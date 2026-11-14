/*
 * image-fit.js — how big a picture to decode, and how to get there.
 *
 * The server cannot resize (its /thumbnail route hands back the original bytes
 * with an immutable cache header), so every "thumbnail" decision in this client
 * has to be made here, on the decoding side.
 *
 * Two costs matter and they are not the same:
 *
 *   transport  bytes over the wire — controlled by the HTTP cache, not by us;
 *   memory     the decoded RGBA bitmap — width × height × 4, and this is what
 *              actually kills a tab. Chromium hard-caps its decoded-image cache
 *              at 32 MB and re-decodes on a miss, so a folder of 24 MP photos
 *              thrashes unless the decoded size is bounded before it lands.
 *
 * `createImageBitmap(blob, { resizeWidth })` downsamples DURING decode, before
 * the full-size bitmap is ever materialised. That is the one lever available
 * without a server-side resizer.
 */

/**
 * Long edge of a preview, in CSS pixels.
 *
 * A drawer is at most `--drawer-w` (min(560px, 94vw)) wide, so 1600 is already
 * generous: it covers a 2.8x DPR tablet at full drawer width, and it is the same
 * "preview" tier Immich uses (1440) for the same reason.
 */
export const PREVIEW_LONG_EDGE = 1600;

/** Never decode a preview smaller than this, however small the box is. */
export const PREVIEW_MIN_EDGE = 320;

/**
 * The pixel budget for one decoded picture.
 *
 * Immich picks this from WebGL's MAX_TEXTURE_SIZE because it uploads pictures as
 * textures; there is no GL here, so the numbers are used only as a memory
 * ceiling. 16 MP x 4 bytes = 64 MB of RGBA, which is already the whole
 * 32 MB×2 budget Chromium keeps — so the tiers are deliberately conservative.
 */
export function pixelBudget(maxTextureSize) {
  const size = Number.isFinite(maxTextureSize) ? maxTextureSize : 0;
  if (size >= 16384) return 16 * 1024 * 1024;
  if (size >= 8192) return 10 * 1024 * 1024;
  return 4 * 1024 * 1024;
}

/**
 * The box a picture should be decoded into.
 *
 * Inputs are the source dimensions (0 when unknown, e.g. the header has not
 * been read), the box the drawer will paint it in, and the device pixel ratio.
 * The result never upscales: a 400px source stays 400px.
 *
 * Returns { width, height, scale } where scale is the factor actually applied.
 */
export function fitSize(sourceWidth, sourceHeight, boxWidth, boxHeight, options) {
  const opts = options || {};
  const dpr = Number.isFinite(opts.dpr) && opts.dpr > 0 ? opts.dpr : 1;
  const longEdgeCap = Number.isFinite(opts.longEdge) ? opts.longEdge : PREVIEW_LONG_EDGE;
  const minEdge = Number.isFinite(opts.minEdge) ? opts.minEdge : PREVIEW_MIN_EDGE;
  const budget = Number.isFinite(opts.pixelBudget) ? opts.pixelBudget : pixelBudget(opts.maxTextureSize);

  const sw = Number.isFinite(sourceWidth) && sourceWidth > 0 ? sourceWidth : 0;
  const sh = Number.isFinite(sourceHeight) && sourceHeight > 0 ? sourceHeight : 0;
  const bw = Number.isFinite(boxWidth) && boxWidth > 0 ? boxWidth : 0;
  const bh = Number.isFinite(boxHeight) && boxHeight > 0 ? boxHeight : 0;

  // No source size: ask for the box at DPR, which is the honest "as big as the
  // drawer can use" answer, and let the decoder clamp it to the real size.
  if (!sw || !sh) {
    const width = Math.max(minEdge, Math.round((bw || PREVIEW_LONG_EDGE) * dpr));
    const height = Math.max(minEdge, Math.round((bh || PREVIEW_LONG_EDGE) * dpr));
    return { width: Math.min(width, longEdgeCap), height: Math.min(height, longEdgeCap), scale: 1 };
  }

  // Contain-fit against the real box, when the box is known.
  //
  // Using "the box's longest side" instead would decode a landscape photograph
  // to the drawer's HEIGHT — 867px for a 559px-wide drawer, 55% more pixels than
  // can ever be displayed and 2.4x the memory. The aspect ratio is known here
  // (it comes from the source), so the honest answer is min() of the two ratios.
  let scale = 1;
  if (bw && bh) scale = Math.min(bw * dpr / sw, bh * dpr / sh);
  else scale = Math.min(bw * dpr / sw || 1, bh * dpr / sh || 1);

  // Then the house rules: never upscale, never exceed the long-edge cap, never
  // exceed the pixel budget. Each is a min(), so the smallest wins.
  scale = Math.min(scale, 1, longEdgeCap / Math.max(sw, sh));
  if (scale * Math.max(sw, sh) < minEdge) scale = Math.min(1, minEdge / Math.max(sw, sh));
  const area = sw * sh * scale * scale;
  if (area > budget) scale = Math.sqrt(budget / (sw * sh));

  const width = Math.max(1, Math.round(sw * scale));
  const height = Math.max(1, Math.round(sh * scale));
  return { width, height, scale };
}

