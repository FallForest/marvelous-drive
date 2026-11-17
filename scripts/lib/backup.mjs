import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const HASH = /^[a-f0-9]{64}$/
const BLOCK = 512
const optionalStat = (path) => lstat(path).catch((error) => { if (error.code === 'ENOENT') return null; throw error })
const sqlString = (value) => "'" + value.replace(/'/g, "''") + "'"

/** Remove only a private staging directory created directly under its parent. */
async function cleanStage(stage, parent) {
  if (resolve(dirname(stage)) !== resolve(parent) || !basename(stage).startsWith('.drive-backup-')) {
    throw new Error('Refusing to remove an unexpected backup staging path.')
  }
  await rm(stage, { recursive: true, force: true })
}

function safeName(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(name) || name.includes('..')) {
    throw new Error('Backup name must contain only letters, numbers, dots, underscores and hyphens.')
  }
  return name
}

/** VACUUM INTO reads a transactional snapshot, including committed WAL pages. */
async function snapshotDatabase(dataDir, target) {
  const source = join(dataDir, 'drive.db')
  const info = await optionalStat(source)
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error('A regular drive.db is required in ' + dataDir)
  const db = new DatabaseSync(source, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout=5000')
    db.exec('VACUUM INTO ' + sqlString(target))
  } finally {
    db.close()
  }
  await chmod(target, 0o600)
}

async function copySecret(dataDir, target) {
  const source = join(dataDir, '.jwt-secret')
  const info = await optionalStat(source)
  if (!info) return
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('The JWT secret must be a regular file.')
  await copyFile(source, target)
  await chmod(target, 0o600)
}

/** Online metadata snapshot. It deliberately makes no promise about blob bytes. */
export async function createDatabaseSnapshot({ dataDir, outDir, name }) {
  dataDir = resolve(dataDir)
  outDir = resolve(outDir)
  name = safeName(name)
  await mkdir(outDir, { recursive: true })
  for (const extension of ['.db', '.jwt-secret', '.json']) {
    if (await optionalStat(join(outDir, name + extension))) throw new Error('Snapshot already exists: ' + name)
  }
  const stage = await mkdtemp(join(outDir, '.drive-backup-'))
  try {
    await snapshotDatabase(dataDir, join(stage, name + '.db'))
    await copySecret(dataDir, join(stage, name + '.jwt-secret'))
    await writeFile(join(stage, name + '.json'), JSON.stringify({
      format: 1, kind: 'database-only', createdAt: new Date().toISOString(),
      note: 'Metadata and generated JWT secret only. Blob bytes are not included.',
    }, null, 2) + '\n', { mode: 0o600 })
    for (const file of await readdir(stage)) await rename(join(stage, file), join(outDir, file))
    return join(outDir, name + '.db')
  } finally {
    await cleanStage(stage, outDir)
  }
}

/** Verify every current/history blob required by this database, including trash. */
export async function verifyBackup(dataDir) {
  return verifyBackupLayout(join(dataDir, 'drive.db'), join(dataDir, 'blobs'))
}

/** Only the recovery layout is accepted; links, WALs and arbitrary paths are not. */
function archivePath(raw, directory = false) {
  const path = raw.replace(/^(\.\/)+/, '').replace(/\/$/, '')
  if (!path || path.includes('\\') || path.includes(':') || path.startsWith('/') || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Unsafe archive path: ' + raw)
  }
  const parts = path.split('/')
  let allowed = !directory && parts.length === 1 && ['drive.db', '.jwt-secret', 'backup.json'].includes(path)
  if (parts[0] === 'blobs') {
    allowed = directory
      ? parts.length === 1 || (parts.length === 2 && /^[a-f0-9]{2}$/.test(parts[1]))
      : parts.length === 3 && HASH.test(parts[2]) && parts[1] === parts[2].slice(0, 2)
  }
  if (parts[0] === 'quarantine') {
    allowed = parts.length === 1 ? directory : parts.slice(1).every((part) => /^[A-Za-z0-9._-]+$/.test(part))
  }
  if (!allowed) throw new Error('Unexpected archive entry: ' + raw)
  return path
}

function tarHeader(name, info, directory) {
  if (Buffer.byteLength(name) > 100) throw new Error('Backup entry name is too long: ' + name)
  const header = Buffer.alloc(BLOCK)
  header.write(name)
  const octal = (value, start, length) => {
    const text = value.toString(8)
    if (!Number.isSafeInteger(value) || value < 0 || text.length > length - 1) throw new Error('Backup entry exceeds the supported ustar field range: ' + name)
    header.write(text.padStart(length - 1, '0') + '\0', start, length, 'ascii')
  }
  octal(directory ? 0o700 : 0o600, 100, 8)
  octal(0, 108, 8)
  octal(0, 116, 8)
  octal(directory ? 0 : info.size, 124, 12)
  octal(Math.floor(info.mtimeMs / 1000), 136, 12)
  header.fill(0x20, 148, 156)
  header[156] = directory ? 0x35 : 0x30
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
  return header
}

