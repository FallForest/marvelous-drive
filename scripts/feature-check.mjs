#!/usr/bin/env node
/**
 * Feature surface check: the parts of the 0.3/0.4 UI that only a real browser can
 * prove — thumbnails in the list, the batch selection bar (download / move /
 * delete), draggable rows, and the duplicates drawer.
 *
 *   node scripts/feature-check.mjs [--server URL]
 */

import { serverUrl, runBrowserCheck, sleep } from './lib/browser.mjs'

const server = serverUrl()

process.exit(await runBrowserCheck({ title: 'Feature surface check' }, async (page, check) => {
  await page.navigate(server + '/?t=' + Date.now(), { settle: 1300 })

  const seeded = await page.run(async () => {
    const email = 'v2-' + Date.now() + '@example.com'
    const body = JSON.stringify({ email, password: 'feature check' })
    const json = { 'content-type': 'application/json' }
    await fetch('/api/v1/auth/register', { method: 'POST', headers: json, body })
    const login = await fetch('/api/v1/auth/login', { method: 'POST', headers: json, body }).then((r) => r.json())
    const headers = { authorization: 'Bearer ' + login.token }
    const post = (path, payload) => fetch(path, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(payload),
    }).then((r) => r.json())
    const folder = await post('/api/v1/nodes', { name: '目标', kind: 'folder' })
    // A 1x1 PNG: the smallest thing the server will accept as an image thumbnail.
    const png = Uint8Array.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0x0d,0x49,0x48,0x44,0x52,0,0,0,1,0,0,0,1,8,6,0,0,0,0x1f,0x15,0xc4,0x89,0,0,0,0x0a,0x49,0x44,0x41,0x54,0x78,0x9c,0x63,0,1,0,0,5,0,1,0x0d,0x0a,0x2d,0xb4,0,0,0,0,0x49,0x45,0x4e,0x44,0xae,0x42,0x60,0x82])
    const put = (name, type, payload) => fetch('/api/v1/uploads?name=' + encodeURIComponent(name), {
      method: 'PUT', headers: { ...headers, 'content-type': type }, body: payload,
    })
    await put('shot.png', 'image/png', png)
    await put('dupA.txt', 'text/plain', 'identical content')
    await put('dupB.txt', 'text/plain', 'identical content')
    localStorage.setItem('mdrive-token', login.token)
    return { folder: folder.node.id }
  })
  check('seed data created', typeof seeded.folder === 'string', JSON.stringify(seeded))

  await page.navigate(server + '/?t=' + Date.now(), { settle: 2200 })

  const rows = await page.evaluate("document.querySelectorAll('[data-id]').length")
  check('rows rendered', rows >= 3, String(rows))

  const thumbs = await page.evaluate("document.querySelectorAll('.thumb, .row-thumb, .frow img').length")
  check('image row shows a thumbnail', thumbs >= 1, String(thumbs))

  await page.run(() => {
    const items = Array.from(document.querySelectorAll('[data-id]'))
    items[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    items[1].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
  })
  await sleep(400)

  const bar = await page.evaluate("(document.querySelector('.sel-bar') || {}).innerText || ''")
  check('selection bar appears', /已选择 2 项/.test(bar), JSON.stringify(bar))
  check('batch move button present', /移动/.test(bar), JSON.stringify(bar))

  const draggable = await page.evaluate("Array.from(document.querySelectorAll('[data-id]')).filter((n) => n.getAttribute('draggable') === 'true').length")
  check('rows are draggable', draggable >= 3, String(draggable))

  await page.evaluate("(function () { const b = document.querySelector('[aria-label=\"账号菜单\"]'); if (b) b.click(); })()")
  await sleep(400)
  const menu = await page.evaluate("Array.from(document.querySelectorAll('.menu-item')).map((n) => n.innerText.trim())")
  check('user menu offers 重复文件', menu.some((label) => /重复文件/.test(label)), JSON.stringify(menu))

  await page.run(() => {
    const item = Array.from(document.querySelectorAll('.menu-item')).find((n) => /重复文件/.test(n.innerText))
    if (item) item.click()
  })
  await sleep(1800)

  const dup = await page.evaluate("(document.querySelector('.drawer') || {}).innerText || 'missing'")
  check('duplicates drawer lists the pair', /dupA|dupB|重复/.test(dup), JSON.stringify(dup.slice(0, 140)))

  await page.shot('duplicates')
  check('no console errors', page.consoleErrors.length === 0, page.consoleErrors.slice(0, 2).join(' | '))
}))