/**
 * The one dimension to hand `createImageBitmap`.
 *
 * Only one of resizeWidth/resizeHeight may be passed, which preserves the
 * aspect ratio for free — that is the whole trick, because the source
 * dimensions are not known until something has been decoded.
 *
 * Returns `{ dimension: 'width' | 'height', size }`. Width is the default
 * because most photographs are landscape; a portrait picture that still comes
 * back too tall is re-decoded once with `dimension: 'height'`.
 */
export function capFor(boxWidth, boxHeight, options) {
  const opts = options || {};
  const dpr = Number.isFinite(opts.dpr) && opts.dpr > 0 ? opts.dpr : 1;
  const longEdgeCap = Number.isFinite(opts.longEdge) ? opts.longEdge : PREVIEW_LONG_EDGE;
  const minEdge = Number.isFinite(opts.minEdge) ? opts.minEdge : PREVIEW_MIN_EDGE;
  const bw = Number.isFinite(boxWidth) && boxWidth > 0 ? boxWidth : 0;
  const bh = Number.isFinite(boxHeight) && boxHeight > 0 ? boxHeight : 0;
  const wanted = Math.round(Math.max(bw, bh) * dpr);
  const size = Math.min(longEdgeCap, Math.max(minEdge, wanted || longEdgeCap));
  return { dimension: 'width', size };
}

/**
 * Does a width-capped decode still need a second pass?
 *
 * Two reasons: the picture came back taller than the cap (a portrait shot whose
 * width was clamped), or its area blew the pixel budget (a panorama, where
 * clamping the width leaves an enormous height).
 */
export function needsRecap(width, height, options) {
  const opts = options || {};
  const longEdgeCap = Number.isFinite(opts.longEdge) ? opts.longEdge : PREVIEW_LONG_EDGE;
  const budget = Number.isFinite(opts.pixelBudget) ? opts.pixelBudget : pixelBudget(opts.maxTextureSize);
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (!w || !h) return false;
  if (h > longEdgeCap) return true;
  return w * h > budget;
}

/** The exact decode box for a source we have already measured once. */
export function recapFor(width, height, options) {
  const opts = options || {};
  const longEdgeCap = Number.isFinite(opts.longEdge) ? opts.longEdge : PREVIEW_LONG_EDGE;
  const budget = Number.isFinite(opts.pixelBudget) ? opts.pixelBudget : pixelBudget(opts.maxTextureSize);
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (!w || !h) return capFor(0, 0, opts);
  // Clamp the longer edge (that is what "too tall / too wide" means), and take
  // the budget into it at the same time: capping the long edge to `s` leaves an
  // area of s² × ratio, so s = sqrt(budget / ratio) is the largest allowed.
  if (h > w) {
    const ratio = h / w;
    return { dimension: 'height', size: Math.max(1, Math.min(longEdgeCap, Math.floor(Math.sqrt(budget * ratio)))) };
  }
  const ratio = w / h;
  return { dimension: 'width', size: Math.max(1, Math.min(longEdgeCap, Math.floor(Math.sqrt(budget * ratio)))) };
}

/** True when the picture needs no downscale at all (it is already small). */
export function isSmallEnough(sourceWidth, sourceHeight, fit) {
  const sw = Number(sourceWidth) || 0;
  const sh = Number(sourceHeight) || 0;
  if (!sw || !sh || !fit) return true;
  return fit.width >= sw && fit.height >= sh;
}

/**
 * Decodes `blob` into a bitmap no larger than `fit`.
 *
 * Returns the ImageBitmap (caller owns it and must `close()` it) or null when
 * the platform cannot do it, in which case the caller falls back to an <img>
 * over the object URL. Every failure path is a fallback, never an exception:
 * a picture that cannot be re-encoded is still a picture.
 */
export async function decodePreview(blob, fit) {
  if (typeof createImageBitmap !== 'function' || !blob) return null;
  try {
    return await createImageBitmap(blob, {
      resizeWidth: fit.width,
      resizeHeight: fit.height,
      // 'high' costs a little more CPU and is visibly better on photographs;
      // Chrome's default is 'low' for resize during decode.
      resizeQuality: 'high',
    });
  } catch {
    try {
      return await createImageBitmap(blob);
    } catch {
      return null;
    }
  }
}
