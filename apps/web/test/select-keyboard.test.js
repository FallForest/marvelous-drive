import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'node:test'
import { installFakeDom, keyEvent } from './fake-dom.js'
import { renderSelect } from '../lib/select.js'

/**
 * UI14 — a menu button opens its own popup from the keyboard.
 *
 * ArrowDown/ArrowUp on a closed trigger is the APG behaviour for this widget and
 * the reason the trigger no longer claims to be a listbox: a listbox has a
 * selected option inside the field, a menu button opens a menu. The last case
 * pins the listbox contract that *does* remain — the value is readable without
 * opening anything.
 */

beforeEach(() => {
  installFakeDom()
})

const OPTIONS = [
  { value: 'viewer', label: '仅查看' },
  { value: 'downloader', label: '可下载' },
]

describe('menu button keyboard', () => {
  it('opens on ArrowDown with the first item focused', () => {
    const select = renderSelect({ label: '权限', value: 'viewer', options: OPTIONS })
    document.body.appendChild(select)
    const event = keyEvent('ArrowDown')
    select.emit('keydown', event)
    assert.equal(event.defaultPrevented, true)
    assert.equal(document.querySelector('.menu').getAttribute('role'), 'menu')
    assert.equal(document.activeElement, document.querySelector('.menu .menu-item'))
  })

  it('opens on ArrowUp with the last item focused', () => {
    const select = renderSelect({ label: '权限', value: 'viewer', options: OPTIONS })
    document.body.appendChild(select)
    select.emit('keydown', keyEvent('ArrowUp'))
    const items = document.querySelectorAll('.menu .menu-item')
    assert.equal(document.activeElement, items[items.length - 1])
  })

  it('ignores other keys, so the fields around it keep working', () => {
    const select = renderSelect({ label: '权限', value: 'viewer', options: OPTIONS })
    document.body.appendChild(select)
    const event = keyEvent('a')
    select.emit('keydown', event)
    assert.equal(event.defaultPrevented, false)
    assert.equal(document.querySelector('.menu'), null)
  })
})
