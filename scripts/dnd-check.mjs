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
 * Synthetic events cover prohibited targets; native CDP mouse input covers
 * browser-generated thumbnail payloads and the complete move gesture.
 */

import { serverUrl, runBrowserCheck, signUpInPage, sleep } from './lib/browser.mjs'

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

  /* Native mouse drags catch browser-added image Files payloads, which a
     synthetic DataTransfer does not reproduce. Check the persisted tree too. */
  const native = await page.run(async () => {
    const headers = { authorization: 'Bearer ' + localStorage.getItem('mdrive-token') }
    const makeFolder = async (name, parentId = null) => (await (await fetch('/api/v1/nodes', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ name, kind: 'folder', parentId }),
    })).json()).node.id
    const upload = async (name, body, mime) => (await (await fetch('/api/v1/uploads?name=' + encodeURIComponent(name), {
      method: 'PUT', headers: { ...headers, 'content-type': mime }, body,
    })).json()).node.id
    const target = await makeFolder('原生拖放目标')
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zlc0AAAAASUVORK5CYII='), c => c.charCodeAt(0))
    return {
      target,
      picture: await upload('mouse-photo.png', png, 'image/png'),
      text: await upload('mouse-notes.txt', 'native drag', 'text/plain'),
      second: await upload('mouse-second.txt', 'second drag', 'text/plain'),
    }
  })
  await page.reload({ settle: 1400 })
  const row = (id) => '[data-id="' + id + '"]'
  const parentId = (id) => page.run(async (id) => {
    const response = await fetch('/api/v1/nodes', { headers: { authorization: 'Bearer ' + localStorage.getItem('mdrive-token') } })
    return (await response.json()).nodes.find(node => node.id === id)?.parentId
  }, id)

  async function mouseDrag(sourceSelector, targetSelector) {
    await page.waitFor('document.querySelector(' + JSON.stringify(sourceSelector) + ') && document.querySelector(' + JSON.stringify(targetSelector) + ')')
    const positions = await page.run((sourceSelector, targetSelector) => {
      window.lastNativeDrag = null
      window.nativeDropSeen = false
      document.addEventListener('dragstart', e => { window.lastNativeDrag = { trusted: e.isTrusted, types: [...e.dataTransfer.types] } }, { once: true })
      document.addEventListener('drop', () => { window.nativeDropSeen = true }, { capture: true, once: true })
      const center = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } }
      return { source: center(sourceSelector), target: center(targetSelector) }
    }, sourceSelector, targetSelector)
    const { source, target } = positions
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...source })
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...source, button: 'left', buttons: 1, clickCount: 1 })
    for (let step = 1; step <= 12; step++) {
      await page.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', button: 'left', buttons: 1,
        x: source.x + (target.x - source.x) * step / 12,
        y: source.y + (target.y - source.y) * step / 12,
      })
      await sleep(25)
    }
    // Allow Chromium to emit dragover after the last dragenter, including
    // narrow breadcrumb targets that are only reached by the final move.
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...target, button: 'left', buttons: 1 })
    await sleep(80)
    const hovered = await page.run((selector) => ({
      highlighted: document.querySelector(selector).closest('.frow,.gcard,.side-row,.crumb')?.classList.contains('is-drop-target'),
      overlay: Boolean(document.querySelector('.drop-overlay')),
      badge: document.querySelector('.drag-badge')?.textContent,
    }), targetSelector)
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...target, button: 'left', buttons: 0, clickCount: 1 })
    await sleep(650)
    return { ...hovered, ...await page.run(() => ({ ...window.lastNativeDrag, dropped: window.nativeDropSeen })) }
  }

  const textDrag = await mouseDrag(row(native.text) + ' .name', row(native.target) + ' .name')
  check('a real mouse drag moves a file into a list folder', textDrag.trusted && textDrag.dropped && await parentId(native.text) === native.target, JSON.stringify(textDrag))
  check('native hover shows the destination and highlights the folder', textDrag.highlighted && textDrag.badge.includes('原生拖放目标'), JSON.stringify(textDrag))

  await page.waitFor('document.querySelector(' + JSON.stringify(row(native.picture) + ' img') + ')')
  const pictureDrag = await mouseDrag(row(native.picture) + ' img', row(native.target) + ' .name')
  check('a real mouse drag from a thumbnail moves the original file', pictureDrag.trusted && pictureDrag.dropped && await parentId(native.picture) === native.target, JSON.stringify(pictureDrag))
  check('an internal picture drag never becomes an external upload', !pictureDrag.overlay && !pictureDrag.types.includes('Files'), JSON.stringify(pictureDrag))

  await page.run((target) => window.mdrive.navigate('/folder/' + target), native.target)
  await page.waitFor('document.querySelector(' + JSON.stringify(row(native.picture) + ' .name') + ')')
  await sleep(450)
  const rootDrag = await mouseDrag(row(native.picture) + ' .name', 'nav[aria-label="主导航"] .side-row')
  check('My Drive in the sidebar accepts a move back to root', rootDrag.dropped && await parentId(native.picture) === null, JSON.stringify(rootDrag))

  const crumbDrag = await mouseDrag(row(native.text) + ' .name', '.crumbs button.crumb')
  check('the root breadcrumb accepts a move out of the current folder', crumbDrag.dropped && await parentId(native.text) === null, JSON.stringify(crumbDrag))

  await page.run(() => { localStorage.setItem('mdrive-view', 'grid'); window.mdrive.navigate('/') })
  await page.reload({ settle: 1400 })
  await page.waitFor('document.querySelector(' + JSON.stringify(row(native.picture) + ' img') + ')')
  const gridDrag = await mouseDrag(row(native.picture) + ' img', row(native.target) + ' .gname')
  check('a real thumbnail drag works in grid view too', gridDrag.trusted && gridDrag.dropped && await parentId(native.picture) === native.target, JSON.stringify(gridDrag))

  // A selected group follows the dragged member and does not include neighbours.
  await page.run((ids) => { for (const id of ids) document.querySelector('[data-id="' + id + '"] .pick').click() }, [native.text, native.second])
  const multiDrag = await mouseDrag(row(native.text) + ' .gname', row(native.target) + ' .gname')
  check('dragging a selected file moves the selected group', multiDrag.dropped && await parentId(native.text) === native.target && await parentId(native.second) === native.target, JSON.stringify(multiDrag))
  check('the drag badge states how many items will move', multiDrag.badge.includes('2 项'), JSON.stringify(multiDrag))

  const cancelled = await page.run(async (targetId, otherId) => {
    const source = document.querySelector('[data-id="' + targetId + '"]')
    const target = document.querySelector('[data-id="' + otherId + '"]')
    window.mdrive.store.state.selection = new Set([targetId])
    const dt = new DataTransfer()
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
    await new Promise(resolve => setTimeout(resolve, 250))
    return { selected: window.mdrive.store.state.selection.has(targetId), moving: document.body.classList.contains('is-moving'), badge: document.querySelector('.drag-badge')?.classList.contains('is-on') }
  }, native.target, seeded.target)
  check('Escape preserves selection and cancels stale drag payloads', cancelled.selected && !cancelled.moving && !cancelled.badge && await parentId(native.target) === null, JSON.stringify(cancelled))
  await page.shot('dnd-02-native-grid')

  // A direct search URL starts with an empty module state, so its tree must be
  // loaded too; navigation from a drive page can hide a missing-tree bug.
  await page.navigate(server + '/search?q=mouse-second')
  await page.waitFor('document.querySelector(' + JSON.stringify(row(native.second) + ' .gname') + ')')
  await sleep(450)
  const searchDrag = await mouseDrag(row(native.second) + ' .gname', 'nav[aria-label="主导航"] .side-row')
  check('a directly loaded search result can be dragged to root', searchDrag.trusted && searchDrag.dropped && await parentId(native.second) === null, JSON.stringify(searchDrag))

  const mixed = await page.run(async (sourceId) => {
    const source = document.querySelector('[data-id="' + sourceId + '"]')
    const target = document.querySelector('.side-row.folder[title="原生拖放目标"]')
    const dt = new DataTransfer()
    dt.items.add(new File(['not an upload'], 'phantom.png', { type: 'image/png' }))
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt })
    target.dispatchEvent(over)
    const state = { accepted: over.defaultPrevented, files: dt.types.includes('Files'), overlay: Boolean(document.querySelector('.drop-overlay')) }
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
    source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
    await new Promise(resolve => setTimeout(resolve, 650))
    return state
  }, native.second)
  check('an internal node payload takes precedence over a mixed Files payload', mixed.files && mixed.accepted && !mixed.overlay && await parentId(native.second) === native.target, JSON.stringify(mixed))

  const leftTarget = await page.run((sourceId) => {
    const source = document.querySelector('[data-id="' + sourceId + '"]')
    const target = document.querySelector('nav[aria-label="主导航"] .side-row')
    const dt = new DataTransfer()
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
    document.querySelector('.section-head').dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
    const state = { targets: document.querySelectorAll('.is-drop-target').length, badge: document.querySelector('.drag-badge').textContent }
    source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
    return state
  }, native.second)
  check('leaving a folder clears its destination feedback', leftTarget.targets === 0 && !leftTarget.badge.includes('→'), JSON.stringify(leftTarget))

  check('no console errors', page.consoleErrors.length === 0, page.consoleErrors.slice(0, 3).join(' | '))
  check('no failed requests', page.failedRequests.length === 0, page.failedRequests.slice(0, 3).join(' | '))
}))
