import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { startServer, uniqueEmail } from './helpers.js'

/**
 * Storage P0: instant (deduplicated) uploads and the three conflict strategies.
 *
 * The tests talk HTTP exactly like the web client does, then open the SQLite
 * file to check the blob refcounts the API deliberately hides.
 */

let app
let api
let token

before(async () => {
  app = await startServer()
  api = app.client
  const registered = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'dedup password' } })
  token = registered.json.token
})

after(async () => {
  await app.close()
  app.cleanup()
})

const auth = (extra = {}) => ({ token, ...extra })
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

/** Reads the live blob row straight from the database file. */
function blobRow(hash) {
  const db = new DatabaseSync(join(app.dataDir, 'drive.db'))
  try {
    return db.prepare('SELECT hash, size, refs FROM blobs WHERE hash=?').get(hash) || null
  } finally {
    db.close()
  }
}

const blobCount = () => {
  const db = new DatabaseSync(join(app.dataDir, 'drive.db'))
  try {
    return db.prepare('SELECT COUNT(*) AS total FROM blobs').get().total
  } finally {
    db.close()
  }
}

async function upload(name, body, query = '', parentId = null) {
  const parent = parentId ? `&parentId=${parentId}` : ''
  return api('PUT', `/api/v1/uploads?name=${encodeURIComponent(name)}${parent}${query}`, auth({
    raw: true, body, headers: { 'content-type': 'text/plain' },
  }))
}

async function makeFolder(name) {
  const response = await api('POST', '/api/v1/nodes', auth({ body: { name, kind: 'folder' } }))
  assert.equal(response.status, 201, response.text)
  return response.json.node.id
}

async function makeFile(name, parentId, body) {
  const response = await upload(name, body, '', parentId)
  assert.equal(response.status, 201, response.text)
  return response.json.node
}

describe('blob probe', () => {
  it('answers 200 with size and refs for a stored blob, without a path', async () => {
    const bytes = 'probe me once'
    const node = await makeFile('probe.txt', null, bytes)
    const probe = await api('GET', `/api/v1/blobs/${sha256(bytes)}`, auth())
    assert.equal(probe.status, 200, probe.text)
    assert.deepEqual(probe.json, { exists: true, sha256: sha256(bytes), size: bytes.length, refs: 1 })
    assert.equal(node.blobHash, sha256(bytes))
    assert.ok(!probe.text.includes('blobs/'), 'the on-disk path must stay hidden')
    assert.ok(!('path' in probe.json))
  })

  it('answers 404 for bytes that were never stored', async () => {
    const probe = await api('GET', `/api/v1/blobs/${sha256('never uploaded')}`, auth())
    assert.equal(probe.status, 404)
    assert.equal(probe.json.error.code, 'NOT_FOUND')
  })

  it('rejects a hash that is not 64 lowercase hex characters', async () => {
    for (const bad of ['nope', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64)]) {
      const probe = await api('GET', `/api/v1/blobs/${bad}`, auth())
      assert.equal(probe.status, 400, bad)
      assert.equal(probe.json.error.code, 'INVALID_INPUT', bad)
    }
  })

  it('requires a session', async () => {
    const probe = await api('GET', `/api/v1/blobs/${sha256('anonymous')}`)
    assert.equal(probe.status, 401)
  })
})

