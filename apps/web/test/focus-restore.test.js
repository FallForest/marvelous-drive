import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'node:test'
import { installFakeDom } from './fake-dom.js'
import { h } from '../lib/dom.js'
import { captureFocusAddress, restoreFocusAddress } from '../lib/focus.js'

/**
 * Focus across a re-render.
 *
 * refreshData() replaces the rows the user is standing on. The element cannot be
 * reused, so what is restored is the semantic address: the row, and the control
 * inside it. These cases pin the addresses that must survive (and the ones that
 * must not be guessed at).
 */

let dom

beforeEach(() => {
  dom = installFakeDom()
})

/** A grid card shaped like the real one: a pick box, a star, a more button. */
function makeCard(id, starLabel = '加星标') {
  const card = h('div', { class: 'gcard', attrs: { 'data-id': id, tabindex: '0' } })
  card.appendChild(h('input', { class: 'pick', attrs: { type: 'checkbox', 'aria-label': '选择' } }))
  const actions = h('div', { class: 'gactions' })
  actions.appendChild(h('button', { attrs: { 'aria-label': starLabel } }))
  actions.appendChild(h('button', { attrs: { 'aria-label': '更多操作' } }))
  card.appendChild(actions)
  dom.body.appendChild(card)
  return card
}

describe('captureFocusAddress', () => {
  it('records the row and the control by its stable label', () => {
    const card = makeCard('node-1')
    const star = card.querySelectorAll('.gactions button')[0]
    star.focus()
    assert.deepEqual(captureFocusAddress(dom.body), { rowId: 'node-1', control: { kind: 'label', value: '加星标' } })
  })

  it('returns null when the caret is not in the observed root', () => {
    makeCard('node-1')
    dom.body.appendChild(h('button', { attrs: { 'aria-label': '外面' } }))
    const outside = h('button', { attrs: { 'aria-label': '外部' } })
    dom.body.appendChild(outside)
    outside.focus()
    const otherRoot = h('div', {})
    dom.body.appendChild(otherRoot)
    assert.equal(captureFocusAddress(otherRoot), null)
  })

  it('returns null for <body>, text fields and focus inside an open overlay', () => {
    const card = makeCard('node-1')
    assert.equal(captureFocusAddress(dom.body), null, 'nothing focused yet')

    const input = h('input', { attrs: { 'aria-label': '重命名' } })
    card.appendChild(input)
    input.focus()
    assert.equal(captureFocusAddress(dom.body), null, 'a text field has its own rules')

    const dialog = h('div', { attrs: { role: 'dialog' } })
    dialog.appendChild(h('button', { attrs: { 'aria-label': '确认' } }))
    dom.body.appendChild(dialog)
    dialog.querySelector('button').focus()
    assert.equal(captureFocusAddress(dom.body), null, 'an overlay outlives the refresh')
  })
})

describe('restoreFocusAddress', () => {
  it('finds the same control again after a re-render', () => {
    const before = makeCard('node-1')
    before.querySelectorAll('.gactions button')[1].focus()
    const address = captureFocusAddress(dom.body)

    // Simulate the re-render: replace the whole card with an equivalent one.
    before.remove()
    const after = makeCard('node-1')

    assert.equal(restoreFocusAddress(dom.body, address), true)
    assert.equal(dom.document.activeElement, after.querySelectorAll('.gactions button')[1])
  })

  it('falls back to the same slot when the control changed identity', () => {
    // The exact bug: 加星标 becomes 取消星标, so a label lookup finds nothing. The
    // user must keep their place in the row instead of being dropped to <body>.
    const before = makeCard('node-1')
    before.querySelectorAll('.gactions button')[0].focus()
    const address = captureFocusAddress(dom.body)

    before.remove()
    const after = makeCard('node-1', '取消星标')

    assert.equal(restoreFocusAddress(dom.body, address), true)
    assert.equal(dom.document.activeElement, after.querySelectorAll('.gactions button')[0])
  })

  it('never guesses a different row', () => {
    const before = makeCard('node-1')
    before.querySelectorAll('.gactions button')[0].focus()
    const address = captureFocusAddress(dom.body)

    before.remove()
    makeCard('node-2')

    assert.equal(restoreFocusAddress(dom.body, address), false, 'the row is gone; the caret stays put')
    assert.notEqual(dom.document.activeElement && dom.document.activeElement.tagName, 'BODY')
  })

  it('focuses the row itself when it had no control inside', () => {
    const row = h('div', { class: 'frow', attrs: { 'data-id': 'node-9', tabindex: '0' } })
    dom.body.appendChild(row)
    row.focus()
    const address = captureFocusAddress(dom.body)
    assert.deepEqual(address, { rowId: 'node-9', control: null })

    row.remove()
    const after = h('div', { class: 'frow', attrs: { 'data-id': 'node-9', tabindex: '0' } })
    dom.body.appendChild(after)
    assert.equal(restoreFocusAddress(dom.body, address), true)
    assert.equal(dom.document.activeElement, after)
  })
})
