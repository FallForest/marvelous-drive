import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { startServer, uniqueEmail } from './helpers.js'

/**
 * Storage P2-4: the duplicate file report.
 *
 * The report is about *this* account's live files, so the scenarios below are
 * mostly about what must stay out of it: a trashed copy, a single leftover, and
 * identical bytes owned by somebody else.
 */

let app
let api
let token
let otherToken

before(async () => {
  app = await startServer()
  api = app.client
  const first = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'duplicates password' } })
  token = first.json.token
  const second = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'duplicates password' } })
  otherToken = second.json.token
})

after(async () => {
  await app.close()
  app.cleanup()
})

const auth = (extra = {}) => ({ token, ...extra })
const authOther = (extra = {}) => ({ token: otherToken, ...extra })

async function makeFolder(name, parentId = null) {
  const response = await api('POST', '/api/v1/nodes', auth({ body: { name, kind: 'folder', ...(parentId ? { parentId } : {}) } }))
  assert.equal(response.status, 201, response.text)
  return response.json.node
}

async function upload(name, body, parentId = null, as = 'first') {
  const parent = parentId ? `&parentId=${parentId}` : ''
  const response = await api('PUT', `/api/v1/uploads?name=${encodeURIComponent(name)}${parent}`, (as === 'first' ? auth : authOther)({
    raw: true, body, headers: { 'content-type': 'text/plain' },
  }))
  assert.ok(response.status === 201 || response.status === 200, response.text)
  return response.json.node
}

const report = async (as = 'first') => {
  const response = await api('GET', '/api/v1/storage/duplicates', as === 'first' ? auth() : authOther({}))
  assert.equal(response.status, 200, response.text)
  return response.json
}

// The shared fixture: two groups of different sizes plus everything that must
// be ignored.
const GROUP_SMALL = 'same bytes, small'      // 17 bytes, three copies
const GROUP_BIG = 'x'.repeat(400)            // 400 bytes, two copies
const TRASH_ONLY = 'uploaded twice, one copy trashed'
const UNIQUE = 'this one has no twin at all'

