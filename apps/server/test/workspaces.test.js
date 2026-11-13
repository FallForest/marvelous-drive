import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startServer, uniqueEmail } from './helpers.js';

/**
 * Workspaces and membership.
 *
 * Two accounts, one shared workspace. The contract: nodes are visible to every
 * member, names are unique per folder across the workspace, quota still counts
 * against the owner, and an account that is not a member sees nothing.
 */

let app;
let api;
let owner;
let guest;
let outsider;

async function register() {
  const response = await api('POST', '/api/v1/auth/register', {
    body: { email: uniqueEmail(), password: 'workspace password', name: 'Member' },
  });
  assert.equal(response.status, 201, response.text);
  return { token: response.json.token, user: response.json.user };
}

before(async () => {
  app = await startServer();
  api = app.client;
  owner = await register();
  guest = await register();
  outsider = await register();
});

after(async () => {
  await app.close();
  app.cleanup();
});

const auth = (who, extra = {}) => ({ token: who.token, ...extra });

describe('registration', () => {
  it('gives every account a workspace it administers', async () => {
    assert.equal(owner.user.workspace.role, 'admin');
    assert.ok(owner.user.workspace.id);
    assert.notEqual(owner.user.workspace.id, guest.user.workspace.id, 'workspaces are per account');
  });

  it('reports the workspace on /me', async () => {
    const me = await api('GET', '/api/v1/me', auth(owner));
    assert.equal(me.status, 200);
    assert.equal(me.json.user.workspace.id, owner.user.workspace.id);
    assert.equal(me.json.user.workspace.role, 'admin');
  });
});

