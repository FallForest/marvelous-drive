import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'node:test'
import {
  ROW_ACTION, rowAction, openKind, isSelectionClick, isRepeatClick, noteOpen, resetClickGuard,
} from '../lib/row-action.js'

/**
 * The click model is a rule, not a detail: a plain click acts, the checkbox and
 * the modifier keys select. These tests pin the rule so a future "let's add a
 * dblclick" cannot quietly bring Explorer back.
 */

const folder = { id: 'f1', kind: 'folder', name: '项目' }
const file = { id: 'n1', kind: 'file', name: '说明.md' }

describe('rowAction', () => {
  it('opens in the drive, in starred and in search', () => {
    for (const route of ['drive', 'starred', 'search']) {
      assert.equal(rowAction(route, folder), ROW_ACTION.OPEN)
      assert.equal(rowAction(route, file), ROW_ACTION.OPEN)
    }
  })

  it('only selects in the trash', () => {
    assert.equal(rowAction('trash', folder), ROW_ACTION.SELECT)
    assert.equal(rowAction('trash', file), ROW_ACTION.SELECT)
  })

  it('selects when there is no node', () => {
    assert.equal(rowAction('drive', null), ROW_ACTION.SELECT)
  })
})

describe('openKind', () => {
  it('navigates folders and previews files', () => {
    assert.equal(openKind(folder), 'folder')
    assert.equal(openKind(file), 'preview')
    assert.equal(openKind(null), 'preview')
  })
})

describe('isSelectionClick', () => {
  it('treats ctrl, cmd and shift as selection', () => {
    assert.equal(isSelectionClick({ ctrlKey: true }), true)
    assert.equal(isSelectionClick({ metaKey: true }), true)
    assert.equal(isSelectionClick({ shiftKey: true }), true)
  })

  it('treats a bare click as an action', () => {
    assert.equal(isSelectionClick({}), false)
    assert.equal(isSelectionClick(undefined), false)
  })
})

describe('double-click echo', () => {
  beforeEach(() => resetClickGuard())

  it('swallows only the echo of an open', () => {
    noteOpen(1000)
    assert.equal(isRepeatClick(file, {}, 1100), true)
    assert.equal(isRepeatClick(file, {}, 1700), false)
  })

  it('lets a fresh gesture through once the window has passed', () => {
    resetClickGuard()
    assert.equal(isRepeatClick(file, {}, 5000), false)
  })
})
