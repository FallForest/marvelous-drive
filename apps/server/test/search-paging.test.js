import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startServer, uniqueEmail } from './helpers.js';

/**
 * Search paging (UI10).
 *
 * The old endpoint applied a fixed LIMIT and returned the array alone: a client
 * asking for 50 hits could not tell "that is all of them" from "that is the
 * first page", which is how a search page silently showed half a result set.
 *
 * Two rules are asserted here and nowhere else:
 *   - `hasMore` is derived from a fetch one row wider than the window, so it
 *     means "there is at least one more hit", never a total;
 *   - `offset` walks that window without repeating or dropping a row.
 */

let app;
let api;
let token;

before(async () => {
  app = await startServer();
  api = app.client;
  const registered = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'paging password' } });
  token = registered.json.token;
});

after(async () => {
  await app.close();
  app.cleanup();
});

const auth = (extra = {}) => ({ token, ...extra });

/**
 * 55 files sharing one searchable name prefix: one page of 50 plus 5, so the
 * window boundary is exact. The names differ on purpose — two uploads with the
 * same name in one folder are an overwrite, which would leave a single node.
 */
async function seed() {
  for (let index = 0; index < 55; index += 1) {
    const name = 'paging-report-' + String(index).padStart(3, '0') + '.txt';
    const response = await api('PUT', '/api/v1/uploads?name=' + encodeURIComponent(name), auth({
      raw: true, body: 'page filler ' + index, headers: { 'content-type': 'text/plain' },
    }));
    assert.equal(response.status, 201, response.text);
  }
}

const search = (params) => api('GET', '/api/v1/search?' + new URLSearchParams(params).toString(), auth());

