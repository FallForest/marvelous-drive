import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  REASON_TEXT, baselinePath, executePlan, hashFile, isSyncStagingName, planSync, readBaseline,
  restrictPlan, scanLocal, summarize, temporaryPathFor, writeBaseline,
} from '../src/sync.js';

/**
 * The sync decision table.
 *
 * This is the part of sync that can destroy data, so it is tested as a pure
 * function over three snapshots: local, remote, baseline. Every case below is a
 * real situation a photo library produces:
 *
 *   - a new folder of photos appears locally (upload, no question);
 *   - the same photo is edited on the laptop while the phone added bytes to the
 *     remote copy (conflict — must never be resolved automatically);
 *   - the baseline says "in sync" but the remote is gone (a deletion, which is
 *     only acted on with --delete);
 *   - a first run with no baseline at all (adopt identical files, refuse to
 *     guess when both sides differ).
 */

const entry = (sha256, size = 10) => ({ sha256, size, mtimeMs: 0, absolute: '/tmp/x' });
const remoteEntry = (sha256, version = 1, size = 10) => ({ id: 'node-' + sha256, sha256, size, version });

/** Plans one path and returns its single operation. */
function planOne({ local, remote, base }) {
  const ops = planSync({
    local: new Map(local === undefined ? [] : [['a.jpg', entry(local)]]),
    remote: new Map(remote === undefined ? [] : [['a.jpg', remoteEntry(remote)]]),
    baseline: { entries: base === undefined ? {} : { 'a.jpg': { sha256: base, size: 10, remoteId: 'node-' + base, version: 1 } } },
  });
  return ops.find((op) => op.rel === 'a.jpg');
}

describe('planSync: identical content', () => {
  it('is a no-op, baseline refreshed', () => {
    assert.equal(planOne({ local: 'aaa', remote: 'aaa' }).action, 'unchanged');
  });

  it('adopts on a first run rather than uploading', () => {
    // No baseline, identical bytes: there is nothing to transfer and nothing to
    // arbitrate, so the first run simply records the agreement.
    assert.equal(planOne({ local: 'aaa', remote: 'aaa', base: undefined }).action, 'unchanged');
  });
});

describe('planSync: one side changed', () => {
  it('uploads when only local content moved', () => {
    const op = planOne({ local: 'new', remote: 'old', base: 'old' });
    assert.equal(op.action, 'upload');
    assert.equal(op.reason, 'local-changed');
    assert.equal(op.remoteVersion, 1, 'the version travels with the op so it can be re-checked before writing');
  });

  it('downloads when only remote content moved', () => {
    const op = planOne({ local: 'old', remote: 'new', base: 'old' });
    assert.equal(op.action, 'download');
    assert.equal(op.reason, 'remote-changed');
  });
});

describe('planSync: conflicts are never guessed at', () => {
  it('refuses when both sides moved', () => {
    const op = planOne({ local: 'mine', remote: 'theirs', base: 'old' });
    assert.equal(op.action, 'conflict');
    assert.equal(op.reason, 'both-changed');
  });

  it('refuses on a first run when both sides differ', () => {
    const op = planOne({ local: 'mine', remote: 'theirs', base: undefined });
    assert.equal(op.action, 'conflict');
    assert.equal(op.reason, 'no-baseline');
  });

  it('refuses when the file was deleted remotely but edited locally', () => {
    const op = planOne({ local: 'edited', remote: undefined, base: 'old' });
    assert.equal(op.action, 'conflict');
    assert.equal(op.reason, 'deleted-remotely-but-changed-locally');
  });

  it('refuses when the file was deleted locally but edited remotely', () => {
    const op = planOne({ local: undefined, remote: 'edited', base: 'old' });
    assert.equal(op.action, 'conflict');
    assert.equal(op.reason, 'deleted-locally-but-changed-remotely');
  });
});

