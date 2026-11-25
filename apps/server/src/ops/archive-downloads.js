import { db, nowIso } from '../db.js'
import { fail } from '../http.js'
import { randomId } from '../security.js'
import { releaseBlob } from '../storage/blobs.js'

/**
 * Durable archive downloads.
 *
 * A "download selected" ZIP used to become a real node, so the only way to get
 * rid of it was to delete a file the user never asked to keep. A temporary
 * download is instead a row that owns exactly one blob reference: it has a name,
 * a size and a 24 h expiry, and it disappears on its own when it is released,
 * expired, or swept. No node row is written, ever — the archive is never part of
 * the tree.
 *
 * Lifetime rules, all of them enforced here:
 *
 *   1. `createArchiveDownload` adopts the reference `adoptBlob`/zip already took.
 *      It does not `retainBlob`, because that would leave one extra reference
 *      nobody frees and the bytes would never be collected.
 *   2. `openArchiveDownload` is the only way to read one, and it counts a reader
 *      before returning. The count is in-process only: there is one coordinator,
 *      and a second process serving downloads would need a row, not a Map.
 *   3. A row is deleted only by `DELETE ... RETURNING blob_hash` on a row that is
 *      already released or expired, and only when no reader is active. The hash
 *      comes back from the same statement that removed the row, so the owning
 *      reference is freed exactly once even when two callers race.
 *   4. `releaseArchiveDownload` is a uniform no-op for a missing id and for
 *      another user's id: a caller cannot probe for someone else's downloads.
 */

/** Fixed lifetime. Short enough that a stale temporary file cannot live forever. */
const TTL_MS = 24 * 60 * 60 * 1000

/** Active readers per archive id, incremented after a successful open. */
const readers = new Map()

/** The one failure a caller may see: never "not yours" versus "expired". */
const unavailable = () => fail(404, 'ARCHIVE_DOWNLOAD_UNAVAILABLE', '临时压缩包已失效，请重新打包。')

const iso = (now) => new Date(now).toISOString()

/**
 * Removes `id` when it is released or expired and nobody is reading it.
 *
 * The reader check and the DELETE happen in one synchronous step, so a reader
 * that opened in the same tick cannot lose its bytes halfway through a response:
 * `openArchiveDownload` counts before it returns the row, and `close` is the only
 * place that drops the count.
 */
async function reclaim(id, now = Date.now()) {
  if ((readers.get(id) || 0) > 0) return false
  const row = db.prepare(`DELETE FROM archive_downloads
    WHERE id=? AND (released_at IS NOT NULL OR expires_at<=?)
    RETURNING blob_hash`).get(id, iso(now))
  if (!row) return false
  // One owning reference, so exactly one release — after the row is gone, which
  // is what makes a crash leave an orphan file rather than a row pointing at one.
  await releaseBlob(row.blob_hash)
  return true
}

/**
 * Records a finished archive and takes over its blob reference.
 *
 * `blob` is an already adopted `{hash,size}`; ownership of that single reference
 * moves to this row. Synchronous by design so the caller can release the blob
 * without a window in which neither the row nor the caller owns it. If the
 * insert throws the caller still owns the reference and must release it.
 */
export function createArchiveDownload(userId, name, blob) {
  const id = randomId()
  const expiresAt = iso(Date.now() + TTL_MS)
  db.prepare(`INSERT INTO archive_downloads(id,user_id,name,blob_hash,size,expires_at)
    VALUES (?,?,?,?,?,?)`).run(id, userId, String(name), blob.hash, Number(blob.size), expiresAt)
  return { id, name: String(name), size: Number(blob.size), mime: 'application/zip', expiresAt, temporary: true }
}

/**
 * Returns one temporary download the caller owns and is allowed to read now.
 *
 * Owner, release and expiry are checked in the same statement, so an outsider
 * and an expired id produce the identical 404 — nothing here says whether an id
 * exists. The active-reader count is incremented only after that select, so a
 * failed open never pins a row; the caller must pair it with `closeArchiveDownload`.
 */
export function openArchiveDownload(userId, id) {
  const row = db.prepare(`SELECT * FROM archive_downloads
    WHERE id=? AND user_id=? AND released_at IS NULL AND expires_at>?`).get(id, userId, nowIso())
  if (!row) throw unavailable()
  readers.set(id, (readers.get(id) || 0) + 1)
  return row
}

/**
 * Ends one read. The last reader triggers the reclaim, which is the only moment
 * a released or expired row may disappear while bytes were being served.
 */
export async function closeArchiveDownload(id) {
  const remaining = (readers.get(id) || 0) - 1
  if (remaining > 0) {
    readers.set(id, remaining)
    return false
  }
  // Zero or a stray close: drop the entry rather than leak a count nobody owns.
  readers.delete(id)
  return reclaim(id)
}

/**
 * Marks the owner's row released. Idempotent, and identical for a missing id or
 * another user's id, so a release request cannot be used to discover downloads.
 */
export async function releaseArchiveDownload(userId, id) {
  const result = db.prepare(`UPDATE archive_downloads SET released_at=COALESCE(released_at,?)
    WHERE id=? AND user_id=?`).run(nowIso(), id, userId)
  // Zero rows is the whole answer for a missing id and for an outsider, and it
  // is the same answer: no reclaim, no timing signal, no way to probe an id.
  if (!result.changes) return false
  return reclaim(id)
}

/**
 * Reaps released and expired rows, freeing each owning reference once.
 *
 * One bad release must not stop the rest: the row is already gone, so a failed
 * unlink leaves an orphan file for the scrub rather than a half-freed database.
 * Failures are returned, not swallowed, so the caller can log them.
 */
export async function sweepArchiveDownloads(now = Date.now()) {
  const rows = db.prepare(`SELECT id FROM archive_downloads
    WHERE released_at IS NOT NULL OR expires_at<=?`).all(iso(now))
  let removed = 0
  const failed = []
  for (const row of rows) {
    if ((readers.get(row.id) || 0) > 0) continue
    try {
      if (await reclaim(row.id, now)) removed += 1
    } catch (error) {
      failed.push({ id: row.id, error: String(error?.message || error) })
    }
  }
  return { removed, failed }
}
