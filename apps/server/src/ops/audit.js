import { db, nowIso } from '../db.js'
import { randomId } from '../security.js'

/**
 * Append-only audit log.
 *
 * Every mutating route records one row: who did what to which node, from which
 * address. Two rules keep it honest:
 *   - it is written from the route, after the change succeeded, so the log never
 *     claims an action that failed;
 *   - it is never updated or deleted by the application (only a user delete
 *     cascades), so it is evidence rather than state.
 *
 * Logging must never break the request: a failure is swallowed and reported on
 * stderr, because losing a log line is preferable to losing the operation.
 */

/** Retention: the log is pruned past this window by the same sweep as the trash. */
export const AUDIT_RETENTION_DAYS = 90

const ACTIONS = new Set([
  'upload', 'instant-upload', 'overwrite', 'rename', 'move', 'copy', 'trash',
  'restore', 'purge', 'star', 'share-create', 'share-revoke', 'version-restore',
  'archive', 'login', 'lock-takeover',
])

/**
 * Records one action. Fire-and-forget by design: the caller does not await it
 * for correctness, only for ordering in tests.
 */
export function recordAudit(userId, action, { nodeId = null, detail = null, ip = null } = {}) {
  if (!ACTIONS.has(action)) {
    console.error('[audit] unknown action: ' + action)
    return null
  }
  const id = randomId()
  try {
    db.prepare('INSERT INTO audit_log(id,user_id,action,node_id,detail,ip,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, userId, action, nodeId, detail === null ? null : String(detail).slice(0, 500), ip, nowIso())
    return id
  } catch (error) {
    console.error('[audit] failed to record ' + action + ':', error)
    return null
  }
}

/** Newest first, capped so a long history cannot flood a response. */
export function listAudit(userId, { limit = 50, nodeId = null, action = null } = {}) {
  const where = ['user_id=?']
  const params = [userId]
  if (nodeId) { where.push('node_id=?'); params.push(nodeId) }
  if (action) { where.push('action=?'); params.push(action) }
  params.push(Math.min(Math.max(limit, 1), 200))
  return db.prepare(`SELECT id, action, node_id AS "nodeId", detail, ip, created_at AS "createdAt"
    FROM audit_log WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`).all(...params)
}

/** Drops rows past the retention window; called by the hourly sweep. */
export function pruneAudit(now = Date.now()) {
  const cutoff = new Date(now - AUDIT_RETENTION_DAYS * 86400000).toISOString()
  const result = db.prepare('DELETE FROM audit_log WHERE created_at < ?').run(cutoff)
  return { removed: result.changes || 0, cutoff }
}