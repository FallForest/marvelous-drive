import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'node:test'
import { installFakeDom } from './fake-dom.js'
import { createDownloadCenter, downloadStatus } from '../lib/downloads.js'

/**
 * The download center's state machine, driven through the real module.
 *
 * The browser check proves the panel renders and the bytes arrive; these cases
 * pin the decisions a screenshot cannot: what each state says, that a packaging
 * task reports an unknown total, that a failure is readable and retryable, that
 * cancel really aborts the transport, and — the one the ZIP flow depends on —
 * that a failed or canceled archive keeps its carrier.
 */

installFakeDom()

// Each case gets a clean body: the panel is appended to document.body and would
// otherwise still be found (and still be open) by the next case.
beforeEach(() => {
  installFakeDom()
})

const encoder = new TextEncoder()

/** A transport stand-in that reports progress the way fetchBlob does. */
function fakeTransport({ chunks = [100, 100], total = 200, fail = null, gate = null } = {}) {
  const calls = []
  const transport = async (url, options = {}) => {
    calls.push({ url, options })
    for (let index = 0; index < chunks.length; index += 1) {
      if (gate) await gate(index, options.signal)
      if (options.signal && options.signal.aborted) {
        const error = new Error('已取消下载。')
        error.name = 'AbortError'
        throw error
      }
      const loaded = chunks.slice(0, index + 1).reduce((sum, size) => sum + size, 0)
      if (options.onProgress) options.onProgress(loaded, total)
    }
    if (fail) throw fail
    return new Blob([encoder.encode('x'.repeat(chunks.reduce((sum, size) => sum + size, 0)))])
  }
  return { transport, calls }
}

const saved = () => {
  const entries = []
  const saveBlob = async (blob, filename) => { entries.push({ size: blob.size, filename }) }
  return { entries, saveBlob }
}

const clock = () => {
  let now = 1_000
  return { now: () => now, advance: (ms) => { now += ms } }
}

describe('downloadStatus', () => {
  it('shows packaging as an explicit unknown-total phase', () => {
    const status = downloadStatus({ state: 'packaging' })
    assert.equal(status.label, '正在打包')
    assert.equal(status.percent, null)
    assert.match(status.detail, /总量未知/)
  })

  it('shows percent and bytes only with a trusted total', () => {
    const known = downloadStatus({ state: 'transferring', received: 512, total: 2048 })
    assert.equal(known.percent, 0.25)
    assert.match(known.detail, /25%/)
    assert.match(known.detail, /\/ 2\.0 KB/)

    const unknown = downloadStatus({ state: 'transferring', received: 512, total: null })
    assert.equal(unknown.percent, null)
    assert.match(unknown.detail, /已收 512 B/)
    assert.ok(!/%/.test(unknown.detail), 'an unknown total must not invent a percentage')
  })

  it('names the failure reason and offers a retry', () => {
    const failed = downloadStatus({ state: 'failed', message: '读取失败。' })
    assert.equal(failed.label, '下载失败')
    assert.equal(failed.detail, '读取失败。')
    const canceled = downloadStatus({ state: 'canceled', received: 0 })
    assert.equal(canceled.label, '已取消')
    assert.match(canceled.detail, /可以重试/)
  })

  it('reports the hand-over to the browser as the last state', () => {
    const done = downloadStatus({ state: 'done', received: 4096, total: 4096 })
    assert.equal(done.label, '已交给浏览器保存')
    assert.equal(done.percent, 1)
  })
})

