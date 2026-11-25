import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach } from 'node:test'
import { clearToken, fetchBlob, saveDownloadStream, setToken } from '../lib/api.js'

/**
 * saveDownloadStream(): the anonymous share page's direct-to-disk path.
 *
 * The contract the page relies on:
 *   - bytes go response stream → FileSystemFileHandle writable, never a Blob;
 *   - progress is real received bytes with a trustworthy Content-Length only;
 *   - a trusted length is verified BEFORE the writable closes, so a dropped
 *     socket aborts the file instead of committing a truncated one;
 *   - `auth: false` never sends the drive bearer;
 *   - abort keeps its AbortError, and a disk error stays readable;
 *   - fetchBlob's `maxBytes` refuses an oversized body even when the length is
 *     missing (chunked) and leaves the old no-limit call unchanged.
 */

const encoder = new TextEncoder()

function bodyStream(chunks, gate) {
  let index = 0
  return new ReadableStream({
    async pull(controller) {
      if (index >= chunks.length) { controller.close(); return }
      if (gate) await gate(index)
      controller.enqueue(chunks[index])
      index += 1
    },
  })
}

const chunked = (pieces, options = {}) => {
  const chunks = pieces.map((size) => encoder.encode('x'.repeat(size)))
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const headers = { 'content-type': 'application/octet-stream', ...(options.headers || {}) }
  if (options.length !== false) headers['content-length'] = String(options.length === undefined ? total : options.length)
  return new Response(bodyStream(chunks, options.gate), { status: 200, headers })
}

/**
 * A stand-in FileSystemFileHandle: the writable keeps chunks in memory (as the
 * real one writes them) and records whether it was closed or aborted, which is
 * exactly the "partial file committed?" question.
 */
function fakeHandle(options = {}) {
  const record = { written: 0, closed: false, aborted: false, chunks: [] }
  const handle = {
    kind: 'file',
    async createWritable() {
      if (options.createFails) throw options.createFails
      const writable = new WritableStream({
        write(chunk) {
          const size = chunk && typeof chunk.byteLength === 'number' ? chunk.byteLength : 0
          if (options.writeFails) throw options.writeFails
          record.written += size
          record.chunks.push(size)
        },
        close() { record.closed = true },
        abort() { record.aborted = true },
      })
      return writable
    },
  }
  return { handle, record }
}

let originalFetch
beforeEach(() => { originalFetch = globalThis.fetch })
afterEach(() => {
  globalThis.fetch = originalFetch
  clearToken()
})

describe('saveDownloadStream', () => {
  it('pipes the response into the file handle and reports true progress', async () => {
    const reports = []
    globalThis.fetch = async () => chunked([1000, 1000, 1000], {
      gate: (index) => new Promise((resolve) => setTimeout(resolve, index === 0 ? 4 : 1)),
    })
    const { handle, record } = fakeHandle()
    const result = await saveDownloadStream('/shared/tok/content', handle, {
      auth: false,
      onProgress: (loaded, total) => reports.push({ loaded, total }),
    })

    assert.deepEqual(result, { size: 3000 })
    assert.equal(record.written, 3000)
    assert.equal(record.closed, true)
    assert.equal(record.aborted, false)
    assert.equal(reports[0].loaded, 0)
    assert.ok(reports.every((entry) => entry.total === 3000), JSON.stringify(reports))
    assert.ok(reports.some((entry) => entry.loaded > 0 && entry.loaded < 3000), 'a real middle value')
    assert.equal(reports[reports.length - 1].loaded, 3000)
  })

  it('leaves the total unknown for a chunked or compressed body', async () => {
    const reports = []
    globalThis.fetch = async () => chunked([400, 400], { length: false })
    const { handle } = fakeHandle()
    await saveDownloadStream('/shared/tok/content', handle, { auth: false, onProgress: (loaded, total) => reports.push({ loaded, total }) })
    assert.ok(reports.every((entry) => entry.total === null), JSON.stringify(reports))
    assert.equal(reports[reports.length - 1].loaded, 800)
  })

  it('aborts on a body shorter than the trusted length instead of committing it', async () => {
    globalThis.fetch = async () => chunked([300, 300], { length: 5000 })
    const { handle, record } = fakeHandle()
    await assert.rejects(
      saveDownloadStream('/shared/tok/content', handle, { auth: false }),
      { code: 'NETWORK_ERROR' },
    )
    assert.equal(record.written, 600, 'the bytes that did arrive were written')
    assert.equal(record.closed, false, 'a partial file must not be closed/committed')
    assert.equal(record.aborted, true, 'the writable is aborted so the temporary file is discarded')
  })

  it('never sends the bearer for a public request, and sends it for a drive one', async () => {
    const seen = []
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), auth: init.headers.get('Authorization') })
      return chunked([4])
    }
    setToken('drive-session')
    await saveDownloadStream('/shared/tok/content?password=open+sesame', fakeHandle().handle, { auth: false })
    await saveDownloadStream('/files/n1/content?download=1', fakeHandle().handle, {})
    assert.equal(seen[0].url, '/api/v1/shared/tok/content?password=open+sesame')
    assert.equal(seen[0].auth, null, 'a public download must not leak the drive session')
    assert.equal(seen[1].auth, 'Bearer drive-session')
  })

  it('keeps an abort as an AbortError and leaves no committed file', async () => {
    const controller = new AbortController()
    let cancelled = false
    const aborted = new Promise((resolve) => {
      controller.signal.addEventListener('abort', () => { cancelled = true; resolve() })
    })
    globalThis.fetch = async () => new Response(
      bodyStream([encoder.encode('x'.repeat(500)), encoder.encode('x'.repeat(500))], async (index) => {
        if (index === 0) return
        await aborted
        throw new DOMException('The operation was aborted.', 'AbortError')
      }),
      { status: 200, headers: { 'content-length': '1000' } },
    )
    const { handle, record } = fakeHandle()
    const pending = saveDownloadStream('/shared/tok/content', handle, {
      auth: false,
      signal: controller.signal,
      onProgress: (loaded) => { if (loaded > 0) controller.abort() },
    })
    await assert.rejects(pending, (error) => error.name === 'AbortError')
    assert.ok(cancelled)
    assert.equal(record.closed, false)
  })

  it('surfaces a network failure from a non-ok response with its contract code', async () => {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ error: { code: 'SHARE_LOCKED', message: '需要访问密码。' } }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    )
    const { handle, record } = fakeHandle()
    await assert.rejects(
      saveDownloadStream('/shared/tok/content', handle, { auth: false }),
      { status: 401, code: 'SHARE_LOCKED', message: '需要访问密码。' },
    )
    assert.equal(record.written, 0)
  })

  it('reports a disk write failure readably and never commits the file', async () => {
    globalThis.fetch = async () => chunked([10, 10])
    const { handle, record } = fakeHandle({ writeFails: Object.assign(new Error('磁盘已满。'), { name: 'QuotaExceededError' }) })
    await assert.rejects(
      saveDownloadStream('/shared/tok/content', handle, { auth: false }),
      (error) => error.code === 'SAVE_FAILED' && /磁盘已满/.test(error.message),
    )
    // An errored writable is never closed, so the temporary file is discarded
    // rather than left on disk looking complete.
    assert.equal(record.closed, false)
  })

  it('refuses a handle that cannot create a writable', async () => {
    await assert.rejects(saveDownloadStream('/shared/tok/content', null, { auth: false }), { code: 'UNSUPPORTED' })
  })
})

