#!/usr/bin/env node
/**
 * Picture zoom check: the explicit 缩小 / 适应窗口 / 放大 controls in the preview
 * drawer.
 *
 *   node scripts/zoom-check.mjs [--server URL]
 *
 * What only a real browser can prove here:
 *   - the picture opens fitted (100%), and the multiplier is relative to the fit;
 *   - the three buttons and the double-click shortcut actually change the frame;
 *   - a drag at 200% moves the picture and stops at its edge instead of paging
 *     the gallery, while the arrow keys and a swipe still page it at fit;
 *   - moving to another picture resets the multiplier, and closing the drawer
 *     leaves no zoom behind.
 *
 * The fixture is a large picture with real detail: a flat 8x8 PNG would let a
 * broken downscale pass, and no edge would exist to pan against.
 */

import { serverUrl, runBrowserCheck, signUpInPage, sleep } from './lib/browser.mjs'
import { makePng } from './lib/png.mjs'

const server = serverUrl()

/** A 2400x1600 picture: big enough that 400% still has edges to pan to. */
const BIG = makePng(2400, 1600)
const SECOND = makePng(1800, 1200)

process.exit(await runBrowserCheck({ title: 'Picture zoom check', network: true }, async (page, check) => {
  await page.navigate(server + '/', { settle: 1300 })
  const session = await signUpInPage(page, { prefix: 'zoom', password: 'zoom check password' })
  check('signed in', typeof session.token === 'string' && session.token.length > 20)

  const ids = await page.run(async (pictures) => {
    const headers = { authorization: 'Bearer ' + localStorage.getItem('mdrive-token') }
    const ids = {}
    for (const [name, base64] of pictures) {
      const body = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const response = await fetch('/api/v1/uploads?name=' + encodeURIComponent(name), {
        method: 'PUT', headers: { ...headers, 'content-type': 'image/png' }, body,
      })
      ids[name] = (await response.json()).node.id
    }
    return ids
  }, [
    ['big.png', BIG.toString('base64')],
    ['second.png', SECOND.toString('base64')],
  ])
  await page.reload({ settle: 1800 })
  await page.waitFor("document.querySelectorAll('.frow[data-id]').length === 2", { label: 'the picture rows' })

  const open = async (name) => {
    await page.run((id) => document.querySelector('.frow[data-id="' + id + '"] .name').click(), ids[name])
    await page.waitFor('document.querySelector(".preview-drawer:not(.is-closing) .picture-canvas")')
    await sleep(500)
  }

  /** Everything the zoom UI is showing, read from the live DOM. */
  const zoomState = () => page.run(() => {
    const drawer = document.querySelector('.preview-drawer:not(.is-closing)')
    const canvas = drawer.querySelector('.picture-canvas')
    const frame = drawer.querySelector('.picture-frame')
    const bar = drawer.querySelector('.preview-zoom')
    const transform = canvas ? getComputedStyle(canvas).transform : ''
    const matrix = transform && transform !== 'none' ? transform.match(/matrix\(([^)]+)\)/) : null
    const parts = matrix ? matrix[1].split(',').map(Number) : []
    return {
      title: (drawer.querySelector('.title-text') || {}).textContent || '',
      barHidden: !bar || bar.hasAttribute('hidden'),
      value: (drawer.querySelector('.zoom-value') || {}).textContent || '',
      scale: parts.length === 6 ? parts[0] : 1,
      translateX: parts.length === 6 ? parts[4] : 0,
      zoomedClass: Boolean(frame && frame.classList.contains('is-zoomed')),
      outDisabled: (drawer.querySelector('[aria-label="缩小图片"]') || {}).getAttribute?.('aria-disabled') || null,
      inDisabled: (drawer.querySelector('[aria-label="放大图片"]') || {}).getAttribute?.('aria-disabled') || null,
      canvasWidth: canvas ? canvas.width : 0,
      frameWidth: frame ? frame.getBoundingClientRect().width : 0,
      frameHeight: frame ? frame.getBoundingClientRect().height : 0,
      pictureWidth: canvas ? canvas.getBoundingClientRect().width : 0,
      live: (drawer.querySelector('.preview-zoom [role="status"]') || {}).textContent || '',
    }
  })

  const clickButton = (label) => page.run((name) => {
    const button = document.querySelector('.preview-drawer [aria-label="' + name + '"]')
    if (!button) return false
    button.click()
    return true
  }, label)

  /* ── 1. it opens fitted, with the controls visible ───────────── */
  await open('big.png')
  const fitted = await zoomState()
  check('a large picture opens fitted at 100%', fitted.value === '100%' && Math.abs(fitted.scale - 1) < 0.02, JSON.stringify(fitted))
  check('the zoom controls are visible for a picture', fitted.barHidden === false, JSON.stringify(fitted))
  check('缩小 starts unavailable at fit', fitted.outDisabled === 'true', String(fitted.outDisabled))
  check('放大 is offered at fit', fitted.inDisabled === 'false', String(fitted.inDisabled))
  check('the decoded picture is bounded, not the 2400px original',
    fitted.canvasWidth > 0 && fitted.canvasWidth <= 1600, String(fitted.canvasWidth))

  /* ── 2. 放大 is a real, bounded step ───────────────────────── */
  await clickButton('放大图片')
  await sleep(220)
  const zoomed = await zoomState()
  check('放大 goes one stop up and prints the multiplier',
    zoomed.value === '150%' && Math.abs(zoomed.scale - 1.5) < 0.02, JSON.stringify(zoomed))
  check('the frame reports itself zoomed', zoomed.zoomedClass === true, JSON.stringify(zoomed))
  check('缩小 becomes available once zoomed', zoomed.outDisabled === 'false', String(zoomed.outDisabled))

  // 150% → 200% → 300% → 400%; one more click must not go past the ceiling.
  await clickButton('放大图片')
  await clickButton('放大图片')
  await clickButton('放大图片')
  await clickButton('放大图片')
  await sleep(260)
  const atMax = await zoomState()
  check('放大 stops at 400% instead of running away', atMax.value === '400%' && atMax.inDisabled === 'true', JSON.stringify(atMax))

  /* ── 3. 适应窗口 resets the multiplier and the pan ─────────── */
  await clickButton('适应窗口')
  await sleep(220)
  const backToFit = await zoomState()
  check('适应窗口 returns to 100%', backToFit.value === '100%' && Math.abs(backToFit.scale - 1) < 0.02, JSON.stringify(backToFit))
  check('适应窗口 clears the pan offset', Math.abs(backToFit.translateX) < 0.5, String(backToFit.translateX))
  check('适应窗口 clears the zoomed class', backToFit.zoomedClass === false, JSON.stringify(backToFit))

  /* ── 4. a real drag at 200% pans, and stops at the edge ─────── */
  await clickButton('放大图片')
  await clickButton('放大图片')
  await sleep(220)
  const beforeDrag = await zoomState()
  const centre = await page.run(() => {
    const rect = document.querySelector('.preview-drawer:not(.is-closing) .picture-frame').getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), width: rect.width }
  })
  const pointer = async (type, x, y) => page.send('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse',
  })
  await pointer('mousePressed', centre.x, centre.y)
  for (let step = 1; step <= 6; step += 1) {
    await pointer('mouseMoved', centre.x - step * 40, centre.y)
    await sleep(25)
  }
  await pointer('mouseReleased', centre.x - 240, centre.y)
  await sleep(260)
  const panned = await zoomState()
  check('dragging a zoomed picture moves it', Math.abs(panned.translateX - beforeDrag.translateX) > 10, JSON.stringify({ before: beforeDrag.translateX, after: panned.translateX }))
  check('a drag never pages the gallery', panned.title === 'big.png', panned.title)

  // Drag far past the edge: the offset must clamp to the real overflow of the
  // scaled layout box, not slide the picture out of the frame.
  await page.run(async () => {
    const frame = document.querySelector('.preview-drawer:not(.is-closing) .picture-frame')
    // Start again from the centre so the clamped value is a fresh reading.
    document.querySelector('.preview-drawer [aria-label="适应窗口"]').click()
    await new Promise((resolve) => setTimeout(resolve, 120))
    document.querySelector('.preview-drawer [aria-label="放大图片"]').click()
    document.querySelector('.preview-drawer [aria-label="放大图片"]').click()
    await new Promise((resolve) => setTimeout(resolve, 160))
    return Boolean(frame)
  })
  await pointer('mousePressed', centre.x, centre.y)
  for (let step = 1; step <= 8; step += 1) {
    await pointer('mouseMoved', centre.x + step * 300, centre.y)
    await sleep(20)
  }
  await pointer('mouseReleased', centre.x + 2400, centre.y)
  await sleep(260)
  const clamped = await zoomState()
  const layoutWidth = await page.evaluate("document.querySelector('.preview-drawer:not(.is-closing) .picture-canvas').offsetWidth")
  const expectedLimit = Math.max(0, (layoutWidth * clamped.scale - clamped.frameWidth) / 2)
  check('the pan stops at the picture edge', clamped.translateX <= expectedLimit + 1, JSON.stringify({ x: clamped.translateX, expectedLimit, layoutWidth, scale: clamped.scale }))
  check('a clamped pan still never pages the gallery', clamped.title === 'big.png', clamped.title)

  /* ── 4b. the same drag with a real finger ─────────────────── */
  // A touch pan must move the enlarged picture and must never be read as a
  // gallery swipe: this is the regression the gesture gate exists for.
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await page.run(async () => {
    document.querySelector('.preview-drawer [aria-label="适应窗口"]').click()
    await new Promise((resolve) => setTimeout(resolve, 120))
    document.querySelector('.preview-drawer [aria-label="放大图片"]').click()
    document.querySelector('.preview-drawer [aria-label="放大图片"]').click()
    await new Promise((resolve) => setTimeout(resolve, 160))
  })
  const touchStartState = await zoomState()
  await page.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: centre.x, y: centre.y, radiusX: 4, radiusY: 4, force: 1, id: 1 }],
  })
  for (let step = 1; step <= 6; step += 1) {
    await page.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: centre.x - step * 30, y: centre.y, radiusX: 4, radiusY: 4, force: 1, id: 1 }],
    })
    await sleep(30)
  }
  await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await sleep(300)
  const touchPan = await zoomState()
  check('a one-finger drag pans the zoomed picture', Math.abs(touchPan.translateX - touchStartState.translateX) > 10,
    JSON.stringify({ before: touchStartState.translateX, after: touchPan.translateX }))
  check('a one-finger drag while zoomed never changes the photo', touchPan.title === 'big.png', touchPan.title)
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: false })

  /* ── 5. reset restores paging, including the keyboard ──────── */
  await clickButton('适应窗口')
  await sleep(200)
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 })
  await sleep(1200)
  const moved = await zoomState()
  check('the arrow keys still page after resetting', moved.title === 'second.png', JSON.stringify(moved))
  check('the next picture opens fitted again', moved.value === '100%' && Math.abs(moved.scale - 1) < 0.02, JSON.stringify(moved))

  /* ── 6. double-click is the desktop shortcut ───────────────── */
  await page.run(() => {
    const frame = document.querySelector('.preview-drawer:not(.is-closing) .picture-frame')
    frame.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  })
  await sleep(220)
  const dbl = await zoomState()
  check('a double click zooms in', Math.abs(dbl.scale - 2) < 0.02 && dbl.value === '200%', JSON.stringify(dbl))
  await page.run(() => {
    const frame = document.querySelector('.preview-drawer:not(.is-closing) .picture-frame')
    frame.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  })
  await sleep(220)
  const dblBack = await zoomState()
  check('a second double click returns to fit', Math.abs(dblBack.scale - 1) < 0.02, JSON.stringify(dblBack))

  /* ── 7. wheel zooms, Ctrl+wheel does not ───────────────────── */
  await page.run(() => {
    const frame = document.querySelector('.preview-drawer:not(.is-closing) .picture-frame')
    const rect = frame.getBoundingClientRect()
    frame.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, bubbles: true, cancelable: true }))
  })
  await sleep(220)
  const wheeled = await zoomState()
  check('a plain wheel zooms the picture', wheeled.scale > 1 && wheeled.zoomedClass === true, JSON.stringify(wheeled))

  await page.run(() => {
    const frame = document.querySelector('.preview-drawer:not(.is-closing) .picture-frame')
    const rect = frame.getBoundingClientRect()
    frame.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, ctrlKey: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, bubbles: true, cancelable: true }))
  })
  await sleep(220)
  const ctrlWheel = await zoomState()
  check('Ctrl+wheel is left to the browser and does not change the picture', Math.abs(ctrlWheel.scale - wheeled.scale) < 0.01, JSON.stringify(ctrlWheel))

  await clickButton('适应窗口')
  await sleep(150)

  /* ── 8. closing resets the zoom for the next open ─────────── */
  await clickButton('放大图片')
  await sleep(200)
  await page.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  await sleep(700)
  check('Esc closes the drawer', await page.evaluate("!document.querySelector('.preview-drawer:not(.is-closing)')"))
  await open('big.png')
  const reopened = await zoomState()
  check('reopening starts fitted, never at the last multiplier',
    reopened.value === '100%' && Math.abs(reopened.scale - 1) < 0.02 && reopened.zoomedClass === false, JSON.stringify(reopened))

  /* ── 9. loading, broken and non-picture states offer nothing ── */
  await page.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  await sleep(600)
  const edgeCases = await page.run(async () => {
    const { openPreview } = await import('/lib/preview.js')
    const base = { kind: 'file', mime: 'image/png', size: 4096, version: 1 }

    // (a) a request that never answers: the spinner is up, so the controls are not.
    const realFetch = window.fetch
    window.fetch = (input, init) => (String(input).includes('zoom-loading') ? new Promise(() => {}) : realFetch(input, init))
    openPreview({ ...base, id: 'zoom-loading', name: 'loading.png' }, {})
    await new Promise((resolve) => setTimeout(resolve, 700))
    const loading = document.querySelector('.preview-drawer:not(.is-closing)')
    const loadingState = {
      spinner: Boolean(loading.querySelector('.picture-spinner')),
      barHidden: loading.querySelector('.preview-zoom').hasAttribute('hidden'),
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    window.fetch = realFetch
    await new Promise((resolve) => setTimeout(resolve, 500))

    // (b) a broken picture: the error card is shown and no zoom is offered.
    openPreview({ ...base, id: 'zoom-broken', name: 'broken.png' }, {})
    await new Promise((resolve) => setTimeout(resolve, 1400))
    const broken = document.querySelector('.preview-drawer:not(.is-closing)')
    const brokenState = {
      notice: Boolean(broken.querySelector('.empty')),
      barHidden: broken.querySelector('.preview-zoom').hasAttribute('hidden'),
      canvas: Boolean(broken.querySelector('.picture-canvas')),
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 500))

    // (c) a non-picture: text has no zoom row at all.
    openPreview({ kind: 'file', id: 'zoom-text', name: 'note.txt', mime: 'text/plain', size: 12, version: 1 }, {})
    await new Promise((resolve) => setTimeout(resolve, 900))
    const text = document.querySelector('.preview-drawer:not(.is-closing)')
    const textState = { barHidden: text.querySelector('.preview-zoom').hasAttribute('hidden') }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 500))
    return { loadingState, brokenState, textState }
  })
  check('a loading picture offers no usable zoom',
    edgeCases.loadingState.spinner === true && edgeCases.loadingState.barHidden === true, JSON.stringify(edgeCases.loadingState))
  check('a broken picture falls back to a notice and hides the zoom',
    edgeCases.brokenState.notice === true && edgeCases.brokenState.barHidden === true, JSON.stringify(edgeCases.brokenState))
  check('a non-picture never shows the picture zoom row', edgeCases.textState.barHidden === true, JSON.stringify(edgeCases.textState))

  /* ── 10. 320 CSS px: every zoom control is reachable ──────── */
  await page.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 1, mobile: false })
  await page.navigate(server + '/', { settle: 1500 })
  await page.waitFor("document.querySelectorAll('.frow[data-id]').length === 2", { label: 'the rows at 320px' })
  await open('big.png')
  const narrow = await page.run(() => {
    const drawer = document.querySelector('.preview-drawer:not(.is-closing)')
    const bar = drawer.querySelector('.preview-zoom')
    const buttons = Array.from(bar.querySelectorAll('button')).map((button) => {
      const rect = button.getBoundingClientRect()
      return { label: button.getAttribute('aria-label'), w: rect.width, h: rect.height, left: rect.left, right: rect.right, bottom: rect.bottom }
    })
    const value = drawer.querySelector('.zoom-value').getBoundingClientRect()
    return {
      buttons,
      value: { w: value.width, h: value.height, right: value.right },
      barWidth: bar.getBoundingClientRect().width,
      innerWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      drawerWidth: drawer.getBoundingClientRect().width,
    }
  })
  check('at 320px the zoom row stays inside the drawer',
    narrow.barWidth <= narrow.drawerWidth && narrow.documentWidth <= narrow.innerWidth, JSON.stringify(narrow))
  check('the multiplier is visible beside the controls',
    narrow.value.w > 0 && narrow.value.h > 0 && narrow.value.right <= 320, JSON.stringify(narrow.value))
  check('every zoom button is a 44px target inside 320px',
    narrow.buttons.length === 3 && narrow.buttons.every((box) => box.w >= 44 && box.h >= 44 && box.left >= 0 && box.right <= 320),
    JSON.stringify(narrow.buttons))
  await page.shot('zoom-320')
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false })

  check('no console errors', page.consoleErrors.length === 0, page.consoleErrors.slice(0, 3).join(' | '))
  check('no failed requests', page.failedRequests.length === 0, page.failedRequests.slice(0, 3).join(' | '))
}))