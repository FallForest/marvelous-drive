import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { startServer, uniqueEmail } from './helpers.js'

/**
 * End-to-end behaviour of the HTTP API: accounts, tree, uploads, ranges,
 * versions, shares and the Docs bridge failure path.
 */

let app
let api
let token

before(async () => {
  app = await startServer()
  api = app.client
})

after(async () => {
  await app.close()
  app.cleanup()
})

const auth = (extra = {}) => ({ token, ...extra })

describe('accounts', () => {
  it('registers and returns a working token', async () => {
    const email = uniqueEmail()
    const response = await api('POST', '/api/v1/auth/register', { body: { email, password: 'correct horse battery' } })
    assert.equal(response.status, 201)
    assert.equal(response.json.user.email, email)
    assert.equal(response.json.user.role, 'owner')
    token = response.json.token
    const me = await api('GET', '/api/v1/me', auth())
    assert.equal(me.status, 200)
    assert.equal(me.json.user.email, email)
  })

  it('rejects a duplicate e-mail and a short password', async () => {
    const email = uniqueEmail()
    await api('POST', '/api/v1/auth/register', { body: { email, password: 'long enough password' } })
    const duplicate = await api('POST', '/api/v1/auth/register', { body: { email, password: 'long enough password' } })
    assert.equal(duplicate.status, 409)
    assert.equal(duplicate.json.error.code, 'CONFLICT')
    const short = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'short' } })
    assert.equal(short.status, 400)
  })

  it('rejects bad credentials and missing tokens', async () => {
    const email = uniqueEmail()
    await api('POST', '/api/v1/auth/register', { body: { email, password: 'long enough password' } })
    const bad = await api('POST', '/api/v1/auth/login', { body: { email, password: 'wrong password' } })
    assert.equal(bad.status, 401)
    assert.equal(bad.json.error.code, 'INVALID_CREDENTIALS')
    const anonymous = await api('GET', '/api/v1/nodes')
    assert.equal(anonymous.status, 401)
    assert.equal(anonymous.json.error.code, 'UNAUTHENTICATED')
  })
})

describe('node tree', () => {
  let folderId

  it('creates a folder and a file', async () => {
    const folder = await api('POST', '/api/v1/nodes', auth({ body: { name: 'Project Alpha', kind: 'folder' } }))
    assert.equal(folder.status, 201)
    assert.equal(folder.json.node.kind, 'folder')
    folderId = folder.json.node.id
    const file = await api('POST', '/api/v1/nodes', auth({ body: { name: 'readme.md', parentId: folderId } }))
    assert.equal(file.status, 201)
    assert.equal(file.json.node.parentId, folderId)
    // The name decides the type: an empty file called readme.md is a Markdown
    // document, and reporting octet-stream would cost it its icon and preview.
    assert.equal(file.json.node.mime, 'text/markdown')
  })

  it('rejects duplicate names in one folder and illegal characters', async () => {
    await api('POST', '/api/v1/nodes', auth({ body: { name: 'notes.txt', parentId: folderId } }))
    const duplicate = await api('POST', '/api/v1/nodes', auth({ body: { name: 'notes.txt', parentId: folderId } }))
    assert.equal(duplicate.status, 409)
    assert.equal(duplicate.json.error.code, 'CONFLICT')
    const illegal = await api('POST', '/api/v1/nodes', auth({ body: { name: 'a/b.txt', parentId: folderId } }))
    assert.equal(illegal.status, 400)
  })

  it('refuses to move a folder into itself or a descendant', async () => {
    const child = await api('POST', '/api/v1/nodes', auth({ body: { name: 'child', kind: 'folder', parentId: folderId } }))
    const self = await api('PUT', `/api/v1/nodes/${folderId}`, auth({ body: { parentId: folderId } }))
    assert.equal(self.status, 400)
    assert.equal(self.json.error.code, 'INVALID_PARENT')
    const descendant = await api('PUT', `/api/v1/nodes/${folderId}`, auth({ body: { parentId: child.json.node.id } }))
    assert.equal(descendant.status, 400)
  })

  it('lists children, filters the trash, and searches', async () => {
    const list = await api('GET', `/api/v1/nodes?parentId=${folderId}`, auth())
    assert.equal(list.status, 200)
    assert.ok(list.json.nodes.every((node) => node.parentId === folderId))
    const found = await api('GET', '/api/v1/search?q=readme', auth())
    assert.equal(found.status, 200)
    assert.ok(found.json.results.some((result) => result.name === 'readme.md'))
  })
})

