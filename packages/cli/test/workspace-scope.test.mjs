import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers.mjs';

/**
 * `--workspace` on ls and tree.
 *
 * A shared workspace is only useful from a script if the listing can reach it.
 * The flag has to be threaded through the recursive walk too, otherwise a tree
 * silently collapses to the caller's own files one level down.
 */

const shared = {
  id: 'shared-node-1',
  name: 'team-plan.md',
  kind: 'file',
  parentId: null,
  size: 12,
  mime: 'text/markdown',
  version: 1,
  starred: false,
  deletedAt: null,
  createdAt: '2026-01-02T10:00:00.000Z',
  updatedAt: '2026-01-02T10:00:00.000Z',
  blobHash: null
};

test('ls without --workspace stays personal', async t => {
  const h = await createHarness(t);
  h.server.state.workspaceNodes.push(shared);
  const result = await h.run(['ls']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!/team-plan/.test(result.stdout), 'a shared node must not appear without the flag');
});

test('ls --workspace lists the shared tree', async t => {
  const h = await createHarness(t);
  h.server.state.workspaceNodes.push(shared);
  const result = await h.run(['ls', '--workspace', 'ws-1']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /team-plan\.md/);
});

test('tree --workspace walks the shared scope', async t => {
  const h = await createHarness(t);
  h.server.state.workspaceNodes.push(shared);
  const result = await h.run(['tree', '--workspace', 'ws-1']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /team-plan\.md/);
});

test('team prints the workspace id so --workspace is usable', async t => {
  const h = await createHarness(t);
  const result = await h.run(['team']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /id\s+ws-1/);
});
