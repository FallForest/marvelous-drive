import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createRouteData, nodePagePath, mergeNavigationNodes } from '../lib/route-data.js'

const folder = { id: 'folder', name: 'folder', kind: 'folder', parentId: null }
const file = { id: 'file', kind: 'file', parentId: 'folder' }
function harness() {
  const calls = []
  let clock = 0
  const api = { async get(path) {
    calls.push(path)
    if (path === '/nodes?kind=folder') return { nodes: [folder] }
    if (path === '/storage/stats') return { stats: { bytes: 30 } }
    if (path === '/nodes/shared') return { node: { id: 'shared', name: 'shared', kind: 'folder', parentId: 'ancestor', path: [{ id: 'ancestor', name: 'ancestor', kind: 'folder' }] } }
    if (path.startsWith('/search?')) return { results: [file], hasMore: false }
    const query = new URLSearchParams(path.split('?')[1])
    const offset = Number(query.get('offset'))
    return { nodes: [{ ...file, id: 'file-' + offset }], offset, limit: 100, hasMore: offset < 100 }
  } }
  return { calls, loader: createRouteData(api, () => clock), advance: () => { clock += 30_001 } }
}

it('loads only the current directory and reuses folder/stat metadata across navigation', async () => {
  const { calls, loader } = harness()
  await loader.load({ name: 'drive', folderId: null })
  await loader.load({ name: 'drive', folderId: 'folder' })
  const pages = calls.filter((path) => path.includes('limit='))
  assert.equal(pages.length, 2)
  assert.equal(new URLSearchParams(pages[0].split('?')[1]).get('parentId'), 'root')
  assert.equal(new URLSearchParams(pages[1].split('?')[1]).get('parentId'), 'folder')
  assert.equal(calls.filter((path) => path === '/nodes?kind=folder').length, 1)
  assert.equal(calls.filter((path) => path === '/storage/stats').length, 1)
  assert.ok(calls.every((path) => path !== '/nodes' && !path.includes('trash=')))
})

it('requests trash only on its route and invalidates shared metadata after a mutation refresh', async () => {
  const { calls, loader } = harness()
  await loader.load({ name: 'drive', folderId: null })
  await loader.load({ name: 'trash' }, { force: true })
  assert.equal(calls.filter((path) => path.includes('trash=1')).length, 1)
  assert.equal(calls.filter((path) => path === '/storage/stats').length, 2)
  assert.equal(calls.filter((path) => path === '/nodes?kind=folder').length, 2)
})

it('expires metadata and does not share it with a later signed-in session', async () => {
  const { calls, loader, advance } = harness()
  const route = { name: 'drive', folderId: null }
  await loader.load(route)
  advance()
  await loader.load(route)
  loader.clear()
  await loader.load(route)
  assert.equal(calls.filter((path) => path === '/storage/stats').length, 3)
})

it('loads another page with the same scope/sort and preserves previously explored pages on refresh', async () => {
  const { calls, loader } = harness()
  const route = { name: 'drive', folderId: 'folder' }
  await loader.page(route, { offset: 100, sortKey: 'size', sortDir: 'desc' })
  const query = new URLSearchParams(calls[0].split('?')[1])
  assert.equal(query.get('offset'), '100')
  assert.equal(query.get('sort'), 'size')
  assert.equal(query.get('direction'), 'desc')
  const refreshed = await loader.load(route, { count: 200, force: true })
  assert.deepEqual(refreshed.payload.nodes.map((node) => node.id), ['file-0', 'file-100'])
  assert.equal(refreshed.payload.hasMore, false)
})

it('fetches only breadcrumb metadata for a deep link outside the personal folder tree', async () => {
  const { calls, loader } = harness()
  const result = await loader.load({ name: 'drive', folderId: 'shared' })
  assert.equal(calls.filter((path) => path === '/nodes/shared').length, 1)
  assert.equal(result.folders.find((node) => node.id === 'shared').parentId, 'ancestor')
  assert.equal(result.folders.find((node) => node.id === 'ancestor').parentId, null)
})

it('does not fetch live files as a side effect of content search', async () => {
  const { calls, loader } = harness()
  const result = await loader.load({ name: 'search', query: 'needle' })
  assert.deepEqual(result.payload.results, [file])
  assert.ok(calls.every((path) => path === '/nodes?kind=folder' || path === '/storage/stats' || path.startsWith('/search?')))
})

it('merges metadata without duplicating a visible folder or losing a newer row', () => {
  assert.deepEqual(mergeNavigationNodes([folder], [{ ...folder, name: 'renamed' }, file]), [{ ...folder, name: 'renamed' }, file])
  const starred = new URLSearchParams(nodePagePath({ name: 'starred' }).split('?')[1])
  assert.equal(starred.get('starred'), '1')
  assert.equal(starred.has('parentId'), false)
})
