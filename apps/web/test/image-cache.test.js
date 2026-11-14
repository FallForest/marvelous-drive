import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createImageCache, CACHE_BUDGET_BYTES, ENTRY_BYTE_LIMIT, CACHE_ENTRY_CAP } from '../lib/image-cache.js'

/**
 * Eviction is the difference between "a photo folder works" and "the tab dies".
 * The rules are byte accounting, LRU order, never evicting what you just stored,
 * and disposing what leaves — all four are cheap to pin here.
 */

const cache = (options) => createImageCache({ budgetBytes: 1000, maxEntries: 10, ...options })

describe('createImageCache', () => {
  it('stores and returns a value', () => {
    const c = cache()
    assert.deepEqual(c.set('a', 'bitmap:a', 100).stored, true)
    assert.equal(c.get('a'), 'bitmap:a')
    assert.equal(c.has('a'), true)
  })

  it('answers null for a miss', () => {
    const c = cache()
    assert.equal(c.get('nope'), null)
    assert.equal(c.peek('nope'), null)
  })

  it('accounts bytes as the sum of entry sizes', () => {
    const c = cache()
    c.set('a', 'bitmap:a', 100)
    c.set('b', 'bitmap:b', 250)
    assert.deepEqual(c.stats(), { entries: 2, bytes: 350, budgetBytes: 1000 })
  })
})

describe('byte eviction', () => {
  it('drops the oldest entries until the budget fits', () => {
    const c = cache({ budgetBytes: 300 })
    c.set('a', 'bitmap:a', 100)
    c.set('b', 'bitmap:b', 100)
    const third = c.set('c', 'bitmap:c', 150)
    assert.deepEqual(third.evicted, ['bitmap:a'])
    assert.equal(c.has('a'), false)
    assert.equal(c.has('c'), true)
    assert.equal(c.stats().bytes, 250)
  })

  it('never evicts the entry it just stored', () => {
    const c = cache({ budgetBytes: 150 })
    const result = c.set('big', 'bitmap:big', 150)
    assert.equal(result.stored, true)
    assert.equal(c.get('big'), 'bitmap:big')
  })

  it('refuses to hold a single entry over the budget', () => {
    const c = cache({ budgetBytes: 100 })
    const result = c.set('huge', 'bitmap:huge', 500)
    assert.equal(result.stored, false)
    assert.deepEqual(result.evicted, [])
    assert.equal(c.has('huge'), false)
  })

  it('refuses an entry over the per-entry ceiling even with room', () => {
    const c = cache({ budgetBytes: 10_000, entryLimit: 500 })
    assert.equal(c.set('big', 'bitmap:big', 900).stored, false)
    assert.equal(c.set('ok', 'bitmap:ok', 400).stored, true)
  })
})

describe('recency', () => {
  it('keeps a recently read entry alive', () => {
    const c = cache({ budgetBytes: 300 })
    c.set('a', 'bitmap:a', 100)
    c.set('b', 'bitmap:b', 100)
    c.get('a')
    const result = c.set('c', 'bitmap:c', 150)
    assert.deepEqual(result.evicted, ['bitmap:b'])
    assert.equal(c.has('a'), true)
  })

  it('does not refresh recency on peek', () => {
    const c = cache({ budgetBytes: 300 })
    c.set('a', 'bitmap:a', 100)
    c.set('b', 'bitmap:b', 100)
    c.peek('a')
    const result = c.set('c', 'bitmap:c', 150)
    assert.deepEqual(result.evicted, ['bitmap:a'])
  })
})

describe('replacing an entry', () => {
  it('hands the old value back', () => {
    const c = cache()
    c.set('a', 'bitmap:old', 100)
    const result = c.set('a', 'bitmap:new', 120)
    assert.deepEqual(result.evicted, ['bitmap:old'])
    assert.equal(c.get('a'), 'bitmap:new')
    assert.equal(c.stats().bytes, 120)
  })

  it('does not hand back the same value', () => {
    const c = cache()
    c.set('a', 'bitmap:same', 100)
    assert.deepEqual(c.set('a', 'bitmap:same', 100).evicted, [])
  })
})

describe('entry cap', () => {
  it('evicts by count when entries are tiny', () => {
    const c = cache({ maxEntries: 2, budgetBytes: 10_000 })
    c.set('a', 'bitmap:a', 1)
    c.set('b', 'bitmap:b', 1)
    const result = c.set('c', 'bitmap:c', 1)
    assert.deepEqual(result.evicted, ['bitmap:a'])
    assert.equal(c.stats().entries, 2)
  })
})

describe('delete and clear', () => {
  it('delete hands the value back and frees its bytes', () => {
    const c = cache()
    c.set('a', 'bitmap:a', 100)
    assert.equal(c.delete('a'), 'bitmap:a')
    assert.equal(c.delete('a'), null)
    assert.equal(c.stats().bytes, 0)
  })

  it('clear returns every value', () => {
    const c = cache()
    c.set('a', 'bitmap:a', 10)
    c.set('b', 'bitmap:b', 10)
    assert.deepEqual(c.clear().sort(), ['bitmap:a', 'bitmap:b'])
    assert.equal(c.stats().entries, 0)
  })
})

describe('disposers', () => {
  it('disposes a replaced value', () => {
    const closed = []
    const c = cache()
    c.set('a', 'bitmap-old', 100, () => closed.push('old'))
    c.set('a', 'bitmap-new', 120, () => closed.push('new'))
    assert.deepEqual(closed, ['old'])
  })

  it('disposes on eviction', () => {
    const closed = []
    const c = cache({ budgetBytes: 200 })
    c.set('a', 'bitmap:a', 100, () => closed.push('a'))
    c.set('b', 'bitmap:b', 100, () => closed.push('b'))
    c.set('c', 'bitmap:c', 100, () => closed.push('c'))
    assert.equal(closed.includes('a'), true)
    assert.equal(closed.includes('c'), false)
  })

  it('disposes on delete and on clear', () => {
    const closed = []
    const c = cache()
    c.set('a', 'bitmap:a', 10, () => closed.push('a'))
    c.set('b', 'bitmap:b', 10, () => closed.push('b'))
    c.delete('a')
    c.clear()
    assert.deepEqual(closed.sort(), ['a', 'b'])
  })

  it('does not dispose the value it refused to store', () => {
    const closed = []
    const c = cache({ budgetBytes: 50 })
    c.set('huge', 'bitmap:huge', 500, () => closed.push('huge'))
    assert.deepEqual(closed, [])
  })
})

describe('junk input', () => {
  it('ignores a set without an id or a value', () => {
    const c = cache()
    assert.equal(c.set('', 'bitmap:x', 10).stored, false)
    assert.equal(c.set('a', '', 10).stored, false)
  })

  it('treats a missing size as zero', () => {
    const c = cache()
    c.set('a', 'bitmap:a')
    assert.equal(c.stats().bytes, 0)
  })

  it('falls back to the documented defaults', () => {
    const c = createImageCache()
    assert.equal(c.stats().budgetBytes, CACHE_BUDGET_BYTES)
    assert.equal(ENTRY_BYTE_LIMIT, 24 * 1024 * 1024)
    assert.equal(CACHE_ENTRY_CAP, 24)
  })
})
