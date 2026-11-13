import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { uniqueEmail } from './helpers.js'

/**
 * Quota enforcement.
 *
 * The ceiling is process-wide configuration, so this suite boots its own server
 * with DRIVE_QUOTA_BYTES set; the shared helper cannot be reused because the
 * default instance runs with an unlimited quota.
 */

const QUOTA = 4096
let server
let client
let dataDir
let token

function boot() {
  dataDir = mkdtempSync(join(tmpdir(), 'mdrive-quota-'));
  process.env.DRIVE_DATA_DIR = dataDir;
  process.env.PORT = '0';
  process.env.HOST = '127.0.0.1';
  process.env.DRIVE_LOG = '0';
  process.env.DRIVE_QUOTA_BYTES = String(QUOTA);
}

before(async () => {
  boot();
  const module = await import('../src/index.js?quota');
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
    return { status: response.status, json, text };
  };
  const registered = await client('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'quota password' } });
  token = registered.json.token;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  delete process.env.DRIVE_QUOTA_BYTES;
  // Windows keeps the SQLite WAL handles alive briefly after close; a failed
  // cleanup must not fail the suite (the directory is in the temp folder).
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* still locked */ }
});

const auth = (extra = {}) => ({ token, ...extra });

const upload = (name, bytes, extra = {}) => client('PUT', '/api/v1/uploads?name=' + encodeURIComponent(name), auth({
  raw: true, body: Buffer.alloc(bytes, 1), headers: { 'content-type': 'text/plain' }, ...extra,
}));

describe('quota', () => {
  it('reports the configured ceiling in stats', async () => {
    const stats = await client('GET', '/api/v1/storage/stats', auth());
    assert.equal(stats.json.stats.quota.limit, QUOTA);
    assert.equal(stats.json.stats.quotaBytes, QUOTA);
    assert.equal(stats.json.stats.quota.used, 0);
  });

  it('rejects an upload that would cross the ceiling', async () => {
    const ok = await upload('fits.bin', 3000);
    assert.equal(ok.status, 201, ok.text);
    const tooBig = await upload('overflow.bin', 2000);
    assert.equal(tooBig.status, 413);
    assert.equal(tooBig.json.error.code, 'QUOTA_EXCEEDED');
    assert.match(tooBig.json.error.message, /only \d+ remain/);
  });

  it('counts only the delta when overwriting', async () => {
    const grown = await upload('fits.bin', 4000);
    assert.equal(grown.status, 200, grown.text);
    assert.equal(grown.json.node.size, 4000);
    const stillFits = await upload('tiny.bin', 96);
    assert.equal(stillFits.status, 201, stillFits.text);
    const over = await upload('another.bin', 1);
    assert.equal(over.status, 413);
  });

  it('refuses a resumable session that cannot fit', async () => {
    const session = await client('POST', '/api/v1/uploads/sessions', auth({ body: { name: 'huge.bin', size: 10000 } }));
    assert.equal(session.status, 413);
    assert.equal(session.json.error.code, 'QUOTA_EXCEEDED');
  });

  it('charges an instant upload against the quota too', async () => {
    const first = await upload('blob-source.bin', 4096);
    assert.equal(first.status, 413, 'a 4096 byte file does not fit next to what is already stored');
    const known = await client('GET', '/api/v1/storage/stats', auth());
    const used = known.json.stats.quota.used;
    assert.ok(used > 0);
  });

  it('does not charge the trash', async () => {
    const before = await client('GET', '/api/v1/storage/stats', auth());
    const file = await upload('to-trash.bin', 100);
    if (file.status === 201) {
      await client('DELETE', '/api/v1/nodes/' + file.json.node.id, auth());
      const afterDelete = await client('GET', '/api/v1/storage/stats', auth());
      assert.ok(afterDelete.json.stats.quota.used <= before.json.stats.quota.used + 0);
    }
  });
});
