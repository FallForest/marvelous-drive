import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startServer, uniqueEmail } from './helpers.js';

/**
 * Index coverage and the reindex operation.
 *
 * The index is derived data, so the only way it can go wrong is by falling
 * behind — a file added by an older version, or a blob restored from a backup.
 * Coverage makes that visible; reindex fixes it.
 */

let app;
let api;
let token;

before(async () => {
  app = await startServer();
  api = app.client;
  const registered = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'coverage password' } });
  token = registered.json.token;
});

after(async () => {
  await app.close();
  app.cleanup();
});

const auth = (extra = {}) => ({ token, ...extra });

async function upload(name, body, mime = 'text/plain') {
  const response = await api('PUT', '/api/v1/uploads?name=' + encodeURIComponent(name), auth({
    raw: true, body, headers: { 'content-type': mime },
  }));
  assert.equal(response.status, 201, response.text);
  return response.json.node;
}

describe('index coverage', () => {
  it('starts fully covered for the files this account uploaded', async () => {
    await upload('a.txt', 'alpha');
    await upload('b.md', '# beta', 'text/markdown');
    const status = await api('GET', '/api/v1/maintenance/search', auth());
    assert.equal(status.status, 200);
    assert.equal(status.json.upToDate, true, JSON.stringify(status.json.coverage));
    assert.equal(status.json.coverage.missing, 0);
    assert.ok(status.json.coverage.eligible >= 2);
  });

  it('counts an image as ineligible rather than missing', async () => {
    const before = await api('GET', '/api/v1/maintenance/search', auth());
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    await upload('photo.png', png, 'image/png');
    const afterStatus = await api('GET', '/api/v1/maintenance/search', auth());
    assert.equal(afterStatus.json.coverage.eligible, before.json.coverage.eligible, 'a binary file is not indexable at all');
    assert.equal(afterStatus.json.coverage.missing, 0);
  });

  it('reports a gap when a row is dropped behind the API\'s back', async () => {
    const node = await upload('dropped.txt', 'some searchable words');
    const { DatabaseSync } = await import('node:sqlite');
    const { join } = await import('node:path');
    const db = new DatabaseSync(join(app.dataDir, 'drive.db'));
    db.prepare('DELETE FROM node_text WHERE node_id=?').run(node.id);
    db.close();

    const status = await api('GET', '/api/v1/maintenance/search', auth());
    assert.ok(status.json.coverage.missing >= 1, JSON.stringify(status.json.coverage));
    assert.equal(status.json.upToDate, false);

    const missing = await api('GET', '/api/v1/search?q=searchable&scope=content', auth());
    assert.ok(!missing.json.results.some((row) => row.id === node.id), 'the gap is real: the file is unfindable');
  });

  it('reindex closes the gap and makes the file findable again', async () => {
    const reindexed = await api('POST', '/api/v1/maintenance/search/reindex', auth({ body: {} }));
    assert.equal(reindexed.status, 200);
    assert.equal(reindexed.json.after.missing, 0, JSON.stringify(reindexed.json));
    assert.ok(reindexed.json.summary.indexed >= 1);
    const found = await api('GET', '/api/v1/search?q=searchable&scope=content', auth());
    assert.ok(found.json.results.some((row) => row.name === 'dropped.txt'), JSON.stringify(found.json.results));
  });

  it('does not count a trashed file against coverage', async () => {
    const node = await upload('gone.txt', 'temporary');
    await api('DELETE', `/api/v1/nodes/${node.id}`, auth());
    const status = await api('GET', '/api/v1/maintenance/search', auth());
    assert.equal(status.json.coverage.missing, 0);
  });

  it('counts a deliberately refused file as accounted for, not missing', async () => {
    // A binary file larger than the text ceiling is indexable-in-principle but
    // refused in practice; without the skip row it would look like a permanent
    // gap and "up to date" could never be true again.
    const big = Buffer.alloc(1024);
    big[0] = 0;
    const node = await upload('blob.txt', big, 'text/plain');
    const status = await api('GET', '/api/v1/maintenance/search', auth());
    assert.ok(status.json.coverage.refused >= 1, JSON.stringify(status.json.coverage));
    assert.equal(status.json.coverage.missing, 0);
    assert.equal(status.json.upToDate, true);

    // The refusal is recorded, so a second report is still clean.
    const again = await api('GET', '/api/v1/maintenance/search', auth());
    assert.equal(again.json.coverage.missing, 0);
    // And deleting it clears the bookkeeping too.
    await api('DELETE', '/api/v1/nodes/' + node.id, auth());
    const after = await api('GET', '/api/v1/maintenance/search', auth());
    assert.equal(after.json.coverage.missing, 0);
  });

  it('requires a login for both endpoints', async () => {
    assert.equal((await api('GET', '/api/v1/maintenance/search')).status, 401);
    assert.equal((await api('POST', '/api/v1/maintenance/search/reindex', { body: {} })).status, 401);
  });

  it('exposes coverage in the storage stats', async () => {
    const stats = await api('GET', '/api/v1/storage/stats', auth());
    assert.ok(stats.json.stats.search, JSON.stringify(stats.json.stats));
    assert.equal(typeof stats.json.stats.search.eligible, 'number');
    assert.equal(stats.json.stats.search.missing, 0);
  });
});