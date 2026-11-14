import { db, nowIso } from '../db.js'
import { userFromRequest } from '../auth.js'
import { fail, sendBlob, sendJson } from '../http.js'
import { passwordHash, passwordMatches, randomId, randomToken } from '../security.js'
import { backend } from '../storage/backend.js'
import { requireNode } from '../nodes.js'

/**
 * Public share links.
 *
 * The token is the capability: anyone holding it can read the file (and, with
 * `permission:"downloader"`, fetch the bytes). Optional password, expiry and
 * download budget are enforced on every access, not just at creation.
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
  const row = db.prepare(`SELECT s.*, n.name, n.size, n.mime, n.kind, n.deleted_at
      FROM shares s JOIN nodes n ON n.id=s.node_id WHERE s.token=?`).get(token)
  if (!row) throw fail(404, 'SHARE_NOT_FOUND', 'This link is not valid.')
  if (row.deleted_at) throw fail(404, 'SHARE_NOT_FOUND', 'This link is not valid.')
  if (row.expires_at && row.expires_at < nowIso()) throw fail(404, 'SHARE_NOT_FOUND', 'This link has expired.')
  if (row.max_downloads !== null && row.downloads >= row.max_downloads) {
    throw fail(404, 'SHARE_NOT_FOUND', 'This link has reached its download limit.')
  }
  return row
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
    const row = resolveShare(ctx.params.token)
    const supplied = ctx.url.searchParams.get('password') || ctx.req.headers['x-share-password'] || ''
    if (row.password_hash) {
      if (!supplied) ctx.fail(401, 'SHARE_LOCKED', 'This link is password protected.')
      const ok = await passwordMatches(String(supplied), row.password_hash)
      if (!ok) ctx.fail(401, 'SHARE_LOCKED', 'Wrong password for this link.')
    }
    sendJson(ctx.res, 200, {
      share: {
        token: row.token,
        permission: row.permission,
        expiresAt: row.expires_at,
        maxDownloads: row.max_downloads,
        downloads: row.downloads,
        createdAt: row.created_at,
        node: { id: row.node_id, name: row.name, size: row.size, mime: row.mime, kind: row.kind },
      },
      protected: Boolean(row.password_hash),
      locked: false,
    })
  })

  /** Public download; counts against `maxDownloads`. */
  router.get('/api/v1/shared/:token/content', async (ctx) => {
    const row = resolveShare(ctx.params.token)
    if (row.permission !== 'downloader') ctx.fail(403, 'FORBIDDEN', 'This link does not allow downloads.')
    const supplied = ctx.url.searchParams.get('password') || ctx.req.headers['x-share-password'] || ''
    if (row.password_hash) {
      const ok = supplied ? await passwordMatches(String(supplied), row.password_hash) : false
      if (!ok) ctx.fail(401, 'SHARE_LOCKED', 'This link is password protected.')
    }
    const node = db.prepare('SELECT * FROM nodes WHERE id=?').get(row.node_id)
    if (!node || !node.blob_hash) ctx.fail(404, 'NOT_FOUND', 'File was not found.')
    db.prepare('UPDATE shares SET downloads=downloads+1 WHERE id=?').run(row.id)
    await sendBlob(ctx.req, ctx.res, backend, node.blob_hash, {
      mime: node.mime || 'application/octet-stream',
      download: true,
      filename: node.name,
    })
  })

  router.get('/api/v1/shared/:token/file/:nodeId', async (ctx) => {
    const row = resolveShare(ctx.params.token)
    const supplied = ctx.url.searchParams.get('password') || ctx.req.headers['x-share-password'] || ''
    if (row.password_hash && !(await passwordMatches(String(supplied), row.password_hash))) {
      ctx.fail(401, 'SHARE_LOCKED', 'This link is password protected.')
    }
    const node = db.prepare('SELECT * FROM nodes WHERE id=? AND user_id=? AND deleted_at IS NULL').get(ctx.params.nodeId, row.user_id)
    if (!node || node.kind !== 'file' || !node.blob_hash) ctx.fail(404, 'NOT_FOUND', 'File was not found.')
    if (!isInside(node.id, row.node_id)) ctx.fail(404, 'NOT_FOUND', 'File was not found.')
    await sendBlob(ctx.req, ctx.res, backend, node.blob_hash, {
      mime: node.mime || 'application/octet-stream', download: true, filename: node.name,
    })
  })
}

function isInside(nodeId, ancestorId) {
  let current = nodeId
  let guard = 0
  while (current && guard++ < 512) {
    if (current === ancestorId) return true
    const row = db.prepare('SELECT parent_id FROM nodes WHERE id=?').get(current)
    current = row ? row.parent_id : null
  }
  return false
}
