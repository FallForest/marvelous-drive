import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'node:test'
import { installFakeDom } from './fake-dom.js'
import {
  TRASH_QUERY_MAX, isTrashFilterActive, trashDeletedWithin, trashFilterEmptyText, trashFilterPath, trashKind, trashQuery,
  renderTrashFilter as renderTrashFilterNow,
} from '../lib/trash-filter.js'
import { createRouteData, nodePagePath } from '../lib/route-data.js'
import { parseLocation, routePath, TRASH_DELETED_WITHIN } from '../lib/state.js'

/**
 * The recycle bin's filter controls and the two empty states around them.
 *
 * The filter is route state, so what matters here is the URL it produces (the
 * server applies it before paging), that the page request carries it on every
 * page, the labels a screen reader and a user see, and that "no match" never
 * borrows the "回收站是空的" copy.
 */

describe('trash page requests', () => {
  const harness = () => {
    const calls = []
    const api = { async get(path) {
      calls.push(path)
      if (path === '/nodes?kind=folder') return { nodes: [] }
      if (path === '/storage/stats') return { stats: { bytes: 0 } }
      const query = new URLSearchParams(path.split('?')[1])
      const offset = Number(query.get('offset'))
      return { nodes: [{ id: 'row-' + offset, kind: 'file', parentId: null }], offset, limit: 100, hasMore: offset < 100 }
    } }
    return { calls, loader: createRouteData(api) }
  }

  it('keeps the bare trash page request unfiltered', () => {
    const params = new URLSearchParams(nodePagePath({ name: 'trash' }).split('?')[1])
    assert.equal(params.get('trash'), '1')
    assert.equal(params.has('q'), false)
    assert.equal(params.has('kind'), false)
  })

  it('carries q and kind on every page, including 继续加载', () => {
    const first = new URLSearchParams(nodePagePath({ name: 'trash', query: ' 报告 ', kind: 'file' }).split('?')[1])
    assert.equal(first.get('trash'), '1')
    assert.equal(first.get('q'), '报告')
    assert.equal(first.get('kind'), 'file')
    const later = new URLSearchParams(nodePagePath({ name: 'trash', query: '报告', kind: 'file' }, { offset: 100 }).split('?')[1])
    assert.equal(later.get('offset'), '100')
    assert.equal(later.get('q'), '报告', 'a later page stays on the same filtered set')
    assert.equal(later.get('kind'), 'file')
    // A kind the server does not filter is not forwarded.
    assert.equal(new URLSearchParams(nodePagePath({ name: 'trash', kind: 'image' }).split('?')[1]).has('kind'), false)
  })

  it('carries the deletion window on every page, including 继续加载', () => {
    const first = new URLSearchParams(nodePagePath({ name: 'trash', deletedWithin: '7d' }).split('?')[1])
    assert.equal(first.get('trash'), '1')
    assert.equal(first.get('deletedWithin'), '7d')
    const later = new URLSearchParams(nodePagePath({ name: 'trash', deletedWithin: '7d' }, { offset: 100 }).split('?')[1])
    assert.equal(later.get('offset'), '100')
    assert.equal(later.get('deletedWithin'), '7d', 'load-more must not fall back to the whole bin')
    // All three filters compose on the same page request.
    const combined = new URLSearchParams(nodePagePath({ name: 'trash', query: ' 报告 ', kind: 'folder', deletedWithin: '24h' }).split('?')[1])
    assert.equal(combined.get('q'), '报告')
    assert.equal(combined.get('kind'), 'folder')
    assert.equal(combined.get('deletedWithin'), '24h')
    // 全部时间 and stale values send nothing at all: the server never has to
    // decide what an unknown preset means.
    assert.equal(new URLSearchParams(nodePagePath({ name: 'trash', deletedWithin: '' }).split('?')[1]).has('deletedWithin'), false)
    assert.equal(new URLSearchParams(nodePagePath({ name: 'trash', deletedWithin: 'fortnight' }).split('?')[1]).has('deletedWithin'), false)
    assert.equal(new URLSearchParams(nodePagePath({ name: 'trash', query: 'x', deletedWithin: 'today' }).split('?')[1]).has('deletedWithin'), false)
  })

  it('asks the server for the filtered page instead of pruning loaded rows', async () => {
    const { calls, loader } = harness()
    const result = await loader.load({ name: 'trash', query: 'later-page-match', kind: 'folder' })
    const page = calls.find((path) => path.includes('trash=1'))
    const query = new URLSearchParams(page.split('?')[1])
    assert.equal(query.get('q'), 'later-page-match')
    assert.equal(query.get('kind'), 'folder')
    assert.equal(query.get('limit'), '100')
    assert.deepEqual(result.payload.nodes.map((node) => node.id), ['row-0'])
  })

  it('sends the window together with a name in the same first page request', async () => {
    const { calls, loader } = harness()
    await loader.load({ name: 'trash', query: '报告', kind: 'file', deletedWithin: '30d' })
    const page = calls.find((path) => path.includes('trash=1'))
    const query = new URLSearchParams(page.split('?')[1])
    assert.equal(query.get('deletedWithin'), '30d')
    assert.equal(query.get('q'), '报告')
    assert.equal(query.get('kind'), 'file')
    // Loading the next page reuses the route, so the window comes along.
    const next = new URLSearchParams(nodePagePath({ name: 'trash', query: '报告', kind: 'file', deletedWithin: '30d' }, { offset: 100 }).split('?')[1])
    assert.equal(next.get('deletedWithin'), '30d')
  })
})

