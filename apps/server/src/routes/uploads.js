import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { db, nowIso, transaction } from '../db.js'
import { userFromRequest } from '../auth.js'
import { config } from '../config.js'
import { fail, sendJson } from '../http.js'
import { adoptBlob, releaseBlob, retainBlob } from '../storage/blobs.js'
import { findFileByName, nodeJson, normalizeConflictStrategy, upsertFile } from '../nodes.js'
import { randomId } from '../security.js'
import { safeMime } from './files.js'
import { assertWithinQuota } from '../ops/quota.js'
import { backend } from '../storage/backend.js'

/**
 * Resumable uploads.
 *
 * A session owns a directory of chunk files; `received` in the row is the
 * JSON array of indexes already stored, so a resumed client can ask what is
 * missing instead of tracking state locally. Completion concatenates the
 * chunks into the blob store and creates (or overrides) the file node.
 */

const sessionDir = (id) => join(config.tmpDir, 'sessions', id)

/**
 * The blob record for `hash`, or null.
 *
 * "Exists" is a backend question: a row can survive a lost file, and adopting
 * bytes out of a row that points at nothing would create a node that 500s on
 * download. Same check the instant-upload route uses.
 */
async function existingBlob(hash) {
  const row = db.prepare('SELECT size FROM blobs WHERE hash=?').get(hash)
  if (!row) return null
  const info = await backend.stat(hash)
  return info ? { size: row.size } : null
}

const uploadJson = (row) => ({
  id: row.id,
  name: row.name,
  size: row.size,
  parentId: row.parent_id ?? null,
  chunkSize: row.chunk_size,
  totalChunks: row.total_chunks,
  receivedChunks: JSON.parse(row.received || '[]').sort((a, b) => a - b),
  sha256: row.sha256,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
})

function requireSession(userId, id) {
  const row = db.prepare('SELECT * FROM upload_sessions WHERE id=? AND user_id=?').get(id, userId)
  if (!row) throw fail(404, 'NOT_FOUND', 'Upload session was not found.')
  if (row.expires_at < nowIso()) {
    db.prepare('DELETE FROM upload_sessions WHERE id=?').run(id)
    throw fail(404, 'NOT_FOUND', 'Upload session has expired.')
  }
  return row
}

async function hashFile(path) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    createReadStream(path).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', resolve)
  })
  return hash.digest('hex')
}

/** Bytes an existing same-named file would be replaced by this upload. */
function replacedBytesForUpload(userId, parentId, name) {
  const row = db.prepare(`SELECT size FROM nodes
    WHERE user_id=? AND IFNULL(parent_id,'')=IFNULL(?,'') AND name=? AND kind='file' AND deleted_at IS NULL`)
    .get(userId, parentId ?? null, name)
  return row ? row.size : 0
}

export function registerUploadRoutes(router) {
  router.post('/api/v1/uploads/sessions', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const input = await ctx.json()
    const size = Number(input.size)
    if (!Number.isFinite(size) || size < 0) ctx.fail(400, 'INVALID_INPUT', 'size must be a non-negative number of bytes.')
    if (size > config.maxUploadBytes) ctx.fail(413, 'FILE_TOO_LARGE', `Files are limited to ${config.maxUploadBytes} bytes.`)
    const chunkSize = Number(input.chunkSize || config.upload.defaultChunkSize)
    if (!Number.isFinite(chunkSize) || chunkSize < config.upload.minChunkSize || chunkSize > config.upload.maxChunkSize) {
      ctx.fail(400, 'INVALID_INPUT', `chunkSize must be between ${config.upload.minChunkSize} and ${config.upload.maxChunkSize} bytes.`)
    }
    const name = String(input.name || 'upload.bin').trim()
    if (!name) ctx.fail(400, 'INVALID_INPUT', 'A file name is required.')
    const sha256 = input.sha256 ? String(input.sha256).toLowerCase() : null
    if (sha256 && !/^[a-f0-9]{64}$/.test(sha256)) ctx.fail(400, 'INVALID_INPUT', 'sha256 must be 64 hex characters.')
    // A session reserves the declared size up front: the whole point of a
    // resumable upload is that the bytes are coming, so refusing later is worse
    // than refusing now.
    assertWithinQuota(user.id, size, replacedBytesForUpload(user.id, input.parentId ?? null, name))
    const id = randomId()
    const totalChunks = Math.max(1, Math.ceil(size / chunkSize))
    const createdAt = nowIso()
    const expiresAt = new Date(Date.now() + config.upload.sessionTtlMs).toISOString()
    db.prepare(`INSERT INTO upload_sessions(id,user_id,name,size,sha256,parent_id,chunk_size,total_chunks,received,expires_at,created_at)
                VALUES (?,?,?,?,?,?,?,?,'[]',?,?)`)
      .run(id, user.id, name, size, sha256, input.parentId ?? null, chunkSize, totalChunks, expiresAt, createdAt)
    await mkdir(sessionDir(id), { recursive: true })
    sendJson(ctx.res, 201, { upload: uploadJson(requireSession(user.id, id)) })
  })

  router.get('/api/v1/uploads/sessions/:id', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    sendJson(ctx.res, 200, { upload: uploadJson(requireSession(user.id, ctx.params.id)) })
  })

  router.put('/api/v1/uploads/sessions/:id/chunks/:index', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const session = requireSession(user.id, ctx.params.id)
    const index = Number(ctx.params.index)
    if (!Number.isInteger(index) || index < 0 || index >= session.total_chunks) {
      ctx.fail(400, 'INVALID_INPUT', `Chunk index must be an integer between 0 and ${session.total_chunks - 1}.`)
    }
    const expectedLength = index === session.total_chunks - 1
      ? session.size - index * session.chunk_size
      : session.chunk_size
    const target = join(sessionDir(session.id), String(index).padStart(6, '0'))
    const info = await stat(target).catch(() => null)
    if (info && info.size === expectedLength) {
      // Idempotent retry: the chunk is already stored.
      sendJson(ctx.res, 200, { upload: uploadJson(session) })
      return
    }
    let written = 0
    const out = createWriteStream(target)
    const done = new Promise((resolve, reject) => { out.on('error', reject); out.on('finish', resolve) })
    try {
      for await (const chunk of ctx.req) {
        written += chunk.length
        if (written > Math.max(0, expectedLength) && index !== session.total_chunks - 1) {
          throw fail(400, 'INVALID_INPUT', 'Chunk is larger than chunkSize.')
        }
        if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve))
      }
      out.end()
      await done
    } catch (error) {
      out.destroy()
      await unlink(target).catch(() => {})
      throw error
    }
    if (written !== expectedLength) {
      await unlink(target).catch(() => {})
      ctx.fail(400, 'INVALID_INPUT', `Chunk must be ${expectedLength} bytes, received ${written}.`)
    }
    // Merge against the row as it is *now*, not as it was when this request
    // started reading the body. A client that sends several chunks at once (or
    // two tabs resuming the same session) interleaves inside the wait above, and
    // a read-modify-write on the stale snapshot silently dropped the index of
    // whichever chunk finished first: the bytes were on disk, the row forgot
    // them, and complete answered 409 UPLOAD_INCOMPLETE forever.
    // The connection is one synchronous SQLite handle, so this merge is atomic.
    transaction(() => {
      const fresh = db.prepare('SELECT received FROM upload_sessions WHERE id=?').get(session.id)
      const merged = new Set(JSON.parse((fresh && fresh.received) || '[]'))
      merged.add(index)
      db.prepare('UPDATE upload_sessions SET received=? WHERE id=?')
        .run(JSON.stringify([...merged].sort((a, b) => a - b)), session.id)
    })
    sendJson(ctx.res, 200, { upload: uploadJson(requireSession(user.id, session.id)) })
  })

  /**
   * Assembles a session into a file node.
   *
   * `onConflict` (query or JSON body) picks what happens when the name is
   * already taken in the target folder: overwrite (default), rename, or skip.
   * A skipped completion still drops the session and its temp chunks: the
   * bytes were fully received and hashed, there is just no node to store them
   * under, and the adopted blob is released again.
   */
  router.post('/api/v1/uploads/sessions/:id/complete', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const session = requireSession(user.id, ctx.params.id)
    const input = await ctx.json().catch(() => ({}))
    const onConflict = normalizeConflictStrategy(ctx.url.searchParams.get('onConflict') ?? input.onConflict)
    const received = JSON.parse(session.received || '[]')
    if (received.length !== session.total_chunks) {
      const missing = []
      for (let index = 0; index < session.total_chunks; index++) if (!received.includes(index)) missing.push(index)
      ctx.fail(409, 'UPLOAD_INCOMPLETE', `${missing.length} chunk(s) are still missing.`)
    }
    // Hash the chunks where they lie before writing anything.
    //
    // Assembly used to stream all chunks straight into `assembled-<id>.part`
    // while hashing, so a 1 GiB upload needed 1 GiB of free space on top of the
    // chunks themselves — and the hash only existed at the very end, which made
    // the "these bytes are already in the store" check impossible to do up
    // front. Hashing first costs one extra read of the chunks (they are in the
    // page cache far more often than not) and buys two things: the sha256 is
    // known before a byte is copied, and a mismatch is caught without ever
    // producing the temp file.
    const hash = createHash('sha256')
    for (let index = 0; index < session.total_chunks; index++) {
      const chunkPath = join(sessionDir(session.id), String(index).padStart(6, '0'))
      for await (const buffer of createReadStream(chunkPath)) hash.update(buffer)
    }
    const digest = hash.digest('hex')
    if (session.sha256 && session.sha256 !== digest) {
      await cleanupSession(session.id)
      ctx.fail(409, 'CHECKSUM_MISMATCH', 'The assembled file does not match the declared sha256.')
    }

    // The bytes may already be in the store: the same file uploaded from another
    // device, a retried completion, or a duplicate of something else entirely.
    // Every path that skips assembly here is a multipart upload that cost no
    // extra disk at all.
    const known = await existingBlob(digest)
    if (known && Number(known.size) === Number(session.size)) {
      const existingNode = onConflict === 'skip' ? findFileByName(user.id, session.parent_id, session.name) : null
      await cleanupSession(session.id)
      if (existingNode) {
        sendJson(ctx.res, 200, { node: nodeJson(existingNode), skipped: true, upload: { id: session.id, completed: true } })
        return
      }
      retainBlob(digest)
      let adopted
      try {
        adopted = upsertFile(user.id, {
          name: session.name,
          parentId: session.parent_id,
          mime: safeMime(String(ctx.req.headers['content-type'] || 'application/octet-stream')),
          size: session.size,
          blobHash: digest,
          onConflict,
        })
      } catch (error) {
        await releaseBlob(digest)
        throw error
      }
      if (adopted.skipped) await releaseBlob(digest)
      if (adopted.previousBlob) await releaseBlob(adopted.previousBlob)
      sendJson(ctx.res, adopted.skipped ? 200 : 201, {
        node: nodeJson(adopted.node),
        ...(adopted.renamedFrom ? { renamedFrom: adopted.renamedFrom } : {}),
        ...(adopted.skipped ? { skipped: true } : {}),
        deduplicated: true,
        upload: { id: session.id, completed: true },
      })
      return
    }

    const tempPath = join(config.tmpDir, `assembled-${session.id}.part`)
    const out = createWriteStream(tempPath)
    for (let index = 0; index < session.total_chunks; index++) {
      const chunkPath = join(sessionDir(session.id), String(index).padStart(6, '0'))
      await new Promise((resolve, reject) => {
        const stream = createReadStream(chunkPath)
        stream.on('data', (buffer) => { if (!out.write(buffer)) stream.pause() })
        out.on('drain', () => stream.resume())
        stream.on('error', reject)
        stream.on('end', resolve)
      })
      // The chunk has been copied into the assembly; drop it now instead of at
      // cleanup. Chunks total exactly `size`, so without this the peak is two
      // full copies of the file (chunks + assembled) and a 2 GiB upload on a
      // drive with 3 GiB free fails at the last step. Unlinking as we go keeps
      // the peak at roughly one file. A failure here is harmless — a leftover
      // chunk is removed by cleanupSession / the retention sweep.
      await unlink(chunkPath).catch(() => {})
    }
    out.end()
    await new Promise((resolve, reject) => { out.on('error', reject); out.on('finish', resolve) })
    // A skip that is already known up front does not need the bytes at all.
    const existing = onConflict === 'skip'
      ? findFileByName(user.id, session.parent_id, session.name)
      : null
    if (existing) {
      await unlink(tempPath).catch(() => {})
      await cleanupSession(session.id)
      sendJson(ctx.res, 200, {
        node: nodeJson(existing),
        skipped: true,
        upload: { id: session.id, completed: true },
      })
      return
    }
    const hashValue = await adoptBlob(tempPath, session.size, digest)
    const result = upsertFile(user.id, {
      name: session.name,
      parentId: session.parent_id,
      mime: safeMime(String(ctx.req.headers['content-type'] || 'application/octet-stream')),
      size: session.size,
      blobHash: hashValue,
      onConflict,
    })
    if (result.skipped) await releaseBlob(hashValue)
    if (result.previousBlob) await releaseBlob(result.previousBlob)
    await cleanupSession(session.id)
    sendJson(ctx.res, result.skipped ? 200 : 201, {
      node: nodeJson(result.node),
      ...(result.renamedFrom ? { renamedFrom: result.renamedFrom } : {}),
      ...(result.skipped ? { skipped: true } : {}),
      upload: { id: session.id, completed: true },
    })
  })

  router.delete('/api/v1/uploads/sessions/:id', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const session = requireSession(user.id, ctx.params.id)
    await cleanupSession(session.id)
    sendJson(ctx.res, 200, { ok: true })
  })

  /** Housekeeping for abandoned sessions; runs on boot and after each session. */
  async function cleanupSession(id) {
    db.prepare('DELETE FROM upload_sessions WHERE id=?').run(id)
    const dir = sessionDir(id)
    const files = await readdir(dir).catch(() => [])
    for (const file of files) await unlink(join(dir, file)).catch(() => {})
    const { rm } = await import('node:fs/promises')
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }

  router.get('/api/v1/uploads/sessions', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const rows = db.prepare('SELECT * FROM upload_sessions WHERE user_id=? AND expires_at>? ORDER BY created_at DESC').all(user.id, nowIso())
    sendJson(ctx.res, 200, { uploads: rows.map(uploadJson) })
  })

  /** Drops sessions that expired while the server was down. */
  router.delete('/api/v1/uploads/sessions', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const rows = db.prepare('SELECT id FROM upload_sessions WHERE user_id=? AND expires_at<=?').all(user.id, nowIso())
    for (const row of rows) await cleanupSession(row.id)
    sendJson(ctx.res, 200, { ok: true, removed: rows.length })
  })
}