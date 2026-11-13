import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, uniqueEmail } from './helpers.js';

/**
 * Checksum verification and quarantine.
 *
 * Size and existence cannot detect silent corruption: a blob can be the right
 * length and still contain the wrong bytes. Rehashing is the only check that
 * finds it, and quarantining is what keeps a corrupted file from being served
 * as if it were fine.
 */

let app;
let api;
let token;

before(async () => {
  app = await startServer();
  api = app.client;
  const registered = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'verify password' } });
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

describe('checksum verification', () => {
  it('reports a freshly written store as clean', async () => {
    await upload('clean.txt', 'this file is intact');
    const result = await api('GET', '/api/v1/maintenance/blobs/verify', auth());
    assert.equal(result.status, 200);
    assert.ok(result.json.verification.verified >= 1);
    assert.deepEqual(result.json.verification.corrupt, []);
    assert.deepEqual(result.json.verification.missing, []);
  });

  it('catches a corrupted blob that kept its size', async () => {
    const node = await upload('flipped.txt', 'the original bytes');
    // Same length, different content: exactly what a bad sector looks like.
    const forged = 'x'.repeat('the original bytes'.length);
    writeFileSync(blobFile(node.blobHash), forged);
    const result = await api('GET', '/api/v1/maintenance/blobs/verify', auth());
    const hit = result.json.verification.corrupt.find((entry) => entry.hash === node.blobHash);
    assert.ok(hit, JSON.stringify(result.json.verification));
    assert.notEqual(hit.actual, node.blobHash);
    assert.equal(hit.size, 'the original bytes'.length);
  });

  it('quarantines the corrupted blob and drops its row', async () => {
    const node = await upload('bad.txt', 'corrupt me please');
    writeFileSync(blobFile(node.blobHash), 'y'.repeat('corrupt me please'.length));

    const installed = await api('POST', '/api/v1/maintenance/blobs/quarantine', auth({ body: { hashes: [node.blobHash] } }));
    assert.equal(installed.status, 200);
    assert.ok(installed.json.moved >= 1, JSON.stringify(installed.json));

    // The row is gone, so the download fails cleanly instead of serving junk.
    const download = await api('GET', `/api/v1/files/${node.id}/content`, auth());
    assert.equal(download.status, 404);

    // The bytes are kept, not deleted: they are evidence.
    const quarantine = readdirSync(join(app.dataDir, 'quarantine'));
    assert.ok(quarantine.some((name) => name.startsWith(node.blobHash)), quarantine.join(', '));
  });

  it('honours a limit so a large store can be checked in slices', async () => {
    const limited = await api('GET', '/api/v1/maintenance/blobs/verify?limit=1', auth());
    assert.equal(limited.status, 200);
    assert.ok(limited.json.verification.verified <= 1);
    assert.ok(limited.json.verification.remaining >= 0);
  });

  it('requires a login', async () => {
    assert.equal((await api('GET', '/api/v1/maintenance/blobs/verify')).status, 401);
    assert.equal((await api('POST', '/api/v1/maintenance/blobs/quarantine', { body: {} })).status, 401);
  });
});
