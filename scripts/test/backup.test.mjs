import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createDatabaseSnapshot, createFullBackup, restoreBackup, verifyBackup } from '../lib/backup.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const sha256 = (body) => createHash('sha256').update(body).digest('hex')
const oldBody = Buffer.from('unique historical backup payload')
const currentBody = Buffer.from('unique current backup payload')

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mdrive-backup-test-'))
  t.after(async () => {
    assert.equal(resolve(dirname(root)), resolve(tmpdir()))
    assert.ok(basename(root).startsWith('mdrive-backup-test-'))
    await rm(root, { recursive: true, force: true })
  })
  const dataDir = join(root, "drive data's")
  const outDir = join(root, "backup output's")
  await mkdir(dataDir)
  const db = new DatabaseSync(join(dataDir, 'drive.db'))
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE blobs(hash TEXT PRIMARY KEY,size INTEGER NOT NULL);
    CREATE TABLE nodes(id TEXT PRIMARY KEY,name TEXT,blob_hash TEXT REFERENCES blobs(hash));
    CREATE TABLE node_versions(id TEXT PRIMARY KEY,node_id TEXT REFERENCES nodes(id),blob_hash TEXT REFERENCES blobs(hash));`)
  for (const body of [oldBody, currentBody]) {
    const hash = sha256(body)
    db.prepare('INSERT INTO blobs VALUES(?,?)').run(hash, body.length)
    await mkdir(join(dataDir, 'blobs', hash.slice(0, 2)), { recursive: true })
    await writeFile(join(dataDir, 'blobs', hash.slice(0, 2), hash), body)
  }
  db.prepare('INSERT INTO nodes VALUES(?,?,?)').run('file', 'restored.txt', sha256(currentBody))
  db.prepare('INSERT INTO node_versions VALUES(?,?,?)').run('v1', 'file', sha256(oldBody))
  await writeFile(join(dataDir, '.jwt-secret'), 'isolated-backup-secret')
  await mkdir(join(dataDir, 'quarantine'))
  await writeFile(join(dataDir, 'quarantine', sha256('corrupt') + '.123'), 'preserved evidence')
  return { root, dataDir, outDir, db }
}

test('online snapshot includes committed WAL pages and independently saves the generated JWT secret', async (t) => {
  const f = await fixture(t)
  try {
    assert.ok(existsSync(join(f.dataDir, 'drive.db-wal')))
    const path = await createDatabaseSnapshot({ ...f, name: 'online' })
    const snapshot = new DatabaseSync(path, { readOnly: true })
    try {
      assert.equal(snapshot.prepare('SELECT COUNT(*) AS count FROM nodes').get().count, 1)
      assert.equal(snapshot.prepare('SELECT blob_hash FROM node_versions').get().blob_hash, sha256(oldBody))
    } finally { snapshot.close() }
    assert.equal(await readFile(join(f.outDir, 'online.jwt-secret'), 'utf8'), 'isolated-backup-secret')
    assert.equal(JSON.parse(await readFile(join(f.outDir, 'online.json'), 'utf8')).kind, 'database-only')
    assert.ok(!(await readdir(f.outDir)).includes('blobs'))
  } finally { f.db.close() }
})

test('full backup refuses live-by-default and nonlocal stores', async (t) => {
  const f = await fixture(t)
  f.db.close()
  await assert.rejects(createFullBackup({ ...f, name: 'unsafe' }), /requires --offline/)
  await assert.rejects(createFullBackup({ ...f, name: 'remote', offline: true, storage: 's3' }), /requires local blob storage/)
  const cli = spawnSync(process.execPath, ['scripts/backup.mjs', '--data', f.dataDir, '--out', f.outDir], { cwd: repoRoot, encoding: 'utf8' })
  assert.equal(cli.status, 1)
  assert.match(cli.stderr, /--offline/)
})

test('full backup rejects equal or descendant output paths with native path separators', async (t) => {
  const f = await fixture(t)
  f.db.close()
  for (const outDir of [f.dataDir, join(f.dataDir, 'blobs'), join(f.dataDir, 'blobs', 'nested'), join(f.dataDir, 'backups')]) {
    await assert.rejects(createFullBackup({ ...f, outDir, name: 'nested', offline: true }), /outside the source data directory/)
  }
})

test('offline archive restores current bytes, history, secret and quarantine into a new or empty destination', async (t) => {
  const f = await fixture(t)
  f.db.close()
  const archive = await createFullBackup({ ...f, name: 'full', offline: true })
  assert.equal(archive.blobs, 2)
  for (const emptyExisting of [false, true]) {
    const target = join(f.root, emptyExisting ? 'existing empty' : 'new parent', 'restored')
    if (emptyExisting) await mkdir(target, { recursive: true })
    const restored = await restoreBackup({ archive: archive.path, dataDir: target })
    assert.deepEqual({ blobs: restored.blobs, bytes: restored.bytes }, { blobs: 2, bytes: oldBody.length + currentBody.length })
    assert.deepEqual(await verifyBackup(target), { blobs: 2, bytes: oldBody.length + currentBody.length })
    const db = new DatabaseSync(join(target, 'drive.db'), { readOnly: true })
    try {
      assert.equal(db.prepare('SELECT name FROM nodes').get().name, 'restored.txt')
      assert.equal(db.prepare('SELECT blob_hash FROM node_versions').get().blob_hash, sha256(oldBody))
    } finally { db.close() }
    assert.equal(await readFile(join(target, '.jwt-secret'), 'utf8'), 'isolated-backup-secret')
    assert.equal(await readFile(join(target, 'quarantine', sha256('corrupt') + '.123'), 'utf8'), 'preserved evidence')
    assert.ok(!existsSync(join(target, 'drive.db-wal')))
    assert.ok(!existsSync(join(target, 'drive.db-shm')))
  }
})

test('existing data and stale WAL files are never overlaid by restore', async (t) => {
  const f = await fixture(t)
  f.db.close()
  const archive = await createFullBackup({ ...f, name: 'existing', offline: true })
  const target = join(f.root, 'live target')
  await mkdir(target)
  await writeFile(join(target, 'drive.db-wal'), 'do not overwrite')
  await assert.rejects(restoreBackup({ archive: archive.path, dataDir: target }), /empty destination/)
  assert.equal(await readFile(join(target, 'drive.db-wal'), 'utf8'), 'do not overwrite')
  assert.ok(!existsSync(join(target, 'drive.db')))
})

test('full backup verifies historical bytes, refusing a missing or same-size corrupted blob', async (t) => {
  const f = await fixture(t)
  f.db.close()
  const oldPath = join(f.dataDir, 'blobs', sha256(oldBody).slice(0, 2), sha256(oldBody))
  await writeFile(oldPath, Buffer.alloc(oldBody.length, 0x78))
  await assert.rejects(createFullBackup({ ...f, name: 'corrupt', offline: true }), /checksum mismatch/)
  assert.ok(!existsSync(join(f.outDir, 'corrupt.tar')))
  await rm(oldPath)
  await assert.rejects(createFullBackup({ ...f, name: 'missing', offline: true }), /Missing or wrong-size blob/)
  assert.ok(!existsSync(join(f.outDir, 'missing.tar')))
})

test('corrupt archived content fails before anything is promoted to the requested target', async (t) => {
  const f = await fixture(t)
  f.db.close()
  const archive = await createFullBackup({ ...f, name: 'tampered', offline: true })
  const bytes = await readFile(archive.path)
  const start = bytes.indexOf(oldBody)
  assert.ok(start >= 0)
  bytes[start] ^= 0x01
  await writeFile(archive.path, bytes)
  const target = join(f.root, 'must stay absent')
  await assert.rejects(restoreBackup({ archive: archive.path, dataDir: target }), /checksum mismatch/)
  assert.ok(!existsSync(target))
  assert.ok(!(await readdir(f.root)).some((name) => name.startsWith('.drive-backup-')))
})

function tarEntry(name, { type = '0', body = Buffer.alloc(0), size = body.length, prefix = '' } = {}) {
  const header = Buffer.alloc(512)
  header.write(name)
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12)
  header[156] = type.charCodeAt(0)
  header.write(prefix, 345)
  header.fill(0x20, 148, 156)
  header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8)
  return Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512)])
}

test('restore rejects traversal, absolute paths, link records, WAL entries and duplicate entries', async (t) => {
  const f = await fixture(t)
  f.db.close()
  const entries = [
    tarEntry('../escaped'), tarEntry('/escaped'), tarEntry('C:/escaped'), tarEntry('blobs\\escaped'),
    tarEntry('drive.db', { prefix: '../outside' }), tarEntry('drive.db', { type: '2' }),
    tarEntry('drive.db', { type: '1' }), tarEntry('drive.db', { type: '3' }), tarEntry('drive.db', { type: 'x' }),
    tarEntry('drive.db-wal'), Buffer.concat([tarEntry('drive.db'), tarEntry('drive.db')]),
  ]
  for (let i = 0; i < entries.length; i++) {
    const archive = join(f.root, 'unsafe-' + i + '.tar')
    await writeFile(archive, Buffer.concat([entries[i], Buffer.alloc(1024)]))
    const target = join(f.root, 'unsafe-target-' + i)
    await assert.rejects(restoreBackup({ archive, dataDir: target }), /Unsafe archive|Unexpected archive|refuses archive|Duplicate archive/)
    assert.ok(!existsSync(target))
  }
  assert.ok(!existsSync(join(f.root, 'escaped')))
})

test('restore rejects corrupt checksums, invalid lengths, missing terminators and trailing records', async (t) => {
  const f = await fixture(t)
  f.db.close()
  const full = await createFullBackup({ ...f, name: 'valid', offline: true })
  const valid = await readFile(full.path)
  const badChecksum = Buffer.from(valid)
  badChecksum[0] ^= 1
  const badNumber = tarEntry('drive.db')
  badNumber.write('zzzzzzzzzzz\0', 124, 12)
  badNumber.fill(0x20, 148, 156)
  badNumber.write(badNumber.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8)
  const variants = [badChecksum, Buffer.concat([badNumber, Buffer.alloc(1024)]), tarEntry('drive.db', { size: 2048 }), valid.subarray(0, valid.length - 512), Buffer.concat([valid, tarEntry('../outside')])]
  for (let i = 0; i < variants.length; i++) {
    const archive = join(f.root, 'broken-' + i + '.tar')
    await writeFile(archive, variants[i])
    const target = join(f.root, 'broken-target-' + i)
    await assert.rejects(restoreBackup({ archive, dataDir: target }), /checksum|number|length|terminator|trailing/)
    assert.ok(!existsSync(target))
  }
})

const bash = process.platform === 'win32'
  ? ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe'].find(existsSync)
  : '/bin/bash'
const bashPath = (path) => process.platform === 'win32' ? path.replace(/^([A-Za-z]):[\\/]/, (_, letter) => '/' + letter.toLowerCase() + '/').replace(/\\/g, '/') : path

test('deployment default saves database and secret even with BACKUP_DATA=0', { skip: !bash }, async (t) => {
  const f = await fixture(t)
  try {
    const command = spawnSync(bash, ['scripts/deploy/backup.sh', '20261116-010101'], {
      cwd: repoRoot, encoding: 'utf8', env: { ...process.env, DRIVE_DATA_DIR: bashPath(f.dataDir), BACKUP_DIR: bashPath(f.outDir), BACKUP_DATA: '0' },
    })
    assert.equal(command.status, 0, command.stderr + command.stdout)
    const db = new DatabaseSync(join(f.outDir, 'pre-update-20261116-010101.db'), { readOnly: true })
    try { assert.equal(db.prepare('SELECT COUNT(*) AS count FROM nodes').get().count, 1) } finally { db.close() }
    assert.equal(await readFile(join(f.outDir, 'pre-update-20261116-010101.jwt-secret'), 'utf8'), 'isolated-backup-secret')
  } finally { f.db.close() }
})

test('an unavailable metadata snapshot stops update before pinning or invoking Docker', { skip: !bash }, async (t) => {
  const f = await fixture(t)
  f.db.close()
  const isolatedRoot = join(f.root, 'updater project')
  await mkdir(join(isolatedRoot, 'scripts', 'deploy'), { recursive: true })
  await mkdir(join(isolatedRoot, 'scripts', 'lib'), { recursive: true })
  for (const path of ['scripts/deploy/update.sh', 'scripts/deploy/backup.sh', 'scripts/backup.mjs', 'scripts/lib/backup.mjs', 'scripts/lib/args.mjs']) {
    await copyFile(join(repoRoot, path), join(isolatedRoot, path))
  }
  await writeFile(join(isolatedRoot, 'package.json'), '{"version":"0.1.0"}')
  await writeFile(join(isolatedRoot, '.env'), 'DRIVE_VERSION=0.1.0\n')
  await writeFile(join(isolatedRoot, 'docker-compose.yml'), 'services: {}\n')
  await writeFile(join(isolatedRoot, '.update-manifest.json'), '{"version":"0.2.0","image":"isolated-fixture:0.2.0"}')
  // Snapshot failure must exit before Docker is called. Keep an inert Docker
  // stub first in PATH as an additional guard against touching any real stack.
  const bin = join(isolatedRoot, 'bin')
  await mkdir(bin)
  await writeFile(join(bin, 'docker'), '#!/bin/sh\necho called > "' + bashPath(join(isolatedRoot, 'docker-called')) + '"\nexit 91\n', { mode: 0o755 })
  const result = spawnSync(bash, ['scripts/deploy/update.sh'], {
    cwd: isolatedRoot, encoding: 'utf8', env: { ...process.env,
      PATH: bashPath(bin) + (process.platform === 'win32' ? ';' : ':') + process.env.PATH,
      DRIVE_DATA_DIR: bashPath(join(f.root, 'missing source')), BACKUP_DIR: bashPath(f.outDir), BACKUP_DATA: '0',
    },
  })
  assert.notEqual(result.status, 0, result.stdout)
  assert.match(result.stderr, /regular drive.db is required/)
  assert.equal(await readFile(join(isolatedRoot, '.env'), 'utf8'), 'DRIVE_VERSION=0.1.0\n')
  assert.equal(JSON.parse(await readFile(join(isolatedRoot, 'package.json'), 'utf8')).version, '0.1.0')
  assert.ok(!existsSync(join(isolatedRoot, 'docker-called')))
})

test('a failed full deployment backup restarts the stopped drive using an inert Docker stub', { skip: !bash }, async (t) => {
  const f = await fixture(t)
  f.db.close()
  await writeFile(join(f.dataDir, 'blobs', sha256(oldBody).slice(0, 2), sha256(oldBody)), Buffer.alloc(oldBody.length, 0x78))
  const bootstrap = join(f.root, 'isolated-shell.sh')
  const log = join(f.root, 'docker.log')
  await writeFile(bootstrap, `#!/usr/bin/env bash
