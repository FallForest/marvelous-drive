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
});
