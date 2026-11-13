import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EMPTY_SHA256, S3Backend, signRequest, uriEncode } from '../src/storage/s3.js';

/**
 * SigV4 signing and the S3 backend against a stub S3.
 *
 * A wrong signature fails with 403 and no useful detail, so the canonical
 * request is checked against the worked example from the AWS documentation
 * (the GET-object example, dated 2013-05-24). That test is the only thing
 * standing between a typo and an afternoon of confusion.
 */

const CREDENTIALS = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 's3',
};

describe('SigV4', () => {
  it('builds the canonical request from the AWS documentation example', () => {
    // GET /test.txt with Range: bytes=0-9 at 2013-05-24T00:00:00Z. The documented
    // canonical request is reproduced byte for byte; that text is the contract,
    // and a signature is only as good as it.
    const signed = signRequest({
      ...CREDENTIALS,
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      headers: { range: 'bytes=0-9' },
      now: new Date('2013-05-24T00:00:00Z'),
    });
    assert.equal(signed.amzDate, '20130524T000000Z');
    assert.equal(signed.canonicalRequest, [
      'GET',
      '/test.txt',
      '',
      'host:examplebucket.s3.amazonaws.com',
      'range:bytes=0-9',
      'x-amz-content-sha256:' + EMPTY_SHA256,
      'x-amz-date:20130524T000000Z',
      '',
      'host;range;x-amz-content-sha256;x-amz-date',
      EMPTY_SHA256,
    ].join('\n'));
    assert.match(signed.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/);
    // The string-to-sign is deterministic too, and its shape is what a 403 turns
    // into when a header is missing.
    assert.equal(signed.stringToSign.split('\n').slice(0, 3).join(' | '),
      'AWS4-HMAC-SHA256 | 20130524T000000Z | 20130524/us-east-1/s3/aws4_request');
  });

  it('encodes a key the way AWS expects, not the way encodeURIComponent does', () => {
    assert.equal(uriEncode('a b'), 'a%20b');
    assert.equal(uriEncode('a/b'), 'a%2Fb');
    assert.equal(uriEncode('a/b', true), 'a/b');
    assert.equal(uriEncode('(paren)'), '%28paren%29');
    assert.equal(uriEncode('中文'), '%E4%B8%AD%E6%96%87');
  });

  it('sorts query parameters and signs the session token when present', () => {
    const signed = signRequest({
      ...CREDENTIALS,
      method: 'PUT',
      host: 'bucket.local',
      path: '/b/k',
      query: { b: '2', a: '1' },
      sessionToken: 'TOKEN',
      now: new Date('2026-01-01T00:00:00Z'),
    });
    assert.match(signed.canonicalRequest, /a=1&b=2/);
    assert.match(signed.authorization, /x-amz-security-token/);
  });
});

describe('S3Backend', () => {
/** A stub S3: records requests, serves an in-memory object table. */
  function stub() {
    const objects = new Map();
    const calls = [];
    const fetchImpl = async (url, init) => {
      const parsed = new URL(url);
      const key = decodeURIComponent(parsed.pathname);
      calls.push({ method: init.method, key, headers: init.headers });
      if (init.method === 'PUT') {
        const body = typeof init.body === 'string' ? Buffer.from(init.body) : Buffer.from(init.body);
        objects.set(key, body);
        return new Response(null, { status: 200 });
      }
      if (init.method === 'HEAD') {
        const value = objects.get(key);
        return new Response(null, { status: value ? 200 : 404, headers: value ? { 'content-length': String(value.length) } : {} });
      }
      if (init.method === 'DELETE') {
        const had = objects.delete(key);
        return new Response(null, { status: had ? 204 : 404 });
      }
      const value = objects.get(key);
      if (!value) return new Response('missing', { status: 404 });
      return new Response(value, { status: 200, headers: { 'content-length': String(value.length) } });
    };
    return { objects, calls, fetchImpl };
  }

  const backend = (srv) => new S3Backend({
    settings: {
      endpoint: 'http://127.0.0.1:9000',
      bucket: 'bucket',
      ...CREDENTIALS,
      secretAccessKey: CREDENTIALS.secretAccessKey,
      region: CREDENTIALS.region,
    },
    fetchImpl: srv.fetchImpl,
  });

  it('round-trips bytes with path-style addressing', async () => {
    const srv = stub();
    const store = backend(srv);
    const hash = 'a'.repeat(64);
    await store.putBytes(hash, Buffer.from('hello s3'));
    assert.deepEqual(await store.stat(hash), { size: 8 });
    const chunks = [];
    for await (const chunk of store.get(hash)) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), 'hello s3');
    await store.remove(hash);
    assert.equal(await store.stat(hash), null);
    await store.remove(hash);
  });

  it('signs every request and never sends a bare path', async () => {
    const srv = stub();
    const store = backend(srv);
    await store.putBytes('b'.repeat(64), Buffer.from('x'));
    const put = srv.calls.find((call) => call.method === 'PUT');
    assert.match(put.headers.authorization, /^AWS4-HMAC-SHA256 Credential=/);
    assert.match(put.key, /^\/bucket\/bb/);
  });

  it('refuses to pretend it has a local path', () => {
    const srv = stub();
    const store = backend(srv);
    assert.throws(() => store.path(), /no local paths/);
  });

  it('falls back to a download for link()', async () => {
    const srv = stub();
    const store = backend(srv);
    const { mkdtemp, readFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 's3-link-'));
    const hash = 'c'.repeat(64);
    await store.putBytes(hash, Buffer.from('linked bytes'));
    const target = join(dir, 'out.bin');
    await store.link(hash, target);
    assert.equal((await readFile(target)).toString(), 'linked bytes');
    await rm(dir, { recursive: true, force: true });
  });

  it('honours a prefix and reports a 404 as null', async () => {
    const srv = stub();
    const store = new S3Backend({
      settings: { endpoint: 'http://127.0.0.1:9000', bucket: 'bucket', prefix: 'drive', ...CREDENTIALS },
      fetchImpl: srv.fetchImpl,
    });
    await store.putBytes('d'.repeat(64), Buffer.from('y'));
    assert.ok(srv.objects.has('/bucket/drive/' + 'd'.repeat(64)));
    assert.equal(await store.stat('e'.repeat(64)), null);
  });
});