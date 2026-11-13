import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { startServer, uniqueEmail } from './helpers.js'

/**
 * Archiving a selection.
 *
 * The point of the route is that a user can pick five things from three
 * different folders and get one zip that preserves each one's own name.
 */

let app
let api
let token

before(async () => {
  app = await startServer();
  api = app.client;
  const registered = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'archive password' } });
  token = registered.json.token;
});

after(async () => {
  await app.close();
  app.cleanup();
});

const auth = (extra = {}) => ({ token, ...extra });

async function folder(name, parentId) {
  const response = await api('POST', '/api/v1/nodes', auth({ body: { name, kind: 'folder', parentId } }));
  assert.equal(response.status, 201, response.text);
  return response.json.node;
}

async function file(name, body, parentId) {
  const query = '/api/v1/uploads?name=' + encodeURIComponent(name) + (parentId ? '&parentId=' + parentId : '');
  const response = await api('PUT', query, auth({ raw: true, body, headers: { 'content-type': 'text/plain' } }));
  assert.equal(response.status, 201, response.text);
  return response.json.node;
}

describe('selection archive', () => {
  it('zips files and folders picked from different places', async () => {
    const alpha = await folder('alpha');
    const deep = await folder('deep', alpha.id);
    const nested = await file('inside.txt', 'nested bytes', deep.id);
    const loose = await file('loose.txt', 'loose bytes');
    // Same name, different parent: legal, and the route still has to disambiguate
    // the two folders inside one archive.
    const holder = await folder('holder');
    const second = await folder('alpha', holder.id);

    const response = await api('POST', '/api/v1/nodes/archive', auth({ body: { ids: [alpha.id, loose.id, second.id] } }));
    assert.equal(response.status, 201, response.text);
    assert.match(response.json.node.name, /^selection-3-items\.zip$/);
    assert.equal(response.json.node.mime, 'application/zip');

    const content = await api('GET', `/api/v1/files/${response.json.node.id}/content`, auth());
    const bytes = Buffer.from(content.text, 'binary');
    assert.equal(bytes.subarray(0, 2).toString(), 'PK');
    const names = bytes.toString('binary');
    assert.match(names, /alpha\/inside\.txt|alpha\/deep\/inside\.txt/, 'the nested file keeps its path');
    assert.match(names, /loose\.txt/, 'the loose file is at the top level');
    assert.match(names, /alpha \(1\)/, 'two folders with the same name are disambiguated');
    // Referenced nodes are untouched.
    const still = await api('GET', `/api/v1/nodes/${nested.id}`, auth());
    assert.equal(still.status, 200);
  });

  it('names a single selected folder after itself', async () => {
    const solo = await folder('solo');
    await file('a.txt', 'a', solo.id);
    const response = await api('POST', '/api/v1/nodes/archive', auth({ body: { ids: [solo.id] } }));
    assert.equal(response.status, 201);
    assert.equal(response.json.node.name, 'solo.zip');
  });

  it('rejects an empty selection, an oversized one, and unknown ids', async () => {
    const empty = await api('POST', '/api/v1/nodes/archive', auth({ body: { ids: [] } }));
    assert.equal(empty.status, 400);
    const tooMany = await api('POST', '/api/v1/nodes/archive', auth({ body: { ids: Array.from({ length: 201 }, (_, index) => 'id-' + index) } }));
    assert.equal(tooMany.status, 400);
    const unknown = await api('POST', '/api/v1/nodes/archive', auth({ body: { ids: ['00000000-0000-0000-0000-000000000000'] } }));
    assert.equal(unknown.status, 404);
  });

  it('skips trashed nodes in the selection', async () => {
    const live = await file('keep.txt', 'keep');
    const trashed = await file('drop.txt', 'drop');
    await api('DELETE', `/api/v1/nodes/${trashed.id}`, auth());
    const response = await api('POST', '/api/v1/nodes/archive', auth({ body: { ids: [live.id, trashed.id] } }));
    assert.equal(response.status, 201);
    const content = await api('GET', `/api/v1/files/${response.json.node.id}/content`, auth());
    assert.match(content.text, /keep\.txt/);
    assert.ok(!/drop\.txt/.test(content.text), 'a trashed node must not sneak into the archive');
  });
});