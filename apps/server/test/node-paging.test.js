import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { startServer, uniqueEmail } from './helpers.js'

let app, api, owner, outsider, folder, file
before(async () => {
  app = await startServer()
  api = app.client
  const register = async () => (await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'paging password' } })).json
  owner = await register()
  outsider = await register()
  const make = async (name, kind = 'file', parentId = null) => {
    const response = await api('POST', '/api/v1/nodes', { token: owner.token, body: { name, kind, parentId } })
    assert.equal(response.status, 201, response.text)
    return response.json.node
  }
  folder = await make('paging', 'folder')
  await make('z-subfolder', 'folder', folder.id)
  for (let i = 0; i < 7; i++) file = await make('file-' + i, 'file', folder.id)
  await make('elsewhere')
})
after(async () => { await app.close(); app.cleanup() })
const get = (query, token = owner.token) => api('GET', '/api/v1/nodes?' + query, { token })

it('bounds pages in the requested directory and exposes a truthful continuation', async () => {
  const first = await get('parentId=' + folder.id + '&limit=3')
  assert.equal(first.status, 200, first.text)
  assert.equal(first.json.nodes.length, 3)
  assert.equal(first.json.limit, 3)
  assert.equal(first.json.offset, 0)
  assert.equal(first.json.hasMore, true)
  assert.equal(first.json.nodes[0].kind, 'folder')
  const second = await get('parentId=' + folder.id + '&limit=3&offset=3')
  const third = await get('parentId=' + folder.id + '&limit=3&offset=6')
  const rows = [...first.json.nodes, ...second.json.nodes, ...third.json.nodes]
  assert.equal(new Set(rows.map((node) => node.id)).size, 8)
  assert.equal(third.json.hasMore, false)
  assert.ok(rows.every((node) => node.parentId === folder.id))
})

it('keeps the legacy unpaged listing available to CLI and directory upload checks', async () => {
  const all = await get('parentId=' + folder.id)
  assert.equal(all.json.nodes.length, 8)
  assert.equal(Object.hasOwn(all.json, 'hasMore'), false)
  const folders = await get('kind=folder')
  assert.ok(folders.json.nodes.every((node) => node.kind === 'folder'))
})

it('counts children for folder cards on a page but not on the unpaged listing', async () => {
  const paged = await get('parentId=root&limit=30')
  assert.equal(paged.status, 200, paged.text)
  const card = paged.json.nodes.find((node) => node.id === folder.id)
  assert.deepEqual(card.childCounts, { files: 7, folders: 1 })
  const all = await get('parentId=root')
  assert.ok(all.json.nodes.every((node) => !Object.hasOwn(node, 'childCounts')))
})

it('sorts globally before paging and leaves folders first when reversing files', async () => {
  const pages = []
  for (const offset of [0, 3, 6]) {
    const response = await get('parentId=' + folder.id + '&limit=3&offset=' + offset + '&direction=desc')
    pages.push(...response.json.nodes)
  }
  assert.equal(pages[0].kind, 'folder')
  assert.deepEqual(pages.slice(1).map((node) => node.name), ['file-6', 'file-5', 'file-4', 'file-3', 'file-2', 'file-1', 'file-0'])
})

it('reverses the folder name group when name sorting is explicitly descending', async () => {
  const shelf = (await api('POST', '/api/v1/nodes', { token: owner.token, body: { name: 'name-order', kind: 'folder', parentId: null } })).json.node
  for (const name of ['A folder', 'Z folder']) {
    const response = await api('POST', '/api/v1/nodes', { token: owner.token, body: { name, kind: 'folder', parentId: shelf.id } })
    assert.equal(response.status, 201, response.text)
  }
  const response = await get('parentId=' + shelf.id + '&kind=folder&sort=name&direction=desc&limit=50')
  assert.equal(response.status, 200, response.text)
  assert.deepEqual(response.json.nodes.map((node) => node.name), ['Z folder', 'A folder'])
  const ascending = await get('parentId=' + shelf.id + '&kind=folder&sort=name&direction=asc&limit=50')
  assert.deepEqual(ascending.json.nodes.map((node) => node.name), ['A folder', 'Z folder'])
})

