import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  PREFETCH_RADIUS, NEIGHBOUR_BYTE_LIMIT, isGalleryImage, galleryFor, indexOfId, stepIndex,
  prefetchWindow, positionLabel, arrowDelta, jumpDelta, cancelDirection,
} from '../lib/gallery.js'

/**
 * The gallery is a policy module: which files you can arrow through, and which
 * neighbours are worth bandwidth. Both answers are cheap to check here and
 * expensive to get wrong in a browser (a folder of 40 MB photos).
 */

const image = (id, size = 1024, mime = 'image/jpeg') => ({ id, name: id + '.jpg', kind: 'file', mime, size })
const folder = { id: 'd1', name: 'folder', kind: 'folder', mime: null, size: 0 }
const text = { id: 't1', name: 'a.md', kind: 'file', mime: 'text/markdown', size: 10 }

describe('isGalleryImage', () => {
  it('accepts raster pictures a browser renders', () => {
    for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']) {
      assert.equal(isGalleryImage(image('x', 10, mime)), true, mime)
    }
  })

  it('rejects folders, text, video and junk', () => {
    assert.equal(isGalleryImage(folder), false)
    assert.equal(isGalleryImage(text), false)
    assert.equal(isGalleryImage({ id: 'v', name: 'a.mp4', kind: 'file', mime: 'video/mp4', size: 1 }), false)
    assert.equal(isGalleryImage(null), false)
  })
})

describe('galleyFor', () => {
  it('keeps only pictures, in list order', () => {
    const list = galleryFor([image('a'), folder, text, image('b'), image('c')])
    assert.deepEqual(list.map((node) => node.id), ['a', 'b', 'c'])
  })

  it('drops duplicates and entries without an id', () => {
    const list = galleryFor([image('a'), image('a'), { name: 'no-id.jpg', kind: 'file', mime: 'image/jpeg', size: 1 }])
    assert.deepEqual(list.map((node) => node.id), ['a'])
  })

  it('tolerates no input', () => {
    assert.deepEqual(galleryFor(null), [])
    assert.deepEqual(galleryFor([]), [])
  })
})

describe('indexOfId', () => {
  const gallery = [image('a'), image('b'), image('c')]

  it('finds the position', () => {
    assert.equal(indexOfId(gallery, 'b'), 1)
  })

  it('answers -1 for a stranger', () => {
    assert.equal(indexOfId(gallery, 'zzz'), -1)
    assert.equal(indexOfId(gallery, null), -1)
  })
})

describe('stepIndex', () => {
  it('moves one at a time inside the gallery', () => {
    assert.equal(stepIndex(1, 1, 3), 2)
    assert.equal(stepIndex(2, -1, 3), 1)
  })

  it('clamps at both ends instead of wrapping', () => {
    assert.equal(stepIndex(0, -1, 3), 0)
    assert.equal(stepIndex(2, 1, 3), 2)
  })

  it('wraps only when asked', () => {
    assert.equal(stepIndex(2, 1, 3, { wrap: true }), 0)
    assert.equal(stepIndex(0, -1, 3, { wrap: true }), 2)
    assert.equal(stepIndex(0, -1, 3, { wrap: true }) === 2, true)
  })

  it('clamps a jump bigger than the gallery', () => {
    assert.equal(stepIndex(0, 99, 3), 2)
    assert.equal(stepIndex(1, -99, 3), 0)
  })

  it('reports -1 for an empty gallery', () => {
    assert.equal(stepIndex(0, 1, 0), -1)
    assert.equal(stepIndex(0, 1, Number.NaN), -1)
  })

  it('treats a junk index or delta as zero', () => {
    assert.equal(stepIndex(Number.NaN, Number.NaN, 3), 0)
    assert.equal(stepIndex(-5, 0, 3), 0)
  })
})

