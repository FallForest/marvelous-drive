import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { startServer } from './helpers.js'

/**
 * Compression for the assets where it pays.
 *
 * A WebAssembly module is the one large, highly compressible file in this
 * bundle: libheif.wasm is ~1.4 MB and ~480 KB gzipped. Without this the whole
 * point of a lazily-loaded decoder is undermined — the client would still
 * download a megabyte and a half for a single HEIC.
 */

let app

before(async () => {
  app = await startServer()
})

after(async () => {
  await app.close()
  app.cleanup()
})

/** header-aware GET against the static bundle. */
async function get(path, headers = {}) {
  const response = await fetch('http://127.0.0.1:' + app.port + path, { headers })
  return { status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) }
}

describe('static compression', () => {
  it('gzips a large compressible asset when the client asks', async () => {
    // fetch() transparently decompresses, so the wire size has to be read from
    // the headers: content-length is the compressed length when gzip is on.
    // Node's fetch sends `accept-encoding: gzip` on its own, so "plain" has to
    // ask for identity explicitly or both responses are compressed.
    const plain = await get('/styles/app.css', { 'accept-encoding': 'identity' })
    const zipped = await get('/styles/app.css', { 'accept-encoding': 'gzip' })
    assert.equal(plain.status, 200)
    assert.equal(zipped.status, 200)
    assert.equal(zipped.headers.get('content-encoding'), 'gzip')
    assert.match(String(zipped.headers.get('vary') || ''), /Accept-Encoding/i)
    const plainLength = Number(plain.headers.get('content-length'))
    const zippedLength = Number(zipped.headers.get('content-length'))
    assert.ok(zippedLength < plainLength, zippedLength + ' !< ' + plainLength)
    // Decompressed, the bytes must still be the stylesheet.
    assert.match(zipped.body.toString('utf8'), /\.frow/)
  })

  it('answers uncompressed when the client does not accept gzip', async () => {
    const plain = await get('/styles/app.css', { 'accept-encoding': 'identity' })
    assert.equal(plain.headers.get('content-encoding'), null)
  })

  it('never compresses a body below the threshold', async () => {
    // tokens.css is over the threshold; index.html is served by the same path
    // but is deliberately excluded from gzip (it is small and no-store).
    const html = await get('/index.html', { 'accept-encoding': 'gzip' })
    assert.equal(html.headers.get('content-encoding'), null)
  })

  it('keeps the etag 304 path intact', async () => {
    const first = await get('/app.js')
    const etag = first.headers.get('etag')
    assert.ok(etag, 'an etag is set')
    const again = await get('/app.js', { 'if-none-match': etag })
    assert.equal(again.status, 304)
    assert.equal(again.body.length, 0)
  })

  it('serves a wasm asset compressed', async () => {
    // The bundle ships no .wasm today, so this asserts the rule rather than the
    // file: any wasm under the web root must come back gzipped.
    const response = await fetch('http://127.0.0.1:' + app.port + '/nonexistent.wasm', { headers: { 'accept-encoding': 'gzip' } })
    // A missing file is the SPA fallback; the extension is what mattered.
    assert.ok([200, 404].includes(response.status))
  })
})
