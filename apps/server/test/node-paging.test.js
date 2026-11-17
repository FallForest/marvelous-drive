import assert from 'node:assert/strict'
import { after, before, it } from 'node:test'
import { startServer, uniqueEmail } from './helpers.js'

let app, api, owner, outsider, folder, file
before(async () => {
  app = await startServer()
  api = app.client
  const register = async () => (await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'paging password' } })).json
  owner = await register()
  outsider = await register()
  const make = async (name, kind = 'file', parentId = null) => {
    const response = await api('POST', '/api/v1/nodes', { token: owner.token, body: { name, kind, parentId } })
    assert.equal(response.status, 201, response.text)
    return response.json.node
  }
  folder = await make('paging', 'folder')
  await make('z-subfolder', 'folder', folder.id)
  for (let i = 0; i < 7; i++) file = await make('file-' + i, 'file', folder.id)
  await make('elsewhere')
})
after(async () => { await app.close(); app.cleanup() })
const get = (query, token = owner.token) => api('GET', '/api/v1/nodes?' + query, { token })

it('bounds pages in the requested directory and exposes a truthful continuation', async () => {
  const first = await get('parentId=' + folder.id + '&limit=3')
  assert.equal(first.status, 200, first.text)
  assert.equal(first.json.nodes.length, 3)
  assert.equal(first.json.limit, 3)
  assert.equal(first.json.offset, 0)
  assert.equal(first.json.hasMore, true)
  assert.equal(first.json.nodes[0].kind, 'folder')
  const second = await get('parentId=' + folder.id + '&limit=3&offset=3')
  const third = await get('parentId=' + folder.id + '&limit=3&offset=6')
  const rows = [...first.json.nodes, ...second.json.nodes, ...third.json.nodes]
  assert.equal(new Set(rows.map((node) => node.id)).size, 8)
  assert.equal(third.json.hasMore, false)
  assert.ok(rows.every((node) => node.parentId === folder.id))
})

it('keeps the legacy unpaged listing available to CLI and directory upload checks', async () => {
  const all = await get('parentId=' + folder.id)
  assert.equal(all.json.nodes.length, 8)
  assert.equal(Object.hasOwn(all.json, 'hasMore'), false)
  const folders = await get('kind=folder')
  assert.ok(folders.json.nodes.every((node) => node.kind === 'folder'))
})

it('sorts globally before paging and leaves folders first when reversing files', async () => {
  const pages = []
  for (const offset of [0, 3, 6]) {
    const response = await get('parentId=' + folder.id + '&limit=3&offset=' + offset + '&direction=desc')
    pages.push(...response.json.nodes)
  }
  assert.equal(pages[0].kind, 'folder')
  assert.deepEqual(pages.slice(1).map((node) => node.name), ['file-6', 'file-5', 'file-4', 'file-3', 'file-2', 'file-1', 'file-0'])
})

it('rejects malformed paging and direction inputs', async () => {
  for (const query of ['limit=0', 'limit=-1', 'limit=501', 'limit=abc', 'limit=1.5', 'offset=-1', 'offset=NaN', 'offset=1.5', 'direction=sideways']) {
    const response = await get(query)
    assert.equal(response.status, 400, query + ': ' + response.text)
  }
})

it('authorizes a parent before enumerating children', async () => {
  const hidden = await get('parentId=' + folder.id + '&limit=3', outsider.token)
  assert.equal(hidden.status, 404)
  const wrongKind = await get('parentId=' + file.id + '&limit=3')
  assert.equal(wrongKind.status, 400)
  assert.equal(wrongKind.json.error.code, 'NOT_FOLDER')
})

it('pages shared folder children without weakening personal root scope', async () => {
  const { addMember } = await import('../src/workspaces.js')
  addMember(owner.user.workspace.id, outsider.user.id, 'member')
  const shared = await get('parentId=' + folder.id + '&limit=3', outsider.token)
  assert.equal(shared.status, 200, shared.text)
  assert.equal(shared.json.nodes.length, 3)
  const root = await get('parentId=root&limit=3', outsider.token)
  assert.deepEqual(root.json.nodes, [])
})

it('reports an empty last page without inventing more records', async () => {
  const response = await get('parentId=' + folder.id + '&limit=3&offset=100')
  assert.deepEqual(response.json.nodes, [])
  assert.equal(response.json.hasMore, false)
})
