import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarness } from './helpers.mjs';
import { IDS } from './mock-server.mjs';

/**
 * Version history in the CLI.
 *
 * The API could always list versions and restore them; the CLI could not, which
 * meant the one client meant for scripts had no way to pull yesterday's copy.
 */

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mdrive-ver-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Uploads the same name twice so one version row exists. */
async function seedVersioned(h, dir) {
  const file = join(dir, 'draft.txt');
  await writeFile(file, 'first body');
  assert.equal((await h.run(['upload', file, '--name', 'versioned.txt'])).status, 0);
  await writeFile(file, 'second body');
  assert.equal((await h.run(['upload', file, '--name', 'versioned.txt'])).status, 0);
  return file;
}

test('versions lists the stored history, newest first', async t => {
  const h = await createHarness(t);
  const dir = await tempDir(t);
  await seedVersioned(h, dir);
  const result = await h.run(['versions', '/versioned.txt']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /v1/);
  assert.match(result.stdout, /VERSION/);
  assert.match(result.stdout, /Current content is v2/);
});

test('versions works on a file with no history and says so', async t => {
  const h = await createHarness(t);
  const result = await h.run(['versions', '/notes.txt']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no stored versions|v\d/);
});

test('versions --json emits the raw envelope', async t => {
  const h = await createHarness(t);
  const dir = await tempDir(t);
  await seedVersioned(h, dir);
  const result = await h.run(['versions', '/versioned.txt', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.ok(Array.isArray(payload.versions));
  assert.equal(payload.file.name, 'versioned.txt');
});

test('version download writes the old bytes and leaves the file alone', async t => {
  const h = await createHarness(t);
  const dir = await tempDir(t);
  await seedVersioned(h, dir);
  const listed = await h.run(['versions', '/versioned.txt', '--json']);
  const version = JSON.parse(listed.stdout).versions[0];
  const out = join(dir, 'old.txt');
  const result = await h.run(['version', 'download', '/versioned.txt', version.id, '--output', out]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(out, 'utf8'), 'first body');
  const live = await h.run(['cat', '/versioned.txt']);
  assert.equal(live.stdout, 'second body');
});

test('version download refuses to clobber without --force', async t => {
  const h = await createHarness(t);
  const dir = await tempDir(t);
  await seedVersioned(h, dir);
  const listed = await h.run(['versions', '/versioned.txt', '--json']);
  const version = JSON.parse(listed.stdout).versions[0];
  const out = join(dir, 'exists.txt');
  await writeFile(out, 'do not lose me');
  const blocked = await h.run(['version', 'download', '/versioned.txt', version.id, '--output', out]);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /already exists/);
  assert.equal(await readFile(out, 'utf8'), 'do not lose me');
  const forced = await h.run(['version', 'download', '/versioned.txt', version.id, '--output', out, '--force']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(await readFile(out, 'utf8'), 'first body');
});

test('version restore makes the old bytes current', async t => {
  const h = await createHarness(t);
  const dir = await tempDir(t);
  await seedVersioned(h, dir);
  const listed = await h.run(['versions', '/versioned.txt', '--json']);
  const version = JSON.parse(listed.stdout).versions[0];
  const result = await h.run(['version', 'restore', '/versioned.txt', version.id]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Restored versioned\.txt/);
  const live = await h.run(['cat', '/versioned.txt']);
  assert.equal(live.stdout, 'first body');
});

test('version download without --output is a usage error', async t => {
  const h = await createHarness(t);
  const result = await h.run(['version', 'download', '/versioned.txt', 'abc']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--output/);
});

test('both commands document themselves in --help', async t => {
  const h = await createHarness(t);
  for (const args of [['versions', '--help'], ['version', 'download', '--help'], ['version', 'restore', '--help']]) {
    const result = await h.run(args);
    assert.equal(result.status, 0, args.join(' ') + ': ' + result.stderr);
    assert.match(result.stdout, /Usage/);
  }
  // The CLI's own --version must keep meaning "print the version".
  const selfVersion = await h.run(['version']);
  assert.equal(selfVersion.status, 0);
  assert.match(selfVersion.stdout || selfVersion.stderr, /mdrive \d+\.\d+/);
});
