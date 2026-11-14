#!/usr/bin/env node
/**
 * Click-model check: the one rule the drive is built on.
 *
 *   node scripts/click-check.mjs [--server URL]
 *
 * A plain click runs the item's action (folder navigates, file previews); the
 * checkbox and the modifier keys select. This is asserted against the real DOM
 * because the whole point of the change is that the *gesture* works — a unit
 * test on rowAction() cannot tell whether a listener is still swallowing it.
 */

import { serverUrl, runBrowserCheck, signUpInPage, sleep } from './lib/browser.mjs'

const server = serverUrl()

process.exit(await runBrowserCheck({ title: 'Marvelous Drive click model check', network: true }, async (page, check) => {
  await page.navigate(server + '/', { settle: 1200 })
  const session = await signUpInPage(page, { prefix: 'click', password: 'click model password' })
  check('signed in', typeof session.token === 'string' && session.token.length > 20)

  const seeded = await page.run(async () => {
    const token = localStorage.getItem('mdrive-token')
    const headers = { authorization: 'Bearer ' + token }
    const post = (path, payload) => fetch(path, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(payload),
    })
    const put = (query, body, type) => fetch('/api/v1/uploads?' + query, {
      method: 'PUT', headers: { ...headers, 'content-type': type }, body,
    })
    const folder = await (await post('/api/v1/nodes', { name: '项目资料', kind: 'folder' })).json()
    const file = await (await put('name=' + encodeURIComponent('说明.md'), '# 说明', 'text/markdown')).json()
    return { folder: folder.node.id, file: file.node.id }
  })
  check('seed data created', typeof seeded.folder === 'string' && typeof seeded.file === 'string', JSON.stringify(seeded))

  await page.reload({ settle: 1800 })
  await page.waitFor("document.querySelectorAll('.frow[data-id]').length >= 2", { label: 'file rows' })

  const rowOf = (name) => page.run((wanted) => {
    const row = Array.from(document.querySelectorAll('.frow[data-id]'))
      .find((element) => (element.querySelector('.name') || {}).textContent === wanted)
    return Boolean(row)
  }, name)

  /** Clicks a row's name and reports where the app ended up. */
  const clickRow = (name) => page.run(async (wanted) => {
    const row = Array.from(document.querySelectorAll('.frow[data-id]'))
      .find((element) => (element.querySelector('.name') || {}).textContent === wanted)
    if (!row) return { error: 'row missing' }
    row.querySelector('.name').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 700))
    return {
      error: null,
      path: location.pathname,
      drawer: Boolean(document.querySelector('.preview-drawer')),
      drawers: document.querySelectorAll('.preview-drawer').length,
    }
  }, name)

  check('the folder row exists', await rowOf('项目资料'))
  check('the file row exists', await rowOf('说明.md'))

  /* ── 1. a plain click on a folder navigates ─────────────────── */
  const folderClick = await clickRow('项目资料')
  check('one click on a folder enters it', folderClick.path.startsWith('/folder/'), JSON.stringify(folderClick))
  check('entering a folder opens no preview', folderClick.drawer === false, JSON.stringify(folderClick))
  await page.shot('click-01-folder')

  /* The folder is empty; go back to the parent for the file checks. */
  await page.run(() => { history.pushState({}, '', '/'); window.dispatchEvent(new PopStateEvent('popstate')) })
  await sleep(1200)

  /* ── 2. a plain click on a file previews, and does not navigate ─ */
  const fileClick = await clickRow('说明.md')
  check('one click on a file opens the preview', fileClick.drawer === true, JSON.stringify(fileClick))
  check('previewing a file keeps the route', fileClick.path === '/', JSON.stringify(fileClick))
  await page.shot('click-02-preview')

  /* ── 3. a double click must not stack a second drawer ────────── */
  await page.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  await sleep(500)
  const dbl = await page.run(async () => {
    const row = Array.from(document.querySelectorAll('.frow[data-id]'))
      .find((element) => (element.querySelector('.name') || {}).textContent === '说明.md')
    if (!row) return { error: 'row missing' }
    const target = row.querySelector('.name')
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 900))
    return { error: null, drawers: document.querySelectorAll('.preview-drawer').length }
  })
  check('a double click still leaves one drawer', dbl.drawers === 1, JSON.stringify(dbl))
  await page.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  await sleep(400)

  /* ── 4. the checkbox selects without opening ────────────────── */
  // Opening a file left it selected; start the checkbox check from a clean bar.
  await page.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  await sleep(400)
  const boxed = await page.run(async () => {
    const row = Array.from(document.querySelectorAll('.frow[data-id]'))
      .find((element) => (element.querySelector('.name') || {}).textContent === '项目资料')
    const box = row && row.querySelector('.pick')
    if (!box) return { error: 'no checkbox' }
    box.click()
    await new Promise((resolve) => setTimeout(resolve, 400))
    return {
      error: null,
      checked: box.checked,
      drawers: document.querySelectorAll('.preview-drawer').length,
      path: location.pathname,
      bar: (document.querySelector('.sel-bar') || {}).innerText || '',
    }
  })
  check('the row has a checkbox', boxed.error === null, JSON.stringify(boxed))
  check('the checkbox selects the folder', boxed.checked === true, JSON.stringify(boxed))
  check('the checkbox does not navigate', boxed.path === '/', JSON.stringify(boxed))
  check('the checkbox does not open a preview', boxed.drawers === 0, JSON.stringify(boxed))
  check('the selection bar counts it', /已选择 1 项/.test(boxed.bar), JSON.stringify(boxed.bar))
  await page.shot('click-03-checkbox')

  /* ── 5. select all / clear from the header checkbox ─────────── */
  const all = await page.run(async () => {
    const head = document.querySelector('.list-head .pick-all')
    if (!head) return { error: 'no select-all' }
    head.click()
    await new Promise((resolve) => setTimeout(resolve, 400))
    const after = (document.querySelector('.sel-bar') || {}).innerText || ''
    const checked = document.querySelectorAll('.frow .pick:checked').length
    return { error: null, after, checked, total: document.querySelectorAll('.frow .pick').length }
  })
  check('the header selects every row', all.checked === all.total && all.total >= 2, JSON.stringify(all))
  check('the selection bar shows the full count', /已选择 2 项/.test(all.after), JSON.stringify(all.after))

  const cleared = await page.run(async () => {
    document.querySelector('.list-head .pick-all').click()
    await new Promise((resolve) => setTimeout(resolve, 300))
    return { bar: Boolean(document.querySelector('.sel-bar')), checked: document.querySelectorAll('.frow .pick:checked').length }
  })
  check('clicking it again clears the selection', cleared.bar === false && cleared.checked === 0, JSON.stringify(cleared))

  /* ── 6. Ctrl+click selects instead of opening ───────────────── */
  const additive = await page.run(async () => {
    const rows = Array.from(document.querySelectorAll('.frow[data-id]'))
    // Both clicks carry the modifier: a bare click would open the folder, which
    // is exactly the behaviour under test, not a setup step.
    rows[0].querySelector('.name').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
    rows[1].querySelector('.name').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
    await new Promise((resolve) => setTimeout(resolve, 700))
    return {
      path: location.pathname,
      drawers: document.querySelectorAll('.preview-drawer').length,
      bar: (document.querySelector('.sel-bar') || {}).innerText || '',
    }
  })
  check('Ctrl+click never navigates', additive.path === '/', JSON.stringify(additive))
  check('Ctrl+click selects two rows', /已选择 2 项/.test(additive.bar), JSON.stringify(additive.bar))
  await page.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  await sleep(300)

  /* ── 7. the trash keeps selecting on a click ────────────────── */
  const trashed = await page.run(async () => {
    const token = localStorage.getItem('mdrive-token')
    const nodes = await fetch('/api/v1/nodes', { headers: { authorization: 'Bearer ' + token } }).then((r) => r.json())
    const file = nodes.nodes.find((node) => node.name === '说明.md')
    await fetch('/api/v1/nodes/' + file.id, { method: 'DELETE', headers: { authorization: 'Bearer ' + token } })
    history.pushState({}, '', '/trash')
    window.dispatchEvent(new PopStateEvent('popstate'))
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const row = document.querySelector('.frow[data-id]')
    if (!row) return { error: 'no trash row' }
    row.querySelector('.name').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 500))
    return { error: null, drawers: document.querySelectorAll('.preview-drawer').length, selected: row.dataset.selected }
  })
  check('a click in the trash selects, never previews', trashed.error === null && trashed.drawers === 0, JSON.stringify(trashed))
  check('the trash row paints as selected', trashed.selected === 'true', JSON.stringify(trashed))
  await page.shot('click-04-trash')

  check('no console errors', page.consoleErrors.length === 0, page.consoleErrors.slice(0, 3).join(' | '))
  check('no failed requests', page.failedRequests.length === 0, page.failedRequests.slice(0, 3).join(' | '))
}))
