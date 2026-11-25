#!/usr/bin/env node
/**
 * Picture viewer layout check — the first-open geometry of the photo drawer.
 *
 *   node scripts/photo-viewer-check.mjs [--server URL]
 *
 * The reported baseline: at 1440x960 the picture box was only 559px wide and a
 * landscape photograph showed as 559x315; a 500x4600 GIF claimed a 4600px grid
 * row inside an 867px frame and was cropped by overflow:hidden; at 390x300 a
 * PNG 180-320px tall was cut by a 147px frame.
 *
 * This check is deliberately about geometry in a real browser, because that is
 * where the implicit-grid-track bug lived. It asserts:
 *
 *   - a picture's drawer takes the viewport, and a text/PDF drawer does not;
 *   - a normal large landscape photo is at least 1000px wide at 1440x960;
 *   - landscape, portrait, panorama and a very tall GIF all show four edges,
 *     inside the frame, at the right aspect ratio — and are not upscaled when
 *     the source is smaller than the box;
 *   - the same holds in a height-constrained 390x300 viewport;
 *   - the decode is still bounded (long edge <= 1600), the keyboard, focus,
 *     close, download entry, zoom and drag all still work.
 */

import { deflateSync } from 'node:zlib'
import { serverUrl, runBrowserCheck, signUpInPage, sleep } from './lib/browser.mjs'
import { makePng } from './lib/png.mjs'

const server = serverUrl()

/* ── a real GIF at any size ────────────────────────────────────────
 * The GIF path in preview.js is <img>, not createImageBitmap, so exercising it
 * needs actual GIF bytes — a PNG renamed .gif would take the bitmap path and
 * quietly stop testing what it claims to. Two colours, one frame, LZW encoded.
 */
function lzw(indices, minCodeSize) {
  const clear = 1 << minCodeSize
  const eoi = clear + 1
  let codeSize = minCodeSize + 1
  let dict = new Map()
  let next = eoi + 1
  const bytes = []
  let bits = 0
  let count = 0
  const emit = (code) => {
    bits |= code << count
    count += codeSize
    while (count >= 8) {
      bytes.push(bits & 0xff)
      bits >>= 8
      count -= 8
    }
  }
  emit(clear)
  let prefix = indices[0]
  for (let i = 1; i < indices.length; i += 1) {
    const ch = indices[i]
    const key = prefix * 4096 + ch
    if (dict.has(key)) {
      prefix = dict.get(key)
      continue
    }
    emit(prefix)
    dict.set(key, next)
    next += 1
    // The next emitted code may be the one just created, so the width grows
    // the moment the dictionary needs a wider code — not one pixel later.
    if (next > (1 << codeSize) && codeSize < 12) codeSize += 1
    if (next >= 4096) {
      emit(clear)
      dict = new Map()
      next = eoi + 1
      codeSize = minCodeSize + 1
    }
    prefix = ch
  }
  emit(prefix)
  emit(eoi)
  if (count > 0) bytes.push(bits & 0xff)
  return bytes
}

/** A flat two-colour GIF89a of exactly `width` x `height`. */
function makeGif(width, height) {
  const indices = new Uint8Array(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) indices[y * width + x] = (x >> 4) % 2
  }
  const data = lzw(indices, 2)
  const blocks = []
  for (let at = 0; at < data.length; at += 255) {
    const slice = data.slice(at, at + 255)
    blocks.push(Buffer.from([slice.length]), Buffer.from(slice))
  }
  const u16 = (value) => {
    const buffer = Buffer.alloc(2)
    buffer.writeUInt16LE(value & 0xffff, 0)
    return buffer
  }
  return Buffer.concat([
    Buffer.from('GIF89a', 'ascii'),
    u16(width), u16(height),
    Buffer.from([0x80, 0x00, 0x00]), // global colour table, 2 entries
    Buffer.from([0x10, 0x0c, 0x0f, 0xc0, 0x53, 0x3f]), // the two colours
    Buffer.from([0x2c, 0, 0, 0, 0]), u16(width), u16(height), Buffer.from([0x00]),
    Buffer.from([2]), // LZW minimum code size
    ...blocks,
    Buffer.from([0x00, 0x3b]),
  ])
}

/* ── fixtures ───────────────────────────────────────────────────── */
const FIXTURES = [
  // name, mime, bytes — sizes chosen so a wrong fit is visible in the numbers.
  ['landscape.png', 'image/png', makePng(4000, 3000), { w: 4000, h: 3000 }],
  ['portrait.png', 'image/png', makePng(1200, 2400), { w: 1200, h: 2400 }],
  ['panorama.png', 'image/png', makePng(4000, 800), { w: 4000, h: 800 }],
  ['tall.gif', 'image/gif', makeGif(500, 4600), { w: 500, h: 4600 }],
  ['small.png', 'image/png', makePng(300, 200), { w: 300, h: 200 }],
]
const EXPECT = Object.fromEntries(FIXTURES.map(([name, , , size]) => [name, size]))

