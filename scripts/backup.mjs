#!/usr/bin/env node
/**
 * Backup / restore for the data directory.
 *
 *   node scripts/backup.mjs [--data ./data] [--out ./backups]
 *   node scripts/backup.mjs restore backups/drive-<stamp>.tar
 *
 * A backup is a tar archive holding `drive.db` (after a WAL checkpoint),
 * `.jwt-secret` and the whole `blobs/` tree. Stop the server first, or accept
 * that writes during the copy may be inconsistent.
 */

import { existsSync, mkdirSync } from 'node:fs'
import { cp, mkdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { argv, flagReader } from './lib/args.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = argv()
const flag = flagReader(args)

const dataDir = resolve(flag('data', process.env.DRIVE_DATA_DIR || join(repoRoot, 'data')))
const outDir = resolve(flag('out', join(repoRoot, 'backups')))
const command = args[0] === 'restore' ? 'restore' : 'create'
const stamp = new Date().toISOString().replace(/[:.]/g, '-')

if (!existsSync(dataDir)) {
  console.error(`data directory not found: ${dataDir}`)
  process.exit(1)
}

if (command === 'create') {
  mkdirSync(outDir, { recursive: true })
  const dbPath = join(dataDir, 'drive.db')
  if (existsSync(dbPath)) {
    // Checkpoint hands the WAL back to the main file so a plain copy is complete.
    const db = new DatabaseSync(dbPath)
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    db.close()
  }
  const target = join(outDir, `drive-${stamp}.tar`)
  // `quarantine` holds blobs that failed verification: they are evidence, not
  // garbage, so a backup is the wrong place to silently drop them.
  const files = ['drive.db', '.jwt-secret', 'blobs', 'quarantine']
  const existing = files.filter((file) => existsSync(join(dataDir, file)))
  await tar(['-cf', target, '-C', dataDir, ...existing])
  const info = await stat(target)
  console.log(`backup written: ${target} (${(info.size / 1024 / 1024).toFixed(2)} MiB)`)
  console.log('restore with: node scripts/backup.mjs restore ' + target)
} else {
  const archive = args[1]
  if (!archive || !existsSync(archive)) {
    console.error('usage: node scripts/backup.mjs restore <archive.tar>')
    process.exit(2)
  }
  const safety = join(outDir, `pre-restore-${stamp}`)
  await mkdir(safety, { recursive: true })
  for (const file of ['drive.db', '.jwt-secret']) {
    if (existsSync(join(dataDir, file))) await cp(join(dataDir, file), join(safety, file))
  }
  await tar(['-xf', resolve(archive), '-C', dataDir])
  console.log(`restored ${archive} into ${dataDir}`)
  console.log(`previous database copied to ${safety}`)
}

function tar(argv) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('tar', argv, { stdio: 'inherit' })
    child.on('error', (error) => reject(new Error(`tar is required: ${error.message}`)))
    child.on('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error(`tar exited with ${code}`))))
  })
}