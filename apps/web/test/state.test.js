import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  parseLocation, routePath, buildIndex, ancestorPath, childrenOf, descendantIds,
  isDescendant, moveTargets, createStore,
} from '../lib/state.js'
import { nodePagePath, sharesPagePath } from '../lib/route-data.js'

/** Routing and the flat-tree index: the two things that silently break navigation. */

describe('parseLocation', () => {
  const at = (path, search = '') => parseLocation({ pathname: path, search })

  it('maps the drive root and a folder', () => {
    const root = at('/')
    assert.equal(root.name, 'drive')
    assert.equal(root.folderId, null)
    const folder = at('/folder/8a1d')
    assert.equal(folder.name, 'drive')
    assert.equal(folder.folderId, '8a1d')
  })

  it('maps trash, starred and search', () => {
    assert.equal(at('/trash').name, 'trash')
    assert.equal(at('/starred').name, 'starred')
    const search = at('/search', '?q=plan')
    assert.equal(search.name, 'search')
    assert.equal(search.query, 'plan')
  })

  it('maps a public share token and rejects a missing one', () => {
    const shared = at('/s/abc123')
    assert.equal(shared.name, 'shared')
    assert.equal(shared.token, 'abc123')
    assert.equal(at('/s/').name, 'notFound')
  })

  it('maps unknown paths to notFound', () => {
    assert.equal(at('/nope/deeper').name, 'notFound')
  })
})

describe('trash filters', () => {
  it('parses and rebuilds the trash filter as route.query', () => {
    const path = '/trash?q=Chinese%literal&kind=file'
    const parsed = parseLocation({ pathname: '/trash', search: '?q=Chinese%literal&kind=file' })
    assert.equal(parsed.name, 'trash')
    assert.equal(parsed.query, 'Chinese%literal')
    assert.equal(parsed.kind, 'file')
    assert.deepEqual(parseLocation({ pathname: '/trash', search: '' }), { name: 'trash' })
    const rebuilt = routePath(parsed)
    const reparsed = parseLocation({ pathname: rebuilt.split('?')[0], search: '?' + rebuilt.split('?')[1] })
    assert.deepEqual(reparsed, parsed)
    assert.equal(nodePagePath(parsed).includes('q=Chinese%25literal'), true)
    assert.equal(nodePagePath({ name: 'trash' }).includes('q='), false)
    assert.equal(nodePagePath({ name: 'trash' }).includes('deletedWithin'), false)
  })

  it('parses and rebuilds the deletion window, dropping values outside the vocabulary', () => {
    const parsed = parseLocation({ pathname: '/trash', search: '?deletedWithin=7d' })
    assert.deepEqual(parsed, { name: 'trash', deletedWithin: '7d' })
    assert.equal(routePath(parsed), '/trash?deletedWithin=7d')
    assert.deepEqual(parseLocation({ pathname: '/trash', search: '?q=报告&kind=file&deletedWithin=30d' }),
      { name: 'trash', query: '报告', kind: 'file', deletedWithin: '30d' })
    // 全部时间 has no parameter at all, and an unknown preset is not carried.
    assert.deepEqual(parseLocation({ pathname: '/trash', search: '?deletedWithin=' }), { name: 'trash' })
    assert.deepEqual(parseLocation({ pathname: '/trash', search: '?deletedWithin=this-week' }), { name: 'trash' })
    assert.equal(routePath({ name: 'trash', deletedWithin: '' }), '/trash')
    assert.equal(routePath({ name: 'trash', deletedWithin: 'this-week' }), '/trash')
    // The kind vocabulary is dropped the same way, so a URL this app builds is
    // one it accepts back unchanged.
    assert.equal(routePath({ name: 'trash', kind: 'image' }), '/trash')
  })
})

describe('shares filters', () => {
  it('parses and rebuilds /shares?q=&state= as route state', () => {
    const parsed = parseLocation({ pathname: '/shares', search: '?q=' + encodeURIComponent('季度 报告') + '&state=trashed' })
    assert.deepEqual(parsed, { name: 'shares', query: '季度 报告', state: 'trashed' })
    // The canonical URL parses back to the same route, so Back and reload keep
    // the filter (URLSearchParams chooses the space encoding, not this test).
    const rebuilt = routePath(parsed)
    assert.deepEqual(parseLocation({ pathname: rebuilt.split('?')[0], search: '?' + rebuilt.split('?')[1] }), parsed)
    assert.equal(new URLSearchParams(rebuilt.split('?')[1]).get('state'), 'trashed')
    // Bare /shares keeps its old one-key shape, and unknown values are dropped.
    assert.deepEqual(parseLocation({ pathname: '/shares', search: '' }), { name: 'shares' })
    assert.deepEqual(parseLocation({ pathname: '/shares', search: '?state=gone' }), { name: 'shares' })
    assert.equal(routePath({ name: 'shares', query: '   ', state: '' }), '/shares')
  })

  it('carries both filters on every page, including 继续加载', () => {
    const first = new URLSearchParams(sharesPagePath({ name: 'shares', query: ' 报告 ', state: 'expired' }).split('?')[1])
    assert.equal(first.get('q'), '报告')
    assert.equal(first.get('state'), 'expired')
    assert.equal(first.get('limit'), '50')
    assert.equal(first.get('offset'), '0')
    const later = new URLSearchParams(sharesPagePath({ name: 'shares', query: '报告', state: 'expired' }, { offset: 50 }).split('?')[1])
    assert.equal(later.get('offset'), '50')
    assert.equal(later.get('q'), '报告', 'a later page stays on the same filtered set')
    assert.equal(later.get('state'), 'expired')
    // A bare list asks the question it asked before the filters existed.
    const bare = new URLSearchParams(sharesPagePath({ name: 'shares' }).split('?')[1])
    assert.equal(bare.has('q'), false)
    assert.equal(bare.has('state'), false)
  })
})

