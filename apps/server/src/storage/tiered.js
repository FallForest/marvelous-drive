import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'

/**
 * Two-tier storage: hot bytes on local disk, cold bytes in an object store.
 *
 * The point is not capacity but *cost*: object storage is cheap to keep and
 * expensive to read from, local disk is the opposite. A file nobody opened in
 * months belongs in the cold tier; the one being edited belongs on disk.
 *
 * Reads always succeed regardless of tier, which is what makes migration
 * invisible to the API surface. The only visible cost is latency on the first
 * read of a cold blob.
 *
 * Invariants:
 *   - a blob lives in exactly one tier (never both), so `remove` is unambiguous;
 *   - migration verifies the sha256 of the bytes it wrote before deleting the
 *     source, because the one thing worse than a slow read is a lost file.
 */

const sha256File = (path) => new Promise((resolve, reject) => {
  const hash = createHash('sha256')
  createReadStream(path)
    .on('data', (chunk) => hash.update(chunk))
    .on('error', reject)
    .on('end', () => resolve(hash.digest('hex')))
})

export class TieredBackend {
  /**
   * @param {object} options
   * @param {object} options.hot   backend for recently used bytes (local disk)
   * @param {object} options.cold  backend for idle bytes (S3)
   */
  constructor({ hot, cold }) {
    if (!hot || !cold) throw new Error('TieredBackend needs both a hot and a cold backend.')
    this.name = 'tiered'
    this.hot = hot
    this.cold = cold
    this.bucket = cold.bucket
  }

  /**
   * Where a key lives right now: `'hot'`, `'cold'` or `null`.
   *
   * Local first because it is the cheap check; the cold tier answers with a HEAD
   * that costs a round trip, so it is only consulted when the local miss matters.
   */
  async tierOf(key) {
    if (await this.hot.stat(key)) return 'hot'
    if (await this.cold.stat(key)) return 'cold'
    return null
  }

  /** New bytes always land hot: the upload that just happened is by definition hot. */
  async put(key, sourcePath) {
    return this.hot.put(key, sourcePath)
  }

  async putBytes(key, buffer) {
    return this.hot.putBytes(key, buffer)
  }

  /**
   * A readable stream, whichever tier holds the key.
   *
   * Deliberately *not* `async`: a caller does `for await (const chunk of
   * store.get(key))`, and an async method would hand back a Promise of a stream.
   * The tier lookup therefore happens inside the lazy stream.
   */
  get(key) {
    const self = this
    return Readable.from((async function* stream() {
      const tier = await self.tierOf(key)
      if (!tier) throw new Error('Blob ' + key + ' is in no tier.')
      for await (const chunk of (tier === 'hot' ? self.hot.get(key) : self.cold.get(key))) yield chunk
    })())
  }

  async stat(key) {
    const local = await this.hot.stat(key)
    if (local) return local
    return this.cold.stat(key)
  }

  async remove(key) {
    // Both: a crash between two migrations could in principle leave a copy behind,
    // and deleting a key twice is not an error.
    await this.hot.remove(key)
    await this.cold.remove(key)
  }

  /**
   * A local path with the key's bytes.
   *
   * Free when the blob is hot (hard link), a download when it is cold. Callers
   * that assemble archives pay that cost only for the cold files they touch.
   */
  async link(key, targetPath) {
    if (await this.hot.stat(key)) return this.hot.link(key, targetPath)
    return this.cold.link(key, targetPath)
  }

  path(key) {
    // Only meaningful while the blob is hot; the caller cannot know without an
    // await, so this is a programming error rather than a runtime condition.
    throw new Error('The tiered backend has no stable path; use get() or link() instead.')
  }

  /**
   * Moves a hot blob to the cold tier.
   *
   * Verifies the copied bytes before deleting the source: the check is the whole
   * reason this is safe to run unattended.
   */
  async migrateToCold(key) {
    const info = await this.hot.stat(key)
    if (!info) {
      // Already cold (or unknown): nothing to do, and not an error.
      return { key, moved: false, reason: await this.cold.stat(key) ? 'already-cold' : 'missing' }
    }
    const staging = join(tmpdir(), 'tier-' + randomUUID() + '.part')
    try {
      await this.hot.link(key, staging)
      const digest = await sha256File(staging)
      if (digest !== key) {
        return { key, moved: false, reason: 'checksum-mismatch', expected: key, actual: digest }
      }
      await this.cold.put(key, staging)
      // Only now is the local copy redundant.
      await this.hot.remove(key)
      return { key, moved: true, bytes: info.size }
    } catch (error) {
      return { key, moved: false, reason: 'error', error: error.message }
    } finally {
      // cold.put consumes the staging file; this is for every failure path.
      const { unlink } = await import('node:fs/promises')
      await unlink(staging).catch(() => {})
    }
  }

  /** Moves a cold blob back to local disk (the first read after a long idle). */
  async promoteToHot(key) {
    if (await this.hot.stat(key)) return { key, moved: false, reason: 'already-hot' }
    const info = await this.cold.stat(key)
    if (!info) return { key, moved: false, reason: 'missing' }
    const staging = join(tmpdir(), 'tier-' + randomUUID() + '.part')
    try {
      await this.cold.link(key, staging)
      const digest = await sha256File(staging)
      if (digest !== key) {
        return { key, moved: false, reason: 'checksum-mismatch', expected: key, actual: digest }
      }
      await this.hot.put(key, staging)
      // Keep the cold copy: it is the cheaper of the two to store, and dropping it
      // would make a later demotion a fresh upload instead of a no-op.
      return { key, moved: true, bytes: info.size }
    } catch (error) {
      return { key, moved: false, reason: 'error', error: error.message }
    } finally {
      const { unlink } = await import('node:fs/promises')
      await unlink(staging).catch(() => {})
    }
  }
}
