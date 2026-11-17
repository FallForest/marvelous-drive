import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { startServer, uniqueEmail } from './helpers.js'

let app, api, token, owner
before(async () => {
  app = await startServer()
  api = app.client
  const registered = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'merge password' } })
  token = registered.json.token
  owner = registered.json.user
})
after(async () => { await app.close(); app.cleanup() })
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const put = (name, bytes, query = '') => api('PUT', '/api/v1/uploads?name=' + encodeURIComponent(name) + query, { token, raw: true, body: bytes })
function refs(hash) {
  const db = new DatabaseSync(join(app.dataDir, 'drive.db'))
  try { return db.prepare('SELECT refs FROM blobs WHERE hash=?').get(hash)?.refs || 0 } finally { db.close() }
}
async function session(name, bytes, options = {}) {
  const opened = await api('POST', '/api/v1/uploads/sessions', {
    token, body: { name, size: bytes.length, sha256: digest(bytes), chunkSize: 65536, ...options },
  })
  assert.equal(opened.status, 201, opened.text)
  const upload = opened.json.upload
  const chunk = await api('PUT', '/api/v1/uploads/sessions/' + upload.id + '/chunks/0', { token, raw: true, body: bytes })
  assert.equal(chunk.status, 200, chunk.text)
  return upload
}
const complete = (id) => api('POST', '/api/v1/uploads/sessions/' + id + '/complete', { token })

describe('incremental folder upload server contract', () => {
  it('makes identical overwrite idempotent: no version, timestamp or reference change', async () => {
    const bytes = 'same bytes'
    const first = await put('unchanged.txt', bytes)
    const node = first.json.node
    const again = await put(node.name, bytes)
    assert.equal(again.status, 200, again.text)
    assert.equal(again.json.unchanged, true)
    assert.deepEqual(again.json.node, node)
    assert.equal(refs(node.blobHash), 1)
    const history = await api('GET', '/api/v1/files/' + node.id + '/versions', { token })
    assert.deepEqual(history.json.versions, [])
  })

  it('refuses a stale replacement and releases the rejected bytes', async () => {
    const node = (await put('stale.txt', 'first')).json.node
    const next = (await put(node.name, 'other tab')).json.node
    const rejected = await put(node.name, 'stale replacement', '&expectedVersion=1&expectedNodeId=' + node.id)
    assert.equal(rejected.status, 409, rejected.text)
    assert.equal(rejected.json.error.code, 'VERSION_CONFLICT')
    assert.equal(refs(digest('stale replacement')), 0)
    const content = await api('GET', '/api/v1/files/' + next.id + '/content', { token })
    assert.equal(content.text, 'other tab')
  })

  it('guards a previously absent name against a concurrent creation', async () => {
    await put('appeared.txt', 'another upload')
    const rejected = await put('appeared.txt', 'local upload', '&expectedVersion=0')
    assert.equal(rejected.status, 409)
    assert.equal(refs(digest('local upload')), 0)
  })

  it('guards a deleted and recreated name even when its version number matches', async () => {
    const first = (await put('recreated.txt', 'first incarnation')).json.node
    await api('DELETE', '/api/v1/nodes/' + first.id, { token })
    const next = (await put(first.name, 'second incarnation')).json.node
    assert.equal(next.version, first.version)
    const rejected = await put(first.name, 'stale incarnation', '&expectedVersion=1&expectedNodeId=' + first.id)
    assert.equal(rejected.status, 409)
    assert.equal(refs(digest('stale incarnation')), 0)
  })

  it('checks the same snapshot for instant upload without retaining a rejected reference', async () => {
    const source = (await put('instant-source.txt', 'already stored merge')).json.node
    const target = (await put('instant-target.txt', 'target first')).json.node
    await put(target.name, 'target changed')
    const beforeRefs = refs(source.blobHash)
    const rejected = await api('POST', '/api/v1/uploads/instant', { token, body: {
      name: target.name, sha256: source.blobHash, size: source.size, expectedVersion: target.version, expectedNodeId: target.id,
    } })
    assert.equal(rejected.status, 409, rejected.text)
    assert.equal(refs(source.blobHash), beforeRefs)
  })

  it('keeps session merge choices across reload and refuses a stale completion', async () => {
    const node = (await put('session-stale.txt', 'before session')).json.node
    const upload = await session(node.name, 'session stale replacement', { expectedVersion: node.version, expectedNodeId: node.id, onConflict: 'overwrite' })
    const restored = await api('GET', '/api/v1/uploads/sessions/' + upload.id, { token })
    assert.equal(restored.json.upload.expectedNodeId, node.id)
    assert.equal(restored.json.upload.expectedVersion, node.version)
    await put(node.name, 'someone edited while paused')
    const rejected = await complete(upload.id)
    assert.equal(rejected.status, 409, rejected.text)
    assert.equal(refs(digest('session stale replacement')), 0)
  })

  it('keeps rename and skip policies when a resumed completion sends no policy body', async () => {
    const node = (await put('session-policy.txt', 'original')).json.node
    const rename = await session(node.name, 'keep both bytes', { onConflict: 'rename' })
    const renamed = await complete(rename.id)
    assert.equal(renamed.status, 201, renamed.text)
    assert.equal(renamed.json.node.name, 'session-policy (1).txt')
    const skip = await session(node.name, 'skip these bytes', { onConflict: 'skip' })
    const skipped = await complete(skip.id)
    assert.equal(skipped.status, 200, skipped.text)
    assert.equal(skipped.json.skipped, true)
    assert.equal(skipped.json.node.id, node.id)
    assert.equal(skipped.json.node.version, node.version)
    assert.equal(refs(digest('skip these bytes')), 0)
  })

  it('rejects invalid upload versions instead of silently disabling protection', async () => {
    for (const value of ['-1', 'NaN', '1.5', '']) {
      const result = await put('invalid-version.txt', 'bytes', '&expectedVersion=' + value)
      assert.equal(result.status, 400, value)
    }
  })

  it('reuses one namespace in a shared folder while keeping personal roots separate', async () => {
    const registered = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'member password' } })
    const member = registered.json
    const { addMember } = await import('../src/workspaces.js')
    addMember(owner.workspace.id, member.user.id, 'member')
    const folder = (await api('POST', '/api/v1/nodes', { token, body: { name: 'shared-merge', kind: 'folder' } })).json.node
    await api('POST', '/api/v1/nodes', { token, body: { name: 'Docs', kind: 'folder', parentId: folder.id } })
    const duplicate = await api('POST', '/api/v1/nodes', { token: member.token, body: { name: 'Docs', kind: 'folder', parentId: folder.id } })
    assert.equal(duplicate.status, 409, duplicate.text)
    const contents = await api('GET', '/api/v1/nodes?parentId=' + folder.id, { token: member.token })
    assert.equal(contents.json.nodes.length, 1)

    const own = (await put('personal-root.txt', 'owner personal content')).json.node
    await put('personal-root (1).txt', 'owner numbered content')
    const separate = await api('PUT', '/api/v1/uploads?name=personal-root.txt&expectedVersion=0', { token: member.token, raw: true, body: 'member personal content' })
    assert.equal(separate.status, 201, separate.text)
    assert.notEqual(separate.json.node.id, own.id)
    const rename = await api('PUT', '/api/v1/uploads?name=personal-root.txt&onConflict=rename', { token: member.token, raw: true, body: 'member copy' })
    assert.equal(rename.json.node.name, 'personal-root (1).txt', 'another member root does not reserve this name')
    assert.equal((await api('GET', '/api/v1/files/' + own.id + '/content', { token })).text, 'owner personal content')
  })
})
