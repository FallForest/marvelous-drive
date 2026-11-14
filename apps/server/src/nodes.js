import { db, nowIso, transaction } from './db.js'
import { fail } from './http.js'
import { randomId } from './security.js'
import { recordVersion } from './versions.js'
import { resolveMime } from './mime.js'

/**
 * The node tree: folders and files, one tree per account.
 *
 * Every helper here returns plain JSON (`nodeJson`) so the API, the CLI and
 * the web client all speak one shape.
 */

const NAME_LIMIT = 255
const FORBIDDEN_NAME = /[\\/\u0000-\u001f]/

export function nodeJson(row, extra = {}) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    parentId: row.parent_id ?? null,
    size: row.size,
    // Repaired against the extension on the way out: rows written before the
    // MIME table existed (or by a client that sent no type at all) still say
    // application/octet-stream, which costs the file its icon and its preview
    // without a migration or a re-upload.
    mime: resolveMime(row.name, row.mime),
    version: row.version,
    starred: Boolean(row.starred),
    blobHash: row.blob_hash ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? null,
    ...extra,
  }
}

export function normalizeName(value) {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ')
  if (!name) throw fail(400, 'INVALID_INPUT', 'A name is required.')
  if (name.length > NAME_LIMIT) throw fail(400, 'INVALID_INPUT', `Names are limited to ${NAME_LIMIT} characters.`)
  if (name === '.' || name === '..') throw fail(400, 'INVALID_INPUT', 'This name is reserved.')
  if (FORBIDDEN_NAME.test(name)) throw fail(400, 'INVALID_INPUT', 'Names cannot contain "/" or control characters.')
  return name
}

/**
 * A node the caller may see.
 *
 * Owned by them, or owned by someone in a workspace they belong to. The second
 * half is what makes a shared drive work; without it every account is an island
 * and the memberships table would be decoration.
 */
export const getNode = (userId, id) => db.prepare(`SELECT n.* FROM nodes n
  WHERE n.id=? AND (
    n.user_id=?
    OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id=? AND m.workspace_id=n.workspace_id)
  )`).get(id, userId, userId) || null

export function requireNode(userId, id) {
  const row = getNode(userId, id)
  if (!row) throw fail(404, 'NOT_FOUND', 'File or folder was not found.')
  return row
}

export function requireFolder(userId, id) {
  if (!id) return null
  const row = requireNode(userId, id)
  if (row.deleted_at) throw fail(404, 'NOT_FOUND', 'Folder was not found.')
  if (row.kind !== 'folder') throw fail(400, 'NOT_FOLDER', 'The parent must be a folder.')
  return row
}

export function requireFile(userId, id) {
  const row = requireNode(userId, id)
  if (row.deleted_at) throw fail(404, 'NOT_FOUND', 'File was not found.')
  if (row.kind !== 'file') throw fail(400, 'NOT_A_FILE', 'This operation requires a file.')
  return row
}

function assertNameFree(userId, parentId, name, exceptId) {
  const clash = db.prepare(`SELECT id FROM nodes
    WHERE user_id=? AND IFNULL(parent_id,'')=IFNULL(?,'') AND name=? AND deleted_at IS NULL AND id<>?`)
    .get(userId, parentId, name, exceptId || '')
  if (clash) throw fail(409, 'CONFLICT', `"${name}" already exists in this folder.`)
}

/** Every descendant id of `id`, including itself, at any depth. */
export function subtreeIds(userId, id) {
  const rows = db.prepare(`WITH RECURSIVE sub(id) AS (
      SELECT id FROM nodes WHERE id=? AND user_id=?
      UNION ALL
      SELECT n.id FROM nodes n JOIN sub s ON n.parent_id=s.id
    ) SELECT id FROM sub`).all(id, userId)
  return rows.map((row) => row.id)
}

export function isDescendant(userId, candidateId, ancestorId) {
  if (!candidateId) return false
  return subtreeIds(userId, ancestorId).includes(candidateId)
}

export function createNode(userId, { name, kind = 'file', parentId = null, mime = null, size = 0, blobHash = null }) {
  const cleanName = normalizeName(name)
  if (kind !== 'file' && kind !== 'folder') throw fail(400, 'INVALID_INPUT', 'kind must be "file" or "folder".')
  if (parentId) requireFolder(userId, parentId)
  assertNameFree(userId, parentId ?? null, cleanName)
  const timestamp = nowIso()
  const id = randomId()
  // The workspace comes from the parent when there is one (so a member writing
  // into a shared folder stays in that workspace), otherwise from the caller.
  const workspaceId = parentId
    ? (getNode(userId, parentId) || {}).workspace_id
    : (db.prepare('SELECT workspace_id FROM memberships WHERE user_id=? LIMIT 1').get(userId) || {}).workspace_id
  if (!workspaceId) throw fail(500, 'INTERNAL_ERROR', 'The account has no workspace.')
  db.prepare(`INSERT INTO nodes(id,user_id,workspace_id,parent_id,name,kind,size,mime,version,starred,blob_hash,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,1,0,?,?,?)`)
    .run(id, userId, workspaceId, parentId ?? null, cleanName, kind, kind === 'folder' ? 0 : size, kind === 'folder' ? null : (mime || 'application/octet-stream'), blobHash, timestamp, timestamp)
  return getNode(userId, id)
}

