import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createHarness } from './helpers.mjs';

/**
 * `mdrive sync` through the real entry point.
 *
 * Three failures motivated this file, and each one is only visible end to end:
 *
 *   1. a corrupt download body replaced a good local file before anybody hashed
 *      it, so the run reported CHECKSUM_MISMATCH after the damage was done;
 *   2. `--direction up` and `--direction down` were rejected as usage errors while
 *      the undocumented `upload` value was accepted *without* filtering, so a
 *      "one-way" run propagated deletions in both directions;
 *   3. a failed local unlink was swallowed and reported as a deletion.
 *
 * Every assertion below therefore goes through the CLI binary, a temp directory
 * and the in-process HTTP mock.
 */

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

async function tempDir(t, prefix = 'mdrive-sync-cli-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Reads the baseline the CLI just wrote (there is exactly one per run here). */
async function readBaselines(h) {
  const directory = join(h.configDir, 'sync');
  let names;
  try {
    names = await readdir(directory);
  } catch {
    return {};
  }
  const all = {};
  for (const name of names.filter((entry) => entry.endsWith('.json'))) {
    const parsed = JSON.parse(await readFile(join(directory, name), 'utf8'));
    Object.assign(all, parsed.entries ?? {});
  }
  return all;
}

/** Remote seed through the CLI: creates the folder and uploads each file. */
async function seedRemote(h, folder, files, dir) {
  const made = await h.run(['mkdir', '-p', folder]);
  assert.equal(made.status, 0, made.stderr);
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name);
    await writeFile(path, body);
    const uploaded = await h.run(['upload', path, '--to', folder]);
    assert.equal(uploaded.status, 0, uploaded.stderr);
  }
}

/* ── P0: downloads must be verified before they are published ─────────── */

test('a corrupt sync download leaves the local file and baseline intact, and a retry succeeds', async (t) => {
  const h = await createHarness(t);
  const local = await tempDir(t);
  const staging = await tempDir(t);
  await writeFile(join(local, 'notes.txt'), 'one');
  await seedRemote(h, '/Sync', {}, staging);

  // First run establishes the baseline: local notes.txt is new, so it uploads.
  const first = await h.run(['sync', local, '/Sync']);
  assert.equal(first.status, 0, first.stderr);
  const baselineAfterFirst = await readBaselines(h);
  assert.equal(baselineAfterFirst['notes.txt'].sha256, sha256('one'));

  // Change the remote copy through the CLI, then put the local file back so it
  // still matches the baseline: now only the remote moved, i.e. a download.
  const changed = join(staging, 'notes.txt');
  await writeFile(changed, 'two');
  const upload = await h.run(['upload', changed, '--to', '/Sync']);
  assert.equal(upload.status, 0, upload.stderr);
  await writeFile(join(local, 'notes.txt'), 'one');

  const goodRemoteDigest = sha256('two');
  assert.notEqual(goodRemoteDigest, sha256('one'));

  // The server now answers with bytes that do not match the metadata digest it
  // advertised in the listing. This is the exact shape of the reported bug.
  h.server.state.corrupt = () => Buffer.from('THREE!');
  const corrupt = await h.run(['sync', local, '/Sync', '--rehash']);
  assert.equal(corrupt.status, 1, 'a body that fails its digest is a runtime failure');
  assert.match(corrupt.stdout, /does not hash to the remote digest/);

  assert.equal(
    await readFile(join(local, 'notes.txt'), 'utf8'),
    'one',
    'the good local file is not replaced by an unverified body'
  );
  assert.deepEqual(
    (await readdir(local)).sort(),
    ['notes.txt'],
    'the staging file is cleaned up after the failure'
  );
  const baselineAfterFailure = await readBaselines(h);
  assert.equal(
    baselineAfterFailure['notes.txt'].sha256,
    sha256('one'),
    'a failed download does not advance the baseline'
  );
  assert.equal(baselineAfterFailure['notes.txt'].version, 1);

  // Retry with a healthy response: the same path now succeeds.
  h.server.state.corrupt = null;
  const retry = await h.run(['sync', local, '/Sync', '--rehash']);
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(await readFile(join(local, 'notes.txt'), 'utf8'), 'two');
  assert.deepEqual((await readdir(local)).sort(), ['notes.txt']);
  const baselineAfterRetry = await readBaselines(h);
  assert.equal(baselineAfterRetry['notes.txt'].sha256, goodRemoteDigest);
  assert.equal(baselineAfterRetry['notes.txt'].version, 2);
});

