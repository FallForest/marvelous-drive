import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { userFromRequest } from '../auth.js'
import { config } from '../config.js'
import { backend, readBlobBuffer } from '../storage/backend.js'
import { sendJson, sendRaw } from '../http.js'
import { requireFile } from '../nodes.js'
import {
  MAX_SOURCE_BYTES, NormalizeError, isNormalizable, previewSize,
} from '../text/image-normalize.js'
import { encodePng, downscaleRgba } from '../text/image-normalize.js'
import { heifAvailable, loadHeif } from '../text/heif-loader.js'

/**
 * Preview images for formats no browser decodes.
 *
 *   GET /api/v1/files/:id/preview-image?w=1600
 *     -> image/png, cacheable for a week
 *
 * The route exists because HEIC is the default on every iPhone and no Chromium
 * build decodes it: without this, a folder of phone photos is a wall of "cannot
 * preview" cards. It decodes with libheif (WASM, loaded lazily — see
 * ./heif-loader.js) and re-encodes a downscaled PNG, so the response is one a
 * browser already knows how to display and small enough to send.
 *
 * Errors:
 *   400 NOT_NORMALIZABLE   the extension is not one this route handles
 *   413 FILE_TOO_LARGE      the source blob is over MAX_SOURCE_BYTES
 *   422 PREVIEW_UNAVAILABLE the bytes are not a HEIC after all, or decoding failed
 *   503 DECODER_UNAVAILABLE libheif is not installed in this deployment
 */

/** Decodes in flight, keyed by cache path; cleared as soon as it settles. */
const inFlight = new Map()

function decodeOnce(key, work) {
  const running = inFlight.get(key)
  if (running) return running
  const promise = work().finally(() => inFlight.delete(key))
  inFlight.set(key, promise)
  return promise
}

/** The one response shape this route has. */
function sendPng(ctx, png, row, cacheState) {
  sendRaw(ctx.res, 200, png, {
    'content-type': 'image/png',
    // Same contract as the thumbnail route: the bytes for one blob never
    // change, and they are behind a bearer token, so private + immutable.
    'cache-control': 'private, max-age=604800, immutable',
    vary: 'Authorization',
    'x-preview-source': row.mime || 'unknown',
    'x-preview-cache': cacheState,
  })
}

/** Clamp the requested width the same way the thumbnail route does. */
function previewWidth(raw) {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return 1600
  return Math.min(2560, Math.max(64, Math.round(value)))
}

export function registerPreviewImageRoutes(router) {
  router.get('/api/v1/files/:id/preview-image', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const row = requireFile(user.id, ctx.params.id)
    if (!row.blob_hash) ctx.fail(404, 'NOT_FOUND', 'This file has no content yet.')
    if (!isNormalizable(row.name)) {
      ctx.fail(400, 'NOT_NORMALIZABLE', 'This route decodes .heic and .heif only.')
    }

    const info = await backend.stat(row.blob_hash)
    if (!info) ctx.fail(404, 'NOT_FOUND', 'The stored content is missing.')
    if (info.size > MAX_SOURCE_BYTES) {
      ctx.fail(413, 'FILE_TOO_LARGE', 'Preview decoding is limited to ' + MAX_SOURCE_BYTES + ' bytes.')
    }

    const width = previewWidth(ctx.url.searchParams.get('w'))
    // Blobs are content-addressed, so the hash IS the cache key: the same
    // photo decoded once serves every node that points at it, and a file
    // overwritten with new bytes has a different hash and cannot serve stale
    // pixels. The width is part of the key because the output size changes.
    const cachePath = join(config.tmpDir, 'preview-image', row.blob_hash + '@' + width + '.png')
    const cached = await readFile(cachePath).catch(() => null)
    if (cached && cached.length) {
      sendPng(ctx, cached, row, 'hit')
      return
    }

    let libheif
    try {
      libheif = await loadHeif()
    } catch {
      ctx.fail(503, 'DECODER_UNAVAILABLE', 'This deployment has no HEIC decoder installed.')
    }

    // One decode per key, even when a folder is opened and ten requests for the
    // same image arrive together: a 12 MP decode is ~300ms of CPU and a burst
    // of them would push every other request out of the way.
    let png
    try {
      png = await decodeOnce(cachePath, async () => {
        const buffer = await readBlobBuffer(backend, row.blob_hash)
        return decodeToPng(buffer, width, libheif)
      })
    } catch (error) {
      if (error instanceof NormalizeError) ctx.fail(422, 'PREVIEW_UNAVAILABLE', error.message)
      throw error
    }

    // Best effort: a read-only or full tmp directory must not fail a preview.
    await mkdir(dirname(cachePath), { recursive: true })
      .then(() => writeFile(cachePath, png))
      .catch(() => {})

    sendPng(ctx, png, row, 'miss')
  })

  /** Lets the client ask before it tries, and lets ops see the state. */
  router.get('/api/v1/preview/formats', async (ctx) => {
    userFromRequest(ctx.req, ctx.url)
    sendJson(ctx.res, 200, {
      formats: {
        heic: { decodable: await heifAvailable(), route: '/api/v1/files/:id/preview-image' },
      },
    })
  })
}

