#!/usr/bin/env node
/**
 * Drag-and-drop check: the gesture that had silently stopped working.
 *
 *   node scripts/dnd-check.mjs [--server URL]
 *
 * A folder could not be dropped onto another folder in the main list. The
 * cause was not the drag: the rows had lost their drop handlers when the list
 * context was split out of app.js, while the sidebar (which reads the context
 * directly) kept working — so the feature looked "half broken" and no test
 * covered the half that was gone.
 *
 * These assertions drive the DnD events the browser would emit, because CDP's
 * synthetic mouse drag does not produce real dragover/drop.
 */

import { serverUrl, runBrowserCheck, signUpInPage } from './lib/browser.mjs'

const server = serverUrl()

process.exit(await runBrowserCheck({ title: 'Drag and drop check', viewport: { width: 1440, height: 900 } }, async (page, check) => {
  await page.navigate(server + '/?t=' + Date.now(), { settle: 1200 })
  const session = await signUpInPage(page, { prefix: 'dnd', password: 'dnd check password' })
  check('signed in', typeof session.token === 'string' && session.token.length > 20)

  const seeded = await page.run(async () => {
    const token = localStorage.getItem('mdrive-token')
    const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' }
    const make = async (name) => (await (await fetch('/api/v1/nodes', {
      method: 'POST', headers, body: JSON.stringify({ name, kind: 'folder' }),
    })).json()).node.id
    return { target: await make('目标文件夹'), source: await make('要移动的'), third: await make('另一个') }
  })
  check('three folders seeded', typeof seeded.target === 'string', JSON.stringify(seeded))

  await page.reload({ ignoreCache: true, settle: 1800 })
  await page.waitFor("document.querySelectorAll('.frow[data-id]').length === 3", { label: 'the three rows' })

  /** Drags a row onto a folder row; returns what the drop target did. */
  const dragOnto = (sourceName, targetName) => page.run(async (from, to) => {
    const rows = Array.from(document.querySelectorAll('.frow[data-id]'))
    const byName = (name) => rows.find((row) => (row.querySelector('.name') || {}).textContent === name)
    const source = byName(from)
    const target = byName(to)
    if (!source || !target) return { error: 'row missing' }

    const dt = new DataTransfer()
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
    const payload = dt.getData('application/x-mdrive-node')
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt })
    target.dispatchEvent(over)
    const state = {
      error: null,
      payload,
      accepted: over.defaultPrevented,
      highlighted: target.classList.contains('is-drop-target'),
    }
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
    source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
    await new Promise((resolve) => setTimeout(resolve, 1600))
    return state
  }, sourceName, targetName)

  const parentOf = (name) => page.run(async (wanted) => {
    const token = localStorage.getItem('mdrive-token')
    const nodes = await fetch('/api/v1/nodes', { headers: { authorization: 'Bearer ' + token } }).then((r) => r.json())
    const node = nodes.nodes.find((entry) => entry.name === wanted)
    const parent = node && node.parentId ? nodes.nodes.find((entry) => entry.id === node.parentId) : null
    return parent ? parent.name : null
  }, name)

  /* ── 1. the gesture works at all ─────────────────────────────── */
  const dropped = await dragOnto('要移动的', '目标文件夹')
  check('the dragged row carries its id', Boolean(dropped.payload), JSON.stringify(dropped))
  check('the folder row accepts the drop', dropped.accepted === true, JSON.stringify(dropped))
  check('the folder row highlights while hovered', dropped.highlighted === true, JSON.stringify(dropped))
  // effectAllowed / dropEffect are deliberately NOT asserted: a synthetic
  // DataTransfer collapses both to "none" no matter what the handler set, so
  // the assertion would measure the harness. What the user cares about — the
  // folder actually moved — is asserted on the next line against the server.
  check('the folder really moved into the target', await parentOf('要移动的') === '目标文件夹', String(await parentOf('要移动的')))
  await page.shot('dnd-01-moved')

  /* ── 2. an illegal target refuses, and says why ───────────────── */
  const illegal = await page.run(async () => {
    // Re-read: the tree changed, so the rows did too.
    const rows = Array.from(document.querySelectorAll('.frow[data-id]'))
    const source = rows.find((row) => (row.querySelector('.name') || {}).textContent === '目标文件夹')
    if (!source) return { error: 'row missing' }
    const dt = new DataTransfer()
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt })
    source.dispatchEvent(over)
    const state = { accepted: over.defaultPrevented, highlighted: source.classList.contains('is-drop-target'), effect: dt.dropEffect }
    source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
    return state
  })
  check('a folder cannot be dropped onto itself', illegal.accepted === false, JSON.stringify(illegal))
  check('a refused target shows no highlight', illegal.highlighted === false, JSON.stringify(illegal))

  /* ── 3. drag end always clears the drag state ─────────────────── */
  const cleaned = await page.run(() => ({
    moving: document.body.classList.contains('is-moving'),
    targets: document.querySelectorAll('.is-drop-target').length,
  }))
  check('finishing a drag clears the whole drag state', cleaned.moving === false && cleaned.targets === 0, JSON.stringify(cleaned))

  /* ── 4. a file row is NOT a drop target ───────────────────────── */
  const fileRow = await page.run(async () => {
    const token = localStorage.getItem('mdrive-token')
    const response = await fetch('/api/v1/uploads?name=notes.txt', {
      method: 'PUT', headers: { authorization: 'Bearer ' + token, 'content-type': 'text/plain' }, body: 'x',
    })
    await response.json()
    return true
  })
  void fileRow
  await page.reload({ ignoreCache: true, settle: 1800 })
  const ontoFile = await dragOnto('另一个', 'notes.txt')
  check('a file row refuses a node dropped on it', ontoFile.accepted === false, JSON.stringify(ontoFile))
  check('the refused file row is not highlighted', ontoFile.highlighted === false, JSON.stringify(ontoFile))

  /* ── 5. the sidebar is still a drop target ────────────────────── */
  const sidebar = await page.run(async () => {
    const rows = Array.from(document.querySelectorAll('.frow[data-id]'))
    const source = rows.find((row) => (row.querySelector('.name') || {}).textContent === '另一个')
    const sidebarRow = Array.from(document.querySelectorAll('.side-row.folder'))
      .find((row) => /目标文件夹/.test(row.textContent || ''))
    if (!source || !sidebarRow) return { error: 'missing' }
    const dt = new DataTransfer()
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt })
    sidebarRow.dispatchEvent(over)
    const state = { accepted: over.defaultPrevented }
    sidebarRow.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
    await new Promise((resolve) => setTimeout(resolve, 1600))
    return state
  })
  check('the sidebar folder still accepts a drop', sidebar.accepted === true, JSON.stringify(sidebar))

  check('no console errors', page.consoleErrors.length === 0, page.consoleErrors.slice(0, 3).join(' | '))
  check('no failed requests', page.failedRequests.length === 0, page.failedRequests.slice(0, 3).join(' | '))
}))
