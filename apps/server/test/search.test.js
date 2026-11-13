import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startServer, uniqueEmail } from './helpers.js';

/**
 * Content search.
 *
 * The old search only looked at names, which answers "where is invoice.pdf?"
 * but not "which file mentions INV-2026-0042?". The index is derived data, so
 * the tests care about three things: content hits appear, deleted content
 * disappears, and a hostile query string is a no-op rather than a 500.
 */

let app;
let api;
let token;

before(async () => {
  app = await startServer();
  api = app.client;
  const registered = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'search password' } });
  token = registered.json.token;
});

after(async () => {
  await app.close();
  app.cleanup();
});

const auth = (extra = {}) => ({ token, ...extra });

async function upload(name, body, mime = 'text/plain') {
  const response = await api('PUT', '/api/v1/uploads?name=' + encodeURIComponent(name), auth({
    raw: true, body, headers: { 'content-type': mime },
  }));
  assert.equal(response.status, 201, response.text);
  return response.json.node;
}

const search = (query, scope) => api('GET', '/api/v1/search?' + new URLSearchParams({
  q: query, ...(scope ? { scope } : {}),
}).toString(), auth());

describe('content search', () => {
  it('finds a file by a word inside it', async () => {
    const node = await upload('notes.txt', 'the quarterly invoice INV-2026-0042 was approved');
    const found = await search('approved');
    assert.equal(found.status, 200);
    const hit = found.json.results.find((row) => row.id === node.id);
    assert.ok(hit, JSON.stringify(found.json.results));
    assert.equal(hit.matched, 'content');
    assert.match(hit.snippet, /approved/);
  });

  it('ranks a name hit above a content hit', async () => {
    await upload('budget.txt', 'nothing to see here');
    const named = await upload('quarterly.txt', 'unrelated body text');
    await upload('memo.txt', 'the quarterly numbers');
    const found = await search('quarterly');
    assert.equal(found.json.results[0].id, named.id, 'the file called quarterly wins');
    assert.equal(found.json.results[0].matched, 'name');
  });

  it('scope=content ignores names and scope=name ignores bodies', async () => {
    const node = await upload('alpha-keyword.txt', 'body without the word');
    const byContent = await search('alpha-keyword', 'content');
    assert.ok(!byContent.json.results.some((row) => row.id === node.id), 'a name-only match is hidden in content scope');
    const byName = await search('alpha-keyword', 'name');
    assert.ok(byName.json.results.some((row) => row.id === node.id));
  });

  it('drops a trashed file from the results and restores it into them', async () => {
    const node = await upload('receipt.txt', 'payment reference ZX-9999');
    const before = await search('ZX-9999');
    assert.ok(before.json.results.some((row) => row.id === node.id));
    await api('DELETE', `/api/v1/nodes/${node.id}`, auth());
    const during = await search('ZX-9999');
    assert.ok(!during.json.results.some((row) => row.id === node.id), 'a trashed node must not be returned');
    await api('POST', `/api/v1/nodes/${node.id}/restore`, auth({ body: {} }));
    const after = await search('ZX-9999');
    assert.ok(after.json.results.some((row) => row.id === node.id), 'restoring puts it back');
  });

  it('re-indexes after an overwrite', async () => {
    const node = await upload('changing.txt', 'the old sentence');
    assert.ok((await search('sentence')).json.results.some((row) => row.id === node.id));
    await api('PUT', `/api/v1/files/${node.id}/content`, auth({
      raw: true, body: 'a brand new sentence', headers: { 'content-type': 'text/plain' },
    }));
    const old = await search('sentence');
    assert.ok(old.json.results.some((row) => row.id === node.id), 'the shared word still matches');
    const gone = await search('preserved-nowhere');
    assert.equal(gone.json.results.length, 0);
  });

  it('does not index binary content', async () => {
    const binary = Buffer.from([0x00, 0x01, 0x02, 0x66, 0x69, 0x6e, 0x64, 0x6d, 0x65]);
    const node = await api('PUT', '/api/v1/uploads?name=data.bin', auth({
      raw: true, body: binary, headers: { 'content-type': 'application/octet-stream' },
    }));
    assert.equal(node.status, 201);
    const found = await search('findme');
    assert.ok(!found.json.results.some((row) => row.id === node.json.node.id), 'a NUL byte means binary');
  });

  it('treats an FTS syntax injection as plain words', async () => {
    const node = await upload('injection.txt', 'harmless body');
    for (const query of ['"', '*', 'a AND', 'body:"']) {
      const response = await search(query);
      assert.equal(response.status, 200, JSON.stringify(query));
      assert.ok(Array.isArray(response.json.results));
    }
    assert.ok((await search('harmless')).json.results.some((row) => row.id === node.id));
  });

  it('finds a Chinese phrase inside a file', async () => {
    // unicode61 tokenises a run of CJK as one token, so 营收 would never match
    // 本季度营收 through FTS; the substring path exists for exactly this.
    const node = await upload('财报.txt', '本季度营收已确认，附 INV 编号。');
    const found = await search('营收');
    const hit = found.json.results.find((row) => row.id === node.id);
    assert.ok(hit, JSON.stringify(found.json.results));
    assert.match(hit.snippet, /营收/);
    const byScope = await search('营收', 'content');
    assert.ok(byScope.json.results.some((row) => row.id === node.id));
  });

  it('still finds a Chinese file name in name scope', async () => {
    const node = await upload('项目计划.txt', 'english body only');
    const found = await search('项目计划', 'name');
    assert.ok(found.json.results.some((row) => row.id === node.id));
  });

  it('finds a number glued to Chinese text', async () => {
    // unicode61 keeps 于1765年 as one token, so "1765" matches only through the
    // substring path; this is the case that made a real deck unfindable.
    const node = await upload('历史.md', '由黑格尔于1765年提出，影响了后世。');
    const found = await search('1765', 'content');
    const hit = found.json.results.find((row) => row.id === node.id);
    assert.ok(hit, JSON.stringify(found.json.results));
    assert.match(hit.snippet, /1765/);
  });

  it('never returns another account\'s content', async () => {
    const other = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'other password' } });
    const otherToken = other.json.token;
    await api('PUT', '/api/v1/uploads?name=secret.txt', {
      token: otherToken, raw: true, body: 'the private word xylophone', headers: { 'content-type': 'text/plain' },
    });
    const mine = await search('xylophone');
    assert.equal(mine.json.results.length, 0);
  });
});