describe('planSync: addition and deletion', () => {
  it('uploads a file that exists only locally and is unknown to the baseline', () => {
    const op = planOne({ local: 'new', remote: undefined, base: undefined });
    assert.equal(op.action, 'upload');
    assert.equal(op.reason, 'new');
  });

  it('downloads a file that exists only remotely and is unknown to the baseline', () => {
    const op = planOne({ local: undefined, remote: 'fresh', base: undefined });
    assert.equal(op.action, 'download');
    assert.equal(op.reason, 'remote-only');
  });

  it('treats "in baseline, unchanged locally, gone remotely" as a remote deletion', () => {
    const op = planOne({ local: 'same', remote: undefined, base: 'same' });
    assert.equal(op.action, 'remote-deleted');
  });

  it('treats "in baseline, unchanged remotely, gone locally" as a local deletion', () => {
    const op = planOne({ local: undefined, remote: 'same', base: 'same' });
    assert.equal(op.action, 'local-deleted');
  });

  it('forgets a path that is gone on both sides', () => {
    const ops = planSync({
      local: new Map(),
      remote: new Map(),
      baseline: { entries: { 'ghost.jpg': { sha256: 'x', size: 1, remoteId: 'n', version: 1 } } },
    });
    assert.equal(ops.length, 1);
    assert.equal(ops[0].action, 'forget');
  });
});

describe('planSync: an inconsistent baseline cannot cause a guess', () => {
  it('when both sides differ from each other and from the baseline, it is a conflict', () => {
    // The only reachable "neither moved" case is logical impossibility: if both
    // sides differ from the baseline they both moved, so this must be a conflict.
    // The baseline-desync branch exists for the mirror case, where one side equals
    // the baseline and the other does not — and that is a plain upload/download.
    const op = planOne({ local: 'mine', remote: 'theirs', base: 'third' });
    assert.equal(op.action, 'conflict');
    assert.equal(op.reason, 'both-changed');
  });

  it('a stale baseline agreeing with local still uploads a changed remote', () => {
    const op = planOne({ local: 'same', remote: 'changed', base: 'same' });
    assert.equal(op.action, 'download');
  });
});

describe('summarize', () => {
  it('counts actions and only sums bytes for real transfers', () => {
    const summary = summarize([
      { action: 'upload', size: 100 },
      { action: 'upload', size: 50 },
      { action: 'download', size: 7 },
      { action: 'unchanged', size: 999 },
      { action: 'conflict', size: 5 },
    ]);
    assert.equal(summary.upload, 2);
    assert.equal(summary.download, 1);
    assert.equal(summary.bytesUp, 150);
    assert.equal(summary.bytesDown, 7);
    assert.equal(summary.unchanged, 1);
  });

  it('every reason has human text', () => {
    // A conflict printed as a bare code is a conflict nobody understands.
    for (const reason of ['new', 'local-changed', 'remote-changed', 'remote-only', 'no-baseline',
      'both-changed', 'baseline-desync', 'deleted-remotely-but-changed-locally',
      'deleted-locally-but-changed-remotely', 'remote-version-moved']) {
      assert.equal(typeof REASON_TEXT[reason], 'string', reason + ' has no description');
    }
  });
});

/* ── the filesystem half ──────────────────────────────────────────────── */

let workspace;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'mdrive-sync-test-'));
});

