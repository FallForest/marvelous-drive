/*
 * heif-loader.js — the ONE place that imports libheif.
 *
 * libheif compiled to WASM is ~960 KB (877 KB of .wasm + 82 KB of glue). That
 * cost is only paid by a request that actually needs to decode a HEIC, which is
 * why this file exists on its own: everything else in the server can import
 * ./image-normalize.js without pulling a WebAssembly module into memory, and a
 * deployment that never receives a HEIC never loads it at all.
 *
 * Licence: libheif is LGPL-3.0. It is used here as an unmodified library across
 * a dynamic-import boundary — the same "use, do not link" position that lets a
 * proprietary program call an LGPL library — and the notice travels with it in
 * apps/server/THIRD-PARTY.md. Do not copy libheif code into this repository,
 * and do not statically import this module from anywhere that runs on boot.
 */

import { createRequire } from 'node:module'

/** Cached across requests: WASM instantiation is tens of milliseconds, once. */
let pending = null

/**
 * The decoder module, instantiated on first use.
 *
 * `libheif-js` ships two builds: a single 1.25 MB bundle (wasm inlined) and the
 * split glue + .wasm pair. The split build is used here because a CDN-less
 * deployment gets a smaller file, and the require of the glue is what makes the
 * loader pick the .wasm next to it.
 */
export async function loadHeif() {
  if (pending) return pending
  pending = (async () => {
    const require = createRequire(import.meta.url)
    // Resolved lazily: a checkout without the optional dependency still boots
    // and simply reports "HEIC preview unavailable" on demand.
    const init = require('libheif-js/libheif-wasm/libheif.js')
    const libheif = typeof init === 'function' ? await init() : init
    if (!libheif || typeof libheif.HeifDecoder !== 'function') {
      throw new Error('libheif did not expose HeifDecoder')
    }
    return libheif
  })().catch((error) => {
    // A failed load must not be cached forever: a missing dependency that is
    // installed later should work without a restart.
    pending = null
    throw error
  })
  return pending
}

/** True when libheif can be resolved. Never throws; used for the health report. */
export async function heifAvailable() {
  try {
    await loadHeif()
    return true
  } catch {
    return false
  }
}