describe('trash filter URL', () => {
  it('keeps bare /trash for no filter and canonicalizes the term', () => {
    assert.equal(trashFilterPath(), '/trash')
    assert.equal(trashFilterPath({ query: '   ', kind: '' }), '/trash')
    assert.equal(trashFilterPath({ query: ' 报告 ', kind: 'file' }), '/trash?q=' + encodeURIComponent('报告') + '&kind=file')
    assert.equal(trashFilterPath({ kind: 'image' }), '/trash', 'only file/folder are real kinds')
  })

  it('caps the term at the server limit so the URL and the query agree', () => {
    const long = 'x'.repeat(TRASH_QUERY_MAX + 50)
    const params = new URLSearchParams(trashFilterPath({ query: long }).split('?')[1])
    assert.equal(params.get('q').length, TRASH_QUERY_MAX)
    assert.equal(TRASH_QUERY_MAX, 100)
  })

  it('serializes the window into the URL and round-trips through the route', () => {
    assert.equal(trashFilterPath({ deletedWithin: '7d' }), '/trash?deletedWithin=7d')
    assert.equal(trashFilterPath({ query: '报告', kind: 'file', deletedWithin: '24h' }),
      '/trash?q=' + encodeURIComponent('报告') + '&kind=file&deletedWithin=24h')
    assert.equal(trashFilterPath({ deletedWithin: '' }), '/trash', '全部时间 is bare /trash')
    assert.equal(trashFilterPath({ deletedWithin: 'today' }), '/trash', 'only the closed vocabulary reaches a URL')

    // The URL the form produces is the URL the shell parses back: no field is
    // dropped between navigate(), history and the next load.
    for (const route of [
      { name: 'trash', deletedWithin: '24h' },
      { name: 'trash', query: '报告', deletedWithin: '7d' },
      { name: 'trash', kind: 'folder', deletedWithin: '30d' },
      { name: 'trash', query: 'a b', kind: 'file', deletedWithin: '30d' },
    ]) {
      const path = routePath(route)
      const reparsed = parseLocation({ pathname: path.split('?')[0], search: '?' + (path.split('?')[1] || '') })
      assert.deepEqual(reparsed, route, path)
    }
    // A bare /trash keeps its old one-key shape; an unknown preset is dropped
    // instead of being carried into the next request.
    assert.deepEqual(parseLocation({ pathname: '/trash', search: '' }), { name: 'trash' })
    assert.deepEqual(parseLocation({ pathname: '/trash', search: '?deletedWithin=week' }), { name: 'trash' })
    assert.deepEqual(TRASH_DELETED_WITHIN, ['24h', '7d', '30d'])
  })

  it('reads the route fields the shell parses', () => {
    const route = { name: 'trash', query: '  Alpha ', kind: 'folder' }
    assert.equal(trashQuery(route), 'Alpha')
    assert.equal(trashKind(route), 'folder')
    assert.equal(isTrashFilterActive(route), true)
    assert.equal(isTrashFilterActive({ name: 'trash' }), false)
    assert.equal(isTrashFilterActive({ name: 'trash', query: '   ' }), false)
    assert.equal(trashKind({ name: 'trash', kind: 'image' }), '')
    // The window alone is a filter: it must show the clear button and name the
    // failed time in the empty state.
    assert.equal(isTrashFilterActive({ name: 'trash', deletedWithin: '7d' }), true)
    assert.equal(trashDeletedWithin({ name: 'trash', deletedWithin: '7d' }), '7d')
    assert.equal(trashDeletedWithin({ name: 'trash', deletedWithin: 'week' }), '')
    assert.equal(trashDeletedWithin({ name: 'trash' }), '')
  })

  it('names the failed filter instead of claiming the bin is empty', () => {
    const text = trashFilterEmptyText({ name: 'trash', query: '报告', kind: 'file' })
    assert.match(text, /报告/)
    assert.match(text, /文件/)
    assert.doesNotMatch(text, /空的/)
    const kindOnly = trashFilterEmptyText({ name: 'trash', kind: 'folder' })
    assert.match(kindOnly, /文件夹/)
    // A time filter that finds nothing has to say so, or the empty list reads as
    // "nothing was ever deleted".
    const timeOnly = trashFilterEmptyText({ name: 'trash', deletedWithin: '24h' })
    assert.match(timeOnly, /最近 24 小时/)
    assert.match(timeOnly, /回收站项目/)
    assert.doesNotMatch(timeOnly, /空的/)
    const timeAndKind = trashFilterEmptyText({ name: 'trash', kind: 'file', deletedWithin: '30d' })
    assert.match(timeAndKind, /最近 30 天/)
    assert.match(timeAndKind, /文件/)
  })
})

