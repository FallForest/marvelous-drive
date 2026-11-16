import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

/**
 * The single-character shortcut switch (WCAG 2.1.4).
 *
 * The preference is module state, so the tests own the storage: a fake
 * localStorage runs before the module is imported, which is also the state the
 * page boots in. "Unreadable storage" and "no storage at all" are both real
 * (private mode, a locked-down origin) and both must default to enabled rather
 * than crash the shell before the first paint.
 */

const storage = new Map()
globalThis.window = {
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)) },
    removeItem: (key) => { storage.delete(key) },
  },
}

const { parseShortcutPreference, setShortcutsEnabled, shortcutsEnabled } = await import('../lib/shortcuts.js')

beforeEach(() => {
  storage.clear()
  setShortcutsEnabled(true)
})

describe('shortcut preference', () => {
  it('treats an absent or unreadable value as the default: enabled', () => {
    assert.equal(parseShortcutPreference(null), true)
    assert.equal(parseShortcutPreference(undefined), true)
    assert.equal(parseShortcutPreference('on'), true)
    assert.equal(parseShortcutPreference(''), true)
    assert.equal(parseShortcutPreference('off'), false)
  })

  it('persists the switch across reads', () => {
    setShortcutsEnabled(false)
    assert.equal(storage.get('mdrive-shortcuts'), 'off')
    assert.equal(shortcutsEnabled(), false)
    setShortcutsEnabled(true)
    assert.equal(storage.get('mdrive-shortcuts'), 'on')
    assert.equal(shortcutsEnabled(), true)
  })

  it('coerces anything truthy to enabled and anything falsy to disabled', () => {
    assert.equal(setShortcutsEnabled(0), false)
    assert.equal(setShortcutsEnabled('yes'), true)
  })
})
