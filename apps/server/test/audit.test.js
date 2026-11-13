import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { startServer, uniqueEmail } from './helpers.js'

/**
 * The audit trail has one job: after the fact, say who did what, and never lie.
 * These tests check both halves — the entries exist, and a failed operation
 * leaves no entry behind.
 */

let app
let api
let token

before(async () => {
  app = await startServer();
  api = app.client;
  const registered = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'audit password' } });
  token = registered.json.token;
});

after(async () => {
  await app.close();
  app.cleanup();
});

const auth = (extra = {}) => ({ token, ...extra });
const audit = () => api('GET', '/api/v1/audit?limit=200', auth());

describe('audit log', () => {
  it('records an upload with the node and the size', async () => {
    const uploaded = await api('PUT', '/api/v1/uploads?name=audited.txt', auth({
      raw: true, body: 'audited bytes', headers: { 'content-type': 'text/plain' },
    }));
    assert.equal(uploaded.status, 201);
    const log = await audit();
    const entry = log.json.entries.find((row) => row.nodeId === uploaded.json.node.id && row.action === 'upload');
    assert.ok(entry, JSON.stringify(log.json.entries.slice(0, 3)));
    assert.match(entry.detail, /audited\.txt/);
    assert.ok(entry.createdAt);
  });

  it('distinguishes an overwrite from a first upload', async () => {
    const first = await api('PUT', '/api/v1/uploads?name=twice.txt', auth({
      raw: true, body: 'v1', headers: { 'content-type': 'text/plain' },
    }));
    await api('PUT', '/api/v1/uploads?name=twice.txt', auth({
      raw: true, body: 'v2', headers: { 'content-type': 'text/plain' },
    }));
    const log = await audit();
    const entries = log.json.entries.filter((row) => row.nodeId === first.json.node.id).map((row) => row.action);
    assert.ok(entries.includes('upload'));
    assert.ok(entries.includes('overwrite'), 'the second write is an overwrite');
  });

  it('records trash and restore in order', async () => {
    const file = await api('PUT', '/api/v1/uploads?name=cycle.txt', auth({
      raw: true, body: 'cycle', headers: { 'content-type': 'text/plain' },
    }));
    await api('DELETE', `/api/v1/nodes/${file.json.node.id}`, auth());
    await api('POST', `/api/v1/nodes/${file.json.node.id}/restore`, auth({ body: {} }));
    const log = await audit();
    const actions = log.json.entries.filter((row) => row.nodeId === file.json.node.id).map((row) => row.action);
    assert.deepEqual(actions.slice(0, 2), ['restore', 'trash'], 'newest first');
  });

  it('does not record an operation that failed', async () => {
    const before = await audit();
    const rejected = await api('POST', '/api/v1/nodes', auth({ body: { name: 'a/b.txt' } }));
    assert.equal(rejected.status, 400);
    const afterFail = await audit();
    assert.equal(afterFail.json.entries.length, before.json.entries.length, 'a rejected write leaves no trace');
  });

  it('filters by node and by action, and caps the limit', async () => {
    const byAction = await api('GET', '/api/v1/audit?action=upload&limit=1', auth());
    assert.equal(byAction.status, 200);
    assert.ok(byAction.json.entries.length <= 1);
    assert.ok(byAction.json.entries.every((row) => row.action === 'upload'));
    const huge = await api('GET', '/api/v1/audit?limit=100000', auth());
    assert.ok(huge.json.entries.length <= 200, 'the limit is clamped');
  });

  it('never shows another account\'s entries', async () => {
    const other = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'other password' } });
    const otherToken = other.json.token;
    await api('PUT', '/api/v1/uploads?name=private.txt', { token: otherToken, raw: true, body: 'private', headers: { 'content-type': 'text/plain' } });
    const mine = await audit();
    assert.ok(!mine.json.entries.some((row) => row.detail && row.detail.includes('private.txt')));
  });

  it('requires authentication', async () => {
    const anonymous = await api('GET', '/api/v1/audit');
    assert.equal(anonymous.status, 401);
  });
});