const CONFLICT_STRATEGIES = new Set(['overwrite', 'rename', 'skip'])

/**
 * Validates the `onConflict` knob shared by the three upload entry points.
 *
 * `overwrite` is the historical behaviour (same name → new version), so an
 * absent value keeps every existing client working unchanged.
 */
export function normalizeConflictStrategy(value) {
  const strategy = value === undefined || value === null || value === '' ? 'overwrite' : String(value).trim().toLowerCase()
  if (!CONFLICT_STRATEGIES.has(strategy)) {
    throw fail(400, 'INVALID_INPUT', 'onConflict must be "overwrite", "rename" or "skip".')
  }
  return strategy
}

/**
 * The live file called `name` inside `parentId`, or null.
 *
 * Visible-to-the-caller, not owned-by: in a shared folder the member's upload must
 * find the owner's file of the same name, or the tree would grow two entries that
 * look identical in the UI.
 */
export function findFileByName(userId, parentId, name) {
  return db.prepare(`SELECT n.* FROM nodes n
    WHERE IFNULL(n.parent_id,'')=IFNULL(?,'') AND n.name=? AND n.kind='file' AND n.deleted_at IS NULL
      AND (n.user_id=? OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id=? AND m.workspace_id=n.workspace_id))`)
    .get(parentId ?? null, name, userId, userId) || null
}

/**
 * Creates or resolves a file at `parentId/name`.
 *
 * `onConflict` decides what happens when a live file already owns that name:
 *
 * - `overwrite` (default): replace the bytes and append a version, which is how
 *   desktop sync clients behave. Returns `previousBlob` for the caller to drop.
 * - `rename`: keep both, storing the new bytes under `name (1).ext`.
 * - `skip`: touch nothing and hand back the existing node.
 *
 * A `skip` result carries no `previousBlob`: the caller still owns whatever
 * blob it prepared for this request and has to release it itself.
 */
export function upsertFile(userId, { name, parentId = null, mime, size, blobHash, onConflict = 'overwrite' }) {
  const strategy = normalizeConflictStrategy(onConflict)
  const cleanName = normalizeName(name)
  if (parentId) requireFolder(userId, parentId)
  const existing = findFileByName(userId, parentId ?? null, cleanName)
  if (!existing) {
    const row = createNode(userId, { name: cleanName, kind: 'file', parentId, mime, size, blobHash })
    return { node: row, created: true, onConflict: strategy }
  }
  if (strategy === 'skip') {
    return { node: getNode(userId, existing.id), created: false, skipped: true, onConflict: strategy }
  }
  if (strategy === 'rename') {
    const renamedName = uniqueName(userId, parentId ?? null, cleanName, { keepExtension: true })
    const row = createNode(userId, { name: renamedName, kind: 'file', parentId, mime, size, blobHash })
    return { node: row, created: true, renamedFrom: cleanName, onConflict: strategy }
  }
  const timestamp = nowIso()
  recordVersion(existing, userId)
  db.prepare('UPDATE nodes SET size=?, mime=?, blob_hash=?, version=version+1, updated_at=? WHERE id=?')
    .run(size, mime || 'application/octet-stream', blobHash, timestamp, existing.id)
  return { node: getNode(userId, existing.id), created: false, previousBlob: existing.blob_hash, onConflict: strategy }
}

export function updateNode(userId, id, { name, parentId, expectedVersion }) {
  const row = requireNode(userId, id)
  if (row.deleted_at) throw fail(404, 'NOT_FOUND', 'File or folder was not found.')
  if (expectedVersion !== undefined && expectedVersion !== null && Number(expectedVersion) !== row.version) {
    throw fail(409, 'VERSION_CONFLICT', `Node is at version ${row.version}; reload and retry.`)
  }
  const nextName = name === undefined ? row.name : normalizeName(name)
  let nextParent = row.parent_id
  if (parentId !== undefined) {
    nextParent = parentId === null ? null : parentId
    if (nextParent === id) throw fail(400, 'INVALID_PARENT', 'A folder cannot be moved into itself.')
    if (nextParent) {
      requireFolder(userId, nextParent)
      if (isDescendant(userId, nextParent, id)) throw fail(400, 'INVALID_PARENT', 'A folder cannot be moved inside one of its descendants.')
    }
  }
  if (nextName !== row.name || nextParent !== row.parent_id) {
    assertNameFree(userId, nextParent, nextName, id)
    // A metadata change is still a mutation of the node, so the revision moves
    // and a writer that started from the old revision gets 409 next time.
    db.prepare('UPDATE nodes SET name=?, parent_id=?, version=version+1, updated_at=? WHERE id=?')
      .run(nextName, nextParent ?? null, nowIso(), id)
  }
  return getNode(userId, id)
}

