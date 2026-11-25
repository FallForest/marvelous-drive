import { open, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { addAbortSignal } from 'node:stream'
import { crc32 } from 'node:zlib'
import { db, nowIso } from '../db.js'
import { config } from '../config.js'
import { fail } from '../http.js'
import { adoptBlob } from '../storage/blobs.js'
import { backend } from '../storage/backend.js'
import { getNode } from '../nodes.js'
import {
  ZIP32_COUNT_LIMIT,
  ZIP32_LIMIT,
  ZIP64_VERSION,
  zip64Extra,
  zipDataDescriptor,
  zipEndRecords,
} from './zip-records.js'

/**
 * A streaming ZIP writer (stored, no compression).
 *
 * Archives only exist to hand a folder to the user as one download, so the
 * simplest correct format wins: no deflate, deterministic order. ZIP32 is the
 * default and produces the classic layout byte for byte; ZIP64 records are
 * added only when an entry, offset, or tail value reaches its 32-bit sentinel.
 *
 * Non-empty files are written as stored entries with a trailing data
 * descriptor (general-purpose bit 3): the local header carries zero CRC and
 * sizes because neither is known until the blob has been streamed once. The
 * central directory, written afterwards, carries the real values. Empty files
 * and folders know their metadata up front, so they clear bit 3 and carry no
 * descriptor.
 *
 * A streamed entry whose recorded size reaches 0xffffffff uses extraction
 * version 45, writes the sentinel in both classic local size fields, and
 * appends a 20-byte ZIP64 extra with two zero 64-bit sizes as streaming
 * placeholders; the 24-byte data descriptor carries the real size. The central
 * record uses version 45 when its size or local offset overflows, sets a
 * classic field to 0xffffffff only for the values that overflow, and appends
 * the ZIP64 extra in APPNOTE order (uncompressed, compressed, offset),
 * omitting fields that did not overflow. The tail gains the ZIP64 EOCD and
 * locator when the entry count, central size, or central offset overflows.
 */

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50

const FLAG_UTF8 = 0x0800
const FLAG_DATA_DESCRIPTOR = 0x0008

const MAX_NAME_BYTES = 0xffff
const LOCAL_HEADER_BYTES = 30
const CENTRAL_HEADER_BYTES = 46
const CLASSIC_DESCRIPTOR_BYTES = 16
const ZIP64_DESCRIPTOR_BYTES = 24
const ZIP64_LOCAL_EXTRA_BYTES = 20
const ZIP64_EXTRA_HEADER_BYTES = 4
const ZIP64_EXTRA_VALUE_BYTES = 8
const CLASSIC_TAIL_BYTES = 22
/** ZIP64 EOCD (56) + locator (20) + classic EOCD (22). */
const ZIP64_TAIL_BYTES = 56 + 20 + 22
const MAX_SAFE_BYTES = Number.MAX_SAFE_INTEGER

const archiveTooLarge = (message) => fail(413, 'ARCHIVE_TOO_LARGE', message)

/** DOS date/time pair for `entryDate`. */
function dosStamp(date) {
  const year = Math.max(1980, date.getFullYear())
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, day }
}

function entryStamp(entry) {
  const date = new Date(entry.date || nowIso())
  return dosStamp(Number.isNaN(date.getTime()) ? new Date() : date)
}

function checkAbort(signal) {
  signal?.throwIfAborted()
}

function collectFiles(userId, folderId, prefix, out, workspaceId, signal) {
  checkAbort(signal)
  // Two modes, two scopes. An explicit `workspaceId` is the public folder share
  // and stays limited to that workspace, exactly like the shared children
  // listing. Without one this is the authenticated archive route, where the
  // caller already authorized the root: children use the same visibility as the
  // live folder listing (`(user_id=? OR member of the row's workspace)`), so a
  // member's file inside the owner's folder is not silently dropped.
  const rows = workspaceId
    ? db.prepare(`SELECT * FROM nodes WHERE workspace_id=? AND parent_id=? AND deleted_at IS NULL
        ORDER BY (kind='folder') DESC, lower(name)`).all(workspaceId, folderId)
    : db.prepare(`SELECT * FROM nodes WHERE (user_id=? OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id=? AND m.workspace_id=nodes.workspace_id))
        AND parent_id=? AND deleted_at IS NULL ORDER BY (kind='folder') DESC, lower(name)`).all(userId, userId, folderId)
  for (const row of rows) {
    checkAbort(signal)
    const entryName = prefix ? `${prefix}/${row.name}` : row.name
    if (row.kind === 'folder') {
      out.push({ name: `${entryName}/`, folder: true, size: 0, date: row.updated_at })
      collectFiles(userId, row.id, entryName, out, workspaceId, signal)
    } else {
      const size = Number(row.size) || 0
      if (row.blob_hash) {
        out.push({ name: entryName, folder: false, size, hash: row.blob_hash, date: row.updated_at })
      } else if (size === 0) {
        // A zero-byte placeholder is real: emit its metadata instead of leaving
        // a hole where the user expected a file.
        out.push({ name: entryName, folder: false, size: 0, hash: null, date: row.updated_at })
      } else {
        // A non-empty row with no blob cannot be packaged honestly. Failing beats
        // a silently short archive, and the message names only the authorized
        // entry — never a server-side blob path.
        throw fail(500, 'ARCHIVE_INVALID', `"${entryName}" has ${size} bytes recorded but no stored content.`)
      }
    }
  }
  return out
}

