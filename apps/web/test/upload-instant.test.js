import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createUploadTask, sha256, INSTANT_LIMIT, SIMPLE_LIMIT } from '../lib/upload.js'
import { createUploader } from '../lib/upload-queue.js'

/**
 * createUploadTask against an injected client: no HTTP, no DOM.
 * The client records every call so a test can assert that a deduplicated upload
 * never sends a single byte.
 */

const MiB = 1024 * 1024
const CHUNK = 8 * MiB

function apiError(message, status, code) {
  const error = new Error(message)
  error.status = status
  error.code = code || 'HTTP_' + status
  return error
}

function abortError() {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

/** A promise that rejects with AbortError as soon as the signal aborts. */
function hang(signal) {
  return new Promise((resolve, reject) => {
    if (!signal) return
    if (signal.aborted) { reject(abortError()); return }
    signal.addEventListener('abort', () => reject(abortError()), { once: true })
  })
}

function fakeClient(handlers) {
  const calls = []
  return {
    calls,
    request: async (path, options) => {
      calls.push({ method: (options && options.method) || 'GET', path, body: options && options.body })
      return handlers.request(path, options, calls)
    },
    putRaw: async (path, blob, options) => {
      calls.push({ method: 'PUT', path, size: blob.size })
      return handlers.putRaw ? handlers.putRaw(path, blob, options, calls) : { node: { id: 'node-put', size: blob.size } }
    },
  }
}

const bytes = (length) => new Uint8Array(length)
const fileOf = (name, length) => new File([bytes(length)], name, { type: 'application/octet-stream' })

describe('instant upload (dedup probe)', () => {
  it('skips every byte when the server already holds the blob', async () => {
    const file = fileOf('big.bin', 2 * MiB)
    const hash = await sha256(file)
    let instantBody = null
    const client = fakeClient({
      request: async (path, options) => {
        if (path === '/blobs/' + hash) return { exists: true, sha256: hash, size: file.size, refs: 1 }
        if (path === '/uploads/instant') { instantBody = options.body; return { node: { id: 'node-instant', size: file.size }, deduplicated: true } }
        throw new Error('unexpected ' + path)
      },
    })

    const task = createUploadTask({ file, parentId: 'folder-1', api: client })
    const doneEvents = []
    task.on('done', (event) => doneEvents.push(event))
    const node = await task.start()

    assert.equal(node.id, 'node-instant')
    assert.equal(task.state, 'done')
    assert.equal(task.deduplicated, true)
    assert.equal(task.progress, 1)
    assert.equal(doneEvents.length, 1)
    // The whole point: zero content PUTs.
    assert.deepEqual(client.calls.map((call) => call.method + ' ' + call.path), [
      'GET /blobs/' + hash,
      'POST /uploads/instant',
    ])
    assert.equal(client.calls.some((call) => call.method === 'PUT'), false)
    assert.equal(instantBody.name, 'big.bin')
    assert.equal(instantBody.parentId, 'folder-1')
    assert.equal(instantBody.sha256, hash)
    assert.equal(instantBody.size, file.size)
  })

  it('falls back to a real PUT when the probe answers 404', async () => {
    const file = fileOf('medium.bin', 2 * MiB)
    const hash = await sha256(file)
    let putHeaders = null
    const client = fakeClient({
      request: async (path) => {
        if (path === '/blobs/' + hash) throw apiError('not found', 404, 'NOT_FOUND')
        throw new Error('unexpected ' + path)
      },
      putRaw: async (path, blob, options) => {
        putHeaders = options.headers
        assert.match(path, /^\/uploads\?/)
        return { node: { id: 'node-real', size: blob.size } }
      },
    })

    const task = createUploadTask({ file, api: client })
    const node = await task.start()

    assert.equal(node.id, 'node-real')
    assert.equal(task.state, 'done')
    assert.equal(task.deduplicated, false)
    assert.equal(putHeaders['X-Checksum-Sha256'], hash)
  })

  it('survives a probe network error without failing the upload', async () => {
    const file = fileOf('flaky.bin', 2 * MiB)
    const client = fakeClient({
      request: async () => { throw apiError('offline', 0, 'NETWORK_ERROR') },
    })

    const task = createUploadTask({ file, api: client })
    await task.start()

    assert.equal(task.state, 'done')
    assert.equal(task.deduplicated, false)
    assert.equal(client.calls.filter((call) => call.method === 'PUT').length, 1)
  })

  it('falls back when POST /uploads/instant answers 404 BLOB_NOT_FOUND', async () => {
    const file = fileOf('gone.bin', 2 * MiB)
    const hash = await sha256(file)
    const client = fakeClient({
      request: async (path) => {
        if (path === '/blobs/' + hash) return { exists: true, sha256: hash, size: file.size, refs: 1 }
        if (path === '/uploads/instant') throw apiError('blob missing', 404, 'BLOB_NOT_FOUND')
        throw new Error('unexpected ' + path)
      },
    })

    const task = createUploadTask({ file, api: client })
    await task.start()

    assert.equal(task.state, 'done')
    assert.equal(task.deduplicated, false)
    assert.equal(client.calls.filter((call) => call.method === 'PUT').length, 1)
  })

  it('never probes small files', async () => {
    const file = fileOf('small.txt', INSTANT_LIMIT) // exactly 1 MiB: not "above" it
    const client = fakeClient({
      request: async (path) => { throw new Error('no probe expected, got ' + path) },
    })

    const task = createUploadTask({ file, api: client })
    await task.start()

    assert.equal(task.state, 'done')
    assert.equal(client.calls.every((call) => !call.path.startsWith('/blobs/')), true)
    assert.ok(file.size <= SIMPLE_LIMIT)
  })

  it('does not turn a rejected instant replacement into a fresh upload', async () => {
    const file = fileOf('stale.bin', 2 * MiB)
    const client = fakeClient({ request: async (path) => {
      if (path.startsWith('/blobs/')) return { exists: true }
      throw apiError('file changed since preflight', 409, 'VERSION_CONFLICT')
    } })
    const task = createUploadTask({ file, api: client, expectedVersion: 3, expectedNodeId: 'original' })
    await assert.rejects(task.start(), (error) => error.code === 'VERSION_CONFLICT')
    const instant = client.calls.find((call) => call.path === '/uploads/instant')
    assert.equal(instant.body.expectedVersion, 3)
    assert.equal(instant.body.expectedNodeId, 'original')
    assert.equal(client.calls.some((call) => call.method === 'PUT'), false)
  })

  it('passes the absence guard through the shared scheduler for a new small file', async () => {
    const client = fakeClient({ request: async () => { throw new Error('no probe needed') } })
    const uploader = createUploader({ api: client })
    await uploader.enqueueAndWait(fileOf('new.txt', 3), 'docs', 'overwrite', { expectedVersion: 0 })
    const put = client.calls.find((call) => call.method === 'PUT')
    assert.equal(new URL('http://local' + put.path).searchParams.get('expectedVersion'), '0')
  })

  it('keeps the selected strategy and snapshot on chunked creation and completion', async () => {
    const file = fileOf('large.bin', 9 * MiB)
    const client = fakeClient({ request: async (path, options) => {
      if (path.startsWith('/blobs/')) throw apiError('not found', 404)
      if (path === '/uploads/sessions') return { upload: { id: 'policy', chunkSize: CHUNK, receivedChunks: [] } }
      if (path.endsWith('/complete')) return { node: { id: 'renamed', name: 'large (1).bin' } }
      throw new Error(path)
    } })
    const uploader = createUploader({ api: client })
    await uploader.enqueueAndWait(file, 'docs', 'rename', { expectedVersion: 2, expectedNodeId: 'original' })
    for (const path of ['/uploads/sessions', '/uploads/sessions/policy/complete']) {
      const call = client.calls.find((call) => call.path === path)
      assert.equal(call.body.onConflict, 'rename')
      assert.equal(call.body.expectedVersion, 2)
      assert.equal(call.body.expectedNodeId, 'original')
    }
  })

  it('restores the server-side conflict strategy when claiming a paused session', async () => {
    const file = fileOf('paused.bin', 9 * MiB)
    const session = { id: 'paused', onConflict: 'skip', expectedVersion: 4, expectedNodeId: 'original', chunkSize: CHUNK, receivedChunks: [0, 1] }
    const client = fakeClient({ request: async (path) => {
      if (path === '/uploads/sessions/paused') return { upload: session }
      if (path.endsWith('/complete')) return { node: { id: 'original' } }
      throw new Error(path)
    } })
    const uploader = createUploader({ api: client })
    uploader.enqueueResume(file, session, 'docs')
    await uploader.whenIdle()
    const completed = client.calls.find((call) => call.path.endsWith('/complete'))
    assert.equal(completed.body.onConflict, 'skip')
    assert.equal(completed.body.expectedVersion, 4)
    assert.equal(completed.body.expectedNodeId, 'original')
    assert.equal(client.calls.some((call) => call.method === 'PUT'), false)
  })
})

describe('resumable session, pause and cancel', () => {
  /** A server stub that remembers received chunks and can stall one chunk. */
  function chunkedClient(options) {
    const opts = options || {}
    const received = new Set()
    const chunksSent = []
    const client = fakeClient({
      request: async (path, requestOptions) => {
        if (path === '/uploads/sessions' && requestOptions.method === 'POST') {
          return { upload: { id: 'sess-1', chunkSize: CHUNK, receivedChunks: [] } }
        }
        if (path === '/uploads/sessions/sess-1') {
          return { upload: { id: 'sess-1', chunkSize: CHUNK, receivedChunks: [...received] } }
        }
        if (path === '/uploads/sessions/sess-1/complete') {
          return { node: { id: 'node-chunked', size: opts.size } }
        }
        if (path.startsWith('/blobs/')) throw apiError('not found', 404)
        if (path.includes('/chunks/')) return null
        if (requestOptions.method === 'DELETE') return { ok: true }
        throw new Error('unexpected ' + path)
      },
      putRaw: async (path, blob, putOptions) => {
        const index = Number(path.slice(path.lastIndexOf('/') + 1))
        if (opts.stallIndex === index && !opts.stalled.has(index)) {
          opts.stalled.add(index)
          return hang(putOptions.signal) // waits until abort
        }
        await new Promise((resolve) => setTimeout(resolve, 1))
        received.add(index)
        chunksSent.push(index)
        if (putOptions && putOptions.onProgress) putOptions.onProgress(blob.size, blob.size)
        return { ok: true }
      },
    })
    return { client, received, chunksSent }
  }

  it('uploads 9 MiB through a session and reports progress', async () => {
    const file = fileOf('big9.bin', 9 * MiB)
    const { client, chunksSent } = chunkedClient({ size: file.size })
    // One chunk lane: this test is about the session protocol, not about how
    // many chunks overlap. The lane count has its own test.
    const task = createUploadTask({ file, api: client, chunkParallel: 1 })
    const ticks = []
    task.on('progress', (event) => ticks.push(event.progress))

    const node = await task.start()

    assert.equal(node.id, 'node-chunked')
    assert.equal(task.state, 'done')
    assert.equal(task.sessionId, 'sess-1')
    assert.deepEqual(chunksSent, [0, 1])
    assert.ok(ticks.length >= 2)
    assert.equal(task.deduplicated, false)
  })

  it('pauses with the session kept, then resumes from the missing chunk', async () => {
    const file = fileOf('pause9.bin', 9 * MiB)
    const stalled = new Set()
    const { client, chunksSent } = chunkedClient({ size: file.size, stallIndex: 1, stalled })
    const task = createUploadTask({ file, api: client, chunkParallel: 1 })

    const first = task.start()
    // Wait until chunk 1 is being uploaded (chunk 0 already accepted).
    while (!stalled.has(1)) await new Promise((resolve) => setTimeout(resolve, 2))
    assert.equal(task.state, 'uploading')
    task.pause()
    await first.catch(() => {})
    assert.equal(task.state, 'paused')
    assert.equal(task.sessionId, 'sess-1')

    const node = await task.resume()
    assert.equal(node.id, 'node-chunked')
    assert.equal(task.state, 'done')
    // Chunk 0 was never re-sent: the session remembered it.
    assert.deepEqual(chunksSent, [0, 1])
  })

  it('cancel still reports canceled and drops the session', async () => {
    const file = fileOf('cancel9.bin', 9 * MiB)
    const stalled = new Set()
    const { client } = chunkedClient({ size: file.size, stallIndex: 1, stalled })
    const task = createUploadTask({ file, api: client, chunkParallel: 1 })

    const running = task.start()
    while (!stalled.has(1)) await new Promise((resolve) => setTimeout(resolve, 2))
    task.cancel()
    await running.catch(() => {})

    assert.equal(task.state, 'canceled')
    assert.equal(client.calls.some((call) => call.method === 'DELETE' && call.path === '/uploads/sessions/sess-1'), true)
  })
})
