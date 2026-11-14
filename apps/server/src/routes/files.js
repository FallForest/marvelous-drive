import { createWriteStream } from 'node:fs'
import { stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { db, nowIso } from '../db.js'
import { userFromRequest } from '../auth.js'
import { config } from '../config.js'
import { fail, sendBlob, sendFile, sendJson, spoolBody } from '../http.js'
import { adoptBlob, blobPath, releaseBlob, retainBlob } from '../storage/blobs.js'
import { backend, readBlobBuffer } from '../storage/backend.js'
import {
  findFileByName, nodeJson, normalizeConflictStrategy, normalizeName, requireFile, upsertFile,
  uniqueName, createNode,
} from '../nodes.js'
import { recordVersion, listVersions } from '../versions.js'
import { randomId } from '../security.js'
import { recordAudit } from '../ops/audit.js'
import { assertWithinQuota } from '../ops/quota.js'
import { indexNode, removeFromIndex } from '../ops/search-index.js'
import { touchBlob } from '../ops/access-log.js'

/**
 * File content: simple upload, instant (deduplicated) upload, download with
 * Range, and version history.
 *
 * Bytes live in the content-addressed blob store; the database only ever holds
 * hashes. Replacing content appends the previous blob to `node_versions`.
 *
 * Two paths can put bytes into a file:
 *
 * - the classic raw-body upload, which spools, hashes and adopts the bytes;
 * - the instant upload, which is told a sha256 and only creates a node when
 *   that blob is already in the store (`retainBlob`, no bytes on the wire).
 *
 * Name collisions are resolved by `onConflict` — see `upsertFile`.
 */

const SHA256_RE = /^[a-f0-9]{64}$/

/**
 * Thumbnail support: which stored mime types a browser can always decode, and
 * the window the `w` query is clamped into.
 *
 * This route does not resize anything, on purpose. A real thumbnail needs a
 * JPEG/PNG/WebP decoder, a resampler and an encoder in pure Node — there is no
 * runtime dependency to borrow one from and no external process to shell out
 * to. PNG alone is feasible (`node:zlib` inflates, unfiltering is ~80 lines);
 * a baseline + progressive JPEG decoder and a WebP VP8/VP8L decoder each cost
 * several hundred lines and carry real risk on hostile input. Browsers already
 * downsample off the main thread and cache the decoded result, so the trade is
 * passthrough + immutable caching + `<img width height>` + `object-fit: cover`.
 *
 * Path for a real implementation, if it ever pays off:
 *   1. decode to raw RGB (PNG first, then JPEG baseline, then WebP),
 *   2. box-filter down to the requested box plus one bilinear pass,
 *   3. re-encode as a single-store PNG (node:zlib deflate, ~40 lines),
 *   4. cache it beside the blob keyed by `hash@width`; blobs are content
 *      addressed, so the hash is already the cache key.
 */
const THUMBNAIL_MIME = new Set(['image/jpeg', 'image/png', 'image/webp'])
/**
 * Cacheable for a week — but never `public`.
 *
 * The bytes are behind a bearer token, and this server has no per-user URL: the
 * same `/files/:id/thumbnail` answers whoever holds a session for that account.
 * A `public` response is shared by every account in the browser profile, so
 * signing out and back in as someone else would serve the previous account's
 * picture out of the HTTP cache. `private` keeps the week-long freshness (the
 * point of the header) while scoping it to one profile's own cache, and
 * `Vary: Authorization` keeps a shared proxy honest about the same thing.
 */
const THUMBNAIL_CACHE_CONTROL = 'private, max-age=604800, immutable'
const THUMBNAIL_WIDTH_MIN = 16
const THUMBNAIL_WIDTH_MAX = 1024
const THUMBNAIL_WIDTH_DEFAULT = 240
/** Above this size the response is tagged so a client can adapt if it wants. */
const THUMBNAIL_PASSTHROUGH_BYTES = 8 * 1024 * 1024

/** `?w=` to an integer inside [16, 1024], defaulting to 240. */
function thumbnailWidth(raw) {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return THUMBNAIL_WIDTH_DEFAULT
  return Math.min(THUMBNAIL_WIDTH_MAX, Math.max(THUMBNAIL_WIDTH_MIN, Math.round(value)))
}

/**
 * `sendFile` always writes a revalidating `cache-control` and takes the Range
 * branch whenever the client asks for one. A thumbnail must be one whole
 * response a browser may keep for a week, so this wraps `res.writeHead` for the
 * duration of the call instead of duplicating the streaming logic.
 */
async function sendWholeFile(req, res, filePath, { mime, headers }) {
  const writeHead = res.writeHead
  res.writeHead = function patched(status, incoming) {
    return writeHead.call(this, status, { ...incoming, ...headers })
  }
  try {
    // An empty header bag carries no `range`, so sendFile takes its 200 branch.
    await sendFile({ method: req.method, headers: {} }, res, filePath, { mime })
  } finally {
    res.writeHead = writeHead
  }
}

/** Reads a sha256 from a path/body value, rejecting anything that is not hex. */
const sha256OrFail = (value, raise) => {
  const digest = String(value ?? '').trim()
  if (!SHA256_RE.test(digest)) raise(400, 'INVALID_INPUT', 'sha256 must be 64 lowercase hex characters.')
  return digest
}

const uploadPayload = (result, extra = {}) => ({
  node: nodeJson(result.node),
  ...(result.renamedFrom ? { renamedFrom: result.renamedFrom } : {}),
  ...(result.skipped ? { skipped: true } : {}),
  ...extra,
})

/** Consumes and drops a request body so the socket stays reusable. */
async function discardBody(req) {
  let bytes = 0
  for await (const chunk of req) bytes += chunk.length
  return bytes
}

/** The stored blob record, or null; also guards against a lost blob. */
async function storedBlob(hash) {
  const row = db.prepare('SELECT size, refs FROM blobs WHERE hash=?').get(hash)
  if (!row) return null
  // Through the backend: "does it still exist" is not a filesystem question.
  const info = await backend.stat(hash)
  return info ? { size: row.size, refs: row.refs } : null
}

const safeMime = (value) => {
  const raw = String(value || '').split(';')[0].trim().toLowerCase()
  if (!raw || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(raw)) return 'application/octet-stream'
  return raw
}

function nameFromRequest(url, req) {
  const queryName = url.searchParams.get('name')
  if (queryName) return queryName
  const header = String(req.headers['x-file-name'] || '').trim()
  if (header) return decodeURIComponent(header)
  const disposition = String(req.headers['content-disposition'] || '')
  const match = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition)
  if (match) { try { return decodeURIComponent(match[1]) } catch { return match[1] } }
  return 'upload.bin'
}