/**
 * Writes `folderId` into the blob store as a stored ZIP and returns
 * `{hash,size}`, ready to be attached to a file node.
 */
export async function buildZip(userId, folderId, options = {}) {
  return buildZipFrom(userId, [{ id: folderId }], options)
}

/**
 * Zips an arbitrary selection.
 *
 * `roots` is a list of `{ id, name? }`; each folder keeps its own name as the
 * archive prefix and each file is stored at the top level under its own name.
 * Duplicate names inside the archive are suffixed, because two selected folders
 * can legitimately be called the same thing.
 * `workspaceId` includes contributors' children for an already-authorized
 * shared root. The caller must authorize the selection before enabling it.
 */
export async function buildZipFrom(userId, roots, { workspaceId, signal, onProgress } = {}) {
  checkAbort(signal)
  const entries = []
  const used = new Set()
  for (const root of roots) {
    checkAbort(signal)
    // An explicit `workspaceId` narrows the root to that one workspace, mirroring
    // the share. Otherwise getNode resolves the caller's own or shared-visible
    // row, so the authenticated archive route matches route-level visibility.
    const row = workspaceId
      ? db.prepare('SELECT * FROM nodes WHERE id=? AND workspace_id=? AND deleted_at IS NULL').get(root.id, workspaceId)
      : getNode(userId, root.id)
    if (!row || row.deleted_at) continue
    let prefix = row.name
    if (used.has(prefix)) {
      let counter = 1
      while (used.has(prefix + ' (' + counter + ')')) counter += 1
      prefix = prefix + ' (' + counter + ')'
    }
    used.add(prefix)
    if (row.kind === 'folder') {
      entries.push({ name: prefix + '/', folder: true, size: 0, date: row.updated_at })
      collectFiles(userId, row.id, prefix, entries, workspaceId, signal)
    } else {
      const size = Number(row.size) || 0
      if (row.blob_hash) {
        entries.push({ name: prefix, folder: false, size, hash: row.blob_hash, date: row.updated_at })
      } else if (size === 0) {
        entries.push({ name: prefix, folder: false, size: 0, hash: null, date: row.updated_at })
      } else {
        throw fail(500, 'ARCHIVE_INVALID', `"${prefix}" has ${size} bytes recorded but no stored content.`)
      }
    }
  }
  checkAbort(signal)
  return writeArchive(entries, { signal, onProgress })
}

/**
 * Fails before the spool is opened when the archive cannot be represented.
 *
 * Entry counts, sizes, and offsets may exceed ZIP32: those are exactly what
 * ZIP64 carries. Only totals that a JavaScript Number cannot hold without
 * rounding are rejected, because a safe integer is the only value that can be
 * written as a 64-bit field. The estimate mirrors the writer record for
 * record — local header (plus its ZIP64 size extra for a large entry), payload,
 * the descriptor form the size implies, every central record with the extras
 * its sentinels require, and the classic or ZIP64 tail — so an unsupported
 * selection is refused before any payload is copied.
 */
