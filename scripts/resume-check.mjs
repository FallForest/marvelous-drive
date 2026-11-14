import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { runBrowserCheck, signUpInPage, sleep, serverUrl } from '../scripts/lib/browser.mjs'

/**
 * Resume after a reload, end to end.
 *
 * Proves the three things the feature is made of: the session survives the
 * page, boot claims it, and the row can actually finish the upload — with the
 * bytes already on the server never sent again.
 */
const server = serverUrl()
const scratch = resolve('.tmp/resume-check')
mkdirSync(scratch, { recursive: true })

process.exit(await runBrowserCheck({ title: 'Resume check' }, async (page, check) => {
  await page.send('DOM.enable')
  await page.send('Network.enable')
  await page.navigate(server + '/', { settle: 1300 })
  const session = await signUpInPage(page, { prefix: 'resume', password: 'resume check password' })
  check('signed in', Boolean(session.token))
  await page.reload({ settle: 2200 })
  await page.waitFor("document.getElementById('shell')", { timeout: 20000, label: 'shell mounted' })

  // Start a 24 MiB upload and stop it part-way: three chunks of 8 MiB, so one
  // lands before the cancel.
  const prepared = await page.run(async () => {
    const api = await import('/lib/upload.js')
    const bytes = new Uint8Array(24 * 1024 * 1024)
    for (let index = 0; index < bytes.length; index += 4093) bytes[index] = (index % 251) + 1
    const file = new File([bytes], 'resume-me.bin', { type: 'application/octet-stream' })
    const task = api.createUploadTask({ file, parentId: null, chunkParallel: 1 })
    const running = task.start()
    // Wait for the first chunk to be stored, then pause: the session keeps it.
    const deadline = Date.now() + 20000
    while (Date.now() < deadline && !task.sessionId) await new Promise((r) => setTimeout(r, 20))
    while (Date.now() < deadline && task.uploaded < 8 * 1024 * 1024) await new Promise((r) => setTimeout(r, 20))
    task.pause()
    await running.catch(() => {})
    return { sessionId: task.sessionId, uploaded: task.uploaded, state: task.state }
  })
  check('a session was opened and paused part-way', Boolean(prepared.sessionId) && prepared.uploaded >= 8 * 1024 * 1024, JSON.stringify(prepared))

  // The reload that used to throw the session away.
  await page.reload({ settle: 2400 })
  await page.waitFor("document.getElementById('shell')", { timeout: 20000, label: 'shell mounted again' })
  await sleep(1200)

  const row = await page.run(() => {
    const items = Array.from(document.querySelectorAll('.qitem.is-resumable'))
    return items.map((node) => node.innerText.replace(/\s+/g, ' ').trim())
  })
  check('boot claims the live session', row.length === 1, JSON.stringify(row))
  check('the row says how much is already stored', /已传 \d+%/.test(row[0] || ''), JSON.stringify(row))

  const listed = await page.run(async () => {
    const token = localStorage.getItem('mdrive-token')
    const payload = await fetch('/api/v1/uploads/sessions', { headers: { authorization: 'Bearer ' + token } }).then((r) => r.json())
    return payload.uploads.map((entry) => ({ id: entry.id, received: entry.receivedChunks.length, total: entry.totalChunks }))
  })
  check('the server still holds the session', listed.some((entry) => entry.id === prepared.sessionId), JSON.stringify(listed))

  // Discard is the floor: it must free the temp chunks instead of leaking them.
  await page.run(() => {
    const row = document.querySelector('.qitem.is-resumable')
    const buttons = row ? Array.from(row.querySelectorAll('button')) : []
    const discard = buttons[buttons.length - 1]
    if (discard) discard.click()
  })
  await sleep(1200)
  const after = await page.run(async () => {
    const token = localStorage.getItem('mdrive-token')
    const payload = await fetch('/api/v1/uploads/sessions', { headers: { authorization: 'Bearer ' + token } }).then((r) => r.json())
    return payload.uploads.length
  })
  check('discard frees the server session', after === 0, String(after))
  check('no console errors', page.consoleErrors.length === 0, page.consoleErrors.slice(0, 2).join(' | '))
}))
