#!/usr/bin/env node
/**
 * End-to-end check of the S3 driver against a **signature-verifying** fixture.
 *
 *   node scripts/s3-check.mjs [--drive-port 4401] [--s3-port 9101]
 *
 * The server unit tests use a stub that trusts whatever arrives; this one boots
 * the real process on `DRIVE_STORAGE=s3` and talks to `scripts/s3-fixture.mjs`,
 * which recomputes the SigV4 signature from the wire. A bug in encoding, header
 * selection or the key chain therefore fails here with a 403 and the canonical
 * request printed, instead of failing in production.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf('--' + name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const s3Port = Number(flag('s3-port', 9101))
const drivePort = Number(flag('drive-port', 4401))
const BUCKET = 'drive'
const KEY = 'minioadmin'

let passed = 0
const failures = []
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log('  ok   ' + name) }
  else { failures.push(name + (detail ? ': ' + detail : '')); console.log('  FAIL ' + name + (detail ? ': ' + detail : '')) }
}

const children = []
function start(file, env, label) {
  const child = spawn(process.execPath, [file], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => {
    if (process.env.DEBUG) process.stdout.write('[' + label + '] ' + chunk)
  })
  child.stderr.on('data', (chunk) => {
    if (process.env.DEBUG) process.stderr.write('[' + label + '!] ' + chunk)
  })
  children.push(child)
  return child
}

function stopAll() {
  for (const child of children) {
    try { child.kill() } catch { /* already gone */ }
  }
}

process.on('exit', stopAll)

const dataDir = mkdtempSync(join(tmpdir(), 'mdrive-s3-check-'))
const api = 'http://127.0.0.1:' + drivePort + '/api/v1'

try {
  console.log('S3 driver check (fixture verifies SigV4)\n')
  start(join(here, 's3-fixture.mjs'), {
    S3_PORT: String(s3Port),
    S3_ACCESS_KEY_ID: KEY,
    S3_SECRET_ACCESS_KEY: KEY,
  }, 's3')

  // Wait for the fixture to answer (an unsigned request gets 403, which is proof
  // it is up and checking).
  let ready = false
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch('http://127.0.0.1:' + s3Port + '/' + BUCKET + '/ping', { method: 'PUT', body: 'x' })
      if (response.status === 403) { ready = true; break }
    } catch { /* not up yet */ }
    await sleep(200)
  }
  check('fixture is up and rejects unsigned requests', ready)

  start(join(repoRoot, 'apps/server/src/index.js'), {
    DRIVE_DATA_DIR: dataDir,
    DRIVE_STORAGE: 's3',
    DRIVE_S3_ENDPOINT: 'http://127.0.0.1:' + s3Port,
    DRIVE_S3_BUCKET: BUCKET,
    DRIVE_S3_ACCESS_KEY_ID: KEY,
    DRIVE_S3_SECRET_ACCESS_KEY: KEY,
    DRIVE_S3_REGION: 'us-east-1',
    DRIVE_LOG: '0',
    PORT: String(drivePort),
    HOST: '127.0.0.1',
  }, 'drive')

  const email = 's3check-' + Date.now() + '@example.com'
  let token = null
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(api + '/auth/register', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 's3 check password' }),
      })
      if (response.status === 201) { token = (await response.json()).token; break }
    } catch { /* not up yet */ }
    await sleep(250)
  }
  check('server boots on the s3 driver', typeof token === 'string')
  if (!token) throw new Error('server did not start')

  const auth = { authorization: 'Bearer ' + token }
  const payload = '# S3 check\n\nstored through the signed driver.\n'
  const upload = await fetch(api + '/uploads?name=s3.txt', {
    method: 'PUT', headers: { ...auth, 'content-type': 'text/plain' }, body: payload,
  })
  check('upload stores bytes in the bucket', upload.status === 201, 'status ' + upload.status)
  const node = (await upload.json()).node

  const whole = await fetch(api + '/files/' + node.id + '/content', { headers: auth })
  check('download returns the bytes', (await whole.text()) === payload)

  const ranged = await fetch(api + '/files/' + node.id + '/content', { headers: { ...auth, range: 'bytes=0-9' } })
  check('range download answers 206', ranged.status === 206, 'status ' + ranged.status)
  check('range body is the right slice', (await ranged.text()) === payload.slice(0, 10))

  const preview = await fetch(api + '/files/' + node.id + '/text', { headers: auth })
  const previewBody = await preview.json()
  check('text preview reads through the driver', previewBody.text === payload)

  const search = await fetch(api + '/search?q=stored&scope=content', { headers: auth }).then((r) => r.json())
  check('content search indexes a remote blob', search.results.some((row) => row.id === node.id))

  const folder = await fetch(api + '/nodes', {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 's3-folder', kind: 'folder' }),
  }).then((r) => r.json())
  await fetch(api + '/uploads?parentId=' + folder.node.id + '&name=inner.txt', {
    method: 'PUT', headers: { ...auth, 'content-type': 'text/plain' }, body: 'inner',
  })
  const archive = await fetch(api + '/nodes/' + folder.node.id + '/archive', { method: 'POST', headers: auth })
  check('ZIP assembly downloads the objects it needs', archive.status === 201, 'status ' + archive.status)

  await fetch(api + '/nodes/' + node.id, { method: 'DELETE', headers: auth })
  const purge = await fetch(api + '/nodes/' + node.id + '/permanent', { method: 'DELETE', headers: auth })
  check('purge removes the object from the bucket', purge.status === 200)

  const backend = await fetch(api + '/maintenance/storage/backend', { headers: auth }).then((r) => r.json())
  check('the API reports the s3 driver', backend.backend.name === 's3', JSON.stringify(backend.backend))
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