function preflight(entries) {
  let outputOffset = 0
  let centralSize = 0
  let bytesTotal = 0

  for (const entry of entries) {
    const nameBytes = Buffer.byteLength(entry.name, 'utf8')
    if (nameBytes > MAX_NAME_BYTES) {
      throw archiveTooLarge(`The entry name "${entry.name}" is ${nameBytes} bytes; ZIP entry names are limited to ${MAX_NAME_BYTES} bytes.`)
    }
    const payload = entry.folder ? 0 : Number(entry.size)
    if (!Number.isSafeInteger(payload) || payload < 0) {
      throw fail(500, 'ARCHIVE_INVALID', `The entry "${entry.name}" has an invalid size.`)
    }
    if (!Number.isSafeInteger(bytesTotal + payload)) {
      throw archiveTooLarge(`The archive payload exceeds the largest size JavaScript can represent exactly (${MAX_SAFE_BYTES} bytes).`)
    }
    bytesTotal += payload

    // A streamed local record at or past the ZIP32 sentinel grows by the
    // 20-byte ZIP64 extra (header plus two 64-bit streaming placeholders), and
    // its descriptor widens from 16 to 24 bytes. Non-empty entries always get
    // a descriptor; folders and empty files get none.
    const localExtra = payload >= ZIP32_LIMIT ? ZIP64_LOCAL_EXTRA_BYTES : 0
    const descriptorBytes = payload > 0
      ? (payload >= ZIP32_LIMIT ? ZIP64_DESCRIPTOR_BYTES : CLASSIC_DESCRIPTOR_BYTES)
      : 0
    const localBytes = LOCAL_HEADER_BYTES + nameBytes + localExtra + payload + descriptorBytes
    if (!Number.isSafeInteger(outputOffset + localBytes)) {
      throw archiveTooLarge(`The archive output exceeds the largest size JavaScript can represent exactly (${MAX_SAFE_BYTES} bytes).`)
    }

    // Central extras: two 64-bit values when the entry size needs ZIP64, one
    // when only the local offset does. The block itself costs 4 + 8 * fields.
    const sizeFields = payload >= ZIP32_LIMIT ? 2 : 0
    const offsetFields = outputOffset >= ZIP32_LIMIT ? 1 : 0
    const extraFields = sizeFields + offsetFields
    const centralBytes = CENTRAL_HEADER_BYTES + nameBytes
      + (extraFields > 0 ? ZIP64_EXTRA_HEADER_BYTES + extraFields * ZIP64_EXTRA_VALUE_BYTES : 0)
    if (!Number.isSafeInteger(centralSize + centralBytes)) {
      throw archiveTooLarge(`The archive central directory exceeds the largest size JavaScript can represent exactly (${MAX_SAFE_BYTES} bytes).`)
    }

    outputOffset += localBytes
    centralSize += centralBytes
  }

  // The tail needs its ZIP64 pair when the count, size, or offset reaches a
  // sentinel; otherwise the classic EOCD alone. Both sums are bounded by the
  // per-entry checks above, so only the final total is rechecked.
  const needsZip64Tail = entries.length >= ZIP32_COUNT_LIMIT
    || centralSize >= ZIP32_LIMIT
    || outputOffset >= ZIP32_LIMIT
  const totalBytes = outputOffset + centralSize + (needsZip64Tail ? ZIP64_TAIL_BYTES : CLASSIC_TAIL_BYTES)
  if (!Number.isSafeInteger(totalBytes)) {
    throw archiveTooLarge(`The archive output exceeds the largest size JavaScript can represent exactly (${MAX_SAFE_BYTES} bytes).`)
  }

  return { entriesTotal: entries.length, bytesTotal }
}