describe('content and versions', () => {
  let fileId

  it('uploads bytes and reports the node', async () => {
    const up = await api('PUT', '/api/v1/uploads?name=hello.txt', auth({
      raw: true, body: 'hello world', headers: { 'content-type': 'text/plain' },
    }))
    assert.equal(up.status, 201)
    assert.equal(up.json.node.size, 11)
    assert.equal(up.json.node.mime, 'text/plain')
    fileId = up.json.node.id
  })

  it('serves the bytes, honours Range, and sets attachment on download', async () => {
    const full = await api('GET', `/api/v1/files/${fileId}/content`, auth())
    assert.equal(full.status, 200)
    assert.equal(full.text, 'hello world')
    const ranged = await api('GET', `/api/v1/files/${fileId}/content`, auth({ headers: { range: 'bytes=0-4' } }))
    assert.equal(ranged.status, 206)
    assert.equal(ranged.text, 'hello')
    assert.equal(ranged.headers.get('content-range'), 'bytes 0-4/11')
    const download = await api('GET', `/api/v1/files/${fileId}/content?download=1`, auth())
    assert.match(download.headers.get('content-disposition') || '', /attachment; filename="hello\.txt"/)
  })

  it('version-bumps on overwrite and restores an older version', async () => {
    const overwrite = await api('PUT', `/api/v1/files/${fileId}/content`, auth({
      raw: true, body: 'goodbye world', headers: { 'content-type': 'text/plain' },
    }))
    assert.equal(overwrite.status, 200)
    assert.equal(overwrite.json.node.version, 2)
    const versions = await api('GET', `/api/v1/files/${fileId}/versions`, auth())
    assert.equal(versions.json.versions.length, 1)
    const restore = await api('POST', `/api/v1/files/${fileId}/versions/${versions.json.versions[0].id}/restore`, auth({
      body: { expectedVersion: 2 },
    }))
    assert.equal(restore.status, 200)
    const content = await api('GET', `/api/v1/files/${fileId}/content`, auth())
    assert.equal(content.text, 'hello world')
  })

  it('deduplicates identical bytes in the blob store', async () => {
    const first = await api('PUT', '/api/v1/uploads?name=dup-a.txt', auth({ raw: true, body: 'same bytes', headers: { 'content-type': 'text/plain' } }))
    const second = await api('PUT', '/api/v1/uploads?name=dup-b.txt', auth({ raw: true, body: 'same bytes', headers: { 'content-type': 'text/plain' } }))
    assert.equal(first.json.node.blobHash, second.json.node.blobHash)
  })

  it('rejects a checksum mismatch', async () => {
    const response = await api('PUT', '/api/v1/uploads?name=bad.txt', auth({
      raw: true, body: 'abcdef', headers: { 'content-type': 'text/plain', 'x-checksum-sha256': '0'.repeat(64) },
    }))
    assert.equal(response.status, 409)
    assert.equal(response.json.error.code, 'CHECKSUM_MISMATCH')
  })
})

