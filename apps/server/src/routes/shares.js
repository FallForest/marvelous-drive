import { db, nowIso } from '../db.js'
import { userFromRequest } from '../auth.js'
import { fail, sendBlob, sendJson } from '../http.js'
import { passwordHash, passwordMatches, randomId, randomToken } from '../security.js'
import { backend } from '../storage/backend.js'
import { releaseBlob } from '../storage/blobs.js'
import { requireNode } from '../nodes.js'
import { resolveMime } from '../mime.js'
import { officePreview } from './office.js'

/**
 * Public share links.
 *
 * The token is the capability: anyone holding it can read the node behind it.
 * `permission` splits that capability in two:
 *
 *   viewer      read-only. The bytes are streamed inline at /preview (and at
 *               /file/:nodeId), a folder share can be browsed child by child,
 *               and nothing here spends the download budget.
 *   downloader  everything viewer gets, plus attachments — /content, a plain
 *               /file/:nodeId and the folder archive — each of which counts
 *               against `maxDownloads`.
 *
 * Preview never counts: a link with a download budget must not be spent by the
 * recipient merely opening the page. Optional password, expiry and budget are
 * enforced on every access through unlockShare, not just at creation.
 */

function shareJson(row, origin = '') {
  return {
    id: row.id,
    nodeId: row.node_id,
    token: row.token,
    url: `${origin}/s/${row.token}`,
    permission: row.permission,
    expiresAt: row.expires_at,
    maxDownloads: row.max_downloads,
    downloads: row.downloads,
    hasPassword: Boolean(row.password_hash),
    createdAt: row.created_at,
  }
}

function requireShareNode(userId, id) {
  const row = requireNode(userId, id)
  if (row.deleted_at) throw fail(404, 'NOT_FOUND', 'File or folder was not found.')
  return row
}

function resolveShare(token) {
  const row = db.prepare(`SELECT s.*, n.name, n.size, n.mime, n.kind, n.blob_hash, n.deleted_at, n.workspace_id
      FROM shares s JOIN nodes n ON n.id=s.node_id WHERE s.token=?`).get(token)
  if (!row) throw fail(404, 'SHARE_NOT_FOUND', 'This link is not valid.')
  if (row.deleted_at) throw fail(404, 'SHARE_NOT_FOUND', 'This link is not valid.')
  if (row.expires_at && row.expires_at < nowIso()) throw fail(404, 'SHARE_NOT_FOUND', 'This link has expired.')
  if (row.max_downloads !== null && row.downloads >= row.max_downloads) {
    throw fail(404, 'SHARE_NOT_FOUND', 'This link has reached its download limit.')
  }
  return row
}

/**
 * Token first, password second — the pair every public route needs.
 *
 * These two steps used to be copied into each handler, and the fourth copy is
 * exactly the one that forgets the password; one function means a locked link
 * cannot leak bytes through a route somebody added later.
 */
async function unlockShare(ctx) {
  const row = resolveShare(ctx.params.token)
  if (row.password_hash) {
    const supplied = ctx.url.searchParams.get('password') || ctx.req.headers['x-share-password'] || ''
    const ok = supplied ? await passwordMatches(String(supplied), row.password_hash) : false
    if (!ok) throw fail(401, 'SHARE_LOCKED', 'This link is password protected.')
  }
  return row
}

/**
 * Headers for a body the public page renders inline, on our own origin.
 *
 * The bytes are user-supplied: an uploaded .html or .svg opened directly would
 * otherwise run its script against this origin, with this visitor's storage and
 * this link's password in the URL. `sandbox` without allow-* tokens makes that
 * document opaque and script-free; nosniff stops the declared type from being
 * ignored in favour of a sniffed one.
 */
const INLINE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': 'sandbox',
}

/** One node inside the share's subtree; anything else is a 404, not a 403. */
function shareNodeOf(row, nodeId) {
  const node = db.prepare('SELECT * FROM nodes WHERE id=? AND workspace_id=? AND deleted_at IS NULL').get(nodeId, row.workspace_id)
  if (!node || !isInside(node.id, row.node_id, row.workspace_id)) throw fail(404, 'NOT_FOUND', 'File was not found.')
  return node
}

function countDownload(row) {
  const claimed = db.prepare(`UPDATE shares SET downloads=downloads+1 WHERE id=?
      AND (max_downloads IS NULL OR downloads<max_downloads)`).run(row.id)
  if (!claimed.changes) throw fail(404, 'SHARE_NOT_FOUND', 'This link has reached its download limit.')
}

