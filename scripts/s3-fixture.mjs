#!/usr/bin/env node
/**
 * A minimal S3-compatible server that **verifies SigV4**.
 *
 *   node scripts/s3-fixture.mjs [--port 9100] [--bucket drive]
 *
 * Docker Hub is not always reachable, and a stub that ignores the Authorization
 * header cannot prove a signature is right — it only proves the client can build
 * a request. This fixture reconstructs the canonical request from the wire and
 * recomputes the signature, so any mistake in encoding, header selection or the
 * key derivation chain shows up as a 403 with the reason.
 *
 * It implements what the backend uses: PUT/GET/HEAD/DELETE of an object, plus a
 * bucket HEAD. Nothing else, on purpose.
 */

import { createHash, createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import { argv, flagReader } from './lib/args.mjs'

const flag = flagReader(argv())

const PORT = Number(flag('port', process.env.S3_PORT || 9100))
const BUCKET = flag('bucket', 'drive')
const ACCESS_KEY = process.env.S3_ACCESS_KEY_ID || 'minioadmin'
const SECRET_KEY = process.env.S3_SECRET_ACCESS_KEY || 'minioadmin'

/** Access-key -> secret, so a rotated key can be expressed. */
const SECRETS = new Map([[ACCESS_KEY, SECRET_KEY]])

const objects = new Map()

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex')
const hmac = (key, data) => createHmac('sha256', key).update(data).digest()

/** The canonical URI: each path segment RFC 3986-encoded, slashes kept. */
function canonicalUri(pathname) {
  return pathname
    .split('/')
    .map((segment) => {
      let out = ''
      for (const byte of Buffer.from(segment, 'utf8')) {
        const char = String.fromCharCode(byte)
        out += /[A-Za-z0-9\-._~]/.test(char) ? char : '%' + byte.toString(16).toUpperCase().padStart(2, '0')
      }
      return out
    })
    .join('/')
}

/** Query parameters, sorted, both sides encoded — AWS's canonical form. */
function canonicalQuery(searchParams) {
  const pairs = [...searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return pairs
    .map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(value))
    .join('&')
}

/**
 * Rebuilds the canonical request from what actually arrived and recomputes the
 * signature. Returns { ok, reason } — a failure names the field that differs.
 */
function verifySignature(req, bodyHash) {
  const header = String(req.headers.authorization || '')
  if (!header.startsWith('AWS4-HMAC-SHA256 ')) return { ok: false, reason: 'missing or unknown Authorization scheme' }
  const fields = Object.fromEntries(
    header.slice('AWS4-HMAC-SHA256 '.length).split(',').map((part) => {
      const [key, value] = part.trim().split('=')
      return [key, value]
    }),
  )
  const credential = fields.Credential || ''
  const matched = /^([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request$/.exec(credential)
  if (!matched) return { ok: false, reason: 'malformed Credential' }
  const [, accessKeyId, dateStamp, region, service] = matched
  const secret = SECRETS.get(accessKeyId)
  if (!secret) return { ok: false, reason: 'unknown access key ' + accessKeyId }
  if (service !== 's3') return { ok: false, reason: 'unexpected service ' + service }

  const signedHeaders = String(fields.SignedHeaders || '').split(';').filter(Boolean)
  const amzDate = String(req.headers['x-amz-date'] || '')
  if (!amzDate) return { ok: false, reason: 'x-amz-date missing from the signed headers' }

  const headerLines = signedHeaders.map((name) => {
    const value = name === 'host' ? String(req.headers.host || '') : String(req.headers[name] ?? '')
    return name + ':' + value.trim() + '\n'
  })
  const canonicalHeaders = headerLines.join('')
  const url = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'))
  const canonicalRequest = [
    req.method,
    canonicalUri(url.pathname),
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    signedHeaders.join(';'),
    bodyHash,
  ].join('\n')

  const scope = dateStamp + '/' + region + '/' + service + '/aws4_request'
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n')
  const signingKey = hmac(hmac(hmac(hmac('AWS4' + secret, dateStamp), region), service), 'aws4_request')
  const expected = createHmac('sha256', signingKey).update(stringToSign).digest('hex')
  if (expected !== fields.Signature) {
    return {
      ok: false,
      reason: 'signature mismatch\n--- canonical request ---\n' + canonicalRequest + '\n--- expected ' + expected + ' got ' + fields.Signature,
    }
  }
  return { ok: true, canonicalRequest }
}

function reply(res, status, headers = {}, body = null) {
  res.writeHead(status, { 'x-amz-request-id': 'fixture', ...headers })
  res.end(body)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'))
  const method = req.method || 'GET'

  // Read the body first: the signature covers its hash.
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = Buffer.concat(chunks)
  const declared = String(req.headers['x-amz-content-sha256'] || '')
  const bodyHash = declared && declared !== 'UNSIGNED-PAYLOAD' ? declared : sha256Hex(body)
  if (declared && declared !== 'UNSIGNED-PAYLOAD' && declared !== sha256Hex(body)) {
    return reply(res, 400, {}, Buffer.from('<Error><Code>XAmzContentSHA256Mismatch</Code></Error>'))
  }

  const verified = verifySignature(req, declared === 'UNSIGNED-PAYLOAD' ? 'UNSIGNED-PAYLOAD' : bodyHash)
  if (!verified.ok) {
    process.stdout.write('[s3] 403 ' + method + ' ' + url.pathname + ': ' + verified.reason + '\n')
    return reply(res, 403, {}, Buffer.from('<Error><Code>SignatureDoesNotMatch</Code></Error>'))
  }

  const parts = url.pathname.split('/').filter(Boolean)
  const bucket = decodeURIComponent(parts[0] || '')
  if (bucket !== BUCKET) return reply(res, 404, {}, Buffer.from('<Error><Code>NoSuchBucket</Code></Error>'))
  const key = parts.slice(1).map(decodeURIComponent).join('/')

  if (!key) {
    // Bucket-level HEAD: what a health check would use.
    if (method === 'HEAD') return reply(res, 200)
    return reply(res, 400, {}, Buffer.from('<Error><Code>NotImplemented</Code></Error>'))
  }

  if (method === 'PUT') {
    objects.set(key, body)
    process.stdout.write('[s3] PUT ' + key + ' (' + body.length + ' bytes)\n')
    return reply(res, 200, { etag: '"' + sha256Hex(body).slice(0, 32) + '"' })
  }

  if (method === 'HEAD') {
    const value = objects.get(key)
    if (!value) return reply(res, 404)
    return reply(res, 200, { 'content-length': String(value.length), etag: '"' + sha256Hex(value).slice(0, 32) + '"' })
  }

  if (method === 'DELETE') {
    const had = objects.delete(key)
    process.stdout.write('[s3] DELETE ' + key + ' (' + (had ? 'removed' : 'absent') + ')\n')
    return reply(res, had ? 204 : 404)
  }

  if (method === 'GET') {
    const value = objects.get(key)
    if (!value) return reply(res, 404, {}, Buffer.from('<Error><Code>NoSuchKey</Code></Error>'))
    // Range matters: drive streams partial reads for video and for resumed
    // downloads, so the fixture has to answer 206 the way S3 does.
    const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range || ''))
    if (range) {
      const start = Number(range[1])
      const end = range[2] === '' ? value.length - 1 : Math.min(Number(range[2]), value.length - 1)
      if (start >= value.length) return reply(res, 416, { 'content-range': 'bytes */' + value.length })
      const slice = value.subarray(start, end + 1)
      return reply(res, 206, {
        'content-length': String(slice.length),
        'content-range': 'bytes ' + start + '-' + end + '/' + value.length,
      }, slice)
    }
    return reply(res, 200, { 'content-length': String(value.length) }, value)
  }

  return reply(res, 405)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log('S3 fixture on http://127.0.0.1:' + PORT + ' (bucket ' + BUCKET + ', key ' + ACCESS_KEY + ')')
  console.log('It verifies SigV4: an unsigned or mis-signed request answers 403 and says why.')
})
