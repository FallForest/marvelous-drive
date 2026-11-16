import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'node:test'
import { installFakeDom, keyEvent } from './fake-dom.js'
import { buildIndex } from '../lib/state.js'
import { renderSidebar } from '../lib/sidebar.js'

/**
 * UI15 — the folder tree answers the arrow keys.
 *
 * The rows were role="treeitem" with a caret only a mouse could hit, so a
 * keyboard user could open a folder but never explore one. Everything below goes
 * through renderSidebar() and the real keydown handler: expanding triggers
 * ctx.onToggleFolder → runtime.renderShell, which re-renders the whole tree, so
 * "does focus survive a re-render" is the assertion that matters.
 */

let dom

const NODES = [
  { id: 'a', kind: 'folder', name: 'A', parentId: null },
  { id: 'a1', kind: 'folder', name: 'A1', parentId: 'a' },
  { id: 'a11', kind: 'folder', name: 'A11', parentId: 'a1' },
  { id: 'a2', kind: 'folder', name: 'A2', parentId: 'a' },
  { id: 'b', kind: 'folder', name: 'B', parentId: null },
  { id: 'leaf', kind: 'folder', name: '无子', parentId: null },
  { id: 'f1', kind: 'file', name: 'x.txt', parentId: null },
]

function makeState(expanded) {
  return {
    expanded,
    route: { name: 'drive', folderId: null },
    stats: null,
    user: null,
    sortKey: 'name',
    sortDir: 'asc',
    view: 'list',
  }
}

/** Mounts the sidebar for one state; returns the ctx it was given. */
function mountTree(options) {
  const opts = options || {}
  const state = makeState(opts.expanded || new Set())
  const navigated = []
  const toggled = []
  const ctx = {
    state,
    index: buildIndex(NODES),
    navigate: (path) => navigated.push(path),
    onToggleFolder: (folderId) => {
      toggled.push(folderId)
      if (state.expanded.has(folderId)) state.expanded.delete(folderId)
      else state.expanded.add(folderId)
      // A real toggle re-renders the entire shell, which detaches every row.
      rerender()
    },
    onNewFolder: () => {},
    onSearchInput: () => {},
    onSearchCommit: () => {},
    onSearchClear: () => {},
    onUserMenu: () => {},
    onSort: () => {},
    onSortDirection: () => {},
    onViewChange: () => {},
    onUploadClick: () => {},
  };
  function rerender() {
    const host = dom.document.querySelector('.sidebar-host')
    host.childNodes = []
    host.appendChild(renderSidebar(ctx))
    return ctx
  }
  const host = dom.document.createElement('div')
  host.className = 'sidebar-host'
  dom.body.appendChild(host)
  host.appendChild(renderSidebar(ctx))
  return { ctx, navigated, toggled, rerender }
}

const row = (id) => dom.document.querySelector('.tree [data-folder-id="' + id + '"]')
const press = (id, key, options) => {
  const target = row(id)
  const event = keyEvent(key, Object.assign({ target }, options || {}))
  // The handler lives on the container, and so does the real event's bubble path.
  target.closest('[role="tree"]').emit('keydown', event)
  return event
}

beforeEach(() => {
  dom = installFakeDom()
})

describe('folder tree structure', () => {
  it('marks every row with its level and exactly one tab stop', () => {
    mountTree({ expanded: new Set(['a']) })
    assert.equal(dom.document.querySelector('.tree').getAttribute('role'), 'tree')
    assert.equal(row('a').getAttribute('aria-level'), '1')
    assert.equal(row('a1').getAttribute('aria-level'), '2')
    const stops = dom.document.querySelectorAll('[role="treeitem"][tabindex="0"]')
    assert.equal(stops.length, 1)
    assert.equal(stops[0].getAttribute('data-folder-id'), 'a')
    assert.ok(dom.document.querySelector('.tree [role="group"]'), 'children still live in a group')
  })

  it('keeps only folders in the tree', () => {
    mountTree()
    assert.equal(row('f1'), null)
  })
})

describe('folder tree keyboard', () => {
  it('walks the visible rows with ArrowDown/ArrowUp and stops at the ends', () => {
    mountTree({ expanded: new Set(['a']) })
    row('a').focus()
    press('a', 'ArrowDown')
    assert.equal(dom.document.activeElement, row('a1'))
    press('a1', 'ArrowDown')
    assert.equal(dom.document.activeElement, row('a2'))
    press('a2', 'ArrowUp')
    assert.equal(dom.document.activeElement, row('a1'))
    // First row: stays put instead of wrapping into the settings above it.
    press('a', 'ArrowUp')
    assert.equal(dom.document.activeElement, row('a'))
  })

  it('jumps to the first and last visible row with Home/End', () => {
    mountTree({ expanded: new Set(['a']) })
    row('a1').focus()
    press('a1', 'End')
    assert.equal(dom.document.activeElement, row('leaf'))
    press('leaf', 'Home')
    assert.equal(dom.document.activeElement, row('a'))
  })

  it('expands on ArrowRight and keeps focus on the folder it expanded', () => {
    const { toggled } = mountTree()
    row('a').focus()
    const event = press('a', 'ArrowRight')
    assert.equal(event.defaultPrevented, true)
    assert.deepEqual(toggled, ['a'])
    // The tree was re-rendered; focus has to be re-found by data-folder-id.
    assert.equal(dom.document.activeElement, row('a'))
    assert.equal(row('a').getAttribute('aria-expanded'), 'true')
  })

  it('does nothing on ArrowRight for a folder without children', () => {
    mountTree()
    row('leaf').focus()
    const event = press('leaf', 'ArrowRight')
    assert.equal(event.defaultPrevented, false)
    assert.equal(dom.document.activeElement, row('leaf'))
  })

  it('steps into the first child on ArrowRight when already expanded', () => {
    mountTree({ expanded: new Set(['a']) })
    row('a').focus()
    press('a', 'ArrowRight')
    assert.equal(dom.document.activeElement, row('a1'))
  })

  it('collapses on ArrowLeft and keeps focus on the folder', () => {
    mountTree({ expanded: new Set(['a']) })
    row('a').focus()
    press('a', 'ArrowLeft')
    assert.equal(dom.document.activeElement, row('a'))
    assert.equal(row('a').getAttribute('aria-expanded'), 'false')
    assert.equal(row('a1'), null, 'the children are gone')
  })

  it('climbs to the parent row on ArrowLeft when already collapsed', () => {
    mountTree({ expanded: new Set(['a', 'a1']) })
    row('a2').focus()
    press('a2', 'ArrowLeft')
    assert.equal(dom.document.activeElement, row('a'))
  })

  it('opens the folder on Enter and on Space', () => {
    const { navigated } = mountTree()
    row('a').focus()
    press('a', 'Enter')
    press('a', ' ')
    assert.deepEqual(navigated, ['/folder/a', '/folder/a'])
  })

  it('moves the tab stop with the caret so Tab leaves the tree', () => {
    mountTree({ expanded: new Set(['a']) })
    row('a').focus()
    press('a', 'ArrowDown')
    const stops = dom.document.querySelectorAll('[role="treeitem"][tabindex="0"]')
    assert.equal(stops.length, 1)
    assert.equal(stops[0].getAttribute('data-folder-id'), 'a1')
  })

  it('restores the tab stop to the last row after a re-render', () => {
    const { ctx } = mountTree({ expanded: new Set(['a']) })
    row('a2').focus()
    ctx.onToggleFolder('a')
    const stops = dom.document.querySelectorAll('[role="treeitem"][tabindex="0"]')
    assert.equal(stops.length, 1)
  })
})