docker() {
  case " $* " in
    *" ps "*) echo isolated-container ;;
    *" stop "*) echo stop >> "$BACKUP_DOCKER_LOG" ;;
    *" start "*) echo start >> "$BACKUP_DOCKER_LOG" ;;
    *) return 91 ;;
  esac
}
du() { printf '1\\tdata\\n'; }
df() { printf 'Filesystem 1M-blocks Used Available Use%% Mounted\\nfixture 100000 1 99999 1%% /\\n'; }
export -f docker du df
exec "$BASH" "$@"
`)
  const result = spawnSync(bash, [bashPath(bootstrap), 'scripts/deploy/backup.sh', '20261116-020202'], {
    cwd: repoRoot, encoding: 'utf8', env: { ...process.env,
      DRIVE_DATA_DIR: bashPath(f.dataDir), BACKUP_DIR: bashPath(f.outDir), BACKUP_DATA: '1', BACKUP_DOCKER_LOG: bashPath(log),
    },
  })
  assert.notEqual(result.status, 0, result.stdout)
  assert.match(result.stderr, /checksum mismatch/)
  assert.equal((await readFile(log, 'utf8')).replace(/\r/g, ''), 'stop\nstart\n')
  assert.ok(existsSync(join(f.outDir, 'pre-update-20261116-020202.db')))
  assert.ok(!existsSync(join(f.outDir, 'data-20261116-020202.tar')))
})
