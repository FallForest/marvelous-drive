/*
 * image-size.js — read a picture's dimensions from its header, before decoding.
 *
 * Two reasons this is worth 120 lines:
 *
 * 1. `createImageBitmap(blob, { resizeWidth })` UPSCALES a small picture to the
 *    requested width. A 300px screenshot in a 560px drawer would be blown up and
 *    then blurred by the browser — visibly worse than not touching it.
 * 2. Knowing the true size before the decode means the fit is computed once, so
 *    the correcting second decode in image-loader.js becomes the rare path
 *    instead of the normal one.
 *
 * Only the four formats the client previews are parsed. Everything else answers
 * null and the caller falls back to decode-then-recap.
 */

/** How many leading bytes are enough: JPEG's SOF sits after the EXIF block. */
export const HEADER_PROBE_BYTES = 256 * 1024;

const ascii = (bytes, start, length) => {
  let out = '';
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[start + i] || 0);
  return out;
};

const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u16le = (b, i) => b[i] | (b[i + 1] << 8);
const u24le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];

/**
 * Reads { width, height } from a picture header, or null.
 *
 * Uint8Array in, plain object out: no Blob, no DOM, so node --test drives it
 * with bytes it built itself.
 */
export function imageSize(bytes) {
  if (!bytes || bytes.length < 12) return null;
  const size = (width, height) => (width > 0 && height > 0 ? { width, height } : null);

  // PNG: 8-byte signature, then the IHDR chunk with width/height big-endian.
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    if (bytes.length < 24) return null;
    return size(u32be(bytes, 16), u32be(bytes, 20));
  }

  // GIF: "GIF87a" / "GIF89a", then the logical screen size little-endian.
  if (ascii(bytes, 0, 3) === 'GIF') {
    return size(u16le(bytes, 6), u16le(bytes, 8));
  }

  // WebP: RIFF....WEBP, then one of three bitstream headers.
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    const chunk = ascii(bytes, 12, 4);
    if (chunk === 'VP8X') return size(u24le(bytes, 24) + 1, u24le(bytes, 27) + 1);
    if (chunk === 'VP8 ') return size(u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff);
    if (chunk === 'VP8L') {
      // Lossless: 14 bits of width and 14 of height, packed after the signature.
      const b = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
      return size((b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1);
    }
    return null;
  }

  // JPEG: walk the segment chain to the first Start Of Frame.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) { at += 1; continue; }
      const marker = bytes[at + 1];
      // Fill bytes and standalone markers carry no length.
      if (marker === 0xff) { at += 1; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
      const length = u16be(bytes, at + 2);
      if (length < 2) return null;
      // SOF0-3, SOF5-7, SOF9-11, SOF13-15 all carry the dimensions.
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return size(u16be(bytes, at + 7), u16be(bytes, at + 5));
      at += 2 + length;
    }
    return null;
  }

  return null;
}
