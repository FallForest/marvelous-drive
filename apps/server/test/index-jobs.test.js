import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { after, before, test } from 'node:test'
import { join } from 'node:path'
import { startServer, uniqueEmail } from './helpers.js'

let app
let createIndexJobs
let schema
before(async () => {
  app = await startServer()
  ;({ createIndexJobs } = await import('../src/ops/index-jobs.js'))
  const { db } = await import('../src/db.js')
  schema = db.prepare("SELECT sql FROM sqlite_master WHERE name='index_jobs'").get().sql
})
after(async () => { await app.close(); app.cleanup() })

const waitFor = async (condition) => {
  const deadline = Date.now() + 2000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for index worker.')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function databaseAt(path = ':memory:') {
  const database = new DatabaseSync(path)
  database.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE nodes(id TEXT PRIMARY KEY,user_id TEXT,workspace_id TEXT,name TEXT,mime TEXT,kind TEXT,
      blob_hash TEXT,version INTEGER,deleted_at TEXT);
    CREATE TABLE memberships(user_id TEXT,workspace_id TEXT);
    CREATE TABLE index_skips(node_id TEXT PRIMARY KEY,reason TEXT);
    CREATE TABLE node_text(node_id TEXT PRIMARY KEY);
    ${schema};`)
  return database
}

function fixture(t, index) {
  const database = databaseAt()
  const queues = []
  const build = (operation = index) => {
    const queue = createIndexJobs({ database, index: operation,
      remove: (id) => database.prepare('DELETE FROM index_skips WHERE node_id=?').run(id),
      log: { error() {} }, retryMs: 1 })
    queues.push(queue)
    return queue
  }
  t.after(async () => { for (const queue of queues) await queue.stop(); database.close() })
  const add = (id, { owner = 'owner', workspace = 'workspace', name = id + '.pdf' } = {}) => {
    database.prepare('INSERT INTO nodes VALUES(?,?,?,?,?,?,?,1,NULL)')
      .run(id, owner, workspace, name, name.endsWith('.txt') ? 'text/plain' : 'application/pdf', 'file', 'a'.repeat(64))
    return database.prepare('SELECT * FROM nodes WHERE id=?').get(id)
  }
  return { database, build, add }
}

test('container enqueue persists before returning and does not wait for extraction', async (t) => {
  let release
  let called = false
  const { database, build, add } = fixture(t, async () => {
    called = true
    await new Promise((resolve) => { release = resolve })
    return true
  })
  const queue = build()
  assert.equal(await queue.queue(add('document')), true)
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM index_jobs').get().n, 1)
  await waitFor(() => called)
  assert.equal(database.prepare('SELECT state FROM index_jobs').get().state, 'running')
  release()
  await queue.drain('owner')
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM index_jobs').get().n, 0)
})

test('resume replays persisted pending and interrupted running rows', async (t) => {
  const seen = []
  const path = join(app.dataDir, 'index-job-replay.sqlite')
  const database = databaseAt(path)
  const first = createIndexJobs({ database, index: async () => true, remove() {} })
  for (const id of ['pending', 'interrupted']) {
    database.prepare('INSERT INTO nodes VALUES(?,?,?,?,?,?,?,1,NULL)')
      .run(id, 'owner', 'workspace', id + '.pdf', 'application/pdf', 'file', 'a'.repeat(64))
    await first.queue({ id })
  }
  await first.stop()
  database.prepare("UPDATE index_jobs SET state='running' WHERE node_id='interrupted'").run()
  database.close()
  const reopened = new DatabaseSync(path)
  const restarted = createIndexJobs({ database: reopened, index: async (node) => { seen.push(node.id); return true }, remove() {} })
  t.after(async () => { await restarted.stop(); reopened.close() })
  restarted.resume()
  await restarted.drain('owner')
  assert.deepEqual(seen.sort(), ['interrupted', 'pending'])
})

test('an old completion cannot erase a newer queued generation', async (t) => {
  let release
  const seen = []
  const { database, build, add } = fixture(t, async (node) => {
    seen.push(node.version)
    if (seen.length === 1) await new Promise((resolve) => { release = resolve })
    return true
  })
  const queue = build()
  await queue.queue(add('replace'))
  await waitFor(() => seen.length === 1)
  database.prepare('UPDATE nodes SET version=2,blob_hash=? WHERE id=?').run('b'.repeat(64), 'replace')
  await queue.queue({ id: 'replace' })
  release()
  await queue.drain('owner')
  assert.deepEqual(seen, [1, 2])
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM index_jobs').get().n, 0)
})

test('metadata changes during parsing are retried using the current node', async (t) => {
  let release
  const names = []
  const { database, build, add } = fixture(t, async (node) => {
    names.push(node.name)
    if (names.length === 1) await new Promise((resolve) => { release = resolve })
    return true
  })
  const queue = build()
  await queue.queue(add('rename'))
  await waitFor(() => names.length === 1)
  database.exec("UPDATE nodes SET version=2,name='renamed.pdf' WHERE id='rename'")
  release()
  await queue.drain('owner')
  assert.deepEqual(names, ['rename.pdf', 'renamed.pdf'])
})

test('deleted and trashed jobs are dropped without indexing their content', async (t) => {
  const seen = []
  const { database, build, add } = fixture(t, async (node) => { seen.push(node.id); return true })
  const queue = build()
  await queue.queue(add('deleted'))
  await queue.queue(add('trashed'))
  database.exec("DELETE FROM nodes WHERE id='deleted'; UPDATE nodes SET deleted_at='now' WHERE id='trashed';")
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM index_jobs WHERE node_id='deleted'").get().n, 0)
  await waitFor(() => database.prepare('SELECT COUNT(*) AS n FROM index_jobs').get().n === 0)
  assert.deepEqual(seen, [])
})

test('failed jobs retry three times and retain diagnostic state', async (t) => {
  let calls = 0
  const { database, build, add } = fixture(t, async () => { calls += 1; throw new Error('fixture read failed') })
  const queue = build()
  await queue.queue(add('failure'))
  await queue.drain('owner')
  const failed = database.prepare('SELECT * FROM index_jobs').get()
  assert.equal(calls, 3)
  assert.equal(failed.state, 'failed')
  assert.equal(failed.attempts, 3)
  assert.match(failed.last_error, /fixture read failed/)
})

test('deliberately refused documents complete instead of spinning on retries', async (t) => {
  let calls = 0
  const { database, build, add } = fixture(t, async (node) => {
    calls += 1
    database.prepare('INSERT INTO index_skips VALUES(?,?)').run(node.id, 'encrypted')
    return false
  })
  const queue = build()
  await queue.queue(add('encrypted'))
  await queue.drain('owner')
  assert.equal(calls, 1)
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM index_jobs').get().n, 0)
})

test('a successful manual rebuild clears old failures without clearing new pending work', async (t) => {
  const { database, build, add } = fixture(t, async () => false)
  const queue = build()
  await queue.queue(add('repaired'))
  await queue.queue(add('replacement'))
  await queue.drain('owner')
  assert.equal(queue.summary().failed, 2)
  database.exec("INSERT INTO index_skips VALUES('repaired','no-text'); INSERT INTO node_text VALUES('replacement');")
  // A newer upload has already arrived while the administrator rebuilt it.
  database.exec("UPDATE index_jobs SET state='pending',generation=generation+1 WHERE node_id='replacement'")
  assert.equal(queue.reconcile(), 1)
  assert.equal(database.prepare("SELECT state FROM index_jobs WHERE node_id='replacement'").get().state, 'pending')
  assert.equal(queue.summary().failed, 0)
})

test('search barriers wait only for readable jobs and stop waiting on revoked membership', async (t) => {
  let release
  let called = false
  const { database, build, add } = fixture(t, async () => {
    called = true
    await new Promise((resolve) => { release = resolve })
    return true
  })
  const queue = build()
  await queue.queue(add('private', { owner: 'other' }))
  await waitFor(() => called)
  assert.deepEqual(queue.summary('stranger'), { pending: 0, running: 0, failed: 0 })
  assert.deepEqual(queue.summary('other'), { pending: 0, running: 1, failed: 0 })
  await queue.drain('stranger', { timeoutMs: 20 })
  database.exec("INSERT INTO memberships VALUES('member','workspace')")
  const waiting = queue.drain('member', { timeoutMs: 100 })
  database.exec("DELETE FROM memberships WHERE user_id='member'")
  await waiting
  release()
  await queue.drain('other')
})

test('content search has a finite wait budget and can retry later', async (t) => {
  let release
  let called = false
  const { build, add } = fixture(t, async () => {
    called = true
    await new Promise((resolve) => { release = resolve })
    return true
  })
  const queue = build()
  await queue.queue(add('slow'))
  await waitFor(() => called)
  await assert.rejects(queue.drain('owner', { timeoutMs: 15 }), (error) => error.status === 503 && error.code === 'SEARCH_INDEX_BUSY')
  release()
  await queue.drain('owner')
})

test('plain text indexing remains immediate without a persisted parser job', async (t) => {
  let done = false
  const { database, build, add } = fixture(t, async () => { done = true; return true })
  const queue = build()
  await queue.queue(add('text', { name: 'note.txt' }))
  assert.equal(done, true)
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM index_jobs').get().n, 0)
})

test('an upload returns while its PDF parse is blocked; content search waits for it', async () => {
  const { backend } = await import('../src/storage/backend.js')
  const { db } = await import('../src/db.js')
  const registered = await app.client('POST', '/api/v1/auth/register', {
    body: { email: uniqueEmail(), password: 'index queue password' },
  })
  const token = registered.json.token
  const originalStat = backend.stat
  let release
  let entered = false
  backend.stat = async function (...args) {
    if (!db.prepare('SELECT 1 FROM index_jobs WHERE blob_hash=?').get(args[0])) return originalStat.apply(this, args)
    entered = true
    await new Promise((resolve) => { release = resolve })
    return originalStat.apply(this, args)
  }
  try {
    const uploaded = await app.client('PUT', '/api/v1/uploads?name=queued.pdf', {
      token, raw: true, body: Buffer.from('%PDF-1.4\nnot searchable fixture'),
      headers: { 'content-type': 'application/pdf' },
    })
    assert.equal(uploaded.status, 201, uploaded.text)
    const id = uploaded.json.node.id
    assert.ok(['pending', 'running'].includes(db.prepare('SELECT state FROM index_jobs WHERE node_id=?').get(id).state))
    await waitFor(() => entered)
    assert.equal(db.prepare('SELECT state FROM index_jobs WHERE node_id=?').get(id).state, 'running')
    const status = await app.client('GET', '/api/v1/maintenance/search', { token })
    assert.equal(status.status, 200)
    assert.equal(status.json.upToDate, false)
    assert.equal(status.json.jobs.running, 1)
    const stats = await app.client('GET', '/api/v1/storage/stats', { token })
    assert.equal(stats.json.stats.search.jobs.running, 1)
    const nameOnly = await app.client('GET', '/api/v1/search?q=queued&scope=name', { token })
    assert.equal(nameOnly.status, 200)
    assert.ok(nameOnly.json.results.some((node) => node.id === id))
    let completed = false
    const searching = app.client('GET', '/api/v1/search?q=queued&scope=content', { token }).then((result) => { completed = true; return result })
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(completed, false)
    backend.stat = originalStat
    release()
    assert.equal((await searching).status, 200)
    assert.equal(db.prepare('SELECT 1 FROM index_jobs WHERE node_id=?').get(id), undefined)
  } finally {
    backend.stat = originalStat
    release?.()
  }
})
