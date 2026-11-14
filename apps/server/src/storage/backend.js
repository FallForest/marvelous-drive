import { createReadStream } from 'node:fs'
import { copyFile, link, mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { config } from '../config.js'
import { S3Backend } from './s3.js'
import { TieredBackend } from './tiered.js'
import { ClusterBackend } from './cluster.js'

/**
 * Storage backend interface.
 *
 * Everything that touches blob bytes goes through one of these, so the store can
 * later be split across tiers (local hot, remote cold) without any route knowing
 * about it. The interface is deliberately tiny and byte-oriented: a backend never
 * sees a node, a user or a hash — only paths and streams.
 *
 *   put(key, sourcePath)      → adopt a finished file under `key`
 *   get(key)                  → readable stream
 *   stat(key)                 → { size } or null
 *   remove(key)               → delete, missing is not an error
 *   link(key)                 → a local path with the same bytes (hard link if
 *                               possible), for assembly and ZIP reads
 *
 * The local backend stores blobs as `<blobDir>/<key[0..2]>/<key>`, which is what
 * every existing call site already assumes.
 */
export class LocalBackend {
  constructor(rootDir = config.blobDir) {
    this.name = 'local'
    this.rootDir = rootDir
  }

  /** Absolute path for a key. Public because ZIP assembly and sendFile need it. */
  path(key) {
    return join(this.rootDir, key.slice(0, 2), key)
  }

  async put(key, sourcePath) {
    const target = this.path(key)
    await mkdir(dirname(target), { recursive: true })
    try {
      await rename(sourcePath, target)
    } catch {
      // A cross-device rename fails; copying is the correct fallback.
      await copyFile(sourcePath, target)
      await unlink(sourcePath).catch(() => {})
    }
    return target
  }

  async putBytes(key, buffer) {
    const target = this.path(key)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, buffer)
    return target
  }

  get(key) {
    return createReadStream(this.path(key))
  }

  async stat(key) {
    const info = await stat(this.path(key)).catch(() => null)
    return info && info.isFile() ? { size: info.size } : null
  }

  async remove(key) {
    await unlink(this.path(key)).catch(() => {})
  }

  /** A path whose bytes are `key`: a hard link when possible, else a copy. */
  async link(key, targetPath) {
    try {
      await link(this.path(key), targetPath)
    } catch {
      await copyFile(this.path(key), targetPath)
    }
    return targetPath
  }

  /** Copies a key's bytes to a destination stream without buffering. */
  async pump(key, destination) {
    await pipeline(this.get(key), destination)
  }
}

/**
 * The single backend instance the process uses.
 *
 * Selected once, from configuration. Every caller goes through this object, so
 * swapping the driver is a deployment change and not a code change — that is the
 * whole point of the seam.
 */
function selectBackend() {
  const driver = config.storage?.driver || 'local'
  if (driver === 'local') return new LocalBackend()
  if (driver === 's3') return new S3Backend({ settings: config.storage.s3 })
  if (driver === 'tiered') {
    // Cold first, so the same process can serve both tiers without a second deploy.
    const cold = { ...config.storage.s3, bucket: config.storage.s3.coldBucket, prefix: config.storage.s3.coldPrefix }
    return new TieredBackend({ hot: new LocalBackend(), cold: new S3Backend({ settings: cold }) })
  }
  if (driver === 'cluster') {
    // The rows live in SQLite, which the backend imports lazily for exactly this
    // reason: importing db.js at module load would open the database before the
    // storage driver is even known.
    return new ClusterBackend({
      dataDir: config.dataDir,
      writes: config.storage.cluster.writes,
      reserveBytes: config.storage.cluster.reserveBytes,
      timeoutMs: config.storage.cluster.timeoutMs,
    })
  }
  throw new Error('Unknown DRIVE_STORAGE driver "' + driver + '". Use "local", "s3", "tiered" or "cluster".')
}

export const backend = selectBackend()

/**
 * Reads a whole blob into memory.
 *
 * Only for paths that must parse the bytes anyway (text preview, office
 * extraction, indexing). Everything user-facing streams instead, so this never
 * sits in the path of a download.
 */
export async function readBlobBuffer(store, key) {
  const chunks = []
  for await (const chunk of store.get(key)) chunks.push(chunk)
  return Buffer.concat(chunks)
}

/** Adapter kept for the old `(hash) => path` call sites. */
export const blobPath = (hash) => backend.path(hash)