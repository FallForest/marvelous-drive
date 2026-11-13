#!/usr/bin/env node
/**
 * Syntax check for every JavaScript file in the repository.
 *
 *   node scripts/check-syntax.mjs
 *
 * Uses `node --check` in a worker pool: fast enough to run before a commit and
 * strict enough to catch a stray bracket in a file no test imports.
 */

import { readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { fileURLToPath } from 'node:url'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const targets = ['apps', 'packages', 'scripts']

async function walk(dir, found) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'data' || entry.name === '.tmp' || entry.name.startsWith('_')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await walk(path, found)
    else if (/\.(mjs|js)$/.test(entry.name) && !path.includes('node_modules')) found.push(path)
  }
  return found
}

const files = []
for (const target of targets) await walk(join(rootDir, target), files)
if (files.length === 0) { console.error('no JavaScript files found under ' + targets.join(', ')); process.exit(1) }

const check = (file) => new Promise((resolvePromise) => {
  const child = spawn(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.on('exit', (code) => resolvePromise({ file, code, stderr }))
})

const limit = Math.max(2, availableParallelism())
const queue = [...files]
const failures = []
await Promise.all(Array.from({ length: limit }, async () => {
  while (queue.length) {
    const file = queue.pop()
    const result = await check(file)
    if (result.code !== 0) failures.push(result)
  }
}))

for (const failure of failures) console.error(relative(rootDir, failure.file) + ': ' + failure.stderr.trim())
console.log(files.length + ' files checked, ' + failures.length + ' failed')
process.exit(failures.length ? 1 : 0)
