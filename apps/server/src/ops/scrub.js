import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { db, nowIso } from '../db.js'
import { config } from '../config.js'
import { backend, blobPath } from '../storage/backend.js'

/**
 * Blob store integrity.
 *
 * Two failure modes matter and they are not symmetric:
 *   - a row whose file is gone  → the node still exists, downloads 500. Must be
 *     reported (and can be repaired by dropping the row so the node looks empty);
 *   - a file no row references  → wasted disk, never harmful. Safe to reclaim.
 *
 * A checksum pass is offered too, but it is opt-in: rehashing every blob is I/O
 * proportional to the whole drive, so it must never run implicitly.
 */

const shards = () => readdir(config.blobDir).catch(() => [])

/** Every blob file on disk, as `{ hash, path, size }`. */
async function filesOnDisk() {
  const out = []
  for (const shard of await shards()) {
    const dir = join(config.blobDir, shard)
    const info = await stat(dir).catch(() => null)
    if (!info || !info.isDirectory()) continue
    for (const name of await readdir(dir).catch(() => [])) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue
      const path = join(dir, name)
      const file = await stat(path).catch(() => null)
      if (file && file.isFile()) out.push({ hash: name, path, size: file.size })
    }
  }
  return out
}

/**
 * Compares the database against the disk.
 *
 *   { checkedAt, rows, files, missing: [{hash,size}], orphans: [{hash,size}], sizeMismatch: [{hash, rowSize, diskSize}] }
 */
export async function scanBlobs() {
  const rows = db.prepare('SELECT hash, size, refs FROM blobs').all()
  const files = await filesOnDisk()
  const byHash = new Map(files.map((file) => [file.hash, file]))
  const rowHashes = new Set(rows.map((row) => row.hash))
  const missing = []
  const sizeMismatch = []
  for (const row of rows) {
    const file = byHash.get(row.hash)
    if (!file) { missing.push({ hash: row.hash, size: row.size }); continue }
    if (file.size !== row.size) sizeMismatch.push({ hash: row.hash, rowSize: row.size, diskSize: file.size })
  }
  const orphans = files.filter((file) => !rowHashes.has(file.hash)).map((file) => ({ hash: file.hash, size: file.size }))
  return {
    checkedAt: nowIso(),
    rows: rows.length,
    files: files.length,
    bytesOnDisk: files.reduce((total, file) => total + file.size, 0),
    missing,
    orphans,
    sizeMismatch,
  }
}

/** Deletes files no row references. Returns how many and how many bytes. */
export async function reclaimOrphans(report) {
  const scan = report || await scanBlobs()
  let removed = 0
  let bytes = 0
  for (const orphan of scan.orphans) {
    await backend.remove(orphan.hash)
    removed += 1
    bytes += orphan.size
  }
  return { removed, bytes }
}

/**
 * Rehashes blobs and compares each file against the name it is stored under.
 *
 * This is the only check that can detect silent corruption (a bad sector, a
 * truncated copy, a partial restore) — size alone cannot tell "the right number
 * of wrong bytes" from the right file. It is therefore always opt-in, and it
 * accepts a byte budget so a scheduled run can nibble at a large drive instead of
 * reading all of it at once.
 */
export async function verifyChecksums({ limit = 0, maxBytes = Infinity } = {}) {
  const rows = db.prepare('SELECT hash, size FROM blobs ORDER BY created_at ASC').all()
  const targets = limit > 0 ? rows.slice(0, limit) : rows
  const corrupt = []
  const missing = []
  let verified = 0
  let bytes = 0
  for (const row of targets) {
    if (bytes >= maxBytes) break
    const info = await backend.stat(row.hash)
    if (!info) { missing.push(row.hash); continue }
    let digest
    try {
      // Through the backend, so a remote tier can be verified by the same code.
      digest = await hashStream(backend.get(row.hash))
    } catch {
      missing.push(row.hash)
      continue
    }
    verified += 1
    bytes += info.size
    if (digest !== row.hash) corrupt.push({ hash: row.hash, expected: row.hash, actual: digest, size: info.size })
  }
  return { checkedAt: nowIso(), verified, bytes, corrupt, missing, remaining: Math.max(0, rows.length - targets.length) }
}

/**
 * Moves a corrupted blob out of the store.
 *
 * Quarantine beats deletion: the bytes are evidence, and an operator may still
 * recover them by other means. The row is dropped so no node can serve them, and
 * the file is parked under `data/quarantine/` with its hash as the name.
 */
export async function quarantineBlobs(entries) {
  const dir = join(config.dataDir, 'quarantine')
  await mkdir(dir, { recursive: true })
  let moved = 0
  for (const entry of entries || []) {
    const target = join(dir, entry.hash + '.' + Date.now())
    try {
      // Copy out through the backend, then drop the store entry: a remote tier has
      // no file to rename, so a rename here would only work on local disk.
      const info = await backend.stat(entry.hash)
      if (info) {
        await writeFile(target, await readBlob(backend, entry.hash))
        moved += 1
      }
    } catch {
      // Already gone is fine: the row is dropped either way.
    }
    await backend.remove(entry.hash)
    db.prepare('DELETE FROM blobs WHERE hash=?').run(entry.hash)
  }
  return { moved }
}

/** Reads a whole blob from a backend into a buffer. */
async function readBlob(store, key) {
  const chunks = []
  for await (const chunk of store.get(key)) chunks.push(chunk)
  return Buffer.concat(chunks)
}

/** Sha256 of a stream, so a large blob never sits in memory. */
async function hashStream(stream) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', resolve)
  })
  return hash.digest('hex')
}

/** Drops blob rows whose file is gone, so nodes stop advertising dead content. */
export function forgetMissing(report) {
  const scan = report || { missing: [] }
  const statement = db.prepare('DELETE FROM blobs WHERE hash=?')
  let removed = 0
  for (const entry of scan.missing) removed += statement.run(entry.hash).changes || 0
  return { removed }
}