process.exit(await runBrowserCheck({ title: 'Picture viewer layout check', network: true }, async (page, check) => {
  await page.navigate(server + '/', { settle: 1300 })
  const session = await signUpInPage(page, { prefix: 'photo-viewer', password: 'photo viewer check password' })
  check('signed in', typeof session.token === 'string' && session.token.length > 20)

  const seeded = await page.run(async (folders, fixtures) => {
    const token = localStorage.getItem('mdrive-token')
    const headers = { authorization: 'Bearer ' + token }
    const json = { ...headers, 'content-type': 'application/json' }
    const ids = {}
    for (const folderName of folders) {
      const created = await (await fetch('/api/v1/nodes', {
        method: 'POST', headers: json, body: JSON.stringify({ name: folderName, kind: 'folder' }),
      })).json()
      ids[folderName] = { id: created.node.id, rows: {} }
    }
    for (const [folderName, list] of fixtures) {
      for (const [name, mime, base64] of list) {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
        const response = await fetch('/api/v1/uploads?parentId=' + ids[folderName].id + '&name=' + encodeURIComponent(name), {
          method: 'PUT', headers: { ...headers, 'content-type': mime }, body: bytes,
        })
        ids[folderName].rows[name] = (await response.json()).node.id
      }
    }
    return ids
  }, ['照片', '单张'], [
    ['照片', [
      ...FIXTURES.map(([name, mime, bytes]) => [name, mime, bytes.toString('base64')]),
      ['notes.md', 'text/markdown', Buffer.from('# 说明\n\n这不是图片。\n').toString('base64')],
    ]],
    // One picture and nothing else: a gallery of one must still be a viewer.
    ['单张', [['only.png', 'image/png', makePng(4000, 3000).toString('base64')]]],
  ])
  check('fixtures seeded', Boolean(seeded['照片'] && seeded['单张']), JSON.stringify(seeded).slice(0, 120))

  /* ── read every box the layout produces, from the live DOM ─────── */
  const measure = () => page.run(() => {
    const panel = document.querySelector('.preview-drawer:not(.is-closing)')
    if (!panel) return { error: 'no drawer' }
    const frame = panel.querySelector('.picture-frame')
    const media = panel.querySelector('.picture-canvas,.picture-frame .preview-media')
    const box = (element) => {
      if (!element) return null
      const rect = element.getBoundingClientRect()
      return {
        left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
        width: rect.width, height: rect.height,
      }
    }
    const stage = panel.querySelector('.preview-stage')
    // The DECLARED track values: getComputedStyle resolves them to used pixels,
    // which is exactly what we do not want to assert on here — the declaration is
    // the fix, the used size is the result.
    const declaredTracks = () => {
      for (const sheet of Array.from(document.styleSheets)) {
        let rules
        try { rules = sheet.cssRules } catch { continue }
        for (const rule of Array.from(rules || [])) {
          if (rule.selectorText === '.photo-viewer .picture-frame') {
            return { columns: rule.style.gridTemplateColumns, rows: rule.style.gridTemplateRows }
          }
        }
      }
      return null
    }
    return {
      error: null,
      className: panel.className,
      title: (panel.querySelector('.title-text') || {}).textContent || '',
      viewport: { width: window.innerWidth, height: window.innerHeight },
      panel: box(panel),
      stage: box(stage),
      frame: box(frame),
      media: box(media),
      mediaTag: media ? media.tagName : null,
      natural: media && media.tagName === 'CANVAS' ? { width: media.width, height: media.height } : null,
      naturalSize: media && media.tagName === 'IMG' ? { width: media.naturalWidth, height: media.naturalHeight } : null,
      declaredTracks: declaredTracks(),
      zoom: {
        value: (panel.querySelector('.zoom-value') || {}).textContent || '',
        transform: media ? getComputedStyle(media).transform : '',
        barHidden: !panel.querySelector('.preview-zoom') || panel.querySelector('.preview-zoom').hasAttribute('hidden'),
      },
      controls: {
        close: Boolean(panel.querySelector('.drawer-head [aria-label="关闭"]')),
        download: Boolean(panel.querySelector('.drawer-head [aria-label="下载文件"]')),
        downloadFooter: Array.from(panel.querySelectorAll('.drawer-foot button')).some((button) => /下载/.test(button.textContent)),
        zoomIn: Boolean(panel.querySelector('[aria-label="放大图片"]')),
        focusInside: Boolean(document.activeElement && document.activeElement.closest('.preview-drawer')),
      },
    }
  })

  const openIn = async (folderName, fileName) => {
    await page.navigate(server + '/folder/' + seeded[folderName].id, { settle: 1200 })
    const id = seeded[folderName].rows[fileName]
    await page.run((nodeId) => document.querySelector('.frow[data-id="' + nodeId + '"] .name').click(), id)
    await page.waitFor('document.querySelector(".preview-drawer:not(.is-closing) .picture-frame")')
    await page.waitFor('document.querySelector(".preview-drawer:not(.is-closing) .picture-canvas,.preview-drawer:not(.is-closing) .preview-frame, .preview-drawer:not(.is-closing) img.preview-media")')
    await sleep(450)
    return measure()
  }

  const inside = (inner, outer, tolerance = 1) => Boolean(inner && outer)
    && inner.left >= outer.left - tolerance
    && inner.top >= outer.top - tolerance
    && inner.right <= outer.right + tolerance
    && inner.bottom <= outer.bottom + tolerance

  const ratioOf = (rect) => (rect && rect.height > 0 ? rect.width / rect.height : 0)

  const closeDrawer = async () => {
    await page.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
    await sleep(500)
  }

  /* ══ 1. desktop 1440x960 ═══════════════════════════════════════ */
  const landscape = await openIn('照片', 'landscape.png')
  check('the drawer opens for the clicked picture', landscape.error === null && landscape.title === 'landscape.png', JSON.stringify(landscape).slice(0, 160))
  check('a picture drawer carries the photo-viewer layout class', /photo-viewer/.test(landscape.className), landscape.className)
  check('the panel takes the whole viewport',
    landscape.panel && Math.abs(landscape.panel.width - landscape.viewport.width) < 2
    && Math.abs(landscape.panel.height - landscape.viewport.height) < 2,
    JSON.stringify({ panel: landscape.panel, viewport: landscape.viewport }))
  check('the picture frame has a real box, not an intrinsic one',
    landscape.frame && landscape.frame.width > 1000 && landscape.frame.height > 500,
    JSON.stringify(landscape.frame))
  // The reported bug: 559px of width for a 4000px photograph.
  check('a large landscape photo is at least 1000px wide at 1440x960',
    landscape.media && landscape.media.width >= 1000, JSON.stringify(landscape.media))
  console.log('       desktop picture box: ' + JSON.stringify({
    frame: Math.round(landscape.frame.width) + 'x' + Math.round(landscape.frame.height),
    drawn: Math.round(landscape.media.width) + 'x' + Math.round(landscape.media.height),
  }))
  check('the landscape photo is fully inside the frame', inside(landscape.media, landscape.frame), JSON.stringify({ media: landscape.media, frame: landscape.frame }))
  check('the landscape photo keeps its 4:3 shape', Math.abs(ratioOf(landscape.media) - 4 / 3) < 0.02, String(ratioOf(landscape.media)))
  check('both frame tracks are declared as minmax(0,1fr)',
    landscape.declaredTracks
    && /minmax\(0(px)?\s*,\s*1fr\)/.test(String(landscape.declaredTracks.columns))
    && /minmax\(0(px)?\s*,\s*1fr\)/.test(String(landscape.declaredTracks.rows)),
    JSON.stringify(landscape.declaredTracks))
  check('the decode is still bounded to the 1600px ceiling',
    landscape.natural && landscape.natural.width > 0 && landscape.natural.width <= 1600 && landscape.natural.height <= 1600,
    JSON.stringify(landscape.natural))
  check('focus is inside the drawer', landscape.controls.focusInside === true, JSON.stringify(landscape.controls))
  check('the close and both download entries survive', landscape.controls.close && landscape.controls.download && landscape.controls.downloadFooter, JSON.stringify(landscape.controls))
  await page.shot('photo-viewer-01-landscape')

  const portrait = await openIn('照片', 'portrait.png')
  check('a portrait photo fits the frame height', inside(portrait.media, portrait.frame) && portrait.media.height >= portrait.frame.height - 2, JSON.stringify({ media: portrait.media, frame: portrait.frame }))
  check('the portrait photo keeps its 1:2 shape', Math.abs(ratioOf(portrait.media) - 0.5) < 0.02, String(ratioOf(portrait.media)))
  await page.shot('photo-viewer-02-portrait')

  const panorama = await openIn('照片', 'panorama.png')
  check('a panorama fits four sides and the full width', inside(panorama.media, panorama.frame) && Math.abs(panorama.media.width - panorama.frame.width) < 2, JSON.stringify({ media: panorama.media, frame: panorama.frame }))
  check('the panorama keeps its 5:1 shape', Math.abs(ratioOf(panorama.media) - 5) < 0.05, String(ratioOf(panorama.media)))

  const tallGif = await openIn('照片', 'tall.gif')
  // The baseline: an <img> laid out 4600px tall inside an 867px frame.
  check('a tall GIF is laid out inside the frame, not at its 4600px height',
    tallGif.mediaTag === 'IMG' && tallGif.media && tallGif.media.height < 4600 && tallGif.media.height <= tallGif.frame.height + 1,
    JSON.stringify({ media: tallGif.media, frame: tallGif.frame, tag: tallGif.mediaTag }))
  check('the tall GIF shows all four edges', inside(tallGif.media, tallGif.frame), JSON.stringify({ media: tallGif.media, frame: tallGif.frame }))
  check('the tall GIF keeps its 500:4600 shape', Math.abs(ratioOf(tallGif.media) - 500 / 4600) < 0.01, String(ratioOf(tallGif.media)))
  check('the animated picture still uses the browser image path', tallGif.mediaTag === 'IMG' && tallGif.naturalSize && tallGif.naturalSize.height === 4600, JSON.stringify(tallGif.naturalSize))
  await page.shot('photo-viewer-03-tall-gif')

  const small = await openIn('照片', 'small.png')
  check('a small picture is not blown up to fill the viewer',
    small.media && Math.abs(small.media.width - 300) < 4 && Math.abs(small.media.height - 200) < 4,
    JSON.stringify(small.media))
  check('the small picture keeps its own proportions', Math.abs(ratioOf(small.media) - 1.5) < 0.03, String(ratioOf(small.media)))

  /* ── a gallery of one is still a viewer ───────────────────────── */
  const single = await openIn('单张', 'only.png')
  check('a single picture in its folder still opens as a viewer', /photo-viewer/.test(single.className) && single.panel.width === single.viewport.width, JSON.stringify({ cls: single.className, panel: single.panel }))
  check('the single picture is contained too', inside(single.media, single.frame), JSON.stringify({ media: single.media, frame: single.frame }))

  /* ── a non-picture gets the full-surface reader ─────────────────
   * Text is read, so it takes the whole surface like the picture viewer does;
   * the line measure, not the panel, is what stays narrow. */
  await page.navigate(server + '/folder/' + seeded['照片'].id, { settle: 1100 })
  await page.run((id) => document.querySelector('.frow[data-id="' + id + '"] .name').click(), seeded['照片'].rows['notes.md'])
  await page.waitFor("document.querySelector('.preview-drawer:not(.is-closing) .preview-md')")
  await sleep(300)
  const text = await page.run(() => {
    const panel = document.querySelector('.preview-drawer:not(.is-closing)')
    const rect = panel.getBoundingClientRect()
    const body = panel.querySelector('.preview-text, .preview-md')
    const measure = body ? body.getBoundingClientRect() : null
    return {
      className: panel.className,
      width: rect.width,
      viewport: window.innerWidth,
      photoClass: panel.classList.contains('photo-viewer'),
      readerClass: panel.classList.contains('reader-viewer'),
      picture: Boolean(panel.querySelector('.picture-frame')),
      measure: measure ? { width: measure.width } : null,
    }
  })
  check('a text preview never gets the picture layout', text.photoClass === false && text.picture === false, JSON.stringify(text))
  check('a text preview opens the full-surface reader', text.readerClass === true, JSON.stringify(text))
  check('the reader fills the viewport', Math.abs(text.width - text.viewport) <= 2, JSON.stringify(text))
  check('the reading measure is set but stays narrow', text.measure !== null && text.measure.width > 0 && text.measure.width <= 800, JSON.stringify(text.measure))
  await page.shot('photo-viewer-04-text-drawer')
  await closeDrawer()
  check('Esc still closes the drawer', await page.evaluate("!document.querySelector('.preview-drawer:not(.is-closing)')"))

  /* ══ 2. zoom and drag still work inside the new frame ══════════ */
  const zoomed = await openIn('照片', 'landscape.png')
  const frameCentre = await page.run(() => {
    const rect = document.querySelector('.preview-drawer:not(.is-closing) .picture-frame').getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  })
  await page.run(() => document.querySelector('.preview-drawer [aria-label="放大图片"]').click())
  await sleep(240)
  const at150 = await measure()
  check('放大 still steps to 150% in the new frame', at150.zoom.value === '150%', JSON.stringify(at150.zoom))
  const pointer = (type, x, y) => page.send('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse',
  })
  await pointer('mousePressed', frameCentre.x, frameCentre.y)
  for (let step = 1; step <= 5; step += 1) {
    await pointer('mouseMoved', frameCentre.x - step * 30, frameCentre.y)
    await sleep(20)
  }
  await pointer('mouseReleased', frameCentre.x - 150, frameCentre.y)
  await sleep(220)
  const panned = await measure()
  check('a zoomed picture can still be dragged', panned.zoom.transform !== at150.zoom.transform, JSON.stringify({ before: at150.zoom.transform, after: panned.zoom.transform }))
  check('a drag never pages the gallery', panned.title === 'landscape.png', panned.title)
  await page.run(() => document.querySelector('.preview-drawer [aria-label="适应窗口"]').click())
  await sleep(200)
  const fitted = await measure()
  check('适应窗口 returns to fit', fitted.zoom.value === '100%' && (fitted.zoom.transform === 'none' || fitted.zoom.transform === 'matrix(1, 0, 0, 1, 0, 0)'), JSON.stringify(fitted.zoom))
  // Arrow keys still page, and the next picture keeps the viewer layout.
  for (const type of ['keyDown', 'keyUp']) {
    await page.send('Input.dispatchKeyEvent', { type, key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 })
  }
  await sleep(900)
  const next = await measure()
  // The list is name-sorted, so the picture after landscape.png is panorama.png
  // (notes.md is skipped). Assert that it moved and stayed a viewer, rather than
  // pinning the whole sort order into the layout check.
  check('→ still moves to the next picture in the new layout',
    next.title !== 'landscape.png' && next.title.endsWith('.png') && /photo-viewer/.test(next.className),
    JSON.stringify({ title: next.title, cls: next.className }))
  check('the next picture is contained as well', inside(next.media, next.frame), JSON.stringify({ media: next.media, frame: next.frame }))
  await closeDrawer()

  /* ══ 3. the height-constrained 390x300 viewport ════════════════ */
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 300, deviceScaleFactor: 1, mobile: false })
  await sleep(400)
  for (const name of ['tall.gif', 'portrait.png', 'small.png']) {
    const shot = await openIn('照片', name)
    const expected = EXPECT[name]
    check('390x300: the frame fits the small viewport', shot.frame && shot.frame.width <= 390 && shot.frame.height <= 300 && shot.frame.width > 0, JSON.stringify({ frame: shot.frame, viewport: shot.viewport }))
    check('390x300: ' + name + ' shows all four edges', inside(shot.media, shot.frame), JSON.stringify({ media: shot.media, frame: shot.frame }))
    check('390x300: ' + name + ' is not cropped by an intrinsic track',
      shot.media.height <= shot.frame.height + 1 && shot.media.width <= shot.frame.width + 1,
      JSON.stringify({ media: shot.media, frame: shot.frame }))
    const wanted = Math.min(shot.frame.width / expected.w, shot.frame.height / expected.h)
    const drawn = Math.max(shot.media.width / expected.w, shot.media.height / expected.h)
    // Small sources stay at their own size; everything else is contain-fitted.
    check('390x300: ' + name + ' is contain-fitted, not stretched',
      Math.abs(drawn - Math.min(1, wanted)) < 0.03, JSON.stringify({ wanted, drawn }))
    if (name === 'tall.gif') await page.shot('photo-viewer-05-narrow')
    await closeDrawer()
  }

  // 320x300: the narrowest window this viewer has to survive. Nothing may be
  // pushed sideways or cropped away, and the controls keep their tap heights.
  await page.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 300, deviceScaleFactor: 1, mobile: false })
  await sleep(400)
  const tiny = await openIn('照片', 'tall.gif')
  check('320x300: the tall GIF still shows four edges', inside(tiny.media, tiny.frame), JSON.stringify({ media: tiny.media, frame: tiny.frame }))
  check('320x300: the viewer never overflows horizontally',
    await page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth') <= 0)
  await page.shot('photo-viewer-06-tiny')
  await closeDrawer()

  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false })
  await sleep(300)

  const overflow = await page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
  check('the viewer never adds horizontal page overflow', overflow <= 0, String(overflow))
  check('the photo stylesheet is actually loaded',
    await page.evaluate("Array.from(document.styleSheets).some((sheet) => /photo-viewer\\.css$/.test(sheet.href || ''))"))
  check('no console errors', page.consoleErrors.length === 0, page.consoleErrors.slice(0, 3).join(' | '))
  check('no failed requests', page.failedRequests.length === 0, page.failedRequests.slice(0, 3).join(' | '))
}))
