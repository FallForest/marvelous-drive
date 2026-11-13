import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, before, describe, it } from 'node:test'
import { startServer, uniqueEmail } from './helpers.js'

/**
 * The Docs bridge is gone, and "gone" has to mean gone.
 *
 * Removing a feature is four separate claims, and a test that only checks the
 * HTTP route would miss three of them:
 *
 *   1. no route answers (a half-registered group answers 401, not 404);
 *   2. no query touches the tables, and the boot drops them — an upgraded
 *      database still holds `docs_accounts.token`, a bearer token for another
 *      service that nothing should read any more;
 *   3. no source file imports the client, so a stale reference cannot resurrect
 *      a dead code path at runtime;
 *   4. no node payload advertises a `docsLink` the web client no longer renders.
 *
 * One server per process: `helpers.js` caches the `../src/index.js` module, so a
 * second `startServer()` would await `listening` on an already-closed instance.
 */

const srcRoot = join(import.meta.dirname, '..', 'src')

/** The one module allowed to name the retired tables: the migration that drops them. */
const MIGRATION_OWNER = 'db.js'

/** Every `.js` file under apps/server/src. */
function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(path, out)
    else if (entry.name.endsWith('.js')) out.push(path)
  }
  return out
}

describe('the retired Docs bridge', () => {
  it('leaves no source file importing a Docs client', () => {
    const offenders = []
    for (const file of sourceFiles(srcRoot)) {
      const text = readFileSync(file, 'utf8')
      if (/docs-client|integrations\/docs|registerDocsRoutes/.test(text)) {
        offenders.push(file.replace(srcRoot, 'src'))
      }
    }
    assert.deepEqual(offenders, [])
  })

  it('only the migration names the retired tables', () => {
    const offenders = []
    for (const file of sourceFiles(srcRoot)) {
      if (file.endsWith(MIGRATION_OWNER)) continue
      if (/\bdocs_(?:links|accounts)\b/.test(readFileSync(file, 'utf8'))) {
        offenders.push(file.replace(srcRoot, 'src'))
      }
    }
    assert.deepEqual(offenders, [], 'a module still reads or writes a retired table')
  })
})

let app
let token

before(async () => {
  app = await startServer()
  const registered = await app.client('POST', '/api/v1/auth/register', {
    body: { email: uniqueEmail(), password: 'retired bridge password' },
  })
  token = registered.json.token
})

after(async () => {
  await app.close()
  app.cleanup()
})

describe('the retired Docs bridge, through the API', () => {
  it('drops the leftover tables, and the token with them', async () => {
    // A database written by the version that still had the bridge. It is created
    // behind the running server's back, then the migration is applied to the same
    // file — the upgrade path a real deployment takes on its next boot.
    const { dropRetiredTables } = await import('../src/db.js')
    const dbPath = join(app.dataDir, 'drive.db')
    const seed = new DatabaseSync(dbPath)
    seed.exec(`
      CREATE TABLE docs_accounts (user_id TEXT PRIMARY KEY, server_url TEXT, email TEXT, token TEXT, updated_at TEXT);
      CREATE TABLE docs_links (id TEXT PRIMARY KEY, node_id TEXT, user_id TEXT, document_id TEXT);
      INSERT INTO docs_accounts VALUES ('u1', 'http://docs:3000', 'ada@example.com', 'secret-bearer-token', '2026-01-01');
    `)
    seed.close()

    const dropped = dropRetiredTables()
    assert.deepEqual(dropped.sort(), ['docs_accounts', 'docs_links'])

    const after = new DatabaseSync(dbPath)
    const remaining = after
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'docs_%'")
      .all()
      .map((row) => row.name)
    after.close()
    assert.deepEqual(remaining, [], 'both tables are gone, and with them the stored token')

    // Idempotent: a second boot on a clean database changes nothing and says so.
    assert.deepEqual(dropRetiredTables(), [])
  })

  it('answers 404 for every retired route, even with a valid token', async () => {
    const routes = [
      ['GET', '/api/v1/integrations/docs/status'],
      ['POST', '/api/v1/integrations/docs/login'],
      ['DELETE', '/api/v1/integrations/docs/login'],
      ['GET', '/api/v1/integrations/docs/documents'],
      ['POST', '/api/v1/integrations/docs/import'],
      ['POST', '/api/v1/integrations/docs/push'],
      ['GET', '/api/v1/integrations/docs/links'],
      ['POST', '/api/v1/integrations/docs/links/abc/refresh'],
      ['DELETE', '/api/v1/integrations/docs/links/abc'],
    ]
    for (const [method, path] of routes) {
      const response = await app.client(method, path, { token, body: method === 'GET' ? undefined : {} })
      assert.equal(response.status, 404, method + ' ' + path + ' answered ' + response.status)
      assert.equal(response.json.error.code, 'NOT_FOUND', method + ' ' + path)
    }
  })

  it('no longer advertises docsLink on a node', async () => {
    const uploaded = await app.client('PUT', '/api/v1/uploads?name=plain.md', {
      token, raw: true, body: '# plain', headers: { 'content-type': 'text/markdown' },
    })
    assert.equal(uploaded.status, 201, uploaded.text)
    const node = uploaded.json.node
    assert.equal('docsLink' in node, false, 'the field was removed with the bridge: ' + JSON.stringify(node))

    const detail = await app.client('GET', '/api/v1/nodes/' + node.id, { token })
    assert.equal(detail.status, 200)
    assert.equal('docsLink' in detail.json.node, false)
  })
})