it('rejects malformed paging and direction inputs', async () => {
  for (const query of ['limit=0', 'limit=-1', 'limit=501', 'limit=abc', 'limit=1.5', 'offset=-1', 'offset=NaN', 'offset=1.5', 'direction=sideways']) {
    const response = await get(query)
    assert.equal(response.status, 400, query + ': ' + response.text)
  }
})

it('authorizes a parent before enumerating children', async () => {
  const hidden = await get('parentId=' + folder.id + '&limit=3', outsider.token)
  assert.equal(hidden.status, 404)
  const wrongKind = await get('parentId=' + file.id + '&limit=3')
  assert.equal(wrongKind.status, 400)
  assert.equal(wrongKind.json.error.code, 'NOT_FOLDER')
})

it('pages shared folder children without weakening personal root scope', async () => {
  const { addMember } = await import('../src/workspaces.js')
  addMember(owner.user.workspace.id, outsider.user.id, 'member')
  const shared = await get('parentId=' + folder.id + '&limit=3', outsider.token)
  assert.equal(shared.status, 200, shared.text)
  assert.equal(shared.json.nodes.length, 3)
  const root = await get('parentId=root&limit=3', outsider.token)
  assert.deepEqual(root.json.nodes, [])
})

it('reports an empty last page without inventing more records', async () => {
  const response = await get('parentId=' + folder.id + '&limit=3&offset=100')
  assert.deepEqual(response.json.nodes, [])
  assert.equal(response.json.hasMore, false)
})

it('orders paged trash by deletion time so a fresh child still reaches the first page', async () => {
  const root = (await api('POST', '/api/v1/nodes', { token: owner.token, body: { name: 'trash-root', kind: 'folder' } })).json.node
  const parent = (await api('POST', '/api/v1/nodes', { token: owner.token, body: { name: 'trash-parent', kind: 'folder', parentId: root.id } })).json.node
  const child = (await api('POST', '/api/v1/nodes', { token: owner.token, body: { name: 'trash-child', kind: 'file', parentId: parent.id } })).json.node
  const older = (await api('POST', '/api/v1/nodes', { token: owner.token, body: { name: 'trash-older.txt', kind: 'file' } })).json.node
  assert.equal((await api('DELETE', '/api/v1/nodes/' + older.id, { token: owner.token })).status, 200)
  assert.equal((await api('DELETE', '/api/v1/nodes/' + child.id, { token: owner.token })).status, 200)
  // A trashed row edited after deletion: its updated_at is newer than its
  // deleted_at, so sorting by updated_at would hide it from a one-row page.
  const database = new DatabaseSync(join(app.dataDir, 'drive.db'))
  try {
    database.prepare('UPDATE nodes SET updated_at=? WHERE id=?').run(new Date(Date.now() + 60000).toISOString(), older.id)
  } finally {
    database.close()
  }

  const paged = await get('trash=1&sort=updated&direction=desc&limit=1')
  assert.equal(paged.status, 200, paged.text)
  assert.deepEqual(paged.json.nodes.map((node) => node.id), [child.id])
  assert.deepEqual(paged.json.nodes[0].originalPath, [
    { id: root.id, name: 'trash-root', kind: 'folder' },
    { id: parent.id, name: 'trash-parent', kind: 'folder' },
  ])
  const all = await get('trash=1&sort=updated&direction=desc&limit=50')
  assert.deepEqual(all.json.nodes.find((node) => node.id === older.id).originalPath, [])

  // The legacy unpaged listing keeps updated_at ordering and carries no page.
  const unpaged = await get('trash=1&sort=updated')
  assert.equal(Object.hasOwn(unpaged.json, 'hasMore'), false)
  assert.deepEqual(unpaged.json.nodes.map((node) => node.id), [older.id, child.id])
})

/**
 * The recycle bin's name filter.
 *
 * The rules under test are the ones the browser cannot make true on its own:
 * the term narrows the query BEFORE LIMIT/OFFSET (so a match on a later page is
 * still reachable), it applies only to trashed rows of the caller, and LIKE's
 * wildcards are literal characters in a file name.
 */