describe('routePath', () => {
  it('builds a canonical path that parses back to the same route', () => {
    const cases = [
      { name: 'drive', folderId: null },
      { name: 'drive', folderId: 'abc' },
      { name: 'trash' },
      { name: 'starred' },
      { name: 'search', query: 'a b' },
      { name: 'shared', token: 'tok' },
    ]
    for (const route of cases) {
      const path = routePath(route)
      const parsed = parseLocation({ pathname: path.split('?')[0], search: path.includes('?') ? '?' + path.split('?')[1] : '' })
      assert.equal(parsed.name, route.name, path)
      if (route.folderId !== undefined) assert.equal(parsed.folderId, route.folderId, path)
    }
  })
})

describe('buildIndex', () => {
  const nodes = [
    { id: 'root-a', kind: 'folder', name: 'A', parentId: null },
    { id: 'child-a', kind: 'file', name: 'a.txt', parentId: 'root-a' },
    { id: 'root-b', kind: 'file', name: 'b.txt', parentId: null },
  ]

  it('indexes nodes by id and by parent, with root under "root"', () => {
    const index = buildIndex(nodes)
    assert.equal(index.byId.get('root-a').name, 'A')
    assert.deepEqual(childrenOf(index, null).map((node) => node.id).sort(), ['root-a', 'root-b'])
    assert.deepEqual(childrenOf(index, 'root-a').map((node) => node.id), ['child-a'])
  })

  it('tolerates an empty tree', () => {
    const index = buildIndex([])
    assert.equal(index.byId.size, 0)
    assert.deepEqual(childrenOf(index, null), [])
  })
})

describe('tree helpers', () => {
  const nodes = [
    { id: 'a', kind: 'folder', name: 'A', parentId: null },
    { id: 'b', kind: 'folder', name: 'B', parentId: 'a' },
    { id: 'c', kind: 'file', name: 'c.txt', parentId: 'b' },
    { id: 'd', kind: 'folder', name: 'D', parentId: null },
  ]

  it('walks ancestors from root to node', () => {
    const index = buildIndex(nodes)
    assert.deepEqual(ancestorPath(index, 'c').map((node) => node.name), ['A', 'B', 'c.txt'])
  })

  it('stops on a cycle instead of looping forever', () => {
    const cyclic = buildIndex([
      { id: 'x', kind: 'folder', name: 'X', parentId: 'y' },
      { id: 'y', kind: 'folder', name: 'Y', parentId: 'x' },
    ])
    assert.ok(ancestorPath(cyclic, 'x').length <= 64)
  })

  it('collects descendants recursively', () => {
    const index = buildIndex(nodes)
    assert.deepEqual([...descendantIds(index, 'a')].sort(), ['b', 'c'])
    assert.equal(isDescendant(index, 'c', 'a'), true)
    assert.equal(isDescendant(index, 'd', 'a'), false)
  })

  it('never offers the node itself or its descendants as a move target', () => {
    const index = buildIndex(nodes)
    const targets = moveTargets(index, index.byId.get('a')).map((node) => node.id)
    assert.ok(!targets.includes('a'))
    assert.ok(!targets.includes('b'))
    assert.ok(targets.includes('d'))
  })
})

describe('createStore', () => {
  it('notifies subscribers and allows silent patches', () => {
    const store = createStore()
    let calls = 0
    const unsubscribe = store.subscribe(() => { calls += 1 })
    store.set({ view: 'grid' })
    assert.equal(calls, 1)
    assert.equal(store.state.view, 'grid')
    store.set({ view: 'list' }, { silent: true })
    assert.equal(calls, 1)
    unsubscribe()
    store.set({ view: 'grid' })
    assert.equal(calls, 1)
  })

  it('survives a throwing subscriber', () => {
    const store = createStore()
    store.subscribe(() => { throw new Error('boom') })
    let reached = false
    store.subscribe(() => { reached = true })
    store.set({ view: 'grid' })
    assert.equal(reached, true)
  })
})
