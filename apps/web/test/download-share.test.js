import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'node:test'
import { installFakeDom } from './fake-dom.js'
import { createDownloadCenter, downloadStatus } from '../lib/downloads.js'
import { popupElements } from '../lib/focus.js'

/**
 * The reusable half of the download center: the anonymous share page drives a
 * second center over the same task/panel machinery.
 *
 * These cases pin the parts the share page depends on and the drive must not
 * lose:
 *   - a direct URL spec needs no node, is fetched with `auth: false` (no bearer
 *     for a public link), honours maxBytes and saves under its own filename;
 *   - the existing private node path keeps its exact call shape;
 *   - a caller-supplied `transfer` bypasses fetchBlob/saveBlob, survives cancel
 *     and retry, reports only real progress, and ends in "已保存到磁盘";
 *   - the instance owns its panel id, its Escape listener and its tasks, and
 *     destroy() releases all of them.
 */

installFakeDom()

beforeEach(() => {
  installFakeDom()
})

/** A transport that reports the shape fetchBlob uses. */
function transport({ chunks = [100], total = 100, fail = null } = {}) {
  const calls = []
  const fetchBlob = async (url, options = {}) => {
    calls.push({ url, options })
    for (let index = 0; index < chunks.length; index += 1) {
      if (fail) throw fail
      const loaded = chunks.slice(0, index + 1).reduce((sum, size) => sum + size, 0)
      if (options.onProgress) options.onProgress(loaded, total)
    }
    const size = chunks.reduce((sum, value) => sum + value, 0)
    return new Blob([new Uint8Array(size)])
  }
  return { fetchBlob, calls }
}

const saved = () => {
  const entries = []
  return {
    entries,
    saveBlob: async (blob, filename) => { entries.push({ size: blob.size, filename }) },
  }
}

const hangingTransfer = (probe) => ({ signal, onProgress }) => new Promise((resolve, reject) => {
  if (probe) probe(signal)
  const fail = () => {
    const error = new Error('已取消下载。')
    error.name = 'AbortError'
    reject(error)
  }
  if (signal.aborted) { fail(); return }
  signal.addEventListener('abort', fail, { once: true })
})

describe('a direct URL spec for the public share page', () => {
  it('needs no node, fetches with auth:false and saves under the spec filename', async () => {
    const { fetchBlob, calls } = transport({ chunks: [120, 80], total: 200 })
    const { entries, saveBlob } = saved()
    const center = createDownloadCenter({
      fetchBlob,
      saveBlob,
      // Any contentUrl call would be a node requirement this case denies.
      contentUrl: () => { throw new Error('a URL spec must not ask for a node route') },
    })
    center.entry()
    const handle = center.start({
      name: 'report.pdf',
      kind: 'file',
      url: '/shared/tok/content?password=open+sesame',
      auth: false,
      maxBytes: 5_000_000,
      filename: '季度报告.pdf',
    })
    const result = await handle.done

    assert.equal(result.state, 'done')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, '/shared/tok/content?password=open+sesame')
    assert.equal(calls[0].options.auth, false, 'a public link must not carry the drive bearer')
    assert.equal(calls[0].options.maxBytes, 5_000_000)
    assert.deepEqual(entries, [{ size: 200, filename: '季度报告.pdf' }])
    assert.equal(center.tasks[0].received, 200)
    assert.equal(center.tasks[0].total, 200)
    // A Blob download still ends as a hand-over to the browser.
    assert.equal(downloadStatus(center.tasks[0]).label, '已交给浏览器保存')
  })

  it('falls back to the spec name when no filename is given', async () => {
    const { fetchBlob } = transport({ chunks: [4], total: 4 })
    const { entries, saveBlob } = saved()
    const center = createDownloadCenter({ fetchBlob, saveBlob })
    await center.start({ name: 'open.txt', url: '/shared/t/content', auth: false }).done
    assert.deepEqual(entries, [{ size: 4, filename: 'open.txt' }])
  })

  it('keeps the private node path byte-for-byte: same options, same name', async () => {
    const { fetchBlob, calls } = transport({ chunks: [10], total: 10 })
    const { entries, saveBlob } = saved()
    const center = createDownloadCenter({
      fetchBlob,
      saveBlob,
      contentUrl: (id, options) => '/api/v1/files/' + id + '/content' + (options.download ? '?download=1' : ''),
    })
    center.entry()
    await center.start({ node: { id: 'n1', name: 'note.txt' }, name: 'note.txt', kind: 'file' }).done

    assert.equal(calls[0].url, '/api/v1/files/n1/content?download=1')
    // No auth/maxBytes keys: the drive's old call shape is untouched.
    assert.deepEqual(Object.keys(calls[0].options).sort(), ['onProgress', 'signal'])
    assert.deepEqual(entries, [{ size: 10, filename: 'note.txt' }])
  })

  it('reports a readable failure for an oversized or rejected public file', async () => {
    const tooLarge = Object.assign(new Error('文件超过在线下载上限，请使用浏览器自带的“另存为”直接下载。'), { code: 'DOWNLOAD_TOO_LARGE' })
    const center = createDownloadCenter({
      fetchBlob: async () => { throw tooLarge },
      saveBlob: async () => {},
    })
    center.entry()
    const result = await center.start({ name: 'huge.iso', url: '/shared/t/content', auth: false, maxBytes: 10 }).done
    assert.equal(result.state, 'failed')
    assert.equal(result.error.code, 'DOWNLOAD_TOO_LARGE')
    assert.match(downloadStatus(center.tasks[0]).detail, /另存为/)
  })
})

