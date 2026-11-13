import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createHarness } from './helpers.mjs';

/**
 * Instant upload (dedup) and the conflict strategy flag.
 *
 * The fast path must be invisible when it does not apply: a small file, an
 * unknown hash or a failing probe all have to fall back to a real upload, and
 * only a hash the server already stores may skip the bytes.
 */

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mdrive-dedup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const uploadRequests = (server) => server.requests.filter((request) => request.path === '/api/v1/uploads' && request.method === 'PUT');
const probeRequests = (server) => server.requests.filter((request) => request.path.startsWith('/api/v1/blobs/'));
const instantRequests = (server) => server.requests.filter((request) => request.path === '/api/v1/uploads/instant');

test('a small file skips the probe entirely', async (t) => {
  const h = await createHarness(t);
  const dir = await tempDir(t);
  const file = join(dir, 'tiny.txt');
  await writeFile(file, 'tiny');
  const result = await h.run(['upload', file]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(probeRequests(h.server).length, 0, 'hashing a 4 byte file is pure overhead');
  assert.equal(uploadRequests(h.server).length, 1);
});

test('an unknown hash falls back to a real upload', async (t) => {
  const h = await createHarness(t);
  const dir = await tempDir(t);
  const file = join(dir, 'fresh.bin');
  await writeFile(file, Buffer.alloc(2 * 1024 * 1024, 3));
  const result = await h.run(['upload', file]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(probeRequests(h.server).length, 1, 'the probe ran');
  assert.equal(instantRequests(h.server).length, 0, 'but no instant upload was attempted');
  assert.equal(uploadRequests(h.server).length, 1, 'the bytes were sent normally');
});

test('a known hash creates the node without sending bytes', async (t) => {
  const h = await createHarness(t);
  const dir = await tempDir(t);
  const payload = Buffer.alloc(2 * 1024 * 1024, 9);
  const hash = createHash('sha256').update(payload).digest('hex');
  h.server.state.blobs.set(hash, { size: payload.length, refs: 1 });
  const file = join(dir, 'notes.md');
  await writeFile(file, payload);

  const result = await h.run(['upload', file, '--name', 'copy.md']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0 bytes sent/);
  assert.equal(uploadRequests(h.server).length, 0, 'no bytes were sent');
  const instant = instantRequests(h.server);
  assert.equal(instant.length, 1);
  assert.equal(instant[0].body.sha256, hash);
  assert.equal(instant[0].body.size, payload.length);
});

test('--on-conflict is passed through and validated', async (t) => {
  const h = await createHarness(t);
  const dir = await tempDir(t);
  const file = join(dir, 'clash.txt');
  await writeFile(file, 'clash');
  const accepted = await h.run(['upload', file, '--on-conflict', 'rename']);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(uploadRequests(h.server).at(-1).query.onConflict, 'rename');

  const rejected = await h.run(['upload', file, '--on-conflict', 'explode']);
  assert.equal(rejected.status, 2, 'an unknown strategy is a usage error');
  assert.match(rejected.stderr, /overwrite, rename or skip/);
});

test('--on-conflict defaults to leaving the query off', async (t) => {
  const h = await createHarness(t);
  const dir = await tempDir(t);
  const file = join(dir, 'plain.txt');
  await writeFile(file, 'plain');
  const result = await h.run(['upload', file]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(uploadRequests(h.server).at(-1).query.onConflict, undefined);
});