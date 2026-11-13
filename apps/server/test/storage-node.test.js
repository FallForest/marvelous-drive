import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, before, after } from 'node:test'
import { createNodeServer, tokenMatches, bearerOf } from '../src/storage/node.js'

/**
 * The storage node, tested as a standalone HTTP service.
 *
 * A node is the one component that holds bytes for machines it does not own, so
 * the properties worth pinning are all about refusing to lie:
 *
 *   - it rejects a body whose digest does not match the key it was sent under,
 *     because a mis-keyed blob is worse than a missing one;
 *   - it never answers a blob to a caller without the token;
 *   - it survives a restart with the same disk, since a node has no database to
 *     remember anything in;
 *   - Range works, because a resume depends on it.
 */

let root
let server
let base
const TOKEN = 'test-node-token-0123456789'

async function startNode(dir) {
  const instance = createNodeServer({ rootDir: dir, token: TOKEN, name: 'test-node', capacityBytes: 1024 * 1024 })
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve))
  const { port } = instance.address()
  return { instance, url: 'http://127.0.0.1:' + port }
}

const sha256 = async (text) => {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(text).digest('hex')
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'mdrive-node-test-'))
  const started = await startNode(root)
  server = started.instance
  base = started.url
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  await rm(root, { recursive: true, force: true })
})

describe('token handling', () => {
  it('compares in constant time and rejects a prefix', () => {
    assert.equal(tokenMatches('abcdef1234567890', 'abcdef1234567890'), true)
    assert.equal(tokenMatches('abcdef1234567890', 'abcdef123456789'), false)
    assert.equal(tokenMatches('abcdef1234567890', 'abcdef12345678900'), false)
    assert.equal(tokenMatches('abcdef1234567890', ''), false)
    assert.equal(tokenMatches('abcdef1234567890', undefined), false)
  })

  it('reads a bearer header, and nothing else', () => {
    assert.equal(bearerOf({ headers: { authorization: 'Bearer abc' } }), 'abc')
    assert.equal(bearerOf({ headers: { authorization: 'bearer abc' } }), 'abc')
    assert.equal(bearerOf({ headers: { authorization: 'Basic abc' } }), '')
    assert.equal(bearerOf({ headers: {} }), '')
  })
})

describe('health', () => {
  it('answers without a token, so a probe can tell "down" from "misconfigured"', async () => {
    const response = await fetch(base + '/node/v1/health')
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.name, 'test-node')
    assert.equal(payload.capacityBytes, 1024 * 1024)
    assert.equal(typeof payload.usedBytes, 'number')
  })
})

describe('authentication', () => {
  it('refuses every blob verb without the token', async () => {
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) {
      const response = await fetch(base + '/node/v1/blobs/' + 'a'.repeat(64), { method })
      assert.equal(response.status, 401, method + ' must require the token')
    }
  })

  it('refuses a wrong token', async () => {
    const response = await fetch(base + '/node/v1/blobs/' + 'a'.repeat(64), {
      headers: { authorization: 'Bearer wrong-token' },
    })
    assert.equal(response.status, 401)
  })
})

