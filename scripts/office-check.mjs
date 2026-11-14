#!/usr/bin/env node
/**
 * Office preview check: uploads real .pptx / .docx / .xlsx files, opens each in
 * the web client and asserts the drawer renders extracted text instead of the
 * "this format cannot be previewed" notice.
 *
 *   node scripts/office-check.mjs [--server URL] [--sample DIR[,DIR]]
 *
 * Samples come from --sample, MDRIVE_OFFICE_SAMPLES (comma separated), or
 * .tmp/office-fixtures. With no samples the check reports so and exits 0.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { flag, serverUrl, runBrowserCheck, sleep } from './lib/browser.mjs'

const server = serverUrl()
const dirs = (flag('sample', process.env.MDRIVE_OFFICE_SAMPLES) || '.tmp/office-fixtures').split(/[,;]/).filter(Boolean)
const OFFICE = new Set(['.pptx', '.docx', '.xlsx', '.ppt', '.doc', '.xls'])

const samples = []
for (const dir of dirs) {
  const absolute = resolve(dir)
  if (!existsSync(absolute)) continue
  for (const name of readdirSync(absolute)) {
    if (!OFFICE.has(extname(name).toLowerCase())) continue
    samples.push({ name, bytes: readFileSync(join(absolute, name)) })
  }
}

if (!samples.length) {
  console.log('No office samples found in ' + dirs.join(', ') + '; nothing to verify.')
  console.log('Point --sample at a folder of .pptx/.docx/.xlsx files to run this check.')
  process.exit(0)
}

process.exit(await runBrowserCheck({ title: 'Office preview check' }, async (page, check) => {
  await page.navigate(server + '/', { settle: 1300 })

  // ── 1. API side: upload each sample and extract it ──────────────────────────
  const session = await page.run(async (email, password) => {
    const body = JSON.stringify({ email, password })
    const response = await fetch('/api/v1/auth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    })
    const payload = await response.json().catch(() => ({}))
    if (!payload.token) return null
    localStorage.setItem('mdrive-token', payload.token)
    return payload.token
  }, 'office-' + Date.now() + '@example.com', 'office check password')
  check('an account is registered', typeof session === 'string', String(session))
  if (!session) return

  const extracted = []
  for (const sample of samples) {
    const result = await page.run(async (name, bytes, token) => {
      const upload = await fetch('/api/v1/uploads?name=' + encodeURIComponent(name), {
        method: 'PUT',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/octet-stream' },
        body: Uint8Array.from(bytes),
      })
      const uploaded = await upload.json().catch(() => ({}))
      if (!uploaded.node) return { uploadStatus: upload.status }
      const office = await fetch('/api/v1/files/' + uploaded.node.id + '/office', {
        headers: { authorization: 'Bearer ' + token },
      })
      const payload = (await office.json().catch(() => ({}))).office
      return { uploadStatus: upload.status, status: office.status, id: uploaded.node.id, payload }
    }, sample.name, Array.from(sample.bytes), session)

    if (!result.id) { check('upload ' + sample.name, false, 'status ' + result.uploadStatus); continue }

    const payload = result.payload || {}
    const pages = payload.pages || []
    const sheets = payload.sheets || []
    const text = pages.length
      ? pages.map((page) => (page.title || '') + ' ' + (page.blocks || []).map((block) => block.text || (block.items || []).join(' ') || '').join(' ')).join(' ')
      : sheets.map((sheet) => sheet.rows.slice(0, 20).map((row) => row.map((cell) => cell.text).join(' ')).join(' ')).join(' ')

    extracted.push({ name: sample.name, id: result.id })
    check('extracts ' + sample.name, result.status === 200 && text.trim().length > 0, 'status ' + result.status + ' chars ' + text.trim().length)
    console.log('       ' + JSON.stringify({ name: sample.name, kind: payload.kind, pages: pages.length, sheets: sheets.length, chars: text.trim().length }))
  }

  // ── 2. Client side: the drawer must render the outline ──────────────────────
  await page.reload({ settle: 1800 })
  for (const entry of extracted) {
    const opened = await page.run((nodeId) => {
      const row = Array.from(document.querySelectorAll('[data-id]')).find((element) => element.getAttribute('data-id') === nodeId)
      if (!row) return 'row missing'
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      return 'ok'
    }, entry.id)
    check('opens ' + entry.name + ' in the drawer', opened === 'ok', opened)
    await sleep(2200)

    const drawerText = await page.evaluate("(document.querySelector('.preview-drawer .drawer-body') || {}).innerText || ''")
    const unsupported = /此格式暂不支持在线预览/.test(drawerText)
    const hasOfficeMarkup = await page.evaluate("Boolean(document.querySelector('.office'))")
    check('renders the extracted outline for ' + entry.name, hasOfficeMarkup && !unsupported, JSON.stringify(drawerText.slice(0, 120)))

    await page.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
    await sleep(400)
  }

  await page.shot('office-preview')
  check('no console errors', page.consoleErrors.length === 0, page.consoleErrors.slice(0, 2).join(' | '))
}))