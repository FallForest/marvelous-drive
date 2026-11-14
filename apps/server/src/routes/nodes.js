import { db, nowIso } from '../db.js'
import { userFromRequest } from '../auth.js'
import { sendJson } from '../http.js'
import { releaseBlob, retainBlob } from '../storage/blobs.js'
import { recordAudit } from '../ops/audit.js'
import { acquireLock, activeLock, releaseLock } from '../ops/locks.js'
import { indexNode, removeFromIndex, renameInIndex } from '../ops/search-index.js'
import { dropVersions } from '../versions.js'
import {
  childrenCount, createNode, getNode, nodeJson, pathTo, requireNode,
  restoreNode, subtreeIds, trashNode, uniqueName, updateNode, upsertFile,
} from '../nodes.js'

/**
 * Node tree routes: listing, creation, rename/move, trash, restore, purge,
 * starring, copying, breadcrumb paths.
 */

const SORTS = {
  name: 'lower(name)',
  size: 'size DESC, lower(name)',
  updated: 'updated_at DESC',
  created: 'created_at DESC',
}

/**
 * Lists nodes.
 *
 * `workspace` widens the scope from "mine" to "every node in this workspace",
 * which is what a shared drive means. Without it the query stays exactly what it
 * was before workspaces existed, so the personal view cannot regress.
 */
function listNodes(userId, { parentId, trash, starred, sort = 'name', kind, workspace = null }) {
  const order = SORTS[sort] || SORTS.name
  const where = []
  const params = []
  if (workspace) {
    where.push('workspace_id=?')
    params.push(workspace)
    where.push('EXISTS (SELECT 1 FROM memberships m WHERE m.user_id=? AND m.workspace_id=nodes.workspace_id)')
    params.push(userId)
  } else if (parentId !== undefined && parentId !== null && parentId !== '' && parentId !== 'root') {
    // Inside a folder, visibility is the folder's, not the owner's: a member who
    // wrote into my folder must appear in it. The caller is already authorised for
    // the folder by the route (requireFolder/requireNode) before this runs.
    where.push('EXISTS (SELECT 1 FROM memberships m WHERE m.user_id=? AND m.workspace_id=nodes.workspace_id)')
    params.push(userId)
  } else {
    where.push('user_id=?')
    params.push(userId)
  }
  if (trash) where.push('deleted_at IS NOT NULL')
  else where.push('deleted_at IS NULL')
  if (!trash && parentId !== undefined) {
    if (parentId === null || parentId === '' || parentId === 'root') where.push('parent_id IS NULL')
    else { where.push('parent_id=?'); params.push(parentId) }
  }
  if (starred) where.push('starred=1')
  if (kind === 'file' || kind === 'folder') { where.push('kind=?'); params.push(kind) }
  const rows = db.prepare(`SELECT * FROM nodes nodes_alias WHERE ${where.join(' AND ').replace(/nodes\./g, 'nodes_alias.')} ORDER BY (kind='folder') DESC, ${order}`).all(...params)
  return rows.map((row) => nodeJson(row))
}

