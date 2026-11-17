import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { imageRequestUrl } from '../lib/image-loader.js'

/**
 * Drawer detail must not be replaced by a small, lossy list thumbnail.
 */

const picture = (mime, id = 'n1') => ({ id, name: 'a.jpg', kind: 'file', mime, size: 10 })

describe('imageRequestUrl', () => {
  it('keeps original detail for the three native image formats', () => {
    for (const mime of ['image/jpeg', 'image/png', 'image/webp']) {
      const url = imageRequestUrl(picture(mime))
      assert.equal(url, '/api/v1/files/n1/content', mime)
    }
  })

  it('strips mime parameters before deciding', () => {
    assert.match(imageRequestUrl(picture('image/jpeg; charset=binary')), /content/)
  })

  it('keeps every other format on the content path', () => {
    for (const mime of ['image/gif', 'image/avif', 'image/svg+xml', 'application/pdf']) {
      const url = imageRequestUrl(picture(mime))
      assert.equal(url, '/api/v1/files/n1/content', mime)
    }
  })

  it('does not let a thumbnail width reduce original preview quality', () => {
    assert.equal(imageRequestUrl(picture('image/png'), { width: 512 }), '/api/v1/files/n1/content')
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

  it('keeps original content for native formats', () => {
    assert.match(imageRequestUrl({ id: 'n1', mime: 'image/jpeg' }), /content/)
  })

  it('falls back to the plain content route for anything else', () => {
    assert.equal(imageRequestUrl({ id: 'n1', mime: 'image/bmp' }), '/api/v1/files/n1/content')
  })
})
