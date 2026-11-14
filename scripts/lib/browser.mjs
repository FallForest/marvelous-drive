/**
 * Shared harness for the browser-driven checks.
 *
 * Eleven check scripts used to carry their own copy of the same 80 lines:
 * find a Chrome binary, spawn it, poll /json/version, open a page, speak the
 * DevTools protocol, collect console errors, print ok/FAIL. The copies drifted
 * (different flags, different error capture, different exit codes), so the
 * drift was the bug surface.
 *
 * This module owns that machinery once. A check script keeps only what makes it
 * a check: the seed data, the page interactions, and the assertions.
 *
 *   import { runBrowserCheck } from './lib/browser.mjs'
 *   await runBrowserCheck({ title: 'Upload check' }, async (page, check) => {
 *     const token = await page.signUp()
 *     check('signed in', Boolean(token))
 *   })
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

/** Where screenshots land. Shared by every check. */
export const SHOTS_DIR = resolve('.tmp/shots')

/**
 * Chromium candidates, in order of preference.
 *
 * Windows paths first because that is where this project is developed, but the
 * Linux names are what CI uses, so both must stay.
 */
const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

export function findChrome() {
  return CHROME_CANDIDATES.find((candidate) => existsSync(candidate)) || null
}

/** Reads `--flag value` from argv. Every check takes --server and a few take more. */
export function flag(name, fallback) {
  const args = process.argv.slice(2)
  const index = args.indexOf('--' + name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

export const serverUrl = () => flag('server', process.env.MDRIVE_SERVER || 'http://127.0.0.1:4400').replace(/\/+$/, '')

/**
 * A page driven over the DevTools protocol.
 *
 * The socket is the only stateful part: `pending` maps a protocol id to the
 * promise that resolves when the reply arrives. Everything else is a thin,
 * testable wrapper over one protocol call.
 */
class Page {
  constructor(socket, version) {
    this.socket = socket
    this.version = version
    this.consoleErrors = []
    this.failedRequests = []
    // Every URL the page actually asked for, in order, with the answer's status
    // and whether the browser served it from its own cache. Checks about
    // "this route, once" need the evidence, not a guess.
    this.networkRequests = []
    /** URLs the browser answered without touching the network. */
    this.cachedRequests = []
    this._requestUrls = new Map()
    this.nextId = 1
    this.pending = new Map()
    this.logPageConsole = false

    socket.onmessage = (event) => {
      const message = JSON.parse(event.data)
      const entry = message.id ? this.pending.get(message.id) : null
      if (entry) {
        this.pending.delete(message.id)
        if (message.error) entry.reject(new Error(message.error.message))
        else entry.resolve(message.result)
        return
      }
      this.onEvent(message)
    }
  }

  /** Protocol events: the two things every check cares about, plus optional logging. */
  onEvent(message) {
    if (message.method === 'Runtime.exceptionThrown') {
      const detail = message.params.exceptionDetails
      this.consoleErrors.push(detail.exception?.description || detail.text)
      return
    }
    if (message.method === 'Runtime.consoleAPICalled') {
      const text = message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ')
      if (this.logPageConsole) console.log('  [page ' + message.params.type + ']', text)
      if (message.params.type === 'error') this.consoleErrors.push(text)
      return
    }
    if (message.method === 'Network.loadingFailed' && !message.params.canceled) {
      this.failedRequests.push(message.params.errorText)
      return
    }
    if (message.method === 'Network.requestWillBeSent') {
      const { requestId, request } = message.params
      if (request && request.url) this._requestUrls.set(requestId, request.url)
      return
    }
    if (message.method === 'Network.responseReceived') {
      const url = message.params.response?.url
      if (!url) return
      const cacheHeaders = message.params.response?.fromDiskCache || message.params.response?.fromMemoryCache
      this.networkRequests.push(url)
      if (cacheHeaders) this.cachedRequests.push(url)
    }
  }

  send(method, params = {}) {
    return new Promise((resolvePromise, rejectPromise) => {
      const id = this.nextId++
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  /** Evaluates an expression and returns its value; page exceptions become errors. */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails
      throw new Error(detail.exception?.description || detail.text)
    }
    return result.result.value
  }

  /**
   * Runs a function inside the page with JSON arguments.
   *
   * Arguments travel as JSON rather than by string interpolation, so a value
   * containing a quote or a newline cannot break the call — which is exactly
   * what happened when a file name was pasted into an expression.
   */
  run(fn, ...params) {
    return this.evaluate('(' + fn.toString() + ').apply(null, ' + JSON.stringify(params) + ')')
  }

  /** Polls an expression until it is truthy. Throws on timeout. */
  async waitFor(expression, { timeout = 10000, label = expression } = {}) {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      if (await this.evaluate('Boolean(' + expression + ')')) return true
      await sleep(100)
    }
    throw new Error('timed out waiting for ' + label)
  }

  /** Captures a screenshot into .tmp/shots. Returns the file path. */
  async shot(name) {
    mkdirSync(SHOTS_DIR, { recursive: true })
    const result = await this.send('Page.captureScreenshot', { format: 'png' })
    const path = SHOTS_DIR + '/' + name + '.png'
    writeFileSync(path, Buffer.from(result.data, 'base64'))
    return path
  }

  async navigate(url, { settle = 1200 } = {}) {
    await this.send('Page.navigate', { url })
    await sleep(settle)
  }

  async reload({ ignoreCache = true, settle = 1800 } = {}) {
    await this.send('Page.reload', { ignoreCache })
    await sleep(settle)
  }

  /** Enables the domains a check needs; Network is optional because not all do. */
  async start({ network = false } = {}) {
    await this.send('Page.enable')
    await this.send('Runtime.enable')
    if (network) await this.send('Network.enable')
  }

  close() {
    try { this.socket.close() } catch { /* already closed */ }
  }
}

/** The ok/FAIL tally every check prints, and the exit code it produces. */
function createRecorder() {
  let passed = 0
  const failures = []
  const check = (name, ok, detail) => {
    if (ok) {
      passed += 1
      console.log('  ok   ' + name)
    } else {
      failures.push(name + (detail ? ': ' + detail : ''))
      console.log('  FAIL ' + name + (detail ? ': ' + detail : ''))
    }
  }
  return { check, failures, count: () => passed }
}

/**
 * Launches Chrome, opens a page, runs the body, and reports.
 *
 * `body(page, check, recorder)` gets the live page. Throwing is safe: the error
 * is recorded as a harness failure, a screenshot is taken, and the exit code is
 * still correct — a check that crashes must never look like a check that passed.
 *
 * Resolves to the process exit code instead of calling process.exit, so a caller
 * that wants two checks in one process can. The CLI wrapper at the bottom of
 * each script is what actually exits.
 */
export async function runBrowserCheck({ title, network = false, viewport = { width: 1440, height: 960 } }, body) {
  const chromeBinary = findChrome()
  if (!chromeBinary) {
    console.error('No Chrome or Edge found; skipping ' + (title || 'the browser check') + '.')
    return 2
  }

  mkdirSync(SHOTS_DIR, { recursive: true })
  const port = 9200 + Math.floor(Math.random() * 600)
  const profile = resolve('.tmp/chrome-' + Math.random().toString(36).slice(2, 10))
  const chrome = spawn(chromeBinary, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + port, '--user-data-dir=' + profile,
    '--window-size=' + viewport.width + ',' + viewport.height, '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore' })

  const recorder = createRecorder()
  const { check, failures } = recorder
  let page = null

  try {
    const version = await waitForDevtools(port)
    const target = await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' }).then((r) => r.json())
    const socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolvePromise, rejectPromise) => { socket.onopen = resolvePromise; socket.onerror = rejectPromise })

    page = new Page(socket, version)
    console.log((title || 'Browser check') + ' via ' + version.Browser + '\n')
    await page.start({ network })
    await page.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false })

    await body(page, check, recorder)
  } catch (error) {
    failures.push('harness: ' + error.message)
    console.log('  FAIL harness: ' + error.message)
    if (page) { try { await page.shot('99-failure') } catch { /* nothing to capture */ } }
  } finally {
    if (page) page.close()
    chrome.kill()
  }

  console.log('\n' + recorder.count() + ' checks passed, ' + failures.length + ' failed')
  if (failures.length) {
    for (const failure of failures) console.log('  - ' + failure)
    return 1
  }
  return 0
}

async function waitForDevtools(port) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/json/version')
      if (response.ok) return response.json()
    } catch { /* not listening yet */ }
    await sleep(200)
  }
  throw new Error('Chrome did not expose the DevTools endpoint on port ' + port)
}

/**
 * Registers a throwaway account through the page's own fetch and stores the
 * token where the client looks for it. Every check needs this; none of them
 * should be re-deriving it.
 */
export async function signUpInPage(page, { prefix = 'check', password = 'check password', name = null } = {}) {
  const email = prefix + '-' + Date.now() + '@example.com'
  const token = await page.run(async (emailAddress, secretWord, displayName) => {
    const body = JSON.stringify({ email: emailAddress, password: secretWord, ...(displayName ? { name: displayName } : {}) })
    const headers = { 'content-type': 'application/json' }
    const registered = await fetch('/api/v1/auth/register', { method: 'POST', headers, body })
    if (registered.status !== 201 && registered.status !== 409) return null
    const login = await fetch('/api/v1/auth/login', { method: 'POST', headers, body }).then((response) => response.json())
    if (!login.token) return null
    localStorage.setItem('mdrive-token', login.token)
    return login.token
  }, email, password, name)
  return { email, password, token }
}

export { sleep }