export function registerNodeRoutes(router) {
  // Literal paths first: /api/v1/nodes/archive must win over /api/v1/nodes/:id,
  // which matches the same shape with GET/PUT/DELETE and would answer 405.
  /** The live lock on a node, or null. */
  router.get('/api/v1/nodes/:id/lock', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const row = requireNode(user.id, ctx.params.id)
    sendJson(ctx.res, 200, { lock: activeLock(row.id) })
  })

  /**
   * Takes (or extends) the edit lock.
   *
   * `force` takes over someone else's lock; without it a held lock answers 409 with
   * the current holder, so a client can ask rather than guess.
   */
  router.post('/api/v1/nodes/:id/lock', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const row = requireNode(user.id, ctx.params.id)
    const input = await ctx.json().catch(() => ({}))
    const { lock, tookOver, supersededClient } = acquireLock(row.id, user.id, {
      client: String(input.client || '').slice(0, 80),
      ttlMs: input.ttlMs,
      force: Boolean(input.force),
    })
    if (tookOver) recordAudit(user.id, 'lock-takeover', { nodeId: row.id, detail: row.name, ip: ctx.ip })
    sendJson(ctx.res, 200, { lock, tookOver, supersededClient })
  })

  router.delete('/api/v1/nodes/:id/lock', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const row = requireNode(user.id, ctx.params.id)
    const result = releaseLock(row.id, user.id)
    sendJson(ctx.res, 200, result)
  })

  /**
   * Zips a selection of nodes into one archive file.
   *
   * Used by "download selected" in the client. The archive is created as a real
   * node so the client can download it with the same code path as any file, then
   * delete it; nothing keeps it around unless the user asks for that.
   */
  router.post('/api/v1/nodes/archive', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const input = await ctx.json()
    const ids = Array.isArray(input.ids) ? [...new Set(input.ids.map(String))] : []
    if (!ids.length) ctx.fail(400, 'INVALID_INPUT', 'Provide a non-empty ids array.')
    if (ids.length > 200) ctx.fail(400, 'INVALID_INPUT', 'At most 200 nodes can be archived at once.')
    const nodes = ids.map((id) => requireNode(user.id, id)).filter((row) => !row.deleted_at)
    if (!nodes.length) ctx.fail(404, 'NOT_FOUND', 'None of the selected nodes exist.')
    const { buildZipFrom } = await import('../text/zip.js')
    const blob = await buildZipFrom(user.id, nodes.map((row) => ({ id: row.id })))
    const parentId = nodes.length === 1 ? nodes[0].parent_id : null
    const baseName = input.name
      ? String(input.name)
      : nodes.length === 1 ? nodes[0].name.replace(/\.zip$/i, '') + '.zip' : 'selection-' + nodes.length + '-items.zip'
    const name = uniqueName(user.id, parentId, baseName)
    const { node: archive } = upsertFile(user.id, {
      name, parentId, mime: 'application/zip', size: blob.size, blobHash: blob.hash,
    })
    sendJson(ctx.res, 201, { node: nodeJson(getNode(user.id, archive.id)) })
  })

  router.get('/api/v1/nodes', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const query = ctx.url.searchParams
    const nodes = listNodes(user.id, {
      parentId: query.has('parentId') ? query.get('parentId') : undefined,
      trash: query.get('trash') === '1' || query.get('trash') === 'true',
      starred: query.get('starred') === '1' || query.get('starred') === 'true',
      sort: query.get('sort') || 'name',
      kind: query.get('kind') || undefined,
      workspace: query.get('workspace') || null,
    })
    sendJson(ctx.res, 200, { nodes })
  })

  router.post('/api/v1/nodes', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const input = await ctx.json()
    const kind = input.kind === 'folder' ? 'folder' : 'file'
    const row = createNode(user.id, { name: input.name, kind, parentId: input.parentId ?? null })
    sendJson(ctx.res, 201, { node: nodeJson(row) })
  })

  router.get('/api/v1/nodes/:id', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const row = requireNode(user.id, ctx.params.id)
    const extra = {
      children: childrenCount(user.id, row.id),
      path: pathTo(user.id, row.parent_id),
      // So a client knows before it starts typing that someone else is editing.
      lock: activeLock(row.id),
    }
    if (row.kind === 'file') {
      extra.downloadUrl = `/api/v1/files/${row.id}/content?download=1`
      extra.previewUrl = `/api/v1/files/${row.id}/content`
    }
    sendJson(ctx.res, 200, { node: nodeJson(row, extra) })
  })

  router.put('/api/v1/nodes/:id', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const input = await ctx.json()
    const row = updateNode(user.id, ctx.params.id, {
      name: input.name,
      parentId: input.parentId,
      expectedVersion: input.expectedVersion,
    })
    if (input.name !== undefined) renameInIndex(row.id, row.name)
    sendJson(ctx.res, 200, { node: nodeJson(row) })
  })

  router.delete('/api/v1/nodes/:id', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const ids = trashNode(user.id, ctx.params.id)
    const trashed = getNode(user.id, ctx.params.id)
    for (const nodeId of ids) removeFromIndex(nodeId)
    recordAudit(user.id, 'trash', {
      nodeId: ctx.params.id,
      detail: trashed ? trashed.name + (ids.length > 1 ? '（含 ' + (ids.length - 1) + ' 个子项）' : '') : null,
      ip: ctx.ip,
    })
    sendJson(ctx.res, 200, { ok: true, trashed: ids.length })
  })

  router.post('/api/v1/nodes/:id/restore', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const row = restoreNode(user.id, ctx.params.id)
    for (const nodeId of subtreeIds(user.id, row.id)) {
      const child = getNode(user.id, nodeId)
      if (child && child.kind === 'file') await indexNode(child)
    }
    recordAudit(user.id, 'restore', { nodeId: row.id, detail: row.name, ip: ctx.ip })
    sendJson(ctx.res, 200, { node: nodeJson(row) })
  })

  router.delete('/api/v1/nodes/:id/permanent', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const row = requireNode(user.id, ctx.params.id)
    if (!row.deleted_at) ctx.fail(400, 'INVALID_INPUT', 'Only trashed items can be deleted permanently.')
    const ids = subtreeIds(user.id, row.id)
    const placeholders = ids.map(() => '?').join(',')
    const blobRows = db.prepare(`SELECT blob_hash FROM nodes WHERE id IN (${placeholders}) AND blob_hash IS NOT NULL`).all(...ids)
    await dropVersions(ids)
    db.prepare(`DELETE FROM nodes WHERE id IN (${placeholders})`).run(...ids)
    for (const blob of blobRows) await releaseBlob(blob.blob_hash)
    sendJson(ctx.res, 200, { ok: true, purged: ids.length })
  })

  router.put('/api/v1/nodes/:id/star', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const row = requireNode(user.id, ctx.params.id)
    const input = await ctx.json()
    const starred = Boolean(input.starred)
    db.prepare('UPDATE nodes SET starred=?, updated_at=? WHERE id=?').run(starred ? 1 : 0, nowIso(), row.id)
    sendJson(ctx.res, 200, { starred })
  })

  /** Copies a file (one new blob reference) or a folder tree recursively. */
  router.post('/api/v1/nodes/:id/copy', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const source = requireNode(user.id, ctx.params.id)
    const input = await ctx.json().catch(() => ({}))
    const targetParent = input.parentId !== undefined ? input.parentId : source.parent_id
    const copyOne = (row, parentId, forcedName) => {
      const name = forcedName ?? uniqueName(user.id, parentId, row.name)
      const copy = createNode(user.id, {
        name, kind: row.kind, parentId, mime: row.mime, size: row.size, blobHash: row.blob_hash,
      })
      if (row.blob_hash) retainBlob(row.blob_hash)
      if (row.kind === 'folder') {
        // Children keep their own names; only the copied root may be renamed.
        for (const child of db.prepare('SELECT * FROM nodes WHERE parent_id=? AND deleted_at IS NULL ORDER BY name').all(row.id)) {
          copyOne(child, copy.id)
        }
      }
      return copy
    }
    const copy = copyOne(source, targetParent ?? null, input.name ? String(input.name) : undefined)
    sendJson(ctx.res, 201, { node: nodeJson(copy) })
  })

  router.get('/api/v1/nodes/:id/path', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    requireNode(user.id, ctx.params.id)
    sendJson(ctx.res, 200, { path: pathTo(user.id, ctx.params.id) })
  })

  /** Downloads a whole folder as a stored ZIP archive. */
  router.post('/api/v1/nodes/:id/archive', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const folder = requireNode(user.id, ctx.params.id)
    if (folder.kind !== 'folder') ctx.fail(400, 'NOT_A_FILE', 'Only folders can be archived.')
    const { buildZip } = await import('../text/zip.js')
    const blob = await buildZip(user.id, folder.id)
    const name = `${folder.name}.zip`
    const { node: archive } = upsertFile(user.id, { name: uniqueName(user.id, folder.parent_id, name), parentId: folder.parent_id, mime: 'application/zip', size: blob.size, blobHash: blob.hash })
    sendJson(ctx.res, 201, { node: nodeJson(getNode(user.id, archive.id)) })
  })
}

export { listNodes }