/** Stores a raw body and returns the promoted blob descriptor. */
async function storeBody(req, limit) {
  const spooled = await spoolBody(req, { limit })
  const hash = await adoptBlob(spooled.path, spooled.size, spooled.sha256)
  return { hash, size: spooled.size, sha256: spooled.sha256 }
}

/** Bytes a same-named live file in the target folder already occupies. */
function replacedBytesFor(userId, parentId, name) {
  const row = db.prepare(`SELECT size FROM nodes
    WHERE user_id=? AND IFNULL(parent_id,'')=IFNULL(?,'') AND name=? AND kind='file' AND deleted_at IS NULL`)
    .get(userId, parentId ?? null, name)
  return row ? row.size : 0
}

export function registerFileRoutes(router) {
  /**
   * Dedup probe: does this drive already hold these exact bytes?
   *
   * Only `size` and `refs` leak — never the on-disk path — and the blob is a
   * global (content-addressed) fact, so the answer is the same for any account
   * that already has that content.
   */
  router.get('/api/v1/blobs/:sha256', async (ctx) => {
    userFromRequest(ctx.req, ctx.url)
    const sha256 = sha256OrFail(ctx.params.sha256, ctx.fail)
    const blob = await storedBlob(sha256)
    if (!blob) ctx.fail(404, 'NOT_FOUND', 'No blob with this sha256 is stored.')
    sendJson(ctx.res, 200, { exists: true, sha256, size: blob.size, refs: blob.refs })
  })

  /**
   * Instant upload: create a file node that points at an existing blob.
   *
   * The request body is a small JSON descriptor; when the blob is missing the
   * route answers `404 BLOB_NOT_FOUND` so the client falls back to a real
   * upload. No bytes are read into a blob here — `retainBlob` is the whole
   * storage cost of a duplicate.
   */
  router.post('/api/v1/uploads/instant', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const input = await ctx.json()
    const sha256 = sha256OrFail(input.sha256, ctx.fail)
    const onConflict = normalizeConflictStrategy(input.onConflict)
    const name = normalizeName(input.name)
    const parentId = input.parentId ?? null
    if (input.size === undefined || input.size === null) ctx.fail(400, 'INVALID_INPUT', 'size is required for an instant upload.')
    const size = Number(input.size)
    if (!Number.isFinite(size) || size < 0) ctx.fail(400, 'INVALID_INPUT', 'size must be a non-negative number of bytes.')
    const blob = await storedBlob(sha256)
    if (!blob) ctx.fail(404, 'BLOB_NOT_FOUND', 'These bytes are not stored yet; upload them normally.')
    if (blob.size !== size) {
      ctx.fail(400, 'INVALID_INPUT', `size does not match the stored blob (${blob.size} bytes).`)
    }
    const mime = input.mime ? safeMime(input.mime) : safeMime(null)
    // `skip` must not touch the refcount at all: no node is created, so the
    // reference that retainBlob would add would never be released.
    const existing = onConflict === 'skip' ? findFileByName(user.id, parentId, name) : null
    if (existing) {
      sendJson(ctx.res, 200, { node: nodeJson(existing), skipped: true, deduplicated: true })
      return
    }
    assertWithinQuota(user.id, size, replacedBytesFor(user.id, parentId, name))
    retainBlob(sha256)
    try {
      const result = upsertFile(user.id, { name, parentId, mime, size, blobHash: sha256, onConflict })
      if (result.skipped) await releaseBlob(sha256)
      if (result.previousBlob) await releaseBlob(result.previousBlob)
      recordAudit(user.id, 'instant-upload', { nodeId: result.node.id, detail: name + ' · ' + size + 'B dedup', ip: ctx.ip })
      await indexNode({ ...result.node, user_id: user.id })
      sendJson(ctx.res, result.skipped ? 200 : 201, uploadPayload(result, { deduplicated: true }))
    } catch (error) {
      await releaseBlob(sha256)
      throw error
    }
  })

  /**
   * Simple upload: create or overwrite `parentId/name` in one request.
   *
   * `onConflict=overwrite|rename|skip` decides what a taken name means; the
   * body is always drained so the error paths keep the connection clean.
   */
  router.put('/api/v1/uploads', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const onConflict = normalizeConflictStrategy(ctx.url.searchParams.get('onConflict'))
    const name = normalizeName(nameFromRequest(ctx.url, ctx.req))
    const parentId = ctx.url.searchParams.get('parentId') || null
    const mime = safeMime(ctx.req.headers['content-type'])
    // Quota is checked twice: once from Content-Length so an over-quota upload
    // costs no disk I/O, and once against the bytes actually stored because a
    // chunked request has no Content-Length at all.
    const declared = Number(ctx.req.headers['content-length'] || 0)
    if (declared > 0) assertWithinQuota(user.id, declared, replacedBytesFor(user.id, parentId, name))
    const blob = await storeBody(ctx.req, config.maxUploadBytes)
    const expected = String(ctx.req.headers['x-checksum-sha256'] || '').toLowerCase()
    if (expected && expected !== blob.sha256) {
      await releaseBlob(blob.hash)
      ctx.fail(409, 'CHECKSUM_MISMATCH', 'The uploaded bytes do not match X-Checksum-Sha256.')
    }
    try {
      assertWithinQuota(user.id, blob.size, replacedBytesFor(user.id, parentId, name))
    } catch (error) {
      await releaseBlob(blob.hash)
      throw error
    }
    const result = upsertFile(user.id, { name, parentId, mime, size: blob.size, blobHash: blob.hash, onConflict })
    if (result.skipped) await releaseBlob(blob.hash)
    if (result.previousBlob) await releaseBlob(result.previousBlob)
    recordAudit(user.id, result.previousBlob ? 'overwrite' : 'upload', { nodeId: result.node.id, detail: name + ' · ' + blob.size + 'B', ip: ctx.ip })
    // Indexing is best effort and deliberately not awaited into the response
    // path any longer than the read itself: a failed index write must not fail
    // the upload.
    await indexNode({ ...result.node, user_id: user.id })
    sendJson(ctx.res, result.created ? 201 : 200, uploadPayload(result))
  })

  /**
   * Replaces the content of an existing file, appending a version.
   *
   * This target always exists, so `skip` means "keep the current bytes" and
   * `rename` makes no sense — there is nothing to rename away from.
   */
  router.put('/api/v1/files/:id/content', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const row = requireFile(user.id, ctx.params.id)
    const onConflict = normalizeConflictStrategy(ctx.url.searchParams.get('onConflict'))
    if (onConflict === 'rename') {
      await discardBody(ctx.req)
      ctx.fail(400, 'INVALID_INPUT', 'onConflict=rename is not valid when replacing an existing file.')
    }
    if (onConflict === 'skip') {
      await discardBody(ctx.req)
      sendJson(ctx.res, 200, { node: nodeJson(row), skipped: true })
      return
    }
    const mime = safeMime(ctx.req.headers['content-type'] || row.mime)
    // Replacing bytes only charges the difference: the old size is still on the
    // books until the update lands.
    const declared = Number(ctx.req.headers['content-length'] || 0)
    if (declared > 0) assertWithinQuota(user.id, declared, row.size)
    const blob = await storeBody(ctx.req, config.maxUploadBytes)
    const expected = String(ctx.req.headers['x-checksum-sha256'] || '').toLowerCase()
    if (expected && expected !== blob.sha256) {
      await releaseBlob(blob.hash)
      ctx.fail(409, 'CHECKSUM_MISMATCH', 'The uploaded bytes do not match X-Checksum-Sha256.')
    }
    try {
      assertWithinQuota(user.id, blob.size, row.size)
    } catch (error) {
      await releaseBlob(blob.hash)
      throw error
    }
    recordVersion(row, user.id)
    db.prepare('UPDATE nodes SET size=?, mime=?, blob_hash=?, version=version+1, updated_at=? WHERE id=?')
      .run(blob.size, mime, blob.hash, nowIso(), row.id)
    if (row.blob_hash) await releaseBlob(row.blob_hash)
    const updated = requireFile(user.id, row.id)
    await indexNode({ ...updated, user_id: user.id })
    sendJson(ctx.res, 200, { node: nodeJson(updated) })
  })

  router.get('/api/v1/files/:id/content', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const row = requireFile(user.id, ctx.params.id)
    if (!row.blob_hash) ctx.fail(404, 'NOT_FOUND', 'This file has no content yet.')
    touchBlob(row.blob_hash)
    // Through the backend, not a path: a future tier/S3 blob has no local path.
    await sendBlob(ctx.req, ctx.res, backend, row.blob_hash, {
      mime: row.mime || 'application/octet-stream',
      download: ctx.url.searchParams.get('download') === '1',
      filename: row.name,
    })
  })

  /**
   * List thumbnails. Only the three formats a browser is certain to decode are
   * accepted; anything else answers `415 UNSUPPORTED_MEDIA_TYPE` so the client
   * keeps the row icon instead of drawing garbage. The bytes are the original
   * blob and the answer is cacheable for a week, because a blob hash can never
   * change — see `THUMBNAIL_MIME` above for why no resize happens here.
   */
  router.get('/api/v1/files/:id/thumbnail', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const row = requireFile(user.id, ctx.params.id)
    const mime = safeMime(row.mime)
    if (!THUMBNAIL_MIME.has(mime)) {
      ctx.fail(415, 'UNSUPPORTED_MEDIA_TYPE', 'Thumbnails exist for image/jpeg, image/png and image/webp only.')
    }
    if (!row.blob_hash) ctx.fail(404, 'NOT_FOUND', 'This file has no content yet.')
    const width = thumbnailWidth(ctx.url.searchParams.get('w'))
    // Through the backend: the store may not be local disk at all.
    const info = await backend.stat(row.blob_hash)
    if (!info) ctx.fail(404, 'BLOB_NOT_FOUND', 'The stored content is missing.')
    touchBlob(row.blob_hash)
    await sendBlob(ctx.req, ctx.res, backend, row.blob_hash, {
      mime,
      // A thumbnail is one whole representation, cached per URL: no Range.
      acceptRanges: false,
      headers: {
        'cache-control': THUMBNAIL_CACHE_CONTROL,
        // Two accounts, one URL: the response body depends on who asked.
        vary: 'Authorization',
        'x-thumbnail-width': String(width),
        // Large originals are still handed over whole: the browser downsamples
        // them itself, but a client that cares may want to know.
        ...(info.size > THUMBNAIL_PASSTHROUGH_BYTES ? { 'x-thumbnail': 'passthrough' } : {}),
      },
    })
  })

  router.get('/api/v1/files/:id/versions', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const row = requireFile(user.id, ctx.params.id)
    const versions = listVersions(row.id)
      .map((version) => ({
        id: version.id,
        version: version.version,
        size: version.size,
        mime: version.mime,
        createdBy: version.created_by,
        createdAt: version.created_at,
        // Ready-made URL so a client does not have to compose the path.
        downloadUrl: '/api/v1/files/' + row.id + '/versions/' + version.id + '/content?download=1',
      }))
    sendJson(ctx.res, 200, { versions, currentVersion: row.version })
  })

  /**
   * Streams the bytes of one historical version.
   *
   * Version history is only useful if you can get the old file back out, and
   * `restore` is a destructive answer to a question that is often just "what was
   * in there?". This endpoint reads the version's own blob without touching the
   * node, so downloading an old copy never changes the live file.
   */
  router.get('/api/v1/files/:id/versions/:versionId/content', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const row = requireFile(user.id, ctx.params.id)
    const version = db.prepare('SELECT * FROM node_versions WHERE id=? AND node_id=?').get(ctx.params.versionId, row.id)
    if (!version) ctx.fail(404, 'NOT_FOUND', 'Version was not found.')
    if (!version.blob_hash) ctx.fail(404, 'NOT_FOUND', 'This version has no stored content.')
    // Through the backend: a remote tier has no local path to stat.
    if (!(await backend.stat(version.blob_hash))) {
      ctx.fail(410, 'GONE', 'The stored bytes for this version are no longer available.')
    }
    const suffix = row.name.match(/\.[^.]+$/) ? row.name.slice(row.name.lastIndexOf('.')) : ''
    const base = suffix ? row.name.slice(0, -suffix.length) : row.name
    const filename = base + ' (v' + version.version + ')' + suffix
    await sendBlob(ctx.req, ctx.res, backend, version.blob_hash, {
      mime: version.mime || row.mime || 'application/octet-stream',
      download: ctx.url.searchParams.get('download') === '1',
      filename,
    })
  })

  router.post('/api/v1/files/:id/versions/:versionId/restore', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const row = requireFile(user.id, ctx.params.id)
    const input = await ctx.json()
    const expected = Number(input.expectedVersion ?? row.version)
    if (expected !== row.version) ctx.fail(409, 'VERSION_CONFLICT', `File is at version ${row.version}; reload and retry.`)
    const version = db.prepare('SELECT * FROM node_versions WHERE id=? AND node_id=?').get(ctx.params.versionId, row.id)
    if (!version) ctx.fail(404, 'NOT_FOUND', 'Version was not found.')
    recordVersion(row, user.id)
    if (version.blob_hash) retainBlob(version.blob_hash)
    db.prepare('UPDATE nodes SET size=?, mime=?, blob_hash=?, version=version+1, updated_at=? WHERE id=?')
      .run(version.size, version.mime, version.blob_hash, nowIso(), row.id)
    // The version row keeps its own reference; the node now points at the old
    // bytes, so the node's reference to the replaced blob has to go.
    if (row.blob_hash) await releaseBlob(row.blob_hash)
    const updated = requireFile(user.id, row.id)
    recordAudit(user.id, 'version-restore', { nodeId: row.id, detail: row.name + ' ← v' + version.version, ip: ctx.ip })
    await indexNode({ ...updated, user_id: user.id })
    sendJson(ctx.res, 200, { node: nodeJson(updated) })
  })

  /** Text preview helper used by the Docs bridge and the web client. */
  router.get('/api/v1/files/:id/text', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const row = requireFile(user.id, ctx.params.id)
    if (!row.blob_hash) ctx.fail(404, 'NOT_FOUND', 'This file has no content yet.')
    const limit = Math.min(Number(ctx.url.searchParams.get('limit') || 512 * 1024), 4 * 1024 * 1024)
    // Read through the backend so a remote tier works here too.
    const buffer = await readBlobBuffer(backend, row.blob_hash)
    const slice = buffer.subarray(0, limit)
    sendJson(ctx.res, 200, {
      id: row.id,
      name: row.name,
      mime: row.mime,
      truncated: buffer.length > limit,
      text: slice.toString('utf8'),
    })
  })
}

export { storeBody, safeMime }