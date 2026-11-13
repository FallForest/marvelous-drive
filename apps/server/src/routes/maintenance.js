import { db } from '../db.js'
import { userFromRequest } from '../auth.js'
import { sendJson } from '../http.js'
import { requireWorkspaceOwner } from '../admin.js'
import { forgetMissing, quarantineBlobs, reclaimOrphans, scanBlobs, verifyChecksums } from '../ops/scrub.js'
import { indexCoverage, rebuildIndex } from '../ops/search-index.js'
import { accessReport } from '../ops/access-log.js'
import { backend } from '../storage/backend.js'
import { config } from '../config.js'

/**
 * Maintenance surface.
 *
 * Read-only by default: `GET /maintenance/blobs` reports, and the two repair
 * actions are explicit POSTs so nothing destructive happens because a client
 * polled a status endpoint.
 */
export function registerMaintenanceRoutes(router) {
  router.get('/api/v1/maintenance/blobs', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    requireWorkspaceOwner(user, ctx.fail)
    sendJson(ctx.res, 200, { scan: await scanBlobs(), retentionDays: config.trashRetentionDays })
  })

  /**
   * Which storage backend is serving the bytes.
   *
   * The abstraction exists so a second tier can be added; this endpoint is how an
   * operator confirms what is actually running instead of guessing from config.
   */
  router.get('/api/v1/maintenance/storage/backend', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    requireWorkspaceOwner(user, ctx.fail)
    const blobs = db.prepare('SELECT COUNT(*) AS total, SUM(size) AS bytes FROM blobs').get()
    sendJson(ctx.res, 200, {
      backend: {
        name: backend.name,
        kind: backend.name === 'local' ? 'filesystem' : 'remote',
        blobs: blobs?.total || 0,
        bytes: blobs?.bytes || 0,
      },
    })
  })

  /**
   * Hot/cold split of the store.
   *
   * Read-only: it reports which blobs have not been read in `days`, which is the
   * input a tiering or archival run needs. Actually moving bytes requires a
   * second storage backend, so this deliberately stops at reporting.
   */
  router.get('/api/v1/maintenance/storage/tiers', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    requireWorkspaceOwner(user, ctx.fail)
    const days = Math.min(Math.max(Number(ctx.url.searchParams.get('days') || 90), 1), 3650)
    sendJson(ctx.res, 200, { tiers: accessReport({ days }) })
  })

  /**
   * Demotes idle blobs to the cold tier.
   *
   * Only meaningful on the `tiered` driver. `limit` bounds one run so a large
   * drive is migrated progressively — each blob is copied, rehashed, and only
   * then removed locally, so an interrupted run is safe to repeat.
   */
  router.post('/api/v1/maintenance/storage/demote', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    requireWorkspaceOwner(user, ctx.fail)
    if (typeof backend.migrateToCold !== 'function') {
      ctx.fail(409, 'DRIVER_UNSUPPORTED', 'Demotion needs the tiered driver (DRIVE_STORAGE=tiered).')
    }
    const input = await ctx.json().catch(() => ({}))
    const days = Math.min(Math.max(Number(input.days ?? config.storage.coldAfterDays), 1), 3650)
    const limit = Math.min(Math.max(Number(input.limit ?? 20), 1), 500)
    const report = accessReport({ days })
    const candidates = report.cold.slice(0, limit).map((entry) => entry.hash)
    const results = []
    for (const hash of candidates) results.push(await backend.migrateToCold(hash))
    sendJson(ctx.res, 200, {
      days,
      considered: report.coldCount,
      attempted: candidates.length,
      moved: results.filter((entry) => entry.moved).length,
      results,
    })
  })

  /**
   * Search index health.
   *
   * Read-only: reports how many indexable files have a row, so a gap left by an
   * upgrade or a restored backup is visible instead of being silently missing
   * from search results.
   */
  router.get('/api/v1/maintenance/search', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    requireWorkspaceOwner(user, ctx.fail)
    const coverage = indexCoverage()
    sendJson(ctx.res, 200, { coverage, upToDate: coverage.missing === 0 })
  })

  /**
   * Rebuilds the index for every account.
   *
   * Reads every blob, so this is an explicit operation, never part of a request
   * the client drives while showing a spinner it does not understand.
   */
  router.post('/api/v1/maintenance/search/reindex', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    requireWorkspaceOwner(user, ctx.fail)
    const before = indexCoverage()
    const summary = await rebuildIndex({ log: console })
    const after = indexCoverage()
    sendJson(ctx.res, 200, { summary, before, after })
  })

  /**
   * Rehashes the store.
   *
   * `?limit=` bounds a single run so a big drive can be checked in slices, and
   * the response reports how many blobs are left for the next pass. This is the
   * only check that finds silent corruption.
   */
  router.get('/api/v1/maintenance/blobs/verify', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    requireWorkspaceOwner(user, ctx.fail)
    const limit = Math.min(Math.max(Number(ctx.url.searchParams.get('limit') || 0), 0), 5000)
    const maxBytes = Number(ctx.url.searchParams.get('maxBytes') || 0) || Infinity
    sendJson(ctx.res, 200, { verification: await verifyChecksums({ limit, maxBytes }) })
  })

  /** Parks corrupted blobs in data/quarantine and drops their rows. */
  router.post('/api/v1/maintenance/blobs/quarantine', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    requireWorkspaceOwner(user, ctx.fail)
    const input = await ctx.json().catch(() => ({}))
    const verification = Array.isArray(input.hashes) && input.hashes.length
      ? { corrupt: input.hashes.map((hash) => ({ hash })) }
      : await verifyChecksums({ limit: Number(input.limit || 0) || 0 })
    const result = await quarantineBlobs(verification.corrupt)
    sendJson(ctx.res, 200, { ...result, quarantined: verification.corrupt.length })
  })

  router.post('/api/v1/maintenance/blobs/reclaim', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    requireWorkspaceOwner(user, ctx.fail)
    const scan = await scanBlobs()
    const result = await reclaimOrphans(scan)
    sendJson(ctx.res, 200, { ...result, scan })
  })

  router.post('/api/v1/maintenance/blobs/forget-missing', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    requireWorkspaceOwner(user, ctx.fail)
    const scan = await scanBlobs()
    const result = forgetMissing(scan)
    sendJson(ctx.res, 200, { ...result, scan: await scanBlobs() })
  })
}