describe('trash name filter', () => {
  let ownerToken, ownerFolder, outsiderToken
  const make = async (name, kind = 'file', parentId = null, token = ownerToken) => {
    const response = await api('POST', '/api/v1/nodes', { token, body: { name, kind, parentId } })
    assert.equal(response.status, 201, response.text)
    return response.json.node
  }
  const trashNode = async (node, token = ownerToken) => {
    const response = await api('DELETE', '/api/v1/nodes/' + node.id, { token })
    assert.equal(response.status, 200, response.text)
  }
  const trashList = (query, token = ownerToken) => api('GET', '/api/v1/nodes?trash=1&limit=50&' + query, { token })

  before(async () => {
    // A fresh account: the tests above left their own rows in this bin, and a
    // filter test that has to exclude them cannot tell scope from filtering.
    const register = async () => (await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'trash filter password' } })).json
    const ownerAccount = await register()
    ownerToken = ownerAccount.token
    ownerFolder = await make('filter-origin', 'folder')
    for (const name of ['Alpha Report.txt', 'alpha notes.md', '季度报告-阿尔法.txt', '100% done.txt', 'under_score.txt', 'beta.txt', '闲置.bin']) {
      await trashNode(await make(name, 'file', ownerFolder.id))
    }
    await trashNode(await make('Alpha Folder', 'folder'))
    // Live rows with the same word must never appear in the recycle bin, and a
    // q on the live listing keeps its old meaning (no filtering there).
    await make('Alpha live.txt', 'file', ownerFolder.id)
    const outsiderAccount = await register()
    outsiderToken = outsiderAccount.token
    await trashNode(await make('Alpha outsider.txt', 'file', null, outsiderToken), outsiderToken)
  })

  it('finds a trimmed, case-insensitive substring of trashed names only', async () => {
    const response = await trashList('q=' + encodeURIComponent('  ALPHA  '))
    assert.equal(response.status, 200, response.text)
    const names = response.json.nodes.map((node) => node.name).sort()
    assert.deepEqual(names, ['Alpha Folder', 'Alpha Report.txt', 'alpha notes.md'])
    assert.ok(response.json.nodes.every((node) => node.deletedAt), 'only trashed rows are answered')
    assert.ok(!names.includes('Alpha live.txt'), 'a live row is not in the trash')
    assert.ok(!names.includes('Alpha outsider.txt'), 'another account is out of scope')
    const foreign = await trashList('q=outsider', outsiderToken)
    assert.deepEqual(foreign.json.nodes.map((node) => node.name), ['Alpha outsider.txt'])
  })

  it('applies the term before paging, so a late match is on page one', async () => {
    // Unfiltered, the matching file sorts after the first page. Filtered, it is
    // the first page: the WHERE clause runs before LIMIT, not after it.
    const unfiltered = await api('GET', '/api/v1/nodes?trash=1&sort=name&direction=asc&limit=1', { token: ownerToken })
    assert.equal(unfiltered.status, 200, unfiltered.text)
    assert.notEqual(unfiltered.json.nodes[0].name, 'under_score.txt')
    const first = await api('GET', '/api/v1/nodes?trash=1&q=' + encodeURIComponent('under_') + '&sort=name&direction=asc&limit=1', { token: ownerToken })
    assert.equal(first.status, 200, first.text)
    assert.deepEqual(first.json.nodes.map((node) => node.name), ['under_score.txt'])
    assert.equal(first.json.hasMore, false)
    assert.equal(first.json.limit, 1)
    assert.equal(first.json.offset, 0)
    // Its original location and deletion time survive the filter.
    assert.equal(first.json.nodes[0].originalPath.length, 1)
    assert.equal(first.json.nodes[0].originalPath[0].id, ownerFolder.id)
  })

  it('treats SQL wildcards in the name as literal characters', async () => {
    const percent = await trashList('q=' + encodeURIComponent('%'))
    assert.equal(percent.status, 200, percent.text)
    assert.deepEqual(percent.json.nodes.map((node) => node.name), ['100% done.txt'])
    const underscore = await trashList('q=' + encodeURIComponent('_'))
    assert.deepEqual(underscore.json.nodes.map((node) => node.name), ['under_score.txt'])
    // A term that is only an escape character is still a normal substring.
    const slash = await trashList('q=' + encodeURIComponent('\\'))
    assert.equal(slash.status, 200, slash.text)
    assert.deepEqual(slash.json.nodes, [])
  })

  it('matches Chinese names and combines with the existing kind field', async () => {
    const chinese = await trashList('q=' + encodeURIComponent('报告'))
    assert.equal(chinese.status, 200, chinese.text)
    assert.deepEqual(chinese.json.nodes.map((node) => node.name), ['季度报告-阿尔法.txt'])
    const files = await trashList('q=alpha&kind=file')
    assert.equal(files.status, 200, files.text)
    assert.deepEqual(files.json.nodes.map((node) => node.name).sort(), ['Alpha Report.txt', 'alpha notes.md'])
    const folders = await trashList('q=alpha&kind=folder')
    assert.deepEqual(folders.json.nodes.map((node) => node.name), ['Alpha Folder'])
    const everything = await trashList('q=alpha&kind=image')
    assert.equal(everything.status, 200, 'a kind the trash does not filter is ignored, not rejected')
    assert.equal(everything.json.nodes.length, 3)
  })

  it('answers a no-match page with an empty list and hasMore false', async () => {
    const response = await trashList('q=' + encodeURIComponent('no-such-name'))
    assert.equal(response.status, 200, response.text)
    assert.deepEqual(response.json.nodes, [])
    assert.equal(response.json.hasMore, false)
  })

  it('caps a long term instead of failing the request', async () => {
    // The cap is a slice, not a rejection: a 5000-character term is a normal
    // (empty) answer, never a 400 or an unbounded LIKE pattern.
    const tooLong = await trashList('q=' + 'a'.repeat(5000))
    assert.equal(tooLong.status, 200, tooLong.text)
    assert.deepEqual(tooLong.json.nodes, [])

    // Exactly at the cap it still matches, and anything past it is ignored:
    // otherwise the same field would quietly answer a different question than
    // the one the client capped.
    const name = 'cap-' + 'z'.repeat(96)
    assert.equal(name.length, 100)
    await trashNode(await make(name))
    const atCap = await trashList('q=' + encodeURIComponent(name))
    assert.equal(atCap.status, 200, atCap.text)
    assert.deepEqual(atCap.json.nodes.map((node) => node.name), [name])
    const pastCap = await trashList('q=' + encodeURIComponent(name + 'never-considered'))
    assert.deepEqual(pastCap.json.nodes.map((node) => node.name), [name])
  })

  it('leaves the live listings and the bare trash listing unchanged', async () => {
    // q is not a filter on a live listing: the same rows come back with and
    // without it, which is the pre-existing live-list contract.
    const withQ = await api('GET', '/api/v1/nodes?limit=50&q=' + encodeURIComponent('filter-origin'), { token: ownerToken })
    const withoutQ = await api('GET', '/api/v1/nodes?limit=50', { token: ownerToken })
    assert.equal(withQ.status, 200, withQ.text)
    assert.deepEqual(withQ.json.nodes.map((node) => node.id), withoutQ.json.nodes.map((node) => node.id))
    assert.ok(withQ.json.nodes.some((node) => node.name === 'filter-origin'))
    const bare = await api('GET', '/api/v1/nodes?trash=1&limit=50', { token: ownerToken })
    assert.equal(bare.status, 200, bare.text)
    assert.equal(bare.json.nodes.length, 9)
    const unpaged = await api('GET', '/api/v1/nodes?trash=1&q=alpha', { token: ownerToken })
    assert.equal(unpaged.status, 200, unpaged.text)
    assert.equal(Object.hasOwn(unpaged.json, 'hasMore'), false)
    assert.deepEqual(unpaged.json.nodes.map((node) => node.name).sort(), ['Alpha Folder', 'Alpha Report.txt', 'alpha notes.md'])
  })
})

