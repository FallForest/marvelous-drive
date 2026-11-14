import { db, nowIso } from '../db.js'
import { fail } from '../http.js'

/**
 * Advisory edit locks.
 *
 * The problem this solves is not concurrent writes — `expectedVersion` already
 * turns those into a 409. It is the human case: two tabs (or two people, once
 * there are workspaces) editing the same document, where one saves and the other
 * does not notice. A lock says "someone is editing this"; the writer can then
 * decide to take over rather than discover it afterwards.
 *
 * Design choices that matter:
 *   - a lock **never blocks a write**. Refusing an upload because a stale tab
 *     holds a lock would turn a courtesy into a data-loss bug;
 *   - locks **expire**. A crashed client must not hold a document until someone
 *     notices; the TTL is short and refreshable;
 *   - taking over someone else's lock needs `force`, so the default is honest.
 */

/** Default TTL: long enough to edit, short enough that a crash self-heals. */
const LOCK_TTL_MS = 15 * 60 * 1000
const LOCK_TTL_MAX_MS = 8 * 60 * 60 * 1000

/** Drops expired rows opportunistically; called on every lock operation. */
function sweepExpired(now = Date.now()) {
  db.prepare('DELETE FROM node_locks WHERE expires_at <= ?').run(new Date(now).toISOString())
}

/** The live lock on a node, or null. */
export function activeLock(nodeId, now = Date.now()) {
  const row = db.prepare('SELECT * FROM node_locks WHERE node_id=?').get(nodeId)
  if (!row) return null
  if (Date.parse(row.expires_at) <= now) {
    db.prepare('DELETE FROM node_locks WHERE node_id=?').run(nodeId)
    return null
  }
  return {
    nodeId: row.node_id,
    userId: row.user_id,
    client: row.client,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
  }
}

/**
 * Takes the lock.
 *
 * Returning the *current* holder when it is someone else lets the caller show
 * "Ada is editing this" and offer to take over, instead of a bare 409.
 */
export function acquireLock(nodeId, userId, { client = '', ttlMs = LOCK_TTL_MS, force = false } = {}) {
  sweepExpired()
  const ttl = Math.min(Math.max(Number(ttlMs) || LOCK_TTL_MS, 1000), LOCK_TTL_MAX_MS)
  const expiresAt = new Date(Date.now() + ttl).toISOString()
  const existing = activeLock(nodeId)

  if (existing && existing.userId !== userId && !force) {
    // The envelope is `{error:{code,message}}`, so the holder's name goes in the
    // message: the client has no other field to read it from.
    const who = existing.client ? existing.client : '另一个窗口'
    const error = fail(409, 'LOCKED', who + ' is editing this file.')
    error.lock = existing
    throw error
  }

  let supersededClient = null
  if (existing && existing.userId === userId) {
    // Same user, different window: never block them (it is their file), but make
    // it visible. This is the single-user case the lock exists for — two tabs
    // editing the same document — so hiding it would defeat the purpose.
    if (client && existing.client && client !== existing.client) supersededClient = existing.client
    db.prepare('UPDATE node_locks SET client=?, expires_at=? WHERE node_id=?')
      .run(client || existing.client, expiresAt, nodeId)
  } else {
    db.prepare(`INSERT INTO node_locks(node_id,user_id,client,acquired_at,expires_at) VALUES (?,?,?,?,?)
      ON CONFLICT(node_id) DO UPDATE SET user_id=excluded.user_id, client=excluded.client,
        acquired_at=excluded.acquired_at, expires_at=excluded.expires_at`)
      .run(nodeId, userId, client, nowIso(), expiresAt)
  }
  return {
    lock: activeLock(nodeId),
    tookOver: Boolean(existing && existing.userId !== userId),
    // The window that lost the lock, if any: the caller shows "another window of
    // yours is editing this".
    supersededClient,
  }
}

/** Releases a lock the caller owns; releasing someone else's is a no-op error. */
export function releaseLock(nodeId, userId) {
  const existing = activeLock(nodeId)
  if (!existing) return { released: false, reason: 'no-lock' }
  if (existing.userId !== userId) {
    const error = fail(403, 'FORBIDDEN', 'Only the lock holder can release it.')
    error.lock = existing
    throw error
  }
  db.prepare('DELETE FROM node_locks WHERE node_id=?').run(nodeId)
  return { released: true }
}