after(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe('scanLocal', () => {
  it('hashes every file and keys by posix relative path', async () => {
    const root = join(workspace, 'scan');
    await mkdir(join(root, '2026', '2026-01'), { recursive: true });
    await writeFile(join(root, 'a.jpg'), 'alpha');
    await writeFile(join(root, '2026', '2026-01', 'b.jpg'), 'beta');

    const files = await scanLocal(root);
    assert.deepEqual([...files.keys()].sort(), ['2026/2026-01/b.jpg', 'a.jpg']);
    assert.equal(files.get('a.jpg').sha256, await hashFile(join(root, 'a.jpg')));
    assert.equal(files.get('a.jpg').size, 5);
  });

  it('reuses the cache when size and mtime match, and re-reads when asked', async () => {
    const root = join(workspace, 'cache');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'x.jpg'), 'content');

    const first = await scanLocal(root);
    const cached = {};
    for (const [rel, info] of first) cached[rel] = { size: info.size, mtimeMs: info.mtimeMs, sha256: info.sha256 };

    let rehashed = 0;
    const second = await scanLocal(root, { cache: cached, onProgress: () => { rehashed += 1; } });
    assert.equal(rehashed, 0, 'a cached file is not read again');
    assert.equal(second.get('x.jpg').sha256, first.get('x.jpg').sha256);

    const forced = await scanLocal(root, { cache: cached, rehash: true });
    assert.equal(forced.get('x.jpg').sha256, first.get('x.jpg').sha256);
  });

  it('ignores directories as entries and keeps empty folders out of the file map', async () => {
    const root = join(workspace, 'empty');
    await mkdir(join(root, 'only-dirs', 'deeper'), { recursive: true });
    const files = await scanLocal(root);
    assert.equal(files.size, 0);
  });

  it('ignores a leftover download staging file', async () => {
    const root = join(workspace, 'staging-leftover');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'photo.jpg'), 'real');
    const staging = temporaryPathFor(join(root, 'photo.jpg'));
    await writeFile(staging, 'partial');
    // The transfer layer stages once more inside that path (`<staging>.<pid>.part`).
    await writeFile(staging + '.4242.part', 'partial');
    assert.equal(isSyncStagingName(staging.split(/[\\/]/).pop()), true);
    const files = await scanLocal(root);
    assert.deepEqual([...files.keys()], ['photo.jpg'], 'a half-downloaded staging file is not user data');
  });

  it('keeps the staging name constant and never ignores a look-alike user file', async () => {
    const longName = join(workspace, 'a'.repeat(217) + '.txt');
    const staging = temporaryPathFor(longName);
    const stagingName = staging.split(/[\\/]/).pop();
    const shortStaging = temporaryPathFor(join(workspace, 'a.txt'));
    // NTFS caps one path component at 255 characters; a legal 221-character name
    // plus a basename copy, a UUID and a suffix was 268 and every download of it
    // failed with ENOENT.
    assert.ok(stagingName.length < 255, 'the staging name fits in one component');
    assert.ok(stagingName.length <= 80, 'the staging name does not grow with the destination');
    assert.equal(dirname(staging), dirname(longName), 'staging stays next to the destination for an atomic rename');
    assert.equal(shortStaging.length, staging.length, 'the length does not depend on the destination name');
    assert.notEqual(temporaryPathFor(longName), temporaryPathFor(longName), 'each staging path is unique');
    assert.equal(isSyncStagingName(stagingName), true);
    // The transfer layer's own `<staging>.<pid>.part` tail is covered too.
    assert.equal(isSyncStagingName(stagingName + '.4242.part'), true);

    // A long ordinary file and a name the user made up are data, not staging.
    assert.equal(isSyncStagingName('a'.repeat(217) + '.txt'), false);
    assert.equal(isSyncStagingName('report.123e4567-e89b-12d3-a456-426614174000.sync-part'), false);
    assert.equal(isSyncStagingName('mdrive-sync-123e4567-e89b-12d3-a456-426614174000.sync-part'), false);
    assert.equal(isSyncStagingName('.mdrive-sync-not-a-uuid.sync-part'), false);
  });
});

describe('baseline', () => {
  it('round-trips and is keyed by the (server, local root, remote path) triple', async () => {
    const path = baselinePath('/local/photos', '/照片', 'http://127.0.0.1:4400');
    await writeBaseline(path, { version: 1, entries: { 'a.jpg': { sha256: 'abc', size: 1, remoteId: 'n1', version: 3 } } });
    const back = await readBaseline(path);
    assert.equal(back.entries['a.jpg'].sha256, 'abc');
    assert.equal(back.entries['a.jpg'].version, 3);
    await rm(path, { force: true });
  });

  it('two remote paths on the same local folder get separate memories', () => {
    const a = baselinePath('/local/photos', '/Photos', 'http://s');
    const b = baselinePath('/local/photos', '/Backup', 'http://s');
    assert.notEqual(a, b);
  });

  it('a missing or corrupt file reads as an empty baseline', async () => {
    const missing = baselinePath('/nope', '/nope', 'http://s');
    const empty = await readBaseline(missing);
    assert.deepEqual(empty.entries, {});

    const corrupt = join(workspace, 'corrupt.json');
    await writeFile(corrupt, '{ not json');
    const recovered = await readBaseline(corrupt);
    assert.deepEqual(recovered.entries, {});
  });
});

