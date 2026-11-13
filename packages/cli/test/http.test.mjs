import test from 'node:test';
import assert from 'node:assert/strict';
import { CliError } from '../src/errors.js';
import {
  DEFAULT_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
  MIN_CHUNK_SIZE,
  RESUMABLE_THRESHOLD,
  chunkPlan,
  describeFailure,
  shouldUseResumable
} from '../src/http.js';

test('the resumable threshold is the documented 8 MiB', () => {
  assert.equal(RESUMABLE_THRESHOLD, 8 * 1024 * 1024);
  assert.equal(shouldUseResumable(8 * 1024 * 1024), false, 'exactly 8 MiB still uses one PUT');
  assert.equal(shouldUseResumable(8 * 1024 * 1024 + 1), true);
  assert.equal(shouldUseResumable(1), false);
});

test('chunk math follows ceil(size/chunkSize) with contiguous ranges', () => {
  const plan = chunkPlan({ size: 20 * 1024 * 1024, chunkSize: 8 * 1024 * 1024 });
  assert.equal(plan.totalChunks, 3);
  assert.deepEqual(plan.chunks.map(chunk => [chunk.index, chunk.start, chunk.end, chunk.length]), [
    [0, 0, 8 * 1024 * 1024, 8 * 1024 * 1024],
    [1, 8 * 1024 * 1024, 16 * 1024 * 1024, 8 * 1024 * 1024],
    [2, 16 * 1024 * 1024, 20 * 1024 * 1024, 4 * 1024 * 1024]
  ]);
  assert.equal(plan.chunks.reduce((sum, chunk) => sum + chunk.length, 0), 20 * 1024 * 1024);
});

test('a size that is an exact multiple of chunkSize yields no empty trailing chunk', () => {
  const plan = chunkPlan({ size: 16 * 1024 * 1024, chunkSize: 8 * 1024 * 1024 });
  assert.equal(plan.totalChunks, 2);
  assert.equal(plan.chunks[1].length, 8 * 1024 * 1024);
});

test('an empty file still needs one chunk (contract: max(1, ...))', () => {
  const plan = chunkPlan({ size: 0, chunkSize: DEFAULT_CHUNK_SIZE });
  assert.equal(plan.totalChunks, 1);
  assert.equal(plan.chunks[0].length, 0);
});

test('a single byte above the chunk size rolls over to a second chunk', () => {
  const plan = chunkPlan({ size: 1024 * 1024 + 1, chunkSize: 1024 * 1024 });
  assert.equal(plan.totalChunks, 2);
  assert.equal(plan.chunks[1].length, 1);
});

test('chunk size bounds are enforced', () => {
  assert.throws(() => chunkPlan({ size: 1, chunkSize: MIN_CHUNK_SIZE - 1 }), /between 65536 and 67108864/);
  assert.throws(() => chunkPlan({ size: 1, chunkSize: MAX_CHUNK_SIZE + 1 }), /between/);
  assert.doesNotThrow(() => chunkPlan({ size: 1, chunkSize: 64 * 1024 * 1024 }));
  assert.throws(() => chunkPlan({ size: -1 }), /non-negative integer/);
});

test('resuming skips chunks the server already has', () => {
  const plan = chunkPlan({ size: 10 * 1024 * 1024, chunkSize: 4 * 1024 * 1024 });
  const received = [0];
  const pending = plan.chunks.filter(chunk => !received.includes(chunk.index));
  assert.deepEqual(pending.map(chunk => chunk.index), [1, 2]);
  assert.equal(pending.reduce((sum, chunk) => sum + chunk.length, 0), 6 * 1024 * 1024);
});

const fakeUrl = new URL('http://127.0.0.1:4400/api/v1/uploads/sessions/x/chunks/0');

function failure(status, payload) {
  return describeFailure({ status, payload, url: fakeUrl, method: 'PUT' });
}

test('401 explains how to authenticate', () => {
  const error = failure(401, { error: { code: 'UNAUTHENTICATED', message: 'Bearer required.' } });
  assert.ok(error instanceof CliError);
  assert.equal(error.exitCode, 1);
  assert.match(error.message, /HTTP 401 UNAUTHENTICATED/);
  assert.match(error.message, /mdrive login/);
});

test('403 names the permission problem', () => {
  assert.match(failure(403, { error: { code: 'FORBIDDEN', message: 'Nope.' } }).message, /not allowed/);
});

test('404 hints at the id or path, with code specific guidance', () => {
  assert.match(failure(404, { error: { code: 'NOT_FOUND', message: 'Gone.' } }).message, /mdrive ls/);
  assert.match(failure(404, { error: { code: 'NOT_A_FILE', message: 'Folder.' } }).message, /not a folder|not a file|Run the command/);
  assert.match(failure(404, { error: { code: 'SHARE_NOT_FOUND', message: 'x' } }).message, /revoked|expired/);
});

test('409 CONFLICT suggests --name, VERSION_CONFLICT suggests stat, UPLOAD_INCOMPLETE suggests resuming', () => {
  assert.match(failure(409, { error: { code: 'CONFLICT', message: 'Exists.' } }).message, /--name/);
  assert.match(failure(409, { error: { code: 'VERSION_CONFLICT', message: 'v3' } }).message, /mdrive stat/);
  assert.match(failure(409, { error: { code: 'UPLOAD_INCOMPLETE', message: 'missing' } }).message, /rerun the upload/);
  assert.match(failure(409, { error: { code: 'CHECKSUM_MISMATCH', message: 'hash' } }).message, /sha256/);
});

test('413 mentions the size limit, 429 suggests backing off, 503 says the server is down', () => {
  assert.match(failure(413, { error: { code: 'FILE_TOO_LARGE', message: 'big' } }).message, /DRIVE_MAX_UPLOAD_BYTES/);
  assert.match(failure(429, { error: { code: 'RATE_LIMITED', message: 'slow' } }).message, /retry/);
  assert.match(failure(503, { error: { code: 'INTERNAL_ERROR', message: 'down' } }).message, /temporarily unavailable/);
  assert.match(failure(500, { error: { code: 'INTERNAL_ERROR', message: 'boom' } }).message, /server failed/);
});

test('error envelopes keep their code and status for callers', () => {
  const error = failure(409, { error: { code: 'CONFLICT', message: 'Exists.' } });
  assert.equal(error.code, 'CONFLICT');
  assert.equal(error.status, 409);
  assert.equal(error.exitCode, 1, 'every API failure exits 1 per the contract');
});
