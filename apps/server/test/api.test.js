import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { startServer, uniqueEmail } from './helpers.js'

/**
 * End-to-end behaviour of the HTTP API: accounts, tree, uploads, ranges,
 * versions, shares and the Docs bridge failure path.
 */

let app
let api
let token

before(async () => {
  app = await startServer()
  api = app.client
})

after(async () => {
  await app.close()
  app.cleanup()
})

const auth = (extra = {}) => ({ token, ...extra })

describe('accounts', () => {
  it('registers and returns a working token', async () => {
    const email = uniqueEmail()
    const response = await api('POST', '/api/v1/auth/register', { body: { email, password: 'correct horse battery' } })
    assert.equal(response.status, 201)
    assert.equal(response.json.user.email, email)
    assert.equal(response.json.user.role, 'owner')
    token = response.json.token
    const me = await api('GET', '/api/v1/me', auth())
    assert.equal(me.status, 200)
    assert.equal(me.json.user.email, email)
  })

  it('rejects a duplicate e-mail and a short password', async () => {
    const email = uniqueEmail()
    await api('POST', '/api/v1/auth/register', { body: { email, password: 'long enough password' } })
    const duplicate = await api('POST', '/api/v1/auth/register', { body: { email, password: 'long enough password' } })
    assert.equal(duplicate.status, 409)
    assert.equal(duplicate.json.error.code, 'CONFLICT')
    const short = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'short' } })
    assert.equal(short.status, 400)
  })

  it('rejects bad credentials and missing tokens', async () => {
    const email = uniqueEmail()
    await api('POST', '/api/v1/auth/register', { body: { email, password: 'long enough password' } })
    const bad = await api('POST', '/api/v1/auth/login', { body: { email, password: 'wrong password' } })
    assert.equal(bad.status, 401)
    assert.equal(bad.json.error.code, 'INVALID_CREDENTIALS')
    const anonymous = await api('GET', '/api/v1/nodes')
    assert.equal(anonymous.status, 401)
    assert.equal(anonymous.json.error.code, 'UNAUTHENTICATED')
  })
})

describe('node tree', () => {
  let folderId

  it('creates a folder and a file', async () => {
    const folder = await api('POST', '/api/v1/nodes', auth({ body: { name: 'Project Alpha', kind: 'folder' } }))
    assert.equal(folder.status, 201)
    assert.equal(folder.json.node.kind, 'folder')
    folderId = folder.json.node.id
    const file = await api('POST', '/api/v1/nodes', auth({ body: { name: 'readme.md', parentId: folderId } }))
    assert.equal(file.status, 201)
    assert.equal(file.json.node.parentId, folderId)
    assert.equal(file.json.node.mime, 'application/octet-stream')
  })

  it('rejects duplicate names in one folder and illegal characters', async () => {
    await api('POST', '/api/v1/nodes', auth({ body: { name: 'notes.txt', parentId: folderId } }))
    const duplicate = await api('POST', '/api/v1/nodes', auth({ body: { name: 'notes.txt', parentId: folderId } }))
    assert.equal(duplicate.status, 409)
    assert.equal(duplicate.json.error.code, 'CONFLICT')
    const illegal = await api('POST', '/api/v1/nodes', auth({ body: { name: 'a/b.txt', parentId: folderId } }))
    assert.equal(illegal.status, 400)
  })

  it('refuses to move a folder into itself or a descendant', async () => {
    const child = await api('POST', '/api/v1/nodes', auth({ body: { name: 'child', kind: 'folder', parentId: folderId } }))
    const self = await api('PUT', `/api/v1/nodes/${folderId}`, auth({ body: { parentId: folderId } }))
    assert.equal(self.status, 400)
    assert.equal(self.json.error.code, 'INVALID_PARENT')
    const descendant = await api('PUT', `/api/v1/nodes/${folderId}`, auth({ body: { parentId: child.json.node.id } }))
    assert.equal(descendant.status, 400)
  })

  it('lists children, filters the trash, and searches', async () => {
    const list = await api('GET', `/api/v1/nodes?parentId=${folderId}`, auth())
    assert.equal(list.status, 200)
    assert.ok(list.json.nodes.every((node) => node.parentId === folderId))
    const found = await api('GET', '/api/v1/search?q=readme', auth())
    assert.equal(found.status, 200)
    assert.ok(found.json.results.some((result) => result.name === 'readme.md'))
  })
})

