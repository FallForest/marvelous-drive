import http from 'node:http'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'

/**
 * Marvelous Drive update agent.
 *
 * A separate container that owns two things the API must never have: the Docker
 * socket and a writable copy of the compose project. It does exactly one job —
 * fetch and validate the release manifest, then hand it to
 * scripts/deploy/update.sh — and reports progress over HTTP for the client to
 * poll.
 *
 *   GET  /status   { status: idle | running | completed | failed, output, error }
 *   POST /update   starts a run; 409 when one is already going
 *
 * Every request needs 'Authorization: Bearer $UPDATE_AGENT_TOKEN'. The container
 * is not published to the host, so the API is the only caller.
 *
 * The manifest is written to a file rather than applied here, and that ordering
 * is load-bearing: update.sh takes its backup before it changes .env. An agent
 * that pinned the new tag itself would make the rollback restore the *new*
 * values, which is a rollback that rolls nothing back.
 */

const port = Number(process.env.UPDATE_AGENT_PORT || 8080)
const token = process.env.UPDATE_AGENT_TOKEN || ''
const projectDir = process.env.UPDATE_PROJECT_DIR || '/workspace'
const manifestUrl = process.env.UPDATE_MANIFEST_URL || ''
const composeProject = process.env.COMPOSE_PROJECT_NAME || 'marvelous-drive'

/** Where the validated manifest is handed to update.sh. */
const MANIFEST_FILE = projectDir + '/.update-manifest.json'

/** How much child output is kept for the polling client. */
const OUTPUT_LIMIT = 12000

let state = { status: 'idle', startedAt: null, finishedAt: null, output: '', error: null }

/**
 * The compose files this deployment uses, in order.
 *
 * COMPOSE_FILE is a space-separated list. Treating it as one path produces
 *   ENOENT: open '/workspace/docker-compose.yml docker-compose.deploy.yml'
 * which fails the update before it touches anything.
 */
function composeFiles() {
  return String(process.env.COMPOSE_FILE || 'docker-compose.yml')
    .split(/\s+/)
    .map((file) => file.trim())
    .filter(Boolean)
}

/**
 * Fetches and validates the manifest, then writes it where update.sh expects it.
 *
 * Validation is deliberately strict: a manifest without a version or an image
 * cannot move a deployment forward, and reporting that here is much clearer than
 * a failed pull twenty seconds later.
 */
async function fetchManifest() {
  if (!manifestUrl) throw new Error('UPDATE_MANIFEST_URL is not set')
  const response = await fetch(manifestUrl, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error('release manifest returned ' + response.status)
  const manifest = await response.json()
  if (!manifest || typeof manifest.version !== 'string' || !manifest.version.trim()) {
    throw new Error('release manifest has no version')
  }
  if (typeof manifest.image !== 'string' || !manifest.image.trim()) {
    throw new Error('release manifest has no image')
  }
  await writeFile(MANIFEST_FILE, JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}

const authorized = (request) => Boolean(token) && request.headers.authorization === 'Bearer ' + token

function send(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) })
  response.end(payload)
}

const append = (chunk) => { state.output = (state.output + chunk.toString()).slice(-OUTPUT_LIMIT) }

function finish(status, error) {
  state = { ...state, status, finishedAt: new Date().toISOString(), error: error || null }
}

function startUpdate() {
  state = { status: 'running', startedAt: new Date().toISOString(), finishedAt: null, output: '', error: null }
  fetchManifest().then(() => {
    const child = spawn('bash', ['scripts/deploy/update.sh'], {
      cwd: projectDir,
      env: { ...process.env, COMPOSE_PROJECT_NAME: composeProject, UPDATE_MANIFEST_FILE: MANIFEST_FILE },
    })
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.on('error', (error) => finish('failed', error.message))
    child.on('exit', (code) => finish(code === 0 ? 'completed' : 'failed', code === 0 ? null : 'update exited with code ' + code))
  }).catch((error) => finish('failed', error.message))
}

const server = http.createServer((request, response) => {
  if (!authorized(request)) return send(response, 401, { error: 'unauthorized' })
  if (request.method === 'GET' && request.url === '/status') return send(response, 200, state)
  if (request.method === 'POST' && request.url === '/update') {
    if (state.status === 'running') return send(response, 409, { error: 'update already running', state })
    startUpdate()
    return send(response, 202, state)
  }
  return send(response, 404, { error: 'not found' })
})

server.listen(port, '0.0.0.0', () => {
  console.log('update agent listening on ' + port + ' for ' + projectDir)
  console.log('compose files: ' + composeFiles().join(' '))
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
