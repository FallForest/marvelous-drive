#!/usr/bin/env node
/** Regression checks for grid rendering, nested controls and selected-row keys.
 * Uses real browser key input so native button activation is exercised too.
 *   node scripts/interaction-check.mjs [--server URL]
 */
import { serverUrl, runBrowserCheck, signUpInPage } from './lib/browser.mjs'

const server = serverUrl()

process.exit(await runBrowserCheck({ title: 'File interactions check', network: true }, async (page, check) => {
  await page.navigate(server + '/')
  const session = await signUpInPage(page, { prefix: 'interaction', password: 'interaction check password' })
  check('signed in', Boolean(session.token))

  const seeded = await page.run(async () => {
    const headers = { authorization: 'Bearer ' + localStorage.getItem('mdrive-token') }
    const upload = async (name, type, body) => {
      const response = await fetch('/api/v1/uploads?name=' + encodeURIComponent(name), {
        method: 'PUT', headers: { ...headers, 'content-type': type }, body,
      })
      if (!response.ok) throw new Error('upload failed: ' + name)
      return (await response.json()).node.id
    }
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5h8AAAAASUVORK5CYII='), (c) => c.charCodeAt(0))
    const ids = {
      png: await upload('thumbnail.png', 'image/png', png),
      svg: await upload('vector.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'),
      gif: await upload('animation.gif', 'image/gif', 'GIF89a'),
      tiff: await upload('scan.tiff', 'image/tiff', 'placeholder'),
      first: await upload('notes-a.txt', 'text/plain', 'first'),
      second: await upload('notes-b.txt', 'text/plain', 'second'),
      survivor: await upload('survivor.txt', 'text/plain', 'keep'),
    }
    const response = await fetch('/api/v1/nodes', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Folder', kind: 'folder' }),
    })
    ids.folder = (await response.json()).node.id
    return ids
  })
  const key = async (name, code, virtualKey) => {
    const params = { key: name, code, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey }
    const text = name === 'Enter' ? '\r' : name === ' ' ? ' ' : undefined
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...params, ...(text ? { text, unmodifiedText: text } : {}) })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
  }
  const focus = (id, child = '') => page.run((nodeId, selector) => {
    const row = document.querySelector('[data-id="' + nodeId + '"]')
    const target = selector ? row.querySelector(selector) : row
    target.focus()
    return document.activeElement === target
  }, id, child)
  const select = (ids) => page.run((nodeIds) => {
    for (const id of nodeIds) document.querySelector('[data-id="' + id + '"] .pick').click()
  }, ids)
  const nodes = () => page.run(async () => (await (await fetch('/api/v1/nodes', {
    headers: { authorization: 'Bearer ' + localStorage.getItem('mdrive-token') },
  })).json()).nodes.map((node) => node.id))

  await page.reload()
  await page.waitFor("document.querySelectorAll('.frow[data-id]').length === 8")
  await page.waitFor("document.querySelector('.frow img')")
  check('list thumbnails defer dragging to the row', await page.evaluate("Array.from(document.querySelectorAll('.frow img')).every((img) => img.draggable === false)"))

  await focus(seeded.first)
  await key('F2', 'F2', 113)
  await page.waitFor("document.querySelector('.name-input')")
  const renaming = await page.run(() => {
    const input = document.querySelector('.name-input')
    const row = input.closest('.frow')
    input.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }))
    return { draggable: row.draggable, moving: document.body.classList.contains('is-moving') }
  })
  check('editing a name cannot start a row move', !renaming.draggable && !renaming.moving, JSON.stringify(renaming))
  await key('Escape', 'Escape', 27)
  check('ending rename restores row dragging', await page.run((id) => document.querySelector('[data-id="' + id + '"]').draggable, seeded.first))

  await page.run(() => localStorage.setItem('mdrive-view', 'grid'))
  await page.reload()
  await page.waitFor("document.querySelectorAll('.gcard[data-id]').length === 8")
  check('an unsupported image never truncates the grid', await page.evaluate("document.querySelectorAll('.gcard[data-id]').length") === 8)
  check('unsupported thumbnails retain their image icons', await page.run((ids) => ids.every((id) => {
    const card = document.querySelector('[data-id="' + id + '"]')
    return Boolean(card && card.querySelector('.thumb svg') && !card.querySelector('.thumb img'))
  }), [seeded.svg, seeded.gif, seeded.tiff]))
  await page.waitFor("document.querySelector('.gcard .thumb img')")
  check('grid thumbnails defer dragging to the card', await page.evaluate("Array.from(document.querySelectorAll('.gcard img')).every((img) => img.draggable === false)"))

  await select([seeded.first])
  await focus(seeded.png, '.gactions button[aria-label="加星标"]')
  await key('Enter', 'Enter', 13)
  await page.waitFor("document.querySelector('.gcard button[aria-label=\"取消星标\"]')")
  check('Enter activates the nested star without opening a preview', await page.evaluate("!document.querySelector('.preview-drawer') && document.querySelectorAll('.gcard .pick:checked').length === 1"))
  await focus(seeded.png, '.gactions button[aria-label="取消星标"]')
  await key(' ', 'Space', 32)
  await page.waitFor("!document.querySelector('.gcard button[aria-label=\"取消星标\"]')")
  check('Space activates the nested star without toggling row selection', await page.evaluate("!document.querySelector('.preview-drawer') && document.querySelectorAll('.gcard .pick:checked').length === 1"))

  await focus(seeded.svg, '.gactions button[aria-label="更多操作"]')
  await key('Enter', 'Enter', 13)
  await page.waitFor("document.querySelector('.menu')")
  check('Enter opens the nested menu without opening a preview', await page.evaluate("!document.querySelector('.preview-drawer')"))
  await key('Escape', 'Escape', 27)
  await page.waitFor("!document.querySelector('.menu')")
  await select([seeded.second])
  await focus(seeded.first)
  await key('Delete', 'Delete', 46)
  await page.waitFor("document.querySelector('.dialog h2')")
  check('Delete on a selected grid card targets the whole selection', await page.evaluate("document.querySelector('.dialog h2').textContent") === '删除 2 项')
  await page.run(() => Array.from(document.querySelectorAll('.dialog-foot button')).find((button) => button.textContent === '取消').click())
  await page.waitFor("!document.querySelector('.dialog:not(.is-closing)')")
  const unchanged = await nodes()
  check('cancelling batch deletion keeps both selected files', unchanged.includes(seeded.first) && unchanged.includes(seeded.second))
  await page.shot('interaction-01-grid')

  await page.run(() => localStorage.setItem('mdrive-view', 'list'))
  await page.reload()
  await page.waitFor("document.querySelectorAll('.frow[data-id]').length === 8")
  await select([seeded.first, seeded.second])
  await focus(seeded.second)
  await key('Delete', 'Delete', 46)
  await page.waitFor("document.querySelector('.dialog h2')")
  check('Delete on a selected list row targets the whole selection', await page.evaluate("document.querySelector('.dialog h2').textContent") === '删除 2 项')
  await page.run(() => Array.from(document.querySelectorAll('.dialog-foot button')).find((button) => button.textContent === '移到回收站').click())
  await page.waitFor("document.querySelectorAll('.frow[data-id]').length === 6")
  const remaining = await nodes()
  check('confirmed deletion removes both files and preserves unselected files', !remaining.includes(seeded.first) && !remaining.includes(seeded.second) && remaining.includes(seeded.survivor))
  await page.shot('interaction-02-list')
  await page.navigate(server + '/trash')
  await page.waitFor("document.querySelectorAll('.frow[data-id]').length === 2")
  await select([seeded.first, seeded.second])
  await focus(seeded.first)
  await key('Delete', 'Delete', 46)
  await page.waitFor("document.querySelector('.dialog h2')")
  check('Delete on selected trash rows asks to purge the whole selection', await page.evaluate("document.querySelector('.dialog h2').textContent") === '永久删除 2 项')
  await page.run(() => Array.from(document.querySelectorAll('.dialog-foot button')).find((button) => button.textContent === '取消').click())
  await page.waitFor("!document.querySelector('.dialog:not(.is-closing)')")
  check('cancelling a purge preserves both trash rows', await page.evaluate("document.querySelectorAll('.frow[data-id]').length") === 2)
  check('no console errors', page.consoleErrors.length === 0, page.consoleErrors.slice(0, 3).join(' | '))
  check('no failed requests', page.failedRequests.length === 0, page.failedRequests.slice(0, 3).join(' | '))
}))
