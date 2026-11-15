#!/usr/bin/env node
/** Mobile preview regressions using Chromium's native touch input.
 *   node scripts/mobile-preview-check.mjs [--server URL]
 * Creates a throwaway account; never use an existing account's private files.
 */
import { runBrowserCheck, serverUrl, signUpInPage, sleep } from './lib/browser.mjs'
import { makePng } from './lib/png.mjs'

const server = serverUrl()
const viewport = { width: 390, height: 844 }

process.exit(await runBrowserCheck({ title: 'Mobile preview check', network: true, viewport }, async (page, check) => {
  await page.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: true })
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await page.navigate(server + '/')
  const session = await signUpInPage(page, { prefix: 'mobile-preview', password: 'mobile preview check password' })
  check('signed in', Boolean(session.token))

  const seeded = await page.run(async (png) => {
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
  }, makePng(320, 240).toString('base64'))

  await page.navigate(server + '/folder/' + seeded.folder, { settle: 1200 })
  await page.waitFor("document.querySelectorAll('.frow[data-id]').length === 6", { label: 'the mobile fixture rows' })
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
  check('the mobile page never overflows horizontally', await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'))
  check('no console errors', page.consoleErrors.length === 0, page.consoleErrors.slice(0, 3).join(' | '))
  check('no failed requests', page.failedRequests.length === 0, page.failedRequests.slice(0, 3).join(' | '))
}))
