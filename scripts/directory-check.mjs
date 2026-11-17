#!/usr/bin/env node
/** Real-browser paging, scope, sorting, selection and upload-conflict regressions. */
import { runBrowserCheck, serverUrl, signUpInPage, sleep } from './lib/browser.mjs'
import { makePng } from './lib/png.mjs'

const server = serverUrl()
process.exit(await runBrowserCheck({ title: 'Directory paging check', network: true }, async (page, check) => {
  await page.navigate(server + '/')
  const signedIn = await signUpInPage(page, { prefix: 'directory' })
  check('signed in', Boolean(signedIn.token))
  const ids = await page.run(async () => {
    const headers = { authorization: 'Bearer ' + localStorage.getItem('mdrive-token'), 'content-type': 'application/json' }
    const make = async (name, kind, parentId = null) => {
      const response = await fetch('/api/v1/nodes', { method: 'POST', headers, body: JSON.stringify({ name, kind, parentId }) })
      if (!response.ok) throw new Error('seed failed: ' + name)
      return (await response.json()).node.id
    }
    const parent = await make('PagingParent', 'folder')
    const child = await make('PagingChild', 'folder', parent)
    const destination = await make('MoveDestination', 'folder')
    let first, last
    for (let i = 0; i < 205; i += 1) {
      const id = await make('file-' + String(i).padStart(3, '0') + '.txt', 'file', child)
      if (i === 0) first = id
      last = id
    }
    await make('root-only.txt', 'file')
    return { parent, child, destination, first, last }
  })

  page.networkRequests = []
  await page.navigate(server + '/folder/' + ids.child)
  await page.waitFor("window.mdrive && !window.mdrive.store.state.loading && document.querySelectorAll('.frow[data-id]').length === 100")
  let state = await page.evaluate("({ count: mdrive.store.state.nodes.length, names: mdrive.store.state.nodes.map(n => n.name), text: document.body.innerText, folderCount: document.querySelectorAll('.tree [data-folder-id]').length })")
  check('a deep-linked folder loads its first 100 rows', state.count === 100 && state.names[0] === 'file-000.txt' && state.names[99] === 'file-099.txt')
  check('unrelated root files stay outside the current listing', !state.names.includes('root-only.txt'))
  check('a partial listing says loaded and limits select-all honestly', state.text.includes('已加载 100 项') && state.text.includes('全选仅选择已加载'))
  const breadcrumb = await page.evaluate("document.querySelector('.breadcrumb')?.innerText || document.querySelector('.topbar')?.innerText || ''")
  check('deep-link breadcrumbs keep the folder ancestry', breadcrumb.includes('PagingParent') && breadcrumb.includes('PagingChild'), breadcrumb)
  check('normal navigation fetches no trash', !page.networkRequests.some((url) => new URL(url).searchParams.has('trash')))
  check('normal navigation fetches no unscoped file tree', !page.networkRequests.some((value) => { const url = new URL(value); return url.pathname === '/api/v1/nodes' && !url.searchParams.has('kind') && !url.searchParams.has('parentId') }))

  // The move picker must still know destinations that were not part of this page.
  await page.run((id) => document.querySelector('.frow[data-id="' + id + '"] [aria-label="更多操作"]').click(), ids.first)
  await page.waitFor("document.querySelector('.menu')")
  await page.run(() => Array.from(document.querySelectorAll('.menu-item')).find((button) => button.textContent.includes('移动到')).click())
  await page.waitFor("document.querySelector('.dialog .move-list')")
  check('the move picker retains other folders without loading their files', await page.run((id) => Boolean(document.querySelector('.move-list [data-folder-id="' + id + '"]')), ids.destination))
  await page.run(() => Array.from(document.querySelectorAll('.dialog-foot button')).find((button) => button.textContent === '取消').click())
  await page.waitFor("!document.querySelector('.dialog:not(.is-closing)')")
  await sleep(250)

  await page.run((id) => document.querySelector('.frow[data-id="' + id + '"] input[type="checkbox"]').click(), ids.first)
  await page.run(() => document.querySelector('.node-more button').click())
  await page.waitFor("mdrive.store.state.nodes.length === 200 && !mdrive.store.state.nodeMore.loading")
  check('load-more appends the next page without duplicates', await page.evaluate('new Set(mdrive.store.state.nodes.map(n => n.id)).size === 200'))
  check('selection survives appending a page', await page.run((id) => mdrive.store.state.selection.has(id), ids.first))
  await page.run(() => document.querySelector('.node-more button').click())
  await page.waitFor("mdrive.store.state.nodes.length === 205 && !mdrive.store.state.nodeMore.loading")
  check('the final page removes the continuation control', await page.evaluate("!document.querySelector('.node-more') && document.querySelectorAll('.frow[data-id]').length === 205"))

  // Sorting a partial view starts from page one in the new global order.
  await page.run(() => document.querySelector('.toolbar [aria-label="当前升序，点击切换为降序"]').click())
  await page.waitFor("!mdrive.store.state.loading && mdrive.store.state.nodes.length === 100 && mdrive.store.state.nodes[0].name === 'file-204.txt'")
  check('descending order applies before pagination', await page.evaluate("mdrive.store.state.nodes[99].name === 'file-105.txt'"))

  // file-000 is now outside the visible page: conflict detection must still see it.
  await page.run(() => { void mdrive.uploadFiles([new File(['changed'], 'file-000.txt', { type: 'text/plain' })]) })
  await page.waitFor("Array.from(document.querySelectorAll('.dialog h2')).some(node => node.textContent.includes('同名'))")
  check('plain upload checks off-page same-name files', true)
  await page.run(() => Array.from(document.querySelectorAll('.dialog-foot button')).find((button) => button.textContent === '取消上传').click())
  await page.waitFor("!document.querySelector('.dialog:not(.is-closing)')")

  page.networkRequests = []
  await page.run(() => mdrive.navigate('/'))
  await page.waitFor("!mdrive.store.state.loading && mdrive.store.state.route.folderId === null")
  check('folder and stats caches are reused for another directory', !page.networkRequests.some((value) => { const url = new URL(value); return url.pathname === '/api/v1/storage/stats' || (url.pathname === '/api/v1/nodes' && url.searchParams.get('kind') === 'folder') }))
  await page.run(() => mdrive.navigate('/trash'))
  await page.waitFor("!mdrive.store.state.loading && mdrive.store.state.route.name === 'trash'")
  check('trash is requested when entering the trash view', page.networkRequests.some((value) => new URL(value).searchParams.get('trash') === '1'))

  const photos = await page.run(async (base64) => {
    const headers = { authorization: 'Bearer ' + localStorage.getItem('mdrive-token') }
    const folder = await (await fetch('/api/v1/nodes', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'LazyPhotos', kind: 'folder' }),
    })).json()
    const body = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
    const ids = []
    for (let i = 0; i < 40; i += 1) {
      const response = await fetch('/api/v1/uploads?parentId=' + folder.node.id + '&name=photo-' + String(i).padStart(2, '0') + '.png', {
        method: 'PUT', headers: { ...headers, 'content-type': 'image/png' }, body,
      })
      if (!response.ok) throw new Error('image seed failed')
      ids.push((await response.json()).node.id)
    }
    return { folder: folder.node.id, ids }
  }, makePng(800, 600).toString('base64'))
  page.networkRequests = []
  await page.navigate(server + '/folder/' + photos.folder)
  await page.waitFor("document.querySelectorAll('.frow[data-id]').length === 40 && document.querySelectorAll('.thumb-inline').length > 0")
  await sleep(700)
  const thumbnailRequests = page.networkRequests.filter((value) => new URL(value).pathname.endsWith('/thumbnail'))
  check('offscreen rows do not eagerly download all image content', thumbnailRequests.length > 0 && thumbnailRequests.length < 40, String(thumbnailRequests.length))
  check('photo listings never download original image content', !page.networkRequests.some((value) => new URL(value).pathname.endsWith('/content')))
  const dimensions = await page.evaluate("Array.from(document.querySelectorAll('img.thumb-inline')).map(image => image.naturalWidth)")
  check('list images are decoded from real small representations', dimensions.length > 0 && dimensions.every((width) => width === 96), JSON.stringify(dimensions))
  const finalPhoto = photos.ids[photos.ids.length - 1]
  check('the distant thumbnail has not been requested before scrolling', !thumbnailRequests.some((value) => new URL(value).pathname.includes(finalPhoto)))
  await page.run((id) => document.querySelector('.frow[data-id="' + id + '"]').scrollIntoView({ block: 'center' }), finalPhoto)
  await page.waitFor("document.querySelector('.frow[data-id=\"" + finalPhoto + "\"] .thumb-inline')")
  check('scrolling into view loads the distant thumbnail', page.networkRequests.some((value) => new URL(value).pathname.includes(finalPhoto) && new URL(value).pathname.endsWith('/thumbnail')))
  check('no browser console errors', page.consoleErrors.length === 0, page.consoleErrors.slice(0, 2).join(' | '))
  check('no failed network requests', page.failedRequests.length === 0, page.failedRequests.slice(0, 2).join(' | '))
  await page.shot('directory-paging')
}))
