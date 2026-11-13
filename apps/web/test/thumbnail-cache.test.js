import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { canThumbnail, clearThumbs, rememberThumb } from '../lib/thumb-cache.js'

/**
 * The thumbnail cache is the one piece of list rendering with real policy: it
 * outlives every re-render, so a wrong eviction order either leaks Blobs or
 * revokes an object URL a row is still displaying.
 */

describe('rememberThumb', () => {
  it('stores a new id and reports nothing evicted', () => {
    const map = new Map()
    const result = rememberThumb(map, 'a', 'blob:a', 4)
    assert.equal(result.url, 'blob:a')
    assert.equal(result.reused, false)
    assert.deepEqual(result.evicted, [])
    assert.equal(map.get('a'), 'blob:a')
  })

  it('reuses the cached url for a repeated id instead of creating a second one', () => {
    const map = new Map()
    rememberThumb(map, 'a', 'blob:a-first', 4)
    const again = rememberThumb(map, 'a', 'blob:a-second', 4)
    assert.equal(again.reused, true)
    assert.equal(again.url, 'blob:a-first', 'the first object URL wins; the caller revokes the new one')
    assert.deepEqual(again.evicted, [])
    assert.equal(map.size, 1)
    assert.equal(map.get('a'), 'blob:a-first')
  })

  it('evicts in insertion order once the limit is exceeded', () => {
    const map = new Map()
    rememberThumb(map, 'a', 'blob:a', 3)
    rememberThumb(map, 'b', 'blob:b', 3)
    rememberThumb(map, 'c', 'blob:c', 3)
    const fourth = rememberThumb(map, 'd', 'blob:d', 3)
    assert.deepEqual(fourth.evicted, ['blob:a'], 'the oldest entry goes first')
    assert.deepEqual([...map.keys()], ['b', 'c', 'd'])
  })

  it('evicts several entries when the limit shrinks', () => {
    const map = new Map()
    for (const id of ['a', 'b', 'c', 'd']) rememberThumb(map, id, 'blob:' + id, 10)
    const result = rememberThumb(map, 'e', 'blob:e', 2)
    assert.deepEqual([...map.keys()], ['d', 'e'])
    assert.deepEqual(result.evicted, ['blob:a', 'blob:b', 'blob:c'])
  })

  it('never leaves the map above the limit, even for a limit of one', () => {
    const map = new Map()
    rememberThumb(map, 'a', 'blob:a', 1)
    const second = rememberThumb(map, 'b', 'blob:b', 1)
    assert.equal(map.size, 1)
    assert.deepEqual(second.evicted, ['blob:a'])
  })

  it('falls back to the default cap when the limit is missing or nonsense', () => {
    for (const limit of [0, -3, NaN, undefined, 'abc']) {
      const map = new Map()
      rememberThumb(map, 'a', 'blob:a', limit)
      const second = rememberThumb(map, 'b', 'blob:b', limit)
      assert.equal(map.size, 2, String(limit))
      assert.deepEqual(second.evicted, [], String(limit))
    }
  })

  it('defaults the cap to 200 entries', () => {
    const map = new Map()
    for (let index = 0; index < 200; index += 1) rememberThumb(map, 'id-' + index, 'blob:' + index)
    assert.equal(map.size, 200)
    const overflow = rememberThumb(map, 'id-200', 'blob:200')
    assert.equal(map.size, 200, 'a long session must not grow without a bound')
    assert.deepEqual(overflow.evicted, ['blob:0'])
  })
})

describe('clearThumbs', () => {
  it('drops everything and hands the urls back for revocation', () => {
    const map = new Map()
    rememberThumb(map, 'a', 'blob:a', 4)
    rememberThumb(map, 'b', 'blob:b', 4)
    const urls = clearThumbs(map)
    assert.deepEqual(urls, ['blob:a', 'blob:b'])
    assert.equal(map.size, 0)
  })
})

describe('canThumbnail', () => {
  it('accepts exactly the formats the server answers', () => {
    for (const mime of ['image/png', 'image/jpeg', 'image/webp', 'IMAGE/PNG', ' image/Png ']) {
      assert.equal(canThumbnail(mime), true, mime)
    }
    assert.equal(canThumbnail('image/png; charset=binary'), true)
  })

  it('keeps the icon for everything else', () => {
    for (const mime of ['image/gif', 'image/svg+xml', 'image/avif', 'application/pdf', '', null, undefined]) {
      assert.equal(canThumbnail(mime), false, String(mime))
    }
  })
})