describe('content and versions', () => {
  let fileId

  it('uploads bytes and reports the node', async () => {
    const up = await api('PUT', '/api/v1/uploads?name=hello.txt', auth({
      raw: true, body: 'hello world', headers: { 'content-type': 'text/plain' },
    }))
    assert.equal(up.status, 201)
    assert.equal(up.json.node.size, 11)
    assert.equal(up.json.node.mime, 'text/plain')
    fileId = up.json.node.id
  })

  it('serves the bytes, honours Range, and sets attachment on download', async () => {
    const full = await api('GET', `/api/v1/files/${fileId}/content`, auth())
    assert.equal(full.status, 200)
    assert.equal(full.text, 'hello world')
    const ranged = await api('GET', `/api/v1/files/${fileId}/content`, auth({ headers: { range: 'bytes=0-4' } }))
    assert.equal(ranged.status, 206)
    assert.equal(ranged.text, 'hello')
    assert.equal(ranged.headers.get('content-range'), 'bytes 0-4/11')
    const download = await api('GET', `/api/v1/files/${fileId}/content?download=1`, auth())
    assert.match(download.headers.get('content-disposition') || '', /attachment; filename="hello\.txt"/)
  })

  it('version-bumps on overwrite and restores an older version', async () => {
    const overwrite = await api('PUT', `/api/v1/files/${fileId}/content`, auth({
      raw: true, body: 'goodbye world', headers: { 'content-type': 'text/plain' },
    }))
    assert.equal(overwrite.status, 200)
    assert.equal(overwrite.json.node.version, 2)
    const versions = await api('GET', `/api/v1/files/${fileId}/versions`, auth())
    assert.equal(versions.json.versions.length, 1)
    const restore = await api('POST', `/api/v1/files/${fileId}/versions/${versions.json.versions[0].id}/restore`, auth({
      body: { expectedVersion: 2 },
    }))
    assert.equal(restore.status, 200)
    const content = await api('GET', `/api/v1/files/${fileId}/content`, auth())
    assert.equal(content.text, 'hello world')
  })

  it('deduplicates identical bytes in the blob store', async () => {
    const first = await api('PUT', '/api/v1/uploads?name=dup-a.txt', auth({ raw: true, body: 'same bytes', headers: { 'content-type': 'text/plain' } }))
    const second = await api('PUT', '/api/v1/uploads?name=dup-b.txt', auth({ raw: true, body: 'same bytes', headers: { 'content-type': 'text/plain' } }))
    assert.equal(first.json.node.blobHash, second.json.node.blobHash)
  })

  it('rejects a checksum mismatch', async () => {
    const response = await api('PUT', '/api/v1/uploads?name=bad.txt', auth({
      raw: true, body: 'abcdef', headers: { 'content-type': 'text/plain', 'x-checksum-sha256': '0'.repeat(64) },
    }))
    assert.equal(response.status, 409)
    assert.equal(response.json.error.code, 'CHECKSUM_MISMATCH')
  })
})

describe('resumable uploads', () => {
  it('assembles chunks and verifies the digest', async () => {
    const payload = Buffer.from('chunked upload payload that spans several chunks')
    const session = await api('POST', '/api/v1/uploads/sessions', auth({
      body: { name: 'chunked.bin', size: payload.length, chunkSize: 65536 },
    }))
    assert.equal(session.status, 201)
    const id = session.json.upload.id
    assert.equal(session.json.upload.totalChunks, 1)
    const put = await api('PUT', `/api/v1/uploads/sessions/${id}/chunks/0`, auth({ raw: true, body: payload, headers: { 'content-type': 'application/octet-stream' } }))
    assert.equal(put.status, 200)
    assert.deepEqual(put.json.upload.receivedChunks, [0])
    const complete = await api('POST', `/api/v1/uploads/sessions/${id}/complete`, auth({ body: {} }))
    assert.equal(complete.status, 201)
    assert.equal(complete.json.node.size, payload.length)
  })

  it('reports missing chunks and rejects an unknown session', async () => {
    const session = await api('POST', '/api/v1/uploads/sessions', auth({
      body: { name: 'multi.bin', size: 200000, chunkSize: 65536 },
    }))
    const id = session.json.upload.id
    assert.equal(session.json.upload.totalChunks, 4)
    const early = await api('POST', `/api/v1/uploads/sessions/${id}/complete`, auth({ body: {} }))
    assert.equal(early.status, 409)
    assert.equal(early.json.error.code, 'UPLOAD_INCOMPLETE')
    const missing = await api('GET', '/api/v1/uploads/sessions/00000000-0000-0000-0000-000000000000', auth())
    assert.equal(missing.status, 404)
  })
})

