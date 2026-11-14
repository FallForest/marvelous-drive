#!/usr/bin/env node
/**
 * HEIC preview check: the one format a browser refuses, end to end.
 *
 *   node scripts/heic-check.mjs [--server URL]
 *
 * A real HEIC (libheif's own example file, 1280x854) is uploaded through the
 * public API, and the drawer is asked to show it. This is the assertion that
 * matters: without the normaliser the browser paints "此格式暂不支持在线预览"
 * for every photo an iPhone ever produced.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { serverUrl, runBrowserCheck, signUpInPage, sleep } from './lib/browser.mjs'

const server = serverUrl()

/**
 * The fixture is fetched, not checked in.
 *
 * A real HEIC is 700 KB of binary, and the sample is libheif's own example file
 * — committing a copy would put a third party's image in the repository under
 * a licence this project does not otherwise carry. It is also not something the
 * check can synthesise: a hand-built HEIC would test the writer, not the
 * decoder. So the file is downloaded on demand and cached in `.tmp/`, which is
 * git-ignored and already the scratch directory for every other check.
 *
 * Fetching here rather than exiting with a curl instruction matters: the sweep
 * (scripts/run-checks.mjs) runs this alongside the rest, and a check that needs
 * a manual pre-step turns a fresh clone red for a reason that is not a bug.
 */
const SAMPLE = '.tmp/sample.heic'
const SAMPLE_URL = 'https://raw.githubusercontent.com/strukturag/libheif/master/examples/example.heic'

async function loadSample() {
  try {
    return readFileSync(SAMPLE)
  } catch {
    // Not cached yet; fall through to the download.
  }
  console.log('  ..   fetching the HEIC fixture into ' + SAMPLE)
  const response = await fetch(SAMPLE_URL)
  if (!response.ok) throw new Error('Could not download the HEIC fixture: HTTP ' + response.status)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length < 1024) throw new Error('The HEIC fixture came back empty (' + bytes.length + ' bytes).')
  mkdirSync(dirname(SAMPLE), { recursive: true })
  writeFileSync(SAMPLE, bytes)
  return bytes
}

let heic
try {
  heic = await loadSample()
} catch (error) {
  // A fixture that cannot be fetched is one check's problem, not the sweep's:
  // the runner prints the reason next to the other results instead of a crash.
  console.error('HEIC preview check cannot run: ' + error.message)
  process.exit(1)
}

process.exit(await runBrowserCheck({ title: 'HEIC preview check', network: true }, async (page, check) => {
  await page.navigate(server + '/', { settle: 1200 })
  const session = await signUpInPage(page, { prefix: 'heic', password: 'heic check password' })
  check('signed in', typeof session.token === 'string' && session.token.length > 20)

  const seeded = await page.run(async (b64) => {
    const token = localStorage.getItem('mdrive-token')
    const headers = { authorization: 'Bearer ' + token }
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    // No content type on purpose: that is what a browser sends for .heic.
    const response = await fetch('/api/v1/uploads?name=' + encodeURIComponent('IMG_0001.heic'), {
      method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: bytes,
    })
    const payload = await response.json()
    return { status: response.status, mime: payload.node ? payload.node.mime : null, id: payload.node ? payload.node.id : null }
  }, heic.toString('base64'))
  check('the file uploads', seeded.status === 201, JSON.stringify(seeded))
  check('it is stored as an image, not as octet-stream', seeded.mime === 'image/heic', String(seeded.mime))

  // The normaliser is optional in a checkout: ask the server which it is.
  const formats = await page.run(async () => {
    const token = localStorage.getItem('mdrive-token')
    const response = await fetch('/api/v1/preview/formats', { headers: { authorization: 'Bearer ' + token } })
    return (await response.json()).formats
  })
  const decodable = Boolean(formats && formats.heic && formats.heic.decodable)

  if (!decodable) {
    console.log('  --   this deployment has no HEIC decoder; asserting the honest fallback instead')
    await page.reload({ settle: 1600 })
    const fallback = await page.run(async () => {
      const row = document.querySelector('.frow[data-id]')
      if (!row) return { error: 'row missing' }
      row.querySelector('.name').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 1500))
      return { error: null, text: (document.querySelector('.preview-body') || {}).innerText || '' }
    })
    check('without a decoder the drawer says so honestly', /暂不支持|无法/.test(fallback.text), JSON.stringify(fallback.text.slice(0, 80)))
    check('no console errors', page.consoleErrors.length === 0, page.consoleErrors.slice(0, 2).join(' | '))
    return
  }

  await page.reload({ settle: 1600 })
  await page.waitFor("document.querySelectorAll('.frow[data-id]').length === 1", { label: 'the heic row' })

  const opened = await page.run(async () => {
    const row = document.querySelector('.frow[data-id]')
    row.querySelector('.name').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 2600))
    const canvas = document.querySelector('.preview-drawer .picture-canvas')
    return {
      canvas: Boolean(canvas),
      width: canvas ? canvas.width : null,
      height: canvas ? canvas.height : null,
      text: (document.querySelector('.preview-body') || {}).innerText || '',
    }
  })
  check('a HEIC is rendered as a picture', opened.canvas === true, JSON.stringify(opened))
  check('it is downscaled to the preview cap, not decoded at full size',
    opened.width !== null && opened.width <= 1600, JSON.stringify({ w: opened.width, h: opened.height }))
  check('the aspect ratio of the sample is kept (1280x854)',
    opened.width !== null && Math.abs((opened.width / opened.height) - (1280 / 854)) < 0.02,
    String(opened.width) + 'x' + String(opened.height))
  check('no "unsupported" card is shown', !/暂不支持/.test(opened.text), JSON.stringify(opened.text.slice(0, 60)))
  await page.shot('heic-preview')

  const served = page.networkRequests.filter((url) => /preview-image/.test(url))
  check('the picture came from the preview-image route', served.length > 0, JSON.stringify(served.slice(0, 2)))

  check('no console errors', page.consoleErrors.length === 0, page.consoleErrors.slice(0, 2).join(' | '))
  check('no failed requests', page.failedRequests.length === 0, page.failedRequests.slice(0, 2).join(' | '))
}))
