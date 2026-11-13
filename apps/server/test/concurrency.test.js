import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { startServer, uniqueEmail } from './helpers.js'

/**
 * Optimistic concurrency: two writers that started from the same version must
 * not silently overwrite each other.
 */

let app
let api
let token

before(async () => {
  app = await startServer()
  api = app.client
  const registered = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'conflict password' } })
  token = registered.json.token
})

after(async () => {
  await app.close()
  app.cleanup()
})

describe('version conflicts', () => {
  it('rejects a stale node rename', async () => {
    const file = await api('POST', '/api/v1/nodes', { token, body: { name: 'rename-me.txt' } })
    const first = await api('PUT', `/api/v1/nodes/${file.json.node.id}`, { token, body: { name: 'first.txt', expectedVersion: 1 } })
    assert.equal(first.status, 200)
    const stale = await api('PUT', `/api/v1/nodes/${file.json.node.id}`, { token, body: { name: 'second.txt', expectedVersion: 1 } })
    assert.equal(stale.status, 409)
    assert.equal(stale.json.error.code, 'VERSION_CONFLICT')
  })

  it('rejects a stale version restore', async () => {
    const upload = await api('PUT', '/api/v1/uploads?name=concurrent.txt', {
      token, raw: true, body: 'first body', headers: { 'content-type': 'text/plain' },
    })
    const id = upload.json.node.id
    await api('PUT', `/api/v1/files/${id}/content`, { token, raw: true, body: 'second body', headers: { 'content-type': 'text/plain' } })
    const versions = await api('GET', `/api/v1/files/${id}/versions`, { token })
    const versionId = versions.json.versions[0].id
    const stale = await api('POST', `/api/v1/files/${id}/versions/${versionId}/restore`, { token, body: { expectedVersion: 1 } })
    assert.equal(stale.status, 409)
    assert.equal(stale.json.error.code, 'VERSION_CONFLICT')
    const fresh = await api('POST', `/api/v1/files/${id}/versions/${versionId}/restore`, { token, body: { expectedVersion: 2 } })
    assert.equal(fresh.status, 200)
    const content = await api('GET', `/api/v1/files/${id}/content`, { token })
    assert.equal(content.text, 'first body')
  })

  it('keeps blob refcounts balanced across overwrite and purge', async () => {
    const upload = await api('PUT', '/api/v1/uploads?name=refcount.txt', {
      token, raw: true, body: 'v1', headers: { 'content-type': 'text/plain' },
    })
    const id = upload.json.node.id
    await api('PUT', `/api/v1/files/${id}/content`, { token, raw: true, body: 'v2', headers: { 'content-type': 'text/plain' } })
    const { DatabaseSync } = await import('node:sqlite')
    const { join } = await import('node:path')
    const db = new DatabaseSync(join(app.dataDir, 'drive.db'))
    const rows = db.prepare('SELECT hash, refs FROM blobs ORDER BY hash').all()
    db.close()
    assert.ok(rows.length >= 2, 'both versions keep their blob')
    assert.ok(rows.every((row) => row.refs >= 1), JSON.stringify(rows))
    await api('DELETE', `/api/v1/nodes/${id}`, { token })
    await api('DELETE', `/api/v1/nodes/${id}/permanent`, { token })
    const reopened = new DatabaseSync(join(app.dataDir, 'drive.db'))
    const remaining = reopened.prepare('SELECT hash FROM blobs').all()
    reopened.close()
    assert.equal(remaining.length, rows.length - 2, 'purge released both blobs')
  })
})
