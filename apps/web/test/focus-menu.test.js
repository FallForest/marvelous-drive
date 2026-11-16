import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'node:test'
import { installFakeDom, keyEvent } from './fake-dom.js'
import { h } from '../lib/dom.js'
import { openMenu } from '../lib/ui.js'
import {
  FOCUSABLE_SELECTOR, focusRouteContent, popupElements, popupFocusables, registerPopup, unregisterPopup,
} from '../lib/focus.js'

/**
 * UI11 — the caret never leaves the modal, even though the menu does.
 *
 * A menu is appended to <body>, so the dialog's trap cannot see it by subtree
 * alone. These cases run the real openMenu against the real trapFocus and assert
 * where focus ended up, which is the only thing a user can observe: choosing an
 * item and pressing Tab both used to leave document.activeElement on <body>.
 */

let dom

beforeEach(() => {
  dom = installFakeDom()
})

/** A dialog panel with the given number of buttons, already in the document. */
function makeDialog(buttons) {
  const panel = h('div', { class: 'dialog', attrs: { role: 'dialog', tabindex: '-1' } })
  for (let index = 0; index < buttons; index += 1) panel.appendChild(h('button', { text: 'b' + index }))
  dom.body.appendChild(panel)
  return panel
}

describe('popup registry', () => {
  it('lists only popups that are still in the document', () => {
    const live = h('div', { class: 'menu' })
    const gone = h('div', { class: 'menu' })
    dom.body.appendChild(live)
    registerPopup(live)
    registerPopup(gone)
    assert.deepEqual(popupElements(), [live])
    unregisterPopup(live)
    unregisterPopup(gone)
    assert.deepEqual(popupElements(), [])
  })

  it('skips hidden and unlaid-out items, exactly like the container filter', () => {
    const menu = h('div', { class: 'menu' },
      h('button', { attrs: { type: 'button' } }),
      h('button', { attrs: { type: 'button', hidden: 'hidden' } }),
      h('button', { attrs: { type: 'button' } }))
    dom.body.appendChild(menu)
    menu.children[2].offsetParent = null
    registerPopup(menu)
    assert.deepEqual(popupFocusables(FOCUSABLE_SELECTOR), [menu.children[0]])
    unregisterPopup(menu)
  })
})

describe('trapFocus with a registered popup', () => {
  it('cycles through the dialog and its menu as one set', async () => {
    const { trapFocus } = await import('../lib/dom.js')
    const panel = makeDialog(2)
    const menu = h('div', { class: 'menu', attrs: { role: 'menu' } },
      h('button', { class: 'menu-item' }), h('button', { class: 'menu-item' }))
    dom.body.appendChild(menu)
    registerPopup(menu)
    trapFocus(panel)

    const last = menu.children[1]
    last.focus()
    const event = keyEvent('Tab')
    panel.emit('keydown', event)
    // Wrapping to the dialog's first control is the fix: before it, Tab here
    // walked out of both surfaces and the browser put the caret on <body>.
    assert.equal(dom.document.activeElement, panel.children[0])
    assert.equal(event.defaultPrevented, true)

    unregisterPopup(menu)
  })

  it('goes backwards into the menu from the dialog, never onto <body>', async () => {
    const { trapFocus } = await import('../lib/dom.js')
    const panel = makeDialog(2)
    const menu = h('div', { class: 'menu' }, h('button', { class: 'menu-item' }))
    dom.body.appendChild(menu)
    registerPopup(menu)
    trapFocus(panel)

    panel.children[0].focus()
    const event = keyEvent('Tab', { shiftKey: true })
    panel.emit('keydown', event)
    assert.equal(dom.document.activeElement, menu.children[0])
    unregisterPopup(menu)
  })
})