/* ── execution against a fake client ──────────────────────────────────── */

/** A client stub that records what would have been sent. */
function fakeClient({ remoteFiles = new Map() } = {}) {
  const calls = [];
  return {
    calls,
    async get(path) {
      calls.push(['GET', path]);
      const match = /^\/nodes\/(.+)$/.exec(path);
      if (match) {
        const id = decodeURIComponent(match[1]);
        for (const entry of remoteFiles.values()) if (entry.id === id) return { node: { id, version: entry.version } };
        return { node: null };
      }
      return { nodes: [] };
    },
    async request(method, path, options) {
      calls.push([method, path, options?.body]);
      if (method === 'DELETE') return { ok: true };
      return { node: { id: 'created-' + calls.length, version: 1 } };
    },
    async download(path, options) {
      calls.push(['DOWNLOAD', path]);
      return { path: options.destination };
    },
  };
}

/** Transfers that never touch the network unless a test replaces them. */
const noTransfers = {
  instantUpload: async () => null,
  uploadSimple: async () => ({ node: { id: 'uploaded', version: 1 } }),
  uploadResumable: async () => ({ node: { id: 'uploaded', version: 1 } }),
};

describe('executePlan', () => {
  it('creates parent folders before uploading, so a tree does not flatten into the root', async () => {
    // The bug this pins: `ensureRemoteFolders` existed but was never called, so
    // every subdirectory file uploaded with parentId=null. Each upload reported
    // success and the remote ended up with a flat pile at the root — a failure
    // that looks like success, which is the worst kind.
    const root = join(workspace, 'folders');
    await mkdir(join(root, '2026', '2026-11'), { recursive: true });
    await writeFile(join(root, '2026', '2026-11', 'a.jpg'), 'photo bytes');

    const created = [];
    const uploads = [];
    const transfers = {
      instantUpload: async () => null,   // no dedup hit in this test
      uploadSimple: async (client, options) => {
        uploads.push(options);
        return { node: { id: 'file-a', version: 1 } };
      },
      uploadResumable: async () => { throw new Error('a 11-byte file must not use the resumable path'); },
    };

    const outcome = await executePlan(fakeClient(), {
      ops: [{ rel: '2026/2026-11/a.jpg', action: 'upload', reason: 'new', size: 11, localSha: 'abc' }],
      folders: new Map([['', 'root-id']]),
      localRoot: root,
      baselineEntries: {},
      options: {},
      write: async (path, body) => {
        created.push({ path, body });
        return { id: 'folder-' + body.name };
      },
      log: () => {},
      transfers,
    });

    const folderWrites = created.filter((call) => call.body.kind === 'folder');
    assert.deepEqual(folderWrites.map((call) => call.body.name), ['2026', '2026-11']);
    assert.equal(folderWrites[0].body.parentId, 'root-id', 'the top folder hangs off the remote root');
    assert.equal(folderWrites[1].body.parentId, 'folder-2026', 'the nested folder hangs off its parent');

    // The file itself must land inside the deepest folder, not the root.
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].parentId, 'folder-2026-11', 'the upload targets its real parent');
    assert.equal(uploads[0].name, 'a.jpg');
    assert.equal(outcome.failed.length, 0);
  });

  it('does not re-create a folder that already exists remotely', async () => {
    const root = join(workspace, 'existing');
    await mkdir(join(root, '2026'), { recursive: true });
    await writeFile(join(root, '2026', 'a.jpg'), 'x');
    const created = [];
    await executePlan(fakeClient(), {
      ops: [{ rel: '2026/a.jpg', action: 'upload', size: 1, localSha: 'a' }],
      folders: new Map([['', 'root-id'], ['2026', 'known-folder-id']]),
      localRoot: root,
      baselineEntries: {},
      options: {},
      write: async (path, body) => { created.push(body); return { id: 'new' }; },
      log: () => {},
      transfers: noTransfers,
    });
    assert.equal(created.filter((body) => body.kind === 'folder').length, 0, 'an existing folder costs no request');
  });

  it('refuses to upload when the remote version moved under it', async () => {
    const root = join(workspace, 'exec');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'a.jpg'), 'local bytes');

    const client = fakeClient({ remoteFiles: new Map([['a.jpg', remoteEntry('old', 7)]]) });
    const outcome = await executePlan(client, {
      ops: [{ rel: 'a.jpg', action: 'upload', reason: 'local-changed', size: 11, localSha: 'new', remoteId: 'node-old', remoteVersion: 2 }],
      folders: new Map([['', 'root-id']]),
      localRoot: root,
      baselineEntries: {},
      // version moved 2 -> 7 since the plan was made
      options: {},
      write: async (path, body) => ({ id: 'x' }),
      log: () => {},
      transfers: noTransfers,
    });
    assert.equal(outcome.uploaded, 0);
    assert.equal(outcome.conflicts.length, 1);
    assert.equal(outcome.conflicts[0].reason, 'remote-version-moved');
    assert.ok(!client.calls.some((call) => call[0] === 'POST' && String(call[1]).startsWith('/uploads')));
  });

  it('does not touch a conflict', async () => {
    const root = join(workspace, 'conflict');
    await mkdir(root, { recursive: true });
    const client = fakeClient();
    const outcome = await executePlan(client, {
      ops: [{ rel: 'a.jpg', action: 'conflict', reason: 'both-changed', size: 1, localSha: 'a', remoteSha: 'b' }],
      folders: new Map([['', 'root-id']]),
      localRoot: root,
      baselineEntries: {},
      options: {},
      write: async () => null,
      log: () => {},
      transfers: noTransfers,
    });
    assert.equal(outcome.conflicts.length, 1);
    assert.equal(client.calls.length, 0, 'a conflict must not generate a single request');
  });

  it('reports deletions instead of performing them without --delete', async () => {
    const root = join(workspace, 'deldry');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'gone.jpg'), 'still here');
    const client = fakeClient();
    const outcome = await executePlan(client, {
      ops: [{ rel: 'gone.jpg', action: 'remote-deleted', size: 0, remoteId: 'node-gone' }],
      folders: new Map([['', 'root-id']]),
      localRoot: root,
      baselineEntries: {},
      options: { delete: false },
      write: async () => null,
      log: () => {},
      transfers: noTransfers,
    });
    assert.equal(outcome.pendingDeletes.length, 1);
    assert.equal(outcome.deletedLocal, 0);
    assert.equal(client.calls.length, 0);
    assert.equal((await stat(join(root, 'gone.jpg'))).size, 10, 'the local file is untouched');
  });

  it('deletes the remote node when --delete is set and the local copy is gone', async () => {
    const root = join(workspace, 'del');
    await mkdir(root, { recursive: true });
    const client = fakeClient();
    const deleted = [];
    const outcome = await executePlan(client, {
      ops: [{ rel: 'lifted.jpg', action: 'local-deleted', size: 0, remoteId: 'node-lifted' }],
      folders: new Map([['', 'root-id']]),
      localRoot: root,
      baselineEntries: { 'lifted.jpg': { sha256: 'x', size: 1, remoteId: 'node-lifted', version: 1 } },
      options: { delete: true },
      write: async (path, body, ws, method) => { deleted.push([method, path]); return null; },
      log: () => {},
      transfers: noTransfers,
    });
    assert.equal(outcome.deletedRemote, 1);
    assert.deepEqual(deleted, [['DELETE', '/nodes/node-lifted']]);
    assert.equal(outcome.entries['lifted.jpg'], undefined, 'the baseline forgets the path');
  });

  it('advances the baseline only for successes', async () => {
    const root = join(workspace, 'partial');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'ok.jpg'), 'fine');
    const client = fakeClient();
    // Force the upload path to fail by making the write helper throw.
    const outcome = await executePlan(client, {
      ops: [
        { rel: 'bad.jpg', action: 'upload', size: 10, localSha: 'b' },
      ],
      folders: new Map([['', 'root-id']]),
      localRoot: root,
      baselineEntries: {},
      options: {},
      write: async () => { throw new Error('network down'); },
      log: () => {},
    });
    assert.equal(outcome.failed.length, 1);
    assert.equal(outcome.entries['bad.jpg'], undefined, 'a failed path must be retried next run, not marked synced');
  });

  it('keeps the old file and drops the staging file when the body does not match its digest', async () => {
    const root = join(workspace, 'staged-bad');
    await mkdir(root, { recursive: true });
    const destination = join(root, 'photo.jpg');
    await writeFile(destination, 'good local bytes');
    const existing = await readFile(destination);

    // A client that answers the request with the *wrong* bytes, which is what a
    // corrupt or truncated response looks like to the caller.
    const client = {
      ...fakeClient(),
      async download(path, options) { await writeFile(options.destination, 'corrupt payload'); return { path: options.destination }; },
    };
    const outcome = await executePlan(client, {
      ops: [{ rel: 'photo.jpg', action: 'download', reason: 'remote-changed', size: 16, remoteId: 'node-photo', remoteSha: 'a'.repeat(64), remoteVersion: 2 }],
      folders: new Map([['', 'root-id']]),
      localRoot: root,
      baselineEntries: { 'photo.jpg': { sha256: 'f'.repeat(64), size: 16, remoteId: 'node-photo', version: 1 } },
      options: {},
      write: async () => null,
      log: () => {},
      transfers: noTransfers,
    });

    assert.equal(outcome.failed.length, 1);
    assert.match(outcome.failed[0].message, /does not hash/);
    assert.deepEqual(await readFile(destination), existing, 'the good local file survives a corrupt response');
    assert.equal(outcome.downloaded, 0);
    assert.deepEqual(
      (await readdir(root)).sort(),
      ['photo.jpg'],
      'no staging file is left behind'
    );
    assert.equal(outcome.entries['photo.jpg'].version, 1, 'the baseline stays at the last agreed state');
  });

  it('publishes a verified download by replacing the existing file', async () => {
    const root = join(workspace, 'staged-good');
    await mkdir(root, { recursive: true });
    const destination = join(root, 'photo.jpg');
    await writeFile(destination, 'old bytes');
    const body = 'new bytes';
    const sha = createHash('sha256').update(body).digest('hex');

    const seen = [];
    const client = {
      ...fakeClient(),
      async download(path, options) {
        seen.push(options.destination);
        await writeFile(options.destination, body);
        return { path: options.destination };
      },
    };
    const outcome = await executePlan(client, {
      ops: [{ rel: 'photo.jpg', action: 'download', reason: 'remote-changed', size: body.length, remoteId: 'node-photo', remoteSha: sha, remoteVersion: 2 }],
      folders: new Map([['', 'root-id']]),
      localRoot: root,
      baselineEntries: {},
      options: {},
      write: async () => null,
      log: () => {},
      transfers: noTransfers,
    });

    assert.equal(outcome.failed.length, 0);
    assert.equal(outcome.downloaded, 1);
    assert.equal(await readFile(destination, 'utf8'), body);
    assert.notEqual(seen[0], destination, 'the response never lands on the destination first');
    assert.deepEqual((await readdir(root)), ['photo.jpg'], 'the staging file is renamed away');
    assert.equal(outcome.entries['photo.jpg'].sha256, sha);
  });

  it('counts an already missing local file as converged but fails a real unlink error', async () => {
    const root = join(workspace, 'unlink');
    await mkdir(join(root, 'gone-as-dir'), { recursive: true });
    await writeFile(join(root, 'gone.jpg'), 'x');
    const client = fakeClient();

    // A directory at the path of a file that was deleted remotely: unlink cannot
    // remove it on any platform, which is a deterministic, controlled failure.
    // `already-absent.jpg` never existed locally, so unlink answers ENOENT and
    // that is convergence, not a failure.
    const outcome = await executePlan(client, {
      ops: [
        { rel: 'gone.jpg', action: 'remote-deleted', size: 0, remoteId: 'node-gone' },
        { rel: 'already-absent.jpg', action: 'remote-deleted', size: 0, remoteId: 'node-absent' },
        { rel: 'gone-as-dir', action: 'remote-deleted', size: 0, remoteId: 'node-dir' },
      ],
      folders: new Map([['', 'root-id']]),
      localRoot: root,
      baselineEntries: {
        'gone.jpg': { sha256: 'a', size: 1, remoteId: 'node-gone', version: 1 },
        'already-absent.jpg': { sha256: 'c', size: 1, remoteId: 'node-absent', version: 1 },
        'gone-as-dir': { sha256: 'b', size: 1, remoteId: 'node-dir', version: 1 },
      },
      options: { delete: true },
      write: async () => null,
      log: () => {},
      transfers: noTransfers,
    });

    assert.equal(outcome.deletedLocal, 2, 'the removed file and the already-absent one both count as converged');
    assert.equal(outcome.failed.length, 1);
    assert.equal(outcome.failed[0].rel, 'gone-as-dir');
    assert.equal(await stat(join(root, 'gone-as-dir')).then((info) => info.isDirectory()), true);
    assert.equal(outcome.entries['gone.jpg'], undefined);
    assert.equal(outcome.entries['already-absent.jpg'], undefined, 'ENOENT converges, so the row is dropped');
    assert.ok(outcome.entries['gone-as-dir'], 'a failed deletion keeps its baseline row so it is retried');
    assert.equal(outcome.entries['gone-as-dir'].version, 1);
  });
});

