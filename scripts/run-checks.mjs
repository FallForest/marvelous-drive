#!/usr/bin/env node
/**
 * Runs every browser-driven check against one server.
 *
 *   node scripts/run-checks.mjs [--server URL] [--only a,b] [--keep-going]
 *
 * The checks each boot their own Chrome but share one Drive instance: starting
 * eleven instances would be eleven databases and eleven ports, which is both slow
 * and the reason the old hand-rolled sweep drifted. This runner owns the instance
 * instead — it probes for one already listening, and only spawns a child when
 * nothing answers.
 *
 * Exits non-zero if any check failed. `--keep-going` is the default; the flag
 * exists so a CI job can ask for "stop at the first failure" explicitly.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { serverUrl, flag } from './lib/browser.mjs'

/** Order matters only for readability: cheap checks first, slow ones last. */
const CHECKS = [
  ['browser-check', 'the shell: login, list, preview, trash, share, mobile'],
  ['click-check', 'the click model: click opens, checkbox selects'],
  ['gallery-check', 'the picture browser: arrows, counter, cache, no upscale'],
  ['heic-check', 'a HEIC upload becomes a preview a browser can show'],
  ['dnd-check', 'native file, thumbnail and group drags to list, grid, sidebar and breadcrumbs'],
  ['interaction-check', 'grid image fallbacks, keyboard controls and selected-item deletion'],
  ['move-check', 'move picker cancellation, root destination, keyboard, nesting and conflicts'],
  ['feature-check', 'thumbnails, batch bar, draggable rows, duplicates'],
  ['versions-check', 'the history drawer, absent on a v1 file'],
  ['team-check', 'the team panel and its role labels'],
  ['lock-check', 'the advisory edit lock: claim, supersede, release'],
  ['search-check', 'content hits, snippets, .docx text'],
  ['storage-check', 'ZIP menu entry, storage breakdown, archives'],
  ['folder-check', 'a dropped entry tree keeps nesting and empty dirs'],
  ['upload-check', 'picker, 9 MiB resumable session, batch bar, cancel'],
  ['resume-check', 'a reloaded page claims its live session and can discard it'],
  ['feel-check', 'runtime motion: press, stagger cap, VT flag'],
]

const server = serverUrl()
const only = flag('only', '')
const selected = only
  ? CHECKS.filter(([name]) => only.split(',').map((value) => value.trim()).includes(name))
  : CHECKS

if (!selected.length) {
  console.error('No check matched --only ' + only)
  process.exit(1)
}

/** True when something already answers /healthz at `url`. */
async function isUp(url) {
  try {
    const response = await fetch(url + '/healthz', { signal: AbortSignal.timeout(1500) })
    return response.ok
  } catch {
    return false
  }
}

let child = null
let started = false

if (!(await isUp(server))) {
  const entry = existsSync('apps/server/src/index.js') ? 'apps/server/src/index.js' : null
  if (!entry) {
    console.error('No server at ' + server + ' and no apps/server/src/index.js to start.')
    process.exit(1)
  }
  console.log('Starting a server for the checks…')
  child = spawn(process.execPath, [entry], { stdio: 'ignore', env: { ...process.env, PORT: new URL(server).port || '4400' } })
  started = true
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await isUp(server)) break
    await sleep(250)
  }
  if (!(await isUp(server))) {
    console.error('The server did not come up on ' + server)
    child.kill()
    process.exit(1)
  }
}

const results = []
let failed = 0

try {
  for (const [name, purpose] of selected) {
    console.log('\n═══ ' + name + ' — ' + purpose)
    const code = await run('scripts/' + name + '.mjs', ['--server', server])
    results.push({ name, code })
    if (code !== 0) failed += 1
  }
} finally {
  if (started && child) child.kill()
}

console.log('\n═══ summary')
for (const entry of results) {
  console.log('  ' + (entry.code === 0 ? 'ok  ' : 'FAIL') + '  ' + entry.name)
}
console.log('\n' + (results.length - failed) + ' of ' + results.length + ' checks passed')
process.exit(failed ? 1 : 0)

/** Streams a child's output through, and resolves to its exit code. */
function run(script, args) {
  return new Promise((resolvePromise) => {
    const proc = spawn(process.execPath, [script, ...args], { stdio: 'inherit' })
    proc.on('exit', (code) => resolvePromise(code == null ? 1 : code))
  })
}
