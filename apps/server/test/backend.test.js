import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startServer, uniqueEmail } from './helpers.js';

/**
 * The storage backend boundary.
 *
 * The point of the abstraction is that routes never touch a path, so a range
 * download must stream from the backend rather than seek a file. These tests
 * check the behaviour that would break if someone reached around it.
 */

let app;
let api;
let token;

before(async () => {
  app = await startServer();
  api = app.client;
  const registered = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'backend password' } });
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

describe('backend streaming', () => {
  const payload = 'abcdefghij'.repeat(50);

  it('serves the whole blob', async () => {
    const node = await upload('full.txt', payload);
    const response = await api('GET', '/api/v1/files/' + node.id + '/content', auth());
    assert.equal(response.status, 200);
    assert.equal(response.text, payload);
  });

  it('serves a middle range without the prefix', async () => {
    const node = await upload('middle.txt', payload);
    const response = await api('GET', '/api/v1/files/' + node.id + '/content', auth({
      headers: { range: 'bytes=100-199' },
    }));
    assert.equal(response.status, 206);
    assert.equal(response.text, payload.slice(100, 200));
    assert.equal(response.headers.get('content-range'), 'bytes 100-199/' + payload.length);
  });

  it('serves a suffix range and a tail range', async () => {
    const node = await upload('suffix.txt', payload);
    const suffix = await api('GET', '/api/v1/files/' + node.id + '/content', auth({ headers: { range: 'bytes=-10' } }));
    assert.equal(suffix.text, payload.slice(-10));
    const open = await api('GET', '/api/v1/files/' + node.id + '/content', auth({ headers: { range: 'bytes=490-' } }));
    assert.equal(open.text, payload.slice(490));
  });

  it('answers HEAD with the size and no body', async () => {
    const node = await upload('head.txt', payload);
    const response = await api('HEAD', '/api/v1/files/' + node.id + '/content', auth());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-length'), String(payload.length));
    assert.equal(response.text, '');
  });

  it('serves an empty file without hanging', async () => {
    const node = await upload('empty.txt', '');
    const response = await api('GET', '/api/v1/files/' + node.id + '/content', auth());
    assert.equal(response.status, 200);
    assert.equal(response.text, '');
  });

  it('falls back to the whole file for an impossible range', async () => {
    const node = await upload('impossible.txt', payload);
    const response = await api('GET', '/api/v1/files/' + node.id + '/content', auth({ headers: { range: 'bytes=9999-10000' } }));
    assert.equal(response.status, 200);
    assert.equal(response.text, payload);
  });
});

describe('local backend', () => {
  it('stores a key under a two-character shard and removes it cleanly', async () => {
    const { LocalBackend } = await import('../src/storage/backend.js');
    const dir = mkdtempSync(join(tmpdir(), 'backend-'));
    const store = new LocalBackend(dir);
    const key = 'f'.repeat(64);
    const source = join(dir, 'source.bin');
    writeFileSync(source, 'hello backend');

    await store.put(key, source);
    assert.deepEqual(await store.stat(key), { size: 13 });
    assert.equal(store.path(key), join(dir, 'ff', key));
    assert.equal((await readFile(store.path(key))).toString(), 'hello backend');

    await store.remove(key);
    assert.equal(await store.stat(key), null);
    // Removing twice is not an error: releases race and that must be tolerated.
    await store.remove(key);
    rmSync(dir, { recursive: true, force: true });
  });
});
