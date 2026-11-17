#!/usr/bin/env node
/** Complete local backups require stopped writers; snapshot is metadata only. */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { argv, flagReader } from './lib/args.mjs'
import { createDatabaseSnapshot, createFullBackup, restoreBackup } from './lib/backup.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = argv()
const flag = flagReader(args)

const dataDir = resolve(flag('data', process.env.DRIVE_DATA_DIR || join(repoRoot, 'data')))
const outDir = resolve(flag('out', join(repoRoot, 'backups')))
const command = ['snapshot', 'restore'].includes(args[0]) ? args[0] : 'create'
const stamp = new Date().toISOString().replace(/[:.]/g, '-')

try {
  if (command === 'snapshot') {
    const path = await createDatabaseSnapshot({ dataDir, outDir, name: flag('name', 'database-' + stamp) })
    console.log('consistent database snapshot written: ' + path)
    console.log('Metadata and generated JWT secret only; blob bytes are not included. Copy backups off this machine separately.')
  } else if (command === 'restore') {
    if (!args[1] || args[1].startsWith('--')) throw new Error('usage: node scripts/backup.mjs restore <archive.tar> --data <empty-directory>')
    const restored = await restoreBackup({ archive: args[1], dataDir })
    console.log(`restored ${restored.blobs} verified blobs (${restored.bytes} bytes) into ${restored.path}`)
  } else {
    const backup = await createFullBackup({
      dataDir, outDir, name: flag('name', 'drive-' + stamp), offline: args.includes('--offline'),
      storage: process.env.DRIVE_STORAGE || 'local',
    })
    console.log(`backup written: ${backup.path} (${backup.blobs} verified blobs, ${backup.bytes} bytes)`)
    console.log('restore into an empty directory: node scripts/backup.mjs restore "' + backup.path + '" --data <empty-directory>')
  }
} catch (error) {
  console.error('backup: ' + error.message)
  process.exitCode = 1
}
