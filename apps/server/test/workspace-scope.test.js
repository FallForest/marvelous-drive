import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startServer, uniqueEmail } from './helpers.js';

/**
 * Workspace-scoped listing.
 *
 * The personal listing must stay exactly what it was; `?workspace=` widens it to
 * every member's nodes. Getting the default wrong would either leak other
 * people's files or hide the user's own — both are regressions, so both are
 * asserted.
 */

let app;
let api;
let owner;
let member;
let stranger;

async function register() {
  const response = await api('POST', '/api/v1/auth/register', {
    body: { email: uniqueEmail(), password: 'scope password', name: 'Scoper' },
  });
  return { token: response.json.token, user: response.json.user };
}

before(async () => {
  app = await startServer();
  api = app.client;
  owner = await register();
  member = await register();
  stranger = await register();
});

after(async () => {
  await app.close();
  app.cleanup();
});

const auth = (who, extra = {}) => ({ token: who.token, ...extra });

describe('workspace scope', () => {
  it('defaults to the caller\'s own nodes', async () => {
    await api('PUT', '/api/v1/uploads?name=owner-only.txt', auth(owner, {
      raw: true, body: 'mine', headers: { 'content-type': 'text/plain' },
    }));
    await api('PUT', '/api/v1/uploads?name=member-only.txt', auth(member, {
      raw: true, body: 'theirs', headers: { 'content-type': 'text/plain' },
    }));
    const mine = await api('GET', '/api/v1/nodes?parentId=root', auth(owner));
    assert.deepEqual(mine.json.nodes.map((node) => node.name), ['owner-only.txt']);
    const theirs = await api('GET', '/api/v1/nodes?parentId=root', auth(member));
    assert.deepEqual(theirs.json.nodes.map((node) => node.name), ['member-only.txt']);
  });

  it('refuses a workspace the caller does not belong to', async () => {
    const response = await api('GET', '/api/v1/nodes?parentId=root&workspace=' + owner.user.workspace.id, auth(stranger));
    assert.equal(response.status, 200);
    assert.deepEqual(response.json.nodes, [], 'a non-member sees an empty scope, not an error');
  });

  it('shows a member\'s write into the shared folder', async () => {
    const created = await api('POST', '/api/v1/workspace/members', auth(owner, { body: { email: member.user.email } }));
    assert.equal(created.status, 201, created.text);
    // A file lands in a workspace by being written *into* it: the member uploads
    // into a folder the owner created.
    const folder = await api('POST', '/api/v1/nodes', auth(owner, { body: { name: 'shared', kind: 'folder' } }));
    const upload = await api('PUT', '/api/v1/uploads?parentId=' + folder.json.node.id + '&name=member-write.txt', auth(member, {
      raw: true, body: 'written into the shared folder', headers: { 'content-type': 'text/plain' },
    }));
    assert.equal(upload.status, 201, upload.text);

    const scoped = await api('GET', '/api/v1/nodes?parentId=' + folder.json.node.id + '&workspace=' + owner.user.workspace.id, auth(owner));
    assert.equal(scoped.status, 200, scoped.text);
    assert.ok(scoped.json.nodes.some((node) => node.name === 'member-write.txt'), JSON.stringify(scoped.json.nodes));
    // The member's own file stayed in its own workspace and does not leak here.
    const rootScope = await api('GET', '/api/v1/nodes?parentId=root&workspace=' + owner.user.workspace.id, auth(owner));
    const names = rootScope.json.nodes.map((node) => node.name);
    assert.ok(names.includes('owner-only.txt'));
    assert.ok(!names.includes('member-only.txt'), 'a file in the member\'s own drive stays there');
  });

  it('lets the member see the same scope from their side', async () => {
    const scoped = await api('GET', '/api/v1/nodes?parentId=root&workspace=' + owner.user.workspace.id, auth(member));
    assert.equal(scoped.status, 200);
    const names = scoped.json.nodes.map((node) => node.name);
    assert.ok(names.includes('owner-only.txt'));
  });

  it('shows a member\'s file inside the owner\'s folder without ?workspace', async () => {
    // The owner opens the folder it owns; a member wrote into it. Listing must be
    // scoped by the folder's visibility, not by the owner's user_id, or the file is
    // invisible in the very folder it lives in.
    const folder = await api('POST', '/api/v1/nodes', auth(owner, { body: { name: 'co-authored', kind: 'folder' } }));
    const upload = await api('PUT', '/api/v1/uploads?parentId=' + folder.json.node.id + '&name=by-member.txt', auth(member, {
      raw: true, body: 'from the member', headers: { 'content-type': 'text/plain' },
    }));
    assert.equal(upload.status, 201, upload.text);
    const ownerView = await api('GET', '/api/v1/nodes?parentId=' + folder.json.node.id, auth(owner));
    assert.equal(ownerView.status, 200, ownerView.text);
    assert.ok(ownerView.json.nodes.some((node) => node.name === 'by-member.txt'), JSON.stringify(ownerView.json.nodes));
    // And the root listing stays personal: the folder is the owner's, the file is not
    // at the root anyway.
    const memberView = await api('GET', '/api/v1/nodes?parentId=' + folder.json.node.id, auth(member));
    assert.ok(memberView.json.nodes.some((node) => node.name === 'by-member.txt'));
  });

  it('keeps the root listing personal even for a shared folder child', async () => {
    const roots = await api('GET', '/api/v1/nodes?parentId=root', auth(member));
    assert.ok(!roots.json.nodes.some((node) => node.name === 'co-authored'), 'the owner\'s folder stays out of the member\'s root');
  });

  it('keeps the trash scope separate too', async () => {
    const uploaded = await api('PUT', '/api/v1/uploads?name=to-trash.txt', auth(owner, {
      raw: true, body: 'bye', headers: { 'content-type': 'text/plain' },
    }));
    await api('DELETE', '/api/v1/nodes/' + uploaded.json.node.id, auth(owner));
    const mine = await api('GET', '/api/v1/nodes?trash=1', auth(owner));
    assert.ok(mine.json.nodes.some((node) => node.name === 'to-trash.txt'));
    const scoped = await api('GET', '/api/v1/nodes?trash=1&workspace=' + owner.user.workspace.id, auth(member));
    assert.ok(scoped.json.nodes.some((node) => node.name === 'to-trash.txt'), 'a member sees the shared trash');
  });
});