describe('resumable uploads', () => {
  it('assembles chunks and verifies the digest', async () => {
    const payload = Buffer.from('chunked upload payload that spans several chunks')
    const session = await api('POST', '/api/v1/uploads/sessions', auth({
      body: { name: 'chunked.bin', size: payload.length, chunkSize: 65536 },
    }))
    assert.equal(session.status, 201)
    const id = session.json.upload.id
    assert.equal(session.json.upload.totalChunks, 1)
    const put = await api('PUT', `/api/v1/uploads/sessions/${id}/chunks/0`, auth({ raw: true, body: payload, headers: { 'content-type': 'application/octet-stream' } }))
    assert.equal(put.status, 200)
    assert.deepEqual(put.json.upload.receivedChunks, [0])
    const complete = await api('POST', `/api/v1/uploads/sessions/${id}/complete`, auth({ body: {} }))
    assert.equal(complete.status, 201)
    assert.equal(complete.json.node.size, payload.length)
  })

  it('reports missing chunks and rejects an unknown session', async () => {
    const session = await api('POST', '/api/v1/uploads/sessions', auth({
      body: { name: 'multi.bin', size: 200000, chunkSize: 65536 },
    }))
    const id = session.json.upload.id
    assert.equal(session.json.upload.totalChunks, 4)
    const early = await api('POST', `/api/v1/uploads/sessions/${id}/complete`, auth({ body: {} }))
    assert.equal(early.status, 409)
    assert.equal(early.json.error.code, 'UPLOAD_INCOMPLETE')
    const missing = await api('GET', '/api/v1/uploads/sessions/00000000-0000-0000-0000-000000000000', auth())
    assert.equal(missing.status, 404)
  })
})

describe('shares', () => {
  let fileId

  it('creates a share link and serves it anonymously', async () => {
    const upload = await api('PUT', '/api/v1/uploads?name=shared.txt', auth({ raw: true, body: 'shared content', headers: { 'content-type': 'text/plain' } }))
    fileId = upload.json.node.id
    const share = await api('POST', `/api/v1/nodes/${fileId}/share`, auth({ body: { permission: 'downloader' } }))
    assert.equal(share.status, 201)
    const token = share.json.share.token
    const publicRead = await api('GET', `/api/v1/shared/${token}`)
    assert.equal(publicRead.status, 200)
    assert.equal(publicRead.json.share.node.name, 'shared.txt')
    const content = await api('GET', `/api/v1/shared/${token}/content`)
    assert.equal(content.status, 200)
    assert.equal(content.text, 'shared content')
  })

  it('enforces the password and the download budget', async () => {
    const share = await api('POST', `/api/v1/nodes/${fileId}/share`, auth({ body: { permission: 'downloader', password: 'open sesame', maxDownloads: 1 } }))
    const token = share.json.share.token
    const locked = await api('GET', `/api/v1/shared/${token}`)
    assert.equal(locked.status, 401)
    assert.equal(locked.json.error.code, 'SHARE_LOCKED')
    const wrong = await api('GET', `/api/v1/shared/${token}?password=nope`)
    assert.equal(wrong.status, 401)
    const right = await api('GET', `/api/v1/shared/${token}?password=${encodeURIComponent('open sesame')}`)
    assert.equal(right.status, 200)
    assert.equal(right.json.protected, true)
    const download = await api('GET', `/api/v1/shared/${token}/content?password=${encodeURIComponent('open sesame')}`)
    assert.equal(download.status, 200)
    const exhausted = await api('GET', `/api/v1/shared/${token}?password=${encodeURIComponent('open sesame')}`)
    assert.equal(exhausted.status, 404)
  })
})

describe('trash lifecycle', () => {
  it('trashes, restores, and purges a subtree', async () => {
    const folder = await api('POST', '/api/v1/nodes', auth({ body: { name: 'trash-me', kind: 'folder' } }))
    const child = await api('POST', '/api/v1/nodes', auth({ body: { name: 'inner.txt', parentId: folder.json.node.id } }))
    const trash = await api('DELETE', `/api/v1/nodes/${folder.json.node.id}`, auth())
    assert.equal(trash.status, 200)
    assert.equal(trash.json.trashed, 2)
    const listed = await api('GET', '/api/v1/nodes?trash=1', auth())
    assert.ok(listed.json.nodes.some((node) => node.id === child.json.node.id))
    const restore = await api('POST', `/api/v1/nodes/${folder.json.node.id}/restore`, auth({ body: {} }))
    assert.equal(restore.status, 200)
    await api('DELETE', `/api/v1/nodes/${folder.json.node.id}`, auth())
    const purge = await api('DELETE', `/api/v1/nodes/${folder.json.node.id}/permanent`, auth())
    assert.equal(purge.status, 200)
    const gone = await api('GET', `/api/v1/nodes/${child.json.node.id}`, auth())
    assert.equal(gone.status, 404)
  })

  it('refuses to purge a live node', async () => {
    const file = await api('POST', '/api/v1/nodes', auth({ body: { name: 'live.txt' } }))
    const purge = await api('DELETE', `/api/v1/nodes/${file.json.node.id}/permanent`, auth())
    assert.equal(purge.status, 400)
  })
})

