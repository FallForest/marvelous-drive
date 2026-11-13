import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startServer, uniqueEmail } from './helpers.js'

/**
 * Blob integrity: the scrub must see the two failure modes apart and never
 * delete something a row still references.
 */

let app
let api
let token

before(async () => {
  app = await startServer();
  api = app.client;
  const registered = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'scrub password' } });
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

const blobFile = (hash) => join(app.dataDir, 'blobs', hash.slice(0, 2), hash);

describe('blob scrub', () => {
  it('reports a clean store as clean', async () => {
    await upload('clean.txt', 'clean bytes');
    const report = await api('GET', '/api/v1/maintenance/blobs', auth());
    assert.equal(report.status, 200);
    assert.deepEqual(report.json.scan.missing, []);
    assert.deepEqual(report.json.scan.orphans, []);
    assert.deepEqual(report.json.scan.sizeMismatch, []);
    assert.ok(report.json.scan.rows >= 1);
  });

  it('flags a row whose file was removed, and forgets it on request', async () => {
    const node = await upload('vanishing.txt', 'gone soon');
    unlinkSync(blobFile(node.blobHash));

    const report = await api('GET', '/api/v1/maintenance/blobs', auth());
    assert.deepEqual(report.json.scan.missing.map((entry) => entry.hash), [node.blobHash]);

    const forgotten = await api('POST', '/api/v1/maintenance/blobs/forget-missing', auth({ body: {} }));
    assert.equal(forgotten.status, 200);
    assert.ok(forgotten.json.removed >= 1);
    assert.deepEqual(forgotten.json.scan.missing, []);

    const download = await api('GET', `/api/v1/files/${node.id}/content`, auth());
    assert.equal(download.status, 404, 'the node no longer advertises dead content');
  });

  it('reclaims a file no row references', async () => {
    const orphanHash = 'a'.repeat(64);
    const dir = join(app.dataDir, 'blobs', orphanHash.slice(0, 2));
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, orphanHash), 'stray bytes');

    const report = await api('GET', '/api/v1/maintenance/blobs', auth());
    assert.ok(report.json.scan.orphans.some((entry) => entry.hash === orphanHash), JSON.stringify(report.json.scan.orphans));

    const reclaimed = await api('POST', '/api/v1/maintenance/blobs/reclaim', auth({ body: {} }));
    assert.equal(reclaimed.status, 200);
    assert.ok(reclaimed.json.removed >= 1);
    assert.ok(!readdirSync(dir).includes(orphanHash), 'the orphan file is gone');
  });

  it('reports a size mismatch without deleting the blob', async () => {
    const node = await upload('truncated.txt', 'twelve bytes');
    // Shrink the file behind the API's back, keeping the name.
    writeFileSync(blobFile(node.blobHash), 'tiny');
    const report = await api('GET', '/api/v1/maintenance/blobs', auth());
    const mismatch = report.json.scan.sizeMismatch.find((entry) => entry.hash === node.blobHash);
    assert.ok(mismatch, 'the mismatch is reported');
    assert.equal(mismatch.diskSize, 4);
    assert.ok(readdirSync(join(app.dataDir, 'blobs', node.blobHash.slice(0, 2))).includes(node.blobHash));
  });
});
