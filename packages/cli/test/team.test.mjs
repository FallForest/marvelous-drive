import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers.mjs';

/**
 * `mdrive team` — membership from the terminal.
 *
 * The web client has a team panel; a script needs the same three operations. The
 * interesting cases are the ones the server refuses, because a CLI that hides
 * them behind a generic error is worse than no command.
 */

test('team lists the workspace and its members', async t => {
  const h = await createHarness(t);
  const result = await h.run(['team']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Projects drive/);
  assert.match(result.stdout, /admin/);
  assert.match(result.stdout, /owner@example\.com/);
});

test('team add reports the new member count', async t => {
  const h = await createHarness(t);
  const result = await h.run(['team', 'add', 'new@example.com']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Added new@example\.com/);
  const listed = await h.run(['team']);
  assert.match(listed.stdout, /new@example\.com/);
});

test('team add surfaces an unknown account as a missing account', async t => {
  const h = await createHarness(t);
  const result = await h.run(['team', 'add', 'nobody@example.com']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /HTTP 404 NOT_FOUND/);
});

test('team remove needs the e-mail to be a member', async t => {
  const h = await createHarness(t);
  const missing = await h.run(['team', 'remove', 'ghost@example.com']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No member with the e-mail ghost@example\.com/);
});

test('team remove refuses the workspace owner', async t => {
  const h = await createHarness(t);
  const result = await h.run(['team', 'remove', 'owner@example.com']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /owner cannot be removed/);
});

test('team remove drops a member and the list reflects it', async t => {
  const h = await createHarness(t);
  await h.run(['team', 'add', 'temp@example.com']);
  const removed = await h.run(['team', 'remove', 'temp@example.com']);
  assert.equal(removed.status, 0, removed.stderr);
  const listed = await h.run(['team']);
  assert.ok(!/temp@example\.com/.test(listed.stdout));
});

test('team --json emits the raw payload', async t => {
  const h = await createHarness(t);
  const result = await h.run(['team', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.ok(payload.workspace.name);
  assert.ok(Array.isArray(payload.members));
});
