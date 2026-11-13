import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers.mjs';

/**
 * `mdrive team --all` — the discovery step a member needs before it can use
 * `--workspace`: `team` alone reports only the active workspace.
 */

test('team --all lists every workspace with ids and the active marker', async t => {
  const h = await createHarness(t);
  const result = await h.run(['team', '--all']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Projects drive/);
  assert.match(result.stdout, /Shared with me/);
  assert.match(result.stdout, /ws-1/);
  assert.match(result.stdout, /ws-2/);
  assert.match(result.stdout, /\*/);
});

test('team --all --json emits the raw payload', async t => {
  const h = await createHarness(t);
  const result = await h.run(['team', '--all', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.workspaces.length, 2);
  assert.equal(payload.workspaces[0].active, true);
  assert.equal(payload.workspaces[1].role, 'member');
});
