import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'node:test'
import { readFileSync } from 'node:fs'
import { installFakeDom } from './fake-dom.js'
import { createDownloadCenter } from '../lib/downloads.js'
import { popupElements, popupFocusables, FOCUSABLE_SELECTOR } from '../lib/focus.js'

/**
 * What a canceled transfer can still get wrong once the state machine is honest,
 * plus the two surfaces the browser check exposed:
 *
 *  - "已全部交给浏览器保存" over a row that says 已取消 contradicts the row.
 *    Canceled is counted on its own, never folded into 失败 and never called a
 *    save, and the task stays retriable.
 *  - The panel is appended to <body>, so a preview drawer's scrim used to sit on
 *    top of it: progress in the DOM, invisible to the user. It now lives one step
 *    above --z-modal (still under --z-menu/--z-toast) and joins the existing tab
 *    cycle through focus.js registerPopup while open, releasing it on close.
 *  - Signing out must not hand the next account the previous one's task list.
 */

installFakeDom()

beforeEach(() => {
  installFakeDom()
})

/** A transport that never delivers until aborted, so the test owns the timing. */
const hangingTransport = () => (url, options) => new Promise((resolve, reject) => {
  const fail = () => {
    const error = new Error('已取消下载。')
    error.name = 'AbortError'
    reject(error)
  }
  options.signal.addEventListener('abort', fail)
  if (options.signal.aborted) fail()
})

const canceledCenter = () => createDownloadCenter({
  fetchBlob: hangingTransport(),
  saveBlob: async () => {},
  contentUrl: (id) => '/files/' + id + '/content?download=1',
})

/** Start a task, cancel it, and wait for the settled state. */
async function startCanceled(center, name) {
  const handle = center.start({ node: { id: 'n-' + name, name }, name })
  await Promise.resolve()
  handle.cancel()
  await handle.done
  return handle
}

/** The summary element of the opened panel. */
const summaryOf = () => document.querySelector('.downloads .dl-summary')

describe('download panel: a cancel is not a save and not a failure', () => {
  it('names the canceled task instead of "已全部交给浏览器保存"', async () => {
    const center = canceledCenter()
    center.entry()
    center.open()
    await startCanceled(center, 'big.bin')

    assert.equal(center.tasks[0].state, 'canceled')
    const summary = summaryOf().textContent
    assert.match(summary, /1 个已取消/)
    assert.ok(!/已全部交给浏览器保存/.test(summary), 'a canceled row must not be reported as saved: ' + summary)
    assert.ok(!/失败/.test(summary), 'a cancel is not a failure: ' + summary)
  })

  it('counts saved and canceled side by side', async () => {
    const center = createDownloadCenter({
      fetchBlob: async (url, options) => {
        if (String(url).includes('slow')) return hangingTransport()(url, options)
        options.onProgress(10, 10)
        return new Blob(['ok'])
      },
      saveBlob: async () => {},
      contentUrl: (id) => '/files/' + id + '/content',
    })
    center.entry()
    center.open()
    await center.start({ node: { id: 'fast', name: 'fast.txt' }, name: 'fast.txt' }).done
    await startCanceled(center, 'slow.bin')

    const summary = summaryOf().textContent
    assert.match(summary, /1 个已保存/)
    assert.match(summary, /1 个已取消/)
    assert.ok(!/失败/.test(summary), summary)
  })

  it('keeps a canceled task retriable and counted on the entry', async () => {
    const center = canceledCenter()
    const entry = center.entry()
    center.open()
    await startCanceled(center, 'again.bin')

    const task = center.tasks[0]
    assert.equal(task.state, 'canceled')
    // The retry button is the promise behind "已取消，可以重试": retry() must
    // start a new attempt and keep the one task in the list.
    const retry = task.retry()
    assert.equal(retry, task)
    assert.equal(center.tasks.length, 1)
    task.cancel()
    await task.promise.catch(() => {})

    // The entry badge keeps counting a canceled task: it is the way back in.
    assert.equal(entry.querySelector('.dl-entry-count').textContent, '1')
    assert.match(entry.getAttribute('aria-label') || '', /已取消/)
  })

  it('clears the panel back to the empty state on clearFinished', async () => {
    const center = canceledCenter()
    center.entry()
    center.open()
    await startCanceled(center, 'gone.bin')
    center.clearFinished()
    assert.equal(center.tasks.length, 0)
    assert.equal(summaryOf().textContent, '暂无下载')
  })
})

describe('download panel: a popup of the page', () => {
  it('joins the registered popups while open and leaves them when closed', () => {
    const center = createDownloadCenter({ fetchBlob: async () => new Blob(['x']), saveBlob: async () => {} })
    center.entry()
    center.open()
    const panel = document.querySelector('.downloads')

    assert.deepEqual(popupElements(), [panel], 'an open panel is part of the tab cycle')
    const focusables = popupFocusables(FOCUSABLE_SELECTOR)
    assert.ok(focusables.length >= 2, 'the header actions are reachable: ' + focusables.length)
    for (const button of panel.querySelectorAll('button')) {
      assert.ok(button.getAttribute('aria-label'), 'every action is named for a screen reader')
    }

    center.close()
    assert.deepEqual(popupElements(), [], 'a closed panel must not hold a hidden tab stop')
  })

  it('registers once, not once per open', () => {
    const center = createDownloadCenter({ fetchBlob: async () => new Blob(['x']), saveBlob: async () => {} })
    center.entry()
    center.open()
    center.close()
    center.open()
    assert.equal(popupElements().length, 1)
    center.close()
    assert.equal(popupElements().length, 0)
  })
})

