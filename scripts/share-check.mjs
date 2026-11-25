#!/usr/bin/env node
/** Anonymous public links, Unicode names and actual downloaded bytes — plus the
 *  owner's in-place edit of an existing link from both management surfaces, the
 *  two share-list filters, and the revoke/restore paths that keep them honest.
 *
 *  With no --server (and no MDRIVE_SERVER) it boots this checkout's own server on
 *  an ephemeral port with a throwaway data directory, so the check never reads or
 *  writes the checkout's data/drive.db. That instance is pinned to DRIVE_STORAGE=local:
 *  a temp database alone does not isolate blob bytes, so without this an ambient
 *  object-store configuration would send the upload fixtures to a remote bucket. */
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { startServer } from '../apps/server/test/helpers.js'
import { runBrowserCheck, serverUrl, sleep } from './lib/browser.mjs'

const explicit = process.argv.includes('--server') || Boolean(process.env.MDRIVE_SERVER)
// Before the server module resolves its configuration: the temporary instance must
// keep fixture bytes on this machine, next to its throwaway database.
if (!explicit) process.env.DRIVE_STORAGE = 'local'
const temporary = explicit ? null : await startServer()
const server = temporary ? new URL('http://127.0.0.1:' + temporary.port).origin : serverUrl()
const downloadPath = resolve('.tmp/share-check-downloads-' + Date.now())
mkdirSync(downloadPath, { recursive: true })

// A public file is read in the full-viewport reader (a drawer appended to
// <body>), no longer inside the 476px .public-card. These helpers locate the
// preview in either surface, so an assertion still passes if a format ever
// renders in the card again; the card keeps the actions and the folder rows.
const inPreview = (selector) => `((document.querySelector('.shared-reader') || document.querySelector('.public-card')).querySelector(${JSON.stringify(selector)}))`