describe('shares', () => {
  let fileId

  it('creates a share link and serves it anonymously', async () => {
    const upload = await api('PUT', '/api/v1/uploads?name=shared.txt', auth({ raw: true, body: 'shared content', headers: { 'content-type': 'text/plain' } }))
    fileId = upload.json.node.id
    const share = await api('POST', `/api/v1/nodes/${fileId}/share`, auth({ body: { permission: 'downloader' } }))
    assert.equal(share.status, 201)
    const token = share.json.share.token
    const publicRead = await api('GET', `/api/v1/shared/${token}`)
    assert.equal(publicRead.status, 200)
    assert.equal(publicRead.json.share.node.name, 'shared.txt')
    const content = await api('GET', `/api/v1/shared/${token}/content`)
    assert.equal(content.status, 200)
    assert.equal(content.text, 'shared content')
  })

  it('enforces the password and the download budget', async () => {
    const share = await api('POST', `/api/v1/nodes/${fileId}/share`, auth({ body: { permission: 'downloader', password: 'open sesame', maxDownloads: 1 } }))
    const token = share.json.share.token
    const locked = await api('GET', `/api/v1/shared/${token}`)
    assert.equal(locked.status, 401)
    assert.equal(locked.json.error.code, 'SHARE_LOCKED')
    const wrong = await api('GET', `/api/v1/shared/${token}?password=nope`)
    assert.equal(wrong.status, 401)
    const right = await api('GET', `/api/v1/shared/${token}?password=${encodeURIComponent('open sesame')}`)
    assert.equal(right.status, 200)
    assert.equal(right.json.protected, true)
    const download = await api('GET', `/api/v1/shared/${token}/content?password=${encodeURIComponent('open sesame')}`)
    assert.equal(download.status, 200)
    const exhausted = await api('GET', `/api/v1/shared/${token}?password=${encodeURIComponent('open sesame')}`)
    assert.equal(exhausted.status, 404)
  })
})

describe('trash lifecycle', () => {
  it('trashes, restores, and purges a subtree', async () => {
    const folder = await api('POST', '/api/v1/nodes', auth({ body: { name: 'trash-me', kind: 'folder' } }))
    const child = await api('POST', '/api/v1/nodes', auth({ body: { name: 'inner.txt', parentId: folder.json.node.id } }))
    const trash = await api('DELETE', `/api/v1/nodes/${folder.json.node.id}`, auth())
    assert.equal(trash.status, 200)
    assert.equal(trash.json.trashed, 2)
    const listed = await api('GET', '/api/v1/nodes?trash=1', auth())
    assert.ok(listed.json.nodes.some((node) => node.id === child.json.node.id))
    const restore = await api('POST', `/api/v1/nodes/${folder.json.node.id}/restore`, auth({ body: {} }))
    assert.equal(restore.status, 200)
    await api('DELETE', `/api/v1/nodes/${folder.json.node.id}`, auth())
    const purge = await api('DELETE', `/api/v1/nodes/${folder.json.node.id}/permanent`, auth())
    assert.equal(purge.status, 200)
    const gone = await api('GET', `/api/v1/nodes/${child.json.node.id}`, auth())
    assert.equal(gone.status, 404)
  })

  it('refuses to purge a live node', async () => {
    const file = await api('POST', '/api/v1/nodes', auth({ body: { name: 'live.txt' } }))
    const purge = await api('DELETE', `/api/v1/nodes/${file.json.node.id}/permanent`, auth())
    assert.equal(purge.status, 400)
  })
})

describe('storage statistics', () => {
  it('reports storage statistics', async () => {
    const stats = await api('GET', '/api/v1/storage/stats', auth())
    assert.equal(stats.status, 200)
    assert.ok(stats.json.stats.files >= 1)
    assert.equal(typeof stats.json.stats.bytes, 'number')
  })

  it('no longer serves the retired Docs bridge routes', async () => {
    // The bridge was removed on purpose; a 404 here is the contract, and a 401
    // would mean an unauthenticated route is still registered somewhere.
    for (const [method, path] of [
      ['GET', '/api/v1/integrations/docs/status'],
      ['POST', '/api/v1/integrations/docs/login'],
      ['GET', '/api/v1/integrations/docs/documents'],
      ['POST', '/api/v1/integrations/docs/push'],
      ['GET', '/api/v1/integrations/docs/links'],
    ]) {
      const response = await api(method, path, auth({ body: method === 'GET' ? undefined : {} }))
      assert.equal(response.status, 404, method + ' ' + path + ' -> ' + response.status)
      assert.equal(response.json.error.code, 'NOT_FOUND')
    }
  })
})
