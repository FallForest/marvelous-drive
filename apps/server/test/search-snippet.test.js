import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { startServer, uniqueEmail } from './helpers.js'

/**
 * The `snippet()` trap, tested directly.
 *
 * FTS5's `snippet()` and `highlight()` take a **column index**. Passing a column
 * name as a string does not raise: it silently resolves to column 0, so every
 * content hit renders a UUID instead of the sentence that matched. That class of
 * bug — wrong output, no error — is exactly what a green test suite must catch,
 * so this file pins both halves:
 *
 *   - the trap still exists in the SQLite build we ship on (if it ever stops
 *     being silent, this test tells us the guard can be relaxed);
 *   - our schema order and `BODY_COLUMN` agree with each other, and a snippet
 *     produced through the real query contains the matching words, not an id.
 */

describe('FTS5 snippet column addressing', () => {
  const build = () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE VIRTUAL TABLE t USING fts5(
      node_id UNINDEXED, user_id UNINDEXED, workspace_id UNINDEXED, name, body,
      tokenize = 'unicode61 remove_diacritics 2')`)
    db.prepare('INSERT INTO t(node_id,user_id,workspace_id,name,body) VALUES (?,?,?,?,?)')
      .run('9f2c1b7e-0000-4000-8000-abcdef123456', 'user-1', 'ws-1', 'invoice.pdf',
        'the quarterly invoice INV-2026-0042 was approved by finance')
    return db
  }

  it('a column NAME silently returns column 0 while a column INDEX works', () => {
    const db = build()
    const query = 'body:"approved"*'
    const byIndex = db.prepare(`SELECT snippet(t, 4, '[', ']', '…', 14) AS s FROM t WHERE t MATCH ?`).get(query).s
    const byName = db.prepare(`SELECT snippet(t, 'body', '[', ']', '…', 14) AS s FROM t WHERE t MATCH ?`).get(query).s
    db.close()

    assert.match(byIndex, /\[approved\]/, 'the numeric column index finds the sentence')
    assert.match(byName, /^[0-9a-f-]{36}$/, 'the string column name returns the node id — the silent failure we guard against')
    assert.doesNotMatch(byName, /approved/, 'the string form never reaches the body')
  })

  it('an out-of-range index does throw, so only the name form is silent', () => {
    const db = build()
    assert.throws(() => db.prepare(`SELECT snippet(t, 9, '[', ']', '…', 14) FROM t WHERE t MATCH ?`).get('body:"approved"*'))
    db.close()
  })

  it('the schema order the code assumes is the order the database creates', async () => {
    const { SEARCH_COLUMNS, SEARCH_INDEX_DDL, searchColumn } = await import('../src/db.js')
    // The DDL is the single source of truth; the column list must produce it.
    assert.equal(SEARCH_COLUMNS.join(','), 'node_id,user_id,workspace_id,name,body')
    assert.match(SEARCH_INDEX_DDL, /name,\s*body,/)
    assert.equal(searchColumn('body'), 4)
    assert.equal(searchColumn('node_id'), 0)
    assert.throws(() => searchColumn('nope'), /unknown search index column/)

    // And a table built from that DDL reports exactly those columns.
    const db = new DatabaseSync(':memory:')
    db.exec(SEARCH_INDEX_DDL)
    const created = db.prepare('PRAGMA table_info(node_text)').all().map((row) => row.name)
    db.close()
    assert.deepEqual(created, [...SEARCH_COLUMNS], 'DDL and SEARCH_COLUMNS disagree; snippet() would drift')
  })
})

/* ── through the API: a snippet must contain the matched words ───────── */

let app
let api
let token

before(async () => {
  app = await startServer()
  api = app.client
  const registered = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'snippet password' } })
  token = registered.json.token
})

after(async () => {
  await app.close()
  app.cleanup()
})

const auth = (extra = {}) => ({ token, ...extra })

async function upload(name, body, mime = 'text/plain') {
  const response = await api('PUT', '/api/v1/uploads?name=' + encodeURIComponent(name), auth({
    raw: true, body, headers: { 'content-type': mime },
  }))
  assert.equal(response.status, 201, response.text)
  return response.json.node
}

describe('snippets in search results', () => {
  it('returns the matching sentence, never the node id', async () => {
    const node = await upload('memo.txt', 'the quarterly invoice INV-2026-0042 was approved by finance')
    const found = await api('GET', '/api/v1/search?q=approved&scope=content', auth())
    const hit = found.json.results.find((row) => row.id === node.id)
    assert.ok(hit, JSON.stringify(found.json.results))
    assert.match(hit.snippet, /approved/)
    assert.doesNotMatch(hit.snippet, /[0-9a-f]{8}-[0-9a-f]{4}-/, 'a snippet made of the uuid means snippet() read column 0')
    assert.ok(hit.snippet.length <= 120, 'a snippet is a sentence, not the file: ' + hit.snippet)
  })

  it('keeps the FTS control characters out of the JSON', async () => {
    const node = await upload('marks.txt', 'highlight the word xylophone here')
    const found = await api('GET', '/api/v1/search?q=xylophone&scope=content', auth())
    const hit = found.json.results.find((row) => row.id === node.id)
    assert.ok(hit)
    assert.doesNotMatch(hit.snippet, /[\u0001\u0002]/, 'the route strips the snippet delimiters; markup never travels in JSON')
  })

  it('a name-only match carries no snippet at all', async () => {
    const node = await upload('budget-plan.txt', 'unrelated body')
    const found = await api('GET', '/api/v1/search?q=budget-plan&scope=name', auth())
    const hit = found.json.results.find((row) => row.id === node.id)
    assert.ok(hit)
    assert.equal(hit.snippet, null)
    assert.equal(hit.matched, 'name')
  })

  it('does not leak another account\'s snippet', async () => {
    const other = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'other snippet' } })
    await api('PUT', '/api/v1/uploads?name=theirs.txt', {
      token: other.json.token, raw: true, body: 'the private word marimba', headers: { 'content-type': 'text/plain' },
    })
    const mine = await api('GET', '/api/v1/search?q=marimba&scope=content', auth())
    assert.equal(mine.json.results.length, 0)
  })
})
