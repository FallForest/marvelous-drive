import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers.mjs';

/**
 * `mdrive index` — the operator's view of the search index.
 *
 * The index is derived data, so the only interesting states are "caught up" and
 * "behind". Both are reported, and --reindex is the fix.
 */

test('index reports coverage for the seeded drive', async t => {
  const h = await createHarness(t);
  const result = await h.run(['index']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /searchable/);
  assert.match(result.stdout, /up to date/);
});

test('index says so when it is behind, and points at --reindex', async t => {
  const h = await createHarness(t);
  h.server.state.indexGap = true;
  const result = await h.run(['index']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /up to date\s+no/);
  assert.match(result.stdout, /--reindex/);
});

test('index --reindex rebuilds and reports the new coverage', async t => {
  const h = await createHarness(t);
  h.server.state.indexGap = true;
  const result = await h.run(['index', '--reindex']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Rebuilt/);
  assert.match(result.stdout, /missing\s+0/);
  const again = await h.run(['index']);
  assert.match(again.stdout, /up to date\s+yes/);
});

test('index --json emits the raw payload', async t => {
  const h = await createHarness(t);
  const result = await h.run(['index', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.ok(payload.coverage);
  assert.equal(typeof payload.coverage.eligible, 'number');
});

test('index --help documents the flag', async t => {
  const h = await createHarness(t);
  const result = await h.run(['index', '--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--reindex/);
});