async function writeArchive(entries, { signal, onProgress } = {}) {
  checkAbort(signal)
  const { entriesTotal, bytesTotal } = preflight(entries)

  const tempPath = join(config.tmpDir, `zip-${process.pid}-${randomUUID()}.part`)
  const hash = createHash('sha256')
  let handle = null
  let offset = 0
  let entriesCompleted = 0
  let bytesCompleted = 0
  const central = []

  const report = async () => {
    if (typeof onProgress !== 'function') return
    await onProgress({ entriesCompleted, entriesTotal, bytesCompleted, bytesTotal })
  }

  try {
    // "wx" makes the spool private to this build: a leftover file is a bug, not
    // something to append to. Every record goes through writeFile, so the sink
    // applies backpressure without a hand-rolled drain/error state machine.
    handle = await open(tempPath, 'wx')

    const write = async (buffer) => {
      await handle.writeFile(buffer)
      hash.update(buffer)
      offset += buffer.length
    }

    checkAbort(signal)
    await report()

    for (const entry of entries) {
      checkAbort(signal)
      const nameBuffer = Buffer.from(entry.name, 'utf8')
      const { time, day } = entryStamp(entry)
      const streaming = !entry.folder && entry.size > 0
      // Only the streamed payload can overflow: folders and empty files store
      // size 0 in both classic and ZIP64 form.
      const largeLocal = !entry.folder && Number(entry.size) >= ZIP32_LIMIT
      const flags = FLAG_UTF8 | (streaming ? FLAG_DATA_DESCRIPTOR : 0)
      const localOffset = offset
      const localExtra = largeLocal ? zip64Extra([0, 0]) : Buffer.alloc(0)

      // For streamed entries the local CRC and sizes stay zero; the descriptor
      // after the payload carries the truth. A large streamed entry instead
      // declares ZIP64: extraction version 45, both classic size fields at the
      // sentinel, and a 20-byte extra with two zero 64-bit placeholders.
      const local = Buffer.alloc(LOCAL_HEADER_BYTES)
      local.writeUInt32LE(SIG_LOCAL, 0)
      local.writeUInt16LE(largeLocal ? ZIP64_VERSION : 20, 4)
      local.writeUInt16LE(flags, 6)
      local.writeUInt16LE(0, 8)
      local.writeUInt16LE(time, 10)
      local.writeUInt16LE(day, 12)
      local.writeUInt32LE(0, 14)
      local.writeUInt32LE(largeLocal ? ZIP32_LIMIT : 0, 18)
      local.writeUInt32LE(largeLocal ? ZIP32_LIMIT : 0, 22)
      local.writeUInt16LE(nameBuffer.length, 26)
      local.writeUInt16LE(localExtra.length, 28)
      await write(local)
      await write(nameBuffer)
      if (localExtra.length) await write(localExtra)

      let crc = 0
      let size = 0
      if (streaming) {
        const source = signal ? addAbortSignal(signal, backend.get(entry.hash)) : backend.get(entry.hash)
        let received = 0
        let finished = false
        try {
          for await (const chunk of source) {
            checkAbort(signal)
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            if (!buffer.length) continue
            if (received + buffer.length > entry.size) {
              source.destroy?.()
              throw fail(409, 'ARCHIVE_SOURCE_CHANGED', `"${entry.name}" grew past the ${entry.size} bytes recorded for it.`)
            }
            await write(buffer)
            received += buffer.length
            crc = crc32(buffer, crc)
            bytesCompleted += buffer.length
            await report()
          }
          finished = true
        } finally {
          if (!finished) source.destroy?.()
        }
        if (received !== entry.size) {
          throw fail(409, 'ARCHIVE_SOURCE_CHANGED', `"${entry.name}" streamed ${received} bytes but ${entry.size} were recorded.`)
        }
        size = received
        await write(zipDataDescriptor(crc, size))
      }

      entriesCompleted += 1
      await report()
      checkAbort(signal)

      // Central records only widen what overflowed: a large size sets both
      // classic size fields to the sentinel and contributes two 64-bit values;
      // a large local offset sets only the offset field and contributes one.
      const largeSize = size >= ZIP32_LIMIT
      const largeOffset = localOffset >= ZIP32_LIMIT
      const version = largeSize || largeOffset ? ZIP64_VERSION : 20
      const zip64Values = []
      if (largeSize) zip64Values.push(size, size)
      if (largeOffset) zip64Values.push(localOffset)
      const centralExtra = zip64Values.length ? zip64Extra(zip64Values) : Buffer.alloc(0)

      const centralHeader = Buffer.alloc(CENTRAL_HEADER_BYTES)
      centralHeader.writeUInt32LE(SIG_CENTRAL, 0)
      centralHeader.writeUInt16LE(version, 4)
      centralHeader.writeUInt16LE(version, 6)
      centralHeader.writeUInt16LE(flags, 8)
      centralHeader.writeUInt16LE(0, 10)
      centralHeader.writeUInt16LE(time, 12)
      centralHeader.writeUInt16LE(day, 14)
      centralHeader.writeUInt32LE(crc, 16)
      centralHeader.writeUInt32LE(largeSize ? ZIP32_LIMIT : size, 20)
      centralHeader.writeUInt32LE(largeSize ? ZIP32_LIMIT : size, 24)
      centralHeader.writeUInt16LE(nameBuffer.length, 28)
      centralHeader.writeUInt16LE(centralExtra.length, 30)
      centralHeader.writeUInt16LE(0, 32)
      centralHeader.writeUInt16LE(0, 34)
      centralHeader.writeUInt16LE(0, 36)
      centralHeader.writeUInt32LE(entry.folder ? 0x10 : 0, 38)
      centralHeader.writeUInt32LE(largeOffset ? ZIP32_LIMIT : localOffset, 42)
      central.push(Buffer.concat([centralHeader, nameBuffer, centralExtra]))
    }

    const centralStart = offset
    for (const record of central) await write(record)
    const centralSize = offset - centralStart

    // Classic EOCD while everything fits; the ZIP64 EOCD and locator are added
    // only when the count, central size, or central offset overflows.
    await write(zipEndRecords(entries.length, centralSize, centralStart))

    const size = offset
    await handle.close()
    handle = null
    const digest = hash.digest('hex')

    // Once adoption has taken the ref, a racing abort must not turn a delivered
    // archive into an error: the caller owns releasing the result.
    checkAbort(signal)
    const adoptedHash = await adoptBlob(tempPath, size, digest)
    return { hash: adoptedHash, size }
  } finally {
    if (handle) await handle.close().catch(() => {})
    // On abort/error, drop the spool. After adoption the spool is normally gone —
    // each backend consumes it — but a deduplicated adoption can leave it behind,
    // and a failed adoption can too. This path is unique to this build, so an
    // unconditional best-effort rm is the only safe reclaimer.
    await rm(tempPath, { force: true }).catch(() => {})
  }
}

export { crc32 }