describe('search paging', () => {
  it('reports hasMore and a windowed page instead of truncating silently', async () => {
    await seed();

    const first = await search({ q: 'paging-report-', scope: 'name', limit: 50 });
    assert.equal(first.status, 200, first.text);
    assert.equal(first.json.results.length, 50);
    assert.equal(first.json.limit, 50);
    assert.equal(first.json.offset, 0);
    assert.equal(first.json.hasMore, true, '55 hits must not look like 50');
    // No invented total: the client is told about the window, not the corpus.
    assert.equal(first.json.total, undefined);

    const second = await search({ q: 'paging-report-', scope: 'name', limit: 50, offset: 50 });
    assert.equal(second.status, 200, second.text);
    assert.equal(second.json.results.length, 5);
    assert.equal(second.json.offset, 50);
    assert.equal(second.json.hasMore, false, 'the last page must say so');

    const firstIds = new Set(first.json.results.map((row) => row.id));
    assert.equal(second.json.results.filter((row) => firstIds.has(row.id)).length, 0, 'pages must not overlap');
    assert.equal(new Set([...firstIds, ...second.json.results.map((row) => row.id)]).size, 55);
  });

  it('keeps the default window small and honest', async () => {
    const page = await search({ q: 'paging-report-', scope: 'name' });
    assert.equal(page.json.results.length, 20);
    assert.equal(page.json.limit, 20);
    assert.equal(page.json.hasMore, true);
  });

  it('says hasMore=false for a result set that fits', async () => {
    const page = await search({ q: 'paging-report-', scope: 'name', limit: 55 });
    assert.equal(page.json.results.length, 55);
    assert.equal(page.json.hasMore, false);
  });

  it('clamps a hostile offset instead of returning someone else\'s window', async () => {
    const negative = await search({ q: 'paging-report-', scope: 'name', limit: 5, offset: -20 });
    assert.equal(negative.status, 200);
    assert.equal(negative.json.offset, 0);
    assert.equal(negative.json.results.length, 5);

    const huge = await search({ q: 'paging-report-', scope: 'name', limit: 5, offset: 999999 });
    assert.equal(huge.status, 200);
    assert.equal(huge.json.offset, 1000, 'offset is capped, not passed through');
    assert.equal(huge.json.results.length, 0);
    assert.equal(huge.json.hasMore, false);
  });

  it('answers an empty query with the same envelope', async () => {
    const empty = await search({ q: '   ' });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json.results, []);
    assert.equal(empty.json.hasMore, false);
    assert.equal(empty.json.offset, 0);
  });

  it('pages the same 55 hits through the content index too', async () => {
    // Same fixture, different half: `scope=content` must paginate by its own
    // window, not fall back to a name-shaped cutoff.
    const first = await search({ q: 'page filler', scope: 'content', limit: 50 });
    assert.equal(first.status, 200, first.text);
    assert.equal(first.json.results.length, 50);
    assert.equal(first.json.offset, 0);
    assert.equal(first.json.hasMore, true, '55 content hits must not look like 50');

    const second = await search({ q: 'page filler', scope: 'content', limit: 50, offset: 50 });
    assert.equal(second.status, 200, second.text);
    assert.equal(second.json.results.length, 5);
    assert.equal(second.json.offset, 50);
    assert.equal(second.json.hasMore, false, 'the last content page must say so');

    const firstIds = new Set(first.json.results.map((row) => row.id));
    assert.equal(second.json.results.filter((row) => firstIds.has(row.id)).length, 0, 'content pages must not overlap');
    assert.equal(new Set([...firstIds, ...second.json.results.map((row) => row.id)]).size, 55);
  });

  it('combines folder scope, kind and updatedAfter without leaking descendants elsewhere', async () => {
    const folder = await api('POST', '/api/v1/nodes', auth({ body: { name: 'marigold-target', kind: 'folder' } }));
    assert.equal(folder.status, 201, folder.text);
    const folderId = folder.json.node.id;

    const nested = await api('POST', '/api/v1/nodes', auth({ body: { name: 'nested', kind: 'folder', parentId: folderId } }));
    assert.equal(nested.status, 201, nested.text);
    const nestedId = nested.json.node.id;

    const upload = async (name, body, parentId) => {
      const response = await api('PUT', '/api/v1/uploads?name=' + encodeURIComponent(name)
        + (parentId ? '&parentId=' + parentId : ''), auth({
        raw: true, body, headers: { 'content-type': 'text/plain' },
      }));
      assert.equal(response.status, 201, response.text);
      return response.json.node;
    };

    const inside = await upload('inside.txt', 'marigold in the target', nestedId);
    // Same keyword, outside the scoped folder: these prove the folder filter is
    // doing the excluding rather than the keyword being unique.
    const rootDecoy = await upload('root-decoy.txt', 'marigold at the root', null);
    const sibling = await api('POST', '/api/v1/nodes', auth({ body: { name: 'marigold-other', kind: 'folder' } }));
    const siblingDecoy = await upload('sibling-decoy.txt', 'marigold next door', sibling.json.node.id);
    // A FOLDER whose name carries the keyword AND ends in .txt. It passes the
    // name LIKE and the kind=document extension test, so only a `n.kind='file'`
    // gate stops a directory answering a document question.
    const fakeFile = await api('POST', '/api/v1/nodes', auth({ body: { name: 'marigold-notes.txt', kind: 'folder', parentId: nestedId } }));
    assert.equal(fakeFile.status, 201, fakeFile.text);

    const scoped = { q: 'marigold', folderId, kind: 'document', limit: 50 };
    const found = await search(scoped);
    assert.equal(found.status, 200, found.text);
    assert.deepEqual(found.json.results.map((row) => row.id), [inside.id],
      'only documents under the folder, not the sibling/root/folder-name matches');
    assert.equal(found.json.results[0].kind, 'file');
    assert.equal(found.json.hasMore, false);

    // The decoys are reachable without the filters; the folder filter and the
    // kind gate are what exclude them from the scoped answer.
    const unscoped = await search({ q: 'marigold', limit: 50 });
    const unscopedIds = unscoped.json.results.map((row) => row.id);
    for (const decoy of [rootDecoy, siblingDecoy, fakeFile.json.node]) {
      assert.ok(unscopedIds.includes(decoy.id), 'decoy ' + decoy.name + ' should be findable unfiltered');
    }

    // updatedAfter is inclusive of a timestamp before the fixture was written.
    const since = new Date(Date.now() - 60_000).toISOString();
    const recent = await search({ ...scoped, updatedAfter: since });
    assert.equal(recent.status, 200, recent.text);
    assert.deepEqual(recent.json.results.map((row) => row.id), [inside.id]);

    // A future cutoff excludes everything, including the target document.
    const future = await search({ ...scoped, updatedAfter: '2099-01-01T00:00:00.000Z' });
    assert.equal(future.status, 200, future.text);
    assert.deepEqual(future.json.results, []);
    assert.equal(future.json.hasMore, false);
  });
});
