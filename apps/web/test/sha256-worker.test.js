import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { sha256Stream } from '../lib/sha256.js'
import { sha256, createUploadTask } from '../lib/upload.js'

/**
 * The background hasher is exercised through a fake `Worker` that runs the real
 * worker module's contract in-process: it consumes postMessage exactly like a
 * structured clone would (a Blob, never bytes), reads it with the same bounded
 * stream, and answers with the same messages. Everything a browser would do
 * asynchronously is still asynchronous here, so the client's job bookkeeping
 * and cancellation paths are genuinely tested.
 */

const MiB = 1024 * 1024
const SHA256 = (...parts) => createHash('sha256').update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest('hex')
const digestOf = (blob) => blob.arrayBuffer().then((buffer) => createHash('sha256').update(Buffer.from(buffer)).digest('hex'))
const bytesOf = (length, seed = 7) => Uint8Array.from({ length }, (_, i) => (i * seed + 11) % 256)
const fileOf = (name, bytes) => new File([bytes], name, { type: 'application/octet-stream' })
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function installFakeWorker(overrides) {
  const opts = overrides || {}
  const created = []
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Worker')
  class FakeWorker {
    constructor(url, options) {
      if (opts.constructorError) throw new Error('blocked by policy')
      this.url = String(url)
      this.options = options
      this.terminated = false
      this.messages = []
      this.onmessage = null
      this.onmessageerror = null
      this.onerror = null
      created.push(this)
    }

    postMessage(message) {
      if (opts.postError) throw new Error('DataCloneError')
      this.messages.push(message)
      if (opts.dropMessages) return
      if (message.type === 'cancel') {
        this.canceled = (this.canceled || new Set()).add(message.id)
        return
      }
      this.respond(message)
    }

    respond(message) {
      const id = message.id
      // A worker that never answers: the client must settle on its own terms.
      if (opts.silent) return
      const total = message.blob.size
      const slice = opts.slice || 4 * MiB
      let loaded = 0
      let slices = 0
      const step = async () => {
        if (opts.dieAfter !== undefined && loaded >= opts.dieAfter) {
          if (this.onerror) this.onerror({ message: 'worker stopped' })
          return
        }
        // A deterministic "still busy" state: after `holdAfter` slices the worker
        // parks until the test releases it. A timing race (hash tick vs. test
        // tick) would otherwise decide the outcome on a fast machine.
        if (opts.holdAfter !== undefined && slices >= opts.holdAfter && opts.hold) {
          await opts.hold
        }
        if (this.canceled && this.canceled.has(id)) return
        if (this.terminated) return
        loaded = Math.min(total, loaded + slice)
        slices += 1
        if (this.onmessage) this.onmessage({ data: { type: 'progress', id, loaded } })
        if (loaded < total) { setTimeout(step, 0); return }
        digestOf(message.blob).then((hash) => {
          if (this.terminated || (this.canceled && this.canceled.has(id))) return
          if (opts.messageError) { if (this.onmessageerror) this.onmessageerror({}); return }
          if (this.onmessage) this.onmessage({ data: { type: 'done', id, hash } })
        })
      }
      setTimeout(step, 0)
    }

    terminate() { this.terminated = true }
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker })
  return {
    created,
    /** Loads a fresh client module: the shared worker lives in module state. */
    async client() {
      return import('../lib/sha256.js?worker=' + Math.random().toString(36).slice(2))
    },
    restore() {
      if (original) Object.defineProperty(globalThis, 'Worker', original)
      else delete globalThis.Worker
    },
    installed: FakeWorker,
  }
}

