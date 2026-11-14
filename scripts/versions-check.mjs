#!/usr/bin/env node
/**
 * Version history check: the drawer a file with history shows, and the two
 * actions it offers. The button must not appear on a v1 file at all.
 *
 *   node scripts/versions-check.mjs [--server URL]
 */

import { flag, serverUrl, runBrowserCheck, signUpInPage, sleep } from './lib/browser.mjs'

const server = serverUrl()
const password = 'version check'

process.exit(await runBrowserCheck({ title: 'Version history check', network: false }, async (page, check) => {
  await page.navigate(server + '/?t=' + Date.now(), { settle: 1300 })

  const session = await signUpInPage(page, { prefix: 'ver', password })

  // Three writes to one node: two of them land in history.
  const seeded = await page.run(async (name) => {
    const token = localStorage.getItem('mdrive-token')
    const headers = { authorization: 'Bearer ' + token }
    const first = await fetch('/api/v1/uploads?name=' + encodeURIComponent(name), {
      method: 'PUT', headers: { ...headers, 'content-type': 'text/plain' }, body: 'first version',
    }).then((response) => response.json())
    for (const body of ['second version', 'third version']) {
      await fetch('/api/v1/files/' + first.node.id + '/content', {
        method: 'PUT', headers: { ...headers, 'content-type': 'text/plain' }, body,
      })
    }
    return { id: first.node.id }
  }, 'draft.txt')
  check('three versions written', typeof seeded.id === 'string', JSON.stringify(seeded))

  await page.navigate(server + '/?t=' + Date.now(), { settle: 2200 })
  await openRow(page, seeded.id)
  await sleep(1800)

  const footer = await visibleFooter(page)
  check('preview offers 历史版本', footer.some((text) => /历史版本/.test(text)), JSON.stringify(footer))

  await page.run(() => {
    const button = Array.from(document.querySelectorAll('.drawer-foot button')).find((node) => /历史版本/.test(node.innerText))
    if (button) button.click()
  })
  await sleep(1600)

  const rows = await page.evaluate("Array.from(document.querySelectorAll('.version-row')).map((r) => r.innerText.replace(/\\s+/g, ' ').trim())")
  check('history lists two older versions', rows.length === 2, JSON.stringify(rows))
  check('rows show v1 and v2', rows.some((text) => /v1/.test(text)) && rows.some((text) => /v2/.test(text)), JSON.stringify(rows))
  check('rows offer download and restore', rows.every((text) => /下载/.test(text) && /恢复/.test(text)), JSON.stringify(rows))

  // A file with no history must not advertise the button.
  await page.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  await sleep(500)
  const fresh = await page.run(async () => {
    const token = localStorage.getItem('mdrive-token')
    const response = await fetch('/api/v1/uploads?name=fresh.txt', {
      method: 'PUT', headers: { authorization: 'Bearer ' + token, 'content-type': 'text/plain' }, body: 'only one version',
    })
    return (await response.json()).node.id
  })
  await page.navigate(server + '/?t=' + Date.now(), { settle: 2000 })
  await openRow(page, fresh)
  await sleep(1500)

  const freshFooter = await visibleFooter(page)
  check('a v1 file does not offer 历史版本', !freshFooter.some((text) => /历史版本/.test(text)), JSON.stringify(freshFooter))
  await page.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  await sleep(400)

  await page.shot('versions')
  check('no console errors', page.consoleErrors.length === 0, page.consoleErrors.slice(0, 2).join(' | '))
  void session
}))

/**
 * The drawer's footer buttons that a person can actually see.
 *
 * `innerText` still returns the text of a `display:none` element, so a
 * "the button is gone" assertion written against it silently passes for a
 * button that is merely hidden — and would fail the moment a hidden-but-present
 * button is the correct design (it is here: the footer keeps the slot and toggles
 * visibility as you arrow between pictures).
 */
async function visibleFooter(page) {
  return page.run(() => Array.from(document.querySelectorAll('.drawer-foot button'))
    .filter((button) => button.offsetParent !== null && getComputedStyle(button).display !== 'none')
    .map((button) => button.textContent.replace(/\s+/g, ' ').trim()))
}

/** Clicks the row for one node id; a plain click opens the drawer (lib/row-action.js). */
async function openRow(page, nodeId) {
  return page.run((id) => {
    const row = Array.from(document.querySelectorAll('[data-id]')).find((element) => element.getAttribute('data-id') === id)
    if (row) row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return Boolean(row)
  }, nodeId)
}