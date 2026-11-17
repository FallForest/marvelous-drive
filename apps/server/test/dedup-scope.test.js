import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { startServer, uniqueEmail } from './helpers.js'

let app
let api
let owner
let stranger
let member
let db
let backend

const auth = (who, extra = {}) => ({ token: who.token, ...extra })
const digest = (body) => createHash('sha256').update(body).digest('hex')

async function register() {
  const response = await api('POST', '/api/v1/auth/register', {
    body: { email: uniqueEmail(), password: 'dedup scope password' },
  })
  assert.equal(response.status, 201, response.text)
  return response.json
}

async function upload(who, name, body) {
  const response = await api('PUT', '/api/v1/uploads?name=' + encodeURIComponent(name), auth(who, {
    body, raw: true, headers: { 'content-type': 'text/plain' },
  }))
  assert.ok(response.status === 200 || response.status === 201, response.text)
  return response.json.node
}

async function invite(who) {
  const response = await api('POST', '/api/v1/workspace/members', auth(owner, {
    body: { email: who.user.email },
  }))
  assert.equal(response.status, 201, response.text)
}

const probe = (who, hash) => api('GET', '/api/v1/blobs/' + hash, auth(who))
const instant = (who, name, body, size = Buffer.byteLength(body)) => api('POST', '/api/v1/uploads/instant', auth(who, {
  body: { name, sha256: digest(body), size },
}))
const refs = (hash) => db.prepare('SELECT refs FROM blobs WHERE hash=?').get(hash)?.refs

before(async () => {
  app = await startServer()
  api = app.client
  ;({ db } = await import('../src/db.js'))
  ;({ backend } = await import('../src/storage/backend.js'))
  owner = await register()
  stranger = await register()
  member = await register()
  await invite(member)
})

after(async () => {
  await app.close()
  app.cleanup()
})

