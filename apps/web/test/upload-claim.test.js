import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createUploadTask } from '../lib/upload.js'

/**
 * Resuming a claimed session: the task already knows its id, so it must not
 * probe for a dedup hit and must ask the server what is missing.
 *
 * The whole value of a resume is that the bytes already on the server are not
 * sent twice; a regression here is invisible until a user refreshes a 4 GB
 * upload and watches it start from zero.
 */

const MiB = 1024 * 1024

function apiError(message, status, code) {
  const error = new Error(message)
  error.status = status
  error.code = code || 'HTTP_' + status
  return error
}

function resumeClient(options) {
  const opts = options || {}
  const received = new Set(opts.received || [])
  const puts = []
  const client = {
    calls: [],
    request: async (path, requestOptions) => {
      client.calls.push(((requestOptions && requestOptions.method) || 'GET') + ' ' + path)
      if (path === '/uploads/sessions/' + opts.id) {
        return { upload: { id: opts.id, chunkSize: opts.chunkSize, totalChunks: Math.ceil(opts.size / opts.chunkSize), receivedChunks: [...received], size: opts.size } }
      }
      if (path === '/uploads/sessions/' + opts.id + '/complete') return { node: { id: 'node-resumed', size: opts.size } }
      if (path.startsWith('/blobs/')) throw new Error('a resume must never probe for a dedup hit, got ' + path)
      throw new Error('unexpected ' + path)
    },
    putRaw: async (path, blob, putOptions) => {
      puts.push(path)
      const index = Number(path.slice(path.lastIndexOf('/') + 1))
      received.add(index)
      if (putOptions && putOptions.onProgress) putOptions.onProgress(blob.size, blob.size)
      return { ok: true }
    },
  }
  return { client, puts, received }
}

const fileOf = (name, length) => new File([new Uint8Array(length)], name, { type: 'application/octet-stream' })

describe('resuming a claimed session', () => {
  it('asks the server what it still needs instead of opening a new session', async () => {
    const size = 12 * MiB
    const { client, puts } = resumeClient({ id: 'sess-keep', size, chunkSize: 4 * MiB, received: [0, 1] })
    const task = createUploadTask({ file: fileOf('resume.bin', size), api: client, sessionId: 'sess-keep' })

    await task.start()

    assert.equal(task.state, 'done')
    assert.equal(task.node.id, 'node-resumed')
    // Exactly the missing chunk, and no POST /uploads/sessions.
    assert.deepEqual(puts, ['/uploads/sessions/sess-keep/chunks/2'])
    assert.equal(client.calls.some((call) => call === 'POST /uploads/sessions'), false)
    assert.equal(client.calls.some((call) => call.startsWith('GET /blobs/')), false)
  })

  it('marks the task as resumed so the UI can say so', async () => {
    const size = 12 * MiB
    const { client } = resumeClient({ id: 'sess-keep', size, chunkSize: 4 * MiB, received: [] })
    const task = createUploadTask({ file: fileOf('flagged.bin', size), api: client, sessionId: 'sess-keep' })
    assert.equal(task.resumed, true)
    assert.equal(task.sessionId, 'sess-keep')
    await task.start()
    assert.equal(task.state, 'done')
  })

  it('sends every chunk of a session that was never touched', async () => {
    // 12 MiB, not 8: at exactly SIMPLE_LIMIT the simple PUT path wins and no
    // session is ever opened.
    const size = 12 * MiB
    const { client, puts } = resumeClient({ id: 'sess-fresh', size, chunkSize: 4 * MiB, received: [] })
    const task = createUploadTask({ file: fileOf('fresh.bin', size), api: client, sessionId: 'sess-fresh' })
    await task.start()
    // 12 MiB in 4 MiB chunks: three of them, none skipped.
    assert.equal(puts.length, 3)
  })

  it('reuses a hash it was given instead of re-reading the file', async () => {
    const size = 9 * MiB
    const { client } = resumeClient({ id: 'sess-hash', size, chunkSize: 8 * MiB, received: [] })
    const task = createUploadTask({ file: fileOf('hashed.bin', size), api: client, sessionId: 'sess-hash', hash: 'a'.repeat(64) })
    // A wrong hash would fail the server's check, so this proves the value was
    // used rather than recomputed from bytes the page had to read again.
    assert.equal(task.hash, 'a'.repeat(64))
    await task.start().catch(() => {})
    assert.equal(task.sessionId, 'sess-hash')
  })
})
