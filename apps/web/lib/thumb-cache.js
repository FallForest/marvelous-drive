/*
 * thumb-cache.js — the bounded map behind list / grid thumbnails.
 *
 * An `<img src` to /api/v1/files/:id/thumbnail would be rejected: the route
 * needs the bearer header, so every thumbnail is fetched with `fetchBlob` and
 * published as an object URL. Object URLs pin their Blob until they are revoked,
 * and the list re-renders on every navigation, so the URLs live in one
 * module-level Map that survives re-renders and page changes.
 *
 * The map is capped (200 by default). Eviction is insertion-ordered — the
 * oldest entry goes first — and the evicted URLs are returned so the caller can
 * revoke them; nothing here touches `URL` or the DOM, which keeps the whole
 * policy unit-testable in Node.
 */

/** Formats the server answers with a thumbnail; anything else keeps its icon. */
export const THUMBNAIL_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** `image/png` → true. A missing mime falls back to the extension via the caller. */
export function canThumbnail(mime) {
  return THUMBNAIL_MIMES.has(String(mime || '').split(';')[0].trim().toLowerCase());
}

/**
 * rememberThumb(map, id, url, limit) → { url, evicted, reused }
 *
 * Stores `id → url`. When the id is already cached the existing URL wins
 * (`reused: true`) so a second render cannot leak a duplicate object URL — the
 * caller revokes the one it just created. Otherwise the oldest entries are
 * dropped until the map fits `limit`, and their URLs are returned in `evicted`.
 */
export function rememberThumb(map, id, url, limit) {
  const existing = map.get(id);
  if (existing) return { url: existing, evicted: [], reused: true };

  map.set(id, url);
  // A missing, zero or negative limit is a caller bug, not a request to cache
  // nothing: fall back to the default cap instead of evicting on every insert.
  const numeric = Number(limit);
  const cap = Number.isFinite(numeric) && numeric >= 1 ? Math.floor(numeric) : 200;
  const evicted = [];
  while (map.size > cap) {
    const oldest = map.keys().next().value;
    evicted.push(map.get(oldest));
    map.delete(oldest);
  }
  return { url, evicted, reused: false };
}

/** Drops every entry and hands the URLs back for revocation. */
export function clearThumbs(map) {
  const urls = Array.from(map.values());
  map.clear();
  return urls;
}
