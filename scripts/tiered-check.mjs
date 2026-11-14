#!/usr/bin/env node
/**
 * The tiered driver, end to end.
 *
 *   node scripts/tiered-check.mjs [--s3-port 9102] [--drive-port 4402]
 *
 * Proves the whole loop: bytes land hot on local disk, `demote` copies them into
 * the (signature-verifying) S3 fixture and removes the local copy, and the API
 * still serves them — a read now crosses the tier boundary.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { argv, flagReader } from './lib/args.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const flag = flagReader(argv())
const s3Port = Number(flag('s3-port', 9102))
const drivePort = Number(flag('drive-port', 4402))
const KEY = 'minioadmin'

let passed = 0
const failures = []
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log('  ok   ' + name) }
  else { failures.push(name + (detail ? ': ' + detail : '')); console.log('  FAIL ' + name + (detail ? ': ' + detail : '')) }
}

const children = []
const start = (file, env, label) => {
  const child = spawn(process.execPath, [file], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (process.env.DEBUG) {
    child.stdout.on('data', (chunk) => process.stdout.write('[' + label + '] ' + chunk))
    child.stderr.on('data', (chunk) => process.stderr.write('[' + label + '!] ' + chunk))
  }
  children.push(child)
  return child
}
const stopAll = () => { for (const child of children) { try { child.kill() } catch { /* gone */ } } }
process.on('exit', stopAll)

const dataDir = mkdtempSync(join(tmpdir(), 'mdrive-tiered-'))
const api = 'http://127.0.0.1:' + drivePort + '/api/v1'

try {
  console.log('Tiered driver check\n')
  start(join(here, 's3-fixture.mjs'), {
    S3_PORT: String(s3Port), S3_ACCESS_KEY_ID: KEY, S3_SECRET_ACCESS_KEY: KEY,
  }, 's3')

  let ready = false
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch('http://127.0.0.1:' + s3Port + '/drive/ping', { method: 'PUT', body: 'x' })
      if (response.status === 403) { ready = true; break }
    } catch { /* not up */ }
    await sleep(200)
  }
  check('S3 fixture is up', ready)

  start(join(repoRoot, 'apps/server/src/index.js'), {
    DRIVE_DATA_DIR: dataDir,
    DRIVE_STORAGE: 'tiered',
    DRIVE_COLD_AFTER_DAYS: '0',
    DRIVE_S3_ENDPOINT: 'http://127.0.0.1:' + s3Port,
    DRIVE_S3_BUCKET: 'drive',
    DRIVE_S3_COLD_BUCKET: 'drive',
    DRIVE_S3_COLD_PREFIX: 'cold',
    DRIVE_S3_ACCESS_KEY_ID: KEY,
    DRIVE_S3_SECRET_ACCESS_KEY: KEY,
    DRIVE_S3_REGION: 'us-east-1',
    DRIVE_LOG: '0',
    PORT: String(drivePort),
    HOST: '127.0.0.1',
  }, 'drive')

  const email = 'tier-' + Date.now() + '@example.com'
  let token = null
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(api + '/auth/register', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'tiered check password' }),
      })
      if (response.status === 201) { token = (await response.json()).token; break }
    } catch { /* not up */ }
    await sleep(250)
  }
  check('server boots on the tiered driver', typeof token === 'string')
  if (!token) throw new Error('server did not start')

  const auth = { authorization: 'Bearer ' + token }
  const payload = 'tiered bytes that start life on local disk'
  const upload = await fetch(api + '/uploads?name=tiered.txt', {
    method: 'PUT', headers: { ...auth, 'content-type': 'text/plain' }, body: payload,
  })
  const node = (await upload.json()).node
  check('upload succeeds', upload.status === 201, 'status ' + upload.status)

  const hotFile = join(dataDir, 'blobs', node.blobHash.slice(0, 2), node.blobHash)
  check('the bytes start hot on local disk', existsSync(hotFile))

  const demote = await fetch(api + '/maintenance/storage/demote', {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ limit: 10 }),
  }).then((r) => r.json())
  check('demote moves at least one blob', (demote.moved || 0) >= 1, JSON.stringify(demote).slice(0, 200))
  check('the local copy is gone after demotion', !existsSync(hotFile))

  // Check the report *before* reading: a read records an access, which by design
  // makes the blob "recently used" again — recency and physical tier are
  // different things, and conflating them here would hide that.
  const tiersAfterDemote = await fetch(api + '/maintenance/storage/tiers', { headers: auth }).then((r) => r.json())
  check('the demoted blob counts as cold bytes', tiersAfterDemote.tiers.coldBytes >= payload.length, JSON.stringify({ cold: tiersAfterDemote.tiers.coldBytes }))

  const read = await fetch(api + '/files/' + node.id + '/content', { headers: auth })
  check('the file is still readable from the cold tier', (await read.text()) === payload)

  const ranged = await fetch(api + '/files/' + node.id + '/content', { headers: { ...auth, range: 'bytes=0-5' } })
  check('a range read crosses the tier boundary', ranged.status === 206 && (await ranged.text()) === payload.slice(0, 6))

  const backend = await fetch(api + '/maintenance/storage/backend', { headers: auth }).then((r) => r.json())
  check('the API reports the tiered driver', backend.backend.name === 'tiered', JSON.stringify(backend.backend))
} catch (error) {
  failures.push('harness: ' + error.message)
  console.log('  FAIL harness: ' + error.message)
} finally {
  stopAll()
  await sleep(300)
  try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* locked */ }
  console.log('\n' + passed + ' checks passed, ' + failures.length + ' failed')
  if (failures.length) { for (const failure of failures) console.log('  - ' + failure); process.exit(1) }
}