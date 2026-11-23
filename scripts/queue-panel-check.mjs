#!/usr/bin/env node
/**
 * Upload panel check: the folded queue and the readable fail reason.
 *
 *   node scripts/queue-panel-check.mjs [--server URL]
 *
 * upload-check already proves bytes move. This one proves the panel stays usable
 * while they do:
 *   - 收起 hides the rows but leaves a 44px launcher carrying the batch counts;
 *   - later progress and state events cannot re-open the panel behind the user;
 *   - clicking the launcher brings the very same live rows back;
 *   - a failure shows its reason as visible text (not only a hover title), and
 *     at 320 CSS px the panel stays readable, clickable and inside the viewport.
 *
 * One real rejected upload produces the failure reason; the remaining rows are
 * synthetic tasks fed to the production panel module, so the code under test is
 * the real paint/updateSummary path rather than a re-implementation of it.
 */

import { serverUrl, runBrowserCheck, signUpInPage, sleep } from './lib/browser.mjs'

const server = serverUrl()

process.exit(await runBrowserCheck({ title: 'Upload panel check', network: true }, async (page, check) => {
  await page.navigate(server + '/', { settle: 1400 })
  const session = await signUpInPage(page, { prefix: 'queue-panel', password: 'queue panel check password' })
  check('signed in', Boolean(session.token))
  await page.reload({ settle: 1800 })
  await page.waitFor("document.getElementById('shell')", { timeout: 20000, label: 'shell mounted' })

  /* ── 1. a real failure, produced by a real request ──────────── */
  const failure = await page.run(async () => {
    const { createUploadTask } = await import('/lib/upload.js')
    const file = new File([new Uint8Array(2048)], 'quota.bin', { type: 'application/octet-stream' })
    // A parent that does not exist: the server rejects it and the task records
    // the reason on itself, exactly as a production failure does. Retries are
    // disabled so the check does not sit through the backoff schedule.
    const task = createUploadTask({ file, parentId: 'missing-folder-id', maxAttempts: 1 })
    await task.start().catch(() => {})
    return { state: task.state, message: task.error ? task.error.message : '' }
  })
  check('a rejected upload ends in the error state', failure.state === 'error', JSON.stringify(failure))
  check('the task records a human-readable reason', typeof failure.message === 'string' && failure.message.length > 0, JSON.stringify(failure))

  /* ── 2. the panel renders that reason as text ───────────────── */
  const shown = await page.run(async (message) => {
    const { createQueuePanel } = await import('/lib/queue.js')
    // This check owns the only panel on screen: drop the app's own instances.
    for (const node of document.querySelectorAll('.queue, .queue-launcher')) node.remove();

    const emitter = (task) => {
      const listeners = new Map()
      task.on = (type, handler) => {
        if (!listeners.has(type)) listeners.set(type, new Set())
        listeners.get(type).add(handler)
        return () => listeners.get(type).delete(handler)
      }
      task.fire = (type) => { for (const handler of listeners.get(type) || []) handler({ task, state: task.state, progress: task.progress }) }
      return task
    }
    const make = (id, name, state, extra) => emitter({
      id, name, size: 8 * 1024 * 1024, state, progress: 0, uploaded: 0, speed: 0,
      error: null, retry: () => Promise.resolve(null), pause: () => true,
      resume: () => Promise.resolve(null), cancel: () => {}, ...extra,
    })

    const panel = createQueuePanel({})
    const running = make('run-1', 'movie.mkv', 'uploading', {
      progress: 0.42, uploaded: Math.round(8 * 1024 * 1024 * 0.42), speed: 1.2 * 1024 * 1024,
    })
    const broken = make('err-1', 'quota.bin', 'error', { uploaded: 1024, error: { message } })
    panel.track(running)
    panel.track(broken)
    panel.show()
    window.__queuePanel = { panel, running, broken }
    await new Promise((resolve) => setTimeout(resolve, 420))

    const text = (node) => (node ? node.innerText.replace(/\s+/g, ' ').trim() : '')
    const rowOf = (id) => Array.from(panel.panel.querySelectorAll('.qitem')).find((node) => node.dataset.id === id)
    const errorRow = rowOf('err-1')
    return {
      open: !panel.panel.hasAttribute('hidden'),
      launcherVisible: !panel.launcher.hasAttribute('hidden'),
      runningText: text(rowOf('run-1')),
      errorDetail: text(errorRow.querySelector('.qdetail')),
      errorState: text(errorRow.querySelector('.qstate')),
      errorTitle: errorRow.querySelector('.qstate').getAttribute('title'),
      summary: text(panel.panel.querySelector('.qsummary')),
      reasonClipped: errorRow.querySelector('.qdetail').scrollWidth > errorRow.querySelector('.qdetail').clientWidth + 2,
      reasonHeight: errorRow.querySelector('.qdetail').getBoundingClientRect().height,
    }
  }, failure.message)
  check('the error row prints its reason in visible text',
    shown.errorDetail === failure.message.trim() && shown.reasonHeight > 0,
    JSON.stringify({ detail: shown.errorDetail, expected: failure.message, height: shown.reasonHeight }))
  check('the reason is not only a hover title', shown.errorTitle === null, String(shown.errorTitle))
  check('the row leads with 失败', shown.errorState === '失败', shown.errorState)
  check('a running row shows transferred bytes and a speed',
    /\d.*\/.*\d/.test(shown.runningText) && /\/s/.test(shown.runningText), JSON.stringify(shown.runningText))
  check('the header separates failed rows from live ones', /失败/.test(shown.summary), JSON.stringify(shown.summary))

  /* ── 3. folding survives the next progress event ────────────── */
  const folded = await page.run(async () => {
    const { panel, running } = window.__queuePanel
    panel.panel.querySelector('[aria-label="收起上传队列"]').click()
    await new Promise((resolve) => setTimeout(resolve, 120))
    const afterClick = {
      open: !panel.panel.hasAttribute('hidden'),
      launcher: !panel.launcher.hasAttribute('hidden'),
      launcherText: panel.launcher.innerText.replace(/\s+/g, ' ').trim(),
    }
    // The network keeps talking: bytes, then a state change, then more bytes.
    running.progress = 0.6
    running.uploaded = Math.round(8 * 1024 * 1024 * 0.6)
    running.fire('progress')
    running.progress = 0.75
    running.fire('progress')
    running.state = 'finalizing'
    running.fire('state')
    running.fire('progress')
    await new Promise((resolve) => setTimeout(resolve, 320))
    const afterEvents = {
      open: !panel.panel.hasAttribute('hidden'),
      launcher: !panel.launcher.hasAttribute('hidden'),
      launcherText: panel.launcher.innerText.replace(/\s+/g, ' ').trim(),
    }
    return { afterClick, afterEvents }
  })
  check('收起 hides the rows', folded.afterClick.open === false, JSON.stringify(folded))
  check('收起 leaves a launcher behind', folded.afterClick.launcher === true, JSON.stringify(folded))
  check('the launcher keeps the batch summary', folded.afterClick.launcherText.length > 0, JSON.stringify(folded.afterClick.launcherText))
  check('a progress event never re-opens a folded panel', folded.afterEvents.open === false, JSON.stringify(folded.afterEvents))
  check('a state change never re-opens a folded panel either', folded.afterEvents.launcher === true, JSON.stringify(folded.afterEvents))

  const reopened = await page.run(async () => {
    const { panel } = window.__queuePanel
    panel.launcher.click()
    await new Promise((resolve) => setTimeout(resolve, 200))
    const rows = Array.from(panel.panel.querySelectorAll('.qitem'))
    return {
      open: !panel.panel.hasAttribute('hidden'),
      launcher: !panel.launcher.hasAttribute('hidden'),
      rows: rows.length,
      finalizing: rows.some((row) => /服务端收尾/.test(row.innerText)),
      lied: rows.some((row) => /上传成功/.test(row.innerText)),
    }
  })
  check('clicking the launcher brings the live rows back', reopened.open === true && reopened.rows >= 2, JSON.stringify(reopened))
  check('the launcher hides once the panel is open', reopened.launcher === false, JSON.stringify(reopened))
  check('server finalisation is never written as success', reopened.finalizing === true && reopened.lied === false, JSON.stringify(reopened))

  const afterUserExpand = await page.run(async () => {
    const { panel, running } = window.__queuePanel
    running.progress = 0.9
    running.fire('progress')
    await new Promise((resolve) => setTimeout(resolve, 320))
    return { open: !panel.panel.hasAttribute('hidden') }
  })
  check('after the user re-opens it, progress keeps it open', afterUserExpand.open === true, JSON.stringify(afterUserExpand))

  /* ── 4. 320 CSS px: readable, clickable, no sideways scroll ─── */
  await page.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 780, deviceScaleFactor: 1, mobile: false })
  await page.navigate(server + '/', { settle: 1600 })
  await page.waitFor("document.getElementById('shell')", { timeout: 20000, label: 'shell mounted at 320px' })

  const narrow = await page.run(async () => {
    const { createQueuePanel } = await import('/lib/queue.js')
    for (const node of document.querySelectorAll('.queue, .queue-launcher')) node.remove();
    const panel = createQueuePanel({})
    const task = {
      id: 'narrow-1', name: 'a-very-long-photograph-name-from-a-phone.jpg',
      size: 12 * 1024 * 1024, state: 'error', progress: 0.3, uploaded: 3.6 * 1024 * 1024, speed: 0,
      error: { message: '存储配额已满，请清理回收站后重试这个文件。' },
      on: () => () => {}, retry: () => Promise.resolve(null), pause: () => true,
      resume: () => Promise.resolve(null), cancel: () => {},
    }
    panel.track(task)
    panel.show()
    await new Promise((resolve) => setTimeout(resolve, 420))
    const row = panel.panel.querySelector('.qitem')
    const detail = row.querySelector('.qdetail')
    const status = row.querySelector('.qstate')
    const buttons = Array.from(row.querySelectorAll('.qactions .icon-btn'))
      .filter((node) => !node.hasAttribute('hidden'))
      .map((node) => {
        const rect = node.getBoundingClientRect()
        return { w: rect.width, h: rect.height, right: rect.right }
      })
    const result = {
      panelWidth: panel.panel.getBoundingClientRect().width,
      innerWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      rowOverflow: row.scrollWidth - row.clientWidth,
      detailText: detail.innerText,
      detailHeight: detail.getBoundingClientRect().height,
      detailBelow: detail.getBoundingClientRect().top >= status.getBoundingClientRect().top,
      buttons,
    }
    panel.fold()
    await new Promise((resolve) => setTimeout(resolve, 240))
    const launcher = panel.launcher.getBoundingClientRect()
    result.launcher = { width: launcher.width, height: launcher.height, right: launcher.right, left: launcher.left }
    result.documentWidthAfterFold = document.documentElement.scrollWidth
    // Screenshot the folded launcher before the instance is torn down.
    panel.launcher.id = 'queue-launcher-shot'
    return result
  })
  await page.shot('queue-panel-320-folded')
  const narrowOpen = await page.run(async () => {
    document.getElementById('queue-launcher-shot').click()
    await new Promise((resolve) => setTimeout(resolve, 320))
    const panel = document.querySelector('.queue')
    const result = { open: panel ? !panel.hasAttribute('hidden') : false }
    return result
  })
  await page.shot('queue-panel-320')
  check('the launcher re-opens the narrow panel', narrowOpen.open === true, JSON.stringify(narrowOpen))
  await page.run(() => {
    const panel = document.querySelector('.queue')
    if (panel) panel.remove()
    for (const node of document.querySelectorAll('.queue-launcher')) node.remove()
  })
  check('at 320px the panel fits the viewport',
    narrow.panelWidth <= 320 && narrow.documentWidth <= narrow.innerWidth,
    JSON.stringify({ panel: narrow.panelWidth, doc: narrow.documentWidth, win: narrow.innerWidth }))
  check('a long fail reason wraps instead of overflowing sideways',
    narrow.rowOverflow <= 1 && narrow.detailHeight > 0 && /配额/.test(narrow.detailText),
    JSON.stringify({ overflow: narrow.rowOverflow, text: narrow.detailText }))
  check('the state word and the reason stack readably at 320px', narrow.detailBelow === true, JSON.stringify(narrow))
  check('row actions keep 24px targets inside 320px',
    narrow.buttons.length >= 1 && narrow.buttons.every((box) => box.w >= 24 && box.h >= 24 && box.right <= 320),
    JSON.stringify(narrow.buttons))
  check('the folded launcher is a 44px target inside the screen',
    narrow.launcher.height >= 44 && narrow.launcher.right <= 320 && narrow.launcher.left >= 0,
    JSON.stringify(narrow.launcher))
  check('folding does not create a horizontal scrollbar', narrow.documentWidthAfterFold <= narrow.innerWidth, String(narrow.documentWidthAfterFold))
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false })
  await sleep(200)

  /* ── 5. no console noise from the panel ─────────────────────── */
  check('no console errors', page.consoleErrors.length === 0, page.consoleErrors.slice(0, 3).join(' | '))
  check('no failed requests', page.failedRequests.length === 0, page.failedRequests.slice(0, 3).join(' | '))
}))