/** How long one frame may take before the request is abandoned. */
const DECODE_TIMEOUT_MS = 20000

/**
 * Pixel ceiling for one decode.
 *
 * MAX_SOURCE_BYTES bounds the input, not the output: HEIC compresses ~10:1, so
 * a 9 MB file can declare 100 MP and ask for 400 MB of RGBA. 50 MP is past any
 * phone camera and still under the memory a single preview may use.
 */
const MAX_PIXELS = 50 * 1000 * 1000

/**
 * Decodes one HEIC frame and returns a downscaled PNG.
 *
 * `image.display()` is ASYNCHRONOUS in libheif-js: it schedules the render and
 * calls back later, so the callback is the only place the pixels exist. Reading
 * a variable set by the callback on the next line — which is what the first
 * version of this did — always finds it empty, and the drawer reported "the
 * HEIC frame came back empty" for a file that decodes perfectly.
 *
 * Returns a Promise; the caller awaits it.
 */
export async function decodeToPng(buffer, longEdge, libheif) {
  let images
  try {
    images = new libheif.HeifDecoder().decode(buffer)
  } catch (error) {
    throw new NormalizeError('DECODE_FAILED', 'The image could not be decoded: ' + (error && error.message ? error.message : 'unknown error'))
  }
  if (!images || !images.length) {
    throw new NormalizeError('NOT_HEIC', 'The file does not contain a decodable HEIC frame.')
  }
  const image = images[0]
  const width = image.get_width()
  const height = image.get_height()
  if (!width || !height) throw new NormalizeError('DECODE_FAILED', 'The HEIC frame reports no size.')
  // A compressed HEIC can declare an enormous canvas without carrying the
  // pixels. Refuse before allocating width×height×4.
  if (width * height > MAX_PIXELS) {
    throw new NormalizeError('IMAGE_TOO_LARGE', 'The HEIC frame is ' + width + 'x' + height + ', above the preview limit.')
  }

  return new Promise((resolve, reject) => {
    const frame = new Uint8ClampedArray(width * height * 4)
    let settled = false
    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) { reject(error); return }
      if (!result || !result.data) {
        reject(new NormalizeError('DECODE_FAILED', 'The HEIC frame came back empty.'))
        return
      }
      try {
        const target = previewSize(width, height, longEdge)
        const pixels = downscaleRgba(result.data, width, height, target.width, target.height)
        resolve(encodePng(pixels, target.width, target.height))
      } catch (failure) {
        reject(new NormalizeError('DECODE_FAILED', 'The preview could not be encoded.'))
      }
    }
    // A malformed frame can hang the decoder; a preview is never worth holding
    // a request open forever.
    const timer = setTimeout(() => finish(new NormalizeError('DECODE_TIMEOUT', 'The HEIC frame took too long to decode.')), DECODE_TIMEOUT_MS)
    if (timer && typeof timer.unref === 'function') timer.unref()
    try {
      image.display({ data: frame, width, height }, (result) => finish(null, result))
    } catch {
      finish(new NormalizeError('DECODE_FAILED', 'The HEIC frame could not be rendered.'))
    }
  })
}
