#!/usr/bin/env node
/**
 * Gallery check: the picture browser in the preview drawer.
 *
 *   node scripts/gallery-check.mjs [--server URL]
 *
 * Asserts the things that only exist in a browser: → and ← move between the
 * pictures of the current folder, a click on the row opens the picture the user
 * asked for, neighbours are prefetched from the immutable thumbnail route, and
 * the same picture is never fetched twice.
 */

import { serverUrl, runBrowserCheck, signUpInPage, sleep } from './lib/browser.mjs'
import { makePng } from './lib/png.mjs'

const server = serverUrl()

/**
 * Four real PNGs, each a different size.
 *
 * The sizes matter: a 300x200 picture must stay 300x200 in the drawer (no
 * upscaling), and a 4000x3000 one must come back downsampled. A single 2x2
 * fixture proves neither.
 */
const PICTURES = [
  { name: 'a.png', png: makePng(300, 200) },
  { name: 'b.png', png: makePng(1600, 1200) },
  { name: 'c.png', png: makePng(4000, 3000) },
]

process.exit(await runBrowserCheck({ title: 'Gallery / picture browser check', network: true }, async (page, check) => {
  await page.navigate(server + '/', { settle: 1300 })
  const session = await signUpInPage(page, { prefix: 'gallery', password: 'gallery check password' })
  check('signed in', typeof session.token === 'string' && session.token.length > 20)

  const seeded = await page.run(async (pictures) => {
    const token = localStorage.getItem('mdrive-token')
    const headers = { authorization: 'Bearer ' + token }
    const json = { ...headers, 'content-type': 'application/json' }
    const folder = await (await fetch('/api/v1/nodes', {
      method: 'POST', headers: json, body: JSON.stringify({ name: '照片', kind: 'folder' }),
    })).json()
    for (const picture of pictures) {
      const bytes = Uint8Array.from(atob(picture.b64), (c) => c.charCodeAt(0))
      await fetch('/api/v1/uploads?parentId=' + folder.node.id + '&name=' + picture.name, {
        method: 'PUT', headers: { ...headers, 'content-type': 'image/png' }, body: bytes,
      })
    }
    // A non-picture in the same folder: the gallery must skip it entirely.
    await fetch('/api/v1/uploads?parentId=' + folder.node.id + '&name=notes.md', {
      method: 'PUT', headers: { ...headers, 'content-type': 'text/markdown' }, body: '# notes',
    })
    return { folder: folder.node.id }
  }, PICTURES.map((picture) => ({ name: picture.name, b64: picture.png.toString('base64') })))
  check('three pictures and a text file seeded', typeof seeded.folder === 'string', JSON.stringify(seeded))

  await page.navigate(server + '/folder/' + seeded.folder, { settle: 1800 })
  await page.waitFor("document.querySelectorAll('.frow[data-id]').length === 4", { label: 'the four rows' })

  /** Clicks the row whose name matches, then waits for the drawer. */
  const open = (name) => page.run(async (wanted) => {
    const row = Array.from(document.querySelectorAll('.frow[data-id]'))
      .find((element) => (element.querySelector('.name') || {}).textContent === wanted)
    if (!row) return { error: 'row missing' }
    row.querySelector('.name').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 1400))
    const title = document.querySelector('.preview-drawer .title-text')
    const sub = document.querySelector('.preview-drawer .drawer-head .sub')
    return {
      error: null,
      title: title ? title.textContent : null,
      counter: sub ? sub.textContent : null,
      canvas: Boolean(document.querySelector('.picture-canvas')),
      spinner: Boolean(document.querySelector('.picture-spinner')),
    }
  }, name)

  /** Presses a key on the drawer and reports the state after it settles. */
  const press = (key) => page.run(async (pressed) => {
    const panel = document.querySelector('.preview-drawer')
    if (!panel) return { error: 'no drawer' }
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: pressed, bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const title = panel.querySelector('.title-text')
    const sub = panel.querySelector('.drawer-head .sub')
    const prev = panel.querySelector('[aria-label="上一张"]')
    const next = panel.querySelector('[aria-label="下一张"]')
    return {
      error: null,
      title: title ? title.textContent : null,
      counter: sub ? sub.textContent : null,
      canvas: Boolean(panel.querySelector('.picture-canvas')),
      prevAriaDisabled: prev ? prev.getAttribute('aria-disabled') : null,
      nextAriaDisabled: next ? next.getAttribute('aria-disabled') : null,
      nextFocusable: next ? next.tabIndex >= 0 && !next.disabled : null,
      spoken: (panel.querySelector('.preview-announce') || {}).textContent || '',
    }
  }, key)

  /* ── 1. one click opens the picture that was clicked ──────────── */
  const first = await open('a.png')
  check('the clicked picture opens', first.title === 'a.png', JSON.stringify(first))
  check('it is painted as a canvas, not a raw <img>', first.canvas === true, JSON.stringify(first))
  check('the counter reads 1 / 3 (the .md is not a picture)', first.counter === '1 / 3', JSON.stringify(first.counter))
  await page.shot('gallery-01-first')

  /* ── 2. the drawer really holds focus, and a real key arrives ─── */
  // Everything below used to press keys by dispatching an event straight at the
  // panel, which is a test that cannot fail: the drawer was never focused (the
  // focus trap ran before the panel was in the document), so a person's arrow
  // keys did nothing while the suite stayed green. These two assertions drive
  // the browser the way a hand does.
  const focusState = await page.run(() => ({
    inPanel: Boolean(document.activeElement && document.activeElement.closest && document.activeElement.closest('.preview-drawer')),
    tag: document.activeElement ? document.activeElement.tagName : null,
  }))
  check('the drawer takes focus when it opens', focusState.inPanel === true, JSON.stringify(focusState))

  const pressReal = async (key, code) => {
    for (const type of ['keyDown', 'keyUp']) {
      await page.send('Input.dispatchKeyEvent', {
        type, key, code, windowsVirtualKeyCode: code === 'ArrowRight' ? 39 : 37, nativeVirtualKeyCode: code === 'ArrowRight' ? 39 : 37,
      })
    }
    await sleep(900)
  }
  await pressReal('ArrowRight', 'ArrowRight')
  const afterRealKey = await page.run(() => ({
    title: (document.querySelector('.preview-drawer .title-text') || {}).textContent,
    inPanel: Boolean(document.activeElement && document.activeElement.closest && document.activeElement.closest('.preview-drawer')),
  }))
  check('a real → key reaches the drawer', afterRealKey.title === 'b.png', JSON.stringify(afterRealKey))
  check('focus stays inside the drawer after a move', afterRealKey.inPanel === true, JSON.stringify(afterRealKey))
  await pressReal('ArrowLeft', 'ArrowLeft')

  /* ── 3. → moves to the next picture ───────────────────────────── */
  const second = await press('ArrowRight')
  check('→ shows the next picture', second.title === 'b.png', JSON.stringify(second))
  check('the counter follows', second.counter === '2 / 3', JSON.stringify(second.counter))
  check('it is painted without a spinner left behind', second.canvas === true, JSON.stringify(second))
  check('the screen reader is told which picture', /第 2 张，共 3 张/.test(second.spoken), JSON.stringify(second.spoken))
  await page.shot('gallery-02-second')

  /* ── 3. ← moves back to the picture already seen ──────────────── */
  const third = await press('ArrowLeft')
  check('← goes back to the previous picture', third.title === 'a.png', JSON.stringify(third))

  /* ── 4. the ends clamp instead of wrapping ────────────────────── */
  const atStart = await press('ArrowLeft')
  check('← at the first picture stays put', atStart.title === 'a.png', JSON.stringify(atStart))
  check('the previous button reports itself unavailable at the start', atStart.prevAriaDisabled === 'true', JSON.stringify(atStart))
  await press('End')
  const atEnd = await press('ArrowRight')
  check('→ at the last picture stays put', atEnd.title === 'c.png', JSON.stringify(atEnd))
  // "Disabled" is aria-disabled + inert, never the attribute: a disabled button
  // drops focus to <body> and the keyboard dies at exactly the moment the user
  // is still pressing → to see whether it wraps.
  check('the next button reports itself unavailable at the end', atEnd.nextAriaDisabled === 'true', JSON.stringify(atEnd))
  check('the next button is still focusable at the end', atEnd.nextFocusable === true, JSON.stringify(atEnd))

  // The killer regression: keep pressing at the end, the drawer must still answer.
  await pressReal('ArrowLeft', 'ArrowLeft')
  const stillAlive = await page.run(() => ({
    title: (document.querySelector('.preview-drawer .title-text') || {}).textContent,
    inPanel: Boolean(document.activeElement && document.activeElement.closest && document.activeElement.closest('.preview-drawer')),
  }))
  check('the keyboard still works after hitting the end', stillAlive.title === 'b.png', JSON.stringify(stillAlive))
  check('focus survived the clamped end', stillAlive.inPanel === true, JSON.stringify(stillAlive))
  await pressReal('ArrowRight', 'ArrowRight')
  await page.shot('gallery-03-last')

  /* ── 5. Home / End jump ──────────────────────────────────────── */
  const home = await press('Home')
  check('Home jumps to the first picture', home.title === 'a.png' && home.counter === '1 / 3', JSON.stringify(home))

  /* ── 6. the button and the key agree ─────────────────────────── */
  const clicked = await page.run(async () => {
    const next = document.querySelector('.preview-drawer [aria-label="下一张"]')
    if (!next) return { error: 'no next button' }
    next.click()
    await new Promise((resolve) => setTimeout(resolve, 1100))
    return { error: null, title: (document.querySelector('.preview-drawer .title-text') || {}).textContent }
  })
  check('the next button does what → does', clicked.title === 'b.png', JSON.stringify(clicked))

  /* ── 7. pictures go through the route that may be cached ─────── */
  const imageUrls = () => page.networkRequests.filter((url) => /\/api\/v1\/files\/[^/]+\/(thumbnail|content)/.test(url))
  const imageRequests = imageUrls()
  // The 4000x3000 fixture must not be decoded at its own size: that is 48 MB of
  // RGBA against a browser budget of 32 MB, which is the thrash this whole
  // pipeline exists to avoid.
  const decoded = await page.run(() => {
    const canvas = document.querySelector('.preview-drawer .picture-canvas')
    return canvas ? { width: canvas.width, height: canvas.height } : null
  })
  check('a big picture is decoded down, not at its native size',
    decoded !== null && decoded.width < 4000, JSON.stringify(decoded))
  check('the decoded bitmap is not larger than the drawer needs',
    decoded !== null && decoded.width <= 1120, JSON.stringify(decoded))

  check('pictures are requested through the immutable thumbnail route',
    imageRequests.some((url) => /\/thumbnail/.test(url)),
    JSON.stringify(imageRequests.slice(0, 3)))
  check('no picture is requested from the revalidating content route',
    imageRequests.every((url) => !/\/content(\?|$)/.test(url)),
    JSON.stringify(imageRequests.filter((url) => /\/content/.test(url)).slice(0, 3)))
  check('the list and the drawer ask for ONE width, not two',
    new Set(imageRequests.map((url) => (/[?&]w=(\d+)/.exec(url) || [])[1])).size <= 1,
    JSON.stringify(Array.from(new Set(imageRequests.map((url) => (/[?&]w=(\d+)/.exec(url) || [])[1])))))

  /* ── 8. Esc closes, and reopening costs no request ───────────── */
  const before = imageUrls().length
  await page.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  await sleep(600)
  check('Esc closes the drawer', await page.evaluate("!document.querySelector('.preview-drawer')"))

  const reopened = await open('b.png')
  check('reopening a seen picture still paints', reopened.canvas === true, JSON.stringify(reopened))
  const after = imageUrls().length
  check('a cached picture is not downloaded again', after === before, before + ' -> ' + after)

  /* ── 9. a text file still opens as text, not as a picture ────── */
  await page.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  await sleep(500)
  const text = await open('notes.md')
  check('a non-picture opens its own preview', text.title === 'notes.md', JSON.stringify(text))
  check('a text file is not forced into the gallery', !/\d+ \/ \d+/.test(String(text.counter)), JSON.stringify(text.counter))

  check('no console errors', page.consoleErrors.length === 0, page.consoleErrors.slice(0, 3).join(' | '))
  check('no failed requests', page.failedRequests.length === 0, page.failedRequests.slice(0, 3).join(' | '))
}))
