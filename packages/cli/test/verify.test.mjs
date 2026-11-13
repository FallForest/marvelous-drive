import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers.mjs';

/**
 * `mdrive verify` — the only check that can see silent corruption.
 *
 * It must never claim success on a corrupt store, must never delete evidence,
 * and --fix must be what moves a bad blob out of service.
 */

test('verify reports a clean store', async t => {
  const h = await createHarness(t);
  const result = await h.run(['verify']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /corrupt\s+0/);
  assert.match(result.stdout, /checked\s+\d+/);
});

test('verify surfaces a corrupt blob without touching it', async t => {
  const h = await createHarness(t);
  h.server.state.corruptHash = 'a'.repeat(64);
  const result = await h.run(['verify']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /corrupt\s+1/);
  assert.match(result.stdout, /aaaaaaaa/);
  assert.match(result.stdout, /--fix/);
  assert.ok(!h.server.state.quarantined, 'a plain verify must not move anything');
});

test('verify --fix quarantines and clears the finding', async t => {
  const h = await createHarness(t);
  h.server.state.corruptHash = 'b'.repeat(64);
  const fixed = await h.run(['verify', '--fix']);
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.match(fixed.stdout, /Quarantined 1/);
  assert.deepEqual(h.server.state.quarantined, ['b'.repeat(64)]);
  const after = await h.run(['verify']);
  assert.match(after.stdout, /corrupt\s+0/);
});

test('verify --limit reports what is left for the next run', async t => {
  const h = await createHarness(t);
  const result = await h.run(['verify', '--limit', '1', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.ok(payload.verification.verified <= 1);
  assert.equal(typeof payload.verification.remaining, 'number');
});
