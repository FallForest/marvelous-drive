import { createWriteStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { db, nowIso } from '../db.js'
import { config } from '../config.js'
import { adoptBlob } from '../storage/blobs.js'
import { backend } from '../storage/backend.js'

/**
 * A streaming ZIP writer (stored, no compression).
 *
 * Archives only exist to hand a folder to the user as one download, so the
 * simplest correct format wins: no deflate, no ZIP64 for the sizes Drive
 * handles, deterministic order.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let value = i
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[i] = value >>> 0
  }
  return table
})()

function crc32(buffer, seed = 0) {
  let crc = (seed ^ -1) >>> 0
  for (let index = 0; index < buffer.length; index++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[index]) & 0xff]
  return (crc ^ -1) >>> 0
}

/** DOS date/time pair for `entryDate`. */
function dosStamp(date) {
  const year = Math.max(1980, date.getFullYear())
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, day }
}

function collectFiles(userId, folderId, prefix, out) {
  const rows = db.prepare("SELECT * FROM nodes WHERE user_id=? AND parent_id=? AND deleted_at IS NULL ORDER BY (kind='folder') DESC, lower(name)").all(userId, folderId)
  for (const row of rows) {
    const entryName = prefix ? `${prefix}/${row.name}` : row.name
    if (row.kind === 'folder') {
      out.push({ name: `${entryName}/`, folder: true, size: 0, date: row.updated_at })
      collectFiles(userId, row.id, entryName, out)
    } else if (row.blob_hash) {
      out.push({ name: entryName, folder: false, size: row.size, hash: row.blob_hash, date: row.updated_at })
    }
  }
  return out
}

/**
 * Writes `folderId` into the blob store as a stored ZIP and returns
 * `{hash,size}`, ready to be attached to a file node.
 */
export async function buildZip(userId, folderId) {
  return buildZipFrom(userId, [{ id: folderId }])
}

/**
 * Zips an arbitrary selection.
 *
 * `roots` is a list of `{ id, name? }`; each folder keeps its own name as the
 * archive prefix and each file is stored at the top level under its own name.
 * Duplicate names inside the archive are suffixed, because two selected folders
 * can legitimately be called the same thing.
 */
export async function buildZipFrom(userId, roots) {
  const entries = []
  const used = new Set()
  for (const root of roots) {
    const row = db.prepare('SELECT * FROM nodes WHERE id=? AND user_id=? AND deleted_at IS NULL').get(root.id, userId)
    if (!row) continue
    let prefix = row.name
    if (used.has(prefix)) {
      let counter = 1
      while (used.has(prefix + ' (' + counter + ')')) counter += 1
      prefix = prefix + ' (' + counter + ')'
    }
    used.add(prefix)
    if (row.kind === 'folder') {
      entries.push({ name: prefix + '/', folder: true, size: 0, date: row.updated_at })
      collectFiles(userId, row.id, prefix, entries)
    } else if (row.blob_hash) {
      entries.push({ name: prefix, folder: false, size: row.size, hash: row.blob_hash, date: row.updated_at })
    }
  }
  return writeArchive(entries)
}

async function writeArchive(entries) {
  const tempPath = join(config.tmpDir, `zip-${process.pid}-${Date.now()}.part`)
  const out = createWriteStream(tempPath)
  const hash = createHash('sha256')
  let offset = 0
  const central = []

  const write = async (buffer) => {
    hash.update(buffer)
    offset += buffer.length
    if (!out.write(buffer)) await new Promise((resolve) => out.once('drain', resolve))
  }

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, 'utf8')
    const { time, day } = dosStamp(new Date(entry.date || nowIso()))
    const crc = entry.folder ? 0 : await crcOfBlob(entry.hash)
    const localOffset = offset

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(day, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(entry.size, 18)
    local.writeUInt32LE(entry.size, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    local.writeUInt16LE(0, 28)
    await write(local)
    await write(nameBuffer)
    if (!entry.folder && entry.size > 0) await pumpBlob(entry.hash, write)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0x0800, 8)
    centralHeader.writeUInt16LE(0, 10)
    centralHeader.writeUInt16LE(time, 12)
    centralHeader.writeUInt16LE(day, 14)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(entry.size, 20)
    centralHeader.writeUInt32LE(entry.size, 24)
    centralHeader.writeUInt16LE(nameBuffer.length, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(entry.folder ? 0x10 : 0, 38)
    centralHeader.writeUInt32LE(localOffset, 42)
    central.push(Buffer.concat([centralHeader, nameBuffer]))
  }

  const centralStart = offset
  for (const record of central) await write(record)
  const centralSize = offset - centralStart

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(centralStart, 16)
  end.writeUInt16LE(0, 20)
  await write(end)

  out.end()
  await new Promise((resolve, reject) => { out.on('error', reject); out.on('finish', resolve) })
  const size = offset
  const digest = hash.digest('hex')
  return { hash: await adoptBlob(tempPath, size, digest), size }
}

const crcCache = new Map()

async function crcOfBlob(hash) {
  if (crcCache.has(hash)) return crcCache.get(hash)
  let crc = 0
  await new Promise((resolve, reject) => {
    // Through the backend: a ZIP must be buildable from a remote tier too.
    backend.get(hash)
      .on('data', (chunk) => { crc = crc32(chunk, crc) })
      .on('error', reject)
      .on('end', resolve)
  })
  crcCache.set(hash, crc)
  return crc
}

async function pumpBlob(hash, write) {
  await new Promise((resolve, reject) => {
    backend.get(hash)
      .on('data', (chunk) => { write(chunk).catch(reject) })
      .on('error', reject)
      .on('end', resolve)
  })
}

export { crc32 }