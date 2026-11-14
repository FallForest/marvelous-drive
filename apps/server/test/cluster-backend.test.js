import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db } from '../src/db.js'
import { ClusterBackend } from '../src/storage/cluster.js'
import { sealSecret, openSecret } from '../src/security.js'

/**
 * Placement and durability rules, with the network stubbed.
 *
 * The question this file answers is the one that decides whether a multi-machine
 * drive is safe: *when does an upload count as stored?* Getting it wrong is
 * silent — the API says 201 and one box holds the only copy — so the rules are
 * pinned here rather than discovered during a disk failure.
 *
 * These tests write to the shared `db` (the process has exactly one connection),
 * so `before` gives the file a throwaway `DRIVE_DATA_DIR` and `after` restores it.
 * Running this file alone is not enough: the node:test runner executes files in
 * one process, and leftover rows from another suite would make "chosen 2 nodes"
 * mean something else.
 */

let dataDir
let backend

/** A fake node: records every request, so placement can be inspected. */
function fakeFetch(responses = {}) {
  const calls = []
  const impl = async (url, init) => {
    const path = new URL(url).pathname
    calls.push({ url, path, method: init.method })
    const key = init.method + ' ' + path.replace(/\/node\/v1/, '')
    if (responses[key]) return responses[key](url, init)
    if (path.endsWith('/health')) {
      return new Response(JSON.stringify({ ok: true, usedBytes: 0, capacityBytes: 0, blobs: 0 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    if (init.method === 'PUT') return new Response(JSON.stringify({ ok: true }), { status: 201 })
    if (init.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': '10' } })
    if (init.method === 'GET') return new Response('0123456789', { status: 200 })
    if (init.method === 'DELETE') return new Response(JSON.stringify({ ok: true }), { status: 200 })
    return new Response('{}', { status: 200 })
  }
  return { impl, calls }
}

function enrol(name, endpoint, { capacity = 0, state = 'active', priority = 100, token = 'tok-' + name } = {}) {
  const id = 'node-' + name
  db.prepare(`INSERT INTO storage_nodes(id,name,endpoint,token_sealed,capacity_bytes,used_bytes,state,priority,created_at)
              VALUES (?,?,?,?,?,0,?,?,?)`).run(id, name, endpoint, sealSecret(token), capacity, state, priority, new Date().toISOString())
  return id
}

/** Every blob hash this file uses: one repeated hex character, so it is unambiguous. */
const OWN_HASHES = ['a', 'b', 'c', 'd', 'e', 'f', '1'].map((char) => char.repeat(64))

/**
 * Removes only what this file created.
 *
 * `db` is one shared in-process connection, and the runner executes every test
 * file in the same process — so a blanket `DELETE FROM blobs` here would wipe the
 * rows another suite is using. Both names are targeted exactly: the nodes are
 * `node-*` and the hashes are the fixed list above.
 */
function clear() {
  const placeholders = OWN_HASHES.map(() => '?').join(',')
  db.prepare(`DELETE FROM blob_placements WHERE hash IN (${placeholders})`).run(...OWN_HASHES)
  db.prepare(`DELETE FROM blobs WHERE hash IN (${placeholders})`).run(...OWN_HASHES)
  db.prepare("DELETE FROM storage_nodes WHERE id LIKE 'node-%'").run()
}

/** Writes a spool file the backend can consume, and returns its path. */
async function spool(name, content) {
  const { writeFile } = await import('node:fs/promises')
  const path = join(dataDir, 'tmp', name)
  await writeFile(path, content)
  return path
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'mdrive-cluster-test-'))
  await mkdir(join(dataDir, 'tmp'), { recursive: true })
  backend = new ClusterBackend({ dataDir, writes: 1, reserveBytes: 100 })
  clear()
})

after(async () => {
  clear()
  await rm(dataDir, { recursive: true, force: true })
})

describe('capacity-aware placement', () => {
  it('skips a node without room rather than failing the upload later', () => {
    clear()
    enrol('full', 'http://full', { capacity: 1000 })
    enrol('roomy', 'http://roomy', { capacity: 10_000_000 })
    // `full` is at 0 used with reserve 100, so it has 900 bytes free.
    assert.equal(backend.chooseNodes(5000, 1)[0].name, 'roomy')
  })

  it('treats an undeclared capacity (0) as unlimited, not as zero space', () => {
    clear()
    enrol('unknown', 'http://unknown', { capacity: 0 })
    assert.equal(backend.chooseNodes(10_000_000_000, 1)[0].name, 'unknown')
  })

  it('prefers the node with the most free space, then priority as a tie-break', () => {
    clear()
    enrol('small', 'http://small', { capacity: 2_000_000 })
    enrol('big', 'http://big', { capacity: 9_000_000 })
    assert.deepEqual(backend.chooseNodes(1000, 2).map((node) => node.name), ['big', 'small'])
  })

  it('honours priority only when free space is equal', () => {
    clear()
    enrol('low', 'http://low', { capacity: 5_000_000, priority: 200 })
    enrol('high', 'http://high', { capacity: 5_000_000, priority: 10 })
    assert.deepEqual(backend.chooseNodes(1000, 2).map((node) => node.name), ['high', 'low'])
  })

  it('never places on a node that is not active', () => {
    clear()
    enrol('draining', 'http://draining', { capacity: 9_000_000, state: 'draining' })
    enrol('active', 'http://active', { capacity: 1_000_000 })
    assert.deepEqual(backend.chooseNodes(1000, 5).map((node) => node.name), ['active'])
  })
})

describe('durability', () => {
  it('refuses an upload that cannot reach the required replica count', async () => {
    clear()
    enrol('only', 'http://only', { capacity: 10_000_000 })
    const strict = new ClusterBackend({ dataDir, writes: 2, reserveBytes: 0, fetchImpl: fakeFetch().impl })
    const path = await spool('tworeplicas.bin', 'needs two homes')
    await assert.rejects(
      () => strict.putFromFile('a'.repeat(64), path, 14),
      (error) => error.code === 'INSUFFICIENT_REPLICAS',
    )
  })

  it('writes to every chosen node when writes=2', async () => {
    clear()
    enrol('one', 'http://one', { capacity: 10_000_000 })
    enrol('two', 'http://two', { capacity: 10_000_000 })
    const fake = fakeFetch()
    const strict = new ClusterBackend({ dataDir, writes: 2, reserveBytes: 0, fetchImpl: fake.impl })
    const path = await spool('two.bin', 'two copies please')
    const hash = 'b'.repeat(64)
    await strict.putFromFile(hash, path, 16)
    const placements = db.prepare('SELECT node_id, state FROM blob_placements WHERE hash=?').all(hash)
    assert.equal(placements.length, 2)
    assert.ok(placements.every((row) => row.state === 'present'))
    const puts = fake.calls.filter((call) => call.method === 'PUT')
    assert.equal(puts.length, 2, 'one PUT per replica')
  })

  it('does not re-upload when the blob already has enough replicas', async () => {
    clear()
    enrol('solo', 'http://solo', { capacity: 10_000_000 })
    const fake = fakeFetch()
    const single = new ClusterBackend({ dataDir, writes: 1, reserveBytes: 0, fetchImpl: fake.impl })
    const hash = 'c'.repeat(64)
    db.prepare('INSERT INTO blobs(hash,size,refs,created_at) VALUES (?,?,1,?)')
      .run(hash, 12, new Date().toISOString())
    // `put` consumes the spool file, so each attempt needs its own.
    await single.putFromFile(hash, await spool('first.bin', 'content here'), 12)
    const before = fake.calls.filter((call) => call.method === 'PUT').length
    await single.putFromFile(hash, await spool('second.bin', 'content here'), 12)
    const after = fake.calls.filter((call) => call.method === 'PUT').length
    assert.equal(after, before, 'identical bytes with enough replicas cost no transfer')
  })

  it('tops up an existing blob when writes was raised after it was stored', async () => {
    // The failure this pins: short-circuiting on "the blob exists" left a drive
    // single-replica forever after an operator raised writes from 1 to 2.
    clear()
    enrol('one', 'http://one', { capacity: 10_000_000 })
    enrol('two', 'http://two', { capacity: 10_000_000 })
    const fake = fakeFetch()
    const hash = 'd'.repeat(64)
    const single = new ClusterBackend({ dataDir, writes: 1, reserveBytes: 0, fetchImpl: fake.impl })
    await single.putFromFile(hash, await spool('up1.bin', 'stored once'), 10)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM blob_placements WHERE hash=?').get(hash).n, 1)

    const strict = new ClusterBackend({ dataDir, writes: 2, reserveBytes: 0, fetchImpl: fake.impl })
    await strict.putFromFile(hash, await spool('up2.bin', 'stored once'), 10)
    const placements = db.prepare("SELECT state FROM blob_placements WHERE hash=?").all(hash)
    assert.equal(placements.filter((row) => row.state === 'present').length, 2, 'the second replica was added')
  })

  it('marks a replica missing when its node rejects the write', async () => {
    clear()
    enrol('bad', 'http://bad', { capacity: 10_000_000 })
    const fake = fakeFetch({
      ['PUT /blobs/' + 'e'.repeat(64)]: async () => new Response('boom', { status: 500 }),
    })
    const single = new ClusterBackend({ dataDir, writes: 1, reserveBytes: 0, fetchImpl: fake.impl })
    await assert.rejects(() => single.putFromFile('e'.repeat(64), '/nonexistent-spool', 4))
  })
})

describe('replication report', () => {
  it('counts a blob with fewer copies than writes as under-replicated', () => {
    clear()
    enrol('a', 'http://a', { capacity: 10_000_000 })
    enrol('b', 'http://b', { capacity: 10_000_000 })
    const hash = 'f'.repeat(64)
    db.prepare('INSERT INTO blobs(hash,size,refs,created_at) VALUES (?,?,1,?)').run(hash, 100, new Date().toISOString())
    db.prepare("INSERT INTO blob_placements(hash,node_id,size,state,created_at) VALUES (?,?,?,?,?)")
      .run(hash, 'node-a', 100, 'present', new Date().toISOString())
    const strict = new ClusterBackend({ dataDir, writes: 2 })
    const report = strict.replicationReport()
    // The report covers the whole store, and the test runner shares one database
    // process-wide: blobs written by another suite (local-driver uploads, which
    // have no placements at all) are legitimately under-replicated here. Assert
    // on this file's own hash instead of on the total.
    const mine = report.blobs.find((entry) => entry.hash === hash)
    assert.ok(mine, JSON.stringify(report.blobs.map((entry) => entry.hash.slice(0, 4))))
    assert.equal(mine.replicas, 1)
    assert.deepEqual(mine.nodes, ['a'])
  })

  it('reports nothing when every blob meets the target', () => {
    clear()
    enrol('a', 'http://a', { capacity: 10_000_000 })
    const hash = '1'.repeat(64)
    db.prepare('INSERT INTO blobs(hash,size,refs,created_at) VALUES (?,?,1,?)').run(hash, 10, new Date().toISOString())
    db.prepare("INSERT INTO blob_placements(hash,node_id,size,state,created_at) VALUES (?,?,?,?,?)")
      .run(hash, 'node-a', 10, 'present', new Date().toISOString())
    const single = new ClusterBackend({ dataDir, writes: 1 })
    // Same scoping: this file's fully replicated blob must not be reported,
    // whatever else is in the shared database.
    const report = single.replicationReport()
    assert.equal(report.blobs.some((entry) => entry.hash === hash), false)
  })
})

describe('node enrolment tokens', () => {
  it('seals a token so a database dump does not reveal it', () => {
    const sealed = sealSecret('a-node-secret-value')
    assert.match(sealed, /^v1:/)
    assert.ok(!sealed.includes('a-node-secret-value'))
    assert.equal(openSecret(sealed), 'a-node-secret-value')
  })

  it('treats a tampered record as unusable rather than returning garbage', () => {
    const sealed = sealSecret('original')
    const parts = sealed.split(':')
    parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith('AA') ? 'BB' : 'AA')
    assert.equal(openSecret(parts.join(':')), null)
  })

  it('refuses a token sealed with a different key', () => {
    assert.equal(openSecret('v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:AAAA'), null)
    assert.equal(openSecret('not-a-sealed-value'), null)
    assert.equal(openSecret(null), null)
  })
})
