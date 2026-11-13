import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { startServer, uniqueEmail } from './helpers.js';

/**
 * Hot/cold reporting.
 *
 * The tier split is only as good as the access signal behind it, so both halves
 * are tested: a read must be recorded (once a day, not once per request), and a
 * blob that was never read must show up as cold.
 */

let app;
let api;
let token;

before(async () => {
  app = await startServer();
  api = app.client;
  const registered = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'tier password' } });
  token = registered.json.token;
});

after(async () => {
  await app.close();
  app.cleanup();
});

const auth = (extra = {}) => ({ token, ...extra });

async function upload(name, body) {
  const response = await api('PUT', '/api/v1/uploads?name=' + encodeURIComponent(name), auth({
    raw: true, body, headers: { 'content-type': 'text/plain' },
  }));
  assert.equal(response.status, 201, response.text);
  return response.json.node;
}

function withDb(fn) {
  const db = new DatabaseSync(join(app.dataDir, 'drive.db'));
  try { return fn(db); } finally { db.close(); }
}

describe('access tracking', () => {
  it('records a read and marks the blob hot', async () => {
    const node = await upload('hot.txt', 'read me once');
    const first = await api('GET', `/api/v1/files/${node.id}/content`, auth());
    assert.equal(first.text, 'read me once');
    const row = withDb((db) => db.prepare('SELECT * FROM blob_access WHERE hash=?').get(node.blobHash));
    assert.ok(row, 'a read must leave a row');
    assert.equal(row.hits, 1);
    const tiers = await api('GET', '/api/v1/maintenance/storage/tiers', auth());
    assert.equal(tiers.status, 200);
    assert.ok(tiers.json.tiers.hotBytes >= node.size);
    assert.ok(!tiers.json.tiers.cold.some((entry) => entry.hash === node.blobHash));
  });

  it('does not write a second row for a second read the same day', async () => {
    const node = await upload('busy.txt', 'downloaded twice');
    await api('GET', `/api/v1/files/${node.id}/content`, auth());
    const before = withDb((db) => db.prepare('SELECT last_access, hits FROM blob_access WHERE hash=?').get(node.blobHash));
    await api('GET', `/api/v1/files/${node.id}/content`, auth());
    const afterRead = withDb((db) => db.prepare('SELECT last_access, hits FROM blob_access WHERE hash=?').get(node.blobHash));
    assert.equal(afterRead.hits, before.hits, 'a download burst must not become a write burst');
    assert.equal(afterRead.last_access, before.last_access);
  });

  it('treats a never-read blob as cold', async () => {
    const node = await upload('untouched.txt', 'nobody has opened this');
    const tiers = await api('GET', '/api/v1/maintenance/storage/tiers', auth());
    const cold = tiers.json.tiers.cold.find((entry) => entry.hash === node.blobHash);
    assert.ok(cold, JSON.stringify(tiers.json.tiers.cold.slice(0, 3)));
    assert.equal(cold.lastAccess, null);
  });

  it('drops a blob out of cold once it is read', async () => {
    const node = await upload('later.txt', 'warmed up later');
    const before = await api('GET', '/api/v1/maintenance/storage/tiers', auth());
    assert.ok(before.json.tiers.cold.some((entry) => entry.hash === node.blobHash));
    await api('GET', `/api/v1/files/${node.id}/content`, auth());
    const afterRead = await api('GET', '/api/v1/maintenance/storage/tiers', auth());
    assert.ok(!afterRead.json.tiers.cold.some((entry) => entry.hash === node.blobHash));
  });

  it('honours the days threshold', async () => {
    const node = await upload('aged.txt', 'aged out');
    await api('GET', `/api/v1/files/${node.id}/content`, auth());
    withDb((db) => db.prepare('UPDATE blob_access SET last_access=? WHERE hash=?')
      .run(new Date(Date.now() - 400 * 86400000).toISOString(), node.blobHash));
    const fresh = await api('GET', '/api/v1/maintenance/storage/tiers?days=30', auth());
    assert.ok(fresh.json.tiers.cold.some((entry) => entry.hash === node.blobHash));
    const loose = await api('GET', '/api/v1/maintenance/storage/tiers?days=3650', auth());
    assert.ok(!loose.json.tiers.cold.some((entry) => entry.hash === node.blobHash));
  });

  it('requires a login', async () => {
    assert.equal((await api('GET', '/api/v1/maintenance/storage/tiers')).status, 401);
  });
});