async function writeAll(handle, buffer) {
  let offset = 0
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset)
    if (!bytesWritten) throw new Error('Could not write backup bytes.')
    offset += bytesWritten
  }
}

/** A small regular-file-only ustar writer; no shell and no whole-file buffers. */
async function writeArchive(target, entries) {
  const out = await open(target, 'wx', 0o600)
  try {
    const append = async (path, name) => {
      const info = await lstat(path)
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error('Backup refuses links or special files: ' + name)
      const directory = info.isDirectory()
      archivePath(name, directory)
      await writeAll(out, tarHeader(name, info, directory))
      if (directory) {
        for (const child of (await readdir(path)).sort()) await append(join(path, child), name + '/' + child)
      } else {
        let written = 0
        for await (const chunk of createReadStream(path)) { await writeAll(out, chunk); written += chunk.length }
        if (written !== info.size) throw new Error('A file changed during backup: ' + name)
        if (written % BLOCK) await writeAll(out, Buffer.alloc(BLOCK - written % BLOCK))
      }
    }
    for (const entry of entries) await append(entry.path, entry.name)
    await writeAll(out, Buffer.alloc(BLOCK * 2))
    await out.sync()
  } finally {
    await out.close()
  }
}

/** A complete local-store backup requires all writers stopped by the operator. */
export async function createFullBackup({ dataDir, outDir, name, offline = false, storage = 'local' }) {
  if (!offline) throw new Error('Full backup requires --offline after stopping all Drive writers. Use snapshot for an online database-only snapshot.')
  if (storage !== 'local') throw new Error('A complete archive requires local blob storage. Use snapshot for metadata and back up remote storage separately.')
  dataDir = resolve(dataDir)
  outDir = resolve(outDir)
  name = safeName(name)
  const outputRelative = relative(dataDir, outDir)
  if (outputRelative === '' || (!isAbsolute(outputRelative) && outputRelative !== '..' && !outputRelative.startsWith('..\\') && !outputRelative.startsWith('../'))) {
    throw new Error('Backup output must be outside the source data directory.')
  }
  await mkdir(outDir, { recursive: true })
  const target = join(outDir, name + '.tar')
  if (await optionalStat(target)) throw new Error('Backup already exists: ' + target)
  const stage = await mkdtemp(join(outDir, '.drive-backup-'))
  try {
    await snapshotDatabase(dataDir, join(stage, 'drive.db'))
    await copySecret(dataDir, join(stage, '.jwt-secret'))
    // Verify the snapshot's references against the stopped source, before any
    // archive can be advertised as complete. Stream hashes rather than buffering.
    const verified = await verifyBackupLayout(join(stage, 'drive.db'), join(dataDir, 'blobs'))
    await writeFile(join(stage, 'backup.json'), JSON.stringify({
      format: 1, kind: 'full-local', createdAt: new Date().toISOString(), verified,
    }, null, 2) + '\n', { mode: 0o600 })
    const entries = [{ path: join(stage, 'drive.db'), name: 'drive.db' }, { path: join(stage, 'backup.json'), name: 'backup.json' }]
    if (await optionalStat(join(stage, '.jwt-secret'))) entries.push({ path: join(stage, '.jwt-secret'), name: '.jwt-secret' })
    for (const name of ['blobs', 'quarantine']) {
      if (await optionalStat(join(dataDir, name))) entries.push({ path: join(dataDir, name), name })
    }
    await writeArchive(join(stage, 'archive.tar'), entries)
    await rename(join(stage, 'archive.tar'), target)
    return { path: target, ...verified }
  } finally {
    await cleanStage(stage, outDir)
  }
}

// The snapshot DB and the immutable blob tree need not share a directory while
// creating an archive. Keeping this seam explicit avoids copying the blob tree.
async function verifyBackupLayout(databasePath, blobRoot) {
  const db = new DatabaseSync(databasePath, { readOnly: true })
  let rows
  try {
    const check = db.prepare('PRAGMA quick_check').all()
    if (check.length !== 1 || Object.values(check[0])[0] !== 'ok') throw new Error('Database integrity check failed.')
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Database foreign-key check failed.')
    rows = db.prepare(`SELECT wanted.hash, b.size FROM (
      SELECT blob_hash AS hash FROM nodes WHERE blob_hash IS NOT NULL
      UNION SELECT blob_hash AS hash FROM node_versions WHERE blob_hash IS NOT NULL
    ) wanted LEFT JOIN blobs b ON b.hash=wanted.hash`).all()
  } finally { db.close() }
  let bytes = 0
  for (const row of rows) {
    if (!HASH.test(row.hash) || row.size === null) throw new Error('Invalid or missing blob metadata: ' + row.hash)
    const path = join(blobRoot, row.hash.slice(0, 2), row.hash)
    const info = await optionalStat(path)
    if (!info?.isFile() || info.isSymbolicLink() || info.size !== row.size) throw new Error('Missing or wrong-size blob: ' + row.hash)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    if (hash.digest('hex') !== row.hash) throw new Error('Blob checksum mismatch: ' + row.hash)
    bytes += info.size
  }
  return { blobs: rows.length, bytes }
}

