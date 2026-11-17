import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { config } from '../config.js'
import { backend } from '../storage/backend.js'
import { CpuTaskError, runCpuTask } from '../text/cpu-tasks.js'
import { previewSource } from './preview-source.js'

export const THUMBNAIL_LIMITS = Object.freeze({ maxSourceBytes: 64 * 1024 * 1024, maxPixels: 40000000,
  maxOutputBytes: 8 * 1024 * 1024, minWidth: 16, maxWidth: 1024 })

const pending = new Map()

/**
 * Caller authorizes the node before invoking this content-addressed cache.
 * No original bytes are returned: every successful result is a bounded WebP.
 */
export async function thumbnail(hash, width, { store = backend,
  cacheDir = join(config.tmpDir, 'thumbnails-v1') } = {}) {
  if (!/^[a-f0-9]{64}$/.test(hash) || !Number.isInteger(width)
      || width < THUMBNAIL_LIMITS.minWidth || width > THUMBNAIL_LIMITS.maxWidth) {
    throw new CpuTaskError('INVALID_INPUT', 'Invalid thumbnail content hash or width.', 400)
  }
  const cachePath = join(cacheDir, hash + '@' + width + '.webp')
  const info = await stat(cachePath).catch(() => null)
  if (info?.isFile() && info.size > 0 && info.size <= THUMBNAIL_LIMITS.maxOutputBytes) {
    const buffer = await readFile(cachePath).catch(() => null)
    if (buffer) return { buffer, mime: 'image/webp', cache: 'hit' }
  }
  if (pending.has(cachePath)) return pending.get(cachePath)
  const work = runCpuTask('thumbnail', async (signal) => ({
    ...(await previewSource(store, hash, THUMBNAIL_LIMITS.maxSourceBytes, signal)), width,
  })).then(async (result) => {
    const buffer = Buffer.from(result.buffer)
    // Atomic publish avoids serving half an encoded image to another process.
    const partial = cachePath + '.' + randomUUID() + '.part'
    try {
      await mkdir(cacheDir, { recursive: true })
      await writeFile(partial, buffer, { flag: 'wx' })
      await rename(partial, cachePath)
    } catch {
      // Derived cache failure cannot make a valid image preview fail.
    } finally {
      await unlink(partial).catch(() => {})
    }
    return { buffer, mime: 'image/webp', width: result.width, height: result.height, cache: 'miss' }
  }).finally(() => pending.delete(cachePath))
  pending.set(cachePath, work)
  return work
}
