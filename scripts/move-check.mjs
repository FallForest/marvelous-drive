#!/usr/bin/env node
/** Move dialog and shared executor regressions against a throwaway account.
 *   node scripts/move-check.mjs [--server URL]
 */
import { serverUrl, runBrowserCheck, signUpInPage, sleep } from './lib/browser.mjs'

const server = serverUrl()

process.exit(await runBrowserCheck({ title: 'Move interactions check', network: true }, async (page, check) => {
  await page.navigate(server + '/')
  const session = await signUpInPage(page, { prefix: 'move', password: 'move check password' })
  check('signed in', Boolean(session.token))
  const seeded = await page.run(async () => {
    const headers = { authorization: 'Bearer ' + localStorage.getItem('mdrive-token') }
    const folder = async (name, parentId = null) => {
      const response = await fetch('/api/v1/nodes', {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ name, kind: 'folder', parentId }),
      })
      if (!response.ok) throw new Error('folder seed failed: ' + name)
      return (await response.json()).node.id
    }
    const file = async (name, parentId, body) => {
      const response = await fetch('/api/v1/uploads?name=' + encodeURIComponent(name) + '&parentId=' + parentId, {
        method: 'PUT', headers: { ...headers, 'content-type': 'text/plain' }, body,
      })
      if (!response.ok) throw new Error('file seed failed: ' + name)
      return (await response.json()).node.id
    }
    const ids = { source: await folder('Source'), destination: await folder('Dest'), last: await folder('Zulu') }
    ids.deep = await folder('Deep', ids.destination)
    ids.branch = await folder('Branch', ids.source)
    ids.leaf = await folder('Leaf', ids.branch)
    ids.nested = await file('nested.txt', ids.leaf, 'nested content')
    ids.cancel = await file('cancel.txt', ids.source, 'cancel content')
    ids.root = await file('back-to-root.txt', ids.source, 'root content')
    ids.conflict = await file('clash.txt', ids.source, 'source content')
    ids.existing = await file('clash.txt', ids.destination, 'existing destination content')
    ids.success = await file('success.txt', ids.source, 'success content')
    return ids
  })
  await page.navigate(server + '/folder/' + seeded.source)
  await page.waitFor("document.querySelectorAll('.frow[data-id]').length === 5")
  await page.run(() => {
    const fetchOriginal = window.fetch.bind(window)
    window.__moveRequests = []
    window.fetch = (input, options) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href)
      if (options?.method?.toUpperCase() === 'PUT' && /^\/api\/v1\/nodes\/[^/]+$/.test(url.pathname)) {
        const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body
        if (body && Object.hasOwn(body, 'parentId')) window.__moveRequests.push({ id: url.pathname.split('/').pop(), parentId: body.parentId })
      }
      return fetchOriginal(input, options)
    }
  })

  const key = async (name, code, virtualKey) => {
    const params = { key: name, code, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey }
    const text = name === 'Enter' ? '\r' : name === ' ' ? ' ' : undefined
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...params, ...(text ? { text, unmodifiedText: text } : {}) })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
  }
  const snapshot = () => page.run(async () => (await (await fetch('/api/v1/nodes', {
    headers: { authorization: 'Bearer ' + localStorage.getItem('mdrive-token') },
  })).json()).nodes)
  const requestCount = () => page.evaluate('window.__moveRequests.length')
  const openMove = async (id, rightClick = false) => {
    await page.run((nodeId, contextMenu) => {
      const row = document.querySelector('.frow[data-id="' + nodeId + '"]')
      if (contextMenu) row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
      else row.querySelector('[aria-label="更多操作"]').click()
    }, id, rightClick)
    await page.waitFor("document.querySelector('.menu')")
    await page.run(() => Array.from(document.querySelectorAll('.menu-item')).find((item) => item.textContent.includes('移动到')).click())
    await page.waitFor("document.querySelector('.dialog:not(.is-closing) .move-list')")
    // Let the dialog's opening focus callbacks run before keyboard input.
    await page.run(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  }
  const choose = (id) => page.run((folderId) => document.querySelector('.dialog:not(.is-closing) .move-list [data-folder-id="' + (folderId || '') + '"]').click(), id)
  const closeDialog = async (method) => {
    if (method === 'Escape') await key('Escape', 'Escape', 27)
    else await page.run((way) => {
      const dialog = document.querySelector('.dialog:not(.is-closing)')
      if (way === 'close') dialog.querySelector('[aria-label="关闭对话框"]').click()
      else Array.from(dialog.querySelectorAll('.dialog-foot button')).find((button) => button.textContent === '取消').click()
    }, method)
    await page.waitFor("!document.querySelector('.dialog:not(.is-closing)')")
    await sleep(250)
  }
  const confirmMove = async () => {
    await page.run(() => document.querySelector('.dialog:not(.is-closing) .btn-primary').focus())
    await key('Enter', 'Enter', 13)
    await sleep(100)
    const state = await page.evaluate("({ open: Boolean(document.querySelector('.dialog:not(.is-closing)')), preview: Boolean(document.querySelector('.preview-drawer')), focused: document.activeElement?.outerHTML?.slice(0, 180) })")
    check('Enter confirms the chosen move destination', !state.open, JSON.stringify(state))
    // Continue observing the other move rules even if a keyboard regression
    // kept the dialog open; the failed assertion still makes this suite fail.
    if (state.open) await page.run(() => document.querySelector('.dialog:not(.is-closing) .btn-primary').click())
    await page.waitFor("!document.querySelector('.dialog:not(.is-closing)')")
  }

  for (const method of ['cancel', 'Escape', 'close']) {
    const before = await requestCount()
    await openMove(seeded.cancel, method === 'Escape')
    await choose(seeded.destination)
    await closeDialog(method)
    check(method + ' never sends a move request', await requestCount() === before)
    check(method + ' preserves the original parent', (await snapshot()).find((node) => node.id === seeded.cancel).parentId === seeded.source)
  }

  await openMove(seeded.branch)
  const blocked = await page.run((ids) => {
    const row = (id) => document.querySelector('.move-list [data-folder-id="' + id + '"]')
    return { current: row(ids.source).disabled, self: row(ids.branch).disabled, descendant: row(ids.leaf).disabled,
      root: row('').disabled, button: document.querySelector('.dialog .btn-primary').disabled }
  }, seeded)
  check('current location, self and descendants are disabled', blocked.current && blocked.self && blocked.descendant, JSON.stringify(blocked))
  check('the initial current location cannot be confirmed', blocked.button && !blocked.root, JSON.stringify(blocked))
  await choose(seeded.deep)
  check('the picker displays the full destination path', await page.evaluate("document.querySelector('.move-destination').textContent") === '目标：我的云盘 / Dest / Deep')
  await page.run(() => document.querySelector('.move-list [aria-selected="true"]').focus())
  const enabled = await page.evaluate("Array.from(document.querySelectorAll('.move-list button:not([disabled])')).map((row) => row.dataset.folderId)")
  const selected = () => page.evaluate("document.querySelector('.move-list [aria-selected=\"true\"]').dataset.folderId")
  await key('Home', 'Home', 36)
  check('Home selects the first enabled destination', await selected() === enabled[0])
  await key('ArrowDown', 'ArrowDown', 40)
  check('ArrowDown selects the next enabled destination', await selected() === enabled[1])
  await key('ArrowUp', 'ArrowUp', 38)
  check('ArrowUp selects the previous enabled destination', await selected() === enabled[0])
  await key('End', 'End', 35)
  const destination = enabled.at(-1)
  check('End selects the last enabled destination', await selected() === destination)
  await page.shot('move-01-picker')
  await confirmMove()
  await page.waitFor("!document.querySelector('.frow[data-id=\"" + seeded.branch + "\"]')")
  check('a keyboard-selected destination moves the folder', (await snapshot()).find((node) => node.id === seeded.branch).parentId === destination)

  await openMove(seeded.root, true)
  await choose(null)
  await confirmMove()
  await page.waitFor("!document.querySelector('.frow[data-id=\"" + seeded.root + "\"]')")
  check('a single file can move from a child folder to the drive root', (await snapshot()).find((node) => node.id === seeded.root).parentId === null)

  const beforeNested = await requestCount()
  await page.run(async (ids) => {
    const { moveItems } = await import('/lib/actions.js')
    const { store } = await import('/lib/session.js')
    store.state.selection = new Set([ids.branch, ids.leaf, ids.nested])
    await moveItems([ids.branch, ids.leaf, ids.nested], ids.destination)
  }, seeded)
  const tree = await snapshot()
  const byId = new Map(tree.map((node) => [node.id, node]))
  check('mixed ancestor and descendant selections move only the ancestor', await requestCount() === beforeNested + 1)
  check('moving an ancestor preserves the whole nested structure', byId.get(seeded.branch).parentId === seeded.destination && byId.get(seeded.leaf).parentId === seeded.branch && byId.get(seeded.nested).parentId === seeded.leaf)

  await page.run((ids) => {
    for (const id of [ids.conflict, ids.success]) document.querySelector('.frow[data-id="' + id + '"] .pick').click()
    Array.from(document.querySelectorAll('.sel-bar button')).find((button) => button.textContent.includes('移动到')).click()
  }, seeded)
  await page.waitFor("document.querySelector('.dialog:not(.is-closing) .move-list')")
  await page.run(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await choose(seeded.destination)
  await confirmMove()
  await page.waitFor("!document.querySelector('.frow[data-id=\"" + seeded.success + "\"]')")
  const afterConflict = await snapshot()
  check('a mixed batch moves its successful item and leaves the conflict in place', afterConflict.find((node) => node.id === seeded.success).parentId === seeded.destination && afterConflict.find((node) => node.id === seeded.conflict).parentId === seeded.source)
  const contents = await page.run(async (ids) => {
    const headers = { authorization: 'Bearer ' + localStorage.getItem('mdrive-token') }
    return Promise.all([ids.conflict, ids.existing].map((id) => fetch('/api/v1/files/' + id + '/content', { headers }).then((response) => response.text())))
  }, seeded)
  check('a name conflict never overwrites either file', contents[0] === 'source content' && contents[1] === 'existing destination content', JSON.stringify(contents))
  check('a failed item stays selected after partial success', await page.run((id) => document.querySelector('.frow[data-id="' + id + '"] .pick').checked, seeded.conflict))
  check('the conflict feedback explains why the file stayed', await page.evaluate("Array.from(document.querySelectorAll('.toast')).some((toast) => /重名/.test(toast.textContent))"))
  await page.shot('move-02-conflict')
  const unexpectedErrors = page.consoleErrors.filter((message) => !/409 \(Conflict\)/.test(message))
  check('no unexpected console errors', unexpectedErrors.length === 0, unexpectedErrors.slice(0, 3).join(' | '))
  check('no failed requests', page.failedRequests.length === 0, page.failedRequests.slice(0, 3).join(' | '))
}))