async function extractArchive(archive, stage) {
  const input = await open(archive, 'r')
  try {
    const size = (await input.stat()).size
    let offset = 0
    let ended = false
    const seen = new Set()
    const read = async (length) => {
      const buffer = Buffer.alloc(length)
      let filled = 0
      while (filled < length) {
        const result = await input.read(buffer, filled, length - filled, offset + filled)
        if (!result.bytesRead) throw new Error('Truncated backup archive.')
        filled += result.bytesRead
      }
      offset += length
      return buffer
    }
    const stringAt = (header, start, length) => header.subarray(start, start + length).toString('utf8').split('\0')[0]
    const octalAt = (header, start, length) => {
      const text = stringAt(header, start, length).trim()
      if (!/^[0-7]+$/.test(text)) throw new Error('Invalid tar number.')
      const value = Number.parseInt(text, 8)
      if (!Number.isSafeInteger(value)) throw new Error('Tar number exceeds the safe range.')
      return value
    }
    while (offset + BLOCK <= size) {
      const header = await read(BLOCK)
      if (header.every((byte) => byte === 0)) {
        if (offset + BLOCK > size || !(await read(BLOCK)).every((byte) => byte === 0)) throw new Error('Truncated backup archive terminator.')
        ended = true
        break
      }
      const checksum = octalAt(header, 148, 8)
      header.fill(0x20, 148, 156)
      if (header.reduce((sum, byte) => sum + byte, 0) !== checksum) throw new Error('Invalid tar header checksum.')
      const type = header[156]
      const directory = type === 0x35
      if (!directory && type !== 0 && type !== 0x30) throw new Error('Backup refuses archive links, extensions or special files.')
      const prefix = stringAt(header, 345, 155)
      const name = archivePath((prefix ? prefix + '/' : '') + stringAt(header, 0, 100), directory)
      if (seen.has(name)) throw new Error('Duplicate archive entry: ' + name)
      seen.add(name)
      const length = octalAt(header, 124, 12)
      if ((directory && length) || offset + Math.ceil(length / BLOCK) * BLOCK > size) throw new Error('Invalid archive entry length.')
      const path = resolve(stage, ...name.split('/'))
      if (!path.startsWith(resolve(stage) + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('Archive path escapes staging directory.')
      if (directory) await mkdir(path, { recursive: true, mode: 0o700 })
      else {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        const output = await open(path, 'wx', 0o600)
        try {
          let remaining = length
          while (remaining) {
            const chunk = await read(Math.min(1024 * 1024, remaining))
            await writeAll(output, chunk)
            remaining -= chunk.length
          }
        } finally { await output.close() }
        if (length % BLOCK) await read(BLOCK - length % BLOCK)
      }
    }
    if (!ended || !seen.has('drive.db')) throw new Error('Archive has no complete database backup.')
    while (offset < size) {
      const tail = await read(Math.min(1024 * 1024, size - offset))
      if (!tail.every((byte) => byte === 0)) throw new Error('Unexpected trailing archive records.')
    }
  } finally { await input.close() }
}

/** Validate in a private sibling directory, then promote into an empty target. */
export async function restoreBackup({ archive, dataDir }) {
  dataDir = resolve(dataDir)
  const checkTarget = async () => {
    const info = await optionalStat(dataDir)
    if (info && (!info.isDirectory() || info.isSymbolicLink() || (await readdir(dataDir)).length)) {
      throw new Error('Restore requires an empty destination; existing data or WAL files will never be overwritten: ' + dataDir)
    }
    return info
  }
  await checkTarget()
  const parent = dirname(dataDir)
  await mkdir(parent, { recursive: true })
  const stage = await mkdtemp(join(parent, '.drive-backup-'))
  try {
    await extractArchive(resolve(archive), stage)
    const verified = await verifyBackup(stage)
    if (await checkTarget()) await rmdir(dataDir)
    await rename(stage, dataDir)
    return { path: dataDir, ...verified }
  } finally {
    await cleanStage(stage, parent)
  }
}
