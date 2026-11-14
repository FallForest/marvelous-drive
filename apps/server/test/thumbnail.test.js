import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { startServer, uniqueEmail } from './helpers.js'

/**
 * GET /api/v1/files/:id/thumbnail
 *
 * The route hands over the original blob for the three formats a browser can
 * always decode, tagged so it may be cached for a week. Everything else keeps
 * its row icon on the client, which starts with a 415.
 */

let app
let api
let token

before(async () => {
  app = await startServer()
  api = app.client
  const registered = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'thumbnail password' } })
  token = registered.json.token
})

after(async () => {
  await app.close()
  app.cleanup()
})

const auth = (extra = {}) => ({ token, ...extra })

/** One pixel PNG: enough to be a real image, small enough to inline. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/**
 * The shared client reads bodies as text, which mangles binary; thumbnails are
 * compared byte for byte, so this one goes straight to fetch.
 */
async function raw(path, extraHeaders = {}) {
  const response = await fetch('http://127.0.0.1:' + app.port + path, {
    headers: { authorization: 'Bearer ' + token, ...extraHeaders },
  })
  return { status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) }
}

async function upload(name, body, type) {
  const response = await api('PUT', '/api/v1/uploads?name=' + encodeURIComponent(name), auth({
    raw: true,
    body,
    headers: { 'content-type': type },
  }))
  assert.ok(response.status === 200 || response.status === 201, response.text)
  return response.json.node
}

describe('file thumbnails', () => {
  it('answers a png with the stored type and a one week immutable cache', async () => {
    const node = await upload('pixel.png', PNG, 'image/png')
    const response = await raw('/api/v1/files/' + node.id + '/thumbnail?w=240')
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/png')
    // `private`: a week of freshness, scoped to one browser profile. A public
    // response would let a second account in the same profile read this picture.
    assert.equal(response.headers.get('cache-control'), 'private, max-age=604800, immutable')
    assert.equal(response.headers.get('vary'), 'Authorization')
    assert.equal(response.headers.get('content-length'), String(PNG.length))
    assert.equal(response.headers.get('x-thumbnail-width'), '240')
    assert.equal(response.headers.get('x-thumbnail'), null, 'a small image is not tagged as a passthrough')
    assert.deepEqual(response.body, PNG, 'the original bytes are passed through untouched')
  })

  it('clamps the requested width instead of failing on nonsense', async () => {
    const node = await upload('wide.png', PNG, 'image/png')
    const huge = await api('GET', '/api/v1/files/' + node.id + '/thumbnail?w=99999', auth())
    assert.equal(huge.headers.get('x-thumbnail-width'), '1024')
    const nonsense = await api('GET', '/api/v1/files/' + node.id + '/thumbnail?w=abc', auth())
    assert.equal(nonsense.status, 200)
    assert.equal(nonsense.headers.get('x-thumbnail-width'), '240')
  })

  it('is never shared across accounts by a cache', async () => {
    const node = await upload('scoped.png', PNG, 'image/png')
    const response = await raw('/api/v1/files/' + node.id + '/thumbnail')
    const cacheControl = String(response.headers.get('cache-control') || '')
    assert.ok(!/\bpublic\b/.test(cacheControl), 'a bearer-protected body must not be marked public')
    assert.match(cacheControl, /\bprivate\b/)
    assert.match(String(response.headers.get('vary') || ''), /Authorization/i)
  })

  it('ignores Range: a thumbnail is always one whole response', async () => {
    const node = await upload('ranged.png', PNG, 'image/png')
    const response = await raw('/api/v1/files/' + node.id + '/thumbnail', { range: 'bytes=0-3' })
    assert.equal(response.status, 200, 'a 206 would mean Range leaked into the thumbnail route')
    assert.equal(response.headers.get('content-range'), null)
    assert.deepEqual(response.body, PNG)
  })

  it('refuses every format a browser cannot promise to decode', async () => {
    const pdf = await upload('paper.pdf', Buffer.from('%PDF-1.4 not really'), 'application/pdf')
    const response = await api('GET', '/api/v1/files/' + pdf.id + '/thumbnail', auth())
    assert.equal(response.status, 415, response.text)
    assert.equal(response.json.error.code, 'UNSUPPORTED_MEDIA_TYPE')

    const svg = await upload('drawing.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml')
    const other = await api('GET', '/api/v1/files/' + svg.id + '/thumbnail', auth())
    assert.equal(other.status, 415, other.text)
  })

  it('answers 404 for a node that does not exist', async () => {
    const response = await api('GET', '/api/v1/files/00000000-0000-4000-8000-000000000000/thumbnail', auth())
    assert.equal(response.status, 404)
    assert.equal(response.json.error.code, 'NOT_FOUND')
  })

  it('requires a session', async () => {
    const node = await upload('private.png', PNG, 'image/png')
    const response = await api('GET', '/api/v1/files/' + node.id + '/thumbnail')
    assert.equal(response.status, 401)
    assert.equal(response.json.error.code, 'UNAUTHENTICATED')
    const bogus = await api('GET', '/api/v1/files/' + node.id + '/thumbnail', { token: 'not-a-token' })
    assert.equal(bogus.status, 401)
  })
})