/**
 * The recycle bin's deletion-time filter.
 *
 * Two rules matter and neither is visible from the client: the window is an
 * exact rolling duration measured from the request (not "today" in some
 * timezone), and it narrows the set BEFORE LIMIT/OFFSET so "继续加载" keeps
 * walking the same filtered set. The rows are written with real `deleted_at`
 * values through SQLite, because a test that awaits the wall clock cannot sit on
 * a boundary.
 */
describe('trash deletion-time filter', () => {
  const HOUR = 60 * 60 * 1000
  const DAY = 24 * HOUR
  let ownerToken, ownerFolder, outsiderToken

  const withDb = (fn) => {
    const database = new DatabaseSync(join(app.dataDir, 'drive.db'))
    try { return fn(database) } finally { database.close() }
  }
  const make = async (name, kind = 'file', parentId = null, token = ownerToken) => {
    const response = await api('POST', '/api/v1/nodes', { token, body: { name, kind, parentId } })
    assert.equal(response.status, 201, response.text)
    return response.json.node
  }
  const trashNode = async (node, token = ownerToken) => {
    const response = await api('DELETE', '/api/v1/nodes/' + node.id, { token })
    assert.equal(response.status, 200, response.text)
  }
  /** Writes a real deletion timestamp, in ISO UTC, the way the server stores it. */
  const deletedAt = (id, iso) => withDb((database) => database.prepare('UPDATE nodes SET deleted_at=? WHERE id=?').run(iso, id))
  const at = (msAgo) => new Date(Date.now() - msAgo).toISOString()
  const trashList = (query, token = ownerToken) => api('GET', '/api/v1/nodes?trash=1&limit=50&' + query, { token })
  const names = (response) => response.json.nodes.map((node) => node.name).sort()

  before(async () => {
    // A fresh account: this bin is shared with the suites above, and a filter
    // test that has to exclude their rows cannot tell the window from the scope.
    const register = async () => (await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'deleted within password' } })).json
    const ownerAccount = await register()
    ownerToken = ownerAccount.token
    ownerFolder = await make('when-origin', 'folder')
    const rows = {}
    for (const name of ['just-now.txt', 'hours-23.txt', 'days-2.txt', 'days-8.txt', 'days-29.txt']) {
      rows[name] = await make(name, 'file', ownerFolder.id)
      await trashNode(rows[name])
    }
    // Real timestamps, each comfortably inside one window and outside the next.
    deletedAt(rows['just-now.txt'].id, at(60 * 1000))
    deletedAt(rows['hours-23.txt'].id, at(23 * HOUR))
    deletedAt(rows['days-2.txt'].id, at(2 * DAY))
    deletedAt(rows['days-8.txt'].id, at(8 * DAY))
    deletedAt(rows['days-29.txt'].id, at(29 * DAY))

    // A fresh account whose whole bin sits inside the 24h window, for the
    // ownership check: the filter must never widen the scope.
    const outsiderAccount = await register()
    outsiderToken = outsiderAccount.token
    const outsiderRow = await make('outsider-fresh.txt', 'file', null, outsiderToken)
    await trashNode(outsiderRow, outsiderToken)
    deletedAt(outsiderRow.id, at(60 * 1000))
  })

  it('measures an exact rolling window and leaves 全部时间 untouched', async () => {
    // Imported here, not at the top of the file: db.js resolves its path from
    // DRIVE_DATA_DIR at module load, and startServer() sets that in before().
    const { trashDeletedCutoff } = await import('../src/routes/nodes.js')
    // The duration itself, pinned: 24h is 24*3600*1000, not "since midnight".
    const reference = Date.parse('2026-03-01T12:00:00.000Z')
    assert.equal(trashDeletedCutoff('24h', reference), '2026-02-28T12:00:00.000Z')
    assert.equal(trashDeletedCutoff('7d', reference), '2026-02-22T12:00:00.000Z')
    assert.equal(trashDeletedCutoff('30d', reference), new Date(reference - 30 * DAY).toISOString())
    // Anything outside the closed vocabulary is "no filter", never a 500 and
    // never a silently different duration.
    for (const value of ['', '1h', 'today', '7', '7D', '24h ', '../7d', null, undefined, 7]) {
      assert.equal(trashDeletedCutoff(value, reference), null, String(value))
    }
  })

  it('narrows the bin to each preset without touching older rows', async () => {
    const day = await trashList('deletedWithin=24h')
    assert.equal(day.status, 200, day.text)
    assert.deepEqual(names(day), ['hours-23.txt', 'just-now.txt'])
    assert.equal(day.json.hasMore, false)

    const week = await trashList('deletedWithin=7d')
    assert.equal(week.status, 200, week.text)
    assert.deepEqual(names(week), ['days-2.txt', 'hours-23.txt', 'just-now.txt'])

    const month = await trashList('deletedWithin=30d')
    assert.equal(month.status, 200, month.text)
    assert.deepEqual(names(month), ['days-2.txt', 'days-29.txt', 'days-8.txt', 'hours-23.txt', 'just-now.txt'])

    // 全部时间 is the bare listing: no `deletedWithin`, same answer.
    const all = await trashList('')
    assert.equal(all.status, 200, all.text)
    assert.equal(all.json.nodes.length, 5)
    const explicitAll = await trashList('deletedWithin=')
    assert.equal(explicitAll.json.nodes.length, 5)
  })

  it('applies the window before paging, so 继续加载 walks the filtered set', async () => {
    // Ordered by deletion (newest first) the 7-day set has three rows. A page of
    // one must take the newest, and the continuation must stay inside the window
    // instead of falling back to the two older rows.
    const first = await api('GET', '/api/v1/nodes?trash=1&deletedWithin=7d&sort=updated&direction=desc&limit=1&offset=0', { token: ownerToken })
    assert.equal(first.status, 200, first.text)
    assert.deepEqual(first.json.nodes.map((node) => node.name), ['just-now.txt'])
    assert.equal(first.json.hasMore, true)
    const second = await api('GET', '/api/v1/nodes?trash=1&deletedWithin=7d&sort=updated&direction=desc&limit=1&offset=1', { token: ownerToken })
    assert.deepEqual(second.json.nodes.map((node) => node.name), ['hours-23.txt'])
    assert.equal(second.json.hasMore, true)
    const third = await api('GET', '/api/v1/nodes?trash=1&deletedWithin=7d&sort=updated&direction=desc&limit=1&offset=2', { token: ownerToken })
    assert.deepEqual(third.json.nodes.map((node) => node.name), ['days-2.txt'])
    assert.equal(third.json.hasMore, false, 'three matches, three pages: the window is the set')
    // The next page must be empty even though the bin still holds older rows:
    // they are outside the window, not merely past the offset.
    const fourth = await api('GET', '/api/v1/nodes?trash=1&deletedWithin=7d&sort=updated&direction=desc&limit=1&offset=3', { token: ownerToken })
    assert.deepEqual(fourth.json.nodes, [], 'the older rows never leak into a filtered continuation')
    assert.equal(fourth.json.hasMore, false)
    // Unfiltered, the same page offsets do reach the older rows.
    const unfiltered = await api('GET', '/api/v1/nodes?trash=1&sort=updated&direction=desc&limit=1&offset=3', { token: ownerToken })
    assert.deepEqual(unfiltered.json.nodes.map((node) => node.name), ['days-8.txt'])
  })

  it('combines with the name and type filters in one page', async () => {
    const combined = await trashList('deletedWithin=7d&q=days&kind=file')
    assert.equal(combined.status, 200, combined.text)
    assert.deepEqual(names(combined), ['days-2.txt'])
    const wrongKind = await trashList('deletedWithin=7d&q=days&kind=folder')
    assert.deepEqual(wrongKind.json.nodes, [])
    const tooOld = await trashList('deletedWithin=24h&q=days')
    assert.deepEqual(tooOld.json.nodes, [], 'the window wins over a name that exists outside it')
    // The row still carries what the list needs to render a deletion.
    const row = combined.json.nodes[0]
    assert.equal(row.originalPath[0].id, ownerFolder.id)
    assert.equal(typeof row.deletedAt, 'string')
  })

  it('keeps the filter on the trash only and never leaks another account rows', async () => {
    // Live listings: the parameter is ignored, not validated and not applied.
    const live = await api('GET', '/api/v1/nodes?limit=50&deletedWithin=24h', { token: ownerToken })
    const plain = await api('GET', '/api/v1/nodes?limit=50', { token: ownerToken })
    assert.equal(live.status, 200, live.text)
    assert.deepEqual(live.json.nodes.map((node) => node.id), plain.json.nodes.map((node) => node.id))
    // The garbage value that IS rejected on the trash is harmless elsewhere.
    assert.equal((await api('GET', '/api/v1/nodes?limit=50&deletedWithin=fortnight', { token: ownerToken })).status, 200)

    // Ownership is unchanged by the filter: another account's fresh row is out
    // of scope, and our own rows are not visible from theirs.
    const own = await trashList('deletedWithin=24h')
    assert.ok(!own.json.nodes.some((node) => node.name === 'outsider-fresh.txt'))
    const foreign = await trashList('deletedWithin=24h', outsiderToken)
    assert.deepEqual(names(foreign), ['outsider-fresh.txt'])
    // The legacy unpaged listing keeps its shape with the filter applied.
    const unpaged = await api('GET', '/api/v1/nodes?trash=1&deletedWithin=24h', { token: ownerToken })
    assert.equal(unpaged.status, 200, unpaged.text)
    assert.equal(Object.hasOwn(unpaged.json, 'hasMore'), false)
    assert.deepEqual(names(unpaged), ['hours-23.txt', 'just-now.txt'])
  })

  it('rejects an unknown preset on the trash instead of answering everything', async () => {
    for (const value of ['1h', 'today', '7', '7D', '24h ', ' fortnight']) {
      const response = await trashList('deletedWithin=' + encodeURIComponent(value))
      assert.equal(response.status, 400, value + ': ' + response.text)
      assert.equal(response.json.error.code, 'INVALID_INPUT')
    }
    // A blank value is 全部时间, which is what the form sends for that option.
    assert.equal((await trashList('deletedWithin=')).status, 200)
  })
})

