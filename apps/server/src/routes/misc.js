import { db, nowIso } from '../db.js'
import { userFromRequest } from '../auth.js'
import { sendJson } from '../http.js'
import { pathTo, requireNode } from '../nodes.js'
import { config } from '../config.js'
import { sweepExpiredTrash } from '../ops/retention.js'
import { quotaSnapshot } from '../ops/quota.js'
import { AUDIT_RETENTION_DAYS, listAudit } from '../ops/audit.js'
import { indexCoverage, searchContents } from '../ops/search-index.js'
import { addMember, workspaceFor, workspacesFor } from '../workspaces.js'

/** Search, storage statistics, the duplicate report and the health probe. */

const SEARCH_LIMIT_MAX = 100
/** A report longer than this stops being a report and becomes a chore. */
const DUPLICATE_GROUP_LIMIT = 100

export function registerMiscRoutes(router, { version }) {
  router.get('/healthz', async (ctx) => {
    const row = db.prepare('SELECT 1 AS ok').get()
    sendJson(ctx.res, row?.ok === 1 ? 200 : 503, { status: row?.ok === 1 ? 'ok' : 'degraded', version })
  })

  router.get('/api/v1/system/version', async (ctx) => {
    sendJson(ctx.res, 200, { version, name: 'Marvelous Drive' })
  })

  /**
   * Search names and contents.
   *
   * `scope` decides how much work happens: `name` is the old LIKE query,
   * `content` is the FTS5 index, `all` (default) unions them and marks which
   * half matched. Name hits come first because a file called "invoice.pdf" is a
   * better answer to "invoice" than a log line that mentions it.
   */
  router.get('/api/v1/search', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const term = String(ctx.url.searchParams.get('q') || '').trim()
    const limit = Math.min(Math.max(Number(ctx.url.searchParams.get('limit') || 20), 1), SEARCH_LIMIT_MAX)
    const scope = ['all', 'name', 'content'].includes(String(ctx.url.searchParams.get('scope')))
      ? String(ctx.url.searchParams.get('scope'))
      : 'all'
    if (!term) { sendJson(ctx.res, 200, { results: [] }); return }

    const results = []
    const seen = new Set()
    const push = (nodeLike, extra) => {
      if (seen.has(nodeLike.id)) return
      seen.add(nodeLike.id)
      results.push(nodeLike)
    }

    if (scope !== 'content') {
      const pattern = `%${term.replace(/[%_\\]/g, (char) => `\\${char}`)}%`
      const rows = db.prepare(`SELECT * FROM nodes WHERE user_id=? AND deleted_at IS NULL AND name LIKE ? ESCAPE '\\'
          ORDER BY (kind='file') DESC, length(name), lower(name) LIMIT ?`).all(user.id, pattern, limit)
      for (const row of rows) {
        push({
          id: row.id, name: row.name, kind: row.kind, parentId: row.parent_id ?? null,
          size: row.size, mime: row.mime, updatedAt: row.updated_at,
          path: pathTo(user.id, row.parent_id), matched: 'name', snippet: null,
        })
      }
    }

    if (scope !== 'name' && results.length < limit) {
      for (const hit of searchContents(user.id, term, limit)) {
        if (seen.has(hit.nodeId)) continue
        // Same visibility rule as a direct read: owned by the caller, or in a
        // workspace they belong to. Filtering by owner here would throw away the
        // shared hits the index just found.
        const row = db.prepare(`SELECT n.* FROM nodes n
          WHERE n.id=? AND n.deleted_at IS NULL
            AND (n.user_id=? OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id=? AND m.workspace_id=n.workspace_id))`)
          .get(hit.nodeId, user.id, user.id)
        if (!row) continue
        push({
          id: row.id, name: row.name, kind: row.kind, parentId: row.parent_id ?? null,
          size: row.size, mime: row.mime, updatedAt: row.updated_at,
          path: pathTo(user.id, row.parent_id), matched: 'content',
          // `marked` uses the control characters FTS5 was told to emit; the
          // client turns them into <mark> so no markup travels in JSON.
          snippet: String(hit.snippet || '').replace(/\u0001/g, '').replace(/\u0002/g, ''),
        })
        if (results.length >= limit) break
      }
    }

    sendJson(ctx.res, 200, { results: results.slice(0, limit), scope })
  })

  router.get('/api/v1/storage/stats', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const counts = db.prepare(`SELECT
        SUM(CASE WHEN kind='file' AND deleted_at IS NULL THEN 1 ELSE 0 END) AS files,
        SUM(CASE WHEN kind='folder' AND deleted_at IS NULL THEN 1 ELSE 0 END) AS folders,
        SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS trashed,
        SUM(CASE WHEN kind='file' AND deleted_at IS NULL THEN size ELSE 0 END) AS bytes,
        SUM(CASE WHEN starred=1 AND deleted_at IS NULL THEN 1 ELSE 0 END) AS starred
      FROM nodes WHERE user_id=?`).get(user.id)
    const shares = db.prepare('SELECT COUNT(*) AS total FROM shares WHERE user_id=?').get(user.id)
    const uploads = db.prepare('SELECT COUNT(*) AS total FROM upload_sessions WHERE user_id=? AND expires_at>?').get(user.id, nowIso())
    sendJson(ctx.res, 200, {
      stats: {
        files: counts.files || 0,
        folders: counts.folders || 0,
        trashed: counts.trashed || 0,
        bytes: counts.bytes || 0,
        starred: counts.starred || 0,
        quotaBytes: quotaSnapshot(user.id).limit,
        quota: quotaSnapshot(user.id),
        shares: shares.total || 0,
        uploads: uploads.total || 0,
        // "What is taking the space" — rolled up from the extension, which is
        // the only signal every platform agrees on.
        byKind: bytesByKind(user.id),
        trash: trashSummary(user.id),
        // How much of this account's text is actually searchable right now.
        search: indexCoverage(user.id),
      },
    })
  })

  /**
   * Duplicate report (storage P2-4).
   *
   * Blobs are content addressed, so identical bytes already cost one copy on
   * disk — but every node still counts its own size against the quota, and the
   * user sees the same document twice. This report finds the groups where one
   * blob backs several live files and says how much the extra copies "cost".
   *
   * Scope is deliberately per user: blobs are global, so a hash shared with a
   * different account must never appear here.
   */
  router.get('/api/v1/storage/duplicates', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const groups = duplicateGroups(user.id)
    const totalWastedBytes = groups.reduce((sum, group) => sum + group.wastedBytes, 0)
    sendJson(ctx.res, 200, { groups, totalWastedBytes, groupCount: groups.length })
  })

  router.get('/api/v1/nodes/:id/breadcrumb', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    requireNode(user.id, ctx.params.id)
    sendJson(ctx.res, 200, { path: pathTo(user.id, ctx.params.id) })
  })

  /**
   * Every workspace the caller belongs to.
   *
   * `/workspace/members` reports the *active* one; a member added to someone
   * else's drive needs to discover that workspace's id to pass it to
   * `?workspace=`. This is that list.
   */
  router.get('/api/v1/workspaces', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const active = workspaceFor(user.id)
    const list = workspacesFor(user.id).map((entry) => {
      const counts = db.prepare(`SELECT
          SUM(CASE WHEN kind='file' AND deleted_at IS NULL THEN 1 ELSE 0 END) AS files,
          SUM(CASE WHEN kind='folder' AND deleted_at IS NULL THEN 1 ELSE 0 END) AS folders,
          SUM(CASE WHEN kind='file' AND deleted_at IS NULL THEN size ELSE 0 END) AS bytes
        FROM nodes WHERE workspace_id=?`).get(entry.id)
      return {
        ...entry,
        active: Boolean(active && active.id === entry.id),
        files: counts?.files || 0,
        folders: counts?.folders || 0,
        bytes: counts?.bytes || 0,
      }
    })
    sendJson(ctx.res, 200, { workspaces: list })
  })

  /** Who is in the caller's workspace. */
  router.get('/api/v1/workspace/members', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const workspace = workspaceFor(user.id)
    if (!workspace) ctx.fail(500, 'INTERNAL_ERROR', 'The account has no workspace.')
    const members = db.prepare(`SELECT u.id, u.email, u.name, m.role, m.created_at AS joinedAt
      FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id=? ORDER BY m.role, u.name`).all(workspace.id)
    sendJson(ctx.res, 200, { workspace, members })
  })

  /**
   * Adds an existing account to the caller's workspace.
   *
   * There is no mail delivery in this product, so an invite is "an account that
   * already exists by e-mail joins my drive" — honest, immediate, and reversible
   * with `DELETE`.
   */
  router.post('/api/v1/workspace/members', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const workspace = workspaceFor(user.id)
    if (!workspace) ctx.fail(500, 'INTERNAL_ERROR', 'The account has no workspace.')
    if (workspace.role !== 'admin') ctx.fail(403, 'ADMIN_REQUIRED', 'Only a workspace admin can add members.')
    const input = await ctx.json()
    const email = String(input.email || '').trim().toLowerCase()
    if (!email) ctx.fail(400, 'INVALID_INPUT', 'An e-mail is required.')
    const target = db.prepare('SELECT * FROM users WHERE lower(email)=?').get(email)
    if (!target) ctx.fail(404, 'NOT_FOUND', 'No account with that e-mail exists yet.')
    if (target.id === user.id) ctx.fail(400, 'INVALID_INPUT', 'You are already a member of your own workspace.')
    const role = input.role === 'admin' ? 'admin' : 'member'
    addMember(workspace.id, target.id, role)
    const members = db.prepare(`SELECT u.id, u.email, u.name, m.role, m.created_at AS joinedAt
      FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id=?`).all(workspace.id)
    sendJson(ctx.res, 201, { members })
  })

  /** Removes a member (not yourself, and not the workspace owner). */
  router.delete('/api/v1/workspace/members/:id', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const workspace = workspaceFor(user.id)
    if (!workspace) ctx.fail(500, 'INTERNAL_ERROR', 'The account has no workspace.')
    if (workspace.role !== 'admin') ctx.fail(403, 'ADMIN_REQUIRED', 'Only a workspace admin can remove members.')
    const targetId = String(ctx.params.id || '')
    if (targetId === workspace.ownerId) ctx.fail(400, 'INVALID_INPUT', 'The workspace owner cannot be removed.')
    const result = db.prepare('DELETE FROM memberships WHERE workspace_id=? AND user_id=?').run(workspace.id, targetId)
    if (!result.changes) ctx.fail(404, 'NOT_FOUND', 'That account is not a member of this workspace.')
    sendJson(ctx.res, 200, { ok: true })
  })

  /** The caller's own audit trail, newest first. */
  router.get('/api/v1/audit', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const limit = Number(ctx.url.searchParams.get('limit') || 50)
    const entries = listAudit(user.id, {
      limit: Number.isFinite(limit) ? limit : 50,
      nodeId: ctx.url.searchParams.get('nodeId') || null,
      action: ctx.url.searchParams.get('action') || null,
    })
    sendJson(ctx.res, 200, { entries, retentionDays: AUDIT_RETENTION_DAYS })
  })

  /** Purges everything past the retention window right now. */
  router.post('/api/v1/trash/sweep', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const summary = await sweepExpiredTrash()
    sendJson(ctx.res, 200, {
      swept: summary.roots,
      nodes: summary.nodes,
      bytes: summary.bytes,
      blobs: summary.blobs,
      cutoff: summary.cutoff,
      retentionDays: config.trashRetentionDays,
    })
  })
}

