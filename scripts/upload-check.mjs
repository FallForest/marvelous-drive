#!/usr/bin/env node
/**
 * Upload regression check.
 *
 *   node scripts/upload-check.mjs [--server http://127.0.0.1:4400]
 *
 * Drives a real headless Chrome through the web client and proves the three
 * upload behaviours the queue depends on:
 *   1. the toolbar picker uploads a small file through PUT /uploads;
 *   2. a 9 MiB file goes through a resumable session and lands with the right
 *      size, emitting progress events;
 *   3. cancel leaves the task canceled and the server without a half file.
 *
 * Exits non-zero on the first regression, so it can gate a deployment.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { serverUrl, runBrowserCheck, signUpInPage, sleep } from './lib/browser.mjs'

const server = serverUrl()
// Absolute: Chrome resolves relative file-input paths against its own cwd,
// which silently yields a 0-byte handle instead of an error.
const scratch = resolve('.tmp/upload-check')
mkdirSync(scratch, { recursive: true })

process.exit(await runBrowserCheck({ title: 'Upload check' }, async (page, check) => {
  await page.send('DOM.enable')
  await page.navigate(server + '/', { settle: 1300 })

  const session = await signUpInPage(page, { prefix: 'upload', password: 'upload check password' })
  check('page signs in', Boolean(session.token))
  await page.reload({ settle: 1800 })

  // 1. Toolbar picker -> PUT /uploads.
  const clicked = await page.run(() => {
    const button = Array.from(document.querySelectorAll('button')).find((node) => /上传/.test(node.textContent || '') && !/队列/.test(node.textContent || ''))
    if (!button) return false
    button.click()
    return true
  })
  check('upload button exists', clicked)
  await sleep(400)

  const choseFiles = await page.run(() => {
    const item = Array.from(document.querySelectorAll('.menu-item')).find((node) => /上传文件/.test(node.innerText))
    if (!item) return false
    item.click()
    return true
  })
  check('upload menu offers "上传文件"', choseFiles)
  await sleep(400)

  const tree = await page.send('DOM.getDocument', { depth: -1 })
  const input = await page.send('DOM.querySelector', { nodeId: tree.root.nodeId, selector: 'input[type=file]' })
  check('file input is created on demand', input.nodeId !== 0)
  if (input.nodeId !== 0) {
    writeFileSync(scratch + '/picker.txt', 'uploaded by the upload check\n')
    await page.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [scratch + '/picker.txt'] })
    await sleep(3200)
    const rows = await page.evaluate("Array.from(document.querySelectorAll('[data-id]')).map((node) => node.innerText.replace(/\\s+/g, ' ').trim())")
    check('picker upload reaches the list', rows.some((text) => text.includes('picker.txt') && !text.includes('失败')), JSON.stringify(rows))
  }

  // 2. Resumable session for 9 MiB.
  // The payload is randomised per run on purpose: with identical bytes the
  // client's dedup probe finds the blob the previous run left behind and
  // finishes without a session (0 bytes uploaded), which would silently skip
  // the flow this check exists to guard.
  const resumable = await page.run(async () => {
    const api = await import('/lib/upload.js')
    const bytes = new Uint8Array(9 * 1024 * 1024)
    const seed = crypto.getRandomValues(new Uint32Array(1))[0]
    for (let index = 0; index < bytes.length; index += 1021) bytes[index] = (index + seed) % 251
    bytes[0] = seed & 0xff
    const file = new File([bytes], 'big.bin', { type: 'application/octet-stream' })
    const task = api.createUploadTask({ file, parentId: null })
    const progress = []
    task.on('progress', (event) => progress.push(event.progress))
    const node = await task.start()
    return { size: node ? node.size : 0, state: task.state, ticks: progress.length }
  })
  check('9 MiB file uploads through a session', resumable.state === 'done' && resumable.size === 9 * 1024 * 1024, JSON.stringify(resumable))
  check('progress events are emitted', resumable.ticks >= 2, String(resumable.ticks))

  // 3. A batch gets one bar for the whole queue, not just per-row bars.
  const batch = await page.run(async () => {
    const input = document.querySelector('input[type=file]')
    return Boolean(input)
  })
  check('file input still mounted for the batch', batch)
  {
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      writeFileSync(scratch + '/' + name, 'batch member ' + name + '\n')
    }
    const tree = await page.send('DOM.getDocument', { depth: -1 })
    const field = await page.send('DOM.querySelector', { nodeId: tree.root.nodeId, selector: 'input[type=file]' })
    await page.send('DOM.setFileInputFiles', {
      nodeId: field.nodeId,
      files: ['a.txt', 'b.txt', 'c.txt'].map((name) => scratch + '/' + name),
    })
  }
  await sleep(2600)
  const header = await page.run(() => {
    const panel = document.querySelector('.queue')
    const total = document.querySelector('.qbar-total')
    const meta = document.querySelector('.qmeta')
    return {
      visible: Boolean(panel) && !panel.hasAttribute('hidden'),
      hasTotals: Boolean(total) && !total.parentElement.hasAttribute('hidden'),
      meta: meta ? meta.innerText.replace(/\s+/g, ' ').trim() : '',
      valued: total ? Number(total.getAttribute('aria-valuenow')) : -1,
    }
  })
  check('the queue shows a batch bar for the whole drop', header.hasTotals, JSON.stringify(header))
  check('the batch bar reports transferred bytes', /\d.*\/.*\d/.test(header.meta), header.meta)
  check('the batch bar reaches 100% when the drop settles', header.valued === 100, String(header.valued))

  // 4. Cancel.
  const cancelled = await page.run(async () => {
    const api = await import('/lib/upload.js')
    const file = new File([new Uint8Array(3 * 1024 * 1024)], 'cancel-me.bin', { type: 'application/octet-stream' })
    const task = api.createUploadTask({ file, parentId: null })
    const running = task.start()
    task.cancel()
    await running.catch(() => {})
    return task.state
  })
  check('cancel stops the task', cancelled === 'canceled', cancelled)

  const listed = await page.run(async () => {
    const token = localStorage.getItem('mdrive-token')
    const payload = await fetch('/api/v1/nodes', { headers: { authorization: 'Bearer ' + token } }).then((r) => r.json())
    return payload.nodes.map((node) => node.name + ':' + node.size)
  })
  check('server holds exactly the five finished files', listed.length === 5, JSON.stringify(listed))

  check('no console errors', page.consoleErrors.length === 0, page.consoleErrors.slice(0, 3).join(' | '))
}))
