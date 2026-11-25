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

/**
 * One promise chain per blob hash.
 *
 * Adopting a duplicate and releasing a reference both read the backend and then
 * mutate the row, with real I/O in between. Interleaved, an adopt can see bytes
 * that a release of the last reference is about to delete, take a reference, and
 * leave the row pointing at nothing. Serializing the whole read-decide-mutate
 * sequence for one hash closes that window; different hashes never wait on each
 * other.
 *
 * The stored tail never rejects, so one failed operation cannot poison the chain
 * for the waiters behind it, and the entry disappears as soon as the last one
 * settles.
 */
const hashChains = new Map()

function withHashLock(hash, work) {
  const previous = hashChains.get(hash)
  const run = previous ? previous.then(work) : Promise.resolve().then(work)
  const tail = run.then(() => {}, () => {})
  hashChains.set(hash, tail)
  tail.then(() => {
    if (hashChains.get(hash) === tail) hashChains.delete(hash)
  })
  return run
}

/** Promotes a spooled temp file into the store and bumps its refcount. */
export async function adoptBlob(tempPath, size, sha256) {
  return withHashLock(sha256, async () => {
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
  })
}

/** Adds a reference to an already stored blob (copy, restore, session). */
export function retainBlob(hash) {
  const result = db.prepare('UPDATE blobs SET refs=refs+1 WHERE hash=?').run(hash)
  if (!result.changes) throw new Error(`Blob ${hash} is missing from the store.`)
}

/**
 * Drops a reference and deletes the bytes when nothing points at them any more.
 * Deleting eagerly keeps the data directory from growing without bound.
 *
 * Returns true only when this call removed the last backing blob, so callers
 * that report a freed-blob count do not have to re-inspect the row.
 */
export async function releaseBlob(hash) {
  if (!hash) return false
  return withHashLock(hash, async () => {
    const row = db.prepare('SELECT refs FROM blobs WHERE hash=?').get(hash)
    if (!row) return false
    const remaining = row.refs - 1
    if (remaining > 0) {
      db.prepare('UPDATE blobs SET refs=? WHERE hash=?').run(remaining, hash)
      return false
    }
    db.prepare('DELETE FROM blobs WHERE hash=?').run(hash)
    await backend.remove(hash)
    return true
  })
}

export async function hashFile(path) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    createReadStream(path).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', resolve)
  })
  return hash.digest('hex')
}