describe('a caller-supplied transfer', () => {
  it('is invoked synchronously from start() so a disk picker keeps the click', () => {
    const center = createDownloadCenter({ fetchBlob: async () => new Blob(['x']), saveBlob: async () => {} })
    let called = false
    let stateAtCall = ''
    let statusAtCall = null
    center.start({
      name: 'pack.zip',
      kind: 'archive',
      waitingDetail: '正在打包，完成后开始传输…',
      transfer: () => {
        called = true
        stateAtCall = center.tasks[0].state
        statusAtCall = downloadStatus(center.tasks[0])
        return Promise.resolve({ size: 0 })
      },
    })
    // No await happened between start() and the transfer call.
    assert.equal(called, true, 'the picker must be openable before the first await')
    assert.equal(stateAtCall, 'waiting')
    assert.equal(statusAtCall.detail, '正在打包，完成后开始传输…')
    assert.equal(statusAtCall.percent, null, 'nothing has moved yet: no guessed percentage')
  })

  it('bypasses fetchBlob/saveBlob and ends with the saved-to-disk label', async () => {
    let fetchCalls = 0
    let saveCalls = 0
    const seen = []
    const center = createDownloadCenter({
      fetchBlob: async () => { fetchCalls += 1; return new Blob(['x']) },
      saveBlob: async () => { saveCalls += 1 },
    })
    center.entry()
    const handle = center.start({
      name: 'bundle.zip',
      kind: 'archive',
      waitingDetail: '正在打包，完成后开始传输…',
      transfer: async ({ signal, onProgress }) => {
        assert.equal(signal.aborted, false)
        onProgress(300, 1000)
        seen.push(downloadStatus(center.tasks[0]))
        onProgress(1000, 1000)
        return { size: 1000 }
      },
    })
    const result = await handle.done

    assert.equal(result.state, 'done')
    assert.equal(fetchCalls, 0, 'a supplied transfer owns the bytes')
    assert.equal(saveCalls, 0, 'the file is already on disk')
    assert.equal(seen[0].percent, 0.3, 'real bytes and a trusted total still paint a real ratio')
    const task = center.tasks[0]
    assert.equal(task.state, 'done')
    assert.equal(task.savedToDisk, true)
    assert.equal(task.received, 1000)
    assert.equal(task.total, 1000)
    assert.equal(downloadStatus(task).label, '已保存到磁盘')
  })

  it('never invents a percentage when the transfer reports no total', async () => {
    const center = createDownloadCenter({ fetchBlob: async () => new Blob(['x']), saveBlob: async () => {} })
    center.entry()
    let midFlight = null
    const handle = center.start({
      name: 'pack.zip',
      transfer: async ({ onProgress }) => {
        onProgress(512, null)
        midFlight = downloadStatus(center.tasks[0])
        return { size: 512 }
      },
    })
    await handle.done
    assert.equal(midFlight.percent, null)
    assert.match(midFlight.detail, /已收 512 B/)
    assert.ok(!/%/.test(midFlight.detail), midFlight.detail)
  })

  it('cancels, then retries with a fresh signal', async () => {
    const signals = []
    const center = createDownloadCenter({ fetchBlob: async () => new Blob(['x']), saveBlob: async () => {} })
    center.entry()
    const handle = center.start({
      name: 'pack.zip',
      waitingDetail: '正在打包，完成后开始传输…',
      transfer: (context) => {
        signals.push(context.signal)
        if (signals.length === 1) return hangingTransfer()(context)
        context.onProgress(20, 20)
        return Promise.resolve({ size: 20 })
      },
    })
    await Promise.resolve()
    handle.cancel()
    const canceled = await handle.done
    assert.equal(canceled.state, 'canceled')
    assert.equal(signals[0].aborted, true)
    assert.match(downloadStatus(center.tasks[0]).detail, /可以重试/)

    await handle.retry().done
    assert.equal(center.tasks[0].state, 'done')
    assert.equal(center.tasks[0].received, 20)
    assert.notEqual(signals[1], signals[0], 'a retry gets its own controller')
    assert.equal(signals[1].aborted, false)
  })

  it('surfaces a disk error readably and stays retriable', async () => {
    let attempts = 0
    const center = createDownloadCenter({ fetchBlob: async () => new Blob(['x']), saveBlob: async () => {} })
    center.entry()
    const handle = center.start({
      name: 'pack.zip',
      transfer: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('保存到磁盘失败：磁盘空间不足。')
        return { size: 3 }
      },
    })
    const failed = await handle.done
    assert.equal(failed.state, 'failed')
    assert.equal(failed.message, '保存到磁盘失败：磁盘空间不足。')
    assert.equal(downloadStatus(center.tasks[0]).detail, '保存到磁盘失败：磁盘空间不足。')

    await handle.retry().done
    assert.equal(center.tasks[0].state, 'done')
    assert.equal(center.tasks[0].savedToDisk, true)
  })

  it('streams real bytes when the transfer answers with the file handle', async () => {
    const calls = []
    const center = createDownloadCenter({
      fetchBlob: async () => new Blob(['x']),
      saveBlob: async () => { throw new Error('the handle path must not buffer a Blob') },
      saveDownloadStream: async (url, handle, options) => {
        calls.push({ url, handle, options })
        options.onProgress(40, 40)
        return { size: 40 }
      },
    })
    center.entry()
    const fakeHandle = { kind: 'file', name: 'picked.bin' }
    const result = await center.start({
      name: 'picked.bin',
      kind: 'file',
      url: '/api/v1/shared/tok/content',
      auth: false,
      transfer: async () => fakeHandle,
    }).done

    assert.equal(result.state, 'done')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, '/api/v1/shared/tok/content')
    assert.equal(calls[0].handle, fakeHandle)
    assert.equal(calls[0].options.auth, false)
    assert.equal(center.tasks[0].received, 40)
    assert.equal(downloadStatus(center.tasks[0]).label, '已保存到磁盘')
  })
})