describe('instant upload', () => {
  it('answers 404 BLOB_NOT_FOUND so the client can fall back', async () => {
    const response = await api('POST', '/api/v1/uploads/instant', auth({
      body: { name: 'fallback.txt', sha256: sha256('not stored anywhere'), size: 4 },
    }))
    assert.equal(response.status, 404)
    assert.equal(response.json.error.code, 'BLOB_NOT_FOUND')
  })

  it('creates a node for bytes already stored: refs +1, no second copy', async () => {
    const bytes = 'deduplicated payload that lives on disk exactly once'
    const first = await makeFile('dedup-source.txt', null, bytes)
    const digest = sha256(bytes)
    const before = blobRow(digest)
    assert.equal(before.refs, 1)
    const blobsBefore = blobCount()

    const instant = await api('POST', '/api/v1/uploads/instant', auth({
      body: { name: 'dedup-copy.txt', sha256: digest, size: bytes.length, mime: 'text/plain' },
    }))
    assert.equal(instant.status, 201, instant.text)
    assert.equal(instant.json.deduplicated, true)
    assert.equal(instant.json.node.name, 'dedup-copy.txt')
    assert.equal(instant.json.node.size, bytes.length)
    assert.equal(instant.json.node.blobHash, digest)

    const after = blobRow(digest)
    assert.equal(after.refs, before.refs + 1, 'the new node holds one more reference')
    assert.equal(blobCount(), blobsBefore, 'no new blob row was created')
    assert.notEqual(instant.json.node.id, first.id)

    const content = await api('GET', `/api/v1/files/${instant.json.node.id}/content`, auth())
    assert.equal(content.status, 200)
    assert.equal(content.text, bytes)

    const stats = await api('GET', '/api/v1/storage/stats', auth())
    assert.equal(stats.status, 200)
    assert.ok(stats.json.stats.bytes >= bytes.length * 2, 'both nodes count their size')
  })

  it('rejects a size that disagrees with the stored blob', async () => {
    const bytes = 'size mismatch candidate'
    await makeFile('size-source.txt', null, bytes)
    const response = await api('POST', '/api/v1/uploads/instant', auth({
      body: { name: 'size-copy.txt', sha256: sha256(bytes), size: bytes.length + 1 },
    }))
    assert.equal(response.status, 400)
    assert.equal(response.json.error.code, 'INVALID_INPUT')
    const probe = await api('GET', `/api/v1/blobs/${sha256(bytes)}`, auth())
    assert.equal(probe.json.refs, 1, 'a rejected instant upload must not leak a reference')
  })

  it('honours onConflict=rename and leaves the original bytes alone', async () => {
    const bytes = 'rename me carefully'
    const original = await makeFile('x.txt', null, bytes)
    const instant = await api('POST', '/api/v1/uploads/instant', auth({
      body: { name: 'x.txt', sha256: sha256(bytes), size: bytes.length, onConflict: 'rename' },
    }))
    assert.equal(instant.status, 201, instant.text)
    assert.equal(instant.json.node.name, 'x (1).txt')
    assert.equal(instant.json.renamedFrom, 'x.txt')
    assert.equal(instant.json.deduplicated, true)
    const untouched = await api('GET', `/api/v1/files/${original.id}/content`, auth())
    assert.equal(untouched.text, bytes)
    const originalNode = await api('GET', `/api/v1/nodes/${original.id}`, auth())
    assert.equal(originalNode.json.node.version, 1, 'rename never touches the old node')
  })

  it('honours onConflict=skip: same node, same version, refs unchanged', async () => {
    const bytes = 'skip keeps the original'
    const original = await makeFile('keep.txt', null, bytes)
    const digest = sha256(bytes)
    const before = blobRow(digest)
    const instant = await api('POST', '/api/v1/uploads/instant', auth({
      body: { name: 'keep.txt', sha256: digest, size: bytes.length, onConflict: 'skip' },
    }))
    assert.equal(instant.status, 200, instant.text)
    assert.equal(instant.json.skipped, true)
    assert.equal(instant.json.node.id, original.id)
    assert.equal(instant.json.node.version, 1)
    const after = blobRow(digest)
    assert.equal(after.refs, before.refs, 'skip must not retain the blob')
  })

  it('rejects an unknown onConflict value', async () => {
    const bytes = 'bad strategy'
    await makeFile('bad-strategy.txt', null, bytes)
    const response = await api('POST', '/api/v1/uploads/instant', auth({
      body: { name: 'bad-strategy-2.txt', sha256: sha256(bytes), size: bytes.length, onConflict: 'duplicate' },
    }))
    assert.equal(response.status, 400)
    assert.equal(response.json.error.code, 'INVALID_INPUT')
  })
})

describe('onConflict on the classic upload', () => {
  it('overwrite stays the default: same name, new version', async () => {
    const first = await upload('default.txt', 'first body')
    assert.equal(first.status, 201)
    const second = await upload('default.txt', 'second body')
    assert.equal(second.status, 200)
    assert.equal(second.json.node.id, first.json.node.id)
    assert.equal(second.json.node.version, 2)
    const content = await api('GET', `/api/v1/files/${first.json.node.id}/content`, auth())
    assert.equal(content.text, 'second body')
  })

  it('rename creates "x (1).txt" and keeps the old content', async () => {
    const first = await upload('conflict.txt', 'original')
    const second = await upload('conflict.txt', 'newcomer', '&onConflict=rename')
    assert.equal(second.status, 201, second.text)
    assert.equal(second.json.node.name, 'conflict (1).txt')
    assert.equal(second.json.renamedFrom, 'conflict.txt')
    assert.notEqual(second.json.node.id, first.json.node.id)
    const oldContent = await api('GET', `/api/v1/files/${first.json.node.id}/content`, auth())
    assert.equal(oldContent.text, 'original')
    const newContent = await api('GET', `/api/v1/files/${second.json.node.id}/content`, auth())
    assert.equal(newContent.text, 'newcomer')
    const third = await upload('conflict.txt', 'third wheels', '&onConflict=rename')
    assert.equal(third.json.node.name, 'conflict (2).txt')
  })

  it('skip returns the existing node and leaves the refcount alone', async () => {
    const bytes = 'skipped body'
    const first = await upload('skip.txt', bytes)
    const digest = first.json.node.blobHash
    const before = blobRow(digest)
    const second = await upload('skip.txt', bytes, '&onConflict=skip')
    assert.equal(second.status, 200, second.text)
    assert.equal(second.json.skipped, true)
    assert.equal(second.json.node.id, first.json.node.id)
    assert.equal(second.json.node.version, 1)
    const after = blobRow(digest)
    assert.equal(after.refs, before.refs, 'the skipped body must be released again')
    const content = await api('GET', `/api/v1/files/${first.json.node.id}/content`, auth())
    assert.equal(content.text, bytes)
  })

  it('rejects an unknown strategy with 400', async () => {
    const response = await upload('whatever.txt', 'bytes', '&onConflict=keep-both')
    assert.equal(response.status, 400)
    assert.equal(response.json.error.code, 'INVALID_INPUT')
  })
})

