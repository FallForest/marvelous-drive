import { db, nowIso } from './db.js'
import { fail } from './http.js'
import { randomId } from './security.js'

/**
 * Workspaces and membership.
 *
 * A workspace is the visibility boundary; `nodes.user_id` stays the owner so
 * quota and "my files" keep working. Two roles are enough for now:
 *
 *   - `admin`  — the owner of the workspace: may invite, may read every node;
 *   - `member` — sees every node in the workspace (a shared drive, not a
 *                 per-file ACL: that is what share links are for).
 *
 * The distinction matters for the future and costs nothing today, because every
 * existing account is an admin of its own workspace.
 */

const ROLES = new Set(['admin', 'member', 'viewer'])

/** The workspace a user belongs to (today: exactly one). */
export function workspaceFor(userId) {
  const row = db.prepare(`SELECT w.id, w.name, w.owner_id AS ownerId, m.role
    FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
    WHERE m.user_id=?
    ORDER BY (w.owner_id = m.user_id) DESC, m.created_at
    LIMIT 1`).get(userId)
  return row || null
}

/** Every workspace the user belongs to, for a future switcher. */
export function workspacesFor(userId) {
  return db.prepare(`SELECT w.id, w.name, w.owner_id AS ownerId, m.role
    FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
    WHERE m.user_id=? ORDER BY w.name`).all(userId)
}

/** Creates a workspace and makes `ownerId` its admin. */
export function createWorkspace(ownerId, name) {
  const id = randomId()
  const createdAt = nowIso()
  db.prepare('INSERT INTO workspaces(id,name,owner_id,created_at) VALUES (?,?,?,?)')
    .run(id, String(name || 'New workspace').slice(0, 120), ownerId, createdAt)
  db.prepare('INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES (?,?,?,?)')
    .run(id, ownerId, 'admin', createdAt)
  return workspaceFor(ownerId)
}

/** Adds an existing account to a workspace. Idempotent on the role. */
export function addMember(workspaceId, userId, role = 'member') {
  if (!ROLES.has(role)) throw fail(400, 'INVALID_INPUT', 'role must be admin, member or viewer.')
  db.prepare(`INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES (?,?,?,?)
    ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role`)
    .run(workspaceId, userId, role, nowIso())
  return db.prepare('SELECT workspace_id, user_id, role FROM memberships WHERE workspace_id=? AND user_id=?')
    .get(workspaceId, userId)
}
