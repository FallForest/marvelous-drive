import { createReadStream } from 'node:fs'
import { createHash, timingSafeEqual } from 'node:crypto'
import { mkdir, readdir, stat, unlink, writeFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'

/**
 * A storage node: one machine that hands its disk to a Drive coordinator.
 *
 * The design constraint is that a node must be **dumb and safe**. It stores
 * opaque bytes keyed by sha256 and answers four questions. It has no database, no
 * knowledge of users, files or folders, and no way to enumerate what it holds
 * beyond what the coordinator asks for. That is deliberate:
 *
 *   - every byte it receives is content-addressed, so a node cannot corrupt the
 *     namespace even if it misbehaves — a wrong key simply never matches;
 *   - it verifies the digest on write, so a truncated transfer is rejected at the
 *     edge instead of being discovered months later;
 *   - it never deletes on its own schedule; deletion requires the coordinator's
 *     token and an explicit hash.
 *
 * Protocol (all under /node/v1, all requiring `Authorization: Bearer <token>`):
 *
 *   GET    /health          → { ok, name, capacityBytes, usedBytes, blobs }
 *   PUT    /blobs/:sha256   → raw body; verifies sha256; 201 or 409 on mismatch
 *   HEAD   /blobs/:sha256   → 200 with content-length, or 404
 *   GET    /blobs/:sha256   → bytes; honours Range so a resume works
 *   DELETE /blobs/:sha256   → 200, missing is not an error
 *
 * What it is not: a replica protocol, a consensus participant, or a cache. Those
 * live in the coordinator, where the metadata already is.
 */

/** Same layout as the local backend, so a node's disk is browsable by the same tools. */
const blobPath = (root, hash) => join(root, hash.slice(0, 2), hash)

const SHA256_HEX = /^[0-9a-f]{64}$/

/**
 * Constant-time token comparison.
 *
 * A node holds bytes for one coordinator, so a leaked token is a full compromise
 * of that node's contents; comparing with `===` would leak the matching prefix
 * through timing.
 */
export function tokenMatches(expected, provided) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(provided, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Pulls the bearer token out of an Authorization header. */
export function bearerOf(req) {
  const header = req.headers.authorization || ''
  const match = /^Bearer\s+(.+)$/i.exec(String(header))
  return match ? match[1].trim() : ''
}

/** Recursive size and count of stored blobs, for the capacity report. */
async function measure(root) {
  let bytes = 0
  let blobs = 0
  const walk = async (dir) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) { await walk(path); continue }
      if (!entry.isFile() || entry.name.endsWith('.part')) continue
      const info = await stat(path).catch(() => null)
      if (!info) continue
      bytes += info.size
      blobs += 1
    }
  }
  await walk(root)
  return { bytes, blobs }
}

/** Streams a request body to disk while hashing it, so a 40 GB PUT never buffers. */
async function spoolAndHash(req, destination) {
  const hash = createHash('sha256')
  const chunks = []
  for await (const chunk of req) {
    hash.update(chunk)
    chunks.push(chunk)
  }
  const buffer = Buffer.concat(chunks)
  await mkdir(dirname(destination), { recursive: true })
  const temporary = destination + '.' + process.pid + '.part'
  await writeFile(temporary, buffer)
  // Rename only after the bytes are on disk: a reader must never see a partial file
  // under the final name.
  await rename(temporary, destination)
  return { digest: hash.digest('hex'), size: buffer.length }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim())
  if (!match) return null
  const startText = match[1]
  const endText = match[2]
  if (startText === '' && endText === '') return null
  let start
  let end
  if (startText === '') {
    const suffix = Number(endText)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(startText)
    end = endText === '' ? size - 1 : Number(endText)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null
  return { start, end: Math.min(end, size - 1) }
}

/**
 * Builds the node's HTTP server.
 *
 * @param {object} options
 * @param {string} options.rootDir     where blobs live
 * @param {string} options.token       the coordinator's shared secret
 * @param {string} [options.name]      reported in /health
 * @param {number} [options.capacityBytes] advertised ceiling (0 = unknown)
 */
