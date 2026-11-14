/*
 * image-normalize.js — formats a browser cannot decode, turned into one it can.
 *
 * The whole point of this module is HEIC. An iPhone stores photos as HEIC, no
 * Chromium build decodes HEVC stills, and a drive that shows a grey "cannot
 * preview" card for every photo a phone produced is not doing its job.
 *
 * Three constraints shape everything below:
 *
 * 1. THE DECODER IS BIG. libheif compiled to WebAssembly is ~877 KB of .wasm
 *    plus a ~82 KB glue script. Shipping that to every visitor would be trading
 *    the app's first paint for a format most folders never contain, so it is
 *    loaded lazily — only a request for a HEIC ever touches it (see
 *    ./heif-loader.js, which is the only file that imports the wasm).
 *
 * 2. THE DECODER IS LGPL-3.0. libheif itself is LGPL; this project is not. The
 *    licence is satisfied by using it as an unmodified library across a clear
 *    process/library boundary — which is exactly what a WASM module behind a
 *    dynamic import is — and by keeping the notice and the source link next to
 *    it. Nothing here links libheif into the application's own code.
 *
 * 3. THE OUTPUT MUST BE SMALL. A decoded HEIC frame is 4 bytes per pixel; a
 *    12 MP photo is 48 MB of RGBA before it is re-encoded. So the frame is
 *    downsampled on the way out to the size the drawer asked for, and encoded
 *    as PNG (node:zlib, no dependency) — a 1600px preview lands around 1-2 MB,
 *    which is the same order as the JPEG it replaces.
 */

import { deflateSync } from 'node:zlib'

/** The extensions this module can turn into a browser-decodable image. */
export const NORMALIZABLE = new Set(['heic', 'heif'])

/** Above this a decode would cost more memory than a preview is worth. */
export const MAX_SOURCE_BYTES = 96 * 1024 * 1024

/** The long edge of the preview we produce. Matches lib/image-fit.js. */
export const PREVIEW_LONG_EDGE = 1600

export class NormalizeError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'NormalizeError'
    this.code = code
  }
}

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
 * Encodes RGBA pixels as a PNG.
 *
 * PNG rather than JPEG because the encoder is `node:zlib` — no dependency, no
 * second licence, ~40 lines. JPEG would be a third of the size; it would also
 * be a whole extra library for a preview that is already downsampled. The bytes
 * are cached next to the blob, so the cost is paid once.
 */
export function encodePng(rgba, width, height) {
  const stride = width * 4
  // Filter 0 (none) on every scanline: cheap, and colour-type 6 already gets
  // most of the compression back from deflate on photographic data.
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    Buffer.from(rgba.buffer ? rgba.buffer : rgba, rgba.byteOffset || 0, rgba.length)
      .copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8   // bit depth
  header[9] = 6   // colour type: RGBA
  header[10] = 0  // deflate
  header[11] = 0  // adaptive filtering
  header[12] = 0  // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Box-filters RGBA down to `targetWidth` × `targetHeight`.
 *
 * A naive nearest-neighbour resize of a 12 MP photo shimmers badly; averaging
 * the source box behind each destination pixel is one pass, no allocation
 * beyond the output, and it is what makes a downsampled preview look like the
 * photograph rather than like a sharpened thumbnail.
 */
export function downscaleRgba(source, sourceWidth, sourceHeight, targetWidth, targetHeight) {
  if (targetWidth === sourceWidth && targetHeight === sourceHeight) {
    return source instanceof Uint8ClampedArray ? source : new Uint8ClampedArray(source)
  }
  const out = new Uint8ClampedArray(targetWidth * targetHeight * 4)
  const xRatio = sourceWidth / targetWidth
  const yRatio = sourceHeight / targetHeight

  for (let y = 0; y < targetHeight; y += 1) {
    const y0 = Math.floor(y * yRatio)
    const y1 = Math.min(sourceHeight, Math.max(y0 + 1, Math.floor((y + 1) * yRatio)))
    for (let x = 0; x < targetWidth; x += 1) {
      const x0 = Math.floor(x * xRatio)
      const x1 = Math.min(sourceWidth, Math.max(x0 + 1, Math.floor((x + 1) * xRatio)))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let count = 0
      for (let sy = y0; sy < y1; sy += 1) {
        let at = (sy * sourceWidth + x0) * 4
        for (let sx = x0; sx < x1; sx += 1) {
          r += source[at]
          g += source[at + 1]
          b += source[at + 2]
          a += source[at + 3]
          at += 4
          count += 1
        }
      }
      const at = (y * targetWidth + x) * 4
      out[at] = r / count
      out[at + 1] = g / count
      out[at + 2] = b / count
      out[at + 3] = a / count
    }
  }
  return out
}

/** The preview box for a source of `width` × `height`, never upscaling. */
export function previewSize(width, height, longEdge) {
  const cap = Number.isFinite(longEdge) && longEdge > 0 ? longEdge : PREVIEW_LONG_EDGE;
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (!w || !h) return { width: 1, height: 1 };
  const scale = Math.min(1, cap / Math.max(w, h));
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

/** True when the file name says this module can normalise it. */
export function isNormalizable(name) {
  const clean = String(name || '');
  const index = clean.lastIndexOf('.');
  if (index <= 0) return false;
  return NORMALIZABLE.has(clean.slice(index + 1).toLowerCase());
}
