#!/usr/bin/env node
/** Mobile preview regressions using Chromium's native touch input.
 *   node scripts/mobile-preview-check.mjs [--server URL]
 * Creates a throwaway account; never use an existing account's private files.
 */
import { runBrowserCheck, serverUrl, signUpInPage, sleep } from './lib/browser.mjs'
import { makePng } from './lib/png.mjs'

/**
 * A tiny but genuinely valid single-page PDF: catalog, page tree, one page with
 * a MediaBox and a font resource, one text object, and an xref table.
 *
 * Chrome refuses a "PDF" whose startxref/or the entry offsets are wrong, and a
 * refused document fails exactly like a broken preview, so the offsets are
 * measured from the bytes actually written instead of hand-counted.
 */
function makePdf() {
  const text = Buffer.from('BT /F1 22 Tf 72 700 Td (Mobile preview PDF) Tj ET\n', 'latin1')
  const bodies = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'latin1'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', 'latin1'),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', 'latin1'),
    Buffer.concat([
      Buffer.from('<< /Length ' + text.length + ' >>\nstream\n', 'latin1'),
      text,
      Buffer.from('endstream', 'latin1'),
    ]),
  ]
  const parts = [Buffer.from('%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n', 'latin1')]
  let at = parts[0].length
  const offsets = []
  bodies.forEach((body, index) => {
    offsets.push(at)
    const chunk = Buffer.concat([
      Buffer.from((index + 1) + ' 0 obj\n', 'latin1'),
      body,
      Buffer.from('\nendobj\n', 'latin1'),
    ])
    parts.push(chunk)
    at += chunk.length
  })
  const size = bodies.length + 1
  let xref = 'xref\n0 ' + size + '\n0000000000 65535 f \n'
  for (const offset of offsets) xref += String(offset).padStart(10, '0') + ' 00000 n \n'
  parts.push(Buffer.from(
    xref + 'trailer\n<< /Size ' + size + ' /Root 1 0 R >>\nstartxref\n' + at + '\n%%EOF\n',
    'latin1',
  ))
  return Buffer.concat(parts)
}

/**
 * Self-audit of the bytes above, so a broken fixture says so instead of
 * quietly looking like a broken preview. Checks the header, that every xref
 * entry points at its own "N 0 obj", and that startxref lands on the table.
 */
function validatePdf(bytes) {
  const text = bytes.toString('latin1')
  if (!text.startsWith('%PDF-1.')) return 'missing the %PDF header'
  if (!text.trimEnd().endsWith('%%EOF')) return 'missing the %%EOF trailer'
  const startxref = /startxref\s+(\d+)\s+%%EOF/.exec(text)
  if (!startxref) return 'missing startxref'
  const xrefAt = Number(startxref[1])
  if (text.slice(xrefAt, xrefAt + 4) !== 'xref') return 'startxref points at ' + JSON.stringify(text.slice(xrefAt, xrefAt + 12))
  const table = /\nxref\n0 (\d+)\n([\s\S]*?)\ntrailer/.exec(text)
  if (!table) return 'unreadable xref table'
  const entries = table[2].trimEnd().split('\n')
  if (entries.length !== Number(table[1])) return 'xref lists ' + entries.length + ' entries, /Size says ' + table[1]
  for (let index = 1; index < entries.length; index += 1) {
    const offset = Number(entries[index].slice(0, 10))
    if (text.slice(offset, offset + (String(index) + ' 0 obj').length) !== index + ' 0 obj') {
      return 'object ' + index + ' offset ' + offset + ' does not land on its header'
    }
  }
  if (!/\/MediaBox \[0 0 612 792\]/.test(text)) return 'the page has no MediaBox'
  if (!/\/Resources << \/Font << \/F1/.test(text)) return 'the page has no font resource'
  return null
}

const server = serverUrl()
const viewport = { width: 390, height: 844 }
// One document, uploaded once; its bytes are also self-audited below so a
// broken fixture is reported as a fixture problem, not a preview one.
const pdfBytes = makePdf()

