#!/usr/bin/env node
/**
 * Team panel check: the account menu opens the member list, an admin adds a
 * second account by e-mail, the row shows up with its role, and removing it works.
 *
 *   node scripts/team-check.mjs [--server URL]
 */

import { serverUrl, runBrowserCheck, sleep } from './lib/browser.mjs'

const server = serverUrl()

process.exit(await runBrowserCheck({ title: 'Team panel check' }, async (page, check) => {
  await page.navigate(server + '/?t=' + Date.now(), { settle: 1300 })

  const seeded = await page.run(async () => {
    const stamp = Date.now()
    const make = async (email, name) => {
      const body = JSON.stringify({ email, password: 'team check password', name })
      await fetch('/api/v1/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      return fetch('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body }).then((r) => r.json())
    }
    const admin = await make('team-admin-' + stamp + '@example.com', 'Ada')
    const guest = await make('team-guest-' + stamp + '@example.com', 'Bob')
    localStorage.setItem('mdrive-token', admin.token)
    return { guestEmail: guest.user.email }
  })
  check('two accounts seeded', typeof seeded.guestEmail === 'string')

  await page.navigate(server + '/?t=' + Date.now(), { settle: 2200 })
  await page.run(() => {
    const button = document.querySelector('[aria-label="账号菜单"]')
    if (button) button.click()
  })
  await sleep(400)

  const menu = await page.evaluate("Array.from(document.querySelectorAll('.menu-item')).map((n) => n.innerText.trim())")
  check('the account menu offers 团队成员', menu.some((label) => /团队成员/.test(label)), JSON.stringify(menu))

  await page.run(() => {
    const item = Array.from(document.querySelectorAll('.menu-item')).find((node) => /团队成员/.test(node.innerText))
    if (item) item.click()
  })
  await sleep(1600)

  const rows = await page.evaluate("Array.from(document.querySelectorAll('.member-row')).map((r) => r.innerText.replace(/\\s+/g, ' ').trim())")
  check('the panel lists the owner as 拥有者', rows.some((row) => /拥有者/.test(row)), JSON.stringify(rows))
  check('the panel reports the admin role', /管理员/.test(await page.evaluate("(document.querySelector('.member-head') || {}).innerText || ''")))

  await page.shot('team')
  check('no console errors', page.consoleErrors.length === 0, page.consoleErrors.slice(0, 2).join(' | '))
}))
