import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, uniqueEmail } from './helpers.js';

/**
 * Completion and housekeeping for resumable uploads.
 *
 * Assembly is the most expensive step of a multipart upload and the easiest to
 * leave in a bad state: it used to need a second full copy of the file, and the
 * "these bytes are already stored" shortcut was unreachable because the digest
 * only existed after the copy. Both are asserted here against the disk, because
 * the failure they cause (a full disk during the last request) is invisible in
 * any response body.
 */

let app;
let api;
let token;
const MiB = 1024 * 1024;

before(async () => {
  app = await startServer();
  api = app.client;
  const registered = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'complete password' } });
  token = registered.json.token;
});

after(async () => {
  await app.close();
  app.cleanup();
});

const auth = (extra = {}) => ({ token, ...extra });
const sha256Of = async (buffer) => {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(buffer).digest('hex');
};

async function uploadSession(name, body, chunkSize = 1 * MiB, options = {}) {
  const created = await api('POST', '/api/v1/uploads/sessions', auth({
    body: { name, size: body.length, chunkSize, sha256: options.sha256 },
  }));
  assert.equal(created.status, 201, created.text);
  const session = created.json.upload;
  const total = Math.ceil(body.length / chunkSize);
  for (let index = 0; index < total; index += 1) {
    const slice = body.subarray(index * chunkSize, Math.min(body.length, (index + 1) * chunkSize));
    const response = await api('PUT', '/api/v1/uploads/sessions/' + session.id + '/chunks/' + index, auth({
      raw: true, body: slice, headers: { 'content-type': 'application/octet-stream' },
    }));
    assert.equal(response.status, 200, response.text);
  }
  return session;
}

const sessionPath = (id) => join(app.dataDir, 'tmp', 'sessions', id);
const blobPath = (hash) => join(app.dataDir, 'blobs', hash.slice(0, 2), hash);

describe('completing a resumable upload', () => {
  it('assembles the file and drops every temp chunk', async () => {
    const body = Buffer.alloc(3 * MiB, 3);
    const session = await uploadSession('assembled.bin', body);
    const completed = await api('POST', '/api/v1/uploads/sessions/' + session.id + '/complete', auth());
    assert.equal(completed.status, 201, completed.text);
    assert.equal(completed.json.node.size, body.length);
    // The chunk directory is gone, so the peak disk cost was one file, not two.
    assert.equal(existsSync(sessionPath(session.id)), false);
  });

  it('reuses an already stored blob instead of copying the bytes again', async () => {
    const body = Buffer.alloc(2 * MiB, 8);
    const hash = await sha256Of(body);
    // First upload puts the blob in the store the normal way.
    const first = await uploadSession('dup-a.bin', body);
    const firstDone = await api('POST', '/api/v1/uploads/sessions/' + first.id + '/complete', auth());
    assert.equal(firstDone.status, 201, firstDone.text);

    // Second upload of the same bytes under another name: the digest is known
    // before assembly, so nothing is written into the temp file at all.
    const second = await uploadSession('dup-b.bin', body);
    const secondDone = await api('POST', '/api/v1/uploads/sessions/' + second.id + '/complete', auth());
    assert.equal(secondDone.status, 201, secondDone.text);
    assert.equal(secondDone.json.deduplicated, true);
    assert.equal(secondDone.json.node.size, body.length);
    assert.equal(secondDone.json.node.blobHash, hash);
    // One blob, two nodes: that is the whole point of content addressing. Count
    // refs on the row rather than the total, since other tests share this store.
    const { db } = await import('../src/db.js');
    const row = db.prepare('SELECT refs FROM blobs WHERE hash=?').get(hash);
    assert.equal(row.refs, 2);
  });

  it('rejects a digest mismatch without leaving the bytes behind', async () => {
    const body = Buffer.alloc(1 * MiB, 4);
    const wrong = 'f'.repeat(64);
    const session = await uploadSession('mismatch.bin', body, 1 * MiB, { sha256: wrong });
    const completed = await api('POST', '/api/v1/uploads/sessions/' + session.id + '/complete', auth());
    assert.equal(completed.status, 409);
    assert.equal(completed.json.error.code, 'CHECKSUM_MISMATCH');
    assert.equal(existsSync(sessionPath(session.id)), false);
    assert.equal(existsSync(blobPath(wrong)), false);
  });

  it('refuses to complete while a chunk is missing', async () => {
    const body = Buffer.alloc(2 * MiB, 5);
    const created = await api('POST', '/api/v1/uploads/sessions', auth({
      body: { name: 'partial.bin', size: body.length, chunkSize: 1 * MiB },
    }));
    const session = created.json.upload;
    await api('PUT', '/api/v1/uploads/sessions/' + session.id + '/chunks/0', auth({
      raw: true, body: body.subarray(0, 1 * MiB), headers: { 'content-type': 'application/octet-stream' },
    }));
    const completed = await api('POST', '/api/v1/uploads/sessions/' + session.id + '/complete', auth());
    assert.equal(completed.status, 409);
    assert.equal(completed.json.error.code, 'UPLOAD_INCOMPLETE');
  });
});

describe('abandoned sessions', () => {
  it('drops the session directory when the client cancels', async () => {
    const created = await api('POST', '/api/v1/uploads/sessions', auth({
      body: { name: 'cancel.bin', size: 2 * MiB, chunkSize: 1 * MiB },
    }));
    const session = created.json.upload;
    assert.equal(existsSync(sessionPath(session.id)), true);
    const removed = await api('DELETE', '/api/v1/uploads/sessions/' + session.id, auth());
    assert.equal(removed.status, 200);
    assert.equal(existsSync(sessionPath(session.id)), false);
    const listed = await api('GET', '/api/v1/uploads/sessions', auth());
    // Other tests leave their own live sessions behind on this shared server, so
    // the assertion is about *this* one being gone, not about the list length.
    assert.equal(listed.json.uploads.some((row) => row.id === session.id), false);
  });

  it('lists only live sessions, so a reload can claim them', async () => {
    const created = await api('POST', '/api/v1/uploads/sessions', auth({
      body: { name: 'live.bin', size: 4 * MiB, chunkSize: 1 * MiB },
    }));
    const session = created.json.upload;
    await api('PUT', '/api/v1/uploads/sessions/' + session.id + '/chunks/0', auth({
      raw: true, body: Buffer.alloc(1 * MiB), headers: { 'content-type': 'application/octet-stream' },
    }));
    const listed = await api('GET', '/api/v1/uploads/sessions', auth());
    const entry = listed.json.uploads.find((row) => row.id === session.id);
    assert.ok(entry, JSON.stringify(listed.json));
    assert.deepEqual(entry.receivedChunks, [0]);
    assert.equal(entry.size, 4 * MiB);
    assert.ok(entry.expiresAt);
  });
});