/**
 * The public shape of a folder entry.
 *
 * Deliberately narrower than nodeJson: a recipient of a folder link should learn
 * what the browser needs to draw a row, never blob hashes, versions, parents or
 * ids of anything outside the shared subtree.
 */
function entryJson(row) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    size: row.size,
    mime: resolveMime(row.name, row.mime),
    updatedAt: row.updated_at,
  }
}

function originOf(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim()
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '127.0.0.1').split(',')[0].trim()
  return `${proto}://${host}`
}

export function registerShareRoutes(router) {
  router.post('/api/v1/nodes/:id/share', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const row = requireShareNode(user.id, ctx.params.id)
    const input = await ctx.json().catch(() => ({}))
    const permission = input.permission === 'downloader' ? 'downloader' : 'viewer'
    const expiresInDays = input.expiresInDays === undefined || input.expiresInDays === null ? null : Number(input.expiresInDays)
    if (expiresInDays !== null && (!Number.isFinite(expiresInDays) || expiresInDays <= 0 || expiresInDays > 365)) {
      ctx.fail(400, 'INVALID_INPUT', 'expiresInDays must be between 1 and 365.')
    }
    const maxDownloads = input.maxDownloads === undefined || input.maxDownloads === null ? null : Number(input.maxDownloads)
    if (maxDownloads !== null && (!Number.isInteger(maxDownloads) || maxDownloads < 1)) {
      ctx.fail(400, 'INVALID_INPUT', 'maxDownloads must be a positive integer.')
    }
    const password = input.password ? String(input.password) : ''
    const id = randomId()
    const token = randomToken(24)
    const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 86400000).toISOString() : null
    db.prepare(`INSERT INTO shares(id,node_id,user_id,token,permission,expires_at,password_hash,max_downloads,downloads,created_at)
                VALUES (?,?,?,?,?,?,?,?,0,?)`)
      .run(id, row.id, user.id, token, permission, expiresAt, password ? await passwordHash(password) : null, maxDownloads, nowIso())
    const created = db.prepare('SELECT * FROM shares WHERE id=?').get(id)
    sendJson(ctx.res, 201, { share: shareJson(created, originOf(ctx.req)) })
  })

  router.get('/api/v1/nodes/:id/shares', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const row = requireShareNode(user.id, ctx.params.id)
    const shares = db.prepare('SELECT * FROM shares WHERE node_id=? ORDER BY created_at DESC').all(row.id)
      .map((share) => shareJson(share, originOf(ctx.req)))
    sendJson(ctx.res, 200, { shares })
  })

  router.delete('/api/v1/shares/:id', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const row = db.prepare('SELECT * FROM shares WHERE id=? AND user_id=?').get(ctx.params.id, user.id)
    if (!row) ctx.fail(404, 'NOT_FOUND', 'Share link was not found.')
    db.prepare('DELETE FROM shares WHERE id=?').run(row.id)
    sendJson(ctx.res, 200, { ok: true })
  })

  /** Public metadata read; the password check gates the payload. */
  router.get('/api/v1/shared/:token', async (ctx) => {
    const row = await unlockShare(ctx)
    sendJson(ctx.res, 200, {
      share: {
        token: row.token,
        permission: row.permission,
        expiresAt: row.expires_at,
        maxDownloads: row.max_downloads,
        downloads: row.downloads,
        createdAt: row.created_at,
        node: { id: row.node_id, name: row.name, size: row.size, mime: resolveMime(row.name, row.mime), kind: row.kind },
      },
      protected: Boolean(row.password_hash),
      locked: false,
    })
  })

  /**
   * Inline read of the shared file, for both permissions.
   *
   * This is what the public page points an <img>, an <iframe> or a fetch at, so
   * it must be an inline body and must not count: opening a link is not a
   * download, and a viewer link has no download budget to spend anyway.
   */
  router.get('/api/v1/shared/:token/preview', async (ctx) => {
    const row = await unlockShare(ctx)
    if (row.kind !== 'file' || !row.blob_hash) throw fail(404, 'NOT_FOUND', 'File was not found.')
    await sendBlob(ctx.req, ctx.res, backend, row.blob_hash, {
      mime: resolveMime(row.name, row.mime),
      download: false,
      filename: row.name,
      headers: INLINE_HEADERS,
    })
  })

  /** Public download; downloader only, attachment, counts against `maxDownloads`. */
  router.get('/api/v1/shared/:token/content', async (ctx) => {
    const row = await unlockShare(ctx)
    if (row.permission !== 'downloader') throw fail(403, 'FORBIDDEN', 'This link does not allow downloads.')
    if (row.kind !== 'file' || !row.blob_hash) throw fail(404, 'NOT_FOUND', 'File was not found.')
    await sendBlob(ctx.req, ctx.res, backend, row.blob_hash, {
      mime: resolveMime(row.name, row.mime),
      download: true,
      filename: row.name,
      onStart: () => countDownload(row),
    })
  })

  /**
   * The direct children of a folder share, one level at a time.
   *
   * `parentId` defaults to the shared folder itself and is validated against the
   * share's subtree, so a recipient can walk down from the link but cannot ask
   * for anything the share does not contain — a sibling folder id is a 404, not
   * an empty list.
   */
  router.get('/api/v1/shared/:token/children', async (ctx) => {
    const row = await unlockShare(ctx)
    const parent = shareNodeOf(row, ctx.url.searchParams.get('parentId') || row.node_id)
    if (parent.kind !== 'folder') throw fail(400, 'NOT_FOLDER', 'The parent must be a folder.')
    // Workspace contributors keep ownership of the files they add. The token
    // grants this subtree, irrespective of who created each child.
    const entries = db.prepare(`SELECT id,name,kind,size,mime,updated_at FROM nodes
        WHERE parent_id=? AND workspace_id=? AND deleted_at IS NULL
        ORDER BY (kind='folder') DESC, lower(name)`).all(parent.id, row.workspace_id)
    sendJson(ctx.res, 200, {
      rootId: row.node_id,
      parentId: parent.id,
      permission: row.permission,
      entries: entries.map(entryJson),
    })
  })

  /**
   * The whole folder share as one ZIP, downloader only.
   *
   * The archive is adopted into the blob store so it can be streamed like any
   * other blob, then released: it is a response body, not a node, so it must not
   * appear in anyone's tree or keep disk alive after the response.
   */
  router.get('/api/v1/shared/:token/archive', async (ctx) => {
    const row = await unlockShare(ctx)
    if (row.permission !== 'downloader') throw fail(403, 'FORBIDDEN', 'This link does not allow downloads.')
    if (row.kind !== 'folder') throw fail(400, 'NOT_A_FILE', 'Only a folder share can be archived as a whole.')
    const { buildZipFrom } = await import('../text/zip.js')
    const blob = await buildZipFrom(row.user_id, [{ id: row.node_id }], { workspaceId: row.workspace_id })
    try {
      await sendBlob(ctx.req, ctx.res, backend, blob.hash, {
        mime: 'application/zip',
        download: true,
        filename: row.name + '.zip',
        onStart: () => countDownload(row),
      })
    } finally {
      // The response is already streaming: a cleanup failure must not turn a
      // delivered archive into an error, and the scrub reclaims a stray blob.
      await releaseBlob(blob.hash).catch(() => {})
    }
  })

  /**
   * One file inside the share, permission-aware.
   *
   * A viewer reads it inline — that is how the folder list previews an image or
   * a pdf — and pays nothing. A downloader gets an attachment and the counter
   * moves, unless it passes `inline=1` because it is only previewing; browsing a
   * folder must not drain a link's budget one thumbnail at a time.
   */
  router.get('/api/v1/shared/:token/file/:nodeId', async (ctx) => {
    const row = await unlockShare(ctx)
    const node = shareNodeOf(row, ctx.params.nodeId)
    if (node.kind !== 'file' || !node.blob_hash) throw fail(404, 'NOT_FOUND', 'File was not found.')
    const inline = row.permission !== 'downloader' || ctx.url.searchParams.get('inline') === '1'
    await sendBlob(ctx.req, ctx.res, backend, node.blob_hash, {
      mime: resolveMime(node.name, node.mime),
      download: !inline,
      filename: node.name,
      headers: inline ? INLINE_HEADERS : {},
      onStart: inline ? undefined : () => countDownload(row),
    })
  })

  const office = async (ctx) => {
    const row = await unlockShare(ctx)
    const node = shareNodeOf(row, ctx.params.nodeId || row.node_id)
    if (node.kind !== 'file') throw fail(400, 'NOT_A_FILE', 'Only a file can be previewed.')
    sendJson(ctx.res, 200, await officePreview(node))
  }
  router.get('/api/v1/shared/:token/office', office)
  router.get('/api/v1/shared/:token/office/:nodeId', office)
}

function isInside(nodeId, ancestorId, workspaceId) {
  let current = nodeId
  let guard = 0
  while (current && guard++ < 512) {
    const row = db.prepare('SELECT parent_id FROM nodes WHERE id=? AND workspace_id=? AND deleted_at IS NULL').get(current, workspaceId)
    if (!row) return false
    if (current === ancestorId) return true
    current = row ? row.parent_id : null
  }
  return false
}
