import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Boots the real server in-process on an ephemeral port with a throwaway data
 * directory, and hands back a tiny fetch client. Nothing here mocks HTTP: the
 * tests exercise the same code path a browser or the CLI would.
 *
 * `startServer()` refuses to start when configuration was already resolved for
 * somewhere else, and throws — never waits — when the listener cannot bind. Both
 * failures name the offending directory and the fix, because the alternative is a
 * suite that quietly writes fixtures into the checkout's own database.
 */

function failFastMessage(config, dataDir) {
  return [
    '[test] server configuration was already initialized before startServer() could isolate it.',
    `  configured: dataDir=${config.dataDir} port=${config.port} host=${config.host}`,
    `  expected:   dataDir=${dataDir} port=0 host=127.0.0.1`,
    'A test file imported a module that reads configuration at module load (config.js, db.js,',
    'storage/backend.js, or a route that reaches them). That module bound this process to the',
    'ambient database and port, so fixtures would be written to the wrong place.',
    'Move that import into before() after startServer(), or use `await import(...)` there.',
  ].join('\n')
}

/** Resolves on `listening`, rejects on `error` instead of waiting forever. */
function waitForListening(server) {
  if (server.listening) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onListening = () => { server.off('error', onError); resolve() }
    const onError = (error) => { server.off('listening', onListening); reject(error) }
    server.once('listening', onListening)
    server.once('error', onError)
  })
}

async function closeQuietly(server) {
  if (!server) return
  try { await new Promise((resolve) => server.close(() => resolve())) } catch { /* already closed */ }
}

export async function startServer() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mdrive-test-'))
  process.env.DRIVE_DATA_DIR = dataDir
  process.env.PORT = '0'
  process.env.HOST = '127.0.0.1'
  process.env.DRIVE_LOG = '0'

  // Import after the env is set: config.js resolves paths at module load. A static
  // import in the test file would already have evaluated it against the checkout's
  // data directory, so refuse to start rather than point fixtures at that database.
  const { config } = await import('../src/config.js')
  if (config.dataDir !== resolve(dataDir) || config.port !== 0 || config.host !== '127.0.0.1') {
    try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* windows lock */ }
    throw new Error(failFastMessage(config, dataDir))
  }

  let server
  try {
    ({ server } = await import('../src/index.js'))
    await waitForListening(server)
  } catch (error) {
    // A failed boot must not leak the half-started server, the index worker or the
    // throwaway directory: the suite is about to fail, and a second failure in
    // `after` (server.close on undefined) would hide this one.
    await closeQuietly(server)
    try {
      const { stopIndexJobs } = await import('../src/ops/index-jobs.js')
      await stopIndexJobs()
    } catch { /* index module may not have loaded */ }
    try {
      const { db } = await import('../src/db.js')
      db.close()
    } catch { /* database may not have opened, or belongs to another graph */ }
    try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* windows lock */ }
    throw error
  }
  const { port } = server.address()

  const client = async (method, path, { body, token, headers = {}, raw = false } = {}) => {
    const init = { method, headers: { ...headers } }
    if (token) init.headers.authorization = `Bearer ${token}`
    if (body !== undefined) {
      init.body = raw || typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
      if (!raw) init.headers['content-type'] = init.headers['content-type'] || 'application/json'
    }
    const response = await fetch(`http://127.0.0.1:${port}${path}`, init)
    const text = await response.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { json = null }
    return { status: response.status, json, text, headers: response.headers }
  }

  // Both are safe to call on a suite whose `before` threw, and both are idempotent:
  // an `after` hook that calls them unconditionally must not become a second
  // failure that hides the first one.
  const close = async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve))
    try {
      const { stopIndexJobs } = await import('../src/ops/index-jobs.js')
      await stopIndexJobs()
    } catch { /* index module may not have loaded */ }
    // The server only closes its connection on SIGINT, but a test process is not a
    // deployment: leaving `drive.db` open keeps the WAL files locked on Windows, so
    // `cleanup()` cannot remove the directory and every run leaks one.
    try {
      const { db } = await import('../src/db.js')
      db.close()
    } catch { /* already closed, or never opened */ }
  }

  // `force: true` does not retry a file that is still held, so the retry budget is
  // explicit. Cleanup stays best effort: a temp directory that will not delete must
  // never turn a passing suite into a failing one.
  const cleanup = () => {
    try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }
    catch { /* windows lock */ }
  }

  return { client, close, cleanup, dataDir, port }
}

export const uniqueEmail = () => `user-${Math.random().toString(16).slice(2)}@example.com`
