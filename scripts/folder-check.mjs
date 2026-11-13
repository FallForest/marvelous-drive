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

import { serverUrl, runBrowserCheck, signUpInPage, sleep } from './lib/browser.mjs'

const server = serverUrl()

process.exit(await runBrowserCheck({ title: 'Folder drop check', network: true }, async (page, check) => {
  page.logPageConsole = true
  await page.navigate(server + '/', { settle: 1300 })
  await signUpInPage(page, { prefix: 'drop', password: 'drop check password' })
  await page.reload({ settle: 1800 })

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
    const tree = makeDirEntry('项目资料', [
      makeFileEntry('README.md', '# 顶层\n'),
      makeDirEntry('文档', [
        makeFileEntry('计划.md', '# 计划\n'),
        makeDirEntry('归档', [makeFileEntry('旧.txt', 'old\n')]),
      ]),
      makeDirEntry('空目录', []),
    ])
    const item = { kind: 'file', webkitGetAsEntry: () => tree }
    const dataTransfer = { items: [item], files: [], types: ['Files'], dropEffect: 'copy' }
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
    document.getElementById('shell').dispatchEvent(event)
    return true
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

  await page.shot('folder-drop')
  check('no console errors', page.consoleErrors.length === 0, page.consoleErrors.slice(0, 2).join(' | '))
}))
