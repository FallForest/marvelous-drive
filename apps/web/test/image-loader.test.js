import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { imageRequestUrl } from '../lib/image-loader.js'

/**
 * The route choice is the only traffic lever this server offers: the thumbnail
 * path answers with `immutable`, the content path revalidates every time.
 * A picture routed to the wrong one silently costs full bandwidth on every
 * revisit, so the rule is pinned here.
 */

const picture = (mime, id = 'n1') => ({ id, name: 'a.jpg', kind: 'file', mime, size: 10 })

describe('imageRequestUrl', () => {
  it('routes the three resizable-safe formats to the immutable thumbnail path', () => {
    for (const mime of ['image/jpeg', 'image/png', 'image/webp']) {
      const url = imageRequestUrl(picture(mime))
      assert.match(url, /\/api\/v1\/files\/n1\/thumbnail\?w=1024$/, mime)
    }
  })

  it('strips mime parameters before deciding', () => {
    assert.match(imageRequestUrl(picture('image/jpeg; charset=binary')), /thumbnail/)
  })

  it('keeps every other format on the content path', () => {
    for (const mime of ['image/gif', 'image/avif', 'image/svg+xml', 'application/pdf']) {
      const url = imageRequestUrl(picture(mime))
      assert.equal(url, '/api/v1/files/n1/content', mime)
    }
  })

  it('honours a requested width', () => {
    assert.match(imageRequestUrl(picture('image/png'), { width: 512 }), /w=512$/)
  })

  it('answers null without a node', () => {
    assert.equal(imageRequestUrl(null), null)
    assert.equal(imageRequestUrl({ name: 'x.jpg' }), null)
  })
})
describe('HEIC routing', () => {
  it('sends heic and heif to the transcoding route', () => {
    assert.equal(imageRequestUrl({ id: 'n1', mime: 'image/heic' }), '/api/v1/files/n1/preview-image?w=1600')
    assert.equal(imageRequestUrl({ id: 'n1', mime: 'image/heif' }, { width: 800 }), '/api/v1/files/n1/preview-image?w=800')
  })

  it('keeps the immutable thumbnail route for the three native formats', () => {
    assert.match(imageRequestUrl({ id: 'n1', mime: 'image/jpeg' }), /thumbnail/)
  })

  it('falls back to the plain content route for anything else', () => {
    assert.equal(imageRequestUrl({ id: 'n1', mime: 'image/bmp' }), '/api/v1/files/n1/content')
  })
})
