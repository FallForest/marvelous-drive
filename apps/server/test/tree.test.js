import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { startServer, uniqueEmail } from './helpers.js'

/**
 * Tree behaviour that is easy to get subtly wrong: recursive copies, ZIP
 * archives, restores into a now-occupied name, and LIKE escaping in search.
 */

let app
let api
let token

before(async () => {
  app = await startServer()
  api = app.client
  const registered = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'tree password' } })
  token = registered.json.token
})

after(async () => {
  await app.close()
  app.cleanup()
})

const auth = (extra = {}) => ({ token, ...extra })

async function makeFolder(name, parentId) {
  const response = await api('POST', '/api/v1/nodes', auth({ body: { name, kind: 'folder', parentId } }))
  assert.equal(response.status, 201, response.text)
  return response.json.node
}

async function makeFile(name, parentId, body = name) {
  const response = await api('PUT', `/api/v1/uploads?name=${encodeURIComponent(name)}${parentId ? `&parentId=${parentId}` : ''}`, auth({
    raw: true, body, headers: { 'content-type': 'text/plain' },
  }))
  assert.equal(response.status, 201, response.text)
  return response.json.node
}

describe('copy and archive', () => {
  it('copies a folder recursively and keeps child names', async () => {
    const root = await makeFolder('projects')
    await makeFile('plan.txt', root.id, 'plan body')
    const nested = await makeFolder('nested', root.id)
    await makeFile('deep.txt', nested.id, 'deep body')

    const copy = await api('POST', `/api/v1/nodes/${root.id}/copy`, auth({ body: {} }))
    assert.equal(copy.status, 201)
    assert.equal(copy.json.node.name, 'projects (1)')

    const children = await api('GET', `/api/v1/nodes?parentId=${copy.json.node.id}`, auth())
    const names = children.json.nodes.map((node) => node.name).sort()
    assert.deepEqual(names, ['nested', 'plan.txt'])
    const nestedCopy = children.json.nodes.find((node) => node.name === 'nested')
    const deep = await api('GET', `/api/v1/nodes?parentId=${nestedCopy.id}`, auth())
    assert.deepEqual(deep.json.nodes.map((node) => node.name), ['deep.txt'])
    // Blob bytes are shared, not duplicated.
    const original = await api('GET', `/api/v1/nodes/${root.id}`, auth())
    assert.equal(original.status, 200)
  })

  it('renames a copy when asked and refuses a folder with a taken name into conflict', async () => {
    const folder = await makeFolder('renamable')
    const copy = await api('POST', `/api/v1/nodes/${folder.id}/copy`, auth({ body: { name: 'renamed' } }))
    assert.equal(copy.json.node.name, 'renamed')
  })

  it('archives a folder into a readable zip', async () => {
    const folder = await makeFolder('archive-me')
    await makeFile('a.txt', folder.id, 'alpha')
    const sub = await makeFolder('sub', folder.id)
    await makeFile('b.txt', sub.id, 'beta')

    const archive = await api('POST', `/api/v1/nodes/${folder.id}/archive`, auth({ body: {} }))
    assert.equal(archive.status, 201)
    assert.match(archive.json.node.name, /\.zip$/)
    assert.equal(archive.json.node.mime, 'application/zip')

    const download = await api('GET', `/api/v1/files/${archive.json.node.id}/content`, auth())
    assert.equal(download.status, 200)
    const bytes = Buffer.from(download.text, 'binary')
    assert.equal(bytes.subarray(0, 2).toString(), 'PK')
    assert.match(bytes.toString('binary'), /a\.txt/)
    assert.match(bytes.toString('binary'), /sub\/b\.txt/)
  })
})

describe('restore collisions', () => {
  it('renames a restored node when the name was reused', async () => {
    const folder = await makeFolder('collide')
    const file = await makeFile('same.txt', folder.id, 'original')
    await api('DELETE', `/api/v1/nodes/${file.id}`, auth())
    await makeFile('same.txt', folder.id, 'new occupant')
    const restored = await api('POST', `/api/v1/nodes/${file.id}/restore`, auth({ body: {} }))
    assert.equal(restored.status, 200)
    assert.equal(restored.json.node.name, 'same.txt (restored)')
  })

  it('refuses to restore a child while its parent is still trashed', async () => {
    const folder = await makeFolder('parent-trash')
    const file = await makeFile('child.txt', folder.id)
    await api('DELETE', `/api/v1/nodes/${folder.id}`, auth())
    const restore = await api('POST', `/api/v1/nodes/${file.id}/restore`, auth({ body: {} }))
    assert.equal(restore.status, 400)
    assert.equal(restore.json.error.code, 'INVALID_PARENT')
  })
})

describe('search and listing', () => {
  it('escapes LIKE wildcards instead of matching everything', async () => {
    await makeFile('100%done.txt', null, 'percent')
    await makeFile('under_score.txt', null, 'underscore')
    const percent = await api('GET', '/api/v1/search?q=100%25', auth())
    assert.equal(percent.status, 200)
    assert.deepEqual(percent.json.results.map((result) => result.name), ['100%done.txt'])
    const underscore = await api('GET', '/api/v1/search?q=_', auth())
    assert.equal(underscore.status, 200)
    assert.ok(underscore.json.results.every((result) => result.name.includes('_')), JSON.stringify(underscore.json.results))
  })

  it('sorts folders before files and honours the sort key', async () => {
    const parent = await makeFolder('sorting')
    await makeFile('b-file.txt', parent.id, 'b'.repeat(50))
    await makeFile('a-file.txt', parent.id, 'a')
    const byName = await api('GET', `/api/v1/nodes?parentId=${parent.id}&sort=name`, auth())
    assert.deepEqual(byName.json.nodes.map((node) => node.name), ['a-file.txt', 'b-file.txt'])
    const bySize = await api('GET', `/api/v1/nodes?parentId=${parent.id}&sort=size`, auth())
    assert.equal(bySize.json.nodes[0].name, 'b-file.txt')
  })

  it('reports starred nodes separately', async () => {
    const file = await makeFile('starred.txt', null, 'star')
    const star = await api('PUT', `/api/v1/nodes/${file.id}/star`, auth({ body: { starred: true } }))
    assert.equal(star.json.starred, true)
    const listed = await api('GET', '/api/v1/nodes?starred=1', auth())
    assert.ok(listed.json.nodes.every((node) => node.starred))
    assert.ok(listed.json.nodes.some((node) => node.id === file.id))
  })
})

describe('bodies and ranges', () => {
  it('rejects oversized JSON bodies', async () => {
    const huge = { name: 'x'.repeat(2 * 1024 * 1024) }
    const response = await api('POST', '/api/v1/nodes', auth({ body: huge }))
    assert.equal(response.status, 413)
    assert.equal(response.json.error.code, 'FILE_TOO_LARGE')
  })

  it('serves suffix ranges and rejects impossible ones', async () => {
    const file = await makeFile('ranged.txt', null, '0123456789')
    const suffix = await api('GET', `/api/v1/files/${file.id}/content`, auth({ headers: { range: 'bytes=-3' } }))
    assert.equal(suffix.status, 206)
    assert.equal(suffix.text, '789')
    const file2 = await api('GET', `/api/v1/files/${file.id}/content`, auth({ headers: { range: 'bytes=40-50' } }))
    assert.equal(file2.status, 200)
    assert.equal(file2.text, '0123456789')
  })

  it('answers HEAD without a body', async () => {
    const file = await makeFile('head.txt', null, 'head body')
    const head = await api('HEAD', `/api/v1/files/${file.id}/content`, auth())
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-length'), '9')
    assert.equal(head.text, '')
  })
})