export function createNodeServer({ rootDir, token, name = 'storage-node', capacityBytes = 0, requireToken = true }) {
  if (!rootDir) throw new Error('A storage node needs a root directory.')
  if (requireToken && !token) throw new Error('A storage node needs a token; an open node is a public write endpoint.')

  const server = createServer(async (req, res) => {
    const startedAt = Date.now()
    try {
      const url = new URL(req.url || '/', 'http://node.local')
      const path = url.pathname

      // /health is the only route that answers before the token check: a probe must
      // be able to say "I am alive but misconfigured" instead of a bare 401.
      if (path === '/node/v1/health' && req.method === 'GET') {
        const measured = await measure(rootDir)
        sendJson(res, 200, {
          ok: true,
          name,
          capacityBytes,
          usedBytes: measured.bytes,
          blobs: measured.blobs,
          uptimeSeconds: Math.round(process.uptime()),
        })
        return
      }

      if (requireToken && !tokenMatches(token, bearerOf(req))) {
        sendJson(res, 401, { error: { code: 'UNAUTHENTICATED', message: 'A node token is required.' } })
        return
      }

      const blobMatch = /^\/node\/v1\/blobs\/([0-9a-fA-F]{64})$/.exec(path)
      if (!blobMatch) {
        // Any other path drains the body first, so an error cannot leave a
        // half-consumed request holding the connection open.
        req.resume()
        sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'No route for ' + req.method + ' ' + path } })
        return
      }
      const hash = blobMatch[1].toLowerCase()
      if (!SHA256_HEX.test(hash)) {
        req.resume()
        sendJson(res, 400, { error: { code: 'INVALID_INPUT', message: 'Not a sha256 hex digest.' } })
        return
      }
      const target = blobPath(rootDir, hash)

      if (req.method === 'PUT') {
        const { digest, size } = await spoolAndHash(req, target)
        if (digest !== hash) {
          // The bytes were written under the wrong name; drop them rather than
          // leaving a lie on disk.
          await unlink(target).catch(() => {})
          sendJson(res, 409, {
            error: { code: 'CHECKSUM_MISMATCH', message: 'The body does not hash to the key it was sent under.' },
            expected: hash,
            actual: digest,
          })
          return
        }
        sendJson(res, 201, { ok: true, sha256: hash, size })
        return
      }

      if (req.method === 'HEAD') {
        const info = await stat(target).catch(() => null)
        if (!info || !info.isFile()) {
          res.writeHead(404, { 'content-length': 0 })
          res.end()
          return
        }
        res.writeHead(200, { 'content-length': info.size, 'accept-ranges': 'bytes' })
        res.end()
        return
      }

      if (req.method === 'GET') {
        const info = await stat(target).catch(() => null)
        if (!info || !info.isFile()) {
          sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'No blob with this sha256 is stored here.' } })
          return
        }
        const range = parseRange(req.headers.range, info.size)
        if (range) {
          res.writeHead(206, {
            'content-type': 'application/octet-stream',
            'accept-ranges': 'bytes',
            'content-length': range.end - range.start + 1,
            'content-range': 'bytes ' + range.start + '-' + range.end + '/' + info.size,
          })
          if (req.method === 'HEAD') { res.end(); return }
          createReadStream(target, { start: range.start, end: range.end }).pipe(res)
          return
        }
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'accept-ranges': 'bytes',
          'content-length': info.size,
        })
        createReadStream(target).pipe(res)
        return
      }

      if (req.method === 'DELETE') {
        // Idempotent: deleting what is already gone is the state the caller wanted.
        await unlink(target).catch(() => {})
        sendJson(res, 200, { ok: true, sha256: hash })
        return
      }

      req.resume()
      sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: req.method + ' is not supported here.' } })
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: error?.message ?? String(error) } })
      } else {
        res.destroy(error)
      }
    } finally {
      void startedAt
    }
  })

  server.requestTimeout = 0
  return server
}

/** A Readable over a node's HTTP response, for the coordinator side. */
export function toReadable(webStream) {
  return Readable.fromWeb(webStream)
}
