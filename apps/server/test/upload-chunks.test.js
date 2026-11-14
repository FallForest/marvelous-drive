import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startServer, uniqueEmail } from './helpers.js';

/**
 * Parallel chunk writes.
 *
 * A browser sends two chunks of one file at a time. Each PUT reads the session
 * row, waits for its body, then merged the index back — and the second request
 * to finish used to write its snapshot of a Set it read before the first one
 * committed. The bytes landed, the index vanished, and complete answered 409
 * forever. These tests hold the merge to its promise.
 */

let app;
let api;
let token;

before(async () => {
  app = await startServer();
  api = app.client;
  const registered = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'chunk race password' } });
  token = registered.json.token;
});

after(async () => {
  await app.close();
  app.cleanup();
});

const auth = (extra = {}) => ({ token, ...extra });
const MiB = 1024 * 1024;

async function openSession(name, size, chunkSize) {
  const created = await api('POST', '/api/v1/uploads/sessions', auth({ body: { name, size, chunkSize } }));
  assert.equal(created.status, 201, created.text);
  return created.json.upload;
}

describe('parallel chunk writes', () => {
  it('records every index when all chunks arrive at once', async () => {
    const size = 4 * MiB;
    const chunkSize = 1 * MiB;
    const session = await openSession('race.bin', size, chunkSize);
    const body = Buffer.alloc(size, 7);

    const responses = await Promise.all([0, 1, 2, 3].map((index) => api(
      'PUT',
      '/api/v1/uploads/sessions/' + session.id + '/chunks/' + index,
      auth({ raw: true, body: body.subarray(index * chunkSize, (index + 1) * chunkSize), headers: { 'content-type': 'application/octet-stream' } }),
    )));
    for (const response of responses) assert.equal(response.status, 200, response.text);

    const state = await api('GET', '/api/v1/uploads/sessions/' + session.id, auth());
    assert.deepEqual(state.json.upload.receivedChunks, [0, 1, 2, 3]);

    const completed = await api('POST', '/api/v1/uploads/sessions/' + session.id + '/complete', auth());
    assert.equal(completed.status, 201, completed.text);
    assert.equal(completed.json.node.size, size);
  });

  it('still completes when chunks arrive in an interleaved order', async () => {
    const size = 3 * MiB;
    const chunkSize = 1 * MiB;
    const session = await openSession('interleaved.bin', size, chunkSize);
    const body = Buffer.alloc(size, 9);

    // Deliberately out of order and overlapping in time.
    await Promise.all([2, 0, 1].map((index) => api(
      'PUT',
      '/api/v1/uploads/sessions/' + session.id + '/chunks/' + index,
      auth({ raw: true, body: body.subarray(index * chunkSize, (index + 1) * chunkSize), headers: { 'content-type': 'application/octet-stream' } }),
    )));

    const state = await api('GET', '/api/v1/uploads/sessions/' + session.id, auth());
    assert.deepEqual(state.json.upload.receivedChunks, [0, 1, 2]);
    const completed = await api('POST', '/api/v1/uploads/sessions/' + session.id + '/complete', auth());
    assert.equal(completed.status, 201, completed.text);
  });

  it('reports the missing indexes instead of pretending the upload is done', async () => {
    const size = 3 * MiB;
    const session = await openSession('partial.bin', size, 1 * MiB);
    const body = Buffer.alloc(1 * MiB, 1);
    await api('PUT', '/api/v1/uploads/sessions/' + session.id + '/chunks/1', auth({
      raw: true, body, headers: { 'content-type': 'application/octet-stream' },
    }));

    const completed = await api('POST', '/api/v1/uploads/sessions/' + session.id + '/complete', auth());
    assert.equal(completed.status, 409);
    assert.equal(completed.json.error.code, 'UPLOAD_INCOMPLETE');
  });
});