describe('download center', () => {
  it('takes one file from 0 to a save and keeps the entry reachable', async () => {
    const time = clock()
    const { transport } = fakeTransport({ chunks: [50, 50, 50, 50], total: 200 })
    const { entries, saveBlob } = saved()
    const center = createDownloadCenter({
      fetchBlob: transport, saveBlob, contentUrl: (id) => '/api/v1/files/' + id + '/content?download=1',
      now: time.now,
    })
    const entry = center.entry()
    const seen = []
    const handle = center.start({ node: { id: 'n1', name: 'note.txt' }, name: 'note.txt', kind: 'file' })
    // The task is observable while it runs, which is what the panel paints.
    seen.push(center.tasks[0].state)
    const result = await handle.done
    seen.push(center.tasks[0].state)

    assert.equal(result.state, 'done')
    // Whichever of the first two states the transport reached before the test
    // could look (a fake may report synchronously), the point is that "done"
    // is only reached through the transfer, never directly from the start.
    assert.ok(seen[0] === 'starting' || seen[0] === 'transferring', JSON.stringify(seen))
    assert.deepEqual(entries, [{ size: 200, filename: 'note.txt' }])
    // The entry is the one global control: it exists before and after a task and
    // carries the count, so a download is never unreachable from another route.
    assert.equal(entry.getAttribute('aria-label') === null, false)
    assert.equal(center.tasks.length, 1)
    assert.equal(center.tasks[0].received, 200)
    assert.equal(center.tasks[0].total, 200)
  })

  it('keeps packaging separate from the transfer and reuses the carrier on retry', async () => {
    const time = clock()
    let packages = 0
    let attempts = 0
    const center = createDownloadCenter({
      now: time.now,
      saveBlob: async () => {},
      contentUrl: (id) => '/files/' + id + '/content?download=1',
      fetchBlob: async (url, options) => {
        attempts += 1
        options.onProgress(100, 100)
        if (attempts === 1) {
          const error = new Error('读取失败。')
          error.code = 'HTTP_500'
          throw error
        }
        return new Blob(['ok'])
      },
    })
    center.entry()
    const handle = center.start({
      name: 'Bundle.zip',
      kind: 'archive',
      prepare: async () => {
        packages += 1
        return { id: 'zip-1', name: 'Bundle.zip', kind: 'file' }
      },
    })
    const first = await handle.done
    assert.equal(first.state, 'failed')
    assert.equal(first.message, '读取失败。')
    assert.equal(packages, 1)
    assert.equal(first.carrier.id, 'zip-1')
    // Packaging is over: the failure is a transfer failure, and the task keeps
    // its carrier so 重试 does not zip the folder again.
    assert.equal(center.tasks[0].phase, 'transfer')

    await handle.retry().done
    const task = center.tasks[0]
    assert.equal(task.state, 'done')
    assert.equal(packages, 1, 'retry must not repackage a carrier that already exists')
    assert.equal(attempts, 2)
    assert.equal(task.carrier.id, 'zip-1')
  })

  it('aborts the transport on cancel and lets the task be retried', async () => {
    const time = clock()
    let aborted = false
    const center = createDownloadCenter({
      now: time.now,
      saveBlob: async () => {},
      contentUrl: (id) => '/files/' + id + '/content?download=1',
      fetchBlob: (url, options) => new Promise((resolve, reject) => {
        options.onProgress(10, 100)
        options.signal.addEventListener('abort', () => {
          aborted = true
          const error = new Error('已取消下载。')
          error.name = 'AbortError'
          reject(error)
        })
        if (options.signal.aborted) reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        window.__resolveLater = () => resolve(new Blob(['later']))
      }),
    })
    center.entry()
    const handle = center.start({ node: { id: 'n2', name: 'big.bin' }, name: 'big.bin' })
    handle.cancel()
    const result = await handle.done
    assert.equal(result.state, 'canceled')
    assert.equal(aborted, true)
    const row = downloadStatus(center.tasks[0])
    assert.equal(row.label, '已取消')
  })

  it('opens the panel from the entry and closes it again', () => {
    const center = createDownloadCenter({ fetchBlob: async () => new Blob(['x']), saveBlob: async () => {} })
    const entry = center.entry()
    assert.equal(center.openState, false)
    entry.listeners.get('click').values().next().value({})
    assert.equal(center.openState, true)
    assert.equal(Boolean(document.querySelector('.downloads')), true)
    assert.equal(document.querySelector('.downloads').hasAttribute('hidden'), false)
    entry.listeners.get('click').values().next().value({})
    assert.equal(center.openState, false)
    assert.equal(document.querySelector('.downloads').hasAttribute('hidden'), true)
  })

  it('keeps a failed task in the list when finished ones are cleared', async () => {
    const center = createDownloadCenter({
      fetchBlob: async () => { throw Object.assign(new Error('读取失败。'), { code: 'HTTP_500' }) },
      saveBlob: async () => {},
      contentUrl: (id) => '/files/' + id + '/content',
    })
    center.entry()
    await center.start({ node: { id: 'n3', name: 'gone.txt' }, name: 'gone.txt' }).done
    assert.equal(center.tasks.length, 1)
    center.clearFinished()
    assert.equal(center.tasks.length, 1, 'a failure the user has not retried must stay')
    assert.equal(center.tasks[0].state, 'failed')
  })

  it('a retry after a canceled archive reuses the carrier instead of repackaging', async () => {
    let packages = 0
    let transfers = 0
    const center = createDownloadCenter({
      saveBlob: async () => {},
      contentUrl: (id) => '/files/' + id + '/content?download=1',
      fetchBlob: (url, options) => new Promise((resolve, reject) => {
        transfers += 1
        if (transfers === 1) {
          options.onProgress(10, 100)
          options.signal.addEventListener('abort', () => {
            const error = new Error('已取消下载。')
            error.name = 'AbortError'
            reject(error)
          })
          return
        }
        options.onProgress(100, 100)
        resolve(new Blob(['zip']))
      }),
    })
    center.entry()
    const handle = center.start({
      name: 'Bundle.zip',
      kind: 'archive',
      prepare: async () => { packages += 1; return { id: 'zip-9', name: 'Bundle.zip' } },
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    handle.cancel()
    const canceled = await handle.done
    assert.equal(canceled.state, 'canceled')
    assert.equal(canceled.carrier.id, 'zip-9', 'a canceled ZIP still names its carrier so it is not lost')

    await handle.retry().done
    assert.equal(packages, 1, 'the carrier is reused, not rebuilt')
    assert.equal(center.tasks[0].state, 'done')
  })

  it('a packaging cancel keeps the carrier the server already built', async () => {
    const center = createDownloadCenter({
      saveBlob: async () => {},
      contentUrl: (id) => '/files/' + id + '/content',
      // A transfer that never delivers on its own: the cancel has to land while
      // the task is between "archive built" and "bytes saved".
      fetchBlob: (url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('已取消下载。')
          error.name = 'AbortError'
          reject(error)
        })
      }),
    })
    center.entry()
    const handle = center.start({
      name: 'Folder.zip',
      kind: 'archive',
      prepare: async () => ({ id: 'zip-10', name: 'Folder.zip' }),
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    handle.cancel()
    const result = await handle.done
    assert.equal(result.state, 'canceled')
    assert.equal(result.carrier.id, 'zip-10')
  })
})
