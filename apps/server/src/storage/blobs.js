import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { db, nowIso } from '../db.js'
import { backend, blobPath } from './backend.js'

/**
 * Content-addressed blob store.
 *
 * A blob is named by the sha256 of its bytes, so identical uploads cost one copy
 * on disk. `blobs.refs` counts live references (nodes, versions, upload
 * sessions); a blob is removed when the count reaches zero.
 *
 * The bytes themselves live behind `storage-backend.js`: this module owns the
 * refcounting and the database, never the layout on disk. That split is what lets
 * a second tier (or an S3 backend) be added without touching a route.
 */

export { blobPath }

/** Promotes a spooled temp file into the store and bumps its refcount. */
export async function adoptBlob(tempPath, size, sha256) {
  const existing = await backend.stat(sha256)
  if (existing) {
    // Identical bytes are already stored: the spool file is redundant.
    await backend.remove(tempPath).catch(() => {})
  } else {
    await backend.put(sha256, tempPath)
  }
  db.prepare(`INSERT INTO blobs(hash,size,refs,created_at) VALUES (?,?,1,?)
              ON CONFLICT(hash) DO UPDATE SET refs=refs+1`).run(sha256, size, nowIso())
  return sha256
}

/** Adds a reference to an already stored blob (copy, restore, session). */
export function retainBlob(hash) {
  const result = db.prepare('UPDATE blobs SET refs=refs+1 WHERE hash=?').run(hash)
  if (!result.changes) throw new Error(`Blob ${hash} is missing from the store.`)
}

/**
 * Drops a reference and deletes the bytes when nothing points at them any more.
 * Deleting eagerly keeps the data directory from growing without bound.
 */
export async function releaseBlob(hash) {
  if (!hash) return
  const row = db.prepare('SELECT refs FROM blobs WHERE hash=?').get(hash)
  if (!row) return
  const remaining = row.refs - 1
  if (remaining > 0) {
    db.prepare('UPDATE blobs SET refs=? WHERE hash=?').run(remaining, hash)
    return
  }
  db.prepare('DELETE FROM blobs WHERE hash=?').run(hash)
  await backend.remove(hash)
}

export async function hashFile(path) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    createReadStream(path).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', resolve)
  })
  return hash.digest('hex')
}

/** A path whose bytes are `hash` (hard link when possible), for ZIP assembly. */
export async function materialize(hash, targetPath) {
  return backend.link(hash, targetPath)
}

export function blobSize(hash) {
  const row = db.prepare('SELECT size FROM blobs WHERE hash=?').get(hash)
  return row ? row.size : 0
}