function abortError() {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

describe('streaming SHA-256 for HTTP folder uploads', () => {
  it('matches the native implementation across padding and multi-chunk boundaries', async () => {
    for (const size of [0, 3, 55, 56, 63, 64, 65, 127, 128, 4 * 1024 * 1024 + 79]) {
      const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 31) % 256);
      assert.equal(await sha256Stream(new Blob([bytes])), createHash('sha256').update(bytes).digest('hex'), 'size ' + size);
    }
  });
  it('hashes ArrayBuffers including non-ASCII input', async () => {
    const bytes = new TextEncoder().encode('文件夹增量更新');
    assert.equal(await sha256Stream(bytes.buffer), createHash('sha256').update(bytes).digest('hex'));
  });
  it('reports progress monotonically up to the real byte count', async () => {
    const bytes = bytesOf(4 * MiB + 4321)
    const seen = []
    const hash = await sha256Stream(new Blob([bytes]), { onProgress: (loaded) => seen.push(loaded) })
    assert.equal(hash, SHA256(bytes))
    assert.ok(seen.length >= 2)
    assert.deepEqual(seen, seen.slice().sort((a, b) => a - b))
    assert.equal(seen[seen.length - 1], bytes.length)
  })
  it('still hashes local files when crypto.subtle is unavailable on an HTTP origin', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
    try {
      const file = new File(['HTTP folder bytes'], 'notes.txt');
      assert.equal(await sha256(file), createHash('sha256').update('HTTP folder bytes').digest('hex'));
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
      else delete globalThis.crypto;
    }
  });
})

