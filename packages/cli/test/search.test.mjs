import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarness } from './helpers.mjs';

/**
 * Content search from the CLI.
 *
 * `mdrive search` used to be name-only, so a script looking for a reference
 * number inside documents had no way in. --scope picks the half, and a content
 * hit is marked so the output says why it matched.
 */

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mdrive-search-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function seed(h, dir) {
  const path = join(dir, 'body.txt');
  await writeFile(path, 'the reference QX-7781 is approved');
  assert.equal((await h.run(['upload', path, '--name', 'searchable.txt'])).status, 0);
}

test('a word only inside a file is found with the default scope', async t => {
  const h = await createHarness(t);
  await seed(h, await tempDir(t));
  const result = await h.run(['search', 'QX-7781']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /searchable\.txt/);
  assert.match(result.stdout, /内容/, 'the output marks a content hit');
});

test('--scope name stays name-only', async t => {
  const h = await createHarness(t);
  await seed(h, await tempDir(t));
  const result = await h.run(['search', 'QX-7781', '--scope', 'name']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No matches/);
});

test('--scope content reports the matching sentence in --json', async t => {
  const h = await createHarness(t);
  await seed(h, await tempDir(t));
  const result = await h.run(['search', 'QX-7781', '--scope', 'content', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.results.length, 1);
  assert.equal(payload.results[0].matched, 'content');
  assert.match(payload.results[0].snippet, /QX-7781/);
});

test('an invalid scope is a usage error', async t => {
  const h = await createHarness(t);
  const result = await h.run(['search', 'x', '--scope', 'everything']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /scope/);
});
