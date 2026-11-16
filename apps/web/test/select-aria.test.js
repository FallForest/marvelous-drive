import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'node:test'
import { installFakeDom } from './fake-dom.js'
import { renderMenu, renderSelect } from '../lib/select.js'

/**
 * UI14 — the trigger and the popup describe the same widget.
 *
 * renderSelect said aria-haspopup="listbox" while openMenu built role="menu" of
 * role="menuitemradio" rows. A screen reader therefore announced a listbox that
 * never appeared, and the aria-checked state the rows do carry went unread
 * because a listbox looks for aria-selected instead.
 *
 * The other half is the accessible name: aria-label="权限" replaced the visible
 * value, so the control announced *what it asks* and never *what is chosen*.
 */

beforeEach(() => {
  installFakeDom()
})

const PERMISSIONS = [
  { value: 'viewer', label: '仅查看' },
  { value: 'downloader', label: '可下载' },
]

describe('select semantics', () => {
  it('advertises the menu it actually opens', () => {
    const select = renderSelect({ id: 'share-permission', label: '权限', value: 'viewer', options: PERMISSIONS })
    assert.equal(select.getAttribute('aria-haspopup'), 'menu')
    assert.equal(select.getAttribute('aria-expanded'), 'false')
  })

  it('names the control with the chosen value, not the field label', () => {
    const select = renderSelect({ id: 'share-permission', label: '权限', value: 'viewer', options: PERMISSIONS })
    assert.equal(select.getAttribute('aria-label'), null, 'aria-label must not overwrite the value')
    const valueId = select.getAttribute('aria-labelledby')
    assert.ok(valueId, 'the visible value is pointed at by aria-labelledby')
    const value = select.querySelector('#' + valueId)
    assert.equal(value.className, 'select-value truncate')
    assert.equal(value.textContent, '仅查看')
  })

  it('keeps the field label as a description instead of a name', () => {
    const select = renderSelect({ label: '有效期', value: '1', options: PERMISSIONS })
    const hintId = select.getAttribute('aria-describedby')
    assert.ok(hintId)
    const hint = select.querySelector('#' + hintId)
    assert.equal(hint.className, 'visually-hidden')
    assert.equal(hint.textContent, '有效期')
  })

  it('opens a labelled menu of radio items that report their state', () => {
    const select = renderSelect({ label: '权限', value: 'viewer', options: PERMISSIONS })
    document.body.appendChild(select)
    select.emit('click')

    const menu = document.querySelector('.menu')
    assert.equal(menu.getAttribute('role'), 'menu')
    assert.equal(menu.getAttribute('aria-label'), '权限')
    const items = menu.querySelectorAll('.menu-item')
    assert.equal(items.length, 2)
    for (const item of items) assert.equal(item.getAttribute('role'), 'menuitemradio')
    assert.deepEqual(items.map((item) => item.getAttribute('aria-checked')), ['true', 'false'])
    assert.deepEqual(items.map((item) => item.textContent.trim()), ['仅查看', '可下载'])
  })

  it('re-points the accessible value when the choice changes', () => {
    const select = renderSelect({ label: '权限', value: 'viewer', options: PERMISSIONS })
    document.body.appendChild(select)
    select.emit('click')
    const items = document.querySelectorAll('.menu .menu-item')
    items[1].emit('click')
    assert.equal(select.value, 'downloader')
    const value = select.querySelector('#' + select.getAttribute('aria-labelledby'))
    assert.equal(value.textContent, '可下载')
  })

  it('gives the toolbar menu the same contract', () => {
    const menuButton = renderMenu({ label: '排序方式', value: 'name', options: [
      { value: 'name', label: '按名称' }, { value: 'size', label: '按大小' },
    ] })
    assert.equal(menuButton.getAttribute('aria-haspopup'), 'menu')
    assert.equal(menuButton.getAttribute('aria-label'), null)
    const value = menuButton.querySelector('#' + menuButton.getAttribute('aria-labelledby'))
    assert.equal(value.textContent, '按名称')
    const hint = menuButton.querySelector('#' + menuButton.getAttribute('aria-describedby'))
    assert.equal(hint.textContent, '排序方式')

    document.body.appendChild(menuButton)
    menuButton.emit('click')
    assert.equal(document.querySelector('.menu').getAttribute('aria-label'), '排序方式')
  })
})
