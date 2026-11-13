import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { startServer } from './helpers.js'

/**
 * Static asset caching.
 *
 * This was a real production bug: the web bundle is served under stable names
 * (app.js, lib/*.js) with no content hash, and the server used to answer
 * `cache-control: public, max-age=3600`. After a deploy, browsers kept running
 * the previous version of app.js for an hour â€?which showed up as a
 * `drawer is not defined` error in a freshly built feature.
 *
 * The fix is revalidation (no-cache + ETag), and these tests pin it down.
 */

let app
let api

before(async () => {
  app = await startServer();
  api = app.client;
});

after(async () => {
  await app.close();
  app.cleanup();
});

function fetchRaw(path, headers = {}) {
  return fetch('http://127.0.0.1:' + app.port + path, { headers });
}

describe('static assets', () => {
  it('serves index.html with no-store', async () => {
    const response = await fetchRaw('/');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  it('serves a module with no-cache and an ETag, never a long max-age', async () => {
    const response = await fetchRaw('/app.js');
    assert.equal(response.status, 200);
    const cacheControl = response.headers.get('cache-control') || '';
    assert.equal(cacheControl, 'no-cache');
    assert.ok(!/max-age=\d{3,}/.test(cacheControl), 'a stable filename must not be cached for long');
    assert.match(response.headers.get('etag') || '', /^W\//);
  });

  it('revalidates to 304 with the same ETag and an empty body', async () => {
    const first = await fetchRaw('/app.js');
    const etag = first.headers.get('etag');
    await first.text();
    const second = await fetchRaw('/app.js', { 'if-none-match': etag });
    assert.equal(second.status, 304);
    assert.equal((await second.text()).length, 0);
  });

  it('changes the ETag when the file changes', async () => {
    const before = await fetchRaw('/lib/session.js');
    const etag = before.headers.get('etag');
    await before.text();
    const { appendFileSync, readFileSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const target = join(process.cwd(), 'apps', 'web', 'lib', 'session.js');
    const original = readFileSync(target, 'utf8');
    try {
      appendFileSync(target, '\n// etag probe\n');
      const after = await fetchRaw('/lib/session.js', { 'if-none-match': etag });
      assert.equal(after.status, 200, 'a changed file must not answer 304');
      assert.notEqual(after.headers.get('etag'), etag);
      await after.text();
    } finally {
      writeFileSync(target, original);
    }
  });

  it('still refuses path traversal', async () => {
    const response = await fetchRaw('/../package.json');
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes('<div id="app"'), 'a traversal attempt falls back to index.html');
  });
});
