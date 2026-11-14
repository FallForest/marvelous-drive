import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createUploadTask, isRetryable, MAX_ATTEMPTS, RETRY_BACKOFF, SIMPLE_LIMIT } from '../lib/upload.js'

/**
 * Resume correctness and automatic retry.
 *
 * The bugs these tests pin down are invisible in the happy path: a resumed
 * session whose chunk size the client did not pick, a progress bar that walked
 * backwards on retry, and a dropped connection that ended an upload outright.
 *
 * Every fixture is above SIMPLE_LIMIT on purpose — anything smaller takes the
 * single-request path and never opens a session at all.
 */

const MiB = 1024 * 1024

function apiError(message, status, code) {
  const error = new Error(message)
  error.status = status
  error.code = code || 'HTTP_' + status
  return error
}

/**
 * A session server whose chunk size is deliberately NOT the client default.
 * Every chunk PUT records the byte count it was asked to carry, which is where
 * a mislabelled boundary shows up.
 */
function sessionServer(options) {
  const opts = options || {}
  const chunkSize = opts.chunkSize
  const received = new Set(opts.received || [])
  const sizes = []
  const puts = []
  let failuresLeft = Number(opts.failFirstN) || 0
  const totalChunks = Math.ceil(opts.size / chunkSize)
  const snapshot = () => ({ id: 'sess-r', chunkSize, totalChunks, receivedChunks: [...received] })
  const client = {
    calls: [],
    request: async (path, requestOptions) => {
      client.calls.push(path)
      const method = (requestOptions && requestOptions.method) || 'GET'
      if (path === '/uploads/sessions' && method === 'POST') return { upload: snapshot() }
      if (path === '/uploads/sessions/sess-r') return { upload: snapshot() }
      if (path === '/uploads/sessions/sess-r/complete') return { node: { id: 'node-r', size: opts.size } }
      if (path.startsWith('/blobs/')) throw apiError('missing', 404, 'NOT_FOUND')
      if (method === 'DELETE') return { ok: true }
      throw new Error('unexpected ' + method + ' ' + path)
    },
    putRaw: async (path, blob, putOptions) => {
      puts.push(path)
      const index = Number(path.slice(path.lastIndexOf('/') + 1))
      if (failuresLeft > 0) {
        failuresLeft -= 1
        throw apiError('connection reset', 0, 'NETWORK_ERROR')
      }
      sizes.push({ index, size: blob.size })
      received.add(index)
      if (putOptions && putOptions.onProgress) putOptions.onProgress(blob.size, blob.size)
      return { ok: true }
    },
  }
  return { client, received, sizes, puts }
}

const fileOf = (name, length) => new File([new Uint8Array(length)], name, { type: 'application/octet-stream' })

describe('resuming a session with a foreign chunk size', () => {
  it('derives boundaries from the session, not from the client default', async () => {
    const size = 12 * MiB
    // 4 MiB chunks: the server opened this session, not the client.
    const { client, sizes } = sessionServer({ size, chunkSize: 4 * MiB })
    const task = createUploadTask({ file: fileOf('twelve.bin', size), api: client })

    await task.start()

    assert.equal(task.state, 'done')
    assert.equal(task.chunkSize, 4 * MiB)
    assert.deepEqual(sizes.map((entry) => entry.index), [0, 1, 2])
    assert.deepEqual(sizes.map((entry) => entry.size), [4 * MiB, 4 * MiB, 4 * MiB])
  })

  it('reports the bytes already stored instead of restarting the bar', async () => {
    const size = 12 * MiB
    const { client, sizes } = sessionServer({ size, chunkSize: 4 * MiB, received: [0, 1] })
    const task = createUploadTask({ file: fileOf('half.bin', size), api: client })
    const seen = []
    task.on('progress', (event) => seen.push(event.progress))

    // A task that already holds the session id takes the resume branch.
    task.sessionId = 'sess-r'
    await task.start()

    assert.equal(task.state, 'done')
    // Only the missing chunk is sent, and the first reading is the resume point.
    assert.deepEqual(sizes.map((entry) => entry.index), [2])
    assert.equal(seen[0], (8 * MiB) / size)
    assert.equal(Math.min(...seen), (8 * MiB) / size)
  })
})

describe('automatic retry', () => {
  it('retries a dropped connection and finishes the upload', async () => {
    const size = 12 * MiB
    const { client, puts } = sessionServer({ size, chunkSize: 4 * MiB, failFirstN: 1 })
    const task = createUploadTask({
      file: fileOf('flaky.bin', size), api: client, retryBackoff: [0],
    })

    await task.start()

    assert.equal(task.state, 'done')
    assert.equal(task.node.id, 'node-r')
    // Three chunks, one of them attempted twice.
    assert.equal(puts.length, 4)
    assert.equal(task.attempts, 2)
  })

  it('classifies transient failures and leaves permanent ones alone', () => {
    assert.equal(isRetryable(apiError('reset', 0, 'NETWORK_ERROR')), true)
    assert.equal(isRetryable(apiError('bad gateway', 502)), true)
    assert.equal(isRetryable(apiError('timeout', 408)), true)
    assert.equal(isRetryable(apiError('slow down', 429)), true)
    assert.equal(isRetryable(apiError('too large', 413, 'FILE_TOO_LARGE')), false)
    assert.equal(isRetryable(apiError('bad checksum', 409, 'CHECKSUM_MISMATCH')), false)
    assert.equal(isRetryable({ name: 'AbortError' }), false)
    assert.equal(isRetryable(null), false)
  })

  it('gives up after the attempt budget instead of looping', async () => {
    const size = 9 * MiB
    const { client, puts } = sessionServer({ size, chunkSize: 4 * MiB, failFirstN: 99 })
    const task = createUploadTask({
      file: fileOf('doomed.bin', size), api: client, retryBackoff: [0], maxAttempts: 3, chunkParallel: 1,
    })

    await assert.rejects(() => task.start())

    assert.equal(task.state, 'error')
    assert.equal(task.attempts, 3)
    assert.equal(puts.length, 3)
    assert.equal(RETRY_BACKOFF.length, MAX_ATTEMPTS - 1)
  })
})

describe('progress is monotonic', () => {
  it('does not walk backwards when a chunk restarts', async () => {
    const size = 12 * MiB
    const { client } = sessionServer({ size, chunkSize: 4 * MiB, failFirstN: 1 })
    const task = createUploadTask({ file: fileOf('mono.bin', size), api: client, retryBackoff: [0] })
    const seen = []
    task.on('progress', (event) => seen.push(event.progress))

    await task.start()

    for (let index = 1; index < seen.length; index += 1) {
      assert.ok(seen[index] >= seen[index - 1], 'progress went backwards at ' + index + ': ' + seen.join(','))
    }
    assert.equal(task.progress, 1)
  })
})

describe('simple uploads stay simple', () => {
  it('does not open a session below the chunking threshold', async () => {
    const client = {
      calls: [],
      request: async (path) => { throw apiError('missing', 404, 'NOT_FOUND') },
      putRaw: async (path, blob) => { client.calls.push(path); return { node: { id: 'node-simple', size: blob.size } } },
    }
    const task = createUploadTask({ file: fileOf('small.bin', SIMPLE_LIMIT), api: client })

    await task.start()

    assert.equal(task.state, 'done')
    assert.deepEqual(client.calls, ['/uploads?name=small.bin'])
  })
})
