import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { startServer, uniqueEmail } from './helpers.js'

/**
 * The self-update surface: what the account menu reads, what the update button
 * calls, and the answers it gives when the deployment has no updater.
 *
 * The agent itself is a separate container, so these tests stand one up as a
 * plain HTTP server and point the API at it through the environment. That keeps
 * the seam under test — the API really fetches, really forwards the bearer
 * token, and really maps a 409 onto a conflict.
 */

let app
let api
let token
let agent
let agentCalls
let agentState
let manifest

/** A stand-in for the updater container. */
async function startAgent() {
  const { createServer } = await import('node:http')
  const server = createServer((request, response) => {
    agentCalls.push({ method: request.method, url: request.url, authorization: request.headers.authorization })
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    if (request.headers.authorization !== 'Bearer test-agent-token') return send(401, { error: 'unauthorized' })
    if (request.method === 'GET' && request.url === '/status') return send(200, agentState)
    if (request.method === 'POST' && request.url === '/update') {
      if (agentState.status === 'running') return send(409, { error: 'update already running', state: agentState })
      agentState = { status: 'running', startedAt: new Date().toISOString(), finishedAt: null, output: '', error: null }
      return send(202, agentState)
    }
    return send(404, { error: 'not found' })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}

/** A stand-in for the release asset the workflow uploads. */
async function startManifestHost() {
  const { createServer } = await import('node:http')
  const server = createServer((request, response) => {
    if (!manifest) { response.writeHead(404); response.end(); return }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(manifest))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}

let manifestServer

before(async () => {
  agentCalls = []
  agentState = { status: 'idle', startedAt: null, finishedAt: null, output: '', error: null }
  agent = await startAgent()
  manifestServer = await startManifestHost()
  process.env.DRIVE_UPDATE_AGENT_URL = 'http://127.0.0.1:' + agent.address().port
  process.env.DRIVE_UPDATE_AGENT_TOKEN = 'test-agent-token'
  process.env.DRIVE_UPDATE_MANIFEST_URL = 'http://127.0.0.1:' + manifestServer.address().port + '/latest.json'
  app = await startServer()
  api = app.client
  const registered = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'correct horse battery' } })
  token = registered.json.token
})

after(async () => {
  await app.close()
  app.cleanup()
  await new Promise((resolve) => agent.close(resolve))
  await new Promise((resolve) => manifestServer.close(resolve))
  delete process.env.DRIVE_UPDATE_AGENT_URL
  delete process.env.DRIVE_UPDATE_AGENT_TOKEN
  delete process.env.DRIVE_UPDATE_MANIFEST_URL
})

describe('release check', () => {
  it('reports the running version and no update when the manifest is absent', async () => {
    manifest = null
    const response = await api('GET', '/api/v1/system/update-check')
    assert.equal(response.status, 200)
    assert.ok(response.json.currentVersion)
    assert.equal(response.json.latestVersion, null)
    assert.equal(response.json.updateAvailable, false)
    assert.equal(response.json.configured, true)
  })

  it('offers a newer release and carries its links through', async () => {
    manifest = {
      version: '99.0.0',
      image: 'ghcr.io/fallforest/marvelous-drive:99.0.0',
      releaseUrl: 'https://github.com/FallForest/marvelous-drive/releases/tag/v99.0.0',
      notesUrl: 'https://github.com/FallForest/marvelous-drive/releases',
    }
    const response = await api('GET', '/api/v1/system/update-check')
    assert.equal(response.json.updateAvailable, true)
    assert.equal(response.json.latestVersion, '99.0.0')
    assert.equal(response.json.manifest.releaseUrl, manifest.releaseUrl)
  })

  it('does not offer the version it is already running', async () => {
    const current = await api('GET', '/api/v1/system/update-check')
    manifest = { version: current.json.currentVersion }
    const response = await api('GET', '/api/v1/system/update-check')
    assert.equal(response.json.updateAvailable, false)
    assert.equal(response.json.latestVersion, current.json.currentVersion)
  })

  it('never needs an account: the login screen can ask too', async () => {
    const response = await api('GET', '/api/v1/system/update-check')
    assert.equal(response.status, 200)
  })
})

describe('starting an update', () => {
  it('requires an account', async () => {
    const response = await api('POST', '/api/v1/system/update')
    assert.equal(response.status, 401)
  })

  it('refuses when there is nothing newer to install', async () => {
    const current = await api('GET', '/api/v1/system/update-check')
    manifest = { version: current.json.currentVersion }
    const before = agentCalls.length
    const response = await api('POST', '/api/v1/system/update', { token })
    assert.equal(response.status, 200)
    assert.equal(response.json.started, false)
    // The agent must not even be asked: restarting for no change is downtime.
    assert.equal(agentCalls.length, before)
  })

  it('hands a newer release to the agent with the bearer token', async () => {
    agentState = { status: 'idle', startedAt: null, finishedAt: null, output: '', error: null }
    manifest = { version: '99.0.0', image: 'ghcr.io/fallforest/marvelous-drive:99.0.0' }
    const response = await api('POST', '/api/v1/system/update', { token })
    assert.equal(response.status, 202)
    assert.equal(response.json.started, true)
    assert.equal(response.json.update.status, 'running')
    const call = agentCalls.find((entry) => entry.method === 'POST')
    assert.ok(call, 'the agent was called')
    assert.equal(call.authorization, 'Bearer test-agent-token')
  })

  it('maps a run in flight onto a conflict', async () => {
    const response = await api('POST', '/api/v1/system/update', { token })
    assert.equal(response.status, 409)
    assert.equal(response.json.error.code, 'UPDATE_REJECTED')
  })

  it('reports the agent state to the poller', async () => {
    const response = await api('GET', '/api/v1/system/update-status', { token })
    assert.equal(response.status, 200)
    assert.equal(response.json.update.status, 'running')
  })

  it('reports an unreachable agent as a bad gateway, not a crash', async () => {
    const realUrl = process.env.DRIVE_UPDATE_AGENT_URL
    process.env.DRIVE_UPDATE_AGENT_URL = 'http://127.0.0.1:1'
    try {
      // The config is read once at boot, so the route keeps using the port it
      // resolved; stopping the listener is how this test makes it unreachable.
      await new Promise((resolve) => agent.close(resolve))
      const response = await api('GET', '/api/v1/system/update-status', { token })
      assert.equal(response.status, 502)
      assert.equal(response.json.error.code, 'UPDATER_UNREACHABLE')
    } finally {
      process.env.DRIVE_UPDATE_AGENT_URL = realUrl
    }
  })
})