describe('a center with its own panel id', () => {
  const idle = () => createDownloadCenter({
    fetchBlob: async () => new Blob(['x']),
    saveBlob: async () => {},
    panelId: 'share-downloads-panel',
  })

  it('uses the id in the panel and in aria-controls, leaving the drive panel alone', () => {
    const center = idle()
    const entry = center.entry()
    assert.equal(entry.getAttribute('aria-controls'), 'share-downloads-panel')
    const panel = document.querySelector('#share-downloads-panel')
    assert.ok(panel, 'the panel carries the configured id')
    assert.equal(panel.hasAttribute('hidden'), true)
    assert.equal(document.querySelector('#downloads-panel'), null)
    center.destroy()
  })

  it('destroy() aborts its own tasks, removes the panel and the Escape listener', async () => {
    const center = idle()
    center.entry()
    center.open()
    assert.equal(center.openState, true)
    assert.equal(popupElements().length, 1)
    const keydownBefore = document.listeners.get('keydown') ? document.listeners.get('keydown').size : 0
    assert.equal(keydownBefore >= 1, true, 'an open panel listens for Escape')

    let signalSeen = null
    center.start({
      name: 'slow.zip',
      transfer: (context) => {
        signalSeen = context.signal
        return hangingTransfer()(context)
      },
    })
    await Promise.resolve()
    assert.ok(signalSeen, 'the transfer started and owns a live signal')

    center.destroy()

    assert.equal(signalSeen.aborted, true, 'a live task is canceled by destroy()')
    assert.equal(center.tasks.length, 0)
    assert.equal(document.querySelector('#share-downloads-panel'), null)
    assert.equal(document.querySelector('.downloads'), null)
    assert.equal(document.listeners.get('keydown')?.size || 0, 0, 'the Escape listener is gone')
    assert.deepEqual(popupElements(), [], 'the popup registration is released')
  })

  it('does not resurrect its panel after destroy()', () => {
    const center = idle()
    center.entry()
    center.destroy()
    center.open()
    assert.equal(center.openState, false)
    assert.equal(document.querySelector('.downloads'), null)
    assert.equal(document.listeners.get('keydown')?.size || 0, 0)
  })

  it('leaves the singleton drive center untouched', async () => {
    // The share page's center is a separate instance; the module singleton is
    // still the one the drive's entry points use.
    const { downloadCenter } = await import('../lib/downloads.js')
    const drive = downloadCenter()
    const share = idle()
    share.entry()
    share.destroy()
    assert.equal(drive.openState, false)
    assert.equal(document.querySelector('#downloads-panel'), null, 'the drive panel was not built here')
    assert.equal(typeof drive.start, 'function')
  })
})
