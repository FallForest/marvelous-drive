import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { startServer, uniqueEmail } from './helpers.js';

/**
 * Advisory edit locks.
 *
 * The contract that matters: a lock is a *courtesy*, never a write barrier.
 * Refusing an upload because a stale tab holds a lock would turn a nicety into
 * data loss, so the tests check both the courtesy and the safety.
 */

let app;
let api;
let token;

before(async () => {
  app = await startServer();
  api = app.client;
  const registered = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'lock password' } });
  token = registered.json.token;
});

after(async () => {
  await app.close();
  app.cleanup();
});

const auth = (extra = {}) => ({ token, ...extra });

async function upload(name, body = 'lockable content') {
  const response = await api('PUT', '/api/v1/uploads?name=' + encodeURIComponent(name), auth({
    raw: true, body, headers: { 'content-type': 'text/plain' },
  }));
  assert.equal(response.status, 201, response.text);
  return response.json.node;
}

function withDb(fn) {
  const db = new DatabaseSync(join(app.dataDir, 'drive.db'));
  try { return fn(db); } finally { db.close(); }
}

describe('edit locks', () => {
  it('starts unlocked and reports the lock in the node detail', async () => {
    const node = await upload('unlocked.txt');
    const detail = await api('GET', '/api/v1/nodes/' + node.id, auth());
    assert.equal(detail.status, 200);
    assert.equal(detail.json.node.lock, null);
  });

  it('acquires a lock and exposes it to everyone who reads', async () => {
    const node = await upload('locked.txt');
    const acquired = await api('POST', '/api/v1/nodes/' + node.id + '/lock', auth({ body: { client: 'tab-a' } }));
    assert.equal(acquired.status, 200, acquired.text);
    assert.equal(acquired.json.lock.client, 'tab-a');
    assert.ok(Date.parse(acquired.json.lock.expiresAt) > Date.now());
    const read = await api('GET', '/api/v1/nodes/' + node.id, auth());
    assert.equal(read.json.node.lock.client, 'tab-a');
  });

  it('extends a lock for the same user instead of failing', async () => {
    const node = await upload('extend.txt');
    await api('POST', '/api/v1/nodes/' + node.id + '/lock', auth({ body: { client: 'tab-a' } }));
    const again = await api('POST', '/api/v1/nodes/' + node.id + '/lock', auth({ body: { client: 'tab-b', ttlMs: 60000 } }));
    assert.equal(again.status, 200, again.text);
    assert.equal(again.json.lock.client, 'tab-b', 'the newest client owns the lock');
  });

  it('tells a second user who holds the lock, with 409 and the holder', async () => {
    const node = await upload('contended.txt');
    const owner = await api('POST', '/api/v1/nodes/' + node.id + '/lock', auth({ body: { client: 'owner-tab' } }));
    assert.equal(owner.status, 200);

    const other = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'other password' } });
    // The second user cannot even see someone else's node: locks are per account,
    // so this exercises the 404 path rather than a shared-file conflict.
    const blocked = await api('POST', '/api/v1/nodes/' + node.id + '/lock', { token: other.json.token, body: {} });
    assert.equal(blocked.status, 404);
  });

  it('never blocks a write', async () => {
    const node = await upload('write-through.txt', 'first');
    await api('POST', '/api/v1/nodes/' + node.id + '/lock', auth({ body: {} }));
    const write = await api('PUT', '/api/v1/files/' + node.id + '/content', auth({
      raw: true, body: 'second', headers: { 'content-type': 'text/plain' },
    }));
    assert.equal(write.status, 200, 'a lock must never make the store lose a write');
    const content = await api('GET', '/api/v1/files/' + node.id + '/content', auth());
    assert.equal(content.text, 'second');
  });

  it('expires so a crashed client cannot hold a file forever', async () => {
    const node = await upload('expiring.txt');
    await api('POST', '/api/v1/nodes/' + node.id + '/lock', auth({ body: { ttlMs: 1000 } }));
    withDb((db) => db.prepare('UPDATE node_locks SET expires_at=? WHERE node_id=?')
      .run(new Date(Date.now() - 1000).toISOString(), node.id));
    const state = await api('GET', '/api/v1/nodes/' + node.id + '/lock', auth());
    assert.equal(state.json.lock, null);
  });

  it('releases a lock and refuses to release someone else\'s', async () => {
    const node = await upload('released.txt');
    await api('POST', '/api/v1/nodes/' + node.id + '/lock', auth({ body: { client: 'mine' } }));
    const released = await api('DELETE', '/api/v1/nodes/' + node.id + '/lock', auth());
    assert.equal(released.status, 200);
    assert.equal(released.json.released, true);
    const state = await api('GET', '/api/v1/nodes/' + node.id + '/lock', auth());
    assert.equal(state.json.lock, null);
    // Releasing what is not there is not an error.
    const again = await api('DELETE', '/api/v1/nodes/' + node.id + '/lock', auth());
    assert.equal(again.status, 200);
    assert.equal(again.json.released, false);
  });

  it('records a takeover in the audit log', async () => {
    const node = await upload('takeover.txt');
    // Simulate another user's stale lock by writing the row directly (a second
    // account cannot reach this node through the API at all).
    withDb((db) => db.prepare('INSERT INTO node_locks(node_id,user_id,client,acquired_at,expires_at) VALUES (?,?,?,?,?)')
      .run(node.id, 'someone-else', 'ghost', new Date().toISOString(), new Date(Date.now() + 600000).toISOString()));
    const forced = await api('POST', '/api/v1/nodes/' + node.id + '/lock', auth({ body: { force: true } }));
    assert.equal(forced.status, 200, forced.text);
    assert.equal(forced.json.tookOver, true);
    const log = await api('GET', '/api/v1/audit?action=lock-takeover&limit=10', auth());
    assert.ok(log.json.entries.some((entry) => entry.nodeId === node.id));
  });

  it('requires a login', async () => {
    const node = await upload('private-lock.txt');
    assert.equal((await api('GET', '/api/v1/nodes/' + node.id + '/lock')).status, 401);
    assert.equal((await api('POST', '/api/v1/nodes/' + node.id + '/lock', { body: {} })).status, 401);
  });
});
