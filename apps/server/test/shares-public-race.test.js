import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { startServer, uniqueEmail } from './helpers.js'

/**
 * The window between "authorized" and "bytes start" on a public byte route.
 *
 * Every public byte route authorizes up front, then awaits the backend's stat
 * before the response headers exist. The owner's in-place PATCH can land in that
 * await — the backend is deliberately slow here so the ordering is not a guess.
 * A rotated password must then refuse at the headers, before a byte is served
 * and before the counted routes claim a download, exactly like the folder
 * archive policy when a setting changes while packaging.
 *
 * Only the first client is paused; the owner's PATCH and the follow-up requests
 * are ordinary ones, so this is the real HTTP server with a real temp data dir.
 */

let app
let api
let token

before(async () => {
  app = await startServer()
  api = app.client
  const registered = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'race account password' } })
  assert.equal(registered.status, 201, registered.text)
  token = registered.json.token
})

after(async () => {
  await app.close()
  app.cleanup()
})

const auth = (extra = {}) => ({ token, ...extra })
const encode = (value) => encodeURIComponent(value)

async function upload(name, body, parentId) {
  const query = '/api/v1/uploads?name=' + encode(name) + (parentId ? '&parentId=' + parentId : '')
  const response = await api('PUT', query, auth({ raw: true, body, headers: { 'content-type': 'text/plain' } }))
  assert.equal(response.status, 201, response.text)
  return response.json.node
}

async function folder(name) {
  const response = await api('POST', '/api/v1/nodes', auth({ body: { name, kind: 'folder' } }))
  assert.equal(response.status, 201, response.text)
  return response.json.node
}

async function share(nodeId, body = {}) {
  const response = await api('POST', '/api/v1/nodes/' + nodeId + '/share', auth({ body }))
  assert.equal(response.status, 201, response.text)
  return response.json.share
}

const patch = (id, body) => api('PATCH', '/api/v1/shares/' + id, auth({ body }))

async function blobHashOf(nodeId) {
  const response = await api('GET', '/api/v1/nodes/' + nodeId, auth())
  assert.equal(response.status, 200, response.text)
  return response.json.node.blobHash
}

async function downloadsOf(link, password) {
  const response = await api('GET', '/api/v1/shared/' + link.token + (password ? '?password=' + encode(password) : ''))
  assert.equal(response.status, 200, response.text)
  return response.json.share.downloads
}

/**
 * Holds the backend stat of one blob, and nothing else.
 *
 * `atStat` resolves when the paused request has passed its up-front
 * authorization and is waiting for the size; `release()` lets that stat finish.
 * Matching on this test's own blob hash keeps every other request untouched.
 */
async function gateStatOn(hash) {
  const { backend } = await import('../src/storage/backend.js')
  const original = backend.stat
  let reached
  let release
  const atStat = new Promise((resolve) => { reached = resolve })
  const unblock = new Promise((resolve) => { release = resolve })
  backend.stat = async function (key) {
    if (key !== hash) return original.call(this, key)
    reached()
    await unblock
    return original.call(this, key)
  }
  return {
    atStat,
    release,
    restore: () => { backend.stat = original },
  }
}

/** Starts a public GET, holds it at the stat, rotates the password, then frees it. */
async function rotateWhilePaused(path, link, blobHash, { from, to }) {
  const gate = await gateStatOn(blobHash)
  const request = new AbortController()
  let pending
  try {
    pending = fetch('http://127.0.0.1:' + app.port + path + (path.includes('?') ? '&' : '?') + 'password=' + encode(from), {
      signal: request.signal,
    })
    await gate.atStat
    // The request is still holding an authorization proven against the old hash.
    const rotated = await patch(link.id, { password: to })
    assert.equal(rotated.status, 200, rotated.text)
    gate.release()
    const response = await pending
    pending = null
    // Read text, not json(): the bug this test exists for answers 200 with the
    // file's bytes, and that must fail on the assertion — not on a JSON parse.
    const text = await response.text()
    let body = null
    try { body = JSON.parse(text) } catch { body = null }
    return { status: response.status, text, body }
  } finally {
    request.abort()
    gate.release()
    gate.restore()
    if (pending) await pending.catch(() => {})
  }
}

describe('password rotation during the stat before public bytes', () => {
  it('answers 401 and spends no download on /content, then accepts the new credential', async () => {
    const file = await upload('race-content.txt', 'direct content race bytes')
    const link = await share(file.id, { permission: 'downloader', password: 'first secret', maxDownloads: 5 })
    const blobHash = await blobHashOf(file.id)

    const response = await rotateWhilePaused(
      '/api/v1/shared/' + link.token + '/content', link, blobHash,
      { from: 'first secret', to: 'second secret' },
    )
    assert.equal(response.status, 401, response.text)
    assert.equal(response.body.error.code, 'SHARE_LOCKED')

    assert.equal(await downloadsOf(link, 'second secret'), 0, 'a refused response must not claim a download')

    // The same token, now with the credential that actually opens it.
    const fresh = await api('GET', '/api/v1/shared/' + link.token + '/content?password=' + encode('second secret'))
    assert.equal(fresh.status, 200, fresh.text)
    assert.equal(fresh.text, 'direct content race bytes')
    assert.equal(await downloadsOf(link, 'second secret'), 1, 'the successful download spends exactly one')
  })

  it('refuses a paused nested file download and a paused inline preview too', async () => {
    const root = await folder('race folder')
    const file = await upload('race-child.txt', 'nested race bytes', root.id)
    const counted = await share(root.id, { permission: 'downloader', password: 'first secret', maxDownloads: 5 })
    const previewLink = await share(root.id, { permission: 'viewer', password: 'first secret' })
    const blobHash = await blobHashOf(file.id)

    const download = await rotateWhilePaused(
      '/api/v1/shared/' + counted.token + '/file/' + file.id, counted, blobHash,
      { from: 'first secret', to: 'second secret' },
    )
    assert.equal(download.status, 401, download.text)
    assert.equal(download.body.error.code, 'SHARE_LOCKED')
    assert.equal(await downloadsOf(counted, 'second secret'), 0)

    const preview = await rotateWhilePaused(
      '/api/v1/shared/' + previewLink.token + '/file/' + file.id + '?inline=1', previewLink, blobHash,
      { from: 'first secret', to: 'second secret' },
    )
    assert.equal(preview.status, 401, preview.text)
    assert.equal(preview.body.error.code, 'SHARE_LOCKED')

    // Both paths still serve normally with the credential that is current now.
    assert.equal((await api('GET', '/api/v1/shared/' + counted.token + '/file/' + file.id
      + '?password=' + encode('second secret'))).status, 200)
    assert.equal(await downloadsOf(counted, 'second secret'), 1)
    assert.equal((await api('GET', '/api/v1/shared/' + previewLink.token + '/file/' + file.id
      + '?inline=1&password=' + encode('second secret'))).status, 200)
  })
})
