import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { startServer, uniqueEmail } from './helpers.js'

/**
 * Router order regression.
 *
 * The router resolves in registration order, so a literal path that shares a
 * shape with a parameterised sibling (`/nodes/archive` vs `/nodes/:id`) is only
 * reachable if the literal one is registered first. This happened for real:
 * `POST /nodes/archive` answered 405 until the route moved above `/nodes/:id`.
 *
 * Each case below is a literal path that must not be swallowed by a capture.
 */

let app
let api
let token

before(async () => {
  app = await startServer();
  api = app.client;
  const registered = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'routing password' } });
  token = registered.json.token;
});

after(async () => {
  await app.close();
  app.cleanup();
});

const auth = (extra = {}) => ({ token, ...extra });

describe('literal paths win over captures', () => {
  it('POST /nodes/archive reaches the archive handler', async () => {
    const file = await api('PUT', '/api/v1/uploads?name=route.txt', auth({
      raw: true, body: 'route bytes', headers: { 'content-type': 'text/plain' },
    }));
    assert.equal(file.status, 201, file.text);
    const response = await api('POST', '/api/v1/nodes/archive', auth({ body: { ids: [file.json.node.id] } }));
    assert.notEqual(response.status, 405, 'the literal route must be registered before /nodes/:id');
    assert.equal(response.status, 201, response.text);
    assert.match(response.json.node.name, /\.zip$/);
  });

  it('GET /nodes/archive does not reach the archive handler', async () => {
    const response = await api('GET', '/api/v1/nodes/archive', auth());
    // The literal route is POST-only, so GET falls through to /nodes/:id and
    // "archive" is not a UUID: a 404, never a 200 and never a crash. This is the
    // documented consequence of resolving in registration order.
    assert.equal(response.status, 404);
    assert.equal(response.json.error.code, 'NOT_FOUND');
  });

  it('a real node id still resolves through the capture', async () => {
    const file = await api('PUT', '/api/v1/uploads?name=capture.txt', auth({
      raw: true, body: 'capture', headers: { 'content-type': 'text/plain' },
    }));
    const single = await api('GET', `/api/v1/nodes/${file.json.node.id}`, auth());
    assert.equal(single.status, 200);
    assert.equal(single.json.node.name, 'capture.txt');
  });

  it('every registered literal path answers something other than 405', async () => {
    const { router } = await import('../src/index.js');
    const literals = router.routes
      .filter((route) => route.method === 'POST' && !route.regex.source.includes('([^/]+)'))
    const probed = [];
    for (const route of literals) {
      const path = route.regex.source.replace(/^\^/, '').replace(/\/?\$$/, '').replace(/\\/g, '');
      if (!path.startsWith('/api/')) continue;
      const response = await api('POST', path, auth({ body: {} }));
      probed.push(path + ' -> ' + response.status);
      assert.notEqual(response.status, 405, path + ' is shadowed by a capture route: ' + JSON.stringify(probed));
    }
    assert.ok(probed.length > 0, 'there must be literal POST routes to probe');
  });
});