describe('storage', () => {
  it('stores a blob, then serves it back byte for byte', async () => {
    const body = 'the quick brown fox jumps over the lazy dog'
    const hash = await sha256(body)
    const put = await fetch(base + '/node/v1/blobs/' + hash, {
      method: 'PUT',
      headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/octet-stream' },
      body,
    })
    const stored = await put.json()
    assert.equal(put.status, 201, JSON.stringify(stored))
    assert.equal(stored.sha256, hash)
    assert.equal(stored.size, body.length)

    const get = await fetch(base + '/node/v1/blobs/' + hash, { headers: { authorization: 'Bearer ' + TOKEN } })
    assert.equal(get.status, 200)
    assert.equal(await get.text(), body)
    assert.equal(get.headers.get('accept-ranges'), 'bytes')
  })

  it('lays the file out as <root>/<first two>/<hash>, like the local backend', async () => {
    const body = 'layout matters: the same tools browse both'
    const hash = await sha256(body)
    await fetch(base + '/node/v1/blobs/' + hash, {
      method: 'PUT', headers: { authorization: 'Bearer ' + TOKEN }, body,
    })
    const onDisk = await readFile(join(root, hash.slice(0, 2), hash), 'utf8')
    assert.equal(onDisk, body)
  })

  it('rejects a body that does not hash to the key, and leaves nothing behind', async () => {
    const hash = await sha256('the real content')
    const response = await fetch(base + '/node/v1/blobs/' + hash, {
      method: 'PUT',
      headers: { authorization: 'Bearer ' + TOKEN },
      body: 'different bytes',
    })
    assert.equal(response.status, 409)
    const payload = await response.json()
    assert.equal(payload.error.code, 'CHECKSUM_MISMATCH')
    assert.equal(payload.expected, hash)
    // A mis-keyed file on disk would be served under a name that lies.
    await assert.rejects(stat(join(root, hash.slice(0, 2), hash)))
  })

  it('rejects a malformed hash instead of writing an arbitrary path', async () => {
    const response = await fetch(base + '/node/v1/blobs/not-a-hash', {
      method: 'PUT', headers: { authorization: 'Bearer ' + TOKEN }, body: 'x',
    })
    assert.equal(response.status, 404)
  })

  it('answers HEAD with the size and no body', async () => {
    const body = 'head me'
    const hash = await sha256(body)
    await fetch(base + '/node/v1/blobs/' + hash, { method: 'PUT', headers: { authorization: 'Bearer ' + TOKEN }, body })
    const head = await fetch(base + '/node/v1/blobs/' + hash, { method: 'HEAD', headers: { authorization: 'Bearer ' + TOKEN } })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-length'), String(body.length))
  })

  it('serves a Range so a download can resume', async () => {
    const body = 'abcdefghijklmnopqrstuvwxyz'
    const hash = await sha256(body)
    await fetch(base + '/node/v1/blobs/' + hash, { method: 'PUT', headers: { authorization: 'Bearer ' + TOKEN }, body })
    const range = await fetch(base + '/node/v1/blobs/' + hash, {
      headers: { authorization: 'Bearer ' + TOKEN, range: 'bytes=5-9' },
    })
    assert.equal(range.status, 206)
    assert.equal(await range.text(), 'fghij')
    assert.equal(range.headers.get('content-range'), 'bytes 5-9/' + body.length)
  })

  it('answers a suffix range', async () => {
    const body = 'abcdefghij'
    const hash = await sha256(body)
    await fetch(base + '/node/v1/blobs/' + hash, { method: 'PUT', headers: { authorization: 'Bearer ' + TOKEN }, body })
    const range = await fetch(base + '/node/v1/blobs/' + hash, {
      headers: { authorization: 'Bearer ' + TOKEN, range: 'bytes=-3' },
    })
    assert.equal(range.status, 206)
    assert.equal(await range.text(), 'hij')
  })

  it('accepts the same bytes twice without complaint', async () => {
    const body = 'idempotent store'
    const hash = await sha256(body)
    for (let index = 0; index < 2; index++) {
      const response = await fetch(base + '/node/v1/blobs/' + hash, {
        method: 'PUT', headers: { authorization: 'Bearer ' + TOKEN }, body,
      })
      assert.equal(response.status, 201)
    }
  })

  it('deletes idempotently', async () => {
    const body = 'to be deleted'
    const hash = await sha256(body)
    await fetch(base + '/node/v1/blobs/' + hash, { method: 'PUT', headers: { authorization: 'Bearer ' + TOKEN }, body })
    for (let index = 0; index < 2; index++) {
      const response = await fetch(base + '/node/v1/blobs/' + hash, { method: 'DELETE', headers: { authorization: 'Bearer ' + TOKEN } })
      assert.equal(response.status, 200)
    }
    const get = await fetch(base + '/node/v1/blobs/' + hash, { headers: { authorization: 'Bearer ' + TOKEN } })
    assert.equal(get.status, 404)
  })

  it('reports used bytes that reflect what is on disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mdrive-node-usage-'))
    const started = await startNode(dir)
    try {
      const body = 'x'.repeat(1000)
      const hash = await sha256(body)
      await fetch(started.url + '/node/v1/blobs/' + hash, { method: 'PUT', headers: { authorization: 'Bearer ' + TOKEN }, body })
      const health = await (await fetch(started.url + '/node/v1/health')).json()
      assert.ok(health.usedBytes >= 1000, JSON.stringify(health))
      assert.equal(health.blobs, 1)
    } finally {
      await new Promise((resolve) => started.instance.close(resolve))
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('restart', () => {
  it('serves blobs written before the restart: a node has no memory to lose', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mdrive-node-restart-'))
    const body = 'written before the restart'
    const hash = await sha256(body)
    const first = await startNode(dir)
    await fetch(first.url + '/node/v1/blobs/' + hash, { method: 'PUT', headers: { authorization: 'Bearer ' + TOKEN }, body })
    await new Promise((resolve) => first.instance.close(resolve))

    const second = await startNode(dir)
    try {
      const get = await fetch(second.url + '/node/v1/blobs/' + hash, { headers: { authorization: 'Bearer ' + TOKEN } })
      assert.equal(get.status, 200)
      assert.equal(await get.text(), body)
    } finally {
      await new Promise((resolve) => second.instance.close(resolve))
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('construction', () => {
  it('refuses to start without a token', () => {
    assert.throws(() => createNodeServer({ rootDir: '/tmp/x', token: '' }), /token/)
  })

  it('refuses to start without a directory', () => {
    assert.throws(() => createNodeServer({ rootDir: '', token: 'x'.repeat(20) }), /root directory/)
  })
})