describe('GET /api/v1/storage/duplicates', () => {
  let smallGroupIds
  let bigGroupIds
  let nestedFolder

  before(async () => {
    const reportFolder = await makeFolder('报告')
    const yearFolder = await makeFolder('2026', reportFolder.id)
    nestedFolder = yearFolder

    // Group 1: three live copies of the same small payload, spread over folders.
    smallGroupIds = [
      (await upload('a.txt', GROUP_SMALL, reportFolder.id)).id,
      (await upload('b.txt', GROUP_SMALL)).id,
      (await upload('c.txt', GROUP_SMALL, yearFolder.id)).id,
    ]

    // Group 2: two copies of a bigger payload (bigger waste → first row).
    bigGroupIds = [
      (await upload('chart.png', GROUP_BIG, yearFolder.id)).id,
      (await upload('chart-copy.png', GROUP_BIG)).id,
    ]

    // Neither of these may appear: no twin at all ...
    await upload('unique.txt', UNIQUE)
    // ... and a trashed copy must not turn a single live file into a group.
    const keep = await upload('keep.txt', TRASH_ONLY)
    const gone = await upload('gone.txt', TRASH_ONLY)
    const deleted = await api('DELETE', '/api/v1/nodes/' + gone.id, auth())
    assert.equal(deleted.status, 200, deleted.text)
    assert.ok(keep.id)
  })

  it('reports one group per duplicated payload, biggest waste first', async () => {
    const payload = await report()
    assert.equal(payload.groupCount, 2)
    assert.equal(payload.groups.length, 2)
    assert.deepEqual(payload.groups.map((group) => group.size), [GROUP_BIG.length, GROUP_SMALL.length])
    assert.deepEqual(payload.groups.map((group) => group.nodes.length), [2, 3])
    assert.deepEqual(payload.groups.map((group) => group.wastedBytes), [GROUP_BIG.length, GROUP_SMALL.length * 2])
    assert.equal(payload.totalWastedBytes, GROUP_BIG.length + GROUP_SMALL.length * 2)
    assert.equal(payload.groups[0].wastedBytes > payload.groups[1].wastedBytes, true)
  })

  it('lists the node shape the drawer needs, including the parent path', async () => {
    const payload = await report()
    const small = payload.groups.find((group) => group.size === GROUP_SMALL.length)
    const names = small.nodes.map((node) => node.name).sort()
    assert.deepEqual(names, ['a.txt', 'b.txt', 'c.txt'])
    for (const node of small.nodes) {
      assert.equal(typeof node.id, 'string')
      assert.equal(typeof node.updatedAt, 'string')
      assert.ok(Array.isArray(node.path))
      assert.ok(node.parentId === null || typeof node.parentId === 'string')
    }
    const nested = small.nodes.find((node) => node.name === 'c.txt')
    assert.deepEqual(nested.path.map((part) => part.name), ['报告', '2026'])
    assert.equal(nested.path[1].id, nestedFolder.id)
    const atRoot = small.nodes.find((node) => node.name === 'b.txt')
    assert.deepEqual(atRoot.path, [])
    assert.equal(atRoot.parentId, null)
    assert.equal(JSON.stringify(payload).includes('blobs/'), false, 'the on-disk path must stay hidden')
  })

  it('leaves out a single live file whose twin is only in the trash', async () => {
    const payload = await report()
    const everyNode = payload.groups.flatMap((group) => group.nodes.map((node) => node.name))
    assert.equal(everyNode.includes('keep.txt'), false)
    assert.equal(everyNode.includes('gone.txt'), false)
    assert.equal(everyNode.includes('unique.txt'), false)
  })

  it('never mixes in identical bytes owned by another account', async () => {
    // Another user uploads the very same payloads; their own report is theirs.
    await upload('theirs-1.txt', GROUP_SMALL, null, 'other')
    await upload('theirs-2.txt', GROUP_SMALL, null, 'other')
    await upload('theirs-3.txt', GROUP_BIG, null, 'other')

    const mine = await report()
    const mineNames = mine.groups.flatMap((group) => group.nodes.map((node) => node.name))
    assert.equal(mineNames.some((name) => name.startsWith('theirs-')), false)
    assert.equal(mine.groups.length, 2)
    assert.deepEqual(mine.groups.map((group) => group.nodes.length), [2, 3])

    const other = await report('other')
    assert.equal(other.groupCount, 1)
    assert.equal(other.groups[0].nodes.length, 2)
    assert.deepEqual(other.groups[0].nodes.map((node) => node.name).sort(), ['theirs-1.txt', 'theirs-2.txt'])
    assert.equal(other.totalWastedBytes, GROUP_SMALL.length)
  })

  it('drops a group once the extra copies are in the trash', async () => {
    const before = await report()
    assert.equal(before.groupCount, 2)
    for (const id of bigGroupIds.slice(1)) {
      const response = await api('DELETE', '/api/v1/nodes/' + id, auth())
      assert.equal(response.status, 200, response.text)
    }
    const after = await report()
    assert.equal(after.groupCount, 1)
    assert.deepEqual(after.groups.map((group) => group.size), [GROUP_SMALL.length])
    assert.deepEqual(after.groups[0].nodes.map((node) => node.name).sort(), ['a.txt', 'b.txt', 'c.txt'])
  })

  it('caps the report at 100 groups', async () => {
    const { duplicateGroups } = await import('../src/routes/misc.js')
    const me = await api('GET', '/api/v1/me', auth())
    const all = duplicateGroups(me.json.user.id, { limit: 0 })
    const capped = duplicateGroups(me.json.user.id)
    assert.ok(all.length >= 1)
    assert.ok(capped.length <= 100)
    assert.deepEqual(capped.map((group) => group.hash), all.slice(0, 100).map((group) => group.hash))
  })

  it('requires a session', async () => {
    const response = await api('GET', '/api/v1/storage/duplicates')
    assert.equal(response.status, 401)
    assert.equal(response.json.error.code, 'UNAUTHENTICATED')
  })

  it('answers an empty report for a drive without duplicates', async () => {
    const fresh = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'duplicates password' } })
    const response = await api('GET', '/api/v1/storage/duplicates', { token: fresh.json.token })
    assert.equal(response.status, 200, response.text)
    assert.deepEqual(response.json, { groups: [], totalWastedBytes: 0, groupCount: 0 })
  })
})
