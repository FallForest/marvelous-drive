#!/usr/bin/env node
/**
 * Download center check.
 *
 *   node scripts/download-check.mjs [--server http://127.0.0.1:49322]
 *
 * Drives a real headless Chrome against a disposable instance and proves the
 * four things the progress panel exists for:
 *
 *   1. under a REAL throttled connection (CDP network emulation, not a mocked
 *      fetch) the percentage moves through an intermediate value and only then
 *      reaches "已交给浏览器保存";
 *   2. cancel stops the transfer, keeps the task, and offers a retry;
 *   3. a failed fetch shows a readable reason and a retry that really works;
 *   4. the topbar entry re-opens the panel from any route and still lists the
 *      tasks it collected.
 *
 * Nothing is asserted about the bytes Chrome writes to disk: a page can only
 * confirm that a complete response was handed to the browser.
 */
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { runBrowserCheck, signUpInPage, serverUrl, sleep } from './lib/browser.mjs'

const server = serverUrl()
// Absolute: a CDP download path is resolved by Chrome, not by this process.
mkdirSync(resolve('.tmp/download-check-saves'), { recursive: true })

/** Bytes/s: slow enough to sample, fast enough for a check. */
const THROTTLE_BPS = 160 * 1024

const unthrottled = { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }

process.exit(await runBrowserCheck({ title: 'Download center check', network: true }, async (page, check) => {
  // Headless Chrome denies downloads by default; a blob-URL download is refused
  // silently, which would look like a product failure.
  await page.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: '.tmp/download-check-saves' }).catch(() => {})
  await page.navigate(server + '/', { settle: 1400 })
  const session = await signUpInPage(page, { prefix: 'download', password: 'download check password' })
  check('page signs in', Boolean(session.token))
  await page.reload({ settle: 1600 })

  const seeded = await page.run(async () => {
    const headers = { authorization: 'Bearer ' + localStorage.getItem('mdrive-token') }
    const upload = async (name, size) => {
      const bytes = new Uint8Array(size)
      for (let index = 0; index < size; index += 1) bytes[index] = (index * 31 + 7) % 251
      const response = await fetch('/api/v1/uploads?name=' + encodeURIComponent(name), {
        method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: bytes,
      })
      const payload = await response.json()
      return payload.node
    }
    // ~600 KiB at 160 KiB/s is roughly four seconds: enough samples, short check.
    const slow = await upload('slow-transfer.bin', 600 * 1024)
    const huge = await upload('cancel-me.bin', 900 * 1024)
    const broken = await upload('broken.txt', 128)
    // A folder for the ZIP flow, plus one file inside it so the archive is real.
    const folder = (await (await fetch('/api/v1/nodes', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'PackingBundle', kind: 'folder', parentId: null }),
    })).json()).node
    const inside = await upload('inside.txt', 64)
    await fetch('/api/v1/nodes/' + inside.id, {
      method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ parentId: folder.id }),
    })
    return { slow: slow.id, huge: huge.id, broken: broken.id, folder: folder.id }
  })
  check('fixtures uploaded', Boolean(seeded.slow && seeded.huge && seeded.broken), JSON.stringify(seeded))
  await page.navigate(server + '/', { settle: 1600 })
  await page.waitFor("document.querySelectorAll('.frow[data-id]').length >= 3")
  check('the topbar carries a download entry', await page.evaluate("Boolean(document.querySelector('.dl-entry'))"))

  /* ── 1. real throttle: middle value, then completion ───────── */
  await page.send('Network.emulateNetworkConditions', {
    offline: false, latency: 40, downloadThroughput: THROTTLE_BPS, uploadThroughput: 1024 * 1024,
  })
  const startSlow = () => page.run((id) => {
    document.querySelector('.frow[data-id="' + id + '"] [data-action="more"]').click()
  }, seeded.slow)
  await startSlow()
  await page.waitFor("document.querySelector('.menu')")
  await page.run(() => [...document.querySelectorAll('.menu-item')].find((item) => item.textContent.trim() === '下载').click())

  const samples = []
  const startedAt = Date.now()
  while (Date.now() - startedAt < 25000) {
    const sample = await page.run(() => {
      const row = document.querySelector('.dl-item')
      const bar = row ? row.querySelector('.dl-bar') : null
      const entry = document.querySelector('.dl-entry-count')
      return {
        state: row ? row.dataset.state : null,
        label: row ? (row.querySelector('.dl-state') || {}).textContent || '' : '',
        detail: row ? (row.querySelector('.dl-meta') || {}).textContent || '' : '',
        now: bar && bar.hasAttribute('aria-valuenow') ? Number(bar.getAttribute('aria-valuenow')) : null,
        entry: entry ? entry.textContent : '',
        panel: Boolean(document.querySelector('.downloads')) && !document.querySelector('.downloads').hasAttribute('hidden'),
      }
    })
    samples.push(sample)
    if (sample.state === 'done' || sample.state === 'failed' || sample.state === 'canceled') break
    await sleep(120)
  }
  const states = samples.map((sample) => sample.state)
  const middles = samples.filter((sample) => sample.now !== null && sample.now > 0 && sample.now < 100)
  const final = samples[samples.length - 1]
  check('the transfer is visible while it runs', states.includes('transferring'), JSON.stringify(states))
  check('progress passes through a real intermediate percentage', middles.length >= 1, JSON.stringify(samples.slice(0, 6)))
  check('progress reaches 100% only at the end', final && final.now === 100, JSON.stringify(final))
  check('the finished task says the browser has the file', final && final.state === 'done' && /已交给浏览器保存/.test(final.label), JSON.stringify(final))
  check('the panel opened from the new task without a click', samples.some((sample) => sample.panel))
  check('the topbar entry counted the running task', samples.some((sample) => sample.entry === '1'), JSON.stringify(samples.map((sample) => sample.entry)))
  await page.send('Network.emulateNetworkConditions', unthrottled)

  /* ── 2. cancel ────────────────────────────────────────────── */
  await page.send('Network.emulateNetworkConditions', {
    offline: false, latency: 40, downloadThroughput: 40 * 1024, uploadThroughput: 1024 * 1024,
  })
  await page.run((id) => document.querySelector('.frow[data-id="' + id + '"] [data-action="more"]').click(), seeded.huge)
  await page.waitFor("document.querySelector('.menu')")
  await page.run(() => [...document.querySelectorAll('.menu-item')].find((item) => item.textContent.trim() === '下载').click())
  await page.waitFor("document.querySelector('.dl-item[data-state=\"transferring\"]')", { timeout: 15000 })
  await sleep(300)
  const canceled = await page.run(() => {
    const row = [...document.querySelectorAll('.dl-item')].find((item) => item.dataset.state === 'transferring')
    if (!row) return null
    const before = Number((row.querySelector('.dl-bar') || {}).getAttribute
      ? row.querySelector('.dl-bar').getAttribute('aria-valuenow')
      : 0)
    row.querySelector('[aria-label^="取消下载"]').click()
    return { before }
  })
  await page.waitFor("document.querySelector('.dl-item[data-state=\"canceled\"]')", { timeout: 8000 })
  const afterCancel = await page.run(() => {
    const row = document.querySelector('.dl-item[data-state="canceled"]')
    return {
      label: (row.querySelector('.dl-state') || {}).textContent || '',
      detail: (row.querySelector('.dl-meta') || {}).textContent || '',
      retry: Boolean(row.querySelector('[aria-label^="重试下载"]')),
      cancelHidden: !row.querySelector('[aria-label^="取消下载"]')
        || row.querySelector('[aria-label^="取消下载"]').hasAttribute('hidden'),
    }
  })
  check('cancel settles the task as canceled', afterCancel.label === '已取消', JSON.stringify(afterCancel))
  check('a canceled task offers a retry and no longer a cancel',
    afterCancel.retry && afterCancel.cancelHidden, JSON.stringify(afterCancel))
  await page.send('Network.emulateNetworkConditions', unthrottled)

  /* ── 3. a readable failure and a working retry ─────────────── */
  await page.run((id) => {
    const next = window.fetch.bind(window)
    window.__restoreDownloadFetch = () => { window.fetch = next }
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : String(input && input.url)
      if (url.includes('/files/' + id + '/content')) {
        return Promise.resolve(new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '磁盘忙，稍后再试' } }),
          { status: 500, headers: { 'content-type': 'application/json' } }))
      }
      return next(input, init)
    }
    document.querySelector('.frow[data-id="' + id + '"] [data-action="more"]').click()
  }, seeded.broken)
  await page.waitFor("document.querySelector('.menu')")
  await page.run(() => [...document.querySelectorAll('.menu-item')].find((item) => item.textContent.trim() === '下载').click())
  await page.waitFor("document.querySelector('.dl-item[data-state=\"failed\"]')", { timeout: 10000 })
  const failed = await page.run(() => {
    const row = document.querySelector('.dl-item[data-state="failed"]')
    return {
      label: (row.querySelector('.dl-state') || {}).textContent || '',
      detail: (row.querySelector('.dl-meta') || {}).textContent || '',
      retry: Boolean(row.querySelector('[aria-label^="重试下载"]')),
    }
  })
  check('a failure states its reason in the row', failed.label === '下载失败' && /磁盘忙/.test(failed.detail), JSON.stringify(failed))
  check('a failed task offers a retry', failed.retry, JSON.stringify(failed))

  await page.run(() => { if (window.__restoreDownloadFetch) window.__restoreDownloadFetch() })
  await page.run(() => {
    const row = document.querySelector('.dl-item[data-state="failed"]')
    row.querySelector('[aria-label^="重试下载"]').click()
  })
  await page.waitFor("document.querySelector('.dl-item[data-state=\"done\"]')", { timeout: 10000 })
  const retried = await page.run(() => {
    const row = document.querySelector('.dl-item[data-state="done"]')
    return { label: (row.querySelector('.dl-state') || {}).textContent || '' }
  })
  check('retry really downloads the file', /已交给浏览器保存/.test(retried.label), JSON.stringify(retried))

  /* ── 4. a ZIP shows packaging first, then a real transfer ───── */
  await page.run((id) => {
    // Hold the archive POST open: without this the pack finishes inside one
    // poll and the "正在打包" state would never be observable, which is exactly
    // the state a slow folder needs to be honest about.
    const next = window.fetch.bind(window)
    window.__restoreArchiveFetch = () => { window.fetch = next }
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : String(input && input.url)
      if (init && init.method === 'POST' && url.endsWith('/nodes/' + id + '/archive')) {
        await new Promise((resolve) => setTimeout(resolve, 900))
      }
      return next(input, init)
    }
    document.querySelector('.frow[data-id="' + id + '"] [data-action="more"]').click()
  }, seeded.folder)
  await page.waitFor("document.querySelector('.menu')")
  await page.run(() => [...document.querySelectorAll('.menu-item')].find((item) => item.textContent.includes('下载为 ZIP')).click())
  await page.waitFor("document.querySelector('.dl-item[data-state=\"packaging\"]')", { timeout: 8000 })
  const packing = await page.run(() => {
    const row = document.querySelector('.dl-item[data-state="packaging"]')
    const bar = row.querySelector('.dl-bar')
    return {
      label: (row.querySelector('.dl-state') || {}).textContent || '',
      detail: (row.querySelector('.dl-meta') || {}).textContent || '',
      indeterminate: bar.classList.contains('is-indeterminate'),
      percent: bar.hasAttribute('aria-valuenow'),
    }
  })
  check('a ZIP starts in an explicit packaging state with no fake total',
    packing.label === '正在打包' && /总量未知/.test(packing.detail) && packing.indeterminate && !packing.percent,
    JSON.stringify(packing))
  await page.waitFor("document.querySelector('.dl-item[data-state=\"done\"]')", { timeout: 20000 })
  await page.run(() => { if (window.__restoreArchiveFetch) window.__restoreArchiveFetch() })

  /* ── 5. the entry is findable again from another route ─────── */
  await page.run(() => document.querySelector('.dl-head [aria-label="关闭下载面板"]').click())
  check('the panel can be closed', await page.evaluate("document.querySelector('.downloads').hasAttribute('hidden')"))
  await page.run(() => window.mdrive.navigate('/starred'))
  await page.waitFor("document.querySelector('.section-head') || document.querySelector('.empty')", { timeout: 8000 })
  const reopened = await page.run(() => {
    const entry = document.querySelector('.dl-entry')
    if (!entry) return { entry: false }
    const badge = document.querySelector('.dl-entry-count')
    entry.click()
    const panel = document.querySelector('.downloads')
    return {
      entry: true,
      badge: badge ? badge.textContent : '',
      open: Boolean(panel) && !panel.hasAttribute('hidden'),
      rows: document.querySelectorAll('.dl-item').length,
      done: document.querySelectorAll('.dl-item[data-state="done"]').length,
    }
  })
  check('the entry survives a route change and re-opens the same list',
    reopened.entry && reopened.open && reopened.rows >= 2 && reopened.done >= 2, JSON.stringify(reopened))

  /* ── 6. narrow screen: the two floating panels never cover each other ── */
  // The upload queue only appears once something is queued. A stand-in with the
  // same class and the same anchoring rules is enough to measure the layout,
  // and it avoids uploading a file just to size a box.
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 740, deviceScaleFactor: 1, mobile: false,
  })
  await sleep(400)
  const narrow = await page.run(() => {
    const panel = document.querySelector('.downloads')
    if (!panel) return { panel: false }
    panel.removeAttribute('hidden')
    const queue = document.createElement('section')
    queue.className = 'queue'
    queue.setAttribute('aria-hidden', 'true')
    queue.style.height = '220px'
    document.body.appendChild(queue)
    const p = panel.getBoundingClientRect()
    const q = queue.getBoundingClientRect()
    const overlap = !(p.bottom <= q.top || q.bottom <= p.top || p.right <= q.left || q.right <= p.left)
    const fits = p.left >= 0 && p.right <= 390 && p.top >= 0
    queue.remove()
    return { panel: true, overlap, fits, p: { top: p.top, bottom: p.bottom, left: p.left, right: p.right }, q: { top: q.top } }
  })
  check('on a 390px screen the panel fits and clears the upload queue',
    narrow.panel && narrow.fits && !narrow.overlap, JSON.stringify(narrow))
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 960, deviceScaleFactor: 1, mobile: false,
  })

  check('no console errors', page.consoleErrors.length === 0, page.consoleErrors.slice(0, 3).join(' | '))
}))

