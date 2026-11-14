import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { thumbnailSourceFor } from '../lib/files.js'

/**
 * Which route a row asks for its thumbnail.
 *
 * Two routes exist for a reason: /thumbnail only answers jpeg/png/webp, and
 * HEIC needs the transcoder. Asking the wrong one is a 415 per row, which looks
 * like "this app cannot show my photos".
 */

describe('thumbnailSourceFor', () => {
  it('routes the three native formats to the thumbnail route', () => {
    for (const mime of ['image/png', 'image/jpeg', 'image/webp']) {
      assert.equal(thumbnailSourceFor({ id: 'n', kind: 'file', mime }), 'thumbnail', mime)
    }
  })

  it('routes HEIC to the transcoding route', () => {
    // The bug this pins: /thumbnail answers 415 for HEIC, and the gate only
    // asked canThumbnail(), so a folder of phone photos rendered as a grid of
    // generic picture icons with no thumbnail at all.
    assert.equal(thumbnailSourceFor({ id: 'n', kind: 'file', mime: 'image/heic' }), 'preview-image')
    assert.equal(thumbnailSourceFor({ id: 'n', kind: 'file', mime: 'image/heif' }), 'preview-image')
  })

  it('has no source for a folder or an undecodable format', () => {
    assert.equal(thumbnailSourceFor({ id: 'n', kind: 'folder', mime: null }), null)
    assert.equal(thumbnailSourceFor({ id: 'n', kind: 'file', mime: 'image/tiff' }), null)
    assert.equal(thumbnailSourceFor(null), null)
  })

  it('strips mime parameters', () => {
    assert.equal(thumbnailSourceFor({ id: 'n', kind: 'file', mime: 'image/heic; charset=binary' }), 'preview-image')
  })
})