/** Soft-deletes `id` and every live descendant. Returns the affected ids. */
export function trashNode(userId, id) {
  const row = requireNode(userId, id)
  if (row.deleted_at) throw fail(404, 'NOT_FOUND', 'File or folder was not found.')
  const ids = subtreeIds(userId, id)
  const timestamp = nowIso()
  const statement = db.prepare('UPDATE nodes SET deleted_at=?, updated_at=? WHERE id=? AND deleted_at IS NULL')
  transaction(() => { for (const nodeId of ids) statement.run(timestamp, timestamp, nodeId) })
  return ids
}

/** Restores `id` and the trashed descendants that belong to its subtree. */
export function restoreNode(userId, id) {
  const row = requireNode(userId, id)
  if (!row.deleted_at) throw fail(404, 'NOT_FOUND', 'This item is not in the trash.')
  const parent = row.parent_id ? getNode(userId, row.parent_id) : null
  if (parent && parent.deleted_at) throw fail(400, 'INVALID_PARENT', 'Restore the parent folder first.')
  const ids = subtreeIds(userId, id)
  const timestamp = nowIso()
  let name = row.name
  const clash = db.prepare(`SELECT id FROM nodes WHERE user_id=? AND IFNULL(parent_id,'')=IFNULL(?,'') AND name=? AND deleted_at IS NULL AND id<>?`)
    .get(userId, row.parent_id ?? null, name, id)
  if (clash) name = uniqueName(userId, row.parent_id, `${name} (restored)`)
  db.prepare('UPDATE nodes SET deleted_at=NULL, name=?, version=version+1, updated_at=? WHERE id=?').run(name, timestamp, id)
  const statement = db.prepare(`UPDATE nodes SET deleted_at=NULL, updated_at=? WHERE id=? AND deleted_at IS NOT NULL`)
  transaction(() => { for (const nodeId of ids) if (nodeId !== id) statement.run(timestamp, nodeId) })
  return getNode(userId, id)
}

/** Splits `x.txt` into `x` + `.txt`; a dotfile or a long tail stays whole. */
function splitExtension(name) {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return { stem: name, ext: '' }
  const ext = name.slice(dot)
  if (ext.length > 17 || /\s/.test(ext)) return { stem: name, ext: '' }
  return { stem: name.slice(0, dot), ext }
}

/**
 * Appends " (1)", " (2)"… until the name is free inside the folder.
 *
 * With `keepExtension` the counter goes before the extension — `x (1).txt`
 * instead of `x.txt (1)` — which is what a rename-on-conflict upload should
 * produce; the default form is kept for restore/copy callers.
 */
export function uniqueName(userId, parentId, candidate, { keepExtension = false } = {}) {
  const { stem, ext } = keepExtension ? splitExtension(candidate) : { stem: candidate, ext: '' }
  const base = stem.replace(/ \(\d+\)$/, '')
  let name = candidate
  let counter = 1
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Same namespace as assertNameFree: a shared folder must not grow two "x.txt".
    const clash = db.prepare(`SELECT id FROM nodes
      WHERE IFNULL(parent_id,'')=IFNULL(?,'') AND name=? AND deleted_at IS NULL
        AND (user_id=? OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id=? AND m.workspace_id=nodes.workspace_id))`)
      .get(parentId ?? null, name, userId, userId)
    if (!clash) return name
    const suffix = ` (${counter++})`
    name = base.slice(0, NAME_LIMIT - suffix.length - ext.length) + suffix + ext
  }
}

export function childrenCount(userId, id) {
  const row = db.prepare(`SELECT COUNT(*) AS total FROM nodes
    WHERE parent_id=? AND deleted_at IS NULL
      AND (user_id=? OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id=? AND m.workspace_id=nodes.workspace_id))`)
    .get(id, userId, userId)
  return row ? row.total : 0
}

/** Folder ids from the root down to `id`, for breadcrumbs. */
export function pathTo(userId, id) {
  const chain = []
  let current = id ? getNode(userId, id) : null
  let guard = 0
  while (current && guard++ < 256) {
    chain.unshift({ id: current.id, name: current.name, kind: current.kind })
    current = current.parent_id ? getNode(userId, current.parent_id) : null
  }
  return chain
}