describe('restrictPlan: one direction table for the plan and the run', () => {
  const ops = () => ([
    { rel: 'up-only.jpg', action: 'upload', size: 1 },
    { rel: 'down-only.jpg', action: 'download', size: 1, remoteId: 'n1', remoteSha: 'x' },
    { rel: 'remote-gone.jpg', action: 'remote-deleted', size: 0, remoteId: 'n2' },
    { rel: 'local-gone.jpg', action: 'local-deleted', size: 0, remoteId: 'n3' },
  ]);

  it('up permits uploads and the deletion of a local file from the remote tree', () => {
    // A local deletion is an *upload-direction* change: it removes the remote
    // node. A remote deletion would have to delete the local file, which only the
    // down direction may do — that is the data-loss case this pins.
    const planned = restrictPlan(ops(), { direction: 'up', delete: true });
    assert.deepEqual(planned.map((op) => op.action), ['upload', 'skipped', 'skipped', 'local-deleted']);
  });

  it('down permits downloads and the deletion of a remote file from the local tree', () => {
    const planned = restrictPlan(ops(), { direction: 'down', delete: true });
    assert.deepEqual(planned.map((op) => op.action), ['skipped', 'download', 'remote-deleted', 'skipped']);
  });

  it('both permits every transfer', () => {
    const planned = restrictPlan(ops(), { direction: 'both', delete: true });
    assert.deepEqual(planned.map((op) => op.action), ['upload', 'download', 'remote-deleted', 'local-deleted']);
  });

  it('deletions stay pending without --delete when their direction allows them', () => {
    const pending = (direction) => restrictPlan(ops(), { direction, delete: false })
      .filter((op) => op.action === 'pending-delete').map((op) => op.rel).sort();
    assert.deepEqual(pending('up'), ['local-gone.jpg'], 'only the deletion up owns is even reported');
    assert.deepEqual(pending('down'), ['remote-gone.jpg']);
    assert.deepEqual(pending('both'), ['local-gone.jpg', 'remote-gone.jpg']);
  });
});
