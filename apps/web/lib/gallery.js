/*
 * gallery.js — the picture-browser half of the preview drawer.
 *
 * A drawer that shows one image and then closes is a viewer without a "next".
 * This module owns the two decisions that are easy to get wrong and cheap to
 * state as pure functions:
 *
 *   1. WHICH files are in the gallery, and in what order;
 *   2. WHICH of them the page should have already fetched.
 *
 * Everything here is DOM-free and network-free on purpose: node --test drives it
 * with plain objects, and the browser code in preview.js only wires it to the
 * drawer. `MAX_SAFE_BYTES` and the prefetch window are policy, not measurements.
 */

import { fileKind } from './format.js';

/** The kinds the drawer can actually render as a picture. */
const GALLERY_KINDS = new Set(['image']);

/**
 * Formats whose whole point is the animation.
 *
 * A decoded ImageBitmap is a single frame, so sending a GIF, an APNG or an
 * animated WebP through the bitmap path draws frame one and silently discards
 * the timeline. These four are natively decoded by every engine this app
 * supports, so the drawer hands them straight to an <img> instead.
 */
const ANIMATED_MIMES = new Set(['image/gif', 'image/apng', 'image/webp', 'image/avif']);

/** True when the format may carry more than one frame. */
export function isAnimated(mime) {
  return ANIMATED_MIMES.has(String(mime || '').split(';')[0].trim().toLowerCase());
}

/**
 * How many neighbours to warm on each side.
 *
 * Two is the number a person reaches by pressing → twice before deciding to
 * wait; it is also the point where a folder of 40 MB photos stops being
 * aggressive. The window is recomputed from the *current* index on every move,
 * so holding the key never accumulates requests: only the two ahead stay warm.
 */
export const PREFETCH_RADIUS = 2;

/**
 * Do not spend bandwidth on a neighbour this large during a skim.
 *
 * The visible image is always fetched at full size (that is what the user
 * asked for); a *neighbour* above this ceiling is only prefetched when it is
 * the immediate next/previous one, never two steps out. 12 MiB is roughly a
 * 24 MP JPEG straight out of a phone at maximum quality.
 */
export const NEIGHBOUR_BYTE_LIMIT = 12 * 1024 * 1024;

/** True when the drawer can show this node as a picture. */
export function isGalleryImage(node) {
  if (!node || node.kind === 'folder') return false;
  return GALLERY_KINDS.has(fileKind(node.mime, node.name));
}

/**
 * The gallery for one folder view.
 *
 * Order is the order the list already shows, so "next" means the row below the
 * one the user clicked, not an invisible alphabetical re-sort. Non-images and
 * folders are dropped: pressing → must never land on a .txt or a folder.
 */
export function galleryFor(nodes) {
  const list = [];
  const seen = new Set();
  for (const node of nodes || []) {
    if (!isGalleryImage(node)) continue;
    if (!node.id || seen.has(node.id)) continue;
    seen.add(node.id);
    list.push(node);
  }
  return list;
}

/** Position of `id` in the gallery, or -1. */
export function indexOfId(gallery, id) {
  if (!id) return -1;
  for (let index = 0; index < gallery.length; index += 1) {
    if (gallery[index].id === id) return index;
  }
  return -1;
}

/**
 * Where a move lands.
 *
 * - `wrap` (default false) is off, like the Windows photo viewer: at the last
 *   picture → does nothing rather than jumping back to the first, because on a
 *   slow connection a wrap looks like a random reload.
 * - A gallery with one entry stays where it is.
 * - A delta larger than the gallery still clamps.
 */
export function stepIndex(index, delta, length, options) {
  const opts = options || {};
  const size = Number(length);
  if (!Number.isFinite(size) || size <= 0) return -1;
  const current = Number.isFinite(index) && index >= 0 ? index : 0;
  const move = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  const next = current + move;
  if (opts.wrap) return ((next % size) + size) % size;
  if (next < 0) return 0;
  if (next > size - 1) return size - 1;
  return next;
}

/**
 * The neighbours worth warming.
 *
 * Returns `[{ node, distance }]` nearest-first, skipping the current picture,
 * the ends of the gallery, and anything too large to spend bandwidth on at that
 * distance. `budgetBytes` caps the whole batch, so a folder of 10 MB photos
 * warms two of them and a folder of 300 KB screenshots warms four.
 */
export function prefetchWindow(gallery, index, options) {
  const opts = options || {};
  const radius = Number.isFinite(opts.radius) ? Math.max(0, Math.trunc(opts.radius)) : PREFETCH_RADIUS;
  const limit = Number.isFinite(opts.limit) ? opts.limit : NEIGHBOUR_BYTE_LIMIT;
  const budget = Number.isFinite(opts.budgetBytes) ? opts.budgetBytes : Infinity;
  if (!Array.isArray(gallery) || !gallery.length || radius === 0) return [];

  const out = [];
  let spent = 0;
  // Distance first, then direction: the picture one step ahead matters more
  // than the one two steps behind, because → is the key people press.
  for (let distance = 1; distance <= radius; distance += 1) {
    for (const direction of [1, -1]) {
      const target = index + direction * distance;
      if (target < 0 || target >= gallery.length) continue;
      const node = gallery[target];
      if (!node) continue;
      const size = Number(node.size);
      // Only the immediate neighbour is worth a big download; two steps out is
      // speculation and should stay cheap.
      const ceiling = distance === 1 ? limit : Math.min(limit, 2 * 1024 * 1024);
      if (Number.isFinite(size) && size > ceiling) continue;
      if (spent + (Number.isFinite(size) ? size : 0) > budget) continue;
      spent += Number.isFinite(size) ? size : 0;
      out.push({ node, distance });
    }
  }
  out.sort((a, b) => a.distance - b.distance);
  return out;
}

/** "3 / 12" — the counter both the header and the live region read. */
export function positionLabel(index, length) {
  if (!Number.isFinite(length) || length <= 0) return '';
  const at = Number.isFinite(index) && index >= 0 ? index + 1 : 0;
  return at + ' / ' + length;
}

/** Arrow keys that mean "previous / next" when the drawer is not typing. */
export function arrowDelta(key) {
  if (key === 'ArrowRight' || key === 'PageDown') return 1;
  if (key === 'ArrowLeft' || key === 'PageUp') return -1;
  return 0;
}

/**
 * The jump Home / End asks for, as a delta from `index`.
 *
 * Returned as a delta rather than an absolute index so the caller keeps one
 * code path: every move in the drawer goes through step().
 */
export function jumpDelta(key, index, length) {
  if (!Number.isFinite(length) || length <= 0) return 0;
  const current = Number.isFinite(index) && index >= 0 ? index : 0;
  // `|| 0` collapses the -0 that negating zero produces: -0 is a different
  // value to assert on and would make a "no move" delta look like a move.
  if (key === 'Home') return -(current) || 0;
  if (key === 'End') return length - 1 - current;
  return 0;
}

/**
 * Which way a move points, for cancelling the prefetches it made pointless.
 *
 * On a slow connection, arrowing → twice while two 20 MB pictures are being
 * warmed means four downloads for one picture the user is looking at. The
 * direction that was left behind is pure waste, so its requests are aborted.
 * 0 means "no opinion" (a jump, a close): everything may be cancelled.
 */
export function cancelDirection(delta) {
  if (delta > 0) return 'behind';
  if (delta < 0) return 'ahead';
  return 'all';
}
