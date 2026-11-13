import { createHash, createHmac } from 'node:crypto'
import { createReadStream, readFileSync, statSync, unlinkSync } from 'node:fs'
import { copyFile, mkdir, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'

/**
 * S3 (and S3-compatible: MinIO, R2, B2) storage backend.
 *
 * The protocol is small: an object is addressed by `bucket/key` and moved with
 * plain HTTP verbs. What is not small is SigV4, the request signing scheme — it
 * is implemented here by hand because this project has no runtime dependencies.
 *
 * Two consequences of "objects, not files" are visible in the interface:
 *   - `path()` cannot exist: there is no local path, so it throws. Callers that
 *     need a path must use `get()` or `link()` instead.
 *   - `link()` degrades to a download into a temp file, because a remote store
 *     cannot hard-link. That is a real cost, and it is why ZIP assembly and Office
 *     extraction are slower on this backend.
 *
 * SigV4 in one paragraph, for the next reader: build a canonical request (method,
 * canonical URI, canonical query, canonical headers, signed headers, payload
 * hash), hash it, then sign "AWS4-<date> ... <hash>" with a key derived by four
 * chained HMACs from the secret. Send the result as `Authorization`. Every part
 * of the canonical request must match byte for byte what the server reconstructs,
 * which is why the URI is encoded twice and headers are lowercased and trimmed.
 */

const ALGORITHM = 'AWS4-HMAC-SHA256'
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex')
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD'

/** RFC 3986 percent-encoding, the one AWS expects (not encodeURIComponent). */
function uriEncode(value, keepSlash = false) {
  let out = ''
  for (const byte of Buffer.from(String(value), 'utf8')) {
    const char = String.fromCharCode(byte)
    if (/[A-Za-z0-9\-._~]/.test(char) || (keepSlash && char === '/')) out += char
    else out += '%' + byte.toString(16).toUpperCase().padStart(2, '0')
  }
  return out
}

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex')
const hmac = (key, data) => createHmac('sha256', key).update(data).digest()

/**
 * Signs one request.
 *
 * Exported because it is the part worth testing on its own: a wrong signature
 * fails with 403 and no useful detail, so the vector from the AWS documentation
 * is used in the test suite.
 */
export function signRequest({
  method,
  host,
  path,
  query = {},
  headers = {},
  payloadHash = EMPTY_SHA256,
  accessKeyId,
  secretAccessKey,
  sessionToken,
  region,
  service,
  now = new Date(),
}) {
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const dateStamp = amzDate.slice(0, 8)
  const canonicalUri = path
    .split('/')
    .map((segment) => uriEncode(segment))
    .join('/')
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((key) => uriEncode(key) + '=' + uriEncode(query[key] ?? ''))
    .join('&')

  const signedHeaderMap = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate }
  if (sessionToken) signedHeaderMap['x-amz-security-token'] = sessionToken
  for (const [key, value] of Object.entries(headers)) signedHeaderMap[key.toLowerCase()] = String(value).trim()

  const signedHeaders = Object.keys(signedHeaderMap).sort()
  const canonicalHeaders = signedHeaders.map((key) => key + ':' + signedHeaderMap[key] + '\n').join('')
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders.join(';'),
    payloadHash,
  ].join('\n')

  const scope = dateStamp + '/' + region + '/' + service + '/aws4_request'
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n')

  const signingKey = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, dateStamp), region), service), 'aws4_request')
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')

  return {
    authorization: ALGORITHM + ' Credential=' + accessKeyId + '/' + scope +
      ', SignedHeaders=' + signedHeaders.join(';') + ', Signature=' + signature,
    headers: { ...signedHeaderMap, authorization: undefined },
    amzDate,
    canonicalRequest,
    stringToSign,
    signature,
  }
}

export class S3Backend {
  constructor(options = {}) {
    const settings = options.settings || {}
    this.name = 's3'
    this.endpoint = String(settings.endpoint || '').replace(/\/+$/, '')
    this.bucket = settings.bucket
    this.region = settings.region || 'us-east-1'
    this.accessKeyId = settings.accessKeyId
    this.secretAccessKey = settings.secretAccessKey
    this.sessionToken = settings.sessionToken || undefined
    this.prefix = (settings.prefix || '').replace(/^\/+|\/+$/g, '')
    // Path style works everywhere (MinIO, R2 with a custom domain). Virtual-host
    // style is the AWS default; keep it opt-in rather than guessing.
    this.forcePathStyle = settings.forcePathStyle !== false
    this.fetchImpl = options.fetchImpl || globalThis.fetch
    if (!this.endpoint || !this.bucket) {
      throw new Error('S3 backend needs DRIVE_S3_ENDPOINT and DRIVE_S3_BUCKET.')
    }
  }

