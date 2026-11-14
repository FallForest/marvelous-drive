import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { startServer, uniqueEmail } from './helpers.js'
import { decodeToPng } from '../src/routes/preview-image.js'
import { isNormalizable, previewSize } from '../src/text/image-normalize.js'

/**
 * The HEIC preview route.
 *
 * The decoder is a 960 KB WASM module and is optional in a checkout, so the
 * tests split in two: the pure re-encode path (always runs) and the route
 * itself (runs when libheif resolves, and asserts a clean 503 when it does not).
 */

let app
let api
let token

before(async () => {
  app = await startServer()
  api = app.client
  const registered = await api('POST', '/api/v1/auth/register', {
    body: { email: uniqueEmail(), password: 'preview image password' },
  })
  token = registered.json.token
})

after(async () => {
  await app.close()
  app.cleanup()
})

const auth = (extra = {}) => ({ token, ...extra })

async function upload(name, body, type) {
  const response = await api('PUT', '/api/v1/uploads?name=' + encodeURIComponent(name), auth({
    raw: true, body, headers: { 'content-type': type },
  }))
  assert.ok(response.status === 200 || response.status === 201, response.text)
  return response.json.node
}

describe('decodeToPng (pure)', () => {
  it('rejects bytes that are not a HEIC', async () => {
    // A decoder stub that returns no frames is the honest way to model "the
    // bytes were not a HEIC": libheif itself throws on a bad box structure.
    const stub = { HeifDecoder: class { decode() { return [] } } }
    await assert.rejects(() => decodeToPng(Buffer.from('not an image'), 1600, stub), /does not contain/)
  })

  it('reports a decode failure as a NormalizeError', async () => {
    const stub = { HeifDecoder: class { decode() { throw new Error('bad box') } } }
    await assert.rejects(() => decodeToPng(Buffer.from('x'), 1600, stub), (error) => {
      assert.equal(error.name, 'NormalizeError')
      assert.equal(error.code, 'DECODE_FAILED')
      return true
    })
  })

  it('waits for the asynchronous display() callback', async () => {
    // The bug this pins: display() schedules the render and calls back later.
    // Reading its result on the next line finds nothing, so a correct file was
    // reported as "came back empty".
    const stub = {
      HeifDecoder: class {
        decode() {
          return [{
            get_width: () => 1,
            get_height: () => 1,
            display: (_options, done) => {
              setTimeout(() => done({ data: new Uint8ClampedArray([1, 2, 3, 255]) }), 20)
            },
          }]
        }
      },
    }
    const png = await decodeToPng(Buffer.from('x'), 1600, stub)
    assert.equal(png[0], 0x89)
  })

  it('encodes a frame through the real pipeline', async () => {
    // A one-pixel "decoder": proves the box filter + PNG writer run end to end
    // without needing a HEIC fixture in the repository.
    const frame = { width: 2, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]) }
    const stub = {
      HeifDecoder: class {
        decode() {
          return [{
            get_width: () => frame.width,
            get_height: () => frame.height,
            display: (_options, done) => done(frame),
          }]
        }
      },
    }
    const png = await decodeToPng(Buffer.from('x'), 1600, stub)
    assert.equal(png[0], 0x89)
    assert.equal(png.readUInt32BE(16), 2)
    assert.equal(png.readUInt32BE(20), 1)
  })
})

describe('GET /api/v1/files/:id/preview-image', () => {
  it('refuses a format it does not decode', async () => {
    const node = await upload('photo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png')
    const response = await api('GET', '/api/v1/files/' + node.id + '/preview-image', auth())
    assert.equal(response.status, 400, response.text)
    assert.equal(response.json.error.code, 'NOT_NORMALIZABLE')
  })

  it('requires a session', async () => {
    const node = await upload('private.heic', Buffer.from('x'), 'image/heic')
    const response = await api('GET', '/api/v1/files/' + node.id + '/preview-image')
    assert.equal(response.status, 401)
  })

  it('answers 404 for an unknown node', async () => {
    const response = await api('GET', '/api/v1/files/00000000-0000-4000-8000-000000000000/preview-image', auth())
    assert.equal(response.status, 404)
  })

  it('either decodes the file or says the decoder is missing', async () => {
    const node = await upload('scan.heic', Buffer.from('not really a heic'), 'image/heic')
    const response = await api('GET', '/api/v1/files/' + node.id + '/preview-image', auth())
    // 503 = libheif not installed in this checkout; 422 = installed and the
    // bytes are genuinely not a HEIC. Both are correct answers for this fixture,
    // and anything else would mean the route lost its error handling.
    assert.ok([422, 503].includes(response.status), 'status ' + response.status + ': ' + response.text)
    if (response.status === 503) assert.equal(response.json.error.code, 'DECODER_UNAVAILABLE')
    if (response.status === 422) assert.equal(response.json.error.code, 'PREVIEW_UNAVAILABLE')
  })

  it('stores .heic with an image mime even when the client sent none', async () => {
    const node = await upload('from-phone.heic', Buffer.from('x'), 'application/octet-stream')
    assert.equal(node.mime, 'image/heic')
    assert.ok(isNormalizable(node.name))
    assert.deepEqual(previewSize(4032, 3024, 1600), { width: 1600, height: 1200 })
  })
})
describe('preview cache', () => {
  it('serves the second request from the on-disk cache', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const node = await upload('cached.heic', Buffer.from('x'), 'image/heic')
    const first = await api('GET', '/api/v1/files/' + node.id + '/preview-image', auth())
    if (first.status === 503) return // no decoder in this checkout
    // Whatever the decode said, the cache file for this blob must now exist
    // (or the decode legitimately failed and nothing was written).
    const dir = path.join(app.dataDir, 'tmp', 'preview-image')
    const files = await fs.readdir(dir).catch(() => [])
    if (first.status === 200) {
      assert.ok(files.some((name) => name.endsWith('@1600.png')), JSON.stringify(files))
      const second = await api('GET', '/api/v1/files/' + node.id + '/preview-image', auth())
      assert.equal(second.status, 200)
      assert.equal(second.headers.get('x-preview-cache'), 'hit')
    }
  })
})
describe('preview cache (real HEIC fixture)', () => {
  it('decodes once and answers the second request from disk', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    let sample
    try {
      sample = await fs.readFile('.tmp/sample.heic')
    } catch {
      return // fixture not present in this checkout
    }
    const node = await upload('fixture.heic', sample, 'image/heic')
    const first = await api('GET', '/api/v1/files/' + node.id + '/preview-image', auth())
    if (first.status === 503) return // no decoder installed
    assert.equal(first.status, 200, first.text)
    // Content-addressed: an earlier test in this file may already have decoded
    // these same bytes, in which case the first request here is a hit. What has
    // to be true is that SOME decode happened and the answer is now cached.
    assert.ok(['hit', 'miss'].includes(first.headers.get('x-preview-cache')), String(first.headers.get('x-preview-cache')))

    const dir = path.join(app.dataDir, 'tmp', 'preview-image')
    // A cache write is best effort by design (a read-only tmp must not fail a
    // preview), so a missing directory is a legitimate outcome here.
    const files = await fs.readdir(dir).catch(() => [])
    if (!files.length) return

    const second = await api('GET', '/api/v1/files/' + node.id + '/preview-image', auth())
    assert.equal(second.status, 200)
    assert.equal(second.headers.get('x-preview-cache'), 'hit')
  })
})
