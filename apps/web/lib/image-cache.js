/*
 * image-cache.js — the bounded byte-aware cache behind the picture drawer.
 *
 * The drawer cannot use `<img src="/api/v1/files/:id/content">`: that route needs
 * the bearer header, so every picture is fetched with `fetchBlob` and published
 * as an object URL. Object URLs pin their Blob for as long as they exist, and a
 * 24 MP photo is 30 MB of decoded bitmap plus 8 MB of bytes, so "cache
 * everything the user has seen" is how a photo folder kills a tab.
 *
 * The policy here:
 *
 *  - bounded by BYTES, not by count — ten screenshots and ten 40 MB raws are not
 *    the same problem;
 *  - LRU, because the useful entries are the ones near the current picture;
 *  - entries are byte-accounted by the blob's own size, and a decoded image can
 *    be 3-10x that, so the cap is deliberately conservative;
 *  - nothing touches URL or the DOM: eviction returns the URLs and the caller
 *    revokes them, which is what makes the whole thing testable in Node.
 */

/** ~64 MiB of encoded bytes: a handful of phone photos, or hundreds of shots. */
export const CACHE_BUDGET_BYTES = 64 * 1024 * 1024;

/** A single entry above this is never worth keeping: it would evict everything. */
export const ENTRY_BYTE_LIMIT = 24 * 1024 * 1024;

/** How many entries to keep even when they are tiny (a folder of icons). */
export const CACHE_ENTRY_CAP = 24;

/**
 * Creates a cache. `budgetBytes` and `maxEntries` are injectable so the tests can
 * drive eviction with kilobytes instead of megabytes.
 *
 * Values are opaque: the drawer stores an ImageBitmap and gives the entry a
 * `dispose` that calls `bitmap.close()`, because an evicted bitmap that is only
 * dropped would keep its GPU texture until the next GC. A caller that stores an
 * object URL instead passes a disposer that revokes it.
 *
 * API:
 *   get(id)                     → value | null (and marks it most-recently-used)
 *   peek(id)                    → value | null (no recency change)
 *   set(id, value, size, dispose) → { evicted: [value...], stored: boolean }
 *   has(id)                     → boolean
 *   delete(id)                  → value | null (already disposed)
 *   clear()                     → [value...] (already disposed)
 *   stats()                     → { entries, bytes, budgetBytes }
 */
export function createImageCache(options) {
  const opts = options || {};
  const budget = Number.isFinite(opts.budgetBytes) && opts.budgetBytes > 0 ? opts.budgetBytes : CACHE_BUDGET_BYTES;
  const maxEntries = Number.isFinite(opts.maxEntries) && opts.maxEntries >= 1 ? Math.floor(opts.maxEntries) : CACHE_ENTRY_CAP;
  const entryLimit = Number.isFinite(opts.entryLimit) && opts.entryLimit > 0 ? opts.entryLimit : ENTRY_BYTE_LIMIT;

  /** id → { url, size }. Insertion-ordered; a hit is re-inserted to refresh recency. */
  const entries = new Map();
  let bytes = 0;

  const account = () => {
    let total = 0;
    for (const entry of entries.values()) total += entry.size;
    bytes = total;
    return total;
  };

  const touch = (id, entry) => {
    entries.delete(id);
    entries.set(id, entry);
  };

  return {
    get(id) {
      const entry = entries.get(id);
      if (!entry) return null;
      touch(id, entry);
      return entry.url;
    },
    peek(id) {
      const entry = entries.get(id);
      return entry ? entry.url : null;
    },
    has(id) {
      return entries.has(id);
    },
    set(id, url, size, dispose) {
      if (!id || !url) return { evicted: [], stored: false };
      const bytesOf = Number.isFinite(size) && size >= 0 ? size : 0;
      // Re-setting an id replaces the old value; the caller disposes what comes back.
      const previous = entries.get(id);
      const evicted = [];
      if (previous) {
        entries.delete(id);
        account();
        if (previous.url !== url) evicted.push(previous.url);
        if (typeof previous.dispose === 'function' && previous.url !== url) previous.dispose();
      }
      // Bigger than the whole budget (or than one entry may be): do not hold it.
      if (bytesOf > entryLimit || bytesOf > budget) return { evicted, stored: false };

      entries.set(id, { url, size: bytesOf, dispose: typeof dispose === 'function' ? dispose : null });
      account();

      while (entries.size > maxEntries || bytes > budget) {
        const oldestId = entries.keys().next().value;
        if (oldestId === id) break; // never evict the entry we just stored
        const oldest = entries.get(oldestId);
        entries.delete(oldestId);
        evicted.push(oldest.url);
        if (typeof oldest.dispose === 'function') oldest.dispose();
        account();
      }
      return { evicted, stored: true };
    },
    delete(id) {
      const entry = entries.get(id);
      if (!entry) return null;
      entries.delete(id);
      account();
      if (typeof entry.dispose === 'function') entry.dispose();
      return entry.url;
    },
    clear() {
      const urls = [];
      for (const entry of entries.values()) {
        urls.push(entry.url);
        if (typeof entry.dispose === 'function') entry.dispose();
      }
      entries.clear();
      bytes = 0;
      return urls;
    },
    stats() {
      return { entries: entries.size, bytes, budgetBytes: budget };
    },
  };
}
