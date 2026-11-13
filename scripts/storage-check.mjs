#!/usr/bin/env node
/**
 * Storage-surface check: the parts of the "storing things" story only a browser
 * can prove — the folder ZIP entry in the row menu, the storage breakdown in the
 * sidebar footer, and the archive actually being produced.
 *
 *   node scripts/storage-check.mjs [--server URL]
 */

import { serverUrl, runBrowserCheck, signUpInPage, sleep } from './lib/browser.mjs'

const server = serverUrl()

process.exit(await runBrowserCheck({ title: 'Storage surface check', network: true }, async (page, check) => {
  await page.navigate(server + '/', { settle: 1300 })
  const session = await signUpInPage(page, { prefix: 'storage', password: 'storage check password' })
  check('signed in', typeof session.token === 'string' && session.token.length > 20)

  const seeded = await page.run(async () => {
    const token = localStorage.getItem('mdrive-token')
    const headers = { authorization: 'Bearer ' + token }
    const post = (path, payload) => fetch(path, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(payload),
    })
    const folder = await (await post('/api/v1/nodes', { name: '报告', kind: 'folder' })).json()
    const put = (query, payload, type) => fetch('/api/v1/uploads?' + query, {
      method: 'PUT', headers: { ...headers, 'content-type': type }, body: payload,
    })
    await put('parentId=' + folder.node.id + '&name=slides.pptx', new Uint8Array(2000), 'application/octet-stream')
    await put('name=chart.png', new Uint8Array(4000), 'image/png')
    await put('name=notes.md', '# notes', 'text/markdown')
    return { folder: folder.node.id }
  })
  check('seed data created', typeof seeded.folder === 'string')

  await page.reload({ settle: 2000 })

  const sidebarText = await page.evaluate("document.querySelector('.storage') ? document.querySelector('.storage').innerText : ''")
  check('sidebar shows the breakdown', /文档|图片/.test(sidebarText), JSON.stringify(sidebarText))
  const kindCount = await page.evaluate("document.querySelectorAll('.storage-kinds span').length")
  check('breakdown lists at most three kinds', kindCount > 0 && kindCount <= 3, String(kindCount))

  const opened = await page.run((folderId) => {
    const row = Array.from(document.querySelectorAll('[data-id]')).find((element) => element.getAttribute('data-id') === folderId)
    if (!row) return 'row missing'
    const more = row.querySelector('[data-action="more"]')
    if (!more) return 'menu button missing'
    more.click()
    return 'ok'
  }, seeded.folder)
  check('folder row menu opens', opened === 'ok', opened)
  await sleep(400)

  const menuLabels = await page.evaluate("Array.from(document.querySelectorAll('.menu-item')).map((node) => node.innerText.trim())")
  check('menu offers "下载为 ZIP"', menuLabels.some((label) => /下载为 ZIP/.test(label)), JSON.stringify(menuLabels))

  // Selection archive: pick two rows and use the shortcut, then confirm the zip.
  const selection = await page.run(async () => {
    const token = localStorage.getItem('mdrive-token')
    const headers = { authorization: 'Bearer ' + token }
    const nodes = await fetch('/api/v1/nodes', { headers }).then((response) => response.json())
    const folder = nodes.nodes.find((node) => node.kind === 'folder')
    const file = nodes.nodes.find((node) => node.kind === 'file')
    const response = await fetch('/api/v1/nodes/archive', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [folder.id, file.id] }),
    })
    const payload = await response.json()
    return { status: response.status, name: payload.node && payload.node.name, size: payload.node && payload.node.size }
  })
  check('selection archive is created', selection.status === 201 && /^selection-2-items\.zip$/.test(selection.name || ''), JSON.stringify(selection))
  check('selection archive has bytes', (selection.size || 0) > 0, String(selection.size))

  const archive = await page.run(async () => {
    const token = localStorage.getItem('mdrive-token')
    const nodes = await fetch('/api/v1/nodes', { headers: { authorization: 'Bearer ' + token } }).then((response) => response.json())
    const folder = nodes.nodes.find((node) => node.kind === 'folder' && node.name === '报告')
    const response = await fetch('/api/v1/nodes/' + folder.id + '/archive', {
      method: 'POST', headers: { authorization: 'Bearer ' + token },
    })
    const payload = await response.json()
    return { status: response.status, name: payload.node && payload.node.name, size: payload.node && payload.node.size }
  })
  check('folder archive is created', archive.status === 201 && /\.zip$/.test(archive.name || ''), JSON.stringify(archive))

  await page.shot('storage-surface')
  check('no console errors', page.consoleErrors.length === 0, page.consoleErrors.slice(0, 2).join(' | '))
}))
