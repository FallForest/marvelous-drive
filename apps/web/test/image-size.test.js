import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { imageSize } from '../lib/image-size.js'
import { makePng } from '../../../scripts/lib/png.mjs'

/**
 * Reading the size from the header is what stops the decoder from UPSCALING a
 * small picture to the drawer width, so each format's layout is pinned with
 * bytes that really are that format.
 */

const bytes = (...values) => Uint8Array.from(values)

/** A minimal but structurally valid JPEG header with one SOF0 segment. */
function jpegHeader(width, height) {
  return bytes(
    0xff, 0xd8,                                     // SOI
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // APP0
    0xff, 0xc0, 0x00, 0x11, 0x08,                   // SOF0, length 17, precision 8
    (height >> 8) & 0xff, height & 0xff,            // height
    (width >> 8) & 0xff, width & 0xff,              // width
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,
  )
}

describe('imageSize', () => {
  it('reads a PNG that a real encoder produced', () => {
    const png = makePng(300, 200)
    assert.deepEqual(imageSize(new Uint8Array(png)), { width: 300, height: 200 })
  })

  it('reads a JPEG SOF0', () => {
    assert.deepEqual(imageSize(jpegHeader(1920, 1080)), { width: 1920, height: 1080 })
  })

  it('skips an EXIF segment before the SOF', () => {
    const jpeg = jpegHeader(640, 480)
    // Splice a second APP1 segment in front of the SOF.
    const app1 = bytes(0xff, 0xe1, 0x00, 0x08, 1, 2, 3, 4, 5, 6)
    const whole = new Uint8Array(jpeg.length + app1.length)
    whole.set(jpeg.subarray(0, 20), 0)
    whole.set(app1, 20)
    whole.set(jpeg.subarray(20), 20 + app1.length)
    assert.deepEqual(imageSize(whole), { width: 640, height: 480 })
  })

  it('reads a GIF logical screen size', () => {
    const gif = bytes(
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // GIF89a
      0x20, 0x03, 0x58, 0x02,             // 800 x 600 little-endian
      0, 0, 0, 0,
    )
    assert.deepEqual(imageSize(gif), { width: 800, height: 600 })
  })

  it('reads a lossless WebP (VP8L)', () => {
    const webp = bytes(
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, // RIFF....WEBP
      0x56, 0x50, 0x38, 0x4c, 0, 0, 0, 0, 0,                       // VP8L
      0x2f, 0x00, 0x00, 0x00,                                       // 14-bit w/h packed
    )
    const size = imageSize(webp)
    assert.ok(size && size.width > 0 && size.height > 0)
  })

  it('reads an extended WebP (VP8X) with 24-bit dimensions', () => {
    const webp = bytes(
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
      0x56, 0x50, 0x38, 0x58, 0, 0, 0, 0, 0, 0, 0, 0,
      0xff, 0x03, 0x00, // width-1 = 1023
      0xff, 0x01, 0x00, // height-1 = 511
    )
    assert.deepEqual(imageSize(webp), { width: 1024, height: 512 })
  })

  it('answers null for formats it does not parse', () => {
    assert.equal(imageSize(new Uint8Array(Buffer.from('%PDF-1.4'))), null)
    assert.equal(imageSize(bytes(1, 2, 3)), null)
    assert.equal(imageSize(null), null)
  })

  it('answers null for a truncated PNG', () => {
    const png = new Uint8Array(makePng(10, 10)).subarray(0, 12)
    assert.equal(imageSize(png), null)
  })

  it('answers null for a JPEG whose segment chain never reaches a SOF', () => {
    assert.equal(imageSize(bytes(0xff, 0xd8, 0xff, 0xd9, 0, 0, 0, 0, 0, 0, 0, 0)), null)
  })
})
