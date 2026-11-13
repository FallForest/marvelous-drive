import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildIndex } from '../lib/state.js'
import {
  BLOCK_REASON, NODE_MIME, decodeNodeIds, encodeNodeIds, hasNodeDrag, planMoves, selectionForDrag,
} from '../lib/drag-move.js'

/**
 * Drag-to-move: the pure half. A drag must never disagree with the "移动到…"
 * dialog about what is legal, so every rule is asserted here instead of in a
 * browser.
 */

const nodes = [
  { id: 'a', kind: 'folder', name: 'A', parentId: null },
  { id: 'a1', kind: 'folder', name: 'A1', parentId: 'a' },
  { id: 'a11', kind: 'folder', name: 'A11', parentId: 'a1' },
  { id: 'f1', kind: 'file', name: 'f1.txt', parentId: 'a' },
  { id: 'f2', kind: 'file', name: 'f2.txt', parentId: null },
  { id: 'b', kind: 'folder', name: 'B', parentId: null },
]
const index = buildIndex(nodes)

describe('planMoves', () => {
  it('allows a file to move into another folder', () => {
    assert.deepEqual(planMoves(['f2'], 'b', index), { allowed: ['f2'], blocked: [] })
  })

  it('allows a whole folder to move to a sibling folder', () => {
    assert.deepEqual(planMoves(['a'], 'b', index), { allowed: ['a'], blocked: [] })
  })

  it('treats a null target as the drive root', () => {
    assert.deepEqual(planMoves(['f1', 'a1'], null, index), { allowed: ['f1', 'a1'], blocked: [] })
  })

  it('keeps a no-op move (already in that folder) allowed', () => {
    // The server answers 200 without bumping the version, so the drag is simply
    // a no-op rather than an error the user has to read.
    assert.deepEqual(planMoves(['f1'], 'a', index), { allowed: ['f1'], blocked: [] })
  })

  it('blocks dropping a folder onto itself', () => {
    assert.deepEqual(planMoves(['a'], 'a', index), { allowed: [], blocked: [{ id: 'a', reason: BLOCK_REASON.SELF }] })
  })

  it('blocks dropping a folder into its own subtree at any depth', () => {
    assert.deepEqual(planMoves(['a'], 'a1', index), { allowed: [], blocked: [{ id: 'a', reason: BLOCK_REASON.DESCENDANT }] })
    assert.deepEqual(planMoves(['a'], 'a11', index), { allowed: [], blocked: [{ id: 'a', reason: BLOCK_REASON.DESCENDANT }] })
    assert.deepEqual(planMoves(['a1'], 'a11', index), { allowed: [], blocked: [{ id: 'a1', reason: BLOCK_REASON.DESCENDANT }] })
  })

  it('splits a mixed selection into allowed and blocked', () => {
    const plan = planMoves(['a', 'f2', 'a1'], 'a11', index)
    assert.deepEqual(plan.allowed, ['f2'])
    assert.deepEqual(plan.blocked.map((entry) => entry.id), ['a', 'a1'])
    assert.ok(plan.blocked.every((entry) => entry.reason === BLOCK_REASON.DESCENDANT))
  })

  it('blocks ids that are not in this account\'s live tree', () => {
    // Defensive: a stale row, a trashed id or another user's id must never be
    // sent to the API. The server would answer 404, the drag answers first.
    assert.deepEqual(planMoves(['not-mine'], 'b', index), { allowed: [], blocked: [{ id: 'not-mine', reason: BLOCK_REASON.UNKNOWN }] })
    assert.deepEqual(planMoves(['f1', 'not-mine'], 'b', index).allowed, ['f1'])
  })

  it('blocks everything when the destination itself is gone or is a file', () => {
    assert.deepEqual(planMoves(['f1'], 'missing-folder', index), {
      allowed: [], blocked: [{ id: 'f1', reason: BLOCK_REASON.TARGET_MISSING }],
    })
    assert.deepEqual(planMoves(['f1'], 'f2', index), {
      allowed: [], blocked: [{ id: 'f1', reason: BLOCK_REASON.TARGET_NOT_FOLDER }],
    })
  })

  it('answers an empty plan for an empty or blank selection', () => {
    assert.deepEqual(planMoves([], 'b', index), { allowed: [], blocked: [] })
    assert.deepEqual(planMoves(null, 'b', index), { allowed: [], blocked: [] })
    assert.deepEqual(planMoves(['', '   '], 'b', index), { allowed: [], blocked: [] })
  })

  it('accepts a Set, collapses duplicates and keeps the order it was given', () => {
    assert.deepEqual(planMoves(new Set(['f2', 'f1']), null, index).allowed, ['f2', 'f1'])
    assert.deepEqual(planMoves(['f2', 'f2', 'f1', 'f2'], 'b', index).allowed, ['f2', 'f1'])
  })
})

describe('drag payload', () => {
  it('round-trips ids through the dataTransfer string', () => {
    assert.equal(encodeNodeIds(['a', 'b']), 'a,b')
    assert.deepEqual(decodeNodeIds('a,b'), ['a', 'b'])
    assert.deepEqual(decodeNodeIds(encodeNodeIds(['id-1', 'id-2'])), ['id-1', 'id-2'])
  })

  it('tolerates blanks, repeats and a missing payload', () => {
    assert.equal(encodeNodeIds([' a ', '', 'a', null, 'b']), 'a,b')
    assert.deepEqual(decodeNodeIds(' a , , a ,b '), ['a', 'b'])
    assert.deepEqual(decodeNodeIds(''), [])
    assert.deepEqual(decodeNodeIds(undefined), [])
    assert.deepEqual(decodeNodeIds(null), [])
  })
})

describe('hasNodeDrag', () => {
  const dt = (types) => ({ types })

  it('recognises our own payload', () => {
    assert.equal(hasNodeDrag(dt([NODE_MIME])), true)
    assert.equal(hasNodeDrag(dt(['Files', NODE_MIME])), true)
  })

  it('ignores a file drop from the OS', () => {
    // This is what keeps "drag files into the window" uploading while a row
    // drag no longer lands on every element of the page.
    assert.equal(hasNodeDrag(dt(['Files'])), false)
    assert.equal(hasNodeDrag(dt(['text/plain'])), false)
    assert.equal(hasNodeDrag(dt([])), false)
  })

  it('survives a dataTransfer without types', () => {
    assert.equal(hasNodeDrag(null), false)
    assert.equal(hasNodeDrag({}), false)
    assert.equal(hasNodeDrag({ types: undefined }), false)
  })
})

describe('selectionForDrag', () => {
  it('carries the whole selection when the dragged row is part of it', () => {
    assert.deepEqual(selectionForDrag(new Set(['f1', 'f2', 'b']), 'f2'), ['f1', 'f2', 'b'])
  })

  it('carries only the dragged row when it is outside the selection', () => {
    assert.deepEqual(selectionForDrag(new Set(['f1']), 'b'), ['b'])
  })

  it('carries the dragged row with an empty selection', () => {
    assert.deepEqual(selectionForDrag(new Set(), 'b'), ['b'])
    assert.deepEqual(selectionForDrag(undefined, 'b'), ['b'])
    assert.deepEqual(selectionForDrag([], 'b'), ['b'])
  })

  it('never clears the selection', () => {
    const selection = new Set(['f1', 'f2'])
    selectionForDrag(selection, 'f1')
    assert.deepEqual([...selection], ['f1', 'f2'])
  })
})
