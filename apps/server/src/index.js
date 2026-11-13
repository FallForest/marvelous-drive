import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.js'
import { db } from './db.js'
import { HttpError, fail, readJson, sendJson, serveStatic } from './http.js'
import { Router } from './router.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerNodeRoutes } from './routes/nodes.js'
import { registerFileRoutes } from './routes/files.js'
import { registerUploadRoutes } from './routes/uploads.js'
import { registerShareRoutes } from './routes/shares.js'
import { registerMiscRoutes } from './routes/misc.js'
import { registerMaintenanceRoutes } from './routes/maintenance.js'
import { registerClusterRoutes } from './routes/cluster.js'
import { sweepExpiredTrash } from './ops/retention.js'
import { indexIsEmpty, rebuildIndex } from './ops/search-index.js'
import { backend } from './storage/backend.js'
import { registerOfficeRoutes } from './routes/office.js'
import { registerUpdateRoutes } from './routes/updates.js'
import { userFromRequest } from './auth.js'

/**
 * Marvelous Drive API entry point.
 *
 * This file only assembles the process: router table, static web client,
 * error mapping and graceful shutdown. Behaviour lives in ./routes (HTTP) and
 * ./nodes + ./blobs (domain).
 */

const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

const router = new Router()

const deps = { version }
registerMiscRoutes(router, deps)
registerAuthRoutes(router)
registerNodeRoutes(router)
registerFileRoutes(router)
registerUploadRoutes(router)
registerShareRoutes(router)
registerMaintenanceRoutes(router)
registerClusterRoutes(router)
registerOfficeRoutes(router)
// System updates answer per instance rather than per user, but starting one is
// an administrator action, so the routes resolve the caller themselves.
registerUpdateRoutes(router, deps, { userFromRequest })

function context(req, res, params) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  return {
    req,
    res,
    url,
    params,
    json: (limit) => readJson(req, limit),
    ip: String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || null,
    fail: (status, code, message) => { throw fail(status, code, message) },
  }
}

const server = createServer(async (req, res) => {
  const startedAt = Date.now()
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('referrer-policy', 'no-referrer')
  res.setHeader('x-frame-options', 'SAMEORIGIN')
  try {
    const method = req.method || 'GET'
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': req.headers.origin || '*',
        'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS',
        'access-control-allow-headers': 'authorization,content-type,x-file-name,x-checksum-sha256,x-share-password,range',
        'access-control-expose-headers': 'content-range,accept-ranges,content-disposition',
        'access-control-max-age': '600',
      })
      res.end()
      return
    }
    const matched = router.match(method, url.pathname)
    if (matched?.handler) {
      await matched.handler(context(req, res, matched.params))
    } else if (matched && matched.handler === null) {
      throw fail(405, 'INVALID_INPUT', `${method} is not allowed on ${url.pathname}.`)
    } else if (url.pathname.startsWith('/api/')) {
      throw fail(404, 'NOT_FOUND', 'The requested resource was not found.')
    } else if (url.pathname.startsWith('/s/')) {
      await serveStatic(req, res, config.webDir, '/index.html')
    } else {
      await serveStatic(req, res, config.webDir, url.pathname === '/' ? '/index.html' : url.pathname)
    }
  } catch (error) {
    if (res.writableEnded) return
    if (error instanceof HttpError) {
      const headers = error.retryAfter ? { 'retry-after': String(error.retryAfter) } : {}
      sendJson(res, error.status, { error: { code: error.code, message: error.message } }, headers)
      return
    }
    console.error(`[drive] ${req.method} ${url.pathname} failed:`, error)
    sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'An unexpected server error occurred.' } })
  } finally {
    if (process.env.DRIVE_LOG !== '0') {
      const status = res.statusCode
      if (!url.pathname.startsWith('/assets/')) {
        console.log(`${req.method} ${url.pathname} ${status} ${Date.now() - startedAt}ms`)
      }
    }
  }
})

server.requestTimeout = 0
server.headersTimeout = 120000

// Retention runs on boot so a long-idle instance catches up after downtime, then
// once an hour. Failures are logged, never fatal: a housekeeping problem must not
// stop the API from serving.
const RETENTION_INTERVAL_MS = 60 * 60 * 1000
async function runRetention() {
  try {
    const summary = await sweepExpiredTrash()
    if (summary.nodes) {
      console.log(`[retention] purged ${summary.nodes} nodes, ${summary.bytes} bytes, ${summary.blobs} blobs`)
    }
  } catch (error) {
    console.error('[retention] sweep failed:', error)
  }
}
void runRetention()

// The content index is derived data: if it is empty (fresh database, or an
// upgrade from a version that had no index) it is built once, in the background.
if (indexIsEmpty()) {
  rebuildIndex({ log: console })
    .then((summary) => console.log('[search] initial index built: ' + summary.indexed + ' files'))
    .catch((error) => console.error('[search] initial index failed:', error))
}
setInterval(runRetention, RETENTION_INTERVAL_MS).unref()

// The storage driver is chosen at import time; report it so a deployment log
// says which one is actually serving bytes.
console.log('Storage backend: ' + backend.name + (backend.bucket ? ' (bucket ' + backend.bucket + ')' : ''))

server.listen(config.port, config.host, () => {
  const address = server.address()
  const host = typeof address === 'object' && address ? address.address : config.host
  console.log(`Marvelous Drive ${version} listening on http://${host}:${config.port}`)
  console.log(`Data directory: ${config.dataDir}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`${signal} received, closing Marvelous Drive`)
    server.close(() => {
      try { db.close() } catch { /* already closed */ }
      process.exit(0)
    })
    setTimeout(() => process.exit(0), 3000).unref()
  })
}

export { server, router }