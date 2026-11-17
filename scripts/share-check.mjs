#!/usr/bin/env node
/** Anonymous public links, Unicode names and actual downloaded bytes. */
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { runBrowserCheck, serverUrl, sleep } from './lib/browser.mjs'

const server = serverUrl()
const downloadPath = resolve('.tmp/share-check-downloads-' + Date.now())
mkdirSync(downloadPath, { recursive: true })

process.exit(await runBrowserCheck({ title: 'Public share check', network: true }, async (page, check) => {
  const register = await fetch(server + '/api/v1/auth/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'public-share-' + Date.now() + '@example.com', password: 'public share check password' }),
  }).then((response) => response.json())
  const headers = { authorization: 'Bearer ' + register.token }
  const json = { ...headers, 'content-type': 'application/json' }
  const createShare = async (nodeId, permission = 'downloader', extra = {}) => {
    const response = await fetch(server + '/api/v1/nodes/' + nodeId + '/share', {
      method: 'POST', headers: json, body: JSON.stringify({ permission, ...extra }),
    })
    if (!response.ok) throw new Error('Could not create share: ' + await response.text())
    return (await response.json()).share
  }
  const upload = async (name, type, body, parentId) => {
    const query = new URLSearchParams({ name, ...(parentId ? { parentId } : {}) })
    const response = await fetch(server + '/api/v1/uploads?' + query, {
      method: 'PUT', headers: { ...headers, 'content-type': type }, body,
    })
    if (!response.ok) throw new Error('Could not upload fixture: ' + await response.text())
    return (await response.json()).node
  }
  const text = '中文分享预览与下载\nhello world\n'
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAO0lEQVRIiWM4EaFBU8QwakHEaBBpjKaiE6MZTWO0qDgxWppGjFY4J0arzIjRVoXGaMMrYrTpqDGoW9cAXmogTLbfJmgAAAAASUVORK5CYII=', 'base64')
  const note = await upload('中文说明😀.txt', 'text/plain', text)
  const picture = await upload('中文图片😀.png', 'image/png', png)
  const folder = (await (await fetch(server + '/api/v1/nodes', {
    method: 'POST', headers: json, body: JSON.stringify({ name: '共享资料😀', kind: 'folder' }),
  })).json()).node
  await upload('文件夹内说明.txt', 'text/plain', text, folder.id)
  const viewer = await createShare(picture.id, 'viewer')
  const downloader = await createShare(note.id, 'downloader', { password: '中文密码' })
  const bundle = await createShare(folder.id)
  // A generated one-entry OOXML package, containing a single text paragraph.
  const docx = Buffer.from('UEsDBBQAAAAIADpocF06A3mNhAAAAK8AAAARAAAAd29yZC9kb2N1bWVudC54bWxFzs0NwyAMBeBVUAaoox56QJQV2hUImASJPxkI6fYN6aGX78my9WTRuUm6BYyVHcHHwvtz2mrNHKDoDYMqt5QxnjubKKh6jrRCT2QyJY2luLgGD/d5fkBQLk5SdL4k8xmZBzSo8t0W7zR7Wes0sky4O+zMuqM2QgHjZEiX+fJXA/8X5RdQSwECFAAUAAAACAA6aHBdOgN5jYQAAACvAAAAEQAAAAAAAAAAAAAAgAEAAAAAd29yZC9kb2N1bWVudC54bWxQSwUGAAAAAAEAAQA/AAAAswAAAAAA', 'base64')
  const document = await upload('公开文档.docx', 'application/octet-stream', docx)
  const officeShare = await createShare(document.id, 'viewer')
  const wav = Buffer.alloc(44 + 1600)
  wav.write('RIFF', 0); wav.writeUInt32LE(1636, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
  wav.write('data', 36); wav.writeUInt32LE(1600, 40)
  const audio = await upload('共享声音.wav', 'audio/wav', wav)
  const audioShare = await createShare(audio.id, 'viewer')

  const downloads = []
  const completed = new Set()
  const progress = new Map()
  const previousHandler = page.onEvent.bind(page)
  page.onEvent = (message) => {
    if (message.method === 'Browser.downloadWillBegin') downloads.push(message.params)
    if (message.method === 'Browser.downloadProgress') progress.set(message.params.guid, message.params)
    if (message.method === 'Browser.downloadProgress' && message.params.state === 'completed') completed.add(message.params.guid)
    return previousHandler(message)
  }
  await page.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath, eventsEnabled: true })
  await page.navigate(server + '/s/' + viewer.token)
  await page.waitFor("document.querySelector('.public-actions button')")
  check('public page opens without an account', await page.evaluate("!localStorage.getItem('mdrive-token') && Boolean(document.querySelector('.public-card'))"))
  await page.run(() => [...document.querySelectorAll('.public-actions button')].find((button) => button.textContent.includes('在线预览')).click())
  await page.waitFor("document.querySelector('.public-card img')?.naturalWidth > 0", { timeout: 10000, label: 'Unicode image preview' })
  check('Unicode image preview decodes for an anonymous viewer', true)
  check('viewer offers no attachment download', !(await page.evaluate("Boolean(document.querySelector('.public-actions a[download]'))")))

  await page.navigate(server + '/s/' + downloader.token)
  await page.waitFor("document.querySelector('.public-card input[type=password]')")
  await page.run(() => {
    document.querySelector('.public-card input[type=password]').value = '中文密码'
    document.querySelector('.public-card form').requestSubmit()
  })
  await page.waitFor("[...document.querySelectorAll('.public-actions button')].some(button => button.textContent.includes('在线预览'))")
  await page.run(() => [...document.querySelectorAll('.public-actions button')].find((button) => button.textContent.includes('在线预览')).click())
  await page.waitFor("document.querySelector('.public-card .preview-text')", { timeout: 10000 })
  check('password remains valid for text preview', await page.evaluate("document.querySelector('.public-card .preview-text').textContent") === text)

  const waitDownload = async (filename) => {
    const started = Date.now()
    while (Date.now() - started < 12000) {
      const item = downloads.find((entry) => entry.suggestedFilename === filename && completed.has(entry.guid))
      if (item) return readFileSync(join(downloadPath, item.guid))
      await sleep(100)
    }
    throw new Error('Download did not complete: ' + filename + ' (' + JSON.stringify(downloads.map((entry) => ({ name: entry.suggestedFilename, progress: progress.get(entry.guid) }))) + ')')
  }
  // A DOM click has no user activation: Chrome can block the second download
  // as an unsolicited automatic download. Exercise the real pointer gesture.
  const clickDownload = async (label) => {
    const point = await page.run((text) => {
      const link = [...document.querySelectorAll('.public-actions a')].find((el) => el.textContent.includes(text))
      const rect = link.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    }, label)
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  }
  await clickDownload('下载文件')
  const savedText = await waitDownload(note.name)
  check('Unicode attachment saves the original name and bytes', savedText.toString('utf8') === text)

  await page.navigate(server + '/s/' + bundle.token)
  await page.waitFor("[...document.querySelectorAll('.public-card .public-file b')].some(el => el.textContent === '文件夹内说明.txt')")
  await page.run(() => [...document.querySelectorAll('.public-card .public-file')].find((el) => el.querySelector('b')?.textContent === '文件夹内说明.txt').click())
  await page.waitFor("document.querySelector('.public-card .preview-text')")
  check('a Chinese folder share previews its child', await page.evaluate("document.querySelector('.public-card .preview-text').textContent") === text)
  await clickDownload('ZIP')
  const archive = await waitDownload(folder.name + '.zip')
  check('Unicode folder ZIP downloads with real archive bytes', archive.subarray(0, 2).toString() === 'PK' && archive.length > 30)

  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await page.navigate(server + '/s/' + viewer.token)
  await page.waitFor("document.querySelector('.public-actions button')")
  const previewButton = await page.run(() => {
    const button = [...document.querySelectorAll('.public-actions button')].find((el) => el.textContent.includes('在线预览'))
    const rect = button.getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  })
  await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [previewButton] })
  await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await page.waitFor("document.querySelector('.public-card img')?.naturalWidth > 0")
  check('mobile touch opens the anonymous image preview', true)
  check('the mobile share stays inside the viewport', await page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
  await page.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 740, deviceScaleFactor: 1, mobile: true })
  const unlockedNote = await createShare(note.id)
  await page.navigate(server + '/s/' + unlockedNote.token)
  await page.waitFor("document.querySelector('.public-actions button')")
  check('download and preview actions wrap on a narrow phone', await page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
  await page.shot('public-share-unicode')

  await page.navigate(server + '/s/' + officeShare.token)
  await page.waitFor("document.querySelector('.public-actions button')")
  await page.run(() => [...document.querySelectorAll('.public-actions button')].find((button) => button.textContent.includes('在线预览')).click())
  await page.waitFor("document.querySelector('.public-card .office')")
  check('anonymous Office preview renders extracted document content', await page.evaluate("document.querySelector('.public-card .office').textContent.includes('Public Office preview fixture')"))
  await page.navigate(server + '/s/' + audioShare.token)
  await page.waitFor("document.querySelector('.public-actions button')")
  await page.run(() => [...document.querySelectorAll('.public-actions button')].find((button) => button.textContent.includes('在线预览')).click())
  await page.waitFor("document.querySelector('.public-card audio')?.readyState >= 1")
  check('anonymous audio preview loads through native media controls', await page.evaluate("document.querySelector('.public-card audio').controls && document.querySelector('.public-card audio').duration > 0"))
  check('no uncaught browser errors', page.consoleErrors.length === 0, page.consoleErrors.join(' | '))
  check('no failed browser requests', page.failedRequests.length === 0, page.failedRequests.join(' | '))
  page.onEvent = previousHandler
}))