import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createHash } from 'node:crypto';
import { LocalBackend } from '../src/storage/backend.js';
import { S3Backend } from '../src/storage/s3.js';
import { TieredBackend } from '../src/storage/tiered.js';

/**
 * The two-tier store.
 *
 * Reads must not care which tier a blob is in; writes land hot; and a migration
 * must never delete the source before the destination is proven to hold the same
 * bytes — that is the one failure mode that loses data.
 */

const CREDENTIALS = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
};

/** A stub S3 backed by a Map, enough for the tier tests. */
function stubS3() {
  const objects = new Map();
  const calls = [];
  const fetchImpl = async (url, init) => {
    const key = decodeURIComponent(new URL(url).pathname);
    calls.push({ method: init.method, key });
    if (init.method === 'PUT') {
      const body = init.body;
      if (Buffer.isBuffer(body)) objects.set(key, body);
      else if (typeof body === 'string') objects.set(key, Buffer.from(body));
      else {
        const chunks = [];
        for await (const chunk of body) chunks.push(Buffer.from(chunk));
        objects.set(key, Buffer.concat(chunks));
      }
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
  };
  return { objects, calls, fetchImpl };
}

let hotDir;
let srv;
let store;

before(() => {
  hotDir = mkdtempSync(join(tmpdir(), 'tier-hot-'));
  srv = stubS3();
  store = new TieredBackend({
    hot: new LocalBackend(hotDir),
    cold: new S3Backend({
      settings: { endpoint: 'http://127.0.0.1:9000', bucket: 'coldbucket', prefix: 'cold', ...CREDENTIALS },
      fetchImpl: srv.fetchImpl,
    }),
  });
});

after(() => {
  try { rmSync(hotDir, { recursive: true, force: true }); } catch { /* locked */ }
});

const sha = (text) => createHash('sha256').update(text).digest('hex');

describe('tiered backend', () => {
  it('writes hot and reads back', async () => {
    const body = 'tiered body';
    const key = sha(body);
    await store.putBytes(key, Buffer.from(body));
    assert.equal(await store.tierOf(key), 'hot');
    const chunks = [];
    for await (const chunk of store.get(key)) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), body);
  });

  it('migrates a blob to cold and verifies the bytes before deleting the source', async () => {
    const body = 'migrate me';
    const key = sha(body);
    await store.putBytes(key, Buffer.from(body));
    const result = await store.migrateToCold(key);
    assert.equal(result.moved, true, JSON.stringify(result));
    assert.equal(await store.tierOf(key), 'cold');
    assert.equal((await store.hot.stat(key)), null, 'the local copy is gone');
    assert.equal(srv.objects.get('/coldbucket/cold/' + key).toString(), body);
  });

  it('refuses to delete the source when the bytes do not match the key', async () => {
    const key = sha('honest bytes');
    await store.putBytes(key, Buffer.from('honest bytes'));
    const path = join(hotDir, key.slice(0, 2), key);
    // Corrupt the local file: the migration must notice and leave everything alone.
    writeFileSync(path, 'X'.repeat('honest bytes'.length));
    const result = await store.migrateToCold(key);
    assert.equal(result.moved, false);
    assert.equal(result.reason, 'checksum-mismatch');
    assert.ok(readFileSync(path).length > 0, 'the source is still there');
  });

  it('reads a cold blob transparently and can promote it', async () => {
    const body = 'cold content';
    const key = sha(body);
    await store.putBytes(key, Buffer.from(body));
    await store.migrateToCold(key);
    const chunks = [];
    for await (const chunk of store.get(key)) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), body);
    const promoted = await store.promoteToHot(key);
    assert.equal(promoted.moved, true, JSON.stringify(promoted));
    assert.equal(await store.tierOf(key), 'hot');
  });

  it('link() gives a readable path for either tier', async () => {
    const hotKey = sha('link hot');
    await store.putBytes(hotKey, Buffer.from('link hot'));
    const coldKey = sha('link cold');
    await store.putBytes(coldKey, Buffer.from('link cold'));
    await store.migrateToCold(coldKey);
    const targetA = join(hotDir, 'link-hot.bin');
    const targetB = join(hotDir, 'link-cold.bin');
    await store.link(hotKey, targetA);
    await store.link(coldKey, targetB);
    assert.equal((await readFile(targetA)).toString(), 'link hot');
    assert.equal((await readFile(targetB)).toString(), 'link cold');
  });

  it('remove() clears both tiers', async () => {
    const body = 'remove both';
    const key = sha(body);
    await store.putBytes(key, Buffer.from(body));
    await store.migrateToCold(key);
    // Leave a stray local copy, as a half-finished migration would.
    await store.hot.putBytes(key, Buffer.from(body));
    await store.remove(key);
    assert.equal(await store.tierOf(key), null);
  });

  it('has no stable path, and says so', () => {
    assert.throws(() => store.path('x'), /no stable path/);
  });

  it('treats migrating an unknown key as a no-op', async () => {
    const result = await store.migrateToCold(sha('never stored'));
    assert.equal(result.moved, false);
    assert.equal(result.reason, 'missing');
  });
});
