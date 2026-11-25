import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { startServer, uniqueEmail } from './helpers.js'
import { readZip } from '../src/text/zip-read.js'

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

  it('streams progress, then serves the finished archive as readable bytes', async () => {
    const source = '你好，archive\n第二行 ✓';
    const fixture = await folder('progress-fixture');
    const nested = await folder('nested', fixture.id);
    await file('说明.txt', source, nested.id);
    // A zero-byte node has no blob: the writer must still emit an entry for it.
    const empty = await api('POST', '/api/v1/nodes', auth({ body: { name: 'zero.txt', parentId: fixture.id } }));
    assert.equal(empty.status, 201, empty.text);

    const stream = await fetch(`http://127.0.0.1:${app.port}/api/v1/nodes/${fixture.id}/archive?progress=1`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type'), /^text\/event-stream/);

    const frames = (await stream.text())
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice('data: '.length)));
    assert.ok(frames.length >= 2, 'expected progress and complete frames');
    assert.ok(!frames.some((frame) => frame.type === 'error'), JSON.stringify(frames));

    // The first report happens before any payload is copied, so it is real
    // progress rather than a synthetic 0..100 animation.
    const first = frames[0];
    assert.equal(first.type, 'progress', JSON.stringify(first));
    assert.equal(first.bytesCompleted, 0);
    assert.equal(first.bytesTotal, Buffer.byteLength(source, 'utf8'));

    const complete = frames.at(-1);
    assert.equal(complete.type, 'complete', JSON.stringify(complete));
    assert.ok(complete.node.id, 'the complete frame names the created archive node');

    const download = await fetch(`http://127.0.0.1:${app.port}/api/v1/files/${complete.node.id}/content`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(download.status, 200);
    const zip = readZip(Buffer.from(await download.arrayBuffer()));

    const nestedSource = zip.get('progress-fixture/nested/说明.txt');
    assert.ok(nestedSource, 'the nested UTF-8 file is present');
    assert.equal(nestedSource.toString('utf8'), source);

    const zero = zip.get('progress-fixture/zero.txt');
    assert.ok(zero, 'the zero-byte file has an entry');
    assert.equal(zero.length, 0);

    // readZip exposes directory records too; both folders must be navigable.
    for (const directory of ['progress-fixture/', 'progress-fixture/nested/']) {
      assert.ok(zip.has(directory), directory + ' is listed');
      assert.equal(zip.get(directory).length, 0);
    }
  });

  /**
   * `?temporary=1` must not change the legacy contract: without `?progress=1`
   * the same POST still answers `201 {node}` in JSON. The difference is where
   * the bytes live — a download-registry carrier, not a node in the tree.
   */
  it('serves a temporary archive without putting it in the tree', async () => {
    const source = '临时压缩包 ✓';
    const fixture = await folder('temporary-fixture');
    await file('note.txt', source, fixture.id);

    const created = await api('POST', '/api/v1/nodes/archive?temporary=1', auth({ body: { ids: [fixture.id] } }));
    assert.equal(created.status, 201, created.text);
    assert.match(created.headers.get('content-type'), /^application\/json/, 'temporary alone must keep the legacy JSON answer');
    const carrier = created.json.node;
    assert.equal(carrier.temporary, true);
    assert.equal(carrier.name, 'temporary-fixture.zip');
    assert.equal(carrier.mime, 'application/zip');
    const expiresAt = Date.parse(carrier.expiresAt);
    assert.ok(Number.isFinite(expiresAt) && expiresAt > Date.now(), 'the carrier expires on its own');

    // The id names a download, not a node: it is neither addressable nor listed.
    const asNode = await api('GET', `/api/v1/nodes/${carrier.id}`, auth());
    assert.equal(asNode.status, 404, 'a temporary archive must not be addressable as a node');

    // Another fresh account can neither read nor release it. Both answers are
    // the same no-op an unknown id gets, so the id cannot be probed.
    const strangerToken = (await api('POST', '/api/v1/auth/register', {
      body: { email: uniqueEmail(), password: 'temporary stranger' },
    })).json.token;
    const stolen = await api('GET', `/api/v1/archive-downloads/${carrier.id}`, { token: strangerToken });
    assert.equal(stolen.status, 404);
    const stolenRelease = await api('DELETE', `/api/v1/archive-downloads/${carrier.id}`, { token: strangerToken });
    assert.equal(stolenRelease.status, 200);
    assert.deepEqual(stolenRelease.json, { ok: true });

    // The stranger's release was a no-op, so the owner still reads real bytes.
    const download = await fetch(`http://127.0.0.1:${app.port}/api/v1/archive-downloads/${carrier.id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-type'), /^application\/zip/);
    const bytes = Buffer.from(await download.arrayBuffer());
    assert.equal(bytes.length, carrier.size);
    const zip = readZip(bytes);
    assert.ok(zip.has('temporary-fixture/'), 'the folder entry is inside the archive');
    assert.equal(zip.get('temporary-fixture/note.txt')?.toString('utf8'), source);

    // Owner release is idempotent, and a released carrier is gone for good.
    for (const attempt of [1, 2]) {
      const released = await api('DELETE', `/api/v1/archive-downloads/${carrier.id}`, auth());
      assert.equal(released.status, 200, 'release attempt ' + attempt + ': ' + released.text);
      assert.deepEqual(released.json, { ok: true });
    }
    const gone = await api('GET', `/api/v1/archive-downloads/${carrier.id}`, auth());
    assert.equal(gone.status, 404);

    // It was never a node, so the trash cannot have gained it.
    const trash = await api('GET', '/api/v1/nodes?trash=1', auth());
    assert.equal(trash.status, 200);
    assert.ok(!trash.json.nodes.some((node) => node.id === carrier.id), 'the temporary archive never appears in the trash');
  });
});
