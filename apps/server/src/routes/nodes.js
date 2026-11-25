import { db, nowIso } from '../db.js'
import { userFromRequest } from '../auth.js'
import { HttpError, sendBlob, sendJson } from '../http.js'
import { backend } from '../storage/backend.js'
import { releaseBlob, retainBlob } from '../storage/blobs.js'
import {
  closeArchiveDownload, createArchiveDownload, openArchiveDownload, releaseArchiveDownload,
} from '../ops/archive-downloads.js'
import { recordAudit } from '../ops/audit.js'
import { acquireLock, activeLock, releaseLock } from '../ops/locks.js'
import { removeFromIndex, renameInIndex } from '../ops/search-index.js'
import { queueIndex as indexNode } from '../ops/index-jobs.js'
import { dropVersions } from '../versions.js'
import {
  childrenCount, createNode, getNode, nodeJson, normalizeName, pathTo, requireNode,
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
 * How many descendants a merge manifest may carry.
 *
 * A client that merges a local folder with a server folder needs the whole tree
 * or none of it: a partial list looks like "these files no longer exist" and a
 * sync would delete them. 5000 entries is the size the client can still diff in
 * one pass, so above it the endpoint says so instead of truncating.
 */
const MERGE_MANIFEST_LIMIT = 5000

/**
 * Longest trash search term the server will look at.
 *
 * The client caps its field at the same number. The cap is applied by slicing
 * rather than rejecting: a hand-written or stale URL with a very long `q` still
 * gets a normal (empty) page instead of a 400, and the substring query stays
 * bounded however the request was built.
 */
const TRASH_QUERY_MAX = 100

/**
 * The recycle bin's deletion-time filter.
 *
 * Dropbox's deleted-files view filters by *when* and Google Drive leads with
 * the deletion date. The preset is a rolling duration — last 24 hours is now
 * minus exactly 24h, not "today" in the reader's timezone — so the answer does
 * not change with the server's locale, a DST jump, or the hour the request
 * arrived. The vocabulary is closed and short, which keeps the value bounded
 * and the comparison on `deleted_at` index-friendly.
 */
const TRASH_DELETED_WITHIN_MS = Object.freeze({
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
})

/**
 * The ISO lower bound for one preset, or null when it is not a preset.
 *
 * Exported so the tests can pin the exact duration instead of inferring it
 * from two rows whose timestamps happen to straddle it.
 */
export function trashDeletedCutoff(value, now = Date.now()) {
  if (typeof value !== 'string' || !Object.hasOwn(TRASH_DELETED_WITHIN_MS, value)) return null
  const reference = Number.isFinite(now) ? now : Date.now()
  return new Date(reference - TRASH_DELETED_WITHIN_MS[value]).toISOString()
}

/** Escape the three characters LIKE treats specially, for an ESCAPE '\' query. */
function likeLiteral(value) {
  return value.replace(/[\\%_]/g, (char) => '\\' + char)
}

/**
 * Lists nodes.
 *
 * `workspace` widens the scope from "mine" to "every node in this workspace",
 * which is what a shared drive means. Without it the query stays exactly what it
 * was before workspaces existed, so the personal view cannot regress.
 *
 * `q` is the trash's name search and is deliberately ignored everywhere else:
 * the live listings keep their existing contract and the search page keeps
 * using /search. It is applied inside the same WHERE clause as the scope and
 * kind filters, before LIMIT/OFFSET, so a match on a later unfiltered page is
 * still reachable.
 */
function listNodes(userId, { parentId, trash, starred, sort = 'name', kind, q = '', deletedWithin = '', workspace = null, limit = null, offset = 0, direction = null }) {
  const effectiveSort = Object.hasOwn(SORTS, sort) ? sort : 'name'
  const updatedColumn = trash && limit !== null ? 'deleted_at' : 'updated_at'
  let order = SORTS[effectiveSort]
  if (effectiveSort === 'updated') order = updatedColumn + ' DESC'
  if (direction) {
    const column = { name: 'lower(name)', size: 'size', updated: updatedColumn, created: 'created_at' }[effectiveSort]
    const dir = direction === 'desc' ? 'DESC' : 'ASC'
    // An explicit name sort reverses the folder group too; folders still sort
    // before files. Size/time sorts leave folders in name order.
    const folderDir = effectiveSort === 'name' ? dir : 'ASC'
    order = `CASE WHEN kind='folder' THEN lower(name) END ${folderDir}, CASE WHEN kind='file' THEN ${column} END ${dir}, lower(name) ${dir}`
  }
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
    where.push('(user_id=? OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id=? AND m.workspace_id=nodes.workspace_id))')
    params.push(userId, userId)
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
  // Trash-only name filter: trimmed, case-insensitive substring, parameterized.
  // Plain LIKE is used, not lower(name): SQLite's intrinsic LIKE folds ASCII
  // case, and lower() would only fold ASCII too — but applying it to the name
  // would turn an exact non-ASCII match ("Ä" vs "Ä") into a miss. `%`/`_`/`\`
  // in the term are escaped so they are literal characters of a file name.
  if (trash) {
    const term = String(q ?? '').trim().slice(0, TRASH_QUERY_MAX)
    if (term) {
      where.push("name LIKE ? ESCAPE '\\'")
      params.push('%' + likeLiteral(term) + '%')
    }
    // Deletion-time preset, applied in the same WHERE as the name and kind
    // filters: "last 7 days" has to narrow the set BEFORE LIMIT/OFFSET or a
    // recent item on page two would still be unreachable. `deleted_at` is the
    // same column the paged trash already sorts by, and both sides are ISO-8601
    // UTC strings, so a lexicographic compare is a chronological one.
    const cutoff = trashDeletedCutoff(deletedWithin)
    if (cutoff) {
      where.push('deleted_at >= ?')
      params.push(cutoff)
    }
  }
  const paging = limit === null ? '' : ' LIMIT ? OFFSET ?'
  if (limit !== null) params.push(limit + 1, offset)
  const rows = db.prepare(`SELECT * FROM nodes nodes_alias WHERE ${where.join(' AND ').replace(/nodes\./g, 'nodes_alias.')} ORDER BY (kind='folder') DESC, ${order}, id ASC${paging}`).all(...params)
  if (limit === null) return { nodes: rows.map((row) => nodeJson(row)) }
  const page = rows.slice(0, limit)
  // One GROUP BY for the whole page, never one query per folder. Only the live
  // view carries counts; the trash keeps its existing shape.
  const childCounts = new Map()
  const folderIds = trash ? [] : page.filter((row) => row.kind === 'folder').map((row) => row.id).slice(0, 500)
  if (folderIds.length) {
    const counts = db.prepare(`SELECT parent_id, SUM(kind='file') AS files, SUM(kind='folder') AS folders FROM nodes
      WHERE parent_id IN (${folderIds.map(() => '?').join(',')}) AND deleted_at IS NULL
        AND (user_id=? OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id=? AND m.workspace_id=nodes.workspace_id))
      GROUP BY parent_id`).all(...folderIds, userId, userId)
    for (const count of counts) childCounts.set(count.parent_id, { files: count.files, folders: count.folders })
  }
  // Trashed rows keep where they were: the originalPath is the same breadcrumb
  // shape as GET /nodes/:id/path, root-to-immediate-parent. Resolved once per
  // distinct parent in the page, and only through pathTo/getNode, so ancestors
  // the caller cannot see are never named: any chain that does not end at a
  // real root (pathTo stops at the first invisible parent) is null. [] means
  // the row really sat at the root.
  const originalPaths = new Map()
  const originalPathFor = (parentId) => {
    if (parentId === null || parentId === undefined) return []
    if (originalPaths.has(parentId)) return originalPaths.get(parentId)
    const chain = pathTo(userId, parentId)
    const top = chain.length ? getNode(userId, chain[0].id) : null
    const value = top && top.parent_id === null ? chain : null
    originalPaths.set(parentId, value)
    return value
  }
  return {
    nodes: page.map((row) => {
      const extra = !trash && row.kind === 'folder'
        ? { childCounts: childCounts.get(row.id) ?? { files: 0, folders: 0 } }
        : {}
      if (trash) {
        extra.originalPath = originalPathFor(row.parent_id)
        // Paged trash rows also name the deletion they belong to, so the client
        // can group them. New rows carry a random batch id, which is what keeps
        // two deletions from the same millisecond apart; rows older than the
        // column fall back to their deletion time. The prefixes keep the two
        // kinds from ever colliding. The unpaged listing keeps its old shape.
        if (limit !== null) {
          extra.trashGroup = row.trash_batch_id
            ? 'batch:' + row.trash_batch_id
            : 'legacy:' + (row.deleted_at ?? '')
        }
      }
      return nodeJson(row, extra)
    }),
    limit,
    offset,
    hasMore: rows.length > limit,
  }
}

/**
 * Builds an archive, then answers either the historical JSON or an opt-in
 * progress stream.
 *
 * `?progress=1` is the only way to ask for SSE: every other request keeps the
 * exact legacy contract ({node}, 201, extra query ignored), so an older server
 * or an old client that appends its own parameters still gets JSON. Auth and
 * selection were validated by the caller before this runs, so nothing below can
 * turn a 4xx into an event stream.
 *
 * `?temporary=1` opts out of the stored node. Without it the archive becomes a
 * real file in the user's tree (the legacy contract, progress stream included);
 * with it the bytes are handed to the archive-download registry, whose row
 * expires on its own and is fetched through GET /api/v1/archive-downloads/:id.
 * The carrier JSON is the same shape either way, so both the 201 body and the
 * SSE complete frame name it without knowing which one was built.
 *
 * `build({signal,onProgress})` must honour the signal (abort work, clean temp
 * files) and report `{entriesCompleted,entriesTotal,bytesCompleted,bytesTotal}`.
 */
async function sendArchive(ctx, userId, { parentId, baseName, build }) {
  const temporary = ctx.url.searchParams.get('temporary') === '1'

  const startPackage = async ({ signal, onProgress } = {}) => {
    const blob = await build({ signal, onProgress })
    // A client can hang up after the last byte was written but before the node
    // exists: publishing then would leave an archive nobody asked to keep.
    if (signal?.aborted) {
      await releaseBlob(blob.hash)
      throw signal.reason instanceof Error ? signal.reason : new Error('Archive build was aborted.')
    }
    if (temporary) {
      try {
        return await createArchiveDownload(userId, normalizeName(baseName), blob)
      } catch (error) {
        // The registry took the adoption; a failed row leaves no owner for it.
        await releaseBlob(blob.hash)
        throw error
      }
    }
    let node
    try {
      const name = uniqueName(userId, parentId, baseName)
      node = upsertFile(userId, { name, parentId, mime: 'application/zip', size: blob.size, blobHash: blob.hash }).node
    } catch (error) {
      // adoptBlob already took a reference; no node owns it now.
      await releaseBlob(blob.hash)
      throw error
    }
    return nodeJson(node)
  }

  const { res } = ctx
  if (ctx.url.searchParams.get('progress') !== '1') {
    sendJson(res, 201, { node: await startPackage() })
    return
  }

  // The POST body has already been read, so request "close" would fire
  // immediately; the response stream is the only honest hangup signal.
  const controller = new AbortController()
  const abort = () => controller.abort(new HttpError(499, 'CLIENT_CLOSED_REQUEST', 'Client closed the request.'))
  res.on('close', abort)

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  })
  // Let the client know the stream is live before packaging starts.
  res.flushHeaders?.()

  // Trailing-edge throttle: a local build finishes many entries inside one
  // window, so a leading-edge-only throttle would collapse the whole build into
  // the initial frame. Keep the newest sample and flush it when the window
  // closes, which keeps the rate near 8/s without ever dropping the last state.
  const PROGRESS_WINDOW_MS = 125
  let closed = false
  let lastAt = 0
  let pending = null
  let progressTimer = null

  const send = (payload) => {
    if (closed || res.writableEnded || res.destroyed) return
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
  }
  const end = () => {
    if (closed) return
    closed = true
    clearTimeout(progressTimer)
    res.end()
  }
  const flush = () => {
    progressTimer = null
    if (!pending) return
    const progress = pending
    pending = null
    lastAt = Date.now()
    send({
      type: 'progress',
      entriesCompleted: progress.entriesCompleted,
      entriesTotal: progress.entriesTotal,
      bytesCompleted: progress.bytesCompleted,
      bytesTotal: progress.bytesTotal,
    })
  }
  const onProgress = (progress) => {
    const isFinal = progress.entriesCompleted === progress.entriesTotal
      && progress.bytesCompleted === progress.bytesTotal
    if (isFinal) {
      // The last sample often lands inside the current window; it must carry the
      // real totals before `complete`, so it bypasses the throttle and replaces
      // any queued intermediate frame it supersedes.
      clearTimeout(progressTimer)
      progressTimer = null
      pending = progress
      flush()
      return
    }
    pending = progress
    const wait = PROGRESS_WINDOW_MS - (Date.now() - lastAt)
    if (wait <= 0) {
      flush()
      return
    }
    if (progressTimer === null) progressTimer = setTimeout(flush, wait)
  }

  try {
    const carrier = await startPackage({ signal: controller.signal, onProgress })
    // Flush the last sample so the final counts precede the terminal frame,
    // then complete: it ignores the throttle and is sent even if the build ended
    // inside the previous window.
    flush()
    send({ type: 'complete', node: carrier })
  } catch (error) {
    if (controller.signal.aborted) {
      // Nobody is listening for an error event; just release the socket.
      res.destroy()
      return
    }
    const status = error instanceof HttpError ? error.status : 500
    const safe = error instanceof HttpError
      ? { code: error.code, message: error.message, status }
      : { code: 'INTERNAL_ERROR', message: 'An unexpected server error occurred.', status: 500 }
    send({ type: 'error', error: safe })
  } finally {
    res.off('close', abort)
    end()
  }
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
    const result = releaseLock(row.id, user.id, { client: ctx.url.searchParams.get('client') ?? undefined })
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
    const roots = nodes.map((row) => ({ id: row.id }))
    const parentId = nodes.length === 1 ? nodes[0].parent_id : null
    const baseName = input.name
      ? String(input.name)
      : nodes.length === 1 ? nodes[0].name.replace(/\.zip$/i, '') + '.zip' : 'selection-' + nodes.length + '-items.zip'
    await sendArchive(ctx, user.id, {
      parentId,
      baseName,
      build: async ({ signal, onProgress }) => {
        const { buildZipFrom } = await import('../text/zip.js')
        return buildZipFrom(user.id, roots, { signal, onProgress })
      },
    })
  })

  router.get('/api/v1/nodes', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const query = ctx.url.searchParams
    const paged = query.has('limit') || query.has('offset')
    const limit = paged ? Number(query.get('limit') ?? 100) : null
    const offset = Number(query.get('offset') ?? 0)
    if (paged && (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)) ctx.fail(400, 'INVALID_INPUT', 'limit must be an integer between 1 and 500.')
    if (!Number.isSafeInteger(offset) || offset < 0) ctx.fail(400, 'INVALID_INPUT', 'offset must be a non-negative integer.')
    const direction = query.get('direction')
    if (direction !== null && direction !== 'asc' && direction !== 'desc') ctx.fail(400, 'INVALID_INPUT', 'direction must be asc or desc.')
    const parentId = query.has('parentId') ? query.get('parentId') : undefined
    if (parentId && parentId !== 'root') {
      const parent = requireNode(user.id, parentId)
      if (parent.deleted_at) ctx.fail(404, 'NOT_FOUND', 'Folder was not found.')
      if (parent.kind !== 'folder') ctx.fail(400, 'NOT_FOLDER', 'The parent must be a folder.')
    }
    const trash = query.get('trash') === '1' || query.get('trash') === 'true'
    // The deletion-time preset exists only on the trash listing. Elsewhere it is
    // ignored rather than validated, so a stray parameter on a live listing
    // cannot turn a working request into a 400 (the same rule `q` follows).
    // On the trash it is validated: a typo must not quietly answer "everything",
    // which would read as a time filter that found old rows.
    const deletedWithin = trash ? (query.get('deletedWithin') || '') : ''
    if (deletedWithin && !trashDeletedCutoff(deletedWithin)) {
      ctx.fail(400, 'INVALID_INPUT', 'deletedWithin must be one of: ' + Object.keys(TRASH_DELETED_WITHIN_MS).join(', ') + '.')
    }
    const payload = listNodes(user.id, {
      parentId,
      trash,
      starred: query.get('starred') === '1' || query.get('starred') === 'true',
      sort: query.get('sort') || 'name',
      kind: query.get('kind') || undefined,
      // The trash's name filter. Ignored on every other listing so the live
      // routes keep their existing meaning for a stray `q`.
      q: trash ? (query.get('q') || '') : '',
      deletedWithin,
      workspace: query.get('workspace') || null,
      limit, offset, direction,
    })
    sendJson(ctx.res, 200, payload)
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
    const restored = restoreNode(user.id, ctx.params.id)
    // Only the files that this restore actually brought back: walking the
    // subtree would also reindex an independently trashed branch that must stay
    // in the trash (and stay out of search).
    for (const file of restored.files) await indexNode(file)
    recordAudit(user.id, 'restore', { nodeId: restored.root.id, detail: restored.root.name, ip: ctx.ip })
    sendJson(ctx.res, 200, { node: nodeJson(restored.root) })
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

  /**
   * Preflight for merging one local folder into one server folder.
   *
   * The manifest is this subtree and nothing else: a merge is bound to the
   * folder the client matched, and walking the parent's other children would
   * offer files that belong to a different local directory. The root itself is
   * excluded, so every entry is a descendant.
   *
   * The walk follows the same visibility as the listing routes — owned by the
   * caller, or in a workspace they belong to — and only live rows, applied at
   * each level: an edge through a trashed or invisible folder is not followed.
   * `nodes_live_parent` serves the recursive step.
   *
   * `LIMIT` sits inside the recursive arm, so an enormous tree stops at 5001
   * rows instead of being materialised. Above the cap the answer is
   * `complete: false` with no nodes at all: a partial manifest would read as
   * "these files are gone" and a client could delete them during the merge.
   */
  router.get('/api/v1/nodes/:id/merge-manifest', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const root = requireNode(user.id, ctx.params.id)
    if (root.deleted_at) ctx.fail(404, 'NOT_FOUND', 'Folder was not found.')
    if (root.kind !== 'folder') ctx.fail(400, 'NOT_FOLDER', 'Only folders can be merged.')
    const rows = db.prepare(`WITH RECURSIVE sub(id) AS (
        SELECT n.id FROM nodes n
          WHERE n.parent_id=? AND n.deleted_at IS NULL
            AND (n.user_id=? OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id=? AND m.workspace_id=n.workspace_id))
        UNION
        SELECT n.id FROM nodes n JOIN sub s ON n.parent_id=s.id
          WHERE n.deleted_at IS NULL
            AND (n.user_id=? OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id=? AND m.workspace_id=n.workspace_id))
        LIMIT ?
      ) SELECT n.id, n.parent_id, n.kind, n.name, n.size, n.blob_hash, n.version
        FROM sub JOIN nodes n ON n.id=sub.id
        ORDER BY lower(n.name), n.id`)
      .all(root.id, user.id, user.id, user.id, user.id, MERGE_MANIFEST_LIMIT + 1)
    if (rows.length > MERGE_MANIFEST_LIMIT) {
      sendJson(ctx.res, 200, { complete: false, nodes: [] })
      return
    }
    // Field names match the node payload the rest of the API and the upload
    // version guard already speak, so a merge can compare versions directly.
    sendJson(ctx.res, 200, {
      complete: true,
      nodes: rows.map((row) => ({
        id: row.id,
        parentId: row.parent_id ?? null,
        kind: row.kind,
        name: row.name,
        size: row.size,
        blobHash: row.blob_hash ?? null,
        version: row.version,
      })),
    })
  })

  /** Downloads a whole folder as a stored ZIP archive. */
  router.post('/api/v1/nodes/:id/archive', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const folder = requireNode(user.id, ctx.params.id)
    // Same "gone folder" contract the listing routes use; checked before the
    // stream opens so the client still gets a JSON 404.
    if (folder.deleted_at) ctx.fail(404, 'NOT_FOUND', 'Folder was not found.')
    if (folder.kind !== 'folder') ctx.fail(400, 'NOT_A_FILE', 'Only folders can be archived.')
    await sendArchive(ctx, user.id, {
      parentId: folder.parent_id,
      baseName: `${folder.name}.zip`,
      build: async ({ signal, onProgress }) => {
        const { buildZip } = await import('../text/zip.js')
        return buildZip(user.id, folder.id, { signal, onProgress })
      },
    })
  })

  /**
   * Serves a temporary archive by its carrier id.
   *
   * The row is the authorisation: it is owned by the account the caller
   * authenticated as, so a leaked id is useless to anyone else and an unknown
   * one is indistinguishable from an expired one. `sendBlob` keeps Range
   * support, so a resumed download behaves exactly like a stored file.
   *
   * The open/close pair is what keeps the row alive while bytes are in flight:
   * the sweep must not reclaim a blob mid-transfer, and `close` runs on every
   * exit — including a client that hung up halfway.
   */
  router.get('/api/v1/archive-downloads/:id', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const row = await openArchiveDownload(user.id, ctx.params.id)
    try {
      await sendBlob(ctx.req, ctx.res, backend, row.blob_hash, {
        mime: 'application/zip',
        download: true,
        filename: row.name,
        headers: { 'cache-control': 'private, no-store' },
      })
    } finally {
      // Cleanup must never raise: `sendBlob` may already have written headers,
      // may have failed mid-stream, or the client may be gone. A second response
      // here would override the real error, so the failure is logged anonymously
      // (no path, no ids) and dropped.
      try {
        await closeArchiveDownload(row.id)
      } catch {
        console.error('[archive-download] cleanup failed')
      }
    }
  })

  /**
   * Drops a temporary archive the client is done with.
   *
   * Idempotent on purpose: the download panel may release a carrier it already
   * lost to expiry, and a double click must not surface an error. An id that
   * belongs to someone else answers exactly like a missing one and leaves the
   * record untouched.
   */
  router.delete('/api/v1/archive-downloads/:id', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    await releaseArchiveDownload(user.id, ctx.params.id)
    sendJson(ctx.res, 200, { ok: true })
  })
}

export { listNodes }
