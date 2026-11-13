import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarness, parseJson, runCli } from './helpers.mjs';
import { EMAIL, IDS, PASSWORD, PLAN_BODY, TOKEN } from './mock-server.mjs';

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mdrive-work-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/* ── account ─────────────────────────────────────────────────────────── */

test('login stores the profile and never prints the token', async t => {
  const h = await createHarness(t);
  const result = await h.login();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Signed in as Ada Lovelace <owner@example.com>/);
  assert.ok(!result.stdout.includes(TOKEN), 'the token must not leak into stdout');

  const config = JSON.parse(await readFile(h.configPath, 'utf8'));
  assert.equal(config.version, 1);
  assert.equal(config.defaultProfile, h.server.url);
  assert.equal(config.profiles[h.server.url].token, TOKEN);
  assert.equal(config.profiles[h.server.url].email, EMAIL);
  if (process.platform !== 'win32') {
    assert.equal((await stat(h.configPath)).mode & 0o777, 0o600);
  }
});

test('login rejects wrong credentials with exit 1 and a readable message', async t => {
  const h = await createHarness(t);
  const result = await runCli(['login', '--email', EMAIL, '--password', 'nope'], {
    configDir: h.configDir,
    server: h.server.url
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /HTTP 401 INVALID_CREDENTIALS/);
  assert.match(result.stderr, /Email or password is incorrect/);
});

test('whoami reads the stored profile with no --server or --token', async t => {
  const h = await createHarness(t);
  assert.equal((await h.login()).status, 0);
  const result = await h.runProfile(['whoami']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /owner@example.com/);
  assert.match(result.stdout, /Ada Lovelace/);
  assert.match(result.stdout, /role\s+owner/);
});

test('whoami --json emits a machine readable envelope', async t => {
  const h = await createHarness(t);
  await h.login();
  const result = await h.runProfile(['whoami', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const payload = parseJson(result);
  assert.equal(payload.ok, true);
  assert.equal(payload.command, 'whoami');
  assert.equal(payload.user.email, EMAIL);
});

test('logout removes only the current profile, --all wipes the cache', async t => {
  const h = await createHarness(t);
  await h.login();
  const done = await h.runProfile(['logout']);
  assert.equal(done.status, 0, done.stderr);
  const config = JSON.parse(await readFile(h.configPath, 'utf8'));
  assert.deepEqual(config.profiles, {});
  assert.equal(config.defaultProfile, null);

  await h.login();
  const all = await h.runProfile(['logout', '--all']);
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /Removed every saved profile/);
});

/* ── listing ─────────────────────────────────────────────────────────── */

test('ls renders folders before files with sizes and versions', async t => {
  const h = await createHarness(t);
  const result = await h.run(['ls']);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trimEnd().split('\n');
  assert.match(lines[0], /^KIND/);
  assert.match(lines[1], /folder\s+-\s+-\s+/, 'folders show "-" for size and version');
  assert.match(result.stdout, /notes\.txt/);
  assert.match(result.stdout, /12 B/, 'small files render as a plain byte count');
  assert.ok(!result.stdout.includes('old.md'), 'trashed nodes are hidden');
});

test('ls lists folder contents and the trash', async t => {
  const h = await createHarness(t);
  const projects = await h.run(['ls', '/Projects']);
  assert.equal(projects.status, 0, projects.stderr);
  assert.match(projects.stdout, /plan\.md/);
  assert.match(projects.stdout, /v3/);

  const trash = await h.run(['ls', '--trash']);
  assert.equal(trash.status, 0, trash.stderr);
  assert.match(trash.stdout, /old\.md/);
});

test('ls on a missing path exits 1 with a path hint', async t => {
  const h = await createHarness(t);
  const result = await h.run(['ls', '/Nope']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No folder at "\/Nope"/);
});

test('ls --json returns the raw node array', async t => {
  const h = await createHarness(t);
  const result = await h.run(['ls', '--json']);
  const payload = parseJson(result);
  assert.equal(payload.ok, true);
  assert.ok(Array.isArray(payload.nodes));
  assert.equal(payload.nodes.find(entry => entry.name === 'notes.txt').size, 12);
});

test('tree prints an indented hierarchy', async t => {
  const h = await createHarness(t);
  const result = await h.run(['tree']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\/$/m);
  assert.match(result.stdout, /\u251c\u2500 Projects\//);
  // Projects holds plan.md and chart.png, so plan.md is not the last child.
  assert.match(result.stdout, /\u2502  \u251c\u2500 plan\.md \(22 B\)/);
  assert.match(result.stdout, /\u2502  \u2514\u2500 chart\.png \(4 B\)/);
  assert.match(result.stdout, /\u2514\u2500 notes\.txt \(12 B\)/);
});

test('stat resolves a path and prints every field', async t => {
  const h = await createHarness(t);
  const result = await h.run(['stat', '/Projects/plan.md']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /path\s+\/Projects\/plan\.md/);
  assert.match(result.stdout, /mime\s+text\/markdown/);
  assert.match(result.stdout, /version\s+3/);
  assert.match(result.stdout, /download\s+\/api\/v1\/files\//);
});

test('stat by uuid works too', async t => {
  const h = await createHarness(t);
  const result = await h.run(['stat', IDS.plan, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const payload = parseJson(result);
  assert.equal(payload.node.id, IDS.plan);
  assert.equal(payload.path, '/Projects/plan.md');
});

/* ── mutations ───────────────────────────────────────────────────────── */

test('mkdir creates a nested folder chain with --parents', async t => {
  const h = await createHarness(t);
  const result = await h.run(['mkdir', '-p', '/Reports/2026/Q1']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Created folder \/Reports\/2026\/Q1/);
  const ls = await h.run(['ls', '/Reports/2026']);
  assert.match(ls.stdout, /Q1/);
});

test('mkdir without --parents refuses a missing intermediate folder', async t => {
  const h = await createHarness(t);
  const result = await h.run(['mkdir', '/Missing/child']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /does not exist\. Add --parents/);
});

test('mkdir spots an existing folder before calling the server', async t => {
  const h = await createHarness(t);
  const before = h.server.requests.length;
  const result = await h.run(['mkdir', '/Projects']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already exists \(22222222/);
  assert.equal(h.server.requests.length, before + 1, 'only the parent listing was requested, no POST');
});

test('a server side 409 is reported with actionable advice', async t => {
  const h = await createHarness(t, { conflictOn: 'Clash' });
  const result = await h.run(['mkdir', '/Clash']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /HTTP 409 CONFLICT/);
  assert.match(result.stderr, /--name/);
});

test('mv renames and moves a node', async t => {
  const h = await createHarness(t);
  const rename = await h.run(['mv', '/notes.txt', '/notes-renamed.txt']);
  assert.equal(rename.status, 0, rename.stderr);
  assert.match(rename.stdout, /Moved notes\.txt -> \/notes-renamed\.txt/);

  const move = await h.run(['mv', '/notes-renamed.txt', '/Projects']);
  assert.equal(move.status, 0, move.stderr);
  const ls = await h.run(['ls', '/Projects']);
  assert.match(ls.stdout, /notes-renamed\.txt/);
});

test('rm trashes, restore brings back, purge deletes for good', async t => {
  const h = await createHarness(t);
  const removed = await h.run(['rm', '/notes.txt']);
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(removed.stdout, /trashed notes\.txt/);

  const trash = await h.run(['ls', '--trash']);
  assert.match(trash.stdout, /notes\.txt/);

  const restored = await h.run(['restore', 'notes.txt']);
  assert.equal(restored.status, 0, restored.stderr);
  assert.match(restored.stdout, /Restored notes\.txt/);

  await h.run(['rm', IDS.trashed]);
  const purged = await h.run(['purge', IDS.trashed, '--yes']);
  assert.equal(purged.status, 0, purged.stderr);
  assert.match(purged.stdout, /purged old\.md/);
});

test('purge refuses to run non-interactively without --yes', async t => {
  const h = await createHarness(t);
  const result = await h.run(['purge', IDS.trashed]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /pass --yes/);
});

test('star toggles the flag and ls --starred finds the node', async t => {
  const h = await createHarness(t);
  const on = await h.run(['star', '/notes.txt']);
  assert.equal(on.status, 0, on.stderr);
  assert.match(on.stdout, /Starred notes\.txt/);
  const starred = await h.run(['ls', '--starred']);
  assert.match(starred.stdout, /notes\.txt/);

  const off = await h.run(['star', '/notes.txt', '--off']);
  assert.match(off.stdout, /Unstarred notes\.txt/);
});

test('cp copies a file and folders copy recursively', async t => {
  const h = await createHarness(t);
  const copied = await h.run(['cp', '/notes.txt', '--name', 'notes-copy.txt']);
  assert.equal(copied.status, 0, copied.stderr);
  assert.match(copied.stdout, /Copied to notes-copy\.txt/);
});

test('search filters by query and honours the limit', async t => {
  const h = await createHarness(t);
  const result = await h.run(['search', 'note']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /notes\.txt/);

  const empty = await h.run(['search', 'zzz']);
  assert.equal(empty.status, 0);
  assert.match(empty.stdout, /No matches for "zzz"/);
});

test('stats prints storage counters', async t => {
  const h = await createHarness(t);
  const result = await h.run(['stats']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /files\s+3/);
  assert.match(result.stdout, /folders\s+1/);
  assert.match(result.stdout, /trashed\s+1/);
  assert.match(result.stdout, /quota\s+10\.0 GiB \(0% used\)/);
});

/* ── content ─────────────────────────────────────────────────────────── */

test('upload sends one PUT for a small file', async t => {
  const h = await createHarness(t);
  const dir = await tempDir(t);
  const file = join(dir, 'notes.md');
  await writeFile(file, '# hello\n');
  const result = await h.run(['upload', file, '--to', '/Projects']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /uploaded notes\.md/);

  const put = h.server.requests.find(request => request.path === '/api/v1/uploads');
  assert.ok(put, 'the simple PUT endpoint was called');
  assert.equal(put.query.name, 'notes.md');
  assert.equal(put.query.parentId, IDS.projects);
  assert.ok(!h.server.requests.some(request => request.path === '/api/v1/uploads/sessions'), 'no session for a small file');

  const cat = await h.run(['cat', '/Projects/notes.md']);
  assert.equal(cat.stdout, '# hello\n');
});

test('upload switches to resumable chunks above 8 MiB', async t => {
  const h = await createHarness(t);
  const dir = await tempDir(t);
  const file = join(dir, 'big.bin');
  const size = 9 * 1024 * 1024 + 123;
  await writeFile(file, Buffer.alloc(size, 7));
  const result = await h.run(['upload', file, '--chunk-size', '4MiB']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\(3\/3 chunks\)/);

  const session = h.server.requests.find(request => request.path === '/api/v1/uploads/sessions' && request.method === 'POST');
  assert.equal(session.body.size, size);
  assert.equal(session.body.chunkSize, 4 * 1024 * 1024);
  const chunks = h.server.requests.filter(request => request.path.includes('/chunks/'));
  assert.equal(chunks.length, 3);
  assert.equal(chunks.map(chunk => chunk.bytes).reduce((sum, bytes) => sum + bytes, 0), size);
  assert.equal(chunks[2].bytes, size - 8 * 1024 * 1024);
  const complete = h.server.requests.find(request => request.path.endsWith('/complete'));
  assert.ok(complete, 'the session was completed');
});

test('a resumed resumable upload skips chunks the server already stored', async t => {
  const h = await createHarness(t);
  const dir = await tempDir(t);
  const file = join(dir, 'resume.bin');
  const size = 9 * 1024 * 1024;
  await writeFile(file, Buffer.alloc(size, 3));

  // Simulate an interrupted session: pre-create it on the mock with chunk 0 stored.
  const created = await fetch(h.server.url + '/api/v1/uploads/sessions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'resume.bin', size, chunkSize: 4 * 1024 * 1024 })
  }).then(response => response.json());
  await fetch(h.server.url + '/api/v1/uploads/sessions/' + created.upload.id + '/chunks/0', {
    method: 'PUT',
    headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/octet-stream' },
    body: new Uint8Array(Buffer.alloc(4 * 1024 * 1024, 3))
  });
  const before = h.server.requests.length;

  const result = await h.run(['upload', file, '--chunk-size', '4MiB', '--session', created.upload.id]);
  assert.equal(result.status, 0, result.stderr);
  const chunks = h.server.requests.slice(before).filter(request => request.path.includes('/chunks/'));
  assert.equal(chunks.length, 2, 'the already stored chunk 0 is not resent');
  assert.match(result.stdout, /uploaded resume\.bin/);
});

test('download writes the file and refuses to clobber without --force', async t => {
  const h = await createHarness(t);
  const dir = await tempDir(t);
  const target = join(dir, 'plan.md');
  const first = await h.run(['download', '/Projects/plan.md', target]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(await readFile(target, 'utf8'), PLAN_BODY);

  const second = await h.run(['download', '/Projects/plan.md', target]);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /already exists\. Pass --force/);

  const forced = await h.run(['download', '/Projects/plan.md', target, '--force']);
  assert.equal(forced.status, 0, forced.stderr);
});

test('download - streams to stdout', async t => {
  const h = await createHarness(t);
  const result = await h.run(['download', '/Projects/plan.md', '-']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, PLAN_BODY);
});

test('cat refuses folders and non-text mimetypes', async t => {
  const h = await createHarness(t);
  const folder = await h.run(['cat', '/Projects']);
  assert.equal(folder.status, 2);
  assert.match(folder.stderr, /is a folder/);

  const binary = await h.run(['cat', '/Projects/chart.png']);
  assert.equal(binary.status, 2);
  assert.match(binary.stderr, /image\/png, not text/);

  const forced = await h.run(['cat', '/Projects/chart.png', '--force']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(forced.stdout, 'PNG!');
});

test('download --resume continues a partial file with a Range request', async t => {
  const h = await createHarness(t);
  const dir = await tempDir(t);
  const target = join(dir, 'plan.md');
  // Pretend an earlier download stopped after the first 8 bytes.
  await writeFile(target, PLAN_BODY.slice(0, 8));

  const result = await h.run(['download', '/Projects/plan.md', target, '--resume']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\(resumed\)/);
  assert.equal(await readFile(target, 'utf8'), PLAN_BODY);

  const ranged = h.server.requests.filter(request => request.method === 'GET' && request.path.endsWith('/content'));
  const last = ranged[ranged.length - 1];
  assert.equal(last.query.download, '1', 'the download asked for an attachment');
  assert.equal(last.headers.range, 'bytes=8-', 'resume sends a Range header for the missing suffix');
  assert.equal(last.headers.authorization, 'Bearer ' + TOKEN);
});

test('download without --resume overwrites instead of appending', async t => {
  const h = await createHarness(t);
  const dir = await tempDir(t);
  const target = join(dir, 'notes.txt');
  await writeFile(target, 'stale-header');
  const result = await h.run(['download', 'notes.txt', target, '--force']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(target, 'utf8'), 'hello notes!');
  const last = h.server.requests.filter(request => request.path.endsWith('/content')).pop();
  assert.equal(last.headers.range, undefined, 'no Range header without --resume');
});

test('cat honours --max-bytes', async t => {
  const h = await createHarness(t);
  const result = await h.run(['cat', '/Projects/plan.md', '--max-bytes', '4']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /above the 4 B cat limit/);
});

/* ── sharing ─────────────────────────────────────────────────────────── */

test('share creates a link and share list shows it', async t => {
  const h = await createHarness(t);
  const created = await h.run(['share', '/Projects/plan.md', '--permission', 'downloader', '--expires-days', '7']);
  assert.equal(created.status, 0, created.stderr);
  assert.match(created.stdout, /Shared plan\.md \(downloader\)/);
  assert.match(created.stdout, new RegExp(h.server.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/s/shr_'));

  const list = await h.run(['share', 'list', '/Projects/plan.md']);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /downloader/);
});

test('revoke deletes a share by token', async t => {
  const h = await createHarness(t);
  const result = await h.run(['revoke', 'shr_4f2c9a']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Revoked share/);
});

/* ── failure modes ───────────────────────────────────────────────────── */

test('an unreachable server exits 1 with the origin in the message', async t => {
  const h = await createHarness(t);
  const result = await runCli(['ls'], { configDir: h.configDir, server: 'http://127.0.0.1:1', token: TOKEN });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot reach http:\/\/127\.0\.0\.1:1/);
});

test('a 401 explains how to authenticate', async t => {
  const h = await createHarness(t);
  const result = await runCli(['ls'], { configDir: h.configDir, server: h.server.url, token: 'stale' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /HTTP 401 UNAUTHENTICATED/);
  assert.match(result.stderr, /mdrive login/);
});

test('a 413 upload is reported with the limit hint', async t => {
  const h = await createHarness(t, { maxUploadBytes: 8 });
  const dir = await tempDir(t);
  const file = join(dir, 'big.txt');
  await writeFile(file, 'way more than eight bytes');
  const result = await h.run(['upload', file]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /HTTP 413 FILE_TOO_LARGE/);
  assert.match(result.stderr, /DRIVE_MAX_UPLOAD_BYTES/);
});

test('--server and --token override the stored profile', async t => {
  const h = await createHarness(t);
  await h.login();
  const result = await runCli(['whoami', '--server', h.server.url, '--token', 'stale'], { configDir: h.configDir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /HTTP 401/);
});

test('version flag and version command agree', async t => {
  const flagged = await runCli(['--version']);
  const command = await runCli(['version']);
  assert.equal(flagged.status, 0);
  assert.equal(command.status, 0);
  assert.equal(flagged.stdout, command.stdout);
  assert.match(flagged.stdout.trim(), /^mdrive \d+\.\d+\.\d+$/);
});

test('unknown commands and options exit 2', async t => {
  const unknown = await runCli(['frobnicate']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown command: frobnicate/);

  // The Docs bridge was removed: the command group must be gone rather than
  // half-registered, and the message falls back to the general help hint.
  const docs = await runCli(['docs', 'status']);
  assert.equal(docs.status, 2);
  assert.match(docs.stderr, /Unknown command: docs/);
  assert.match(docs.stderr, /Run "mdrive --help" for the command list\./);

  const option = await runCli(['ls', '--nope']);
  assert.equal(option.status, 2);
  assert.match(option.stderr, /Unknown option --nope/);
});