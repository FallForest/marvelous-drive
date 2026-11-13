#!/usr/bin/env node
/**
 * Headless browser check for the web client.
 *
 *   node scripts/browser-check.mjs [--server http://127.0.0.1:4400]
 *
 * Launches Chrome over the DevTools protocol, drives the real page, and fails on
 * any console error, failed request, or missing UI state. Screenshots land in
 * .tmp/shots/ so a regression can be looked at instead of guessed about.
 */

import { serverUrl, runBrowserCheck, sleep } from './lib/browser.mjs'

const server = serverUrl()
const markdownBody = ['# 说明', '', '这是浏览器检查写入的文件。', ''].join('\n')

process.exit(await runBrowserCheck({ title: 'Marvelous Drive browser check', network: true }, async (page, check) => {
  await page.navigate(server + '/', { settle: 1200 })

  check('page loads', await page.evaluate('/Marvelous Drive/.test(document.title)'), await page.evaluate('document.title'))
  check('login form is rendered', await page.evaluate("Boolean(document.querySelector('input[type=email], input[name=email], input'))"))
  await page.shot('01-login')

  const email = 'browser-' + Date.now() + '@example.com'
  const password = 'browser check password'
  const seeded = await page.run(async (emailAddress, secretWord, markdown) => {
    const post = (path, body, token) => fetch(path, {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
      body: JSON.stringify(body),
    })
    const registered = await post('/api/v1/auth/register', { email: emailAddress, password: secretWord, name: 'Browser Check' })
    if (registered.status !== 201) return { error: 'register ' + registered.status }
    const login = await (await post('/api/v1/auth/login', { email: emailAddress, password: secretWord })).json()
    const token = login.token
    const folder = await (await post('/api/v1/nodes', { name: '项目资料', kind: 'folder' }, token)).json()
    const putFile = (query, name, type, body) => fetch('/api/v1/uploads?' + query + '&name=' + encodeURIComponent(name), {
      method: 'PUT',
      headers: { authorization: 'Bearer ' + token, 'content-type': type },
      body,
    })
    const first = await putFile('', '说明.md', 'text/markdown', markdown)
    const second = await putFile('parentId=' + folder.node.id, 'photo.svg', 'image/svg+xml',
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#b8472e"/></svg>')
    localStorage.setItem('mdrive-token', token)
    return { folder: folder.node.id, markdown: first.status, svg: second.status }
  }, email, password, markdownBody)
  check('seed data created through the real API', seeded.markdown === 201 && seeded.svg === 201, JSON.stringify(seeded))

  await page.reload({ settle: 1600 })
  await page.waitFor("document.querySelectorAll('[data-id]').length >= 2", { label: 'file rows' })

  const rowCount = await page.evaluate("document.querySelectorAll('[data-id]').length")
  check('drive lists the seeded nodes', rowCount === 2, String(rowCount))
  check('folder and file are both rendered', await page.evaluate("document.body.innerText.includes('项目资料') && document.body.innerText.includes('说明.md')"))
  await page.shot('02-drive')

  const opened = await page.run(() => {
    const row = Array.from(document.querySelectorAll('[data-id]')).find((node) => node.innerText.includes('说明.md'))
    if (!row) return false
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    return true
  })
  check('a file row can be opened', opened)
  await sleep(1400)

  const previewText = await page.evaluate('document.body.innerText')
  check('preview shows the markdown body', previewText.includes('这是浏览器检查写入的文件'), previewText.slice(0, 160))
  await page.shot('03-preview')

  await page.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) ")
  await sleep(500)

  const trash = await page.run(() => {
    const link = Array.from(document.querySelectorAll('a, button')).find((node) => /回收站|Trash/.test(node.textContent || ''))
    if (!link) return 'missing'
    link.click()
    return 'clicked'
  })
  check('trash is reachable from the shell', trash === 'clicked', trash)
  await sleep(1000)
  await page.shot('04-trash')

  await page.run((folderId) => {
    history.pushState({}, '', '/folder/' + folderId)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, seeded.folder)
  await sleep(1100)
  check('folder route renders its children', await page.evaluate("document.body.innerText.includes('photo.svg')"), await page.evaluate('location.pathname'))
  await page.shot('05-folder')

  const shareUrl = await page.run(async () => {
    const token = localStorage.getItem('mdrive-token')
    const nodes = await fetch('/api/v1/nodes', { headers: { authorization: 'Bearer ' + token } }).then((r) => r.json())
    const file = nodes.nodes.find((node) => node.name === '说明.md')
    const share = await fetch('/api/v1/nodes/' + file.id + '/share', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ permission: 'downloader' }),
    }).then((r) => r.json())
    return share.share.url
  })
  check('share link created', typeof shareUrl === 'string' && shareUrl.includes('/s/'), String(shareUrl))

  const sharePageUrl = /^https?:\/\//.test(shareUrl) ? shareUrl : server + shareUrl
  await page.navigate(sharePageUrl, { settle: 1600 })
  const shareText = await page.evaluate('document.body.innerText')
  check('public share page names the file', shareText.includes('说明.md'), shareText.slice(0, 160))
  check('public share page offers a download', /下载|Download/.test(shareText))
  await page.shot('06-share')

  // The Docs bridge was removed; there is no panel to drive any more. The
  // removal is covered by apps/server/test/docs-removal.test.js.

  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await sleep(800)
  const overflow = await page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
  check('mobile layout does not scroll sideways', overflow <= 1, 'overflow ' + overflow + 'px')
  await page.shot('07-mobile')

  check('no console errors', page.consoleErrors.length === 0, page.consoleErrors.slice(0, 3).join(' | '))
  check('no failed requests', page.failedRequests.length === 0, page.failedRequests.slice(0, 3).join(' | '))
}))