describe('openMenu focus lifecycle', () => {
  /** A dialog containing the anchor, which is where a select really lives. */
  function makeDialogWithAnchor() {
    const panel = makeDialog(1)
    const anchor = h('button', { class: 'select', attrs: { type: 'button', 'aria-expanded': 'false' } })
    panel.appendChild(anchor)
    return { panel, anchor }
  }

  it('moves focus onto the first item once the menu is in the document', () => {
    const { anchor } = makeDialogWithAnchor()
    const menu = openMenu({
      anchor,
      items: [{ label: '仅查看', checked: true }, { label: '可下载', checked: false }],
    })
    assert.equal(anchor.getAttribute('aria-expanded'), 'true')
    assert.equal(dom.document.activeElement, dom.document.querySelector('.menu-item'))
    menu.close()
  })

  it('returns the caret to the anchor after an item is chosen', () => {
    const { anchor } = makeDialogWithAnchor()
    let chosen = null
    const menu = openMenu({
      anchor,
      items: [{ label: '仅查看', checked: true, onSelect: () => { chosen = '仅查看' } }],
    })
    const item = dom.document.querySelector('.menu-item')
    item.focus()
    item.emit('click')
    assert.equal(chosen, '仅查看')
    // The clicked node was removed with the menu; without the restore the
    // browser had nowhere to put focus and left it on <body>.
    assert.equal(dom.document.activeElement, anchor)
    assert.equal(anchor.getAttribute('aria-expanded'), 'false')
    assert.equal(dom.document.querySelector('.menu'), null)
    menu.close()
  })

  it('closes on Tab and keeps the caret inside the dialog', () => {
    const { panel, anchor } = makeDialogWithAnchor()
    const menu = openMenu({ anchor, items: [{ label: 'A', checked: true }, { label: 'B', checked: false }] })
    const items = dom.document.querySelectorAll('.menu-item')
    items[items.length - 1].focus()
    const event = keyEvent('Tab', { target: items[items.length - 1] })
    dom.document.emit('keydown', event)

    assert.equal(event.defaultPrevented, true)
    assert.equal(dom.document.querySelector('.menu'), null, 'the menu is closed')
    const active = dom.document.activeElement
    assert.notEqual(active, dom.document.body)
    assert.ok(panel.contains(active), 'focus landed on a dialog control')
    assert.equal(active, panel.children[0])
    menu.close()
  })

  it('returns to the anchor on Escape', () => {
    const { anchor } = makeDialogWithAnchor()
    const menu = openMenu({ anchor, items: [{ label: 'A', checked: true }] })
    dom.document.emit('keydown', keyEvent('Escape'))
    assert.equal(dom.document.querySelector('.menu'), null)
    assert.equal(dom.document.activeElement, anchor)
    menu.close()
  })

  it('leaves the caret alone when the menu closes because the page was clicked', () => {
    const { anchor } = makeDialogWithAnchor()
    const elsewhere = h('button')
    dom.body.appendChild(elsewhere)
    const menu = openMenu({ anchor, items: [{ label: 'A', checked: true }] })
    elsewhere.focus()
    dom.document.emit('mousedown', { target: elsewhere })
    assert.equal(dom.document.querySelector('.menu'), null)
    assert.equal(dom.document.activeElement, elsewhere, 'the click target keeps focus')
    menu.close()
  })

  it('follows the anchor when the page scrolls instead of closing', () => {
    const { anchor } = makeDialogWithAnchor()
    const menu = openMenu({ anchor, items: [{ label: 'A', checked: true }] })
    assert.ok(dom.document.querySelector('.menu'))
    // The menu is positioned in viewport coordinates, so a scroll that keeps the
    // anchor on screen has to move it — not throw it away.
    anchor.rect = { left: 0, top: 100, right: 120, bottom: 124, width: 120, height: 24 }
    dom.window.listeners.get('scroll').forEach((handler) => handler({ type: 'scroll' }))
    assert.ok(dom.document.querySelector('.menu'), 'the menu survives a scroll')
    assert.equal(anchor.getAttribute('aria-expanded'), 'true')
    assert.equal(menu.el.style.top, '128px')
    menu.close()
  })

  it('closes once the anchor has scrolled out of the viewport', () => {
    const { anchor } = makeDialogWithAnchor()
    openMenu({ anchor, items: [{ label: 'A', checked: true }] })
    anchor.rect = { left: 0, top: -80, right: 120, bottom: -56, width: 120, height: 24 }
    dom.window.listeners.get('scroll').forEach((handler) => handler({ type: 'scroll' }))
    assert.equal(dom.document.querySelector('.menu'), null)
    assert.equal(anchor.getAttribute('aria-expanded'), 'false')
  })

  it('unregisters the popup when it closes', () => {
    const { anchor } = makeDialogWithAnchor()
    const menu = openMenu({ anchor, items: [{ label: 'A', checked: true }] })
    assert.equal(popupElements().length, 1)
    menu.close()
    assert.deepEqual(popupElements(), [])
  })
})

describe('focusRouteContent', () => {
  it('moves a lost caret to the route heading', () => {
    const view = h('main', { attrs: { id: 'view', tabindex: '-1' } })
    const heading = h('h1', { attrs: { 'data-route-heading': 'data-route-heading' } })
    view.appendChild(heading)
    dom.body.appendChild(view)
    dom.document.activeElement = dom.body
    assert.equal(focusRouteContent(view), true)
    assert.equal(dom.document.activeElement, heading)
    assert.deepEqual(heading.lastFocusOptions, { preventScroll: true })
    // An <h1> with no tabindex cannot take focus at all; the helper has to make
    // it focusable before it can move the caret there.
    assert.equal(heading.getAttribute('tabindex'), '-1')
  })

  it('falls back to the view itself when the page has no heading', () => {
    const view = h('main', { attrs: { id: 'view', tabindex: '-1' } })
    dom.body.appendChild(view)
    dom.document.activeElement = dom.body
    assert.equal(focusRouteContent(view), true)
    assert.equal(dom.document.activeElement, view)
  })

  it('never steals focus from a control the user is using', () => {
    const view = h('main', { attrs: { tabindex: '-1' } })
    const input = h('input')
    view.appendChild(input)
    dom.body.appendChild(view)
    dom.document.activeElement = input
    assert.equal(focusRouteContent(view), false)
    assert.equal(dom.document.activeElement, input)
  })

  it('treats a detached active element as lost focus', () => {
    const view = h('main', { attrs: { tabindex: '-1' } })
    const heading = h('h1', { attrs: { 'data-route-heading': 'data-route-heading' } })
    view.appendChild(heading)
    dom.body.appendChild(view)
    const detached = h('button')
    dom.document.activeElement = detached
    assert.equal(focusRouteContent(view), true)
    assert.equal(dom.document.activeElement, heading)
  })
})
