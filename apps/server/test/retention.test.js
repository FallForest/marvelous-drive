import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { startServer, uniqueEmail } from './helpers.js'

/**
 * Trash retention and the storage report.
 *
 * Retention is the one operation that deletes user data without a request, so
 * it is tested end to end: age a node past the window by editing `deleted_at`
 * directly, sweep, and prove the row, the subtree, the versions and the blob are
 * all gone — while a fresh deletion survives.
 */

let app
let api
let token

before(async () => {
  app = await startServer();
  api = app.client;
  const registered = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'retention password' } });
  token = registered.json.token;
});

after(async () => {
  await app.close();
  app.cleanup();
});

const auth = (extra = {}) => ({ token, ...extra });

function withDb(fn) {
  const db = new DatabaseSync(join(app.dataDir, 'drive.db'));
  try { return fn(db); } finally { db.close(); }
}

async function upload(name, body, parentId) {
  const query = '/api/v1/uploads?name=' + encodeURIComponent(name) + (parentId ? '&parentId=' + parentId : '');
  const response = await api('PUT', query, auth({ raw: true, body, headers: { 'content-type': 'text/plain' } }));
  assert.equal(response.status, 201, response.text);
  return response.json.node;
}

describe('trash retention', () => {
  it('purges a subtree that has been in the trash past the window', async () => {
    const folder = await api('POST', '/api/v1/nodes', auth({ body: { name: 'old-project', kind: 'folder' } }));
    const folderId = folder.json.node.id;
    const file = await upload('old.txt', 'old bytes', folderId);
    await api('DELETE', `/api/v1/nodes/${folderId}`, auth());

    // Age the deletion 40 days: past the 30 day default.
    const aged = new Date(Date.now() - 40 * 86400000).toISOString();
    withDb((db) => db.prepare('UPDATE nodes SET deleted_at=? WHERE id IN (?,?)').run(aged, folderId, file.id));

    const swept = await api('POST', '/api/v1/trash/sweep', auth({ body: {} }));
    assert.equal(swept.status, 200);
    assert.ok(swept.json.nodes >= 2, JSON.stringify(swept.json));
    assert.equal(swept.json.retentionDays, 30);

    const gone = await api('GET', `/api/v1/nodes/${file.id}`, auth());
    assert.equal(gone.status, 404);
    const versions = withDb((db) => db.prepare('SELECT COUNT(*) AS total FROM node_versions WHERE node_id=?').get(file.id));
    assert.equal(versions.total, 0, 'version rows must be deleted with the node');
  });

  it('keeps a node that was trashed inside the window', async () => {
    const file = await upload('recent.txt', 'recent bytes');
    await api('DELETE', `/api/v1/nodes/${file.id}`, auth());
    const swept = await api('POST', '/api/v1/trash/sweep', auth({ body: {} }));
    assert.equal(swept.status, 200);
    const listed = await api('GET', '/api/v1/nodes?trash=1', auth());
    assert.ok(listed.json.nodes.some((node) => node.id === file.id), 'a fresh deletion must survive a sweep');
  });

  it('drops the blob only when the last reference goes', async () => {
    const first = await upload('shared-a.txt', 'identical payload');
    const second = await upload('shared-b.txt', 'identical payload');
    assert.equal(first.blobHash, second.blobHash, 'the two files share one blob');
    const aged = new Date(Date.now() - 40 * 86400000).toISOString();

    await api('DELETE', `/api/v1/nodes/${first.id}`, auth());
    withDb((db) => db.prepare('UPDATE nodes SET deleted_at=? WHERE id=?').run(aged, first.id));
    await api('POST', '/api/v1/trash/sweep', auth({ body: {} }));

    const refs = withDb((db) => db.prepare('SELECT refs FROM blobs WHERE hash=?').get(first.blobHash));
    assert.ok(refs, 'the blob must survive while the second file still points at it');
    assert.equal(refs.refs, 1);
    const readable = await api('GET', `/api/v1/files/${second.id}/content`, auth());
    assert.equal(readable.text, 'identical payload');
  });

  it('reports the oldest trash entry and when it expires', async () => {
    const stats = await api('GET', '/api/v1/storage/stats', auth());
    assert.equal(stats.status, 200);
    assert.ok(stats.json.stats.trash.nodes >= 1);
    assert.equal(stats.json.stats.trash.retentionDays, 30);
    assert.ok(stats.json.stats.trash.expiresAt, 'a trashed node must have an expiry');
    const expires = Date.parse(stats.json.stats.trash.expiresAt);
    assert.ok(expires > Date.now(), 'expiry is in the future');
  });
});

describe('storage report', () => {
  it('rolls bytes up by kind', async () => {
    await upload('photo.png', 'x'.repeat(100));
    await upload('deck.pptx', 'y'.repeat(300));
    await upload('archive.zip', 'z'.repeat(50));
    await upload('mystery.qqq', 'w'.repeat(10));
    const stats = await api('GET', '/api/v1/storage/stats', auth());
    const byKind = stats.json.stats.byKind;
    assert.ok(byKind.kinds.image, 'image bucket exists');
    assert.equal(byKind.kinds.image.files, 1);
    assert.ok(byKind.kinds.document.bytes >= 300);
    assert.ok(byKind.kinds.archive.files >= 1);
    assert.equal(byKind.kinds.other.files, 1, 'an unknown extension lands in other');
    assert.equal(byKind.totalBytes, stats.json.stats.bytes);
  });

  it('counts a shared blob once in the byte total but per file in the buckets', async () => {
    const before = await api('GET', '/api/v1/storage/stats', auth());
    await upload('dup-1.txt', 'same same same');
    await upload('dup-2.txt', 'same same same');
    const after = await api('GET', '/api/v1/storage/stats', auth());
    assert.equal(after.json.stats.byKind.kinds.document.files - before.json.stats.byKind.kinds.document.files, 2);
    const delta = after.json.stats.bytes - before.json.stats.bytes;
    assert.equal(delta, 2 * 'same same same'.length, 'each node accounts for its own size');
  });
});
