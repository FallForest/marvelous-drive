import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startServer, uniqueEmail } from './helpers.js';

/**
 * Version history as something a user can actually use.
 *
 * Restoring a version is destructive — it moves the live file and appends a new
 * row — but most of the time the question is just "what did v1 look like?". The
 * content endpoint answers that without touching the node, so these tests pin
 * both halves: reading history is read-only, restoring is not.
 */

let app;
let api;
let token;

before(async () => {
  app = await startServer();
  api = app.client;
  const registered = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'versions password' } });
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

async function overwrite(id, body) {
  const response = await api('PUT', `/api/v1/files/${id}/content`, auth({
    raw: true, body, headers: { 'content-type': 'text/plain' },
  }));
  assert.equal(response.status, 200, response.text);
  return response.json.node;
}

describe('version content', () => {
  it('downloads the bytes of an old version without touching the live file', async () => {
    const node = await upload('history.txt', 'the first draft');
    await overwrite(node.id, 'the second draft');

    const versions = await api('GET', `/api/v1/files/${node.id}/versions`, auth());
    assert.equal(versions.status, 200);
    const first = versions.json.versions.find((entry) => entry.version === 1);
    assert.ok(first, 'v1 is in the history');
    assert.match(first.downloadUrl, /\/versions\/.*\/content\?download=1$/);

    const old = await api('GET', `/api/v1/files/${node.id}/versions/${first.id}/content`, auth());
    assert.equal(old.status, 200);
    assert.equal(old.text, 'the first draft');

    // Reading history must not mutate the node.
    const live = await api('GET', `/api/v1/files/${node.id}/content`, auth());
    assert.equal(live.text, 'the second draft');
    const after = await api('GET', `/api/v1/files/${node.id}/versions`, auth());
    assert.equal(after.json.versions.length, versions.json.versions.length);
  });

  it('names the download after the version', async () => {
    const node = await upload('report.txt', 'v1 body');
    await overwrite(node.id, 'v2 body');
    const versions = await api('GET', `/api/v1/files/${node.id}/versions`, auth());
    const first = versions.json.versions.find((entry) => entry.version === 1);
    const response = await api('GET', `/api/v1/files/${node.id}/versions/${first.id}/content?download=1`, auth());
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition') || '', /report \(v1\)\.txt/);
  });

  it('404s for a version that belongs to another file', async () => {
    const a = await upload('a.txt', 'aaa');
    await overwrite(a.id, 'aaa2');
    const b = await upload('b.txt', 'bbb');
    await overwrite(b.id, 'bbb2');
    const versions = await api('GET', `/api/v1/files/${a.id}/versions`, auth());
    const target = versions.json.versions[0];
    const response = await api('GET', `/api/v1/files/${b.id}/versions/${target.id}/content`, auth());
    assert.equal(response.status, 404, 'a version id is scoped to its node');
  });

  it('requires a login', async () => {
    const node = await upload('private.txt', 'secret');
    await overwrite(node.id, 'secret 2');
    const versions = await api('GET', `/api/v1/files/${node.id}/versions`, auth());
    const anonymous = await api('GET', `/api/v1/files/${node.id}/versions/${versions.json.versions[0].id}/content`);
    assert.equal(anonymous.status, 401);
  });

  it('still restores destructively when asked', async () => {
    const node = await upload('restore.txt', 'original');
    const second = await overwrite(node.id, 'replacement');
    const versions = await api('GET', `/api/v1/files/${node.id}/versions`, auth());
    const first = versions.json.versions.find((entry) => entry.version === 1);
    const restored = await api('POST', `/api/v1/files/${node.id}/versions/${first.id}/restore`, auth({
      body: { expectedVersion: second.version },
    }));
    assert.equal(restored.status, 200, restored.text);
    const live = await api('GET', `/api/v1/files/${node.id}/content`, auth());
    assert.equal(live.text, 'original');
    const log = await api('GET', '/api/v1/audit?limit=20', auth());
    assert.ok(log.json.entries.some((entry) => entry.action === 'version-restore' && entry.nodeId === node.id));
  });
});
