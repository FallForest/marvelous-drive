import assert from 'node:assert/strict';
import { it } from 'node:test';
import { clearToken, fetchBlob, getToken, onUnauthorized, setToken } from '../lib/api.js';

it('a public share password failure preserves an unrelated drive login', async () => {
  const originalFetch = globalThis.fetch;
  let signOuts = 0;
  const unsubscribe = onUnauthorized(() => { signOuts += 1; });
  setToken('existing-drive-session');
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, '/api/v1/shared/locked/preview');
      assert.equal(options.headers.get('Authorization'), null);
      return new Response(JSON.stringify({ error: { code: 'SHARE_LOCKED', message: 'Password required.' } }),
        { status: 401, headers: { 'content-type': 'application/json' } });
    };
    await assert.rejects(fetchBlob('/shared/locked/preview', { auth: false }), { status: 401, code: 'SHARE_LOCKED' });
    assert.equal(getToken(), 'existing-drive-session');
    assert.equal(signOuts, 0);
  } finally {
    globalThis.fetch = originalFetch;
    unsubscribe();
    clearToken();
  }
});

it('authenticated blob requests still attach the session and expire it on 401', async () => {
  const originalFetch = globalThis.fetch;
  setToken('expired-drive-session');
  try {
    globalThis.fetch = async (_url, options) => {
      assert.equal(options.headers.get('Authorization'), 'Bearer expired-drive-session');
      return new Response('{}', { status: 401 });
    };
    await assert.rejects(fetchBlob('/files/secret/content'), { status: 401 });
    assert.equal(getToken(), '');
  } finally {
    globalThis.fetch = originalFetch;
    clearToken();
  }
});