describe('background SHA-256 worker', () => {
  it('hashes a large Blob in one shared worker and matches the native digest', async () => {
    const fake = installFakeWorker()
    try {
      const client = await fake.client()
      const blob = new Blob([bytesOf(70 * MiB)])
      const seen = []
      const hash = await client.sha256Background(blob, { onProgress: (loaded) => seen.push(loaded) })
      assert.equal(hash, await digestOf(blob))
      assert.equal(fake.created.length, 1)
      assert.equal(fake.created[0].url.endsWith('/lib/sha256-worker.js'), true)
      assert.deepEqual(fake.created[0].options, { type: 'module' })
      // Structured clone: the worker received the Blob, not an ArrayBuffer copy.
      assert.equal(fake.created[0].messages[0].blob, blob)
      assert.equal(fake.created[0].messages[0].type, 'hash')
      assert.ok(seen.length > 1)
      assert.equal(seen[seen.length - 1], blob.size)
      assert.deepEqual(seen, seen.slice().sort((a, b) => a - b))
    } finally {
      fake.restore()
    }
  })

  it('reuses the one worker across files and settles by request id', async () => {
    const fake = installFakeWorker()
    try {
      const client = await fake.client()
      const first = new Blob([bytesOf(MiB, 3)])
      const second = new Blob([bytesOf(MiB, 5)])
      const [a, b] = await Promise.all([
        client.sha256Background(first),
        client.sha256Background(second),
      ])
      assert.equal(a, await digestOf(first))
      assert.equal(b, await digestOf(second))
      assert.equal(fake.created.length, 1)
      const ids = fake.created[0].messages.map((message) => message.id)
      assert.equal(new Set(ids).size, ids.length, 'ids are never reused')
    } finally {
      fake.restore()
    }
  })

  it('rejects an aborted hash immediately and tells the worker to stop', async () => {
    // The worker parks after its first slice until this resolves, so the abort
    // always lands mid-hash. Waiting a fixed 5 ms instead made the case pass on a
    // slow machine and fail on a fast one, where 4 MiB hashed inside the wait.
    let release
    const hold = new Promise((resolve) => { release = resolve })
    const fake = installFakeWorker({ slice: MiB, holdAfter: 1, hold })
    try {
      const client = await fake.client()
      const controller = new AbortController()
      const started = client.sha256Background(new Blob([bytesOf(4 * MiB)]), { signal: controller.signal })
      await wait(5)
      controller.abort()
      await assert.rejects(started, (error) => error.name === 'AbortError')
      release()
      const worker = fake.created[0]
      await wait(20)
      assert.equal(worker.messages.filter((message) => message.type === 'cancel').length, 1)
      assert.equal(worker.terminated, false, 'the shared worker survives one canceled file')
    } finally {
      release()
      fake.restore()
    }
  })

  it('never delivers a canceled hash to another request', async () => {
    const fake = installFakeWorker({ slice: 64 * 1024 })
    try {
      const client = await fake.client()
      const abortedBlob = new Blob([bytesOf(3 * MiB, 2)])
      const survivorBlob = new Blob([bytesOf(MiB, 9)])
      const controller = new AbortController()
      const aborted = client.sha256Background(abortedBlob, { signal: controller.signal })
      const survivor = client.sha256Background(survivorBlob)
      await wait(3)
      controller.abort()
      await assert.rejects(aborted, (error) => error.name === 'AbortError')
      assert.equal(await survivor, await digestOf(survivorBlob))
    } finally {
      fake.restore()
    }
  })

  it('falls back to the bounded main-thread stream when a worker cannot start', async () => {
    const fake = installFakeWorker({ constructorError: true })
    try {
      const client = await fake.client()
      const blob = new Blob([bytesOf(1024, 4)])
      const seen = []
      assert.equal(await client.sha256Background(blob, { onProgress: (n) => seen.push(n) }), await digestOf(blob))
      assert.deepEqual(seen, [1024])
      assert.equal(fake.created.length, 0)
    } finally {
      fake.restore()
    }
  })

  it('falls back exactly once when the worker script never answers', async () => {
    const fake = installFakeWorker({ silent: true })
    try {
      const client = await fake.client()
      const blob = new Blob([bytesOf(2048, 5)])
      assert.equal(await client.sha256Background(blob, { startTimeout: 20 }), await digestOf(blob))
      // The dead worker is not resurrected for a second attempt: a blocked
      // worker-src would otherwise be retried on every file, forever.
      assert.equal(await client.sha256Background(blob), await digestOf(blob))
      assert.equal(fake.created.length, 1)
    } finally {
      fake.restore()
    }
  })

  it('settles a request on messageerror instead of hanging', async () => {
    const fake = installFakeWorker({ messageError: true })
    try {
      const client = await fake.client()
      await assert.rejects(
        client.sha256Background(new Blob([bytesOf(1024, 6)]), { onProgress: () => {} }),
        (error) => error.name === 'WorkerError',
      )
    } finally {
      fake.restore()
    }
  })

  it('settles a request when postMessage itself throws', async () => {
    const fake = installFakeWorker({ postError: true })
    try {
      const client = await fake.client()
      // Zero progress was ever reported, so this degrades to the main thread.
      assert.equal(await client.sha256Background(new Blob([bytesOf(512, 8)])), await digestOf(new Blob([bytesOf(512, 8)])))
    } finally {
      fake.restore()
    }
  })

  it('does not re-read a file whose worker died after reporting progress', async () => {
    const fake = installFakeWorker({ slice: 1024, dieAfter: 2048 })
    try {
      const client = await fake.client()
      await assert.rejects(
        client.sha256Background(new Blob([bytesOf(4096, 9)]), { onProgress: () => {} }),
        (error) => error.name === 'WorkerError',
      )
    } finally {
      fake.restore()
    }
  })
})

