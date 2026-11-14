#!/usr/bin/env node
/**
 * Tiny PNG writer for the browser checks.
 *
 * A hand-copied base64 blob is a silent trap: an invalid one does not fail the
 * request, it fails `createImageBitmap` and looks exactly like a bug in the
 * preview code. This builds a real PNG with the CRC and the zlib stream that a
 * decoder actually demands, at whatever size the check needs.
 */

import { deflateSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/**
 * An RGB PNG, one flat colour with a diagonal stripe so it is not a single
 * block of identical pixels (a decoder may shortcut those).
 */
export function makePng(width = 8, height = 8) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8   // bit depth
  header[9] = 2   // colour type: truecolour
  header[10] = 0  // deflate
  header[11] = 0  // adaptive filtering
  header[12] = 0  // no interlace

  const raw = Buffer.alloc((width * 3 + 1) * height)
  let at = 0
  for (let y = 0; y < height; y += 1) {
    raw[at] = 0 // filter: none
    at += 1
    for (let x = 0; x < width; x += 1) {
      const lit = (x + y) % 8 < 4
      raw[at] = lit ? 200 : 60
      raw[at + 1] = lit ? 90 : 60
      raw[at + 2] = lit ? 70 : 60
      at += 3
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