describe('onConflict when replacing existing content', () => {
  it('skip returns the current node and writes nothing', async () => {
    const file = await makeFile('content-skip.txt', null, 'current bytes')
    const before = blobRow(file.blobHash)
    const skipped = await api('PUT', `/api/v1/files/${file.id}/content?onConflict=skip`, auth({
      raw: true, body: 'ignored bytes', headers: { 'content-type': 'text/plain' },
    }))
    assert.equal(skipped.status, 200, skipped.text)
    assert.equal(skipped.json.skipped, true)
    assert.equal(skipped.json.node.id, file.id)
    assert.equal(skipped.json.node.version, 1)
    assert.equal(blobRow(file.blobHash).refs, before.refs)
    const content = await api('GET', `/api/v1/files/${file.id}/content`, auth())
    assert.equal(content.text, 'current bytes')
  })

  it('rename makes no sense here and is refused', async () => {
    const file = await makeFile('content-rename.txt', null, 'stable')
    const response = await api('PUT', `/api/v1/files/${file.id}/content?onConflict=rename`, auth({
      raw: true, body: 'replacement', headers: { 'content-type': 'text/plain' },
    }))
    assert.equal(response.status, 400)
    assert.equal(response.json.error.code, 'INVALID_INPUT')
    const content = await api('GET', `/api/v1/files/${file.id}/content`, auth())
    assert.equal(content.text, 'stable')
  })
})

describe('onConflict on resumable completion', () => {
  async function completeSession(name, body, onConflict) {
    const payload = Buffer.from(body)
    const session = await api('POST', '/api/v1/uploads/sessions', auth({
      body: { name, size: payload.length, chunkSize: 65536 },
    }))
    assert.equal(session.status, 201, session.text)
    const id = session.json.upload.id
    const put = await api('PUT', `/api/v1/uploads/sessions/${id}/chunks/0`, auth({
      raw: true, body: payload, headers: { 'content-type': 'application/octet-stream' },
    }))
    assert.equal(put.status, 200, put.text)
    const query = onConflict ? `?onConflict=${onConflict}` : ''
    return api('POST', `/api/v1/uploads/sessions/${id}/complete${query}`, auth({ body: {} }))
  }

  it('rename stores the resumed bytes under " (1)"', async () => {
    const first = await makeFile('chunk-rename.txt', null, 'chunk one')
    const complete = await completeSession('chunk-rename.txt', 'chunk two', 'rename')
    assert.equal(complete.status, 201, complete.text)
    assert.equal(complete.json.node.name, 'chunk-rename (1).txt')
    assert.equal(complete.json.renamedFrom, 'chunk-rename.txt')
    const oldContent = await api('GET', `/api/v1/files/${first.id}/content`, auth())
    assert.equal(oldContent.text, 'chunk one')
    const newContent = await api('GET', `/api/v1/files/${complete.json.node.id}/content`, auth())
    assert.equal(newContent.text, 'chunk two')
  })

  it('skip keeps the existing node and does not leak a reference', async () => {
    const bytes = 'chunk skip bytes'
    const first = await makeFile('chunk-skip.txt', null, bytes)
    const digest = first.blobHash
    const before = blobRow(digest)
    const complete = await completeSession('chunk-skip.txt', bytes, 'skip')
    assert.equal(complete.status, 200, complete.text)
    assert.equal(complete.json.skipped, true)
    assert.equal(complete.json.node.id, first.id)
    assert.equal(complete.json.node.version, 1)
    assert.equal(blobRow(digest).refs, before.refs)
    const content = await api('GET', `/api/v1/files/${first.id}/content`, auth())
    assert.equal(content.text, bytes)
  })

  it('rejects an unknown strategy with 400', async () => {
    const response = await completeSession('chunk-bad.txt', 'bad strategy bytes', 'merge')
    assert.equal(response.status, 400)
    assert.equal(response.json.error.code, 'INVALID_INPUT')
  })
})