  /** The object key for a blob hash, with the configured prefix. */
  keyFor(key) {
    return this.prefix ? this.prefix + '/' + key : key
  }

  /** True object path (bucket + key), path style or virtual host. */
  objectPath(key) {
    const objectKey = this.keyFor(key)
    if (this.forcePathStyle) return '/' + this.bucket + '/' + objectKey
    return '/' + objectKey
  }

  hostFor() {
    const url = new URL(this.endpoint)
    return this.forcePathStyle ? url.host : this.bucket + '.' + url.host
  }

  async request(method, key, { body, headers = {}, payloadHash, query } = {}) {
    const url = new URL(this.endpoint)
    const signed = signRequest({
      method,
      host: this.hostFor(),
      path: this.objectPath(key),
      query,
      headers,
      payloadHash: payloadHash || EMPTY_SHA256,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      sessionToken: this.sessionToken,
      region: this.region,
      service: 's3',
    })
    const target = this.endpoint + this.objectPath(key)
    const init = {
      method,
      headers: {
        ...signed.headers,
        authorization: signed.authorization,
      },
    }
    if (body !== undefined) {
      init.body = body
      // A streamed body is what makes a multi-GB upload possible, and fetch()
      // refuses one without `duplex: 'half'` (undici demands an explicit mode).
      if (typeof body !== 'string' && !Buffer.isBuffer(body)) init.duplex = 'half'
      // A stream needs an explicit length, or the request is chunked and the
      // signature covers a hash the server cannot check.
      if (!init.headers['content-length'] && typeof body !== 'string' && !Buffer.isBuffer(body)) {
        init.headers['content-length'] = String(body.length ?? '')
      }
    }
    const response = await this.fetchImpl(target, init)
    return response
  }

  async put(key, sourcePath) {
    const info = await stat(sourcePath)
    const payloadHash = await sha256File(sourcePath)
    const stream = createReadStream(sourcePath)
    // The length comes from the file, not from the stream (which has none).
    stream.length = info.size
    const response = await this.request('PUT', key, {
      body: stream,
      payloadHash,
      headers: { 'content-length': info.size, 'content-type': 'application/octet-stream' },
    })
    if (!response.ok) throw new Error('S3 PUT ' + this.keyFor(key) + ' failed: ' + response.status + ' ' + (await response.text()).slice(0, 200))
    await unlink(sourcePath).catch(() => {})
    return this.objectPath(key)
  }

  async putBytes(key, buffer) {
    const response = await this.request('PUT', key, {
      body: buffer,
      payloadHash: sha256Hex(buffer),
      headers: { 'content-length': buffer.length, 'content-type': 'application/octet-stream' },
    })
    if (!response.ok) throw new Error('S3 PUT failed: ' + response.status)
    return this.objectPath(key)
  }

  get(key) {
    // A lazy async generator, so the signature is computed when the stream is
    // first read rather than when the caller builds it.
    const self = this
    return Readable.from((async function* stream() {
      const response = await self.request('GET', key, {})
      if (!response.ok) throw new Error('S3 GET ' + self.keyFor(key) + ' failed: ' + response.status)
      for await (const chunk of response.body) yield Buffer.from(chunk)
    })())
  }

  async stat(key) {
    const response = await this.request('HEAD', key, {})
    if (response.status === 404) return null
    if (!response.ok) throw new Error('S3 HEAD failed: ' + response.status)
    const length = Number(response.headers.get('content-length') || 0)
    return { size: length }
  }

  async remove(key) {
    const response = await this.request('DELETE', key, {})
    // 204 for success, 404 when it was already gone: both are "not there".
    if (!response.ok && response.status !== 404) throw new Error('S3 DELETE failed: ' + response.status)
  }

  /**
   * A local path with the same bytes.
   *
   * A remote store cannot hard-link, so this downloads. That is the honest cost
   * of the abstraction and the reason ZIP assembly is slower here.
   */
  async link(key, targetPath) {
    await mkdir(dirname(targetPath), { recursive: true })
    const chunks = []
    for await (const chunk of this.get(key)) chunks.push(chunk)
    await writeFile(targetPath, Buffer.concat(chunks))
    return targetPath
  }

  /** No local path exists for a remote object. */
  path() {
    throw new Error('The S3 backend has no local paths; use get() or link() instead.')
  }
}

/** Streams a file through sha256, the way the store already hashes uploads. */
async function sha256File(path) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    createReadStream(path).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', resolve)
  })
  return hash.digest('hex')
}

export { EMPTY_SHA256, UNSIGNED_PAYLOAD, uriEncode }