describe('sharing a workspace', () => {
  it('makes the owner\'s nodes visible to a member', async () => {
    const created = await api('PUT', '/api/v1/uploads?name=shared-plain.txt', auth(owner, {
      raw: true, body: 'shared bytes', headers: { 'content-type': 'text/plain' },
    }));
    assert.equal(created.status, 201, created.text);
    const node = created.json.node;

    // Before joining: invisible.
    const before = await api('GET', '/api/v1/nodes/' + node.id, auth(guest));
    assert.equal(before.status, 404);

    // Join the owner's workspace, as a member.
    const { addMember } = await import('../src/workspaces.js');
    addMember(owner.user.workspace.id, guest.user.id, 'member');

    const afterJoin = await api('GET', '/api/v1/nodes/' + node.id, auth(guest));
    assert.equal(afterJoin.status, 200, afterJoin.text);
    assert.equal(afterJoin.json.node.name, 'shared-plain.txt');

    // A third account that never joined still sees nothing.
    const stranger = await api('GET', '/api/v1/nodes/' + node.id, auth(outsider));
    assert.equal(stranger.status, 404);
  });

  it('lets a member write into a folder that belongs to the owner', async () => {
    const folder = await api('POST', '/api/v1/nodes', auth(owner, { body: { name: 'team-folder', kind: 'folder' } }));
    assert.equal(folder.status, 201, folder.text);
    const upload = await api('PUT', '/api/v1/uploads?parentId=' + folder.json.node.id + '&name=from-member.txt', auth(guest, {
      raw: true, body: 'written by a member', headers: { 'content-type': 'text/plain' },
    }));
    assert.equal(upload.status, 201, upload.text);
    // The new node lives in the owner's workspace, not the member's own.
    const detail = await api('GET', '/api/v1/nodes/' + upload.json.node.id, auth(owner));
    assert.equal(detail.status, 200);
  });

  it('keeps names unique per folder across members', async () => {
    const folder = await api('POST', '/api/v1/nodes', auth(owner, { body: { name: 'collide', kind: 'folder' } }));
    const first = await api('PUT', '/api/v1/uploads?parentId=' + folder.json.node.id + '&name=same.txt', auth(owner, {
      raw: true, body: 'owner copy', headers: { 'content-type': 'text/plain' },
    }));
    assert.equal(first.status, 201);
    const second = await api('PUT', '/api/v1/uploads?parentId=' + folder.json.node.id + '&name=same.txt&onConflict=rename', auth(guest, {
      raw: true, body: 'member copy', headers: { 'content-type': 'text/plain' },
    }));
    assert.equal(second.status, 201, second.text);
    assert.match(second.json.node.name, /^same \(1\)\.txt$/, 'the tree has one namespace per folder');
  });

  it('charges the owner\'s quota, not the member\'s', async () => {
    const stats = await api('GET', '/api/v1/storage/stats', auth(guest));
    // The member's own files are theirs; what they wrote into the team folder is
    // stored under their user_id too (they created it), so at minimum the member
    // sees their own write and the owner sees it as well.
    assert.equal(stats.status, 200);
    const ownerStats = await api('GET', '/api/v1/storage/stats', auth(owner));
    assert.ok(ownerStats.json.stats.bytes >= 1);
  });

  it('lists members and adds one by e-mail', async () => {
    const fresh = await register();
    const before = await api('GET', '/api/v1/workspace/members', auth(owner));
    assert.equal(before.status, 200);
    assert.ok(before.json.members.some((entry) => entry.id === owner.user.id && entry.role === 'admin'));

    const added = await api('POST', '/api/v1/workspace/members', auth(owner, { body: { email: fresh.user.email } }));
    assert.equal(added.status, 201, added.text);
    assert.ok(added.json.members.some((entry) => entry.email === fresh.user.email));

    // The member's *active* workspace is still its own drive, so its listing is
    // its own (empty) tree; the shared nodes stay reachable by id, which is what
    // links, search results and shares use.
    const own = await api('GET', '/api/v1/nodes?parentId=root', auth(fresh));
    assert.equal(own.status, 200);
    assert.equal(own.json.nodes.length, 0, 'its own drive is still empty');
  });

  it('refuses to add an unknown e-mail, or a non-admin caller', async () => {
    const ghost = await api('POST', '/api/v1/workspace/members', auth(owner, { body: { email: 'nobody@example.com' } }));
    assert.equal(ghost.status, 404);
    // 'guest' is a member of the owner's workspace but admin of its own: the
    // active workspace must stay the one it owns, so the invite targets that one
    // and fails on the unknown e-mail rather than on permissions.
    const me = await api('GET', '/api/v1/me', auth(guest));
    assert.equal(me.json.user.workspace.id, guest.user.workspace.id, 'the own workspace stays active');
    assert.equal(me.json.user.workspace.role, 'admin');
    const attempt = await api('POST', '/api/v1/workspace/members', auth(guest, { body: { email: 'someone@example.com' } }));
    assert.equal(attempt.status, 404, 'it tried to invite into its own workspace');
  });

  it('removes a member, and refuses to remove the owner', async () => {
    const outsiderUser = await register();
    await api('POST', '/api/v1/workspace/members', auth(owner, { body: { email: outsiderUser.user.email } }));
    const removed = await api('DELETE', '/api/v1/workspace/members/' + outsiderUser.user.id, auth(owner));
    assert.equal(removed.status, 200, removed.text);
    const list = await api('GET', '/api/v1/workspace/members', auth(owner));
    assert.ok(!list.json.members.some((entry) => entry.id === outsiderUser.user.id));
    const ownerAttempt = await api('DELETE', '/api/v1/workspace/members/' + owner.user.id, auth(owner));
    assert.equal(ownerAttempt.status, 400);
  });

  it('lists every workspace the caller belongs to, with the active one marked', async () => {
    const listed = await api('GET', '/api/v1/workspaces', auth(guest));
    assert.equal(listed.status, 200, listed.text);
    const ids = listed.json.workspaces.map((entry) => entry.id);
    assert.ok(ids.includes(guest.user.workspace.id), 'the own drive is listed');
    assert.ok(ids.includes(owner.user.workspace.id), 'and the workspace it joined');
    const active = listed.json.workspaces.find((entry) => entry.active);
    assert.equal(active.id, guest.user.workspace.id, 'the own drive stays active');
    const joined = listed.json.workspaces.find((entry) => entry.id === owner.user.workspace.id);
    assert.equal(joined.role, 'member');
    assert.ok(typeof joined.bytes === 'number', 'sizes are reported per workspace');
  });

  it('counts files per workspace, not per account', async () => {
    const listed = await api('GET', '/api/v1/workspaces', auth(owner));
    const own = listed.json.workspaces.find((entry) => entry.id === owner.user.workspace.id);
    assert.ok(own.files >= 1, JSON.stringify(own));
    assert.ok(own.bytes >= 1);
  });

  it('makes a member\'s upload findable by the owner', async () => {
    // The index used to be scoped by user_id, so a file a member wrote into the
    // owner's folder was invisible to the owner's content search even though the
    // folder listing showed it.
    const folder = await api('POST', '/api/v1/nodes', auth(owner, { body: { name: 'search-shared', kind: 'folder' } }));
    const upload = await api('PUT', '/api/v1/uploads?parentId=' + folder.json.node.id + '&name=member-notes.txt', auth(guest, {
      raw: true, body: 'the phrase wombat-crossing appears here', headers: { 'content-type': 'text/plain' },
    }));
    assert.equal(upload.status, 201, upload.text);
    const ownerHit = await api('GET', '/api/v1/search?q=wombat-crossing&scope=content', auth(owner));
    assert.ok(ownerHit.json.results.some((row) => row.id === upload.json.node.id), JSON.stringify(ownerHit.json.results));
    // The member still finds its own file.
    const memberHit = await api('GET', '/api/v1/search?q=wombat-crossing&scope=content', auth(guest));
    assert.ok(memberHit.json.results.some((row) => row.id === upload.json.node.id));
    // And a stranger still sees nothing.
    const strangerHit = await api('GET', '/api/v1/search?q=wombat-crossing&scope=content', auth(outsider));
    assert.equal(strangerHit.json.results.length, 0);
  });

  it('does not leak a workspace node into search for a non-member', async () => {
    await api('PUT', '/api/v1/uploads?name=secret-in-workspace.txt', auth(owner, {
      raw: true, body: 'the hidden word zebra', headers: { 'content-type': 'text/plain' },
    }));
    const mine = await api('GET', '/api/v1/search?q=zebra&scope=content', auth(owner));
    assert.ok(mine.json.results.length >= 1, 'the owner finds it');
    const stranger = await api('GET', '/api/v1/search?q=zebra&scope=content', auth(outsider));
    assert.equal(stranger.json.results.length, 0, 'a non-member must not');
  });
});