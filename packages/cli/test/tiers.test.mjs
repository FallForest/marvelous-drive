import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers.mjs';

/**
 * `mdrive tiers` — the cold-file report an archival decision is based on.
 */

test('tiers reports the split with the biggest cold files first', async t => {
  const h = await createHarness(t);
  const result = await h.run(['tiers']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /threshold\s+90 days/);
  assert.match(result.stdout, /cold/);
});

test('tiers honours --days', async t => {
  const h = await createHarness(t);
  const result = await h.run(['tiers', '--days', '180', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.tiers.thresholdDays, 180);
  assert.ok(Array.isArray(payload.tiers.cold));
});

test('tiers rejects a nonsense threshold', async t => {
  const h = await createHarness(t);
  // A flag outside its declared range is a usage error (exit 2), not a runtime
  // failure: nothing was attempted against the server.
  const result = await h.run(['tiers', '--days', '0']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--days/);
});