describe('prefetchWindow', () => {
  const plain = Array.from({ length: 10 }, (_, i) => image('p' + i, 1000))

  it('warms two neighbours on each side, nearest first', () => {
    const window = prefetchWindow(plain, 5)
    assert.equal(window.length, PREFETCH_RADIUS * 2)
    assert.equal(window[0].node.id, 'p6')
    assert.equal(window[1].node.id, 'p4')
    assert.equal(window[2].node.id, 'p7')
    assert.equal(window[3].node.id, 'p3')
    assert.deepEqual(window.map((entry) => entry.distance), [1, 1, 2, 2])
  })

  it('stops at the ends of the gallery', () => {
    const first = prefetchWindow(plain, 0)
    assert.deepEqual(first.map((entry) => entry.node.id), ['p1', 'p2'])
    const last = prefetchWindow(plain, 9)
    assert.deepEqual(last.map((entry) => entry.node.id), ['p8', 'p7'])
  })

  it('never prefetches the current picture', () => {
    assert.equal(prefetchWindow(plain, 5).some((entry) => entry.node.id === 'p5'), false)
  })

  it('skips a huge neighbour until it is the next one', () => {
    const heavy = plain.slice()
    heavy[8] = image('p8', 40 * 1024 * 1024)
    heavy[7] = image('p7', 40 * 1024 * 1024)
    const window = prefetchWindow(plain.slice(0, 7).concat([heavy[7], heavy[8], heavy[9]]), 5)
    // p7 and p8 are 40 MB: p7 is only two steps out, so it is dropped; p8 does
    // not even exist at that distance in this gallery.
    assert.equal(window.some((entry) => entry.node.id === 'p7'), false)
    assert.equal(window.some((entry) => entry.node.id === 'p6'), true)
  })

  it('honours a byte budget across the batch', () => {
    const big = Array.from({ length: 6 }, (_, i) => image('b' + i, 6 * 1024 * 1024))
    const window = prefetchWindow(big, 2, { budgetBytes: 7 * 1024 * 1024 })
    assert.equal(window.length, 1)
    assert.equal(window[0].node.id, 'b3')
  })

  it('answers an empty list for a one-picture gallery or a zero radius', () => {
    assert.deepEqual(prefetchWindow([image('only')], 0), [])
    assert.deepEqual(prefetchWindow(plain, 5, { radius: 0 }), [])
    assert.deepEqual(prefetchWindow(null, 0), [])
  })

  it('exposes its two policy numbers', () => {
    assert.equal(PREFETCH_RADIUS, 2)
    assert.equal(NEIGHBOUR_BYTE_LIMIT, 12 * 1024 * 1024)
  })
})

describe('positionLabel', () => {
  it('is one-based and reads as a fraction', () => {
    assert.equal(positionLabel(0, 12), '1 / 12')
    assert.equal(positionLabel(11, 12), '12 / 12')
  })

  it('stays empty for an empty gallery', () => {
    assert.equal(positionLabel(0, 0), '')
    assert.equal(positionLabel(0, Number.NaN), '')
  })
})

describe('arrowDelta', () => {
  it('maps the arrow and page keys', () => {
    assert.equal(arrowDelta('ArrowRight'), 1)
    assert.equal(arrowDelta('ArrowLeft'), -1)
    assert.equal(arrowDelta('PageDown'), 1)
    assert.equal(arrowDelta('PageUp'), -1)
  })

  it('ignores everything else', () => {
    assert.equal(arrowDelta('Enter'), 0)
    assert.equal(arrowDelta(' '), 0)
    assert.equal(arrowDelta(undefined), 0)
  })
})
describe('jumpDelta', () => {
  it('jumps to the first and last picture', () => {
    assert.equal(jumpDelta('Home', 5, 12), -5)
    assert.equal(jumpDelta('End', 5, 12), 6)
  })

  it('is zero when already at the edge', () => {
    assert.equal(jumpDelta('Home', 0, 12), 0)
    assert.equal(jumpDelta('End', 11, 12), 0)
  })

  it('ignores other keys and an empty gallery', () => {
    assert.equal(jumpDelta('ArrowLeft', 5, 12), 0)
    assert.equal(jumpDelta('Home', 5, 0), 0)
  })
})

describe('cancelDirection', () => {
  it('names the side that was left behind', () => {
    assert.equal(cancelDirection(1), 'behind')
    assert.equal(cancelDirection(-1), 'ahead')
  })

  it('cancels everything when there is no direction', () => {
    assert.equal(cancelDirection(0), 'all')
  })
})
