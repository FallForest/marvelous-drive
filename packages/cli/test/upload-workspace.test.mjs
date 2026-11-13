import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarness } from './helpers.mjs';

/**
 * `upload --to PATH --workspace ID`.
 *
 * A member has to be able to write into a shared folder it can see but does not
 * own; the destination is a path inside that workspace, not a uuid.
 */

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mdrive-wsup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('upload --to resolves a folder that only exists in the shared workspace', async t => {
  const h = await createHarness(t);
  const dir = await tempDir(t);
  const file = join(dir, 'note.md');
  await writeFile(file, '# shared write');

  // A folder that exists only in the shared scope.
  h.server.state.workspaceNodes.push({
    id: 'shared-folder', name: 'team', kind: 'folder', parentId: null, size: 0, mime: null,
    version: 1, starred: false, deletedAt: null,
    createdAt: '2026-01-02T10:00:00.000Z', updatedAt: '2026-01-02T10:00:00.000Z', blobHash: null
  });

  // The scoped case runs first: the unscoped one creates a FILE called "team" at
  // the root (the last path segment is taken as the target name), which would make
  // the later scoped run refuse with "--to must be a folder".
  const withScope = await h.run(['upload', file, '--to', '/team', '--workspace', 'ws-1']);
  assert.equal(withScope.status, 0, withScope.stderr);
  assert.match(withScope.stdout, /uploaded note\.md/);
  const put = h.server.requests.filter((request) => request.path === '/api/v1/uploads' && request.method === 'PUT').at(-1);
  assert.equal(put.query.parentId, 'shared-folder', 'the upload targeted the shared folder');

  // Without the scope the destination is not visible, so the segment becomes a
  // file name and the bytes land at the root — which is exactly why the flag exists.
  const withoutScope = await h.run(['upload', file, '--to', '/team']);
  assert.equal(withoutScope.status, 0, withoutScope.stderr);
  const unscopedPut = h.server.requests.filter((request) => request.path === '/api/v1/uploads' && request.method === 'PUT').at(-1);
  assert.equal(unscopedPut.query.parentId, undefined, 'without the scope it fell back to a rename');
});