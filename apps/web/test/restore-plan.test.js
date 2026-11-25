import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildIndex } from '../lib/state.js'
import { planRestoreRequests } from '../lib/actions.js'

/**
 * Restoring a batch from the trash, planned before any request is sent.
 *
 * The server restores the selected node plus the descendants it sent to the
 * trash in the same operation (the rows sharing one `trashGroup`). A child that
 * was deleted separately carries another group and is NOT brought back by its
 * folder's restore, so collapsing it into the folder's request loses it — the
 * trash would show it back after a "successful" batch.
 *
 * Purge keeps the old collapse (`topmostSelection`): deleting a folder forever
 * does remove a separately deleted child inside it. That is why the planner is
 * restore-specific and asserted here instead of in a browser.
 */

/** A trashed row; `path` is its originalPath as ids, root-to-parent. */
function row(id, parentId, group, path, kind = 'file') {
  return {
    id,
    name: id,
    kind,
    parentId,
    trashGroup: group,
    originalPath: path.map((segment) => ({ id: segment, name: segment })),
    deletedAt: '2026-01-01T00:00:00.000Z',
  };
}

const ids = (plan) => plan.nodes.map((node) => node.id)
const covered = (plan) => [...plan.coverage].map(([id, set]) => [id, [...set].sort()])
  .sort((left, right) => left[0].localeCompare(right[0]))

// One folder deleted with its child ("g1"), and a file deleted on its own
// afterwards ("g2"). Both rows are in the same trashed folder chain.
const folder = row('folder', null, 'g1', [], 'folder')
const child = row('child', 'folder', 'g1', ['folder'])
const loose = row('loose', 'folder', 'g2', ['folder'])

describe('restore plan: deletion groups', () => {
  it('collapses a same-group child into its selected ancestor', () => {
    const plan = planRestoreRequests([child, folder], buildIndex([folder, child]))
    assert.deepEqual(ids(plan), ['folder'], 'one request restores both rows')
    assert.deepEqual(covered(plan), [['folder', ['child', 'folder']]])
  })

  it('requests an independently deleted child even after its ancestor', () => {
    const plan = planRestoreRequests([loose, folder], buildIndex([folder, loose]))
    assert.deepEqual(ids(plan), ['folder', 'loose'], 'parent first, then the other group')
    assert.deepEqual(covered(plan), [['folder', ['folder']], ['loose', ['loose']]])
  })

  it('keeps the same split when the selected child is listed first', () => {
    // Selection order must not decide what the server is asked for.
    const plan = planRestoreRequests([loose, folder, child], buildIndex([folder, child, loose]))
    assert.deepEqual(ids(plan), ['folder', 'loose'])
    assert.deepEqual(covered(plan), [['folder', ['child', 'folder']], ['loose', ['loose']]])
  })

  it('keeps a same-group grandchild in its parent request instead of splitting it', () => {
    // root and leaf share g1 through a middle row that was never selected:
    // the leaf speaks through the request its nearest selected ancestor
    // resolved to, so the batch is still two requests, not three.
    const top = row('top', null, 'g1', [], 'folder')
    const middle = row('mid', 'top', 'g1', ['top'], 'folder')
    const leaf = row('leaf', 'mid', 'g1', ['top', 'mid'])
    const plan = planRestoreRequests([leaf, middle, top], buildIndex([top, middle, leaf]))
    assert.deepEqual(ids(plan), ['top'])
    assert.deepEqual(covered(plan), [['top', ['leaf', 'mid', 'top']]])
  })

  it('does not cross a known different group to reach a same group higher up', () => {
    // root(g1) > middle(g2) > leaf(g1): the leaf matches the root's group, but
    // the selected row between them is a different group. Ordering the leaf
    // after root would let the middle's restore run first and the leaf answer
    // "not in the trash"; both stay their own requests, root first.
    const root = row('root', null, 'g1', [], 'folder')
    const middle = row('middle', 'root', 'g2', ['root'], 'folder')
    const leaf = row('leaf', 'middle', 'g1', ['root', 'middle'])
    const plan = planRestoreRequests([leaf, middle, root], buildIndex([root, middle, leaf]))
    assert.deepEqual(ids(plan), ['root', 'middle', 'leaf'])
    assert.deepEqual(covered(plan), [['leaf', ['leaf']], ['middle', ['middle']], ['root', ['root']]])
  })

  it('orders a nested branch parent-first with a stable tie order', () => {
    // Three branches deleted separately (one group each), one of them nested.
    const second = row('second', null, 'g9', [], 'folder')
    const plan = planRestoreRequests(
      [
        row('deep', 'mid', 'g5', ['top', 'mid']),
        row('mid', 'top', 'g4', ['top'], 'folder'),
        row('top', null, 'g3', [], 'folder'),
        second,
        folder,
      ],
      buildIndex([]),
    )
    // Depths come from originalPath alone, so a paged trash view (empty index)
    // still orders ancestors before descendants; same-depth rows keep the
    // selection order instead of being re-sorted by a second path walk.
    assert.deepEqual(ids(plan), ['top', 'second', 'folder', 'mid', 'deep'])
    assert.deepEqual(covered(plan).map(([, set]) => set.length), [1, 1, 1, 1, 1])
  })
})

describe('restore plan: paged trash and old servers', () => {
  it('collapses a child whose selected parent is on another page', () => {
    // The index holds only the child: originalPath is the only proof the parent
    // exists, and the group proves the parent's restore brings it back.
    const plan = planRestoreRequests([child, folder], buildIndex([child]))
    assert.deepEqual(ids(plan), ['folder'])
    assert.deepEqual(covered(plan), [['folder', ['child', 'folder']]])
  })

  it('keeps the previous collapse when the server sends no groups', () => {
    const legacyFolder = row('folder', null, undefined, [], 'folder')
    const legacyChild = row('child', 'folder', undefined, ['folder'])
    const legacyLoose = row('loose', 'folder', undefined, ['folder'])
    const plan = planRestoreRequests([legacyChild, legacyLoose, legacyFolder], buildIndex([legacyFolder, legacyChild, legacyLoose]))
    // Exactly the old behavior: every selected descendant folds into the top.
    assert.deepEqual(ids(plan), ['folder'])
    assert.deepEqual(covered(plan), [['folder', ['child', 'folder', 'loose']]])
  })

  it('treats a non-string group as absent instead of comparing objects', () => {
    const plan = planRestoreRequests(
      [{ ...folder, trashGroup: 42 }, { ...child, trashGroup: { id: 'g1' } }],
      buildIndex([]),
    )
    // No usable group anywhere: old-server collapse, never a crash.
    assert.deepEqual(ids(plan), ['folder'])
    assert.deepEqual(covered(plan), [['folder', ['child', 'folder']]])
  })

  it('answers an empty plan for an empty selection', () => {
    assert.deepEqual(planRestoreRequests([], buildIndex([])), { nodes: [], coverage: new Map() })
    assert.deepEqual(planRestoreRequests(null, buildIndex([])), { nodes: [], coverage: new Map() })
  })
})
