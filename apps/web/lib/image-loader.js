/*
 * image-loader.js — one picture, decoded to a bounded bitmap.
 *
 * Three decisions live here, and each one is a cost decision:
 *
 * 1. WHICH ROUTE. `/files/:id/content` answers `cache-control: private,
 *    max-age=0, must-revalidate`, so the browser re-answers every byte on every
 *    visit. `/files/:id/thumbnail` carries `max-age=604800, immutable` and the
 *    same bytes behind it. Using the thumbnail route therefore costs the same
 *    on first view and nothing at all on the second — the only traffic lever
 *    this server offers, because it does not resize.
 *
 * 2. HOW BIG TO DECODE. `createImageBitmap` takes resizeWidth/resizeHeight and
 *    downsamples during decode; the full-size bitmap is never materialised. A
 *    24 MP photo would otherwise be 96 MB of RGBA against a 32 MB decoded-image
 *    budget in Chromium, which is exactly the thrash that makes a photo folder
 *    feel broken.
 *
 * 3. WHEN TO GIVE UP ON IT. A decoder failure is not an error to show the user:
 *    the caller falls back to an <img> over the object URL, and a picture that
 *    only decodes the slow way is still a picture.
 */

import { contentUrl, fetchBlob } from './api.js';
import { thumbnailUrl } from './files.js';
import { THUMBNAIL_MIMES } from './thumb-cache.js';
import { fitSize, needsRecap, recapFor } from './image-fit.js';
import { HEADER_PROBE_BYTES, imageSize } from './image-size.js';

/**
 * The URL that answers with an immutable cache header when it can.
 *
 * Only the three formats the route accepts are sent there; a GIF, AVIF or SVG
 * would get a 415, so those keep the plain content URL and pay the revalidation
 * (they are also the formats a browser cannot cheaply re-encode).
 */
export function imageRequestUrl(node, options) {
  if (!node || !node.id) return null;
  const opts = options || {};
  const mime = String(node.mime || '').split(';')[0].trim().toLowerCase();
  if (THUMBNAIL_MIMES.has(mime)) return thumbnailUrl(node.id, opts.width || 1024);
  return contentUrl(node.id);
}

/**
 * Fetches and decodes `node` into a bitmap no larger than the drawer needs.
 *
 * Resolves to `{ bitmap, blob, cached }`:
 *   bitmap  an ImageBitmap the caller must `close()`, or null when the platform
 *           (or the format) forces the <img> fallback;
 *   blob    the encoded bytes, so the fallback can make an object URL;
 *   cached  true when the browser answered from HTTP cache without a body —
 *           only useful for logging today, but it is the number that proves the
 *           route choice was worth making.
 */
export async function loadPicture(node, options) {
  const opts = options || {};
  const url = imageRequestUrl(node, opts);
  if (!url) throw new Error('没有可用的图片地址。');

  const blob = await fetchBlob(url, { signal: opts.signal });
  if (opts.signal && opts.signal.aborted) throw new DOMException('aborted', 'AbortError');

  // Read the true size from the header first. Without it, createImageBitmap
  // would happily scale a 300px screenshot UP to the drawer width, which is
  // both uglier and more memory than the original.
  const source = await readSize(blob);
  const fit = fitSize(source?.width || 0, source?.height || 0, opts.boxWidth, opts.boxHeight, opts);
  // Already small enough: decode as-is so the browser keeps every pixel.
  const first = source && fit.width >= source.width && fit.height >= source.height
    ? { dimension: 'width', size: source.width }
    : { dimension: fit.width >= fit.height ? 'width' : 'height', size: Math.max(fit.width, fit.height) };

  let bitmap = await decodeCapped(blob, first);
  if (!bitmap) return { bitmap: null, blob, cached: false };

  // A width-capped portrait comes back too tall; a panorama comes back with an
  // enormous area. One corrective decode is cheap (the blob is in memory) and
  // is the difference between "sharp" and "inside the memory budget".
  if (needsRecap(bitmap.width, bitmap.height, opts)) {
    const second = recapFor(bitmap.width, bitmap.height, opts);
    const again = await decodeCapped(blob, second);
    if (again) {
      if (typeof bitmap.close === 'function') bitmap.close();
      bitmap = again;
    }
  }

  return { bitmap, blob, cached: false };
}

/** The picture's real dimensions, read from its header; null when unknown. */
async function readSize(blob) {
  if (!blob || typeof blob.slice !== 'function') return null;
  try {
    const head = await blob.slice(0, Math.min(HEADER_PROBE_BYTES, blob.size)).arrayBuffer();
    return imageSize(new Uint8Array(head));
  } catch {
    return null;
  }
}

/** createImageBitmap with one resize axis; null when the platform refuses. */
async function decodeCapped(blob, cap) {
  if (typeof createImageBitmap !== 'function' || !blob) return null;
  const request = cap && cap.dimension === 'height'
    ? { resizeHeight: cap.size, resizeQuality: 'high' }
    : { resizeWidth: cap && cap.size ? cap.size : undefined, resizeQuality: 'high' };
  try {
    return await createImageBitmap(blob, request);
  } catch {
    try {
      return await createImageBitmap(blob);
    } catch {
      return null;
    }
  }
}
