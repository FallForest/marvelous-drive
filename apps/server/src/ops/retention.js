import { unlink } from 'node:fs/promises'
import { db, nowIso } from '../db.js'
import { config } from '../config.js'
import { blobPath } from '../storage/blobs.js'
import { backend } from '../storage/backend.js'
import { dropVersions } from '../versions.js'
import { pruneAudit } from './audit.js'

/**
 * Trash retention.
 *
 * The trash is a safety net, not storage: a node that has been deleted for
 * longer than `trashRetentionDays` is purged, its subtree with it, and the blobs
 * that lose their last reference are removed from disk.
 *
 * Purging is deliberately conservative about references: a blob is only unlinked
 * after the SQL deletes succeeded and its refcount reached zero, so a crash
 * halfway leaves a file with no rows (an orphan the next scrub can reclaim)
 * rather than a row pointing at a missing file.
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** Every trashed node older than the cutoff, newest first. */
export function expiredTrash(userId, now = Date.now()) {
  const cutoff = new Date(now - config.trashRetentionDays * DAY_MS).toISOString()
  return db.prepare(`SELECT * FROM nodes
    WHERE user_id=? AND deleted_at IS NOT NULL AND deleted_at < ?
    ORDER BY deleted_at ASC`).all(userId, cutoff)
}

/** Descendant ids of `id`, including itself. */
function subtreeIds(userId, id) {
  return db.prepare(`WITH RECURSIVE sub(id) AS (
      SELECT id FROM nodes WHERE id=? AND user_id=?
      UNION ALL
      SELECT n.id FROM nodes n JOIN sub s ON n.parent_id=s.id
    ) SELECT id FROM sub`).all(id, userId).map((row) => row.id)
}

/**
 * Permanently deletes `ids` (and their subtrees) for one user.
 *
 * Returns how many nodes and bytes were removed. Safe to call with an empty
 * list; safe to call repeatedly.
 */
export async function purgeNodes(userId, ids) {
  if (!ids.length) return { nodes: 0, bytes: 0, blobs: 0 }
  const all = new Set()
  for (const id of ids) for (const child of subtreeIds(userId, id)) all.add(child)
  const targets = [...all]
  const placeholders = targets.map(() => '?').join(',')

  const nodeBlobs = db.prepare(`SELECT blob_hash, size FROM nodes WHERE id IN (${placeholders}) AND blob_hash IS NOT NULL`).all(...targets)
  const bytes = nodeBlobs.reduce((total, row) => total + (row.size || 0), 0)

  // Versions own their own references, so they have to be released too.
  await dropVersions(targets)
  db.prepare(`DELETE FROM nodes WHERE id IN (${placeholders})`).run(...targets)

  let freed = 0
  for (const row of nodeBlobs) {
    const current = db.prepare('SELECT refs FROM blobs WHERE hash=?').get(row.blob_hash)
    if (!current) continue
    const remaining = current.refs - 1
    if (remaining > 0) {
      db.prepare('UPDATE blobs SET refs=? WHERE hash=?').run(remaining, row.blob_hash)
      continue
    }
    db.prepare('DELETE FROM blobs WHERE hash=?').run(row.blob_hash)
    // Through the backend: a remote tier has nothing to unlink.
    await backend.remove(row.blob_hash)
    freed += 1
  }
  return { nodes: targets.length, bytes, blobs: freed }
}

/**
 * Purges everything past the retention window, for every account.
 *
 * Called on boot (so a long-running instance catches up after downtime) and by
 * the maintenance route. Returns a per-run summary for the log.
 */
export async function sweepExpiredTrash(now = Date.now()) {
  const cutoff = new Date(now - config.trashRetentionDays * DAY_MS).toISOString()
  const roots = db.prepare(`SELECT id, user_id FROM nodes
    WHERE deleted_at IS NOT NULL AND deleted_at < ?
      AND (parent_id IS NULL OR parent_id NOT IN (SELECT id FROM nodes WHERE deleted_at IS NOT NULL))`).all(cutoff)
  let nodes = 0
  let bytes = 0
  let blobs = 0
  for (const row of roots) {
    const result = await purgeNodes(row.user_id, [row.id])
    nodes += result.nodes
    bytes += result.bytes
    blobs += result.blobs
  }
  // The audit log has its own window; pruning it here keeps one timer for all
  // housekeeping instead of a second scheduler nobody remembers.
  const audit = pruneAudit(now)
  return { roots: roots.length, nodes, bytes, blobs, cutoff, at: nowIso(), auditRemoved: audit.removed }
}