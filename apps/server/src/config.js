import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Process configuration, resolved once at startup.
 *
 * Every environment variable the server reads lives here so a deployment can
 * be audited from one file instead of by grepping process.env.
 */

const here = fileURLToPath(new URL('.', import.meta.url))
export const repoRoot = resolve(here, '../../..')

const dataDir = process.env.DRIVE_DATA_DIR ? resolve(process.env.DRIVE_DATA_DIR) : join(repoRoot, 'data')
// quarantine holds blobs that failed verification: kept as evidence, never served.
for (const dir of [dataDir, join(dataDir, 'blobs'), join(dataDir, 'tmp'), join(dataDir, 'quarantine')]) {
  mkdirSync(dir, { recursive: true })
}

export const config = {
  environment: process.env.NODE_ENV || 'development',
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 4400),
  dataDir,
  dbPath: join(dataDir, 'drive.db'),
  blobDir: join(dataDir, 'blobs'),
  tmpDir: join(dataDir, 'tmp'),
  webDir: join(repoRoot, 'apps', 'web'),
  maxUploadBytes: Number(process.env.DRIVE_MAX_UPLOAD_BYTES || 2 * 1024 * 1024 * 1024),
  tokenTtlSeconds: Number(process.env.DRIVE_TOKEN_TTL || 12 * 60 * 60),
  jwtSecretPath: join(dataDir, '.jwt-secret'),
  /** Trashed nodes older than this are purged on boot and on demand. */
  trashRetentionDays: Number(process.env.DRIVE_TRASH_RETENTION_DAYS || 30),
  /** Per-account byte ceiling; 0 means unlimited. */
  quotaBytes: Number(process.env.DRIVE_QUOTA_BYTES || 0),
  /**
   * Self-update. All three are optional; with none of them set the API simply
   * reports "updates are not configured" and the account menu hides the entry.
   *
   * - `manifestUrl`  the release manifest published with each GitHub release;
   * - `agentUrl`     the update agent that pulls images and restarts compose;
   * - `agentToken`   the shared secret between this process and that agent.
   */
  update: {
    manifestUrl: (process.env.DRIVE_UPDATE_MANIFEST_URL || '').trim(),
    // Only needed when the manifest lives in a private repository; a public
    // release asset needs nothing. The agent already sends this, but the API
    // fetches the same URL for its own check: without it here that check
    // answers 404 and the panel reports "no update" forever while the agent
    // would have succeeded.
    manifestToken: (process.env.DRIVE_UPDATE_MANIFEST_TOKEN || '').trim(),
    agentUrl: (process.env.DRIVE_UPDATE_AGENT_URL || '').trim().replace(/\/+$/, ''),
    agentToken: (process.env.DRIVE_UPDATE_AGENT_TOKEN || '').trim(),
  },
  /**
   * Where blob bytes live.
   *
   * `local` (default) keeps them in `data/blobs`. `s3` talks to any S3-compatible
   * endpoint (AWS, MinIO, R2, B2) — see docs/STORAGE.md for what changes.
   */
  storage: {
    // `local`, `s3`, `tiered` (hot local disk + cold object store), or `cluster`
    // (one drive over several machines' disks).
    driver: (process.env.DRIVE_STORAGE || 'local').toLowerCase(),
    /** Days idle before a blob is demoted to the cold tier. */
    coldAfterDays: Number(process.env.DRIVE_COLD_AFTER_DAYS || 90),
    cluster: {
      /**
       * Replicas that must acknowledge a write before the upload is accepted.
       *
       * 1 means "one machine has it"; the drive is then as durable as that
       * machine. 2 means an upload only succeeds once two machines hold the
       * bytes, which is the setting that survives losing a box.
       */
      writes: Math.max(1, Number(process.env.DRIVE_CLUSTER_WRITES || 1)),
      /** Headroom kept free on every node so a full disk is skipped, not failed. */
      reserveBytes: Number(process.env.DRIVE_CLUSTER_RESERVE_BYTES || 512 * 1024 * 1024),
      /** Per-request timeout to a node, in milliseconds. */
      timeoutMs: Number(process.env.DRIVE_CLUSTER_TIMEOUT_MS || 120000),
    },
    s3: {
      endpoint: process.env.DRIVE_S3_ENDPOINT || '',
      bucket: process.env.DRIVE_S3_BUCKET || '',
      region: process.env.DRIVE_S3_REGION || 'us-east-1',
      accessKeyId: process.env.DRIVE_S3_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.DRIVE_S3_SECRET_ACCESS_KEY || '',
      sessionToken: process.env.DRIVE_S3_SESSION_TOKEN || '',
      prefix: process.env.DRIVE_S3_PREFIX || '',
      // Cold tier for the tiered driver: the same bucket, or a cheaper one.
      coldBucket: process.env.DRIVE_S3_COLD_BUCKET || process.env.DRIVE_S3_BUCKET || '',
      coldPrefix: process.env.DRIVE_S3_COLD_PREFIX || 'cold',
      // Path style is what MinIO and most compatible servers expect.
      forcePathStyle: (process.env.DRIVE_S3_PATH_STYLE || 'true') !== 'false',
    },
  },
  upload: {
    minChunkSize: 64 * 1024,
    maxChunkSize: 64 * 1024 * 1024,
    defaultChunkSize: 8 * 1024 * 1024,
    sessionTtlMs: 24 * 60 * 60 * 1000,
  },
}