/**
 * Delete batches, not deletion times.
 *
 * The bug: a file trashed on its own, then its parent trashed later, made the
 * parent's delete report the old child too and made the old child (and its
 * public link) come back when the parent was restored. The tests below pin the
 * operation boundary — including two deletions inside the same millisecond and
 * the legacy rows that predate `trash_batch_id`.
 */
describe('trash batches', () => {
  const addFolder = async (name, parentId = null) => {
    const response = await api('POST', '/api/v1/nodes', auth({ body: { name, kind: 'folder', parentId } }))
    assert.equal(response.status, 201, response.text)
    return response.json.node
  }
  const addFile = async (name, parentId = null) => {
    const response = await api('PUT', `/api/v1/uploads?name=${encodeURIComponent(name)}${parentId ? '&parentId=' + parentId : ''}`, auth({
      raw: true, body: name + ' bytes', headers: { 'content-type': 'text/plain' },
    }))
    assert.equal(response.status, 201, response.text)
    return response.json.node
  }
  const remove = (id) => api('DELETE', `/api/v1/nodes/${id}`, auth())
  const restore = (id) => api('POST', `/api/v1/nodes/${id}/restore`, auth({ body: {} }))
  const trashList = async (query = 'sort=name&direction=asc&limit=200') => {
    const response = await api('GET', '/api/v1/nodes?trash=1&' + query, auth())
    assert.equal(response.status, 200, response.text)
    return response.json.nodes
  }
  const withDb = (fn) => {
    const database = new DatabaseSync(join(app.dataDir, 'drive.db'))
    try { return fn(database) } finally { database.close() }
  }

  it('counts only the live branch and leaves an independently deleted child in the trash', async () => {
    const root = await addFolder('batch-root')
    const kept = await addFile('kept.txt', root.id)
    const old = await addFile('old.txt', root.id)
    const nested = await addFolder('nested', root.id)
    const deep = await addFile('deep.txt', nested.id)

    // The child goes first, on its own; its public link must stop working now.
    const link = await api('POST', `/api/v1/nodes/${old.id}/share`, auth({ body: {} }))
    assert.equal(link.status, 201, link.text)
    assert.equal((await remove(old.id)).status, 200)
    assert.equal((await api('GET', '/api/v1/shared/' + link.json.share.token)).status, 404)

    // The parent's deletion touches the parent, the live sibling and the whole
    // live nested branch — four rows, not the already-trashed file.
    const parentTrash = await remove(root.id)
    assert.equal(parentTrash.status, 200, parentTrash.text)
    assert.equal(parentTrash.json.trashed, 4)
    assert.deepEqual(
      (await trashList()).filter((node) => [kept.id, deep.id, old.id].includes(node.id)).map((node) => node.id).sort(),
      [kept.id, deep.id, old.id].sort(),
    )

    // Restoring the parent brings back its batch only: the old child stays
    // trashed, and so does the link that points at it.
    const restored = await restore(root.id)
    assert.equal(restored.status, 200, restored.text)
    // The public shape stays {node}: no id list leaks into the response.
    assert.deepEqual(Object.keys(restored.json), ['node'])
    assert.equal(restored.json.node.id, root.id)
    for (const id of [kept.id, nested.id, deep.id]) {
      const live = await api('GET', `/api/v1/nodes/${id}`, auth())
      assert.equal(live.status, 200, 'restored descendant ' + id)
    }
    const stillTrashed = await api('GET', `/api/v1/nodes/${old.id}`, auth())
    assert.notEqual(stillTrashed.json.node.deletedAt, null, 'the independently trashed child is not restored')
    assert.equal((await api('GET', '/api/v1/shared/' + link.json.share.token)).status, 404, 'the independently trashed child stays unreachable')

    // The old child is still its own batch: restoring it works on its own.
    assert.equal((await restore(old.id)).status, 200)
    assert.equal((await api('GET', '/api/v1/shared/' + link.json.share.token)).status, 200)
  })

  it('groups every page with one trashGroup and keeps old batches separate', async () => {
    const folderA = await addFolder('group-a')
    await addFile('group-a-1.txt', folderA.id)
    await addFile('group-a-2.txt', folderA.id)
    const folderB = await addFolder('group-b')
    await addFile('group-b-1.txt', folderB.id)

    assert.equal((await remove(folderA.id)).json.trashed, 3)
    assert.equal((await remove(folderB.id)).json.trashed, 2)

    const rows = (await trashList()).filter((node) => node.name.startsWith('group-'))
    const groups = new Map()
    for (const row of rows) {
      assert.match(row.trashGroup, /^batch:/)
      groups.set(row.trashGroup, (groups.get(row.trashGroup) ?? 0) + 1)
    }
    assert.equal(groups.size, 2, 'two deletions are two groups')
    assert.deepEqual([...groups.values()].sort(), [2, 3])

    // A page boundary does not invent a new group: the same batch is labelled
    // the same on every page it appears on.
    const first = await api('GET', '/api/v1/nodes?trash=1&q=group-a&sort=name&direction=asc&limit=2', auth())
    const second = await api('GET', '/api/v1/nodes?trash=1&q=group-a&sort=name&direction=asc&limit=2&offset=2', auth())
    const pages = [...first.json.nodes, ...second.json.nodes]
    assert.equal(pages.length, 3)
    assert.equal(new Set(pages.map((node) => node.trashGroup)).size, 1)

    // Only trashed rows carry the field: live JSON is unchanged.
    const live = await api('GET', '/api/v1/nodes?parentId=root', auth())
    assert.ok(live.json.nodes.every((node) => !Object.hasOwn(node, 'trashGroup')))
    // The legacy unpaged trash payload keeps its old shape too.
    const unpaged = await api('GET', '/api/v1/nodes?trash=1', auth())
    assert.ok(unpaged.json.nodes.every((node) => !Object.hasOwn(node, 'trashGroup')))
  })

  it('does not walk across an intervening independently deleted branch', async () => {
    const outer = await addFolder('outer')
    const middle = await addFolder('middle', outer.id)
    const leaf = await addFile('leaf.txt', middle.id)
    const sibling = await addFile('sibling.txt', outer.id)

    // The middle folder goes as its own batch first; its leaf goes with it.
    assert.equal((await remove(middle.id)).json.trashed, 2)
    // Then the outer folder: only what was still live belongs to this batch.
    assert.equal((await remove(outer.id)).json.trashed, 2)

    assert.equal((await restore(outer.id)).status, 200)
    assert.equal((await api('GET', `/api/v1/nodes/${sibling.id}`, auth())).status, 200)
    assert.notEqual((await api('GET', `/api/v1/nodes/${middle.id}`, auth())).json.node.deletedAt, null)
    assert.notEqual((await api('GET', `/api/v1/nodes/${leaf.id}`, auth())).json.node.deletedAt, null, 'the leaf stays with its branch')

    // The middle folder's own batch is still intact and restorable as a unit.
    assert.equal((await restore(middle.id)).status, 200)
    assert.equal((await api('GET', `/api/v1/nodes/${leaf.id}`, auth())).status, 200)
  })

  it('keeps two deletions with the same timestamp apart', async () => {
    const one = await addFolder('same-ms-one')
    await addFile('same-ms-one.txt', one.id)
    const two = await addFolder('same-ms-two')
    await addFile('same-ms-two.txt', two.id)
    assert.equal((await remove(one.id)).json.trashed, 2)
    assert.equal((await remove(two.id)).json.trashed, 2)

    // Force the state a same-millisecond pair would have produced: equal
    // deletion stamps, distinct batch ids.
    const stamp = new Date().toISOString()
    withDb((database) => database.prepare('UPDATE nodes SET deleted_at=? WHERE id IN (?,?)').run(stamp, one.id, two.id))
    const groups = (await trashList()).filter((node) => node.name.startsWith('same-ms-'))
    const oneGroup = new Set(groups.filter((node) => node.name.startsWith('same-ms-one')).map((node) => node.trashGroup))
    const twoGroup = new Set(groups.filter((node) => node.name.startsWith('same-ms-two')).map((node) => node.trashGroup))
    assert.equal(oneGroup.size, 1)
    assert.equal(twoGroup.size, 1)
    assert.notDeepEqual([...oneGroup], [...twoGroup], 'equal timestamps are still separate batches')

    assert.equal((await restore(one.id)).status, 200)
    const left = (await trashList()).filter((node) => node.name.startsWith('same-ms-two'))
    assert.equal(left.length, 2, 'restoring one same-time batch leaves the other in the trash')
  })

  it('uses the original deletion time for legacy rows, without a backfill', async () => {
    const folder = await addFolder('legacy-root')
    const child = await addFile('legacy-child.txt', folder.id)
    const later = await addFolder('legacy-later')
    assert.equal((await remove(folder.id)).json.trashed, 2)
    assert.equal((await remove(later.id)).json.trashed, 1)

    // Two older rows with one stamp (one batch) and one with another (a
    // different batch), exactly as a pre-column database would hold them.
    const shared = new Date(Date.now() - 60_000).toISOString()
    const distinct = new Date(Date.now() - 120_000).toISOString()
    withDb((database) => {
      database.prepare('UPDATE nodes SET trash_batch_id=NULL, deleted_at=? WHERE id IN (?,?)').run(shared, folder.id, child.id)
      database.prepare('UPDATE nodes SET trash_batch_id=NULL, deleted_at=? WHERE id=?').run(distinct, later.id)
    })
    const rows = (await trashList()).filter((node) => node.name.startsWith('legacy-'))
    const byName = new Map(rows.map((node) => [node.name, node.trashGroup]))
    assert.equal(byName.get('legacy-root'), 'legacy:' + shared)
    assert.equal(byName.get('legacy-child.txt'), 'legacy:' + shared)
    assert.equal(byName.get('legacy-later'), 'legacy:' + distinct)

    assert.equal((await restore(folder.id)).status, 200)
    assert.equal((await api('GET', `/api/v1/nodes/${child.id}`, auth())).status, 200, 'the same-time legacy child is restored')
    assert.notEqual((await api('GET', `/api/v1/nodes/${later.id}`, auth())).json.node.deletedAt, null, 'the other legacy stamp stays trashed')
  })

  it('scopes a member\'s delete to the root workspace', async () => {
    const member = (await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'batch member password' } })).json
    const shared = await addFolder('batch-shared')
    const inside = await addFile('inside.txt', shared.id)
    const { addMember } = await import('../src/workspaces.js')
    addMember((await api('GET', '/api/v1/me', auth())).json.user.workspace.id, member.user.id, 'member')

    const removed = await api('DELETE', `/api/v1/nodes/${shared.id}`, { token: member.token })
    assert.equal(removed.status, 200, removed.text)
    assert.equal(removed.json.trashed, 2, 'the member trashed the shared branch, not their own empty drive')
    assert.equal((await restore(shared.id)).status, 200)
    assert.equal((await api('GET', `/api/v1/nodes/${inside.id}`, { token: member.token })).status, 200)
  })

  it('renames a restored file whose name a workspace member reused', async () => {
    const member = (await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'restore member password' } })).json
    const { addMember } = await import('../src/workspaces.js')
    addMember((await api('GET', '/api/v1/me', auth())).json.user.workspace.id, member.user.id, 'member')

    // Reproduced over real HTTP: the owner trashes its file, the member writes
    // the same name into the same shared folder, then the owner restores.
    const shared = await addFolder('restore-shared')
    const ownerFile = await addFile('Budget.txt', shared.id)
    assert.equal((await remove(ownerFile.id)).status, 200)
    const memberUpload = await api('PUT', `/api/v1/uploads?name=Budget.txt&parentId=${shared.id}`, {
      token: member.token, raw: true, body: 'member budget', headers: { 'content-type': 'text/plain' },
    })
    assert.equal(memberUpload.status, 201, memberUpload.text)

    const restored = await restore(ownerFile.id)
    assert.equal(restored.status, 200, restored.text)
    assert.equal(restored.json.node.name, 'Budget.txt (restored)')
    const listed = await api('GET', `/api/v1/nodes?parentId=${shared.id}`, auth())
    assert.deepEqual(
      listed.json.nodes.filter((node) => node.name.startsWith('Budget.txt')).map((node) => node.name).sort(),
      ['Budget.txt', 'Budget.txt (restored)'],
      'the shared folder has two distinct names, not two rows named alike',
    )
    // Both files keep their own bytes: the member's upload did not overwrite the
    // trashed row, and the restore did not touch the live one.
    assert.equal((await api('GET', `/api/v1/files/${ownerFile.id}/content`, auth())).text, 'Budget.txt bytes')
    assert.equal((await api('GET', `/api/v1/files/${memberUpload.json.node.id}/content`, auth())).text, 'member budget')

    // At the root the namespace is the row owner's, not the caller's: the member
    // restores the owner's trashed root file while the owner has reused the name.
    const rootOld = await addFile('Budget-root.txt')
    assert.equal((await remove(rootOld.id)).status, 200)
    const rootLive = await api('PUT', '/api/v1/uploads?name=Budget-root.txt', auth({
      raw: true, body: 'owner replacement bytes', headers: { 'content-type': 'text/plain' },
    }))
    assert.equal(rootLive.status, 201, rootLive.text)
    const memberRestore = await api('POST', `/api/v1/nodes/${rootOld.id}/restore`, { token: member.token, body: {} })
    assert.equal(memberRestore.status, 200, memberRestore.text)
    assert.equal(memberRestore.json.node.name, 'Budget-root.txt (restored)')
    assert.equal((await api('GET', `/api/v1/files/${rootOld.id}/content`, auth())).text, 'Budget-root.txt bytes')
    assert.equal((await api('GET', `/api/v1/files/${rootLive.json.node.id}/content`, auth())).text, 'owner replacement bytes')
  })
})

describe('storage statistics', () => {
  it('reports storage statistics', async () => {
    const stats = await api('GET', '/api/v1/storage/stats', auth())
    assert.equal(stats.status, 200)
    assert.ok(stats.json.stats.files >= 1)
    assert.equal(typeof stats.json.stats.bytes, 'number')
  })

  it('no longer serves the retired Docs bridge routes', async () => {
    // The bridge was removed on purpose; a 404 here is the contract, and a 401
    // would mean an unauthenticated route is still registered somewhere.
    for (const [method, path] of [
      ['GET', '/api/v1/integrations/docs/status'],
      ['POST', '/api/v1/integrations/docs/login'],
      ['GET', '/api/v1/integrations/docs/documents'],
      ['POST', '/api/v1/integrations/docs/push'],
      ['GET', '/api/v1/integrations/docs/links'],
    ]) {
      const response = await api(method, path, auth({ body: method === 'GET' ? undefined : {} }))
      assert.equal(response.status, 404, method + ' ' + path + ' -> ' + response.status)
      assert.equal(response.json.error.code, 'NOT_FOUND')
    }
  })
})