process.exit(await runBrowserCheck({ title: 'Mobile preview check', network: true, viewport }, async (page, check) => {
  await page.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: true })
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await page.navigate(server + '/')
  const session = await signUpInPage(page, { prefix: 'mobile-preview', password: 'mobile preview check password' })
  check('signed in', Boolean(session.token))
  const pdfProblem = validatePdf(pdfBytes)
  check('the seeded PDF fixture is a well-formed one-page document', pdfProblem === null, pdfProblem)

  const seeded = await page.run(async (png, pdf) => {
    const headers = { authorization: 'Bearer ' + localStorage.getItem('mdrive-token') }
    const folderResponse = await fetch('/api/v1/nodes', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '手机预览', kind: 'folder' }),
    })
    if (!folderResponse.ok) throw new Error('Could not seed preview folder')
    const folder = (await folderResponse.json()).node.id
    const upload = async (name, type, body) => {
      const response = await fetch('/api/v1/uploads?parentId=' + folder + '&name=' + encodeURIComponent(name), {
        method: 'PUT', headers: { ...headers, 'content-type': type }, body,
      })
      if (!response.ok) throw new Error('Could not seed ' + name)
      return (await response.json()).node.id
    }
    const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0))
    const ids = { folder }
    for (const name of ['a.png', 'b.png', 'c.png']) ids[name] = await upload(name, 'image/png', bytes)
    ids.text = await upload('notes.txt', 'text/plain', 'First line\n' + 'A vertically scrollable document.\n'.repeat(150))
    // A real PDF, not a renamed blob: the drawer hands the bytes to Chrome's
    // viewer, so the iframe only proves anything if the document parses.
    ids.pdf = await upload('manual.pdf', 'application/pdf', Uint8Array.from(atob(pdf), c => c.charCodeAt(0)))

    // A valid short PCM WAV exercises the native audio controls without codecs
    // or fixtures downloaded from a third party.
    const wav = new ArrayBuffer(44 + 1600)
    const view = new DataView(wav)
    const ascii = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)) }
    ascii(0, 'RIFF'); view.setUint32(4, 1636, true); ascii(8, 'WAVE'); ascii(12, 'fmt ')
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
    view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
    ascii(36, 'data'); view.setUint32(40, 1600, true)
    ids.audio = await upload('sound.wav', 'audio/wav', wav)

    const canvas = document.createElement('canvas')
    canvas.width = 32; canvas.height = 32
    const context = canvas.getContext('2d')
    context.fillStyle = '#c85a46'; context.fillRect(0, 0, 32, 32)
    const stream = canvas.captureStream(10)
    const recorded = await new Promise((resolve, reject) => {
      const chunks = []
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' })
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data) }
      recorder.onerror = reject
      recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }))
      recorder.start()
      let frame = 0
      const timer = setInterval(() => {
        context.fillStyle = frame++ % 2 ? '#c85a46' : '#243b53'
        context.fillRect(0, 0, 32, 32)
      }, 75)
      setTimeout(() => { clearInterval(timer); recorder.stop() }, 450)
    })
    for (const track of stream.getTracks()) track.stop()
    ids.video = await upload('clip.webm', 'video/webm', recorded)
    return ids
  }, makePng(320, 240).toString('base64'), pdfBytes.toString('base64'))

  // 6 fixture rows + the PDF. The count is pinned on purpose: the picture
  // gallery must stay 3 pictures and "2 / 3" must keep meaning the same thing,
  // so lifting this number is the check that the PDF did not join the gallery.
  await page.navigate(server + '/folder/' + seeded.folder, { settle: 1200 })
  await page.waitFor("document.querySelectorAll('.frow[data-id]').length === 7", { label: 'the mobile fixture rows' })
  const folderPath = '/folder/' + seeded.folder
  const open = async (id) => {
    await page.run((id) => document.querySelector('.frow[data-id="' + id + '"] .name').click(), id)
    await page.waitFor("document.querySelector('.preview-drawer:not(.is-closing)')")
    await sleep(300)
  }
  const state = () => page.run(() => {
    const panel = document.querySelector('.preview-drawer:not(.is-closing)')
    return {
      title: panel?.querySelector('.title-text')?.textContent,
      counter: panel?.querySelector('.drawer-head .sub')?.textContent,
      scale: window.visualViewport?.scale || 1,
      path: location.pathname,
    }
  })
  const titleIs = async (name) => {
    await page.waitFor('document.querySelector(".preview-drawer:not(.is-closing) .title-text")?.textContent === ' + JSON.stringify(name))
    await page.waitFor('document.querySelector(".preview-drawer:not(.is-closing) .picture-canvas,.preview-drawer:not(.is-closing) .preview-media")')
  }
  const stage = () => page.run(() => {
    const rect = document.querySelector('.preview-body').getBoundingClientRect()
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, y: rect.top + rect.height / 2 }
  })
  const touch = (type, points) => page.send('Input.dispatchTouchEvent', {
    type, touchPoints: points.map((point, index) => ({ radiusX: 4, radiusY: 4, force: 1, id: index + 1, ...point })),
  })
  const swipe = async (from, to) => {
    await touch('touchStart', [from])
    for (let step = 1; step <= 6; step++) {
      await touch('touchMove', [{ x: from.x + (to.x - from.x) * step / 6, y: from.y + (to.y - from.y) * step / 6 }])
      await sleep(30)
    }
    await touch('touchEnd', [])
    await sleep(200)
  }
  const horizontal = async (direction) => {
    const box = await stage()
    const left = box.left + box.width * .22
    const right = box.left + box.width * .78
    await swipe({ x: direction > 0 ? right : left, y: box.y }, { x: direction > 0 ? left : right, y: box.y })
  }
  const close = async () => {
    await page.run(() => document.querySelector('.preview-drawer:not(.is-closing) [aria-label="关闭"]').click())
    await page.waitFor("!document.querySelector('.preview-drawer:not(.is-closing)')")
    await sleep(250)
  }

  await open(seeded['a.png'])
  await titleIs('a.png')
  check('a photo opens in the current folder', (await state()).path === folderPath)
  const buttonSizes = await page.run(() => Array.from(document.querySelectorAll('.preview-drawer .drawer-head .icon-btn')).map(button => {
    const rect = button.getBoundingClientRect()
    return { label: button.getAttribute('aria-label'), width: rect.width, height: rect.height }
  }))
  check('mobile preview controls have 44px touch targets', buttonSizes.every(button => button.width >= 44 && button.height >= 44), JSON.stringify(buttonSizes))

  await horizontal(1)
  const next = await state()
  check('a native left swipe opens the next photo', next.title === 'b.png' && next.counter === '2 / 3', JSON.stringify(next))
  await horizontal(-1)
  const previous = await state()
  check('a native right swipe returns to the previous photo', previous.title === 'a.png' && previous.counter === '1 / 3', JSON.stringify(previous))
  await horizontal(-1)
  check('swiping past the first photo does not wrap', (await state()).title === 'a.png')
  await horizontal(1)
  await titleIs('b.png')

  const box = await stage()
  await swipe({ x: box.left + box.width / 2, y: box.y + 80 }, { x: box.left + box.width / 2 + 8, y: box.y - 80 })
  check('a vertical gesture never changes the photo', (await state()).title === 'b.png')
  await swipe({ x: 5, y: box.y }, { x: 170, y: box.y })
  check('a gesture from the screen edge does not change the photo', (await state()).title === 'b.png')

  // Start at the middle picture so an accidental navigation is observable.
  const pinchStart = [{ x: box.left + box.width / 2 - 30, y: box.y }, { x: box.left + box.width / 2 + 30, y: box.y }]
  await touch('touchStart', pinchStart)
  for (let step = 1; step <= 4; step++) {
    await touch('touchMove', [{ x: pinchStart[0].x - step * 8, y: box.y }, { x: pinchStart[1].x + step * 8, y: box.y }])
    await sleep(35)
  }
  await touch('touchEnd', [])
  await sleep(200)
  check('a two-finger pinch never changes the photo', (await state()).title === 'b.png')
  await page.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 })

  await horizontal(1)
  await titleIs('c.png')
  await horizontal(1)
  const last = await state()
  check('swiping past the last photo does not wrap', last.title === 'c.png' && last.counter === '3 / 3', JSON.stringify(last))
  await page.shot('mobile-preview-01-gallery')
  await close()
  check('closing a preview returns to the same folder', await page.evaluate('location.pathname') === folderPath)

  await open(seeded.text)
  const textBox = await stage()
  await swipe({ x: textBox.left + textBox.width * .8, y: textBox.y }, { x: textBox.left + textBox.width * .2, y: textBox.y })
  check('document gestures do not enter the photo gallery', (await state()).title === 'notes.txt')
  await close()

  await open(seeded.audio)
  await page.waitFor("document.querySelector('.preview-drawer audio[controls]')?.readyState >= 2", { label: 'decoded audio in native player' })
  check('audio preview renders native playback controls', await page.evaluate("Boolean(document.querySelector('.preview-drawer audio[controls]'))"))
  await close()
  await open(seeded.video)
  await page.waitFor("document.querySelector('.preview-drawer video[controls]')?.readyState >= 2", { label: 'decoded video in native player' })
  check('video preview renders native inline playback controls', await page.evaluate("Boolean(document.querySelector('.preview-drawer video[controls][playsinline]'))"))
  const playback = await page.run(async () => {
    const video = document.querySelector('.preview-drawer video')
    video.muted = true
    await video.play()
    await new Promise(resolve => setTimeout(resolve, 120))
    video.pause()
    return { time: video.currentTime, error: video.error?.code || null }
  })
  check('the inline video can actually play', playback.time > 0 && !playback.error, JSON.stringify(playback))
  await page.shot('mobile-preview-02-video')
  await close()
  check('media preview closes back to the same folder', await page.evaluate('location.pathname') === folderPath)

  /* ── the PDF reading surface ───────────────────────────────────
   * A PDF is read, not viewed: the drawer has to be the window, and the frame
   * inside it has to be big enough to actually read a page. The widths below
   * are the reported ones — a desktop window, a phone, and the smallest phone
   * that must still lay out without a sideways scroll.
   */
  const realKey = async (key, code, virtualKeyCode) => {
    for (const type of ['keyDown', 'keyUp']) {
      await page.send('Input.dispatchKeyEvent', {
        type, key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode,
      })
    }
  }
  const pdfState = () => page.run(() => {
    const panel = document.querySelector('.preview-drawer:not(.is-closing)')
    const frame = panel && panel.querySelector('iframe.preview-frame')
    const rect = frame ? frame.getBoundingClientRect() : null
    const panelRect = panel ? panel.getBoundingClientRect() : null
    return {
      open: Boolean(frame),
      title: panel ? (panel.querySelector('.title-text') || {}).textContent : null,
      className: panel ? panel.className : '',
      counter: panel ? Boolean(panel.querySelector('.drawer-head .sub') || panel.querySelector('.preview-nav:not([hidden])')) : false,
      frame: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom } : null,
      panel: panelRect ? { left: panelRect.left, width: panelRect.width, right: panelRect.right } : null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scrollWidth: document.documentElement.scrollWidth,
    }
  })
  const focusPdfRow = () => page.run((id) => {
    const row = document.querySelector('.frow[data-id="' + id + '"]')
    if (!row) return { found: false, tabIndex: null, focused: false }
    row.focus()
    return { found: true, tabIndex: row.tabIndex, focused: document.activeElement === row }
  }, seeded.pdf)
  const openPdfByKeyboard = async () => {
    const row = await focusPdfRow()
    // Enter is dispatched as real input, not a synthetic event at the panel:
    // the row's own keydown is what the keyboard user actually gets.
    await realKey('Enter', 'Enter', 13)
    await page.waitFor("document.querySelector('.preview-drawer:not(.is-closing) iframe.preview-frame')", { label: 'the PDF iframe' })
    await sleep(500)
    return row
  }

  // The widest case: 1440x900 must give the page a real reading area.
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await page.navigate(server + folderPath, { settle: 1200 })
  await page.waitFor("document.querySelectorAll('.frow[data-id]').length === 7", { label: 'the fixture rows at 1440x900' })
  const pdfRow = await openPdfByKeyboard()
  check('the PDF row is a keyboard-focusable frow', pdfRow.found && pdfRow.tabIndex === 0 && pdfRow.focused, JSON.stringify(pdfRow))
  const desktopPdf = await pdfState()
  check('a PDF opens in the reader layout, not the photo gallery',
    desktopPdf.open && desktopPdf.title === 'manual.pdf' && /reader-viewer/.test(desktopPdf.className) && !/photo-viewer/.test(desktopPdf.className),
    JSON.stringify({ title: desktopPdf.title, className: desktopPdf.className }))
  check('a PDF preview has no picture counter or gallery arrows', desktopPdf.counter === false, JSON.stringify(desktopPdf.counter))
  // 1120x680 is the floor the reading surface was built for: below it a page is
  // being squeezed rather than read.
  check('the PDF iframe is at least 1120x680 at 1440x900',
    desktopPdf.frame && desktopPdf.frame.width >= 1120 && desktopPdf.frame.height >= 680,
    JSON.stringify(desktopPdf.frame))
  check('the PDF iframe covers the viewport width at 1440x900',
    desktopPdf.frame && desktopPdf.frame.left >= -1 && desktopPdf.frame.right <= desktopPdf.viewport.width + 1,
    JSON.stringify({ frame: desktopPdf.frame, viewport: desktopPdf.viewport }))
  const servedPdf = await page.run(async () => {
    const frame = document.querySelector('.preview-drawer:not(.is-closing) iframe.preview-frame')
    const src = String(frame.getAttribute('src') || '').split('#')[0]
    if (!src.startsWith('blob:')) return { blob: false, head: '', eof: false, size: 0 }
    const bytes = new Uint8Array(await (await fetch(src)).arrayBuffer())
    const text = new TextDecoder('latin1').decode(bytes)
    return { blob: true, head: text.slice(0, 8), eof: text.trimEnd().endsWith('%%EOF'), size: bytes.length }
  })
  check('the iframe really holds the fetched PDF bytes',
    servedPdf.blob && servedPdf.head === '%PDF-1.4' && servedPdf.eof && servedPdf.size > 200,
    JSON.stringify(servedPdf))
  await page.shot('mobile-preview-03-pdf-desktop')

  // Escape is the keyboard's close; the row the user came from must get focus
  // back, or the next Tab restarts at the top of the page.
  await realKey('Escape', 'Escape', 27)
  await page.waitFor("!document.querySelector('.preview-drawer:not(.is-closing)')", { label: 'the PDF drawer to close' })
  await sleep(300)
  const returned = await page.run((id) => {
    const row = document.activeElement && document.activeElement.closest ? document.activeElement.closest('.frow[data-id]') : null
    return {
      rowId: row ? row.dataset.id : null,
      tag: document.activeElement ? document.activeElement.tagName : null,
      path: location.pathname,
    }
  }, seeded.pdf)
  check('closing the PDF preview returns focus to its row',
    returned.rowId === seeded.pdf && returned.path === folderPath, JSON.stringify(returned))

  // Phones: 390 and 320 CSS pixels. The frame may shrink, but it must never
  // sit outside the panel, and the document must not gain a sideways scroll.
  for (const [width, height] of [[390, 844], [320, 700]]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true })
    await page.navigate(server + folderPath, { settle: 1200 })
    await page.waitFor("document.querySelectorAll('.frow[data-id]').length === 7", { label: 'the fixture rows at ' + width })
    await openPdfByKeyboard()
    const phonePdf = await pdfState()
    check('the PDF iframe stays on screen at ' + width + ' CSS pixels',
      phonePdf.open && phonePdf.frame && phonePdf.panel
      && phonePdf.frame.left >= -1 && phonePdf.frame.right <= phonePdf.viewport.width + 1
      && phonePdf.panel.left >= -1 && phonePdf.panel.right <= phonePdf.viewport.width + 1
      && phonePdf.scrollWidth <= phonePdf.viewport.width,
      JSON.stringify({ frame: phonePdf.frame, panel: phonePdf.panel, viewport: phonePdf.viewport, scrollWidth: phonePdf.scrollWidth }))
    // A frame narrower than the phone is still readable (the viewer zooms the
    // page to fit); a frame only a few dozen pixels tall is not.
    check('the PDF reading surface stays usable at ' + width + ' CSS pixels',
      phonePdf.frame.height >= 300 && Math.abs(phonePdf.frame.width - phonePdf.viewport.width) < 2,
      JSON.stringify(phonePdf.frame))
    if (width === 390) await page.shot('mobile-preview-04-pdf-phone')
    await close()
  }

  await page.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: true })
  await page.navigate(server + folderPath, { settle: 900 })
  check('the mobile page never overflows horizontally', await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'))
  check('no console errors', page.consoleErrors.length === 0, page.consoleErrors.slice(0, 3).join(' | '))
  check('no failed requests', page.failedRequests.length === 0, page.failedRequests.slice(0, 3).join(' | '))
}))