describe('fetchBlob maxBytes', () => {
  it('refuses a declared length over the limit before buffering', async () => {
    let delivered = 0
    let cancelled = false
    globalThis.fetch = async () => {
      const stream = new ReadableStream({
        start(controller) { controller.enqueue(encoder.encode('x'.repeat(10))); delivered += 10 },
        pull(controller) { delivered += 10; controller.enqueue(encoder.encode('x'.repeat(10))) },
        cancel() { cancelled = true },
      })
      return new Response(stream, { status: 200, headers: { 'content-length': '1000' } })
    }
    const reports = []
    await assert.rejects(
      fetchBlob('/shared/tok/content', { auth: false, maxBytes: 100, onProgress: (loaded) => reports.push(loaded) }),
      (error) => error.code === 'DOWNLOAD_TOO_LARGE',
    )
    assert.equal(cancelled, true, 'the body is released, not drained')
    assert.ok(delivered < 100, 'the oversized body is not read: ' + delivered)
    assert.deepEqual(reports, [0], 'no progress is painted for a body refused up front')
  })

  it('stops a chunked body that crosses the limit, with no length to check first', async () => {
    let delivered = 0
    globalThis.fetch = async () => new Response(
      new ReadableStream({
        pull(controller) {
          delivered += 100
          controller.enqueue(encoder.encode('x'.repeat(100)))
        },
      }),
      { status: 200, headers: { 'content-type': 'application/octet-stream' } },
    )
    const reports = []
    await assert.rejects(
      fetchBlob('/shared/tok/content', { auth: false, maxBytes: 250, onProgress: (loaded) => reports.push(loaded) }),
      (error) => error.code === 'DOWNLOAD_TOO_LARGE' && /另存为/.test(error.message),
    )
    assert.ok(delivered >= 300, 'the body really crossed the limit: ' + delivered)
    assert.ok(reports.every((loaded) => loaded <= 250), 'no progress is reported past the limit: ' + JSON.stringify(reports))
  })

  it('still buffers a body under the limit and reports normal progress', async () => {
    globalThis.fetch = async () => chunked([100, 100])
    const reports = []
    const blob = await fetchBlob('/shared/tok/content', {
      auth: false,
      maxBytes: 500,
      onProgress: (loaded, total) => reports.push({ loaded, total }),
    })
    assert.equal(blob.size, 200)
    assert.equal(reports[reports.length - 1].loaded, 200)
    assert.ok(reports.every((entry) => entry.total === 200))
  })

  it('keeps the old no-limit call byte-for-byte', async () => {
    globalThis.fetch = async () => chunked([10, 20])
    const blob = await fetchBlob('/files/n/content')
    assert.ok(blob instanceof Blob)
    assert.equal(blob.size, 30)
  })
})
