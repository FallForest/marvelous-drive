import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { startServer, uniqueEmail } from './helpers.js'

/**
 * The owner list's two filters: ?q= (source name) and ?state= (effective state).
 *
 * The properties that matter are about the *question*, not the page: both
 * filters narrow the set before LIMIT/OFFSET (so a match on later unfiltered
 * pages is reachable and `hasMore` is about the filtered set), the state
 * predicate uses the same precedence the rows report (trash > expired >
 * exhausted > active), the creator boundary never widens, and a request with no
 * filter still answers exactly what it answered before the filters existed.
 */

let app
let api

before(async () => {
  app = await startServer()
  api = app.client
})

after(async () => {
  await app.close()
  app.cleanup()
})

async function newAccount(label) {
  const registered = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: label + ' password' } })
  assert.equal(registered.status, 201, registered.text)
  return registered.json.token
}

async function uploadAs(as, name, text) {
  const response = await api('PUT', '/api/v1/uploads?name=' + encodeURIComponent(name),
    { token: as, raw: true, body: text, headers: { 'content-type': 'text/plain' } })
  assert.equal(response.status, 201, response.text)
  return response.json.node
}

async function folderAs(as, name) {
  const response = await api('POST', '/api/v1/nodes', { token: as, body: { name, kind: 'folder' } })
  assert.equal(response.status, 201, response.text)
  return response.json.node
}

async function shareAs(as, nodeId, body = {}) {
  const response = await api('POST', '/api/v1/nodes/' + nodeId + '/share', { token: as, body })
  assert.equal(response.status, 201, response.text)
  return response.json.share
}

/** One page of the owner list, as the client asks for it. */
async function list(as, query = '') {
  const response = await api('GET', '/api/v1/shares' + (query ? '?' + query : ''), { token: as })
  assert.equal(response.status, 200, response.text)
  return { ...response.json, text: response.text }
}

const ids = (payload) => payload.shares.map((share) => share.id)

/**
 * Walks every page of one filtered query at `limit`, asserting the paging
 * contract as it goes: no repeats, a stable concatenation, and `hasMore` that
 * only says true while a row is really past the page.
 */
async function walk(as, query, limit) {
  const seen = []
  let offset = 0
  for (let guard = 0; guard < 50; guard += 1) {
    const payload = await list(as, 'limit=' + limit + '&offset=' + offset + (query ? '&' + query : ''))
    assert.equal(payload.offset, offset)
    assert.equal(payload.limit, limit)
    seen.push(...ids(payload))
    offset += limit
    if (!payload.hasMore) return seen
  }
  throw new Error('walk did not terminate: ' + query)
}

