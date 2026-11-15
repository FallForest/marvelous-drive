import assert from 'node:assert/strict';
import { before, after, describe, it } from 'node:test';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { startServer, uniqueEmail } from './helpers.js';

let app, api, token;
before(async () => {
  app = await startServer();
  api = app.client;
  token = (await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'content edit password' } })).json.token;
});
after(async () => { await app.close(); app.cleanup(); });
const auth = (extra = {}) => ({ token, ...extra });
const write = (id, body, query = '') => api('PUT', '/api/v1/files/' + id + '/content' + query,
  auth({ raw: true, body, headers: { 'content-type': 'text/plain' } }));
const upload = async (name) => (await api('PUT', '/api/v1/uploads?name=' + name,
  auth({ raw: true, body: 'original', headers: { 'content-type': 'text/plain' } }))).json.node;
function blobRefs(body) {
  const database = new DatabaseSync(join(app.dataDir, 'drive.db'));
  try { return database.prepare('SELECT refs FROM blobs WHERE hash=?').get(createHash('sha256').update(body).digest('hex'))?.refs || 0; }
  finally { database.close(); }
}

describe('version checked content replacement', () => {
  it('saves matching versions and preserves the old bytes in history', async () => {
    const node = await upload('guarded.txt');
    const saved = await write(node.id, 'new text', '?expectedVersion=1');
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.json.node.version, 2);
    const history = await api('GET', '/api/v1/files/' + node.id + '/versions', auth());
    assert.equal(history.json.versions.length, 1);
    const old = await api('GET', '/api/v1/files/' + node.id + '/versions/' + history.json.versions[0].id + '/content', auth());
    assert.equal(old.text, 'original');
    assert.equal((await write(node.id, 'unguarded legacy caller')).status, 200);
  });

  it('rejects invalid version values without altering content or history', async () => {
    const node = await upload('invalid.txt');
    for (const value of ['', '0', '-1', '1.5', 'NaN', '1e0', '9007199254740992']) {
      const result = await write(node.id, 'invalid ' + value, '?expectedVersion=' + value);
      assert.equal(result.status, 400, value + ': ' + result.text);
    }
    assert.equal((await api('GET', '/api/v1/files/' + node.id + '/content', auth())).text, 'original');
    assert.equal((await api('GET', '/api/v1/files/' + node.id + '/versions', auth())).json.versions.length, 0);
  });

  it('leaves current bytes and blob references intact after a stale save', async () => {
    const node = await upload('stale.txt');
    await write(node.id, 'remote edit', '?expectedVersion=1');
    const rejected = 'rejected unique draft';
    const result = await write(node.id, rejected, '?expectedVersion=1');
    assert.equal(result.status, 409);
    assert.equal(result.json.error.code, 'VERSION_CONFLICT');
    assert.equal(blobRefs(rejected), 0, 'discard the newly adopted draft blob');
    assert.equal((await api('GET', '/api/v1/files/' + node.id + '/content', auth())).text, 'remote edit');
    assert.equal((await api('GET', '/api/v1/files/' + node.id + '/versions', auth())).json.versions.length, 1);
  });

  it('rechecks after a streamed request body lets another writer finish', async () => {
    const node = await upload('streamed.txt');
    let incoming;
    const result = new Promise((resolve, reject) => {
      incoming = httpRequest({ host: '127.0.0.1', port: app.port, path: '/api/v1/files/' + node.id + '/content?expectedVersion=1',
        method: 'PUT', headers: { authorization: 'Bearer ' + token, 'content-type': 'text/plain' } }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body }));
      });
      incoming.on('error', reject);
      incoming.write('slow-');
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal((await write(node.id, 'the winning edit', '?expectedVersion=1')).status, 200);
    incoming.end('draft');
    const rejected = await result;
    assert.equal(rejected.status, 409, rejected.body);
    assert.equal(blobRefs('slow-draft'), 0);
    assert.equal((await api('GET', '/api/v1/files/' + node.id + '/content', auth())).text, 'the winning edit');
    assert.equal((await api('GET', '/api/v1/files/' + node.id + '/versions', auth())).json.versions.length, 1);
  });

  it('an older editor cannot release a newer same-account lock', async () => {
    const node = await upload('client-lock.txt');
    await api('POST', '/api/v1/nodes/' + node.id + '/lock', auth({ body: { client: 'editor-a' } }));
    await api('POST', '/api/v1/nodes/' + node.id + '/lock', auth({ body: { client: 'editor-b' } }));
    const stale = await api('DELETE', '/api/v1/nodes/' + node.id + '/lock?client=editor-a', auth());
    assert.equal(stale.json.released, false);
    assert.equal((await api('GET', '/api/v1/nodes/' + node.id + '/lock', auth())).json.lock.client, 'editor-b');
    assert.equal((await api('DELETE', '/api/v1/nodes/' + node.id + '/lock?client=editor-b', auth())).json.released, true);
  });
});