describe('download panel: signing out empties the center', () => {
  it('cancels live transfers, drops the rows and closes the panel', async () => {
    let aborted = false
    let inFlight = false
    const center = createDownloadCenter({
      contentUrl: (id) => '/files/' + id + '/content',
      saveBlob: async () => {},
      fetchBlob: (url, options) => new Promise((resolve, reject) => {
        inFlight = true
        options.signal.addEventListener('abort', () => {
          aborted = true
          reject(Object.assign(new Error('已取消下载。'), { name: 'AbortError' }))
        })
      }),
    })
    center.entry()
    center.open()
    const handle = center.start({ node: { id: 'live', name: 'in-flight.bin' }, name: 'in-flight.bin' })
    await Promise.resolve()
    assert.equal(inFlight, true, 'the transfer is the only thing reset() has to stop')
    assert.equal(center.tasks[0].settled, false)

    center.reset()
    await handle.done

    assert.equal(aborted, true, 'a live transfer must not keep running without a session')
    assert.equal(center.tasks.length, 0, 'the next login must not see the old task list')
    assert.equal(center.openState, false, 'the panel is closed, not just emptied')
    assert.equal(document.querySelector('.downloads').hasAttribute('hidden'), true)
  })
})

describe('download panel CSS: one task hierarchy with the upload queue', () => {
  const read = (name) => readFileSync(new URL('../styles/' + name, import.meta.url), 'utf8')
  const css = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '')
  const app = css(read('app.css'))
  const downloads = css(read('downloads.css'))

  /** Body of the first rule whose selector is exactly `head`, brace-matched. */
  function block(text, head) {
    const start = text.indexOf(head + '{')
    assert.ok(start >= 0, 'missing block ' + head)
    let depth = 0
    for (let position = start + head.length; position < text.length; position += 1) {
      if (text[position] === '{') depth += 1
      else if (text[position] === '}') {
        depth -= 1
        if (depth === 0) return text.slice(start + head.length + 1, position)
      }
    }
    assert.fail('unbalanced block ' + head)
  }

  it('opens at 420–440px on a desktop with a 44–48px header', () => {
    for (const panel of [block(app, '.queue'), block(downloads, '.downloads')]) {
      assert.match(panel, /width:min\(432px,calc\(100vw - 32px\)\)/)
    }
    for (const head of [block(app, '.queue-head'), block(downloads, '.dl-head')]) {
      assert.match(head, /height:46px/)
    }
  })

  it('uses one type scale: 13px name, 12px state and detail', () => {
    assert.match(block(app, '.qitem .qname'), /font-size:var\(--fs-base\)/)
    assert.match(block(app, '.qitem .qstate'), /font-size:var\(--fs-sm\)/)
    assert.match(block(app, '.qitem .qdetail'), /font-size:var\(--fs-sm\)/)
    assert.match(block(downloads, '.dl-name'), /font-size:var\(--fs-base\)/)
    assert.match(block(downloads, '.dl-state'), /font-size:var\(--fs-sm\)/)
    assert.match(block(downloads, '.dl-meta'), /font-size:var\(--fs-sm\)/)
  })

  it('gives the progress slot and the spacing the same numbers', () => {
    assert.match(block(app, '.qbar'), /height:4px/)
    assert.match(block(downloads, '.dl-bar'), /height:4px/)
    // Rows are separated, not stacked: 6px between rows in both lists.
    assert.match(block(app, '.queue-list'), /gap:6px/)
    assert.match(block(downloads, '.dl-list'), /gap:6px/)
  })

  it('wraps a long name and a failure reason instead of clipping them', () => {
    assert.match(block(app, '.qitem .qname'), /line-clamp:2/)
    assert.match(block(downloads, '.dl-name'), /line-clamp:2/)
    assert.match(block(app, '.qitem .qname'), /overflow-wrap:anywhere/)
    assert.match(block(downloads, '.dl-name'), /overflow-wrap:anywhere/)
    assert.match(block(downloads, '.dl-meta'), /overflow-wrap:anywhere/)
  })

  it('is visible above a preview or dialog scrim but under menus and toasts', () => {
    const panel = block(downloads, '.downloads')
    assert.match(panel, /z-index:calc\(var\(--z-modal\) \+ 1\)/)
    // The menu and toast layers are declared above the modal in tokens.css; the
    // panel must stay under both.
    const tokens = read('tokens.css')
    const value = (name) => Number(new RegExp('--' + name + ':\\s*(\\d+);').exec(tokens)[1])
    assert.ok(value('z-modal') + 1 < value('z-menu'))
    assert.ok(value('z-modal') + 1 < value('z-toast'))
  })

  it('stays inside a 6–10px edge on a phone with a scrollable list', () => {
    const narrow = block(downloads, '@media (max-width:700px)')
    assert.match(narrow, /\.downloads\{left:10px;right:10px;width:auto/)
    assert.match(block(downloads, '@media (max-width:360px)'), /\.downloads\{left:6px;right:6px\}/)
    assert.match(block(downloads, '.dl-list'), /overflow:auto/)
    assert.match(block(app, '.queue-list'), /overflow:auto/)
    // Downloads stay in the top band; the upload queue keeps the bottom edge.
    assert.ok(!/bottom:/.test(block(downloads, '.downloads')), 'the bottom edge belongs to the upload queue')
    assert.match(block(app, '.queue'), /bottom:/)
  })

  it('keeps the folded entry small and the touch targets larger on a phone', () => {
    const launcher = block(app, '.queue-launcher')
    assert.match(launcher, /min-height:44px/)
    assert.match(launcher, /max-width:min\(224px/)
    const narrow = block(downloads, '@media (max-width:700px)')
    assert.match(narrow, /\.dl-actions \.icon-btn\{width:28px;height:28px/)
  })
})