describe('trash filter form', () => {
  beforeEach(() => { installFakeDom() })

  const render = async (route, navigate = () => {}) => {
    const { renderTrashFilter } = await import('../lib/trash-filter.js')
    return renderTrashFilter({ state: { route }, navigate })
  }

  /**
   * A filter change re-renders the form, so the control the user was standing on
   * is replaced. This mounts a fresh render in the document (the fake DOM's
   * isConnected check is what focus() honours) and returns the element the caret
   * landed on after the microtask that restores it. renderTrashFilter itself is
   * imported statically here: the caret restore runs in a microtask, and an
   * `await import()` would flush it before the new form was mounted.
   */
  const refocus = (routeAfter, source) => {
    const { document } = globalThis
    const seen = []
    const first = renderTrashFilterNow({ state: { route: { name: 'trash' } }, navigate: (path) => seen.push(path) })
    document.body.appendChild(first)
    const sourceControl = first.querySelector('[name="' + source + '"]')
    sourceControl.focus()
    assert.equal(document.activeElement, sourceControl, 'the test starts with the caret in the control')
    if (source === 'deletedWithin') {
      sourceControl.value = '7d'
      sourceControl.emit('change', {})
    } else if (source === 'kind') {
      sourceControl.value = 'file'
      sourceControl.emit('change', {})
    } else {
      first.emit('submit', { preventDefault() {} })
    }
    // The shell mounts the new form synchronously inside navigate(), before the
    // microtask the filter scheduled runs; emulate exactly that ordering.
    const second = renderTrashFilterNow({ state: { route: routeAfter }, navigate: () => {} })
    document.body.appendChild(second)
    first.remove()
    return { document, form: second, seen }
  }

  it('puts the caret back on the control that filtered after the form is rebuilt', async () => {
    const active = refocus({ name: 'trash', deletedWithin: '7d' }, 'deletedWithin')
    await Promise.resolve()
    assert.equal(active.document.activeElement, active.form.querySelector('[name="deletedWithin"]'),
      'the arrow-keyed select survives the re-render as the caret target')
    const byKind = refocus({ name: 'trash', kind: 'file' }, 'kind')
    await Promise.resolve()
    assert.equal(byKind.document.activeElement, byKind.form.querySelector('[name="kind"]'))
    // A submit returns to the search box the user typed in.
    const bySubmit = refocus({ name: 'trash' }, 'q')
    await Promise.resolve()
    assert.equal(bySubmit.document.activeElement, bySubmit.form.querySelector('[name="q"]'))
  })

  it('waits out the loading skeleton and never steals the caret later', async () => {
    // A navigation paints a skeleton first; the real form arrives with the
    // response. The intent has to survive that render without consuming it.
    const { document } = globalThis
    const first = renderTrashFilterNow({ state: { route: { name: 'trash' } }, navigate: () => {} })
    document.body.appendChild(first)
    first.querySelector('[name="deletedWithin"]').focus()
    first.querySelector('[name="deletedWithin"]').value = '30d'
    first.querySelector('[name="deletedWithin"]').emit('change', {})
    // mount() replaces the view: the old form leaves the document, which is
    // exactly why the caret has nowhere to be until the response paints. A real
    // browser drops focus to <body> when the focused node is removed; the fake
    // DOM keeps pointing at it, so the blur is explicit here.
    first.querySelector('[name="deletedWithin"]').blur()
    first.remove()
    const skeleton = globalThis.document.createElement('div')
    document.body.appendChild(skeleton)
    await Promise.resolve()
    assert.equal(document.activeElement, document.body, 'the skeleton is not a caret target')

    const second = renderTrashFilterNow({ state: { route: { name: 'trash', deletedWithin: '30d' } }, navigate: () => {} })
    document.body.appendChild(second)
    await Promise.resolve()
    assert.equal(document.activeElement, second.querySelector('[name="deletedWithin"]'),
      'the caret lands on the control once the real form is mounted')

    // A caret the user moved somewhere deliberate is respected, not overridden:
    // the second filter change above consumed the intent, so this render — the
    // same route, a different window — must not pull the caret again.
    const elsewhere = renderTrashFilterNow({ state: { route: { name: 'trash', deletedWithin: '24h' } }, navigate: () => {} })
    document.body.appendChild(elsewhere)
    await Promise.resolve()
    assert.notEqual(document.activeElement, elsewhere.querySelector('[name="deletedWithin"]'),
      'no stray re-focus after the intent was consumed')
  })

  it('renders a labelled search field and a native type select', async () => {
    const form = await render({ name: 'trash' })
    const input = form.querySelector('input[name="q"]')
    assert.ok(input, 'the search field exists')
    assert.equal(input.getAttribute('type'), 'search')
    assert.equal(input.getAttribute('maxlength'), String(TRASH_QUERY_MAX))
    assert.equal(input.getAttribute('aria-label'), '搜索回收站中的名称')
    assert.ok(form.textContent.includes('搜索名称'), 'the field has a visible label')

    const select = form.querySelector('select[name="kind"]')
    assert.ok(select, 'a native accessible select, not a custom menu')
    assert.equal(select.getAttribute('aria-label'), '按类型筛选回收站')
    assert.deepEqual(select.children.map((option) => option.textContent), ['全部类型', '文件', '文件夹'])
    assert.deepEqual(select.children.map((option) => option.getAttribute('value')), ['', 'file', 'folder'])
    assert.ok(form.textContent.includes('搜索'), 'there is a submit button')
  })

  it('offers the deletion window as a labelled native select with 全部时间 first', async () => {
    const form = await render({ name: 'trash' })
    const select = form.querySelector('select[name="deletedWithin"]')
    assert.ok(select, 'the window is a native accessible select')
    assert.equal(select.getAttribute('aria-label'), '按删除时间筛选回收站')
    assert.deepEqual(select.children.map((option) => option.textContent), ['全部时间', '最近 24 小时', '最近 7 天', '最近 30 天'])
    assert.deepEqual(select.children.map((option) => option.getAttribute('value')), ['', '24h', '7d', '30d'])
    // 全部时间 is the default selection, so the control reads as a filter at rest.
    assert.equal(select.value, '')
    assert.ok(form.textContent.includes('删除时间'), 'the control has a visible label, not only an aria-label')
    // The type select is untouched by the new field.
    assert.equal(form.querySelector('select[name="kind"]').value, '')
    // No explanation at rest: it appears only when a rolling window is in effect.
    assert.ok(!form.textContent.includes('不按自然日'))
  })

  it('explains only while a window is in effect that the window is rolling', async () => {
    const idle = await render({ name: 'trash' })
    assert.ok(!idle.textContent.includes('不按自然日'), 'a resting filter needs no footnote')
    const active = await render({ name: 'trash', deletedWithin: '7d' })
    const hint = active.querySelectorAll('.field-hint').find((element) => element.textContent.includes('不按自然日'))
    assert.ok(hint, 'the rolling-duration caveat is stated once')
    assert.match(hint.textContent, /从当前时刻向前计算/)
    // Name/type-only filtering stays quiet about time.
    const kindOnly = await render({ name: 'trash', kind: 'file' })
    assert.ok(!kindOnly.textContent.includes('不按自然日'))
  })

  it('reflects the route window, including a preset the route dropped', async () => {
    const active = await render({ name: 'trash', deletedWithin: '7d' })
    assert.equal(active.querySelector('select[name="deletedWithin"]').value, '7d')
    const stale = await render({ name: 'trash', deletedWithin: 'today' })
    assert.equal(stale.querySelector('select[name="deletedWithin"]').value, '', 'an unknown preset paints as 全部时间')
  })

  it('offers 清除筛选 only while a filter is active', async () => {
    const idle = await render({ name: 'trash' })
    assert.ok(!idle.textContent.includes('清除筛选'))

    const active = await render({ name: 'trash', query: 'alpha', kind: 'folder' })
    assert.ok(active.textContent.includes('清除筛选'))
    assert.equal(active.querySelector('input[name="q"]').value, 'alpha')
    assert.equal(active.querySelector('select[name="kind"]').value, 'folder')
    // A time-only filter counts as active too, and clearing it is offered.
    assert.ok((await render({ name: 'trash', deletedWithin: '30d' })).textContent.includes('清除筛选'))
  })

  it('submits the trimmed term and kind, and clearing returns to bare /trash', async () => {
    const seen = []
    const form = await render({ name: 'trash' }, (path) => seen.push(path))
    const input = form.querySelector('input[name="q"]')
    const select = form.querySelector('select[name="kind"]')
    input.value = '  Alpha Report  '
    select.value = 'file'
    form.emit('submit', { preventDefault() {} })
    assert.deepEqual(seen, ['/trash?q=Alpha+Report&kind=file'])

    const filtered = await render({ name: 'trash', query: 'alpha', kind: 'file' }, (path) => seen.push(path))
    const clear = filtered.querySelectorAll('button').find((button) => button.textContent === '清除筛选')
    assert.ok(clear)
    clear.emit('click', {})
    assert.equal(seen[seen.length - 1], '/trash')
  })

  it('applies a type choice without a second click and keeps the typed term', async () => {
    const seen = []
    const form = await render({ name: 'trash', query: 'alpha' }, (path) => seen.push(path))
    const select = form.querySelector('select[name="kind"]')
    select.value = 'folder'
    select.emit('change', {})
    assert.deepEqual(seen, ['/trash?q=alpha&kind=folder'])
  })

  it('applies a window change without a second click, keeping name and type', async () => {
    const seen = []
    const form = await render({ name: 'trash', query: '报告', kind: 'file' }, (path) => seen.push(path))
    const select = form.querySelector('select[name="deletedWithin"]')
    select.value = '7d'
    // The change event is the same one a keyboard pick fires; the handler reads
    // the controls, so no synthetic "was this a click" state is involved.
    select.emit('change', {})
    assert.deepEqual(seen, ['/trash?q=' + encodeURIComponent('报告') + '&kind=file&deletedWithin=7d'])
    // Choosing 全部时间 again drops the parameter and keeps the other filters.
    const back = await render({ name: 'trash', query: '报告', kind: 'file', deletedWithin: '7d' }, (path) => seen.push(path))
    const reset = back.querySelector('select[name="deletedWithin"]')
    reset.value = ''
    reset.emit('change', {})
    assert.equal(seen[seen.length - 1], '/trash?q=' + encodeURIComponent('报告') + '&kind=file')
  })

  it('clears every filter together, including the window', async () => {
    const seen = []
    const form = await render({ name: 'trash', query: '报告', kind: 'file', deletedWithin: '24h' }, (path) => seen.push(path))
    const clear = form.querySelectorAll('button').find((button) => button.textContent === '清除筛选')
    clear.emit('click', {})
    assert.deepEqual(seen, ['/trash'])
  })

  it('submits the window from the form, so Enter in the search field keeps it', async () => {
    const seen = []
    const form = await render({ name: 'trash', deletedWithin: '30d' }, (path) => seen.push(path))
    form.querySelector('input[name="q"]').value = 'alpha'
    form.emit('submit', { preventDefault() {} })
    assert.deepEqual(seen, ['/trash?q=alpha&deletedWithin=30d'])
  })
})

