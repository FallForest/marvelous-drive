import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach } from 'node:test'
import { clearToken, fetchBlob, setToken } from '../lib/api.js'

/**
 * The download transport contract behind the progress panel.
 *
 * `fetchBlob` used to answer with an opaque blob: the page could show "saving"
 * and nothing else. It now counts the response body through a TransformStream
 * while the browser accumulates the same bytes, so a 2 GiB download reports real
 * received bytes without the client ever holding a chunks array.
 *
 * These cases pin the parts a panel can be wrong about:
 *   - a trustworthy length produces 0 → middle → complete;
 *   - no length, or a compressed body, produces `total: null` (not a guess);
 *   - a short body is an error, not a silently truncated file;
 *   - cancel and the old no-listener call keep their exact meaning.
 */

const encoder = new TextEncoder()

/** A byte stream delivered in `chunks` pieces, optionally gated between them. */
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

let originalFetch
beforeEach(() => { originalFetch = globalThis.fetch })
afterEach(() => { globalThis.fetch = originalFetch })

describe('fetchBlob progress', () => {
  it('reports a middle value and then completion for a trusted length', async () => {
    const reports = []
    globalThis.fetch = async () => chunked([1000, 1000, 1000, 1000], {
      gate: (index) => new Promise((resolve) => setTimeout(resolve, index === 0 ? 5 : 1)),
    })
    const blob = await fetchBlob('/files/one/content?download=1', {
      onProgress: (loaded, total) => reports.push({ loaded, total }),
    })

    assert.equal(blob.size, 4000)
    assert.equal(reports[0].loaded, 0)
    assert.equal(reports[0].total, 4000)
    // At least one report arrived while the body was still moving: that is the
    // case the panel exists for, and a listener that only ever sees 0 and 4000
    // would render a frozen bar for the whole transfer.
    const middle = reports.filter((entry) => entry.loaded > 0 && entry.loaded < 4000)
    assert.ok(middle.length >= 1, 'no intermediate progress: ' + JSON.stringify(reports))
    assert.ok(middle.every((entry) => entry.total === 4000), JSON.stringify(middle))
    assert.equal(reports[reports.length - 1].loaded, 4000)
    for (let index = 1; index < reports.length; index += 1) {
      assert.ok(reports[index].loaded >= reports[index - 1].loaded, 'progress must not go backwards')
    }
  })

  it('leaves the total unknown when Content-Length is missing', async () => {
    const reports = []
    globalThis.fetch = async () => chunked([600, 600], { length: false })
    const blob = await fetchBlob('/files/two/content', { onProgress: (loaded, total) => reports.push({ loaded, total }) })

    assert.equal(blob.size, 1200)
    assert.ok(reports.length >= 2)
    assert.ok(reports.every((entry) => entry.total === null), JSON.stringify(reports))
    assert.equal(reports[reports.length - 1].loaded, 1200)
  })

  it('does not trust a length on a compressed response', async () => {
    // Content-Length then describes the compressed body, while the stream the
    // page reads is decoded — a percentage would pass 100%.
    const reports = []
    globalThis.fetch = async () => chunked([500, 500], { headers: { 'content-encoding': 'gzip' } })
    const blob = await fetchBlob('/files/three/content', { onProgress: (loaded, total) => reports.push({ loaded, total }) })

    assert.equal(blob.size, 1000)
    assert.ok(reports.every((entry) => entry.total === null), JSON.stringify(reports))
  })

  it('accepts an identity encoding as a trustworthy length', async () => {
    const reports = []
    globalThis.fetch = async () => chunked([250, 250], { headers: { 'content-encoding': 'identity' } })
    await fetchBlob('/files/four/content', { onProgress: (loaded, total) => reports.push({ loaded, total }) })
    assert.equal(reports[0].total, 500)
  })

  it('turns a body shorter than its declared length into an error', async () => {
    globalThis.fetch = async () => chunked([400, 400], { length: 2000 })
    await assert.rejects(fetchBlob('/files/five/content', { onProgress: () => {} }), { code: 'NETWORK_ERROR' })
  })

  it('keeps the same bytes and the old return type with no listener', async () => {
    globalThis.fetch = async () => chunked([10, 20, 30])
    const blob = await fetchBlob('/files/six/content')
    assert.ok(blob instanceof Blob)
    assert.equal(blob.size, 60)
  })

  it('rejects an abort as an AbortError and stops counting', async () => {
    const controller = new AbortController()
    const reports = []
    // A real fetch ties the body stream to the signal. This stand-in does the
    // same, so the case exercises fetchBlob() rather than the mock.
    let cancelled = false
    const aborted = new Promise((resolve) => {
      controller.signal.addEventListener('abort', () => { cancelled = true; resolve() })
    })
    globalThis.fetch = async () => new Response(
      bodyStream([encoder.encode('x'.repeat(1000)), encoder.encode('x'.repeat(1000))], async (index) => {
        if (index === 0) return
        await aborted
        throw new DOMException('The operation was aborted.', 'AbortError')
      }),
      { status: 200, headers: { 'content-length': '2000' } },
    )
    const pending = fetchBlob('/files/seven/content', {
      signal: controller.signal,
      onProgress: (loaded, total) => {
        reports.push({ loaded, total })
        if (loaded > 0) controller.abort()
      },
    })
    await assert.rejects(pending, (error) => error.name === 'AbortError')
    assert.ok(cancelled)
    assert.ok(reports.length >= 2, JSON.stringify(reports))
  })

  it('passes the bearer header and never the token in the URL', async () => {
    let seenUrl = ''
    let seenAuth = ''
    globalThis.fetch = async (url, init) => {
      seenUrl = String(url)
      seenAuth = init.headers.get('Authorization') || ''
      return chunked([4])
    }
    setToken('tok-123')
    try {
      await fetchBlob('/files/eight/content?download=1', { onProgress: () => {} })
      assert.ok(!seenUrl.includes('tok-123'))
      assert.equal(seenAuth, 'Bearer tok-123')
    } finally {
      clearToken()
    }
  })
})