describe('upload task hash progress', () => {
  const BIG = 65 * MiB

  function stubApi(overrides) {
    const calls = []
    const opts = overrides || {}
    return {
      calls,
      request: async (path) => {
        calls.push(path)
        if (path.startsWith('/blobs/')) return { exists: false }
        if (path === '/uploads/sessions') return { upload: { id: 'sess', chunkSize: 8 * MiB, receivedChunks: [] } }
        if (path.endsWith('/complete')) return { node: { id: 'node' } }
        throw new Error('unexpected ' + path)
      },
      putRaw: async (path, blob, options) => {
        if (opts.onPut) opts.onPut(path, blob, options)
        return { node: { id: 'node', size: blob.size } }
      },
    }
  }

  it('starts with no hashed bytes and reports them without touching upload fields', async () => {
    const file = fileOf('big.bin', bytesOf(BIG))
    const api = stubApi()
    const task = createUploadTask({ file, api })
    assert.equal(task.hashBytes, null)
    const events = []
    const hashEvents = []
    /** Transfer fields read off the task at the moment hashing reported. */
    const atReport = []
    task.on('progress', (event) => events.push(event))
    task.on('hash-progress', (event) => {
      hashEvents.push(event)
      atReport.push({ loaded: task.uploaded, progress: task.progress })
    })
    await task.start()
    assert.equal(task.hashBytes, BIG)
    assert.equal(task.hash, await digestOf(file))
    assert.ok(hashEvents.length >= 2)
    for (const event of hashEvents) {
      assert.equal(event.phase, 'hashing')
      assert.equal(event.task, task)
      assert.equal(event.hashTotal, BIG)
      assert.ok(event.hashBytes > 0 && event.hashBytes <= BIG)
    }
    // The network channel stays a network channel: hashing reports only on its
    // own event, so a consumer of `progress` never sees a 0-byte tick mid-read.
    assert.equal(events.filter((event) => event.phase === 'hashing').length, 0)
    // Hashing never moves the transfer numbers: the task still reads zero at
    // every hashing report, even though the upload finished afterwards.
    assert.deepEqual(atReport, atReport.map(() => ({ loaded: 0, progress: 0 })))
    // Upload bytes only start moving after the hash finished.
    assert.ok(events.length > 0)
    assert.equal(events[events.length - 1].loaded, BIG)
    const values = hashEvents.map((event) => event.hashBytes)
    assert.deepEqual(values, values.slice().sort((a, b) => a - b))
  })

  it('does not read the file again on retry or when a hash is injected', async () => {
    const file = fileOf('prehashed.bin', bytesOf(BIG))
    let reads = 0
    const original = Blob.prototype.arrayBuffer
    Blob.prototype.arrayBuffer = function patched() { reads += 1; return original.call(this) }
    try {
      const api = stubApi()
      const task = createUploadTask({ file, api, hash: 'abc123' })
      await task.start()
      assert.equal(reads, 0, 'a prehashed folder file is never re-read')
      assert.equal(task.hash, 'abc123')
      assert.equal(task.hashBytes, null, 'no hashing happened, so no hash bytes')
    } finally {
      Blob.prototype.arrayBuffer = original
    }
  })

  it('hashes once across a retry and keeps the byte count it really reached', async () => {
    const file = fileOf('retry.bin', bytesOf(BIG))
    let puts = 0
    let failed = false
    const api = stubApi({
      onPut: () => {
        puts += 1
        if (!failed) {
          failed = true
          const error = new Error('network down')
          error.status = 0
          error.code = 'NETWORK_ERROR'
          throw error
        }
      },
    })
    const task = createUploadTask({ file, api, retryBackoff: [1] })
    let hashPasses = 0
    let inPass = false
    task.on('hash-progress', (event) => {
      if (event.phase !== 'hashing') { inPass = false; return }
      if (!inPass) { inPass = true; hashPasses += 1 }
    })
    await task.start()
    assert.equal(task.state, 'done')
    assert.equal(task.hash, await digestOf(file))
    assert.equal(task.hashBytes, BIG)
    assert.equal(hashPasses, 1, 'the cached hash means the retry reads nothing')
    assert.ok(puts > 1)
  })

  it('resets hashBytes when a task really has to hash again', async () => {
    const file = fileOf('rehash.bin', bytesOf(BIG))
    const api = stubApi()
    const task = createUploadTask({ file, api })
    await task.start()
    assert.equal(task.hashBytes, BIG)
    // A hash that could not be cached (an interrupted read) is retried from
    // zero: the number on screen must never open at the previous pass's total.
    task.hash = ''
    task.state = 'error'
    const passes = []
    task.on('hash-progress', (event) => { if (event.phase === 'hashing') passes.push(event.hashBytes) })
    await task.retry()
    assert.equal(task.state, 'done')
    assert.equal(task.hashBytes, BIG)
    assert.ok(passes[0] < BIG, 'the second pass starts low again')
    assert.deepEqual(passes, passes.slice().sort((a, b) => a - b))
  })
})
