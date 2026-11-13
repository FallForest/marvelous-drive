#!/usr/bin/env node
/**
 * Motion feel check: the runtime half of the motion system.
 *
 *   node scripts/feel-check.mjs [--server URL]
 *
 * motion-lint.mjs proves the CSS rules statically; this drives a real browser and
 * reads getComputedStyle / getAnimations(), which is the only way to know the
 * rules are actually applied to the DOM the user sees.
 */

import { serverUrl, runBrowserCheck, sleep } from './lib/browser.mjs'

const server = serverUrl()
const password = 'feel check password'

process.exit(await runBrowserCheck({ title: 'Marvelous Drive motion feel check' }, async (page, check) => {
  await page.navigate(server + '/', { settle: 1200 })

  const seeded = await page.run(async (email, secretWord) => {
    const post = (path, body, token) => fetch(path, {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
      body: JSON.stringify(body),
    })
    const registered = await post('/api/v1/auth/register', { email, password: secretWord, name: 'Feel Check' })
    if (registered.status !== 201) return { error: 'register ' + registered.status }
    const login = await (await post('/api/v1/auth/login', { email, password: secretWord })).json()
    const token = login.token
    const folder = await (await post('/api/v1/nodes', { name: '动效', kind: 'folder' }, token)).json()
    const putFile = (name, body) => fetch('/api/v1/uploads?parentId=' + folder.node.id + '&name=' + encodeURIComponent(name), {
      method: 'PUT', headers: { authorization: 'Bearer ' + token, 'content-type': 'text/plain' }, body,
    })
    // enough rows to prove the stagger cap: 14 items is past the cap of 10
    const results = []
    for (let i = 1; i <= 14; i += 1) results.push((await putFile('文件' + String(i).padStart(2, '0') + '.txt', 'row ' + i)).status)
    await post('/api/v1/nodes', { name: '空文件夹', kind: 'folder' }, token)
    localStorage.setItem('mdrive-token', token)
    return { folder: folder.node.id, uploaded: results.filter((code) => code === 201).length }
  }, 'feel-' + Date.now() + '@example.com', password)
  check('seed data created through the real API', seeded.uploaded === 14, JSON.stringify(seeded))
  if (!seeded.folder) return

  // Land on the folder directly: a fresh paint is the case where the list itself
  // is the entrance. A navigation inside the app uses the cross-fade instead
  // (checked further down), which is the "one entrance per navigation" rule.
  // The entrance lasts a couple of hundred milliseconds by design, so it cannot
  // be sampled after a sleep — by then it is correctly over. A probe installed
  // before the load captures the state on the first frame the rows exist.
  await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: '(' + (() => {
      window.__motionProbe = null
      const started = performance.now()
      const tick = () => {
        if (window.__motionProbe) return
        const rows = Array.from(document.querySelectorAll('.list-body > .frow'))
        const view = document.querySelector('.view')
        if (rows.length >= 14 && view) {
          window.__motionProbe = {
            rootClass: view.className,
            indexes: rows.map((row) => getComputedStyle(row).getPropertyValue('--i').trim()),
            delays: rows.map((row) => getComputedStyle(row).animationDelay),
            names: rows.map((row) => getComputedStyle(row).animationName),
          }
          return
        }
        if (performance.now() - started < 10000) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }).toString() + ')()',
  })
  await page.send('Page.navigate', { url: server + '/folder/' + seeded.folder })
  await sleep(1400)
  await page.waitFor("document.querySelectorAll('.frow[data-id]').length === 14", { label: 'the 14 seeded rows' })

  const rowCount = await page.evaluate("document.querySelectorAll('.frow[data-id]').length")
  check('folder lists 14 rows', rowCount === 14, String(rowCount))

  /* ── 1. staggered entry, capped ────────────────────────────────── */
  const stagger = await page.evaluate('window.__motionProbe') || { rootClass: 'missing', indexes: [], delays: [], names: [] }
  check('the page root is entering', /motion-enter/.test(stagger.rootClass), stagger.rootClass)
  check('rows carry a stagger index', stagger.indexes.filter(Boolean).length === 14, JSON.stringify(stagger.indexes.slice(0, 3)))
  check('the stagger index is capped at 10', stagger.indexes[13] === '10', String(stagger.indexes[13]))
  check('every row plays the enter keyframe', stagger.names.every((name) => name === 'motion-enter'), JSON.stringify(stagger.names.slice(0, 2)))
  check('row 0 starts immediately', /^0s$/.test(String(stagger.delays[0]).split(',')[0].trim()), String(stagger.delays[0]))
  check('row 1 waits one 28ms step', /0\.028s/.test(String(stagger.delays[1])), String(stagger.delays[1]))
  check('row 13 waits 280ms, not 364', /0\.28s/.test(String(stagger.delays[13])), String(stagger.delays[13]))

  /* ── 2. press feedback on a real pointer press ─────────────────── */
  const press = async (selector, hold) => {
    const box = await page.run((sel) => {
      const element = document.querySelector(sel)
      if (!element) return null
      const rect = element.getBoundingClientRect()
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
    }, selector)
    if (!box) return null
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none', clickCount: 0 })
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await sleep(hold == null ? 90 : hold)
    const style = await page.run((sel) => {
      const element = document.querySelector(sel)
      if (!element) return null
      const computed = getComputedStyle(element)
      return { transform: computed.transform, transitionDuration: computed.transitionDuration }
    }, selector)
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    return style
  }

  const rowPress = await press('.frow[data-id]')
  check('a file row shrinks while pressed', rowPress && /matrix\(0\.9/.test(rowPress.transform), JSON.stringify(rowPress))
  const btnPress = await press('.toolbar .btn')
  check('a toolbar button shrinks while pressed', btnPress && /matrix\(0\.9/.test(btnPress.transform), JSON.stringify(btnPress))
  check('the press runs on the instant token (80ms)', Boolean(btnPress && /0\.08s/.test(btnPress.transitionDuration)), JSON.stringify(btnPress))

  /* ── 3. the entrance class leaves (no replay on a local re-render) ─ */
  await sleep(700)
  const settled = await page.evaluate("document.querySelector('.view').classList.contains('motion-enter')")
  check('the page root drops .motion-enter when done', settled === false)

  const replay = await page.run(async () => {
    const star = document.querySelector('.frow[data-id] .star')
    if (!star) return { error: 'no star button' }
    const before = document.querySelectorAll('.frow[data-id]').length
    star.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 260))
    const rows = Array.from(document.querySelectorAll('.frow[data-id]'))
    return {
      error: null,
      before,
      rows: rows.length,
      running: rows.reduce((total, row) => total + row.getAnimations().length, 0),
      rootClass: document.querySelector('.view').className,
    }
  })
  check('a star toggle re-renders the list', replay.rows === replay.before, JSON.stringify(replay))
  check('a local re-render does not replay the row entrance', replay.running === 0, 'running animations: ' + replay.running)
  check('a local re-render does not re-add .motion-enter', !/\.motion-enter/.test('.' + replay.rootClass.replace(/ /g, '.')), replay.rootClass)

  /* ── 4. dialog: spring in, faster out ─────────────────────────── */
  const dialog = await page.run(async () => {
    const row = document.querySelector('.frow[data-id]')
    const more = row && row.querySelector('.more')
    if (!more) return { error: 'no row menu' }
    more.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 60))
    const menu = document.querySelector('.menu')
    const style = menu ? getComputedStyle(menu) : null
    return {
      error: null,
      menuName: style ? style.animationName : '',
      menuDuration: style ? style.animationDuration : '',
      menuEasing: style ? style.animationTimingFunction : '',
      menuClass: menu ? menu.className : '',
    }
  })
  const menuAnimates = dialog.error === null && /motion-(sink|rise)-in/.test(String(dialog.menuName))
  check('the row menu enters with a directional spring keyframe', menuAnimates, JSON.stringify(dialog))
  check('the row menu entrance uses a spring curve, not a bezier', /linear\(|cubic-bezier\(0\.22, 1\.16/.test(String(dialog.menuEasing)), String(dialog.menuEasing))
  check('the row menu entrance runs on the base token (220ms)', /0\.22s/.test(String(dialog.menuDuration)), String(dialog.menuDuration))
  await page.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  await sleep(300)

  /* ── 5. view transition flag is released ──────────────────────── */
  await page.run(() => { history.pushState({}, '', '/trash'); window.dispatchEvent(new PopStateEvent('popstate')) })
  await sleep(120)
  const flagDuring = await page.evaluate("document.documentElement.hasAttribute('data-vt-swapping')")
  await sleep(900)
  const flagAfter = await page.evaluate("document.documentElement.hasAttribute('data-vt-swapping')")
  check('a navigation sets the swap flag', flagDuring === true, String(flagDuring))
  check('the swap flag is released when the transition ends', flagAfter === false, String(flagAfter))

  const viewAnimations = await page.run(() => {
    const view = document.querySelector('.view')
    return view ? view.getAnimations().length : -1
  })
  check('the swapped page does not animate a second time', viewAnimations === 0, 'running: ' + viewAnimations)
  await page.shot('08-feel-trash')

  /* ── 6. reduced motion collapses travel, keeps the change ─────── */
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await page.run(() => { history.pushState({}, '', '/starred'); window.dispatchEvent(new PopStateEvent('popstate')) })
  await sleep(700)
  const reduced = await page.run(() => {
    const view = document.querySelector('.view')
    const rows = Array.from(document.querySelectorAll('.list-body > .frow'))
    return {
      rootClass: view ? view.className : '',
      rowAnimations: rows.reduce((total, row) => total + row.getAnimations().length, 0),
    }
  })
  check('reduced motion adds no page entrance class', !/motion-enter/.test(reduced.rootClass), reduced.rootClass)
  check('reduced motion animates no rows', reduced.rowAnimations === 0, String(reduced.rowAnimations))
  await page.send('Emulation.setEmulatedMedia', { features: [] })

  /* ── 7. will-change never stands still ───────────────────────── */
  await sleep(500)
  const willChange = await page.run(() => Array.from(document.querySelectorAll('*'))
    .filter((element) => getComputedStyle(element).willChange !== 'auto').length)
  check('no standing will-change after the animations settle', willChange === 0, 'elements: ' + willChange)

  /* ── 8. the small-screen drawer behaves like a layer ─────────── */
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await sleep(400)
  const drawer = await page.run(async () => {
    const shell = document.getElementById('shell')
    const toggle = document.querySelector('.nav-toggle')
    const sidebar = document.querySelector('.sidebar')
    const read = () => ({
      open: shell.classList.contains('nav-open'),
      transform: getComputedStyle(sidebar).transform,
      expanded: toggle.getAttribute('aria-expanded'),
    })
    const closed = read()
    toggle.click()
    await new Promise((resolve) => setTimeout(resolve, 420))
    const opened = read()
    // A tap on the scrim arrives at the shell itself; the pseudo-element is not
    // a target, so this is the real gesture.
    shell.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 420))
    return { closed, opened, dismissed: read() }
  })
  check('the drawer starts off-screen', /matrix\(1, 0, 0, 1, -/.test(drawer.closed.transform), drawer.closed.transform)
  check('the toggle slides it in', drawer.opened.open && drawer.opened.transform === 'none', JSON.stringify(drawer.opened))
  check('the toggle reports its state', drawer.opened.expanded === 'true', String(drawer.opened.expanded))
  check('tapping the scrim dismisses the drawer', drawer.dismissed.open === false && drawer.dismissed.expanded === 'false', JSON.stringify(drawer.dismissed))

  check('no console errors', page.consoleErrors.length === 0, page.consoleErrors.slice(0, 3).join(' | '))
}))
