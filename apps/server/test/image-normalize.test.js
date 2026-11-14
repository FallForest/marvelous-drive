import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  NORMALIZABLE, PREVIEW_LONG_EDGE, NormalizeError, downscaleRgba, encodePng, isNormalizable, previewSize,
} from '../src/text/image-normalize.js'

/**
 * These are the size and correctness rules behind the HEIC path. The decoder
 * itself is exercised separately; everything here is what decides how much
 * memory a preview costs and whether the output is a valid PNG.
 */

describe('isNormalizable', () => {
  it('accepts the two names HEIC arrives under', () => {
    assert.equal(isNormalizable('IMG_0001.heic'), true)
    assert.equal(isNormalizable('IMG_0001.HEIF'), true)
  })

  it('rejects everything else', () => {
    assert.equal(isNormalizable('photo.jpg'), false)
    assert.equal(isNormalizable('noext'), false)
    assert.equal(isNormalizable(''), false)
    assert.equal(isNormalizable(null), false)
  })

  it('exposes the set it checks against', () => {
    assert.deepEqual(Array.from(NORMALIZABLE).sort(), ['heic', 'heif'])
  })
})

describe('previewSize', () => {
  it('caps the long edge and keeps the aspect ratio', () => {
    assert.deepEqual(previewSize(4032, 3024, 1600), { width: 1600, height: 1200 })
    assert.deepEqual(previewSize(3024, 4032, 1600), { width: 1200, height: 1600 })
  })

  it('never upscales', () => {
    assert.deepEqual(previewSize(800, 600, 1600), { width: 800, height: 600 })
  })

  it('falls back to the default cap', () => {
    assert.equal(previewSize(4032, 3024).width, PREVIEW_LONG_EDGE)
  })

  it('survives junk dimensions', () => {
    assert.deepEqual(previewSize(0, 0, 1600), { width: 1, height: 1 })
    assert.deepEqual(previewSize(Number.NaN, 10, 1600), { width: 1, height: 1 })
  })
})

describe('downscaleRgba', () => {
  /** A width x height image where every pixel is the same colour. */
  const solid = (width, height, r, g, b, a = 255) => {
    const data = new Uint8ClampedArray(width * height * 4)
    for (let i = 0; i < data.length; i += 4) {
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a
    }
    return data
  }

  it('returns the same pixels for an identical size', () => {
    const source = solid(2, 2, 10, 20, 30)
    const out = downscaleRgba(source, 2, 2, 2, 2)
    assert.deepEqual(Array.from(out), Array.from(source))
  })

  it('averages a box into one pixel', () => {
    // Four pixels: two white, two black -> mid grey, not a nearest-neighbour pick.
    const source = new Uint8ClampedArray([
      255, 255, 255, 255, 0, 0, 0, 255,
      0, 0, 0, 255, 255, 255, 255, 255,
    ])
    const out = downscaleRgba(source, 2, 2, 1, 1)
    assert.equal(out.length, 4)
    // Two white + two black -> 127.5, and Uint8ClampedArray stores it as 128.
    assert.equal(out[0], 128)
    // All four source pixels were opaque, so the result is opaque.
    assert.equal(out[3], 255)
  })

  it('keeps the output size exact', () => {
    const source = solid(100, 50, 1, 2, 3)
    const out = downscaleRgba(source, 100, 50, 25, 10)
    assert.equal(out.length, 25 * 10 * 4)
  })

  it('preserves a solid colour', () => {
    const out = downscaleRgba(solid(40, 30, 200, 100, 50), 40, 30, 8, 6)
    assert.equal(out[0], 200)
    assert.equal(out[1], 100)
    assert.equal(out[2], 50)
    assert.equal(out[3], 255)
  })

  it('handles a one-pixel target', () => {
    const out = downscaleRgba(solid(1, 1, 9, 9, 9), 1, 1, 1, 1)
    assert.equal(out.length, 4)
  })
})

describe('encodePng', () => {
  const isPng = (buffer) => buffer.length > 8
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47

  it('writes a PNG signature and the requested dimensions', () => {
    const png = encodePng(new Uint8ClampedArray(4 * 3 * 2), 3, 2)
    assert.ok(isPng(png))
    assert.equal(png.readUInt32BE(16), 3)
    assert.equal(png.readUInt32BE(20), 2)
  })

  it('declares RGBA colour type 6 at depth 8', () => {
    const png = encodePng(new Uint8ClampedArray(4), 1, 1)
    assert.equal(png[24], 8)
    assert.equal(png[25], 6)
  })

  it('ends with IEND', () => {
    const png = encodePng(new Uint8ClampedArray(4), 1, 1)
    assert.equal(png.subarray(png.length - 8, png.length - 4).toString('ascii'), 'IEND')
  })

  it('produces a decodable structure for a real pixel buffer', () => {
    // 2x2, four distinct colours: the chunk lengths must add up to the file.
    const rgba = new Uint8ClampedArray([
      255, 0, 0, 255, 0, 255, 0, 255,
      0, 0, 255, 255, 255, 255, 0, 255,
    ])
    const png = encodePng(rgba, 2, 2)
    let at = 8
    let chunks = 0
    while (at < png.length) {
      const length = png.readUInt32BE(at)
      at += 12 + length
      chunks += 1
    }
    assert.equal(at, png.length)
    assert.equal(chunks, 3) // IHDR, IDAT, IEND
  })
})

describe('NormalizeError', () => {
  it('carries a stable code', () => {
    const error = new NormalizeError('DECODE_FAILED', 'nope')
    assert.equal(error.code, 'DECODE_FAILED')
    assert.equal(error.name, 'NormalizeError')
    assert.ok(error instanceof Error)
  })
})