/**
 * The merge manifest is the preflight a folder merge diffs against, so it must
 * describe one subtree completely: the root excluded, descendants at every
 * depth, and nothing from the folder's siblings.
 */
describe('merge manifest', () => {
  const withDb = (fn) => {
    const database = new DatabaseSync(join(app.dataDir, 'drive.db'))
    try { return fn(database) } finally { database.close() }
  }
  const manifest = (id, token = owner.token) => api('GET', '/api/v1/nodes/' + id + '/merge-manifest', { token })

  it('lists every live descendant with node-shaped fields and no root or siblings', async () => {
    const root = (await api('POST', '/api/v1/nodes', { token: owner.token, body: { name: 'merge-root', kind: 'folder' } })).json.node
    const nested = (await api('POST', '/api/v1/nodes', { token: owner.token, body: { name: 'nested', kind: 'folder', parentId: root.id } })).json.node
    const deep = (await api('POST', '/api/v1/nodes', { token: owner.token, body: { name: 'deep', kind: 'folder', parentId: nested.id } })).json.node
    await api('POST', '/api/v1/nodes', { token: owner.token, body: { name: 'leaf.txt', kind: 'file', parentId: deep.id } })
    await api('POST', '/api/v1/nodes', { token: owner.token, body: { name: 'sibling', kind: 'folder', parentId: root.parent_id } })

    const response = await manifest(root.id)
    assert.equal(response.status, 200, response.text)
    assert.equal(response.json.complete, true)
    const ids = response.json.nodes.map((node) => node.id)
    assert.equal(new Set(ids).size, 3)
    assert.ok(!ids.includes(root.id), 'the merge target itself is not a descendant')
    const leaf = response.json.nodes.find((node) => node.name === 'leaf.txt')
    assert.ok(leaf, JSON.stringify(response.json.nodes))
    assert.deepEqual(ids.slice().sort(), [nested.id, deep.id, leaf.id].sort())
    // Field names are the ones the upload version guard reads back.
    assert.deepEqual(Object.keys(leaf).sort(), ['blobHash', 'id', 'kind', 'name', 'parentId', 'size', 'version'])
    assert.equal(leaf.parentId, deep.id)
    assert.equal(leaf.version, 1)
  })

  it('skips trashed subtrees instead of reporting a partial branch', async () => {
    const root = (await api('POST', '/api/v1/nodes', { token: owner.token, body: { name: 'merge-trash', kind: 'folder' } })).json.node
    const kept = (await api('POST', '/api/v1/nodes', { token: owner.token, body: { name: 'kept', kind: 'folder', parentId: root.id } })).json.node
    const dropped = (await api('POST', '/api/v1/nodes', { token: owner.token, body: { name: 'dropped', kind: 'folder', parentId: root.id } })).json.node
    await api('POST', '/api/v1/nodes', { token: owner.token, body: { name: 'inside-dropped', kind: 'file', parentId: dropped.id } })
    const trashed = await api('DELETE', '/api/v1/nodes/' + dropped.id, { token: owner.token })
    assert.equal(trashed.status, 200, trashed.text)

    const response = await manifest(root.id)
    assert.equal(response.status, 200, response.text)
    assert.deepEqual(response.json.nodes.map((node) => node.id), [kept.id])
  })

  it('answers complete:false with no nodes above the 5000 descendant cap', async () => {
    const root = (await api('POST', '/api/v1/nodes', { token: owner.token, body: { name: 'merge-big', kind: 'folder' } })).json.node
    withDb((database) => {
      const owner_ = database.prepare('SELECT user_id, workspace_id FROM nodes WHERE id=?').get(root.id)
      const statement = database.prepare(`INSERT INTO nodes(id,user_id,workspace_id,parent_id,name,kind,size,mime,version,starred,blob_hash,created_at,updated_at)
        VALUES (?,?,?,?,?,'file',0,NULL,1,0,NULL,?,?)`)
      const timestamp = new Date().toISOString()
      for (let index = 0; index < 5001; index++) {
        statement.run('big-' + index, owner_.user_id, owner_.workspace_id, root.id, 'big-' + index + '.txt', timestamp, timestamp)
      }
    })

    const over = await manifest(root.id)
    assert.equal(over.status, 200, over.text)
    assert.deepEqual(over.json, { complete: false, nodes: [] })

    // One row below the cap is still a complete manifest, so the boundary is
    // the count and not an off-by-one in the LIMIT.
    withDb((database) => database.prepare('DELETE FROM nodes WHERE id=?').run('big-5000'))
    const under = await manifest(root.id)
    assert.equal(under.status, 200, under.text)
    assert.equal(under.json.complete, true)
    assert.equal(under.json.nodes.length, 5000)
  })

  it('refuses a missing, trashed or non-folder target and lets a member read a shared one', async () => {
    assert.equal((await manifest('does-not-exist')).status, 404)
    // A fresh account: an earlier test already added `outsider` to the workspace.
    const stranger = (await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'paging password' } })).json
    assert.equal((await manifest(folder.id, stranger.token)).status, 404, 'a non-member cannot preflight someone else\'s folder')
    const asFile = await manifest(file.id)
    assert.equal(asFile.status, 400)
    assert.equal(asFile.json.error.code, 'NOT_FOLDER')
    const gone = (await api('POST', '/api/v1/nodes', { token: owner.token, body: { name: 'merge-gone', kind: 'folder' } })).json.node
    await api('DELETE', '/api/v1/nodes/' + gone.id, { token: owner.token })
    assert.equal((await manifest(gone.id)).status, 404)

    // `folder` is shared with the outsider by the membership test above.
    const shared = await manifest(folder.id, outsider.token)
    assert.equal(shared.status, 200, shared.text)
    assert.equal(shared.json.complete, true)
    assert.deepEqual(shared.json.nodes.map((node) => node.name), ['file-0', 'file-1', 'file-2', 'file-3', 'file-4', 'file-5', 'file-6', 'z-subfolder'])
  })
})