const KIND_BY_EXTENSION = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'heic', 'tiff'],
  video: ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v'],
  audio: ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac', 'opus'],
  document: ['pdf', 'doc', 'docx', 'odt', 'rtf', 'md', 'markdown', 'txt', 'pptx', 'ppt', 'odp', 'xlsx', 'xls', 'ods', 'csv'],
  archive: ['zip', 'gz', 'tar', 'rar', '7z', 'bz2', 'xz'],
  code: ['js', 'mjs', 'ts', 'tsx', 'jsx', 'css', 'html', 'py', 'rb', 'go', 'rs', 'java', 'sh', 'sql', 'json', 'yml', 'yaml', 'toml', 'ini'],
}

const extOf = (name) => {
  const match = /\.([a-z0-9]+)$/i.exec(String(name || ''))
  return match ? match[1].toLowerCase() : ''
}

/** Bytes and file counts per coarse kind, plus an `other` bucket. */
export function bytesByKind(userId) {
  const rows = db.prepare("SELECT name, size FROM nodes WHERE user_id=? AND kind='file' AND deleted_at IS NULL").all(userId)
  const buckets = {}
  let total = 0
  for (const row of rows) {
    const extension = extOf(row.name)
    let kind = 'other'
    for (const [candidate, extensions] of Object.entries(KIND_BY_EXTENSION)) {
      if (extensions.includes(extension)) { kind = candidate; break }
    }
    if (!buckets[kind]) buckets[kind] = { files: 0, bytes: 0 }
    buckets[kind].files += 1
    buckets[kind].bytes += row.size || 0
    total += row.size || 0
  }
  // Stable order so the UI does not shuffle between requests.
  const order = ['document', 'image', 'video', 'audio', 'archive', 'code', 'other']
  const out = {}
  for (const kind of order) if (buckets[kind]) out[kind] = buckets[kind]
  return { totalBytes: total, kinds: out }
}