test('a verified sync download replaces an existing file on Windows and elsewhere', async (t) => {
  const h = await createHarness(t);
  const local = await tempDir(t);
  const staging = await tempDir(t);
  await writeFile(join(local, 'doc.txt'), 'local');
  await seedRemote(h, '/Sync', { 'doc.txt': 'remote' }, staging);

  // Baseline adoption is impossible here (both sides exist, bytes differ and
  // there is no history), so establish it with the local content first.
  const conflict = await h.run(['sync', local, '/Sync']);
  assert.equal(conflict.status, 0, conflict.stderr);
  assert.match(conflict.stdout, /CONFLICT/);

  // Give the two sides the same bytes, then move only the remote.
  await writeFile(join(local, 'doc.txt'), 'remote');
  const adopt = await h.run(['sync', local, '/Sync', '--rehash']);
  assert.equal(adopt.status, 0, adopt.stderr);
  const replaced = join(staging, 'doc.txt');
  await writeFile(replaced, 'remote v2');
  const upload = await h.run(['upload', replaced, '--to', '/Sync']);
  assert.equal(upload.status, 0, upload.stderr);

  const result = await h.run(['sync', local, '/Sync', '--rehash']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(local, 'doc.txt'), 'utf8'), 'remote v2');
  assert.equal((await stat(join(local, 'doc.txt'))).isFile(), true);
});

test('a verified sync download replaces a legal 221-character file name', async (t) => {
  // A 221-character name (217 letters + `.txt`) is legal on every supported
  // filesystem, but a staging name built by concatenating the original basename
  // with a UUID and a suffix is 268 characters — past NTFS's 255-character
  // component limit — so the download failed with ENOENT before writing a byte.
  // The staging name is now constant and independent of the destination.
  const h = await createHarness(t);
  const local = await tempDir(t);
  const staging = await tempDir(t);
  const name = 'a'.repeat(217) + '.txt';
  assert.equal(name.length, 221);

  await writeFile(join(local, name), 'local');
  await seedRemote(h, '/Sync', { [name]: 'remote' }, staging);

  // Both sides exist with different bytes and no baseline: the first run only
  // reports a conflict, which is how the baseline gets established below.
  const conflict = await h.run(['sync', local, '/Sync']);
  assert.equal(conflict.status, 0, conflict.stderr);
  assert.match(conflict.stdout, /CONFLICT/);

  // Same bytes on both sides, adopt them, then move only the remote copy.
  await writeFile(join(local, name), 'remote');
  const adopt = await h.run(['sync', local, '/Sync', '--rehash']);
  assert.equal(adopt.status, 0, adopt.stderr);

  const changed = join(staging, name);
  await writeFile(changed, 'remote v2');
  const upload = await h.run(['upload', changed, '--to', '/Sync']);
  assert.equal(upload.status, 0, upload.stderr);

  const result = await h.run(['sync', local, '/Sync', '--rehash']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(local, name), 'utf8'), 'remote v2', 'the verified response replaces the long-named file');
  assert.deepEqual(
    (await readdir(local)).sort(),
    [name],
    'no staging file under any long name is left next to the destination'
  );
});

/* ── P0: direction is one vocabulary, enforced end to end ─────────────── */

test('--direction up uploads only and never downloads, even with --delete', async (t) => {
  const h = await createHarness(t);
  const local = await tempDir(t);
  const staging = await tempDir(t);
  await seedRemote(h, '/Sync', { 'remote.txt': 'server copy' }, staging);
  await writeFile(join(local, 'local.txt'), 'client copy');

  const plan = await h.run(['sync', local, '/Sync', '--direction', 'up', '--delete', '--dry-run', '--json']);
  assert.equal(plan.status, 0, plan.stderr);
  const planned = JSON.parse(plan.stdout);
  assert.equal(planned.summary.upload, 1);
  assert.equal(planned.summary.download, 0, 'a dry-run under up must not plan a download');
  assert.deepEqual(
    planned.plan.filter((op) => op.rel === 'remote.txt').map((op) => op.action),
    ['skipped'],
    'the download is reported as skipped, not silently dropped'
  );

  const result = await h.run(['sync', local, '/Sync', '--direction', 'up', '--delete']);
  assert.equal(result.status, 0, result.stderr);

  const remoteListing = await h.run(['ls', '/Sync']);
  assert.match(remoteListing.stdout, /local\.txt/, 'the local file was uploaded');
  assert.equal(
    await stat(join(local, 'remote.txt')).then(() => true, () => false),
    false,
    'up is one-way: nothing is written locally'
  );
});

