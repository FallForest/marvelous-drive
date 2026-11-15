#!/usr/bin/env node
/** Explicit text editing: save, concurrency, encoding and dismissal safety.
 * node scripts/editor-check.mjs [--server URL]
 */
import { serverUrl, runBrowserCheck, signUpInPage, sleep } from './lib/browser.mjs'

const server = serverUrl()
process.exit(await runBrowserCheck({ title: 'Text editor check', network: true }, async (page, check) => {
  await page.navigate(server + '/')
  const session = await signUpInPage(page, { prefix: 'editor', password: 'editor check password' })
  check('signed in', Boolean(session.token))
  const seeded = await page.run(async () => {
    const headers = { authorization: 'Bearer ' + localStorage.getItem('mdrive-token'), 'content-type': 'text/plain' }
    const upload = async (name, body) => (await (await fetch('/api/v1/uploads?name=' + encodeURIComponent(name), { method: 'PUT', headers, body })).json()).node
    return {
      text: await upload('notes.md', '\uFEFF# Original\r\nsecond line\r\n'),
      invalid: await upload('invalid.txt', new Uint8Array([0xff, 0xfe, 0xff])),
      binary: await upload('binary.txt', 'hello\u0000world'),
      large: await upload('large.txt', new Uint8Array(2 * 1024 * 1024 + 1).fill(65)),
      latest: await upload('latest.txt', 'old metadata'),
    }
  })
  await page.reload()
  await page.waitFor("document.querySelectorAll('.frow[data-id]').length === 5")
  await page.run(() => {
    const originalFetch = window.fetch.bind(window)
    window.__editorCalls = []
    window.fetch = async (url, options = {}) => {
      const path = String(url)
      const method = (options.method || 'GET').toUpperCase()
      window.__editorCalls.push({ path, method })
      if (method === 'POST' && path.endsWith('/lock') && window.__delayLock) await new Promise((resolve) => setTimeout(resolve, 180))
      if (method === 'PUT' && path.includes('/content')) {
        if (window.__failSave) throw new TypeError('simulated offline save')
        await new Promise((resolve) => setTimeout(resolve, 120))
      }
      return originalFetch(url, options)
    }
  })
  const key = async (name, code, virtualKey, modifiers = 0) => {
    const params = { key: name, code, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey, modifiers }
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...params })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
  }
  const fill = (value) => page.run((text) => {
    const input = document.querySelector('.text-editor-input')
    input.value = text
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.focus()
  }, value)
  const ready = () => page.waitFor("document.querySelector('.text-editor-drawer:not(.is-closing) textarea:not([readonly])')")
  const directOpen = async (node) => {
    await page.run(async (entry) => { (await import('/lib/text-editor.js')).openTextEditor(entry) }, node)
    await page.waitFor("document.querySelector('.text-editor-drawer:not(.is-closing)')")
  }
  const closeEditor = async () => {
    await page.run(() => document.querySelector('.text-editor-drawer:not(.is-closing) .drawer-head [aria-label="关闭"]').click())
  }
  const pickPrompt = async (label) => {
    await page.waitFor("document.querySelector('.dialog:not(.is-closing)')")
    await page.run((name) => Array.from(document.querySelectorAll('.dialog:not(.is-closing) button')).find((button) => button.textContent === name).click(), label)
    await page.waitFor("!document.querySelector('.dialog:not(.is-closing)')")
    await sleep(30)
  }
  const content = (id) => page.run(async (nodeId) => {
    const response = await fetch('/api/v1/files/' + nodeId + '/content', { headers: { authorization: 'Bearer ' + localStorage.getItem('mdrive-token') } })
    return new TextDecoder('utf-8', { ignoreBOM: true }).decode(await response.arrayBuffer())
  }, id)

  await page.run((id) => document.querySelector('.frow[data-id="' + id + '"] .name').click(), seeded.text.id)
  await page.waitFor("document.querySelector('.preview-drawer')")
  check('preview alone does not claim an edit lock', !await page.run(async (id) => (await (await fetch('/api/v1/nodes/' + id + '/lock', { headers: { authorization: 'Bearer ' + localStorage.getItem('mdrive-token') } })).json()).lock, seeded.text.id))
  await page.run(() => {
    window.__editorCalls = []
    Array.from(document.querySelectorAll('.preview-drawer button')).find((button) => button.textContent.includes('编辑文本')).click()
  })
  await ready()
  const calls = await page.evaluate('window.__editorCalls')
  const metadataAt = calls.findIndex((call) => call.path === '/api/v1/nodes/' + seeded.text.id)
  const contentAt = calls.findIndex((call) => call.path === '/api/v1/files/' + seeded.text.id + '/content')
  check('editing reads latest metadata before content', metadataAt >= 0 && contentAt > metadataAt)
  await fill('# Edited\nsecond line\n')
  check('dirty content protects browser unload', await page.run(() => {
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  }))
  await page.run(() => { window.__editorCalls = [] })
  await key('s', 'KeyS', 83, 2)
  await key('s', 'KeyS', 83, 2)
  await page.waitFor("document.querySelector('.editor-status').textContent === '已保存'")
  check('Ctrl+S saves exactly once while a save is pending', (await page.evaluate('window.__editorCalls')).filter((call) => call.method === 'PUT').length === 1)
  check('saving preserves UTF-8 BOM and original CRLF line endings', await content(seeded.text.id) === '\uFEFF# Edited\r\nsecond line\r\n')
  const versions = await page.run(async (id) => (await (await fetch('/api/v1/files/' + id + '/versions', { headers: { authorization: 'Bearer ' + localStorage.getItem('mdrive-token') } })).json()).versions, seeded.text.id)
  check('saving creates a recoverable previous version', versions.length === 1 && versions[0].version === 1)
  check('saving refreshes the preview behind the editor', await page.evaluate("/Edited/.test(document.querySelector('.preview-drawer .preview-md').textContent)"))
  await fill('unsaved draft')
  await closeEditor()
  await closeEditor()
  check('repeated close gestures open only one unsaved-change prompt', await page.evaluate("document.querySelectorAll('.dialog:not(.is-closing)').length") === 1)
  await pickPrompt('继续编辑')
  check('continuing to edit preserves the draft', await page.evaluate("document.querySelector('.text-editor-input').value") === 'unsaved draft')
  await key('Escape', 'Escape', 27)
  await pickPrompt('继续编辑')
  check('Escape remains guarded after an earlier close was vetoed', await page.evaluate("Boolean(document.querySelector('.text-editor-drawer:not(.is-closing)'))"))
  await page.run(() => {
    const scrim = document.querySelector('.text-editor-drawer:not(.is-closing)').parentElement
    scrim.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  })
  await pickPrompt('继续编辑')
  check('the backdrop uses the same unsaved-change guard', await page.evaluate("document.querySelector('.text-editor-input').value") === 'unsaved draft')
  await closeEditor()
  await pickPrompt('放弃更改')
  await page.waitFor("!document.querySelector('.text-editor-drawer:not(.is-closing)')")
  check('discarding never overwrites saved content', await content(seeded.text.id) === '\uFEFF# Edited\r\nsecond line\r\n')
  await page.run(() => document.querySelector('.preview-drawer:not(.is-closing) .drawer-head [aria-label="关闭"]').click())
  await page.waitFor("!document.querySelector('.text-editor-drawer')")

  await directOpen(seeded.latest)
  await ready()
  await fill('saved on close')
  await closeEditor()
  await pickPrompt('保存并关闭')
  await page.waitFor("!document.querySelector('.text-editor-drawer:not(.is-closing)')")
  check('Save and close waits for the successful write', await content(seeded.latest.id) === 'saved on close')
  await page.waitFor("!document.querySelector('.text-editor-drawer')")

  await directOpen(seeded.latest)
  await ready()
  check('opening with stale list metadata loads the latest version', await page.evaluate("document.querySelector('.text-editor-input').value") === 'saved on close')
  await page.run(async (id) => fetch('/api/v1/files/' + id + '/content', {
    method: 'PUT', headers: { authorization: 'Bearer ' + localStorage.getItem('mdrive-token'), 'content-type': 'text/plain' }, body: 'another editor won',
  }), seeded.latest.id)
  await fill('my conflicting draft')
  await key('s', 'KeyS', 83, 2)
  await page.waitFor("document.querySelector('.editor-status').dataset.error === 'VERSION_CONFLICT'")
  check('a concurrent edit never overwrites newer content', await content(seeded.latest.id) === 'another editor won')
  check('a conflicting save preserves the draft and explains recovery', await page.evaluate("document.querySelector('.text-editor-input').value === 'my conflicting draft' && /草稿/.test(document.querySelector('.editor-status').textContent)"))
  await page.run(() => { window.__failSave = true })
  await fill('offline draft')
  await key('s', 'KeyS', 83, 2)
  await page.waitFor("document.querySelector('.editor-status').dataset.error === 'NETWORK_ERROR'")
  check('a failed save retains editable content', await page.evaluate("document.querySelector('.text-editor-input').value === 'offline draft' && !document.querySelector('.text-editor-input').readOnly"))
  await closeEditor()
  await pickPrompt('放弃更改')
  await page.waitFor("!document.querySelector('.text-editor-drawer:not(.is-closing)')")
  await page.run(() => { window.__failSave = false })
  await page.waitFor("!document.querySelector('.text-editor-drawer')")

  for (const [kind, node] of [['invalid UTF-8', seeded.invalid], ['binary', seeded.binary]]) {
    await directOpen(node)
    await page.waitFor("document.querySelector('.editor-status').textContent !== '正在读取最新内容…'")
    const state = await page.evaluate("({ readonly: document.querySelector('.text-editor-input').readOnly, disabled: document.querySelector('.text-editor-drawer .btn-primary').disabled, message: document.querySelector('.editor-status').textContent })")
    check(kind + ' files cannot enter editing', state.readonly && state.disabled, JSON.stringify(state))
    await closeEditor()
    await page.waitFor("!document.querySelector('.text-editor-drawer:not(.is-closing)')")
    await page.waitFor("!document.querySelector('.text-editor-drawer')")
  }
  check('large files are excluded before opening an editor', await page.run(async (node) => !(await import('/lib/text-editor.js')).canEditText(node), seeded.large))
  await page.run(() => { window.__delayLock = true })
  await directOpen(seeded.text)
  await ready()
  await closeEditor()
  await page.waitFor("!document.querySelector('.text-editor-drawer:not(.is-closing)')")
  await sleep(400)
  check('a lock arriving after close is still released', !await page.run(async (id) => (await (await fetch('/api/v1/nodes/' + id + '/lock', { headers: { authorization: 'Bearer ' + localStorage.getItem('mdrive-token') } })).json()).lock, seeded.text.id))
  await page.run(() => { window.__delayLock = false })
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await directOpen(seeded.text)
  await ready()
  await page.waitFor("document.querySelector('.text-editor-drawer:not(.is-closing)').getAnimations().every((animation) => animation.playState !== 'running')")
  const layout = await page.run(() => {
    const panel = document.querySelector('.text-editor-drawer:not(.is-closing)')
    const input = panel.querySelector('textarea')
    const rect = input.getBoundingClientRect()
    const close = panel.querySelector('.drawer-head [aria-label="关闭"]').getBoundingClientRect()
    const buttons = Array.from(panel.querySelectorAll('.drawer-foot button')).map((button) => button.getBoundingClientRect().height)
    return { font: parseFloat(getComputedStyle(input).fontSize), height: rect.height, right: panel.getBoundingClientRect().right, viewport: innerWidth,
      closeWidth: close.width, closeHeight: close.height, closeLeft: close.left, buttons }
  })
  check('the mobile editor fits the screen with a readable field', layout.font >= 16 && layout.height > 100 && layout.right <= layout.viewport + 1, JSON.stringify(layout))
  check('mobile editor controls have 44px targets and close is on the right', layout.closeWidth >= 44 && layout.closeHeight >= 44 && layout.closeLeft > layout.viewport / 2 && layout.buttons.every((height) => height >= 44), JSON.stringify(layout))
  await fill('# Mobile saved\n')
  await key('s', 'KeyS', 83, 2)
  await page.waitFor("document.querySelector('.editor-status').textContent === '已保存'")
  check('a physical keyboard can save in the mobile layout', await content(seeded.text.id) === '\uFEFF# Mobile saved\r\n')
  await page.shot('editor-01-mobile')
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 460, deviceScaleFactor: 1, mobile: true })
  await page.waitFor("Math.abs(document.querySelector('.text-editor-drawer:not(.is-closing)').getBoundingClientRect().height - visualViewport.height) < 2")
  const keyboardLayout = await page.run(() => {
    const panel = document.querySelector('.text-editor-drawer:not(.is-closing)')
    const footer = panel.querySelector('.drawer-foot').getBoundingClientRect()
    return { bottom: footer.bottom, visibleBottom: visualViewport.offsetTop + visualViewport.height,
      top: footer.top, visibleTop: visualViewport.offsetTop }
  })
  check('the save bar stays inside a reduced mobile visual viewport', keyboardLayout.bottom <= keyboardLayout.visibleBottom + 1 && keyboardLayout.top >= keyboardLayout.visibleTop, JSON.stringify(keyboardLayout))
  // Exercise the visual-viewport scroll/zoom signals separately from the device
  // resize. These getters model the keyboard's pan and native pinch state.
  const visual = await page.run(() => {
    const viewport = visualViewport
    Object.defineProperty(viewport, 'offsetTop', { configurable: true, value: 35 })
    viewport.dispatchEvent(new Event('scroll'))
    const panel = document.querySelector('.text-editor-drawer:not(.is-closing)')
    const panned = panel.style.getPropertyValue('--editor-viewport-top') === '35px'
    Object.defineProperty(viewport, 'scale', { configurable: true, value: 2 })
    viewport.dispatchEvent(new Event('resize'))
    const zoomReleased = !panel.style.getPropertyValue('--editor-viewport-height') && !panel.style.getPropertyValue('--editor-viewport-top')
    delete viewport.offsetTop
    delete viewport.scale
    viewport.dispatchEvent(new Event('resize'))
    return { panned, zoomReleased }
  })
  check('viewport panning follows the keyboard while pinch keeps native control', visual.panned && visual.zoomReleased, JSON.stringify(visual))
  await page.shot('editor-02-reduced-viewport')
  await closeEditor()
  check('no unexpected console errors', page.consoleErrors.length === 0, page.consoleErrors.slice(0, 3).join(' | '))
  check('no failed requests', page.failedRequests.length === 0, page.failedRequests.slice(0, 3).join(' | '))
}))
