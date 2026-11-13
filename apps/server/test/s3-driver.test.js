import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The server running on the S3 driver.
 *
 * The class tests prove the backend works; this proves the *process* works: the
 * driver is selected from configuration, every route goes through it, and no
 * route falls back to a local path. A stub S3 stands in for MinIO.
 */

let server;
let client;
let dataDir;
let token;
const objects = new Map();

/** A stub S3 that speaks just enough for the backend. */
async function stubFetch(url, init) {
  const parsed = new URL(url);
  const key = decodeURIComponent(parsed.pathname);
  if (init.method === 'PUT') {
    const body = init.body;
    if (Buffer.isBuffer(body)) objects.set(key, body);
    else if (typeof body === 'string') objects.set(key, Buffer.from(body));
    else if (body && typeof body[Symbol.asyncIterator] === 'function') {
      // A streamed body is the normal case for an upload: read it like S3 would.
      const chunks = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      objects.set(key, Buffer.concat(chunks));
    } else return new Response(null, { status: 400 });
    return new Response(null, { status: 200 });
  }
  if (init.method === 'HEAD') {
    const value = objects.get(key);
    return new Response(null, { status: value ? 200 : 404, headers: value ? { 'content-length': String(value.length) } : {} });
  }
  if (init.method === 'DELETE') return new Response(null, { status: objects.delete(key) ? 204 : 404 });
  const value = objects.get(key);
  if (!value) return new Response('missing', { status: 404 });
  return new Response(value, { status: 200, headers: { 'content-length': String(value.length) } });
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'mdrive-s3-'));
  process.env.DRIVE_DATA_DIR = dataDir;
  process.env.PORT = '0';
  process.env.HOST = '127.0.0.1';
  process.env.DRIVE_LOG = '0';
  process.env.DRIVE_STORAGE = 's3';
  process.env.DRIVE_S3_ENDPOINT = 'http://127.0.0.1:9000';
  process.env.DRIVE_S3_BUCKET = 'bucket';
  process.env.DRIVE_S3_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
  process.env.DRIVE_S3_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

  // The backend captures globalThis.fetch at construction, so the stub has to be
  // in place before the module is imported.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => String(url).startsWith('http://127.0.0.1:9000')
    ? stubFetch(url, init)
    : realFetch(url, init);

  const module = await import('../src/index.js?s3driver');
  server = module.server;
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  client = async (method, path, { body, token: bearer, headers = {}, raw = false } = {}) => {
    const init = { method, headers: { ...headers } };
    if (bearer) init.headers.authorization = 'Bearer ' + bearer;
    if (body !== undefined) {
      init.body = raw || typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
      if (!raw) init.headers['content-type'] = init.headers['content-type'] || 'application/json';
    }
    const response = await fetch('http://127.0.0.1:' + port + path, init);
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: response.status, json, text, headers: response.headers };
  };
  const registered = await client('POST', '/api/v1/auth/register', {
    body: { email: 's3-' + Date.now() + '@example.com', password: 's3 driver password' },
  });
  token = registered.json.token;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  for (const key of ['DRIVE_STORAGE', 'DRIVE_S3_ENDPOINT', 'DRIVE_S3_BUCKET', 'DRIVE_S3_ACCESS_KEY_ID', 'DRIVE_S3_SECRET_ACCESS_KEY']) delete process.env[key];
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* still locked */ }
});

const auth = (extra = {}) => ({ token, ...extra });

describe('server on the S3 driver', () => {
  it('uploads into the object store, not the local blob dir', async () => {
    const response = await client('PUT', '/api/v1/uploads?name=remote.txt', auth({
      raw: true, body: 'stored in s3', headers: { 'content-type': 'text/plain' },
    }));
    assert.equal(response.status, 201, response.text);
    assert.equal(objects.size, 1, 'exactly one object was written');
    const [key, value] = [...objects.entries()][0];
    // S3 has no directories, so the key is flat: bucket/<sha256>. The two-character
    // shard only exists in the local layout.
    assert.match(key, /^\/bucket\/[a-f0-9]{64}$/, key);
    assert.equal(value.toString(), 'stored in s3');
  });

  it('reads it back through the API', async () => {
    const nodes = await client('GET', '/api/v1/nodes', auth());
    const node = nodes.json.nodes.find((entry) => entry.name === 'remote.txt');
    const content = await client('GET', '/api/v1/files/' + node.id + '/content', auth());
    assert.equal(content.status, 200);
    assert.equal(content.text, 'stored in s3');
  });

  it('serves a range out of the object store', async () => {
    const nodes = await client('GET', '/api/v1/nodes', auth());
    const node = nodes.json.nodes.find((entry) => entry.name === 'remote.txt');
    const ranged = await client('GET', '/api/v1/files/' + node.id + '/content', auth({ headers: { range: 'bytes=0-5' } }));
    assert.equal(ranged.status, 206);
    assert.equal(ranged.text, 'stored');
  });

  it('reads text preview and the search index through the driver', async () => {
    const nodes = await client('GET', '/api/v1/nodes', auth());
    const node = nodes.json.nodes.find((entry) => entry.name === 'remote.txt');
    const preview = await client('GET', '/api/v1/files/' + node.id + '/text', auth());
    assert.equal(preview.status, 200);
    assert.equal(preview.json.text, 'stored in s3');
    const found = await client('GET', '/api/v1/search?q=stored&scope=content', auth());
    assert.ok(found.json.results.some((row) => row.id === node.id), JSON.stringify(found.json.results));
  });

  it('builds a ZIP by downloading the objects it needs', async () => {
    const folder = await client('POST', '/api/v1/nodes', auth({ body: { name: 'remote-folder', kind: 'folder' } }));
    await client('PUT', '/api/v1/uploads?parentId=' + folder.json.node.id + '&name=inner.txt', auth({
      raw: true, body: 'inner bytes', headers: { 'content-type': 'text/plain' },
    }));
    const archive = await client('POST', '/api/v1/nodes/' + folder.json.node.id + '/archive', auth({ body: {} }));
    assert.equal(archive.status, 201, archive.text);
    assert.ok(archive.json.node.size > 0);
  });

  it('deletes the object when the file is purged', async () => {
    const nodes = await client('GET', '/api/v1/nodes', auth());
    const node = nodes.json.nodes.find((entry) => entry.name === 'remote.txt');
    const before = objects.size;
    await client('DELETE', '/api/v1/nodes/' + node.id, auth());
    await client('DELETE', '/api/v1/nodes/' + node.id + '/permanent', auth());
    assert.equal(objects.size, before - 1, 'the object was removed from the store');
  });
});