describe('instant-upload content authorization', () => {
  it('hides private hashes and refuses to turn one into a readable foreign file', async () => {
    const body = 'a private file is not authorized by its hash'
    const source = await upload(owner, 'private-scope.txt', body)
    const direct = await api('GET', '/api/v1/files/' + source.id + '/content', auth(stranger))
    assert.equal(direct.status, 404)

    const hidden = await probe(stranger, digest(body))
    const missing = await probe(stranger, digest('not stored anywhere'))
    assert.equal(hidden.status, 404)
    assert.deepEqual(hidden.json, missing.json, 'a private hash must be indistinguishable from a missing hash')

    const before = refs(digest(body))
    const denied = await instant(stranger, 'stolen-copy.txt', body)
    assert.equal(denied.status, 404, denied.text)
    assert.equal(denied.json.error.code, 'BLOB_NOT_FOUND')
    assert.equal(refs(digest(body)), before, 'a denied request must not retain the blob')
    const wrongSize = await instant(stranger, 'size-oracle.txt', body, 1)
    assert.equal(wrongSize.status, 404, 'size validation must not reveal private blob metadata')
    const nodes = await api('GET', '/api/v1/nodes', auth(stranger))
    assert.ok(!nodes.json.nodes.some((node) => node.blobHash === digest(body)))
  })

  it('keeps same-account instant upload available', async () => {
    const body = 'owned bytes remain reusable'
    await upload(owner, 'owned-source.txt', body)
    const copy = await instant(owner, 'owned-copy.txt', body)
    assert.equal(copy.status, 201, copy.text)
    assert.equal(copy.json.deduplicated, true)
    const content = await api('GET', '/api/v1/files/' + copy.json.node.id + '/content', auth(owner))
    assert.equal(content.text, body)
  })

  it('allows a workspace member to reuse content they can already read', async () => {
    const body = 'shared workspace content'
    const source = await upload(owner, 'workspace-source.txt', body)
    const direct = await api('GET', '/api/v1/files/' + source.id + '/content', auth(member))
    assert.equal(direct.status, 200, direct.text)
    const visible = await probe(member, digest(body))
    assert.equal(visible.status, 200, visible.text)
    assert.equal(visible.json.refs, 1)
    const copy = await instant(member, 'workspace-copy.txt', body)
    assert.equal(copy.status, 201, copy.text)
    const content = await api('GET', '/api/v1/files/' + copy.json.node.id + '/content', auth(member))
    assert.equal(content.text, body)
  })

  it('denies a removed member whose only reference was in the revoked workspace', async () => {
    const removed = await register()
    await invite(removed)
    const body = 'membership is checked on every reuse'
    await upload(owner, 'revoked-source.txt', body)
    assert.equal((await probe(removed, digest(body))).status, 200)
    const revoke = await api('DELETE', '/api/v1/workspace/members/' + removed.user.id, auth(owner))
    assert.equal(revoke.status, 200, revoke.text)
    assert.equal((await probe(removed, digest(body))).status, 404)
    assert.equal((await instant(removed, 'revoked-copy.txt', body)).status, 404)
  })

  it('authorizes historical content through its live file, without exposing it to strangers', async () => {
    const body = 'historical private bytes'
    await upload(owner, 'history-source.txt', body)
    await upload(owner, 'history-source.txt', 'the newer version')
    assert.equal((await probe(stranger, digest(body))).status, 404)
    assert.equal((await instant(stranger, 'foreign-history.txt', body)).status, 404)
    const visible = await probe(member, digest(body))
    assert.equal(visible.status, 200, visible.text)
    assert.equal(visible.json.refs, 1, 'the visible version is one authorized reference')
    const copy = await instant(owner, 'history-copy.txt', body)
    assert.equal(copy.status, 201, copy.text)
    const content = await api('GET', '/api/v1/files/' + copy.json.node.id + '/content', auth(owner))
    assert.equal(content.text, body)
  })

  it('does not use trashed files or their history to authorize instant upload', async () => {
    const body = 'trashed current bytes'
    const oldBody = 'trashed historical bytes'
    const source = await upload(owner, 'trash-scope.txt', oldBody)
    await upload(owner, 'trash-scope.txt', body)
    const deleted = await api('DELETE', '/api/v1/nodes/' + source.id, auth(owner))
    assert.equal(deleted.status, 200, deleted.text)
    for (const bytes of [body, oldBody]) {
      assert.equal((await probe(owner, digest(bytes))).status, 404)
      assert.equal((await probe(member, digest(bytes))).status, 404)
      assert.equal((await instant(owner, 'trash-copy.txt', bytes)).status, 404)
    }
    const restored = await api('POST', '/api/v1/nodes/' + source.id + '/restore', auth(owner))
    assert.equal(restored.status, 200, restored.text)
    assert.equal((await probe(owner, digest(oldBody))).status, 200, 'restoring the file restores historical access')
  })

  it('deduplicates real body uploads globally while hiding unrelated reference counts', async () => {
    const body = 'independently uploaded identical bytes'
    const a = await upload(owner, 'global-a.txt', body)
    const b = await upload(stranger, 'global-b.txt', body)
    assert.equal(a.blobHash, b.blobHash, 'the storage deduplication remains global')
    assert.equal(refs(digest(body)), 2)
    const visible = await probe(stranger, digest(body))
    assert.equal(visible.status, 200, visible.text)
    assert.equal(visible.json.refs, 1, 'the foreign reference must not be counted')
    const copy = await instant(stranger, 'global-b-copy.txt', body)
    assert.equal(copy.status, 201, copy.text)
    assert.equal(refs(digest(body)), 3)
    assert.equal((await probe(owner, digest(body))).json.refs, 1)
    assert.equal((await probe(stranger, digest(body))).json.refs, 2)
  })

  for (const operation of ['probe', 'instant upload']) {
    it('rechecks access when membership is revoked during ' + operation + ' backend I/O', { timeout: 5000 }, async () => {
      const removed = await register()
      await invite(removed)
      const body = 'remote stat race for ' + operation
      await upload(owner, 'race-' + operation + '.txt', body)
      const hash = digest(body)
      const originalStat = backend.stat
      let started
      let unblock
      const reachedStat = new Promise((resolve) => { started = resolve })
      const gate = new Promise((resolve) => { unblock = resolve })
      backend.stat = async function (key) {
        if (key === hash) {
          started()
          await gate
        }
        return originalStat.call(this, key)
      }
      let pending
      try {
        pending = operation === 'probe'
          ? probe(removed, hash)
          : instant(removed, 'race-copy.txt', body)
        await reachedStat
        const revoke = await api('DELETE', '/api/v1/workspace/members/' + removed.user.id, auth(owner))
        assert.equal(revoke.status, 200, revoke.text)
        unblock()
        const denied = await pending
        assert.equal(denied.status, 404, denied.text)
        assert.equal(refs(hash), 1, 'no reference survives a revoked permission')
      } finally {
        unblock()
        backend.stat = originalStat
        if (pending) await pending
      }
    })
  }
})