/**
 * Groups of live files of one account whose bytes are identical.
 *
 * `blobs.refs >= 2` is only a cheap pre-filter: refs also count version rows
 * and other accounts, so the per-user node count after the join is what decides
 * whether a hash is really a duplicate group.
 *
 * `path` is the parent chain from the root down ({id,name} segments, the file
 * itself excluded) so a client can print "报告 / 2026 / 草稿" without a second
 * round trip per row.
 */
export function duplicateGroups(userId, { limit = DUPLICATE_GROUP_LIMIT } = {}) {
  const rows = db.prepare(`SELECT n.id, n.name, n.parent_id, n.updated_at, n.size, n.blob_hash, b.size AS blob_size
      FROM nodes n JOIN blobs b ON b.hash = n.blob_hash
      WHERE n.user_id=? AND n.deleted_at IS NULL AND n.kind='file' AND n.blob_hash IS NOT NULL AND b.refs >= 2`)
    .all(userId)

  const buckets = new Map()
  for (const row of rows) {
    if (!buckets.has(row.blob_hash)) buckets.set(row.blob_hash, [])
    buckets.get(row.blob_hash).push(row)
  }

  const pathCache = new Map()
  const pathFor = (parentId) => {
    const key = parentId || ''
    if (!pathCache.has(key)) {
      pathCache.set(key, parentId ? pathTo(userId, parentId).map((part) => ({ id: part.id, name: part.name })) : [])
    }
    return pathCache.get(key)
  }

  const groups = []
  for (const [hash, list] of buckets) {
    if (list.length < 2) continue
    const size = Number(list[0].blob_size ?? list[0].size ?? 0)
    list.sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)) || String(a.name).localeCompare(String(b.name)))
    groups.push({
      hash,
      size,
      wastedBytes: size * (list.length - 1),
      nodes: list.map((row) => ({
        id: row.id,
        name: row.name,
        parentId: row.parent_id ?? null,
        path: pathFor(row.parent_id),
        updatedAt: row.updated_at,
      })),
    })
  }

  // Biggest waste first; ties keep a stable hash order so two calls agree.
  groups.sort((a, b) => b.wastedBytes - a.wastedBytes || (b.nodes.length - a.nodes.length) || a.hash.localeCompare(b.hash))
  return limit > 0 ? groups.slice(0, limit) : groups
}

/** How much is in the trash and when the oldest item falls out. */
export function trashSummary(userId, now = Date.now()) {
  const row = db.prepare(`SELECT COUNT(*) AS nodes, SUM(size) AS bytes, MIN(deleted_at) AS oldest
      FROM nodes WHERE user_id=? AND deleted_at IS NOT NULL`).get(userId)
  const retention = config.trashRetentionDays
  const oldest = row && row.oldest ? row.oldest : null
  const expiresAt = oldest && retention > 0
    ? new Date(Date.parse(oldest) + retention * 86400000).toISOString()
    : null
  return { nodes: row?.nodes || 0, bytes: row?.bytes || 0, oldestAt: oldest, expiresAt, retentionDays: retention }
}