describe('trash empty states', () => {
  beforeEach(() => { installFakeDom() })

  const listFor = async (route) => {
    const { renderFileList } = await import('../lib/files.js')
    return renderFileList({
      state: {
        route, nodes: [], view: 'list', sortKey: 'name', sortDir: 'asc', selection: new Set(), stats: { trash: { retentionDays: 30 } },
      },
      index: { byId: new Map(), children: new Map() },
      navigate: () => {},
    })
  }

  it('tells a filtered no-match apart from a genuinely empty bin', async () => {
    const empty = await listFor({ name: 'trash' })
    assert.ok(empty.textContent.includes('回收站是空的'))
    assert.ok(!empty.textContent.includes('清除筛选'))

    const filtered = await listFor({ name: 'trash', query: '报告', kind: 'file' })
    assert.ok(filtered.textContent.includes('没有匹配的回收站项目'))
    assert.ok(filtered.textContent.includes('报告'))
    assert.ok(!filtered.textContent.includes('回收站是空的'), 'a filter never reads as an empty bin')
    const clear = filtered.querySelectorAll('button').find((button) => button.textContent === '清除筛选并显示全部')
    assert.ok(clear, 'the no-match state offers a way out')
  })

  it('makes a time-filtered no-match apparent instead of reading as an empty bin', async () => {
    const timed = await listFor({ name: 'trash', deletedWithin: '24h' })
    assert.ok(timed.textContent.includes('没有匹配的回收站项目'))
    assert.ok(timed.textContent.includes('最近 24 小时'), 'the empty state names the window')
    assert.ok(!timed.textContent.includes('回收站是空的'))
    // The way out is still on screen.
    assert.ok(timed.querySelectorAll('button').some((button) => button.textContent === '清除筛选并显示全部'))
    // The filter form is above the list, still showing the selected window, so
    // the user can change it in place rather than only by clearing everything.
    const combined = await listFor({ name: 'trash', query: '报告', deletedWithin: '30d' })
    assert.ok(combined.textContent.includes('最近 30 天'))
    assert.ok(combined.textContent.includes('报告'))
  })
})