test('--direction down downloads only and never uploads, even with --delete', async (t) => {
  const h = await createHarness(t);
  const local = await tempDir(t);
  const staging = await tempDir(t);
  await seedRemote(h, '/Sync', { 'remote.txt': 'server copy' }, staging);
  await writeFile(join(local, 'local.txt'), 'client copy');

  const result = await h.run(['sync', local, '/Sync', '--direction', 'down', '--delete']);
  assert.equal(result.status, 0, result.stderr);

  assert.equal(await readFile(join(local, 'remote.txt'), 'utf8'), 'server copy');
  const remoteListing = await h.run(['ls', '/Sync']);
  assert.doesNotMatch(remoteListing.stdout, /local\.txt/, 'down is one-way: nothing is uploaded');
  assert.match(remoteListing.stdout, /remote\.txt/);
});

test('a remote deletion with --direction up --delete leaves the local file alone', async (t) => {
  // The reported data-loss case: `--direction upload --delete` deleted the local
  // copy of a file that had only been removed remotely.
  const h = await createHarness(t);
  const local = await tempDir(t);
  const staging = await tempDir(t);
  await seedRemote(h, '/Sync', { 'keep.txt': 'precious' }, staging);
  await writeFile(join(local, 'keep.txt'), 'precious');

  const first = await h.run(['sync', local, '/Sync', '--rehash']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(
    (await h.run(['sync', local, '/Sync', '--rehash', '--json'])).status,
    0,
    'the second run is a no-op'
  );
  const noop = JSON.parse((await h.run(['sync', local, '/Sync', '--rehash', '--json'])).stdout);
  assert.equal(noop.summary.unchanged, 1, 'both sides already matched');

  const removed = await h.run(['rm', '/Sync/keep.txt']);
  assert.equal(removed.status, 0, removed.stderr);

  for (const direction of ['up', 'upload']) {
    const result = await h.run(['sync', local, '/Sync', '--direction', direction, '--delete', '--rehash']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      await readFile(join(local, 'keep.txt'), 'utf8'),
      'precious',
      '--direction ' + direction + ' must not propagate a remote deletion to the local tree'
    );
  }

  const dryRun = await h.run(['sync', local, '/Sync', '--direction', 'up', '--delete', '--dry-run', '--json']);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(JSON.parse(dryRun.stdout).summary['remote-deleted'] ?? 0, 0, 'the dry-run does not promise a local delete');

  // The same deletion is a download-direction change, so `down --delete` applies it.
  const down = await h.run(['sync', local, '/Sync', '--direction', 'down', '--delete', '--rehash']);
  assert.equal(down.status, 0, down.stderr);
  assert.equal(await stat(join(local, 'keep.txt')).then(() => true, () => false), false);
});

test('a local deletion with --direction down --delete leaves the remote file alone', async (t) => {
  const h = await createHarness(t);
  const local = await tempDir(t);
  const staging = await tempDir(t);
  await seedRemote(h, '/Sync', { 'lifted.txt': 'keep me' }, staging);
  await writeFile(join(local, 'lifted.txt'), 'keep me');
  assert.equal((await h.run(['sync', local, '/Sync', '--rehash'])).status, 0);
  await rm(join(local, 'lifted.txt'));

  const down = await h.run(['sync', local, '/Sync', '--direction', 'down', '--delete', '--rehash']);
  assert.equal(down.status, 0, down.stderr);
  const listing = await h.run(['ls', '/Sync']);
  assert.match(listing.stdout, /lifted\.txt/, 'down must not propagate a local deletion to the remote tree');

  const dryRun = await h.run(['sync', local, '/Sync', '--direction', 'down', '--delete', '--dry-run', '--json']);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(JSON.parse(dryRun.stdout).summary['local-deleted'] ?? 0, 0);

  // up --delete is the direction that owns a local deletion, so it removes it remotely.
  const up = await h.run(['sync', local, '/Sync', '--direction', 'up', '--delete']);
  assert.equal(up.status, 0, up.stderr);
  const after = await h.run(['ls', '/Sync']);
  assert.doesNotMatch(after.stdout, /lifted\.txt/);
});

test('--delete is required for deletion in every direction and the default is both', async (t) => {
  const h = await createHarness(t);
  const local = await tempDir(t);
  const staging = await tempDir(t);
  await seedRemote(h, '/Sync', { 'gone.txt': 'remembered' }, staging);
  await writeFile(join(local, 'gone.txt'), 'remembered');
  assert.equal((await h.run(['sync', local, '/Sync', '--rehash'])).status, 0);
  await h.run(['rm', '/Sync/gone.txt']);

  // No --delete: reported, never performed. A remote deletion travels in the
  // download direction, so `up` does not even report it as pending — it is out of
  // that direction entirely.
  for (const direction of ['down', 'both']) {
    const result = await h.run(['sync', local, '/Sync', '--direction', direction, '--rehash', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.pendingDeletes.length, 1, direction + ' must report the pending deletion');
    assert.equal(payload.deletedLocal, 0, direction + ' must not delete locally without --delete');
    assert.equal(
      await readFile(join(local, 'gone.txt'), 'utf8'),
      'remembered',
      direction + ' without --delete keeps the file'
    );
  }

  const up = JSON.parse((await h.run(['sync', local, '/Sync', '--direction', 'up', '--rehash', '--json'])).stdout);
  assert.equal(up.pendingDeletes.length, 0);
  assert.equal(up.summary.skipped, 1, 'a remote deletion is simply not an upload-direction change');
  assert.equal(await readFile(join(local, 'gone.txt'), 'utf8'), 'remembered');

  const human = await h.run(['sync', local, '/Sync', '--rehash']);
  assert.match(human.stdout, /were left alone\. Re-run with --delete/);

  // Default (no --direction) is both directions: a local-only file uploads and a
  // remote-only file downloads in the same run.
  await writeFile(join(local, 'brand-new.txt'), 'from the laptop');
  const both = await h.run(['sync', local, '/Sync', '--rehash']);
  assert.equal(both.status, 0, both.stderr);
  assert.match((await h.run(['ls', '/Sync'])).stdout, /brand-new\.txt/);
  assert.match(both.stdout, /uploaded\s+1/);
});

test('unknown and pseudo-unidirectional --direction values are usage errors', async (t) => {
  const h = await createHarness(t);
  const local = await tempDir(t);
  await h.run(['mkdir', '-p', '/Sync']);

  for (const value of ['none', 'sideways', 'upload-only', 'both ways', 'UPONLY']) {
    const result = await h.run(['sync', local, '/Sync', '--direction', value, '--dry-run']);
    assert.equal(result.status, 2, '--direction ' + value + ' must be rejected');
    assert.match(result.stderr, /--direction must be up, down, both/);
  }
});

test('legacy direction aliases behave exactly like the modes they name', async (t) => {
  const h = await createHarness(t);
  const local = await tempDir(t);
  const staging = await tempDir(t);
  await seedRemote(h, '/Sync', { 'remote.txt': 'server copy' }, staging);
  await writeFile(join(local, 'local.txt'), 'client copy');

  // `upload` used to bypass the filter entirely. It is now `up`.
  const up = await h.run(['sync', local, '/Sync', '--direction', 'upload']);
  assert.equal(up.status, 0, up.stderr);
  assert.equal(
    await stat(join(local, 'remote.txt')).then(() => true, () => false),
    false,
    'the upload alias must not download'
  );
  assert.match((await h.run(['ls', '/Sync'])).stdout, /local\.txt/);

  // ...and `download` is `down`: it must not push the local file up.
  await writeFile(join(local, 'only-local.txt'), 'not for the server');
  const down = await h.run(['sync', local, '/Sync', '--direction', 'download']);
  assert.equal(down.status, 0, down.stderr);
  assert.equal(await readFile(join(local, 'remote.txt'), 'utf8'), 'server copy');
  assert.doesNotMatch((await h.run(['ls', '/Sync'])).stdout, /only-local\.txt/);
});

test('a failed local unlink fails the run and keeps the path in the baseline', async (t) => {
  // The bug: `unlink(...).catch(() => {})` swallowed EACCES/EBUSY/EPERM and then
  // incremented `deletedLocal`, so a file the sync could not remove was counted
  // as deleted and vanished from the baseline.
  //
  // The failure is produced at a deterministic point instead of through file
  // permissions, which no platform agrees on: while the CLI waits on the one
  // upload the plan contains, the server hook replaces one local file with a
  // directory (unlink of a directory fails everywhere) and removes another
  // outright (unlink then answers ENOENT, which *is* convergence).
  const h = await createHarness(t);
  const local = await tempDir(t);
  const staging = await tempDir(t);
  await seedRemote(h, '/Sync', { 'blocked.txt': 'remote bytes', 'vanish.txt': 'also remote' }, staging);
  await writeFile(join(local, 'blocked.txt'), 'remote bytes');
  await writeFile(join(local, 'vanish.txt'), 'also remote');
  assert.equal((await h.run(['sync', local, '/Sync', '--rehash'])).status, 0);

  const before = await readBaselines(h);
  assert.equal(before['blocked.txt'].sha256, sha256('remote bytes'));
  assert.equal(before['vanish.txt'].sha256, sha256('also remote'));
  const blockedId = before['blocked.txt'].remoteId;
  const vanishId = before['vanish.txt'].remoteId;

  // Both remote nodes go away, so both paths plan as remote deletions. A brand
  // new local file whose name sorts first forces one upload, which is the hook's
  // trigger point — the upload runs before either deletion.
  assert.equal((await h.run(['rm', '/Sync/blocked.txt'])).status, 0);
  assert.equal((await h.run(['rm', '/Sync/vanish.txt'])).status, 0);
  await writeFile(join(local, 'aaa-trigger.txt'), 'new local file');

  h.server.state.hooks.onRequest = async ({ method, path }) => {
    if (method !== 'PUT' || path !== '/api/v1/uploads') return;
    await rm(join(local, 'blocked.txt'), { force: true });
    await mkdir(join(local, 'blocked.txt'), { recursive: true });
    await rm(join(local, 'vanish.txt'), { force: true });
  };

  const result = await h.run(['sync', local, '/Sync', '--delete', '--rehash', '--json']);
  assert.equal(result.status, 1, 'a deletion that did not happen is a runtime failure');
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.uploaded, 1, 'the trigger file uploaded, so the hook ran');
  assert.equal(payload.failed.length, 1, 'only the obstructed path failed');
  assert.equal(payload.failed[0].rel, 'blocked.txt');
  assert.equal(payload.deletedLocal, 1, 'the vanished file converged and is counted once');

  const after = await readBaselines(h);
  assert.ok(after['blocked.txt'], 'the failed path keeps its baseline row so the next run retries it');
  assert.equal(after['blocked.txt'].sha256, before['blocked.txt'].sha256);
  assert.equal(after['blocked.txt'].remoteId, blockedId);
  assert.equal(after['vanish.txt'], undefined, 'ENOENT is convergence, so its row is dropped');
  assert.notEqual(after['blocked.txt'].remoteId, vanishId);
  assert.equal((await stat(join(local, 'blocked.txt'))).isDirectory(), true, 'the obstructing entry is not removed');
});

test('a local file that is already gone is convergence, not a failure', async (t) => {
  // Same deterministic seam, without the obstruction: the local file simply
  // disappears before it is unlinked, which is the one case that counts as done.
  const h = await createHarness(t);
  const local = await tempDir(t);
  const staging = await tempDir(t);
  await seedRemote(h, '/Sync', { 'gone.txt': 'remembered' }, staging);
  await writeFile(join(local, 'gone.txt'), 'remembered');
  assert.equal((await h.run(['sync', local, '/Sync', '--rehash'])).status, 0);
  assert.equal((await h.run(['rm', '/Sync/gone.txt'])).status, 0);
  await writeFile(join(local, 'upload-trigger.txt'), 'new local file');

  h.server.state.hooks.onRequest = async ({ method, path }) => {
    if (method !== 'PUT' || path !== '/api/v1/uploads') return;
    await rm(join(local, 'gone.txt'), { force: true });
  };

  const result = await h.run(['sync', local, '/Sync', '--direction', 'down', '--delete', '--rehash', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.failed.length, 0);
  assert.equal(payload.deletedLocal, 1, 'an absent file is converged and counted as such');
  assert.equal((await readBaselines(h))['gone.txt'], undefined, 'the baseline drops a genuinely converged path');
});

test('sync --help documents the modes the command accepts', async (t) => {
  const h = await createHarness(t);
  const help = await h.run(['sync', '--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--direction MODE\s+up \(local→remote\), down \(remote→local\), or both/);
});