describe('owner list filters (GET /api/v1/shares?q=&state=)', () => {
  it('keeps the unfiltered answer byte-identical for a caller that sends no filter', async () => {
    const as = await newAccount('plain')
    const file = await uploadAs(as, 'plain.txt', 'plain bytes')
    const created = []
    for (let index = 0; index < 5; index += 1) created.push(await shareAs(as, file.id))

    const unfiltered = await list(as)
    const explicit = await list(as, 'limit=50&offset=0')
    assert.deepEqual(ids(unfiltered), ids(explicit))
    assert.equal(unfiltered.hasMore, false)
    assert.equal(unfiltered.limit, 50)
    assert.equal(unfiltered.offset, 0)
    assert.deepEqual(new Set(ids(unfiltered)), new Set(created.map((share) => share.id)))
    // An empty q is no filter, exactly like a whitespace-only one.
    assert.deepEqual(ids(await list(as, 'q=')), ids(unfiltered))
    assert.deepEqual(ids(await list(as, 'q=%20%20')), ids(unfiltered))
  })

  it('filters by trimmed source name before paging, matching files and folders', async () => {
    const as = await newAccount('names')
    const folder = await folderAs(as, '季度报告')
    const matchingFile = await uploadAs(as, '2026 季度报告.txt', 'bytes')
    const otherFile = await uploadAs(as, '无关.txt', 'bytes')
    const links = []
    // Interleave: 12 newest first are unrelated, the two matches are older, so a
    // first-page-only filter would see nothing. Filtering must reach them.
    links.push(await shareAs(as, matchingFile.id))
    links.push(await shareAs(as, folder.id))
    for (let index = 0; index < 12; index += 1) links.push(await shareAs(as, otherFile.id))

    const matched = await list(as, 'q=' + encodeURIComponent('  季度报告  '))
    assert.deepEqual(new Set(ids(matched)), new Set(links.slice(0, 2).map((share) => share.id)))
    assert.equal(matched.hasMore, false)
    assert.ok(matched.shares.every((share) => share.node.name.includes('季度报告')))

    // Paged over the filtered set only: no page may contain an unrelated row.
    const walked = await walk(as, 'q=' + encodeURIComponent('季度报告'), 1)
    assert.equal(new Set(walked).size, 2)
    assert.deepEqual(new Set(walked), new Set(links.slice(0, 2).map((share) => share.id)))
  })

  it('treats % and _ in the term as literal characters of a name', async () => {
    const as = await newAccount('wildcards')
    const percent = await uploadAs(as, '100% 完成.txt', 'bytes')
    const underscore = await uploadAs(as, 'a_b.txt', 'bytes')
    const plain = await uploadAs(as, 'axb.txt', 'bytes')
    const percentLink = await shareAs(as, percent.id)
    const underscoreLink = await shareAs(as, underscore.id)
    const plainLink = await shareAs(as, plain.id)

    assert.deepEqual(ids(await list(as, 'q=' + encodeURIComponent('100%'))), [percentLink.id])
    // `_` is one-character-in-LIKE if unescaped: it would also match axb.txt.
    assert.deepEqual(ids(await list(as, 'q=' + encodeURIComponent('a_b'))), [underscoreLink.id])
    assert.ok(!ids(await list(as, 'q=' + encodeURIComponent('a_b'))).includes(plainLink.id))
  })

  it('filters by effective state with the same priority the rows report', async () => {
    const as = await newAccount('states')
    const { db } = await import('../src/db.js')

    const liveFile = await uploadAs(as, 'live.txt', 'bytes')
    const active = await shareAs(as, liveFile.id, { permission: 'downloader' })

    const expiredFile = await uploadAs(as, 'expired.txt', 'bytes')
    const expired = await shareAs(as, expiredFile.id, { expiresInDays: 1 })

    const spentFile = await uploadAs(as, 'spent.txt', 'bytes')
    const exhausted = await shareAs(as, spentFile.id, { permission: 'downloader', maxDownloads: 1 })

    // Both expired AND out of budget: expiry outranks the budget, exactly as
    // shareState() orders its checks, so this row belongs to 已过期 only.
    const bothFile = await uploadAs(as, 'both.txt', 'bytes')
    const both = await shareAs(as, bothFile.id, { permission: 'downloader', maxDownloads: 1, expiresInDays: 1 })

    const trashedFile = await uploadAs(as, 'trashed.txt', 'bytes')
    const trashed = await shareAs(as, trashedFile.id, { permission: 'downloader', maxDownloads: 1, expiresInDays: 1 })

    // Spend both budgets through the public link: the only thing that may move
    // the counter.
    assert.equal((await api('GET', '/api/v1/shared/' + exhausted.token + '/content')).status, 200)
    assert.equal((await api('GET', '/api/v1/shared/' + both.token + '/content')).status, 200)
    assert.equal((await api('GET', '/api/v1/shared/' + trashed.token + '/content')).status, 200)

    // Age the two expiries; the public gate compares the same strings.
    const past = new Date(Date.now() - 60_000).toISOString()
    db.prepare('UPDATE shares SET expires_at=? WHERE id IN (?,?)').run(past, expired.id, both.id)
    // Trash the sources: one row that is only trashed, one that is trashed *and*
    // expired and out of budget (trash must win).
    assert.equal((await api('DELETE', '/api/v1/nodes/' + trashedFile.id, { token: as })).status, 200)
    const bothSource = await uploadAs(as, 'both-trashed.txt', 'bytes')
    const bothTrashed = await shareAs(as, bothSource.id, { maxDownloads: 1, expiresInDays: 1 })
    db.prepare('UPDATE shares SET expires_at=? WHERE id=?').run(past, bothTrashed.id)
    assert.equal((await api('DELETE', '/api/v1/nodes/' + bothSource.id, { token: as })).status, 200)

    const every = await list(as)
    const reported = new Map(every.shares.map((share) => [share.id, share.state]))
    assert.equal(reported.get(active.id), 'active')
    assert.equal(reported.get(expired.id), 'expired')
    assert.equal(reported.get(exhausted.id), 'exhausted')
    assert.equal(reported.get(both.id), 'expired')
    assert.equal(reported.get(trashed.id), 'trashed')
    assert.equal(reported.get(bothTrashed.id), 'trashed')

    // Each state filter answers exactly the rows the list paints with that word.
    for (const state of ['active', 'expired', 'exhausted', 'trashed']) {
      const payload = await list(as, 'state=' + state)
      const expected = every.shares.filter((share) => share.state === state).map((share) => share.id)
      assert.deepEqual(new Set(ids(payload)), new Set(expected), state + ' must match its own word')
      assert.ok(payload.shares.every((share) => share.state === state), state + ' leaked another state')
      assert.ok(payload.shares.every((share) => (share.usable === true) === (state === 'active')))
    }

    // An expired-and-spent link is not in 下载次数用完: two states are exclusive.
    assert.ok(!ids(await list(as, 'state=exhausted')).includes(both.id))
    assert.ok(ids(await list(as, 'state=expired')).includes(both.id))
  })

  it('composes the name and state filters and pages the combination', async () => {
    const as = await newAccount('combined')
    const { db } = await import('../src/db.js')
    const target = await uploadAs(as, '组合 报告.txt', 'bytes')
    const decoy = await uploadAs(as, '组合 附录.txt', 'bytes')

    const wanted = []
    for (let index = 0; index < 4; index += 1) {
      wanted.push(await shareAs(as, target.id, { expiresInDays: 1 }))
    }
    const live = await shareAs(as, target.id)
    const decoyLink = await shareAs(as, decoy.id, { expiresInDays: 1 })
    // Age every expiry the account has: the four wanted rows (and the decoy)
    // become expired, the last target link has no expiry and stays active.
    const past = new Date(Date.now() - 60_000).toISOString()
    db.prepare('UPDATE shares SET expires_at=? WHERE expires_at IS NOT NULL').run(past)

    const combined = await list(as, 'q=' + encodeURIComponent('组合 报告') + '&state=expired')
    assert.deepEqual(new Set(ids(combined)), new Set(wanted.map((share) => share.id)))
    assert.ok(!ids(combined).includes(live.id), 'the live link is not expired')
    assert.ok(!ids(combined).includes(decoyLink.id), 'the decoy name does not match')

    // And the same combination walked one row at a time is the same set.
    const walked = await walk(as, 'q=' + encodeURIComponent('组合 报告') + '&state=expired', 1)
    assert.deepEqual(new Set(walked), new Set(ids(combined)))
    assert.equal(walked.length, combined.shares.length, 'no row is repeated between pages')
  })

  it('never widens past the caller: another account\'s matching rows stay invisible', async () => {
    const mine = await newAccount('mine')
    const theirs = await newAccount('theirs')
    const sharedName = '同名文件.txt'
    const myFile = await uploadAs(mine, sharedName, 'mine')
    const theirFile = await uploadAs(theirs, sharedName, 'theirs')
    const myLink = await shareAs(mine, myFile.id)
    const theirLink = await shareAs(theirs, theirFile.id)

    for (const query of ['q=' + encodeURIComponent('同名'), 'state=active', 'q=' + encodeURIComponent('同名') + '&state=active', '']) {
      const payload = await list(mine, query)
      assert.deepEqual(ids(payload), [myLink.id], query + ' must stay creator-scoped')
      assert.ok(!payload.text.includes(theirLink.token), 'another owner\'s token leaked')
      assert.ok(!payload.text.includes(theirLink.id), 'another owner\'s share id leaked')
    }
    assert.deepEqual(ids(await list(theirs, 'state=active')), [theirLink.id])
  })

  it('validates the state vocabulary, bounds the term and keeps the old paging errors', async () => {
    const as = await newAccount('validation')

    const bad = await api('GET', '/api/v1/shares?state=broken', { token: as })
    assert.equal(bad.status, 400)
    assert.equal(bad.json.error.code, 'INVALID_INPUT')
    const empty = await api('GET', '/api/v1/shares?state=', { token: as })
    assert.equal(empty.status, 200, 'an empty state is 全部状态, not an error')

    // A very long term is bounded, not rejected: the URL still answers a page.
    const long = await list(as, 'q=' + encodeURIComponent('x'.repeat(400)))
    assert.deepEqual(long.shares, [])
    assert.equal(long.hasMore, false)

    // Unrelated bound violations keep their old answers now that filters exist.
    for (const query of ['limit=0', 'limit=101', 'offset=-1', 'offset=abc', 'state=active&limit=0']) {
      const response = await api('GET', '/api/v1/shares?' + query, { token: as })
      assert.equal(response.status, 400, query + ' must still be rejected')
      assert.equal(response.json.error.code, 'INVALID_INPUT')
    }

    const anonymous = await api('GET', '/api/v1/shares?state=active')
    assert.equal(anonymous.status, 401)
  })

  it('reports hasMore about the filtered set, not the whole list', async () => {
    const as = await newAccount('hasmore')
    const match = await uploadAs(as, 'target.txt', 'bytes')
    const other = await uploadAs(as, 'other.txt', 'bytes')
    const matchLinks = []
    for (let index = 0; index < 3; index += 1) matchLinks.push(await shareAs(as, match.id))
    for (let index = 0; index < 20; index += 1) await shareAs(as, other.id)

    const first = await list(as, 'q=target&limit=2&offset=0')
    assert.equal(first.shares.length, 2)
    assert.equal(first.hasMore, true, 'one matching row is still past this page')
    const second = await list(as, 'q=target&limit=2&offset=2')
    assert.equal(second.shares.length, 1)
    assert.equal(second.hasMore, false, 'the unfiltered rows behind it are not "more"')
    // Newest first, so the creation order walks backwards — and the 20
    // unrelated newest links must not appear anywhere in the two pages.
    assert.deepEqual([...first.shares, ...second.shares].map((share) => share.id), matchLinks.map((share) => share.id).reverse())
  })
})
