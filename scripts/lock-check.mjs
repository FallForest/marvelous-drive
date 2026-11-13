#!/usr/bin/env node
/**
 * Edit-lock check: opening a file in the preview drawer claims the advisory
 * edit lock, a second window of the same account is told the lock moved, and
 * closing the drawer releases it.
 *
 * The lock itself is unit-tested in apps/server/test/locks.test.js. What only a
 * browser can prove is the client half: that the drawer claims on open, that the
 * banner appears for the superseded window, and that closing releases.
 *
 *   node scripts/lock-check.mjs [--server URL]
 */

import { serverUrl, runBrowserCheck, signUpInPage, sleep } from './lib/browser.mjs'

const server = serverUrl()

process.exit(await runBrowserCheck({ title: 'Edit lock check' }, async (page, check) => {
  await page.navigate(server + '/?t=' + Date.now(), { settle: 1300 })
  await signUpInPage(page, { prefix: 'lock', password: 'lock check password' })

  const node = await page.run(async () => {
    const token = localStorage.getItem('mdrive-token')
    const response = await fetch('/api/v1/uploads?name=' + encodeURIComponent('共享草稿.md'), {
      method: 'PUT',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'text/markdown' },
      body: '# 共享草稿\n\n两个窗口同时编辑。',
    })
    return (await response.json()).node.id
  })
  check('a file is seeded', typeof node === 'string', String(node))

  // A lock already held by another window of the SAME account. The drawer's own
  // claim then succeeds but reports supersededClient, which is the banner case.
  const seededLock = await page.run(async (nodeId) => {
    const token = localStorage.getItem('mdrive-token')
    const response = await fetch('/api/v1/nodes/' + nodeId + '/lock', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ client: 'tab-other-window' }),
    })
    return { status: response.status, payload: await response.json().catch(() => ({})) }
  }, node)
  check('an existing lock is claimed', seededLock.status === 200, JSON.stringify(seededLock))

  await page.reload({ settle: 2000 })
  await openRow(page, node)
  await sleep(1600)

  const banner = await page.evaluate("(document.querySelector('.lock-banner') || {}).innerText || ''")
  check('the drawer announces the lock it took over', /tab-other-window/.test(banner), JSON.stringify(banner))

  const held = await page.run(async (nodeId) => {
    const token = localStorage.getItem('mdrive-token')
    const response = await fetch('/api/v1/nodes/' + nodeId + '/lock', { headers: { authorization: 'Bearer ' + token } })
    return (await response.json()).lock
  }, node)
  check('the drawer now holds the lock', Boolean(held && held.client && held.client !== 'tab-other-window'), JSON.stringify(held))

  // Closing the drawer releases: the next reader must not inherit a stale lock.
  await page.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  await sleep(900)
  const released = await page.run(async (nodeId) => {
    const token = localStorage.getItem('mdrive-token')
    const response = await fetch('/api/v1/nodes/' + nodeId + '/lock', { headers: { authorization: 'Bearer ' + token } })
    return (await response.json()).lock
  }, node)
  check('closing the drawer releases the lock', released === null, JSON.stringify(released))

  await page.shot('lock')
  check('no console errors', page.consoleErrors.length === 0, page.consoleErrors.slice(0, 2).join(' | '))
}))

/** Double-clicks the row for one node id; the drawer opens from the list row. */
async function openRow(page, nodeId) {
  return page.run((id) => {
    const row = Array.from(document.querySelectorAll('[data-id]')).find((element) => element.getAttribute('data-id') === id)
    if (row) row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    return Boolean(row)
  }, nodeId)
}
