#!/usr/bin/env node
/**
 * Folder-drop check: dispatches a drop carrying a real entry tree (the shape
 * Chrome hands to the page) and asserts the server tree keeps the dropped
 * folder, its nested folders, its EMPTY folder and every file in place.
 *
 * The picker path cannot be driven headless (no directory dialog), and a
 * webkitdirectory FileList can never contain an empty directory, so the entry
 * tree is the one path that can prove empty folders end to end.
 *
 *   node scripts/folder-check.mjs [--server URL]
 */

import { serverUrl, runBrowserCheck, signUpInPage, sleep, flag } from './lib/browser.mjs'

const server = serverUrl()

process.exit(await runBrowserCheck({ title: 'Folder drop check', network: true }, async (page, check) => {
  page.logPageConsole = true
  if (flag('without-webcrypto', '0') === '1') {
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: "Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined })",
    })
  }
  await page.navigate(server + '/', { settle: 1300 })
  await signUpInPage(page, { prefix: 'drop', password: 'drop check password' })
  await page.reload({ settle: 1800 })
  if (flag('without-webcrypto', '0') === '1') check('WebCrypto is unavailable as on plain HTTP', await page.evaluate('!crypto.subtle'))

  // A synthetic DataTransfer whose entries mirror what Chrome produces for a
  // dropped folder: nested directories, an empty one, and files at two levels.
  const dispatched = await page.run(async () => {
    const makeFileEntry = (name, text) => ({
      isFile: true, isDirectory: false, name,
      file(resolve) { resolve(new File([text], name, { type: 'text/plain' })) },
    })
    const makeDirEntry = (name, children) => ({
      isFile: false, isDirectory: true, name,
      createReader() {
        let done = false
        return {
          readEntries(resolve) {
            if (done) { resolve([]); return }
            done = true
            resolve(children)
          },
        }
      },
    })
    window.__dropFolderFixture = (extra = false, changed = false) => {
    const tree = makeDirEntry('项目资料', [
      makeFileEntry('README.md', changed ? '# 变更\n' : '# 顶层\n'),
      makeDirEntry('文档', [
        makeFileEntry('计划.md', '# 计划\n'),
        makeDirEntry('归档', [makeFileEntry('旧.txt', 'old\n')]),
      ]),
      makeDirEntry('空目录', []),
      ...(extra ? [makeFileEntry('新增.txt', 'new\n')] : []),
    ])
    const item = { kind: 'file', webkitGetAsEntry: () => tree }
    const dataTransfer = { items: [item], files: [], types: ['Files'], dropEffect: 'copy' }
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
    document.getElementById('shell').dispatchEvent(event)
    return true
    }
    return window.__dropFolderFixture()
  })
  check('drop dispatched', dispatched === true)
  await sleep(7000)

  const tree = await page.run(async () => {
    const token = localStorage.getItem('mdrive-token')
    const nodes = await fetch('/api/v1/nodes', { headers: { authorization: 'Bearer ' + token } }).then((r) => r.json())
    return nodes.nodes.map((node) => node.kind + ':' + node.name + ':' + (node.parentId ? 'nested' : 'root'))
  })
  console.log('  server tree:', JSON.stringify(tree))

  const names = tree.map((entry) => entry.split(':')[1])
  check('dropped folder is created', names.includes('项目资料'))
  check('nested folder is created', names.includes('文档') && names.includes('归档'))
  check('EMPTY folder survives the drop', names.includes('空目录'))
  check('files at every level uploaded', names.includes('README.md') && names.includes('计划.md') && names.includes('旧.txt'))
  check('nothing flattened into the root', tree.filter((entry) => entry.endsWith(':root')).length === 1, JSON.stringify(tree))

  const snapshot = () => page.run(async () => {
    const headers = { authorization: 'Bearer ' + localStorage.getItem('mdrive-token') }
    return (await (await fetch('/api/v1/nodes', { headers })).json()).nodes
  })
  const original = await snapshot()
  const transfers = []
  const previousHandler = page.onEvent.bind(page)
  page.onEvent = (message) => {
    const request = message.params?.request
    if (message.method === 'Network.requestWillBeSent' && request?.method === 'PUT'
      && /\/api\/v1\/(uploads|files\/[^/]+\/content)/.test(request.url)) transfers.push(request.url)
    return previousHandler(message)
  }
  const dropAgain = async (extra, changed = false) => {
    transfers.length = 0
    await page.run((add, modify) => {
      document.querySelectorAll('.toast').forEach((toast) => toast.remove())
      window.__dropFolderFixture(add, modify)
    }, extra, changed)
  }
  const waitForCompletion = () => page.waitFor(
    "[...document.querySelectorAll('.toast.is-success .toast-text')].some(el => el.textContent.includes('项目资料'))",
    { timeout: 15000, label: 'folder upload completion notice' },
  )

  await dropAgain(false)
  await waitForCompletion()
  const repeated = await snapshot()
  check('re-dropping unchanged folder creates no duplicate nodes', repeated.length === original.length
    && original.every((node) => repeated.some((next) => next.id === node.id)))
  check('unchanged files keep their versions', original.every((node) => repeated.find((next) => next.id === node.id)?.version === node.version))
  check('unchanged files send no content requests', transfers.length === 0, JSON.stringify(transfers))
  check('unchanged files need no conflict decision', !(await page.evaluate("Boolean(document.querySelector('.dialog:not(.is-closing)'))")))

  await dropAgain(true)
  await waitForCompletion()
  const added = await snapshot()
  check('adding one local file adds exactly one remote file', added.length === original.length + 1
    && added.filter((node) => node.name === '新增.txt').length === 1)
  check('incremental drop keeps existing versions', original.every((node) => added.find((next) => next.id === node.id)?.version === node.version))
  check('incremental drop transfers only the new file', transfers.length === 1 && transfers[0].includes(encodeURIComponent('新增.txt')), JSON.stringify(transfers))

  await dropAgain(true, true)
  await page.waitFor("document.querySelector('.dialog:not(.is-closing)')", { timeout: 10000, label: 'changed file conflict decision' })
  check('changed file is confirmed before any content is sent', transfers.length === 0)
  await page.run(() => {
    document.querySelector('input[name="mdrive-upload-conflict"][value="overwrite"]').click()
    ;[...document.querySelectorAll('.dialog-foot button')].find((button) => button.textContent.includes('继续上传')).click()
  })
  await waitForCompletion()
  const changed = await snapshot()
  const beforeReadme = original.find((node) => node.name === 'README.md')
  check('replacement keeps the node and creates one new version', changed.find((node) => node.id === beforeReadme.id)?.version === beforeReadme.version + 1
    && changed.length === added.length)
  check('replacement transfers only the changed file', transfers.length === 1 && transfers[0].includes('README.md'), JSON.stringify(transfers))
  const history = await page.run(async (id) => {
    const headers = { authorization: 'Bearer ' + localStorage.getItem('mdrive-token') }
    return (await (await fetch('/api/v1/files/' + id + '/versions', { headers })).json()).versions
  }, beforeReadme.id)
  check('the original content remains in version history', history.length === 1)
  page.onEvent = previousHandler

  await page.shot('folder-drop')
  check('no console errors', page.consoleErrors.length === 0, page.consoleErrors.slice(0, 2).join(' | '))
}))