const code = await runBrowserCheck({ title: 'Public share check', network: true }, async (page, check) => {
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
  // Public ZIPs fall back to the attachment anchor where the save picker is
  // missing: hide it in every document so the native download event is the one
  // under test. (The picker-enabled managed ZIP is covered by its own check.)
  await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true })",
  })
  // The reader is a modal: its scrim covers the page, so anything under it (the
  // ZIP action, a folder row) is unreachable until the visitor closes it. Click
  // the header's close button, as a mouse user would, and wait for the panel.
  // The reader's close button carries the accessible name "关闭"; find it by
  // that, not by its position in the header, which now also holds a download.
  const closeReader = async () => {
    await page.run(() => document.querySelector('.shared-reader [aria-label="关闭"]').click())
    await page.waitFor("!document.querySelector('.shared-reader')")
  }
  await page.navigate(server + '/s/' + viewer.token)
  await page.waitFor("document.querySelector('.public-actions button')")
  check('public page opens without an account', await page.evaluate("!localStorage.getItem('mdrive-token') && Boolean(document.querySelector('.public-card'))"))
  await page.run(() => [...document.querySelectorAll('.public-actions button')].find((button) => button.textContent.includes('在线预览')).click())
  await page.waitFor(inPreview('img') + '?.naturalWidth > 0', { timeout: 10000, label: 'Unicode image preview' })
  check('Unicode image preview decodes for an anonymous viewer', true)
  check('viewer offers no attachment download', !(await page.evaluate("Boolean(document.querySelector('.public-actions a[download]'))")))
  // The reader is a full-viewport panel, not a sliver in the 476px card, and it
  // carries a visible close button and the file name. It must not overflow the
  // window, which is what a 100vw panel over a scrollbar used to do.
  check('the reader fills the viewport with its own close and file name', await page.evaluate(`(() => {
    const panel = document.querySelector('.shared-reader')
    if (!panel) return false
    const rect = panel.getBoundingClientRect()
    const close = panel.querySelector('.drawer-head .icon-btn')
    const closeRect = close && close.getBoundingClientRect()
    const name = panel.querySelector('.drawer-head .title-text')
    return rect.width >= innerWidth - 1 && rect.height >= innerHeight - 1
      && Boolean(closeRect) && closeRect.width >= 24 && closeRect.right <= innerWidth
      && Boolean(name) && name.textContent.length > 0
  })()`))
  check('the reader does not add horizontal overflow', await page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
  // The attachment moved into the reader header, so a viewer must not find one
  // in the modal either: the server would answer 403.
  check('the reader offers no download to a viewer', await page.evaluate("!document.querySelector('.shared-reader a[download]')"))

  await page.navigate(server + '/s/' + downloader.token)
  await page.waitFor("document.querySelector('.public-card input[type=password]')")
  await page.run(() => {
    document.querySelector('.public-card input[type=password]').value = '中文密码'
    document.querySelector('.public-card form').requestSubmit()
  })
  await page.waitFor("[...document.querySelectorAll('.public-actions button')].some(button => button.textContent.includes('在线预览'))")
  await page.run(() => [...document.querySelectorAll('.public-actions button')].find((button) => button.textContent.includes('在线预览')).click())
  await page.waitFor(inPreview('.preview-text'), { timeout: 10000 })
  check('password remains valid for text preview', await page.evaluate(inPreview('.preview-text') + '.textContent') === text)

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
      // A downloader reading a file gets its attachment in the reader header,
      // which is a modal over the card: reach the link there when the reader is
      // open, and fall back to the card's actions when it is not.
      const reader = document.querySelector('.shared-reader')
      const selector = reader ? '.shared-reader a[download]' : '.public-actions a'
      const link = [...document.querySelectorAll(selector)].find((el) => el.textContent.includes(text))
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
  await page.waitFor(inPreview('.preview-text'))
  check('a Chinese folder share previews its child', await page.evaluate(inPreview('.preview-text') + '.textContent') === text)
  // The reader is a modal over the page: close it before reaching for the ZIP
  // action underneath, which is what a visitor does too.
  await closeReader()
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
  await page.waitFor(inPreview('img') + '?.naturalWidth > 0')
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
  await page.waitFor(inPreview('.office'))
  check('anonymous Office preview renders extracted document content', await page.evaluate(inPreview('.office') + '.textContent.includes(\'Public Office preview fixture\')'))
  await page.navigate(server + '/s/' + audioShare.token)
  await page.waitFor("document.querySelector('.public-actions button')")
  await page.run(() => [...document.querySelectorAll('.public-actions button')].find((button) => button.textContent.includes('在线预览')).click())
  await page.waitFor(inPreview('audio') + '?.readyState >= 1')
  check('anonymous audio preview loads through native media controls', await page.evaluate(inPreview('audio') + '.controls && ' + inPreview('audio') + '.duration > 0'))

  /* ── in-place editing of an existing link, from both surfaces ──
   *
   * The point of every assertion below is that the edit is an edit: the URL the
   * owner already handed out keeps resolving, the row reloads from the server,
   * a cancelled dialog sends no PATCH, and a changed restriction is live for the
   * very next anonymous request.
   */
  // Back to a desktop viewport first: the edit dialog and the 我分享的 row are
  // desktop-shaped, and a leftover 320px emulation would test the phone layout
  // by accident instead of on purpose.
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false })
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: false })

  // The owner is "signed in" by placing the token where the client reads it, then
  // reloading so the shell boots with a session.
  await page.navigate(server + '/', { settle: 400 })
  await page.run((value) => localStorage.setItem('mdrive-token', value), register.token)

  // A link this test will edit: downloadable, password-protected and capped, so
  // the edit has something of every kind to change.
  const editable = await createShare(note.id, 'downloader', { password: '编辑前的密码', maxDownloads: 2 })
  // The link starts locked: without its password the recipient gets 401. The
  // edit below removes that password, so this is the "before" half of the proof
  // that a password change takes effect on the next request, not on a new link.
  const beforeEdit = await fetch(server + '/api/v1/shared/' + editable.token)
  check('the link to be edited starts password-protected', beforeEdit.status === 401, String(beforeEdit.status))

  /* ── entry 1: 我分享的 ───────────────────────────────────────── */
  await page.navigate(server + '/shares', { settle: 1400 })
  await page.waitFor("document.querySelector('.share-row[data-id]')")
  const shareRow = await page.run((id) => {
    const row = document.querySelector('.share-row[data-id="' + id + '"]')
    if (!row) return null
    const edit = row.querySelector('.share-edit')
    return {
      hasEdit: Boolean(edit),
      label: edit ? (edit.getAttribute('aria-label') || '') : '',
      text: edit ? edit.textContent.trim() : '',
      actions: [...row.querySelectorAll('.share-row-actions button')].map((button) => button.textContent.trim()),
    }
  }, editable.id)
  check('the 我分享的 row offers 编辑 beside copy, open and revoke',
    Boolean(shareRow) && shareRow.hasEdit && shareRow.text.includes('编辑')
      && shareRow.actions.some((label) => label.includes('复制'))
      && shareRow.actions.some((label) => label.includes('撤销')), JSON.stringify(shareRow))
  check('the 编辑 control is named for the link it edits',
    Boolean(shareRow) && /编辑链接设置/.test(shareRow.label), JSON.stringify(shareRow))

  // Count the PATCHes the page sends, so "cancel sends nothing" is observable
  // rather than assumed, and a double submit would be visible too.
  await page.run(() => {
    window.__patches = []
    const next = window.fetch.bind(window)
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : String(input && input.url)
      if (init && String(init.method || '').toUpperCase() === 'PATCH') {
        window.__patches.push({ url, body: init.body })
      }
      return next(input, init)
    }
    window.__restorePatchCounter = () => { window.fetch = next }
  })

  await page.run((id) => document.querySelector('.share-row[data-id="' + id + '"] .share-edit').click(), editable.id)
  // Every lookup below is scoped to the *live* editor. A closing overlay plays
  // its exit before it unmounts (140ms), so a bare `.share-edit-dialog` query can
  // address the previous instance — which is exactly the kind of stale-read bug
  // this check exists to catch in the page, so it must not have one itself.
  const liveEditor = "document.querySelector('.share-edit-dialog:not(.is-closing)')"
  await page.waitFor(liveEditor)
  const editorState = await page.run(() => {
    const panel = document.querySelector('.share-edit-dialog:not(.is-closing)')
    const text = panel ? panel.textContent || '' : ''
    const url = panel.querySelector('.share-edit-url code')
    const state = panel.querySelector('.share-edit-state')
    return {
      title: (panel.querySelector('h2') || {}).textContent || '',
      url: url ? url.textContent : '',
      state: state ? state.textContent : '',
      facts: (panel.querySelector('.share-edit-facts') || {}).textContent || '',
      // The current password must not be anywhere in the DOM, in any form.
      hasOldPassword: text.includes('编辑前的密码'),
      passwordFieldHidden: Boolean(panel.querySelector('[data-share-edit="password"]')?.closest('[hidden]')),
      usage: (panel.querySelector('.share-edit-usage') || {}).textContent || '',
      cap: (panel.querySelector('[data-share-edit="cap"]') || {}).value || '',
      permissionLabel: (panel.querySelector('[data-share-edit="permission"]') || {}).textContent || '',
      expiryLabel: (panel.querySelector('[data-share-edit="expiry"]') || {}).textContent || '',
    }
  })
  check('the edit dialog shows the live settings of this link',
    editorState.url.endsWith('/s/' + editable.token) && editorState.state === '有效'
      && /带密码/.test(editorState.facts) && /已下载 0\/2 次/.test(editorState.facts), JSON.stringify(editorState))
  check('the download usage and cap are both on screen',
    /已被下载 0 次，上限 2 次/.test(editorState.usage) && editorState.cap === '2', JSON.stringify(editorState))
  check('the current password is never shown or seeded into the form',
    editorState.hasOldPassword === false && editorState.passwordFieldHidden === true, JSON.stringify(editorState))

  // Typing must reach the model, not just the DOM. This is the bug the dialog
  // used to have: the cap was seeded once and never bound, so a typed value was
  // silently dropped and the save reported "nothing changed".
  const typedCap = await page.run(() => {
    const panel = document.querySelector('.share-edit-dialog:not(.is-closing)')
    const input = panel.querySelector('[data-share-edit="cap"]')
    input.value = '6'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return (panel.querySelector('.share-edit-usage') || {}).textContent || ''
  })
  check('a typed cap updates the usage sentence immediately', /上限 6 次/.test(typedCap), typedCap)
  // Put it back so the cancel check below still proves "no PATCH", and the real
  // edit starts from the stored 2.
  await page.run(() => {
    const input = document.querySelector('.share-edit-dialog:not(.is-closing) [data-share-edit="cap"]')
    input.value = '2'
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })

  // Cancel: nothing may leave the page.
  await page.run(() => [...document.querySelectorAll('.share-edit-dialog:not(.is-closing) .dialog-foot .btn')].find((button) => button.textContent.trim() === '取消').click())
  await page.waitFor("!document.querySelector('.share-edit-dialog:not(.is-closing)')")
  const cancelled = await page.run(() => window.__patches.length)
  check('cancel sends no PATCH', cancelled === 0, JSON.stringify(cancelled))

  // Now a real edit: viewer, no password, no cap. One deliberate change of each
  // kind, and then the row must show what the server said.
  await page.run((id) => document.querySelector('.share-row[data-id="' + id + '"] .share-edit').click(), editable.id)
  await page.waitFor(liveEditor)
  await page.run(() => {
    const panel = document.querySelector('.share-edit-dialog:not(.is-closing)')
    const choose = (selector, label) => {
      const trigger = panel.querySelector(selector)
      trigger.click()
      const item = [...document.querySelectorAll('.menu .menu-item')].find((node) => node.textContent.includes(label))
      if (!item) throw new Error('menu item not found: ' + label + ' in ' + [...document.querySelectorAll('.menu .menu-item')].map((n) => n.textContent))
      item.click()
      if (!panel.querySelector(selector).textContent.includes(label)) {
        throw new Error('select did not take ' + label + ': ' + panel.querySelector(selector).textContent)
      }
    }
    choose('[data-share-edit="permission"]', '仅查看')
    choose('[data-share-edit="password-mode"]', '移除密码')
    choose('[data-share-edit="expiry"]', '30 天')
  })
  await sleep(200)
  await page.run(() => {
    const save = [...document.querySelectorAll('.share-edit-dialog:not(.is-closing) .dialog-foot .btn')].find((button) => button.textContent.includes('保存'))
    // Two clicks in the same tick: the second must be swallowed by the
    // single-flight guard, so exactly one PATCH may reach the server.
    save.click()
    save.click()
  })
  await page.waitFor("!document.querySelector('.share-edit-dialog:not(.is-closing)')", { timeout: 8000 })
  // The row repaint is not a navigation: wait for it to carry the new settings
  // rather than sleeping a guessed interval.
  await page.waitFor("document.querySelector('.share-row[data-id=\"" + editable.id + "\"] .share-detail') && /仅查看/.test(document.querySelector('.share-row[data-id=\"" + editable.id + "\"] .share-detail').textContent)", { timeout: 8000, label: 'the row to repaint with the saved settings' })
  const patchCalls = await page.run(() => window.__patches.map((entry) => ({ url: entry.url, body: entry.body })))
  check('one save issues exactly one PATCH, to the link itself',
    patchCalls.length === 1 && patchCalls[0].url.includes('/shares/' + editable.id), JSON.stringify(patchCalls))
  const sentBody = patchCalls.length ? JSON.parse(patchCalls[0].body) : {}
  check('the PATCH names only what was deliberately changed',
    sentBody.permission === 'viewer' && sentBody.password === null && sentBody.expiresInDays === 30,
    JSON.stringify(sentBody))

  // The list row reflects the server's answer without a manual reload.
  const editedRow = await page.run((id) => {
    const row = document.querySelector('.share-row[data-id="' + id + '"]')
    return { state: row.querySelector('.share-state').textContent, detail: row.querySelector('.share-detail').textContent }
  }, editable.id)
  check('the row shows the new permission, lock and expiry',
    /仅查看/.test(editedRow.detail) && !/带密码/.test(editedRow.detail) && /天后过期/.test(editedRow.detail),
    JSON.stringify(editedRow))

  // And the change is live for an anonymous recipient on the same URL.
  const afterEdit = await fetch(server + '/api/v1/shared/' + editable.token)
  check('the same URL still resolves after the edit', afterEdit.status === 200, String(afterEdit.status))
  const afterPreview = await fetch(server + '/api/v1/shared/' + editable.token + '/preview')
  check('a downgraded link still previews without a password', afterPreview.status === 200, String(afterPreview.status))
  const afterContent = await fetch(server + '/api/v1/shared/' + editable.token + '/content')
  check('a downgraded link refuses the attachment', afterContent.status === 403, String(afterContent.status))

  // The URL is the same one the owner already had — no replacement row, no
  // rotated token, no lost creation date.
  const listedAfter = await (await fetch(server + '/api/v1/nodes/' + note.id + '/shares', { headers })).json()
  const stillListed = listedAfter.shares.find((share) => share.id === editable.id)
  check('the edit did not mint a replacement link',
    Boolean(stillListed) && stillListed.token === editable.token && stillListed.createdAt === editable.createdAt
      && stillListed.downloads === 0, JSON.stringify(stillListed))
  await page.run(() => { if (window.__restorePatchCounter) window.__restorePatchCounter() })
  await page.shot('shares-edit')

  /* ── entry 2: the file's own existing-link dialog ─────────────── */
  await page.navigate(server + '/', { settle: 1400 })
  await page.waitFor("document.querySelector('.frow[data-id]')", { timeout: 10000 })
  await page.run((id) => {
    const row = document.querySelector('.frow[data-id="' + id + '"] [data-action="more"]')
    if (!row) throw new Error('no row menu for the shared file')
    row.click()
  }, note.id)
  await page.waitFor("document.querySelector('.menu')")
  await page.run(() => [...document.querySelectorAll('.menu-item')].find((item) => item.textContent.includes('分享')).click())
  await page.waitFor("document.querySelector('.share-item .share-item-actions')", { timeout: 8000 })
  const fileDialogEdit = await page.run(() => {
    const item = document.querySelector('.share-item')
    const edit = item && item.querySelector('[aria-label="编辑链接设置"]')
    return {
      hasEdit: Boolean(edit),
      url: item ? item.querySelector('code').textContent : '',
      meta: item ? (item.querySelector('.share-item-meta') || {}).textContent || '' : '',
    }
  })
  check('the file dialog lists each existing link with an 编辑 control',
    fileDialogEdit.hasEdit && fileDialogEdit.url.endsWith('/s/' + editable.token), JSON.stringify(fileDialogEdit))
  check('the file dialog row states the current availability',
    /有效|已过期|下载次数用完|文件在回收站/.test(fileDialogEdit.meta), JSON.stringify(fileDialogEdit))

  // Open it, prove it is the same shared dialog seeded from this row, and close
  // with Escape (which is also a cancel: still no PATCH).
  await page.run(() => document.querySelector('.share-item [aria-label="编辑链接设置"]').click())
  await page.waitFor("document.querySelector('.share-edit-dialog')")
  const fromFile = await page.run(() => {
    const panel = document.querySelector('.share-edit-dialog')
    return {
      url: (panel.querySelector('.share-edit-url code') || {}).textContent || '',
      permission: (panel.querySelector('[data-share-edit="permission"]') || {}).textContent || '',
      state: (panel.querySelector('.share-edit-state') || {}).textContent || '',
    }
  })
  check('both entry points open the same dialog, seeded from the same row',
    fromFile.url.endsWith('/s/' + editable.token) && /仅查看/.test(fromFile.permission) && fromFile.state === '有效',
    JSON.stringify(fromFile))
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await page.waitFor("!document.querySelector('.share-edit-dialog:not(.is-closing)')")
  // The dialog is gone and the outer share dialog is still there: Escape closed
  // exactly one layer, which is the overlay stack's contract.
  check('Escape closes the editor and leaves the file dialog open',
    await page.evaluate("Boolean(document.querySelector('.share-item'))"))
  await page.run(() => [...document.querySelectorAll('.dialog-foot .btn')].find((button) => button.textContent.trim() === '完成')?.click())
  await page.shot('share-dialog-edit-entry')

  /* ── filters, a real second page, and the held-refill race ─────
   *
   * The fixture is deliberately over one page (52 links on one title), so the
   * filter has to narrow the server query before LIMIT/OFFSET for the second
   * page to exist at all. The revoke below happens while the offset-0 refill is
   * held; 继续加载 must not paginate the old offset in that window.
   */
  const filterTag = '分页目标' + Date.now()
  const pagedFile = await upload(filterTag + '.txt', 'text/plain', 'paged fixture')
  const fixtureLinks = []
  for (let index = 0; index < 52; index += 1) fixtureLinks.push(await createShare(pagedFile.id, 'viewer'))

  // A second fixture for the recycle-bin path: one link stays openable after a
  // restore, the other has spent its budget and stays exhausted.
  const trashTag = '回收站分享' + Date.now()
  const trashedFile = await upload(trashTag + '.txt', 'text/plain', 'trash fixture')
  const trashedViewer = await createShare(trashedFile.id, 'viewer')
  const trashedSpent = await createShare(trashedFile.id, 'downloader', { maxDownloads: 1 })
  const spent = await fetch(server + '/api/v1/shared/' + trashedSpent.token + '/content')
  check('the trash fixture link starts usable', spent.status === 200, String(spent.status))
  const trashedResponse = await fetch(server + '/api/v1/nodes/' + trashedFile.id, { method: 'DELETE', headers })
  check('the fixture source moves to the trash', trashedResponse.status === 200, String(trashedResponse.status))
  const publicWhileTrashed = await fetch(server + '/api/v1/shared/' + trashedViewer.token)
  check('a trashed source makes its public link stop resolving', publicWhileTrashed.status === 404, String(publicWhileTrashed.status))
  check('a trashed source is reported as 文件在回收站 by the filtered list', await (await fetch(server + '/api/v1/shares?state=trashed&limit=50', { headers })).json()
    .then((payload) => payload.shares.some((share) => share.id === trashedViewer.id && share.state === 'trashed')))

  await page.navigate(server + '/shares', { settle: 900 })
  await page.waitFor("document.querySelector('.shares-filter')", { timeout: 10000 })
  // The real form: name + state, submitted the way Enter in the field does.
  await page.run((term) => {
    const form = document.querySelector('.shares-filter')
    form.querySelector('input[name="q"]').value = term
    form.querySelector('select[name="state"]').value = 'active'
    form.requestSubmit()
  }, filterTag)
  // Wait for the filtered *rows*, not just the URL: a navigation keeps the old
  // rows on screen for one paint, so "50 rows" alone would race the spinner.
  const filteredPage = `(() => {
    const rows = [...document.querySelectorAll('.share-row[data-id]')]
    return location.search.includes('state=active') && rows.length === 50
      && rows.every((row) => row.querySelector('.share-row-title').textContent.includes(${JSON.stringify(filterTag)}))
      && rows.every((row) => row.querySelector('.share-state').textContent === '有效')
  })()`
  await page.waitFor(filteredPage, { timeout: 15000, label: 'the filtered first page' })
  const filtered = await page.run((term) => ({
    path: location.pathname + location.search,
    total: document.querySelectorAll('.share-row[data-id]').length,
    more: Boolean(document.querySelector('.share-more .btn')),
    rowsMatch: [...document.querySelectorAll('.share-row[data-id]')].every((row) => row.querySelector('.share-row-title').textContent.includes(term)),
    states: [...document.querySelectorAll('.share-row .share-state')].map((element) => element.textContent),
  }), filterTag)
  check('the real form filters by name + state before paging', filtered.total === 50 && filtered.more && filtered.rowsMatch, JSON.stringify(filtered))
  check('the state filter selects only 有效 rows', filtered.states.every((text) => text === '有效'), JSON.stringify(filtered.states.slice(0, 3)))
  check('the filtered URL is the canonical name + state route',
    filtered.path === '/shares?q=' + encodeURIComponent(filterTag) + '&state=active', filtered.path)

  // Hold the next offset-0 GET /api/v1/shares, then revoke one row. The revoke
  // itself succeeds; its refill is what stays in flight.
  await page.run(() => {
    window.__shareHold = { armed: true, held: 0, requests: [] }
    const next = window.fetch.bind(window)
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : String(input && input.url)
      window.__shareHold.requests.push(url)
      const response = next(input, init)
      const [path, search] = url.split('?')
      const params = new URLSearchParams(search || '')
      const isSharesPage = path === '/api/v1/shares' || path.endsWith('/api/v1/shares')
      if (window.__shareHold.failNext && isSharesPage && params.get('offset') === '0') {
        // A failed refill: the server never answers this window.
        window.__shareHold.failNext = false
        window.__shareHold.failed += 1
        return Promise.reject(new TypeError('refill failure fixture'))
      }
      if (window.__shareHold.armed && isSharesPage && params.get('offset') === '0') {
        window.__shareHold.armed = false
        window.__shareHold.held += 1
        window.__shareHold.heldUrl = url
        return new Promise((resolve, reject) => {
          window.__shareRelease = () => {
            window.__shareRelease = null
            response.then(resolve, reject)
          }
        })
      }
      return response
    }
    window.__restoreShareFetch = () => { window.fetch = next }
  })

  const revokedId = await page.run(() => {
    const row = document.querySelector('.share-row[data-id]')
    const id = row.dataset.id
    row.querySelector('.share-revoke').click()
    return id
  })
  await page.waitFor("document.querySelector('.dialog-foot .btn-danger')", { timeout: 5000 })
  await page.run(() => [...document.querySelectorAll('.dialog-foot .btn')].find((button) => button.textContent.trim() === '撤销链接').click())
  await page.waitFor("document.querySelectorAll('.share-row[data-id]').length === 49", { timeout: 8000, label: 'the revoked row to disappear while the refill is held' })
  const held = await page.run((id) => ({
    held: window.__shareHold.held,
    heldUrl: window.__shareHold.heldUrl || '',
    revokedGone: !document.querySelector('.share-row[data-id="' + id + '"]'),
    busy: (document.querySelector('.share-rows') || {}).getAttribute?.('aria-busy'),
    moreDisabled: Boolean(document.querySelector('.share-more .btn')?.disabled),
    moreLabel: (document.querySelector('.share-more .btn') || {}).textContent || '',
    rows: document.querySelectorAll('.share-row[data-id]').length,
  }), revokedId)
  check('a successful revoke removes its row before the held refill answers',
    held.held === 1 && held.revokedGone && held.busy === 'true' && held.rows === 49
      && /offset=0/.test(held.heldUrl) && /state=active/.test(held.heldUrl), JSON.stringify(held))
  check('继续加载 is busy while the refill holds the window',
    held.moreDisabled && held.moreLabel.includes('正在载入'), JSON.stringify(held))

  await page.run(() => {
    // Dispatch straight at the control: a disabled button swallows a real click,
    // and the point here is the page's own guard, not the disabled attribute.
    const button = document.querySelector('.share-more .btn')
    if (button) button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await sleep(250)
  const whileHeld = await page.run(() => ({
    oldOffsetPages: window.__shareHold.requests.filter((url) => url.includes('/api/v1/shares?') && /[?&]offset=50(?:&|$)/.test(url)).length,
    rows: document.querySelectorAll('.share-row[data-id]').length,
  }))
  check('继续加载 cannot paginate the old offset while the refill is held',
    whileHeld.oldOffsetPages === 0 && whileHeld.rows === 49, JSON.stringify(whileHeld))

  await page.run(() => { if (window.__shareRelease) window.__shareRelease() })
  await page.waitFor("document.querySelectorAll('.share-row[data-id]').length === 50 && !document.querySelector('.share-more .btn')?.disabled", { timeout: 10000, label: 'the refilled window' })
  const refilled = await page.run((id) => ({
    rows: document.querySelectorAll('.share-row[data-id]').length,
    revokedGone: !document.querySelector('.share-row[data-id="' + id + '"]'),
    busy: document.querySelector('.share-rows').getAttribute('aria-busy'),
    moreLabel: (document.querySelector('.share-more .btn') || {}).textContent || '',
  }), revokedId)
  check('releasing the refill repaints the same filtered window without the revoked row',
    refilled.rows === 50 && refilled.revokedGone && refilled.busy === 'false' && refilled.moreLabel === '继续加载',
    JSON.stringify(refilled))
  await page.run(() => document.querySelector('.share-more .btn').click())
  await page.waitFor("document.querySelectorAll('.share-row[data-id]').length === 51 && !document.querySelector('.share-more .btn')", { timeout: 10000, label: 'the second page after the held refill' })
  const pagedIds = await page.run(() => [...document.querySelectorAll('.share-row[data-id]')].map((row) => row.dataset.id))
  const expectedIds = fixtureLinks.map((share) => share.id).filter((id) => id !== revokedId)
  check('every expected filtered link is reachable exactly once after the held refill',
    pagedIds.length === expectedIds.length && new Set(pagedIds).size === pagedIds.length
      && expectedIds.every((id) => pagedIds.includes(id)),
    JSON.stringify({ rows: pagedIds.length, unique: new Set(pagedIds).size, expected: expectedIds.length }))
  await page.run(() => { const held = window.__shareHold; held.failNext = true; held.failed = 0 })
  const secondRevoked = await page.run(() => {
    const row = document.querySelector('.share-row[data-id]')
    const id = row.dataset.id
    row.querySelector('.share-revoke').click()
    return id
  })
  await page.waitFor("document.querySelector('.dialog-foot .btn-danger')", { timeout: 5000 })
  await page.run(() => [...document.querySelectorAll('.dialog-foot .btn')].find((button) => button.textContent.trim() === '撤销链接').click())
  await page.waitFor("document.querySelector('.share-more .btn')?.textContent.trim() === '重试'", { timeout: 10000, label: 'the failed-refill retry' })
  const failedRefill = await page.run((id) => ({
    failed: window.__shareHold.failed,
    rows: document.querySelectorAll('.share-row[data-id]').length,
    revokedGone: !document.querySelector('.share-row[data-id="' + id + '"]'),
    more: document.querySelector('.share-more .btn').textContent.trim(),
    busy: document.querySelector('.share-rows').getAttribute('aria-busy'),
  }), secondRevoked)
  check('a failed refill keeps the shortened rows and offers a retry of that window',
    failedRefill.failed === 1 && failedRefill.revokedGone && failedRefill.rows === 50
      && failedRefill.more === '重试' && failedRefill.busy === 'false', JSON.stringify(failedRefill))
  const offsetZeroBeforeRetry = await page.run(() => window.__shareHold.requests.filter((url) => /[?&]offset=0(?:&|$)/.test(url)).length)
  await page.run(() => document.querySelector('.share-more .btn').click())
  // Wait for the retry's own answer to be painted: the extra offset-0 request
  // happened AND the list is no longer busy.
  await page.waitFor("document.querySelector('.share-rows').getAttribute('aria-busy') === 'false' && window.__shareHold.requests.filter((url) => /[?&]offset=0(?:&|$)/.test(url)).length > " + offsetZeroBeforeRetry,
    { timeout: 10000, label: 'the retried window' })
  const afterRetry = await page.run((before) => ({
    offsetZeroPages: window.__shareHold.requests.filter((url) => /[?&]offset=0(?:&|$)/.test(url)).length - before,
    rows: document.querySelectorAll('.share-row[data-id]').length,
    ids: [...document.querySelectorAll('.share-row[data-id]')].map((row) => row.dataset.id),
  }), offsetZeroBeforeRetry)
  const remainingIds = expectedIds.filter((id) => id !== secondRevoked)
  check('the retry re-reads that same filtered window from offset 0, with no gap or duplicate',
    afterRetry.offsetZeroPages === 1 && afterRetry.rows === remainingIds.length
      && new Set(afterRetry.ids).size === afterRetry.rows
      && remainingIds.every((id) => afterRetry.ids.includes(id)),
    JSON.stringify({ offsetZero: afterRetry.offsetZeroPages, rows: afterRetry.rows, unique: new Set(afterRetry.ids).size, expected: remainingIds.length }))
  await page.run(() => { if (window.__restoreShareFetch) window.__restoreShareFetch() })
  await page.shot('shares-filters')
  /* ── the recycle-bin entry, and a restore healing both sides ──── */
  await page.navigate(server + '/trash', { settle: 1200 })
  await page.waitFor("document.querySelector('.trash-shares-link a')", { timeout: 10000, label: 'the recycle-bin share link' })
  await page.run(() => document.querySelector('.trash-shares-link a').click())
  await page.waitFor("location.pathname === '/shares' && location.search.includes('state=trashed')", { timeout: 5000, label: 'the recycle-bin link to open the trashed filter' })
  await page.waitFor("document.querySelectorAll('.share-row[data-id]').length === 2", { timeout: 10000, label: 'the two trashed-source links' })
  const viaTrash = await page.run(() => ({
    path: location.pathname + location.search,
    ids: [...document.querySelectorAll('.share-row[data-id]')].map((row) => row.dataset.id),
    states: [...document.querySelectorAll('.share-row .share-state')].map((element) => element.textContent),
    selected: (document.querySelector('.shares-filter select[name="state"]') || {}).value,
  }))
  check('the recycle-bin link opens the trashed filter with its state selected',
    viaTrash.path === '/shares?state=trashed' && viaTrash.selected === 'trashed', JSON.stringify(viaTrash))
  check('the trashed filter lists exactly the links whose source is in the bin',
    viaTrash.ids.length === 2 && viaTrash.ids.includes(trashedViewer.id) && viaTrash.ids.includes(trashedSpent.id)
      && viaTrash.states.every((text) => text === '文件在回收站'), JSON.stringify(viaTrash))

  // Compose the name with the state through the same real form.
  await page.run((term) => {
    const form = document.querySelector('.shares-filter')
    form.querySelector('input[name="q"]').value = term
    form.requestSubmit()
  }, trashTag)
  await page.waitFor("location.search.includes('state=trashed') && location.search.includes('q=') && document.querySelectorAll('.share-row[data-id]').length === 2", { timeout: 10000, label: 'the composed name + trashed filter' })
  check('the name composes with the trashed state on a real submit', true)

  const restored = await fetch(server + '/api/v1/nodes/' + trashedFile.id + '/restore', { method: 'POST', headers })
  check('the source can be restored from the trash', restored.status === 200, String(restored.status))
  const publicAfterRestore = await fetch(server + '/api/v1/shared/' + trashedViewer.token)
  check('restoring the source makes the public link resolve again', publicAfterRestore.status === 200, String(publicAfterRestore.status))
  const spentAfterRestore = await fetch(server + '/api/v1/shared/' + trashedSpent.token)
  check('restore does not resurrect a link that spent its budget', spentAfterRestore.status === 404, String(spentAfterRestore.status))

  await page.navigate(server + '/shares?state=trashed', { settle: 1200 })
  await page.waitFor("!document.querySelector('.share-row[data-id]')", { timeout: 10000, label: 'the restored links to leave the trashed filter' })
  const afterRestore = await page.run(() => ({
    rows: document.querySelectorAll('.share-row[data-id]').length,
    filteredEmpty: Boolean(document.querySelector('.share-empty')),
    selected: (document.querySelector('.shares-filter select[name="state"]') || {}).value,
  }))
  check('a restored source leaves the trashed filter and the reload keeps that filter',
    afterRestore.rows === 0 && afterRestore.filteredEmpty && afterRestore.selected === 'trashed', JSON.stringify(afterRestore))

  check('no uncaught browser errors', page.consoleErrors.length === 0, page.consoleErrors.join(' | '))
  check('no failed browser requests', page.failedRequests.length === 0, page.failedRequests.join(' | '))
  page.onEvent = previousHandler
})

// The throwaway instance is this process's own: stop it (and drop its data
// directory) before exiting, so a run leaves no listener and no fixture behind.
// A crash inside the body is already recorded by the harness (non-zero code), so
// this cleanup runs on that path too rather than only on a clean finish. `close()`
// stops the index jobs and closes the database before `cleanup()` removes the
// directory, which is what lets Windows actually delete it.
try {
  if (temporary) {
    try {
      await temporary.close()
    } finally {
      temporary.cleanup()
    }
  }
} finally {
  process.exit(code)
}