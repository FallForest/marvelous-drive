import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { stat, unlink } from 'node:fs/promises'
import { basename, extname, join, normalize, sep } from 'node:path'
import { config } from './config.js'

/**
 * HTTP plumbing: the error envelope, JSON bodies, raw upload streaming,
 * Range-aware file responses, and static hosting.
 *
 * Nothing here knows about documents or users; routes compose these helpers.
 */

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

export const fail = (status, code, message) => new HttpError(status, code, message)

export function sendJson(res, status, value, headers = {}) {
  const payload = Buffer.from(JSON.stringify(value))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(payload)
}

export function sendEmpty(res, status = 204) {
  res.writeHead(status, { 'content-length': 0 })
  res.end()
}

/** Reads and parses a JSON body, rejecting anything above `limit` bytes. */
export async function readJson(req, limit = 1024 * 1024) {
  const declared = Number(req.headers['content-length'] || 0)
  if (declared > limit) throw fail(413, 'FILE_TOO_LARGE', 'Request body is too large.')
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw fail(413, 'FILE_TOO_LARGE', 'Request body is too large.')
    chunks.push(chunk)
  }
  if (!size) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  try {
    const value = JSON.parse(text)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw fail(400, 'INVALID_INPUT', 'Request body must be a JSON object.')
    }
    return value
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw fail(400, 'INVALID_INPUT', 'Request body is not valid JSON.')
  }
}

/**
 * Streams a raw request body to a temporary file while hashing it.
 *
 * Returns the temp path, byte count, and sha256 so callers can either promote
 * the file to a blob or discard it. Oversized bodies are cut off at `limit`.
 */
export async function spoolBody(req, { limit = config.maxUploadBytes, tmpDir = config.tmpDir, prefix = 'upload' } = {}) {
  const target = join(tmpDir, `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.part`)
  const hash = createHash('sha256')
  let size = 0
  const out = createWriteStream(target)
  const finished = new Promise((resolve, reject) => {
    out.on('error', reject)
    out.on('finish', resolve)
  })
  try {
    for await (const chunk of req) {
      size += chunk.length
      if (size > limit) throw fail(413, 'FILE_TOO_LARGE', `Files are limited to ${limit} bytes.`)
      hash.update(chunk)
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve))
    }
    out.end()
    await finished
    return { path: target, size, sha256: hash.digest('hex') }
  } catch (error) {
    out.destroy()
    await unlink(target).catch(() => {})
    throw error
  }
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
}

export const contentTypeFor = (path, fallback = 'application/octet-stream') =>
  CONTENT_TYPES[extname(path).toLowerCase()] || fallback

/** Parses a single `Range: bytes=a-b` header; returns null when unusable. */
export function parseRange(header, size) {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return null
  let start
  let end
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null
  return { start, end: Math.min(end, size - 1) }
}

/** Sends a file with Range support and a caller-chosen disposition. */
export async function sendFile(req, res, filePath, { mime, download = false, filename } = {}) {
  const info = await stat(filePath).catch(() => null)
  if (!info || !info.isFile()) throw fail(404, 'NOT_FOUND', 'File was not found.')
  const size = info.size
  const type = mime || contentTypeFor(filePath)
  const headers = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=0, must-revalidate',
    'last-modified': info.mtime.toUTCString(),
  }
  if (download) {
    const name = basename(filename || filePath).replace(/["\\\r\n]/g, '_')
    headers['content-disposition'] = `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`
  }
  // A caller that answers one immutable representation (a thumbnail) must not
  // honour Range: a 206 would fragment a response the client caches per URL.
  const range = parseRange(req.headers.range, size)
  if (range) {
    headers['content-range'] = `bytes ${range.start}-${range.end}/${size}`
    headers['content-length'] = range.end - range.start + 1
    res.writeHead(206, headers)
    createReadStream(filePath, { start: range.start, end: range.end }).pipe(res)
    return
  }
  headers['content-length'] = size
  res.writeHead(200, headers)
  if (req.method === 'HEAD') { res.end(); return }
  createReadStream(filePath).pipe(res)
}

/**
 * Sends a stored blob with Range support, streaming from the backend.
 *
 * `sendFile` works on a path, which is fine for the local backend and impossible
 * for a remote one. Every user-facing download goes through here instead, so
 * swapping the backend later does not mean rewriting the routes.
 */
export async function sendBlob(req, res, backend, key, { mime, download = false, filename, headers: extraHeaders, acceptRanges = true } = {}) {
  const info = await backend.stat(key)
  if (!info) throw fail(404, 'NOT_FOUND', 'File was not found.')
  const size = info.size
  const headers = {
    'content-type': mime || 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=0, must-revalidate',
    ...extraHeaders,
  }
  if (download) {
    const name = basename(filename || key).replace(/["\\\r\n]/g, '_')
    headers['content-disposition'] = `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`
  }
  // A caller that answers one immutable representation (a thumbnail) must not
  // honour Range: a 206 would fragment a response the client caches per URL.
  const range = acceptRanges ? parseRange(req.headers.range, size) : null
  const start = range ? range.start : 0
  const end = range ? range.end : size - 1
  if (range) {
    headers['content-range'] = `bytes ${start}-${end}/${size}`
    headers['content-length'] = end - start + 1
    res.writeHead(206, headers)
  } else {
    headers['content-length'] = size
    res.writeHead(200, headers)
  }
  if (req.method === 'HEAD' || size === 0) { res.end(); return }

  // Stream and drop the bytes before `start`: a range request must not buffer the
  // prefix it does not want.
  const source = backend.get(key)
  let position = 0
  try {
    for await (const chunk of source) {
      const chunkStart = position
      const chunkEnd = position + chunk.length - 1
      position += chunk.length
      if (chunkEnd < start) continue
      const slice = chunk.subarray(Math.max(0, start - chunkStart), Math.min(chunk.length, end - chunkStart + 1))
      if (!res.write(slice)) await new Promise((resolve) => res.once('drain', resolve))
      if (position > end) break
    }
  } catch (error) {
    // Headers are already out; the only honest thing left is to cut the socket.
    res.destroy(error)
    return
  }
  source.destroy()
  res.end()
}

/**
 * Serves a file from the web bundle, guarding against path traversal and
 * falling back to index.html for client-side routes.
 */
export async function serveStatic(req, res, rootDir, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0])
  const relative = normalize(decoded).replace(/^([/\\])+/, '')
  if (relative.split(sep).includes('..')) throw fail(404, 'NOT_FOUND', 'File was not found.')
  const target = join(rootDir, relative)
  if (!target.startsWith(rootDir)) throw fail(404, 'NOT_FOUND', 'File was not found.')
  const info = await stat(target).catch(() => null)
  if (info?.isFile()) {
    const isHtml = extname(target).toLowerCase() === '.html'
    // Filenames carry no content hash, so a long max-age would serve stale code
    // for an hour after a deploy (and after every edit in development). Revalidate
    // instead: the ETag makes the revalidation a 304, which costs one round trip
    // and no body.
    const etag = 'W/"' + info.size.toString(16) + '-' + Math.round(info.mtimeMs).toString(16) + '"'
    const headers = {
      'content-type': contentTypeFor(target),
      etag,
      'cache-control': isHtml ? 'no-store' : 'no-cache',
      'x-content-type-options': 'nosniff',
    }
    if (!isHtml && req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers)
      res.end()
      return
    }
    res.writeHead(200, { ...headers, 'content-length': info.size })
    if (req.method === 'HEAD') { res.end(); return }
    createReadStream(target).pipe(res)
    return
  }
  const index = join(rootDir, 'index.html')
  const indexInfo = await stat(index).catch(() => null)
  if (!indexInfo) throw fail(404, 'NOT_FOUND', 'Web client is not built.')
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': indexInfo.size,
    'cache-control': 'no-store',
  })
  if (req.method === 'HEAD') { res.end(); return }
  createReadStream(index).pipe(res)
}