import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

/** Fixture ids, stable across runs so assertions can reference them. */
export const IDS = {
  user: '11111111-1111-4111-8111-111111111111',
  projects: '22222222-2222-4222-8222-222222222222',
  plan: '33333333-3333-4333-8333-333333333333',
  notes: '44444444-4444-4444-8444-444444444444',
  trashed: '55555555-5555-4555-8555-555555555555',
  share: '66666666-6666-4666-8666-666666666666',
  picture: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  missing: '99999999-9999-4999-8999-999999999999'
};

export const TOKEN = 'test-token';
export const EMAIL = 'owner@example.com';
export const PASSWORD = 'correct horse battery staple';
export const PLAN_BODY = '# Plan\n\nShip the CLI.\n';

const USER = {
  id: IDS.user,
  email: EMAIL,
  name: 'Ada Lovelace',
  role: 'owner',
  createdAt: '2026-01-01T09:00:00.000Z'
};

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function fail(res, status, code, message) {
  json(res, status, { error: { code, message } });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Records a blob the way the real store counts references. */
function rememberBlob(state, hash, size) {
  if (!hash) return;
  const known = state.blobs.get(hash);
  if (known) { known.refs += 1; return; }
  state.blobs.set(hash, { size, refs: 1 });
}

/**
 * Records the current content of `entry` as a version before it changes.
 *
 * The real server keeps a version row per overwrite; the mock keeps the bytes
 * too so a download test can assert on the old content.
 */
function rememberVersion(state, entry, content) {
  if (!state.versions.has(entry.id)) state.versions.set(entry.id, []);
  const previous = content ?? state.content.get(entry.id) ?? Buffer.alloc(0);
  state.versions.get(entry.id).push({
    id: randomUUID(),
    version: entry.version,
    size: entry.size,
    mime: entry.mime,
    content: Buffer.from(previous).toString('utf8'),
    createdAt: entry.updatedAt
  });
}

function node(overrides) {
  return {
    id: randomUUID(),
    name: 'unnamed',
    kind: 'file',
    parentId: null,
    size: 0,
    mime: 'application/octet-stream',
    version: 1,
    starred: false,
    createdAt: '2026-01-02T10:00:00.000Z',
    updatedAt: '2026-01-02T10:00:00.000Z',
    deletedAt: null,
    blobHash: null,
    ...overrides
  };
}

/**
 * In-process mock of the Drive API defined in docs/CONTRACT.md. It implements
 * exactly the routes the CLI exercises, including the resumable upload session
 * lifecycle, so tests never need a real server.
 */
export async function startMockServer(options = {}) {
  const state = {
    nodes: new Map(),
    content: new Map(),
    // sha256 -> { size, refs }; the dedup probe and instant upload read this.
    blobs: new Map(),
    // node id -> [{ id, version, size, mime, content, createdAt }]
    versions: new Map(),
    sessions: new Map(),
    shares: new Map(),
    requests: [],
    workspaceNodes: [],
    members: [{ id: IDS.user, email: 'owner@example.com', name: 'Ada Lovelace', role: 'admin', joinedAt: '2026-01-01T00:00:00.000Z' }],
    maxUploadBytes: options.maxUploadBytes ?? 2 * 1024 * 1024 * 1024,
    conflictOn: options.conflictOn ?? null
  };

  const projects = node({ id: IDS.projects, name: 'Projects', kind: 'folder' });
  const plan = node({
    id: IDS.plan,
    name: 'plan.md',
    parentId: IDS.projects,
    size: Buffer.byteLength(PLAN_BODY),
    mime: 'text/markdown',
    version: 3,
    blobHash: createHash('sha256').update(PLAN_BODY).digest('hex'),
    starred: true
  });
  const notes = node({
    id: IDS.notes,
    name: 'notes.txt',
    parentId: null,
    size: 12,
    mime: 'text/plain',
    blobHash: createHash('sha256').update('hello notes!').digest('hex')
  });
  const picture = node({
    id: IDS.picture,
    name: 'chart.png',
    parentId: IDS.projects,
    size: 4,
    mime: 'image/png',
    blobHash: createHash('sha256').update('PNG!').digest('hex')
  });
  const trashed = node({
    id: IDS.trashed,
    name: 'old.md',
    parentId: null,
    size: 5,
    mime: 'text/markdown',
    deletedAt: '2026-01-05T10:00:00.000Z'
  });
  for (const entry of [projects, plan, notes, picture, trashed]) state.nodes.set(entry.id, entry);
  state.content.set(IDS.picture, Buffer.from('PNG!'));
  state.content.set(IDS.plan, Buffer.from(PLAN_BODY));
  state.content.set(IDS.notes, Buffer.from('hello notes!'));
  state.content.set(IDS.trashed, Buffer.from('bye\n'));
  // Seed the blob table so the dedup probe answers for content the mock already
  // holds (the same bytes the real store would have adopted).
  for (const entry of [plan, notes, picture]) rememberBlob(state, entry.blobHash, entry.size);

  state.shares.set(IDS.share, {
    id: IDS.share,
    token: 'shr_4f2c9a',
    url: '/s/shr_4f2c9a',
    permission: 'viewer',
    expiresAt: '2026-02-01T00:00:00.000Z',
    maxDownloads: null,
    downloads: 0,
    hasPassword: false,
    createdAt: '2026-01-06T10:00:00.000Z',
    nodeId: IDS.plan
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const raw = await readBody(req);
    const text = raw.toString('utf8');
    let body;
    if (text !== '' && (req.headers['content-type'] ?? '').includes('json')) {
      try { body = JSON.parse(text); } catch { body = undefined; }
    }
    state.requests.push({
      method,
      path,
      query: Object.fromEntries(url.searchParams),
      headers: { ...req.headers },
      body,
      bytes: raw.length
    });

    if (path === '/api/v1/auth/login' && method === 'POST') {
      if (body?.email === EMAIL && body?.password === PASSWORD) return json(res, 200, { token: TOKEN, user: USER });
      return fail(res, 401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    }
    if (path === '/api/v1/auth/register' && method === 'POST') {
      return json(res, 201, { token: TOKEN, user: USER });
    }

    const authorization = req.headers.authorization ?? '';
    if (authorization !== 'Bearer ' + TOKEN) {
      return fail(res, 401, 'UNAUTHENTICATED', 'A valid bearer token is required.');
    }

    const live = () => [...state.nodes.values()].filter(entry => entry.deletedAt === null);
    const folderChildren = parentId => live()
      .filter(entry => (entry.parentId ?? null) === (parentId ?? null))
      .sort((a, b) => (a.kind === b.kind ? a.name.toLowerCase().localeCompare(b.name.toLowerCase()) : a.kind === 'folder' ? -1 : 1));

    if (path === '/api/v1/me' && method === 'GET') return json(res, 200, { user: USER });

    if (path === '/api/v1/nodes' && method === 'GET') {
      // A workspace scope lists the mock's `workspaceNodes` on top of the live
      // tree, which is enough to prove the flag is threaded through.
      const workspace = url.searchParams.get('workspace');
      const scoped = workspace ? [...state.nodes.values(), ...(state.workspaceNodes ?? [])] : [...state.nodes.values()];
      if (url.searchParams.get('trash') === '1') {
        return json(res, 200, { nodes: scoped.filter(entry => entry.deletedAt !== null) });
      }
      if (url.searchParams.get('starred') === '1') {
        return json(res, 200, { nodes: scoped.filter(entry => entry.deletedAt === null && entry.starred) });
      }
      // `root` (or absent) is the root level; an id filters to that folder — the
      // same contract the real server documents.
      const requested = url.searchParams.get('parentId');
      const parentId = requested === null || requested === 'root' ? null : requested;
      const children = scoped.filter(entry => entry.deletedAt === null && (entry.parentId ?? null) === parentId);
      return json(res, 200, { nodes: children });
    }

    if (path === '/api/v1/nodes' && method === 'POST') {
      const name = body?.name;
      const kind = body?.kind;
      const parentId = body?.parentId ?? null;
      if (typeof name !== 'string' || name.trim() === '') return fail(res, 400, 'INVALID_INPUT', 'name is required.');
      if (kind !== 'folder' && kind !== 'file') return fail(res, 400, 'INVALID_INPUT', 'kind must be folder or file.');
      if (parentId !== null) {
        const parent = state.nodes.get(parentId);
        if (!parent) return fail(res, 404, 'NOT_FOUND', 'Parent folder not found.');
        if (parent.kind !== 'folder') return fail(res, 400, 'INVALID_PARENT', 'Parent is not a folder.');
      }
      if (folderChildren(parentId).some(entry => entry.name === name)) {
        return fail(res, 409, 'CONFLICT', 'A node with that name already exists in the folder.');
      }
      if (state.conflictOn === name) {
        return fail(res, 409, 'CONFLICT', 'A node with that name already exists in the folder.');
      }
      const created = node({
        name: name.trim(),
        kind,
        parentId,
        size: 0,
        mime: kind === 'folder' ? null : 'application/octet-stream',
        createdAt: '2026-01-07T10:00:00.000Z',
        updatedAt: '2026-01-07T10:00:00.000Z'
      });
      state.nodes.set(created.id, created);
      return json(res, 201, { node: { ...created, children: 0 } });
    }

    const nodeMatch = /^\/api\/v1\/nodes\/([^/]+)(\/.*)?$/.exec(path);
    if (nodeMatch) {
      const id = decodeURIComponent(nodeMatch[1]);
      const rest = nodeMatch[2] ?? '';
      const entry = state.nodes.get(id);
      if (!entry) return fail(res, 404, 'NOT_FOUND', 'Node not found.');
      if (rest === '' && method === 'GET') {
        const children = folderChildren(id).length;
        return json(res, 200, {
          node: {
            ...entry,
            children,
            downloadUrl: entry.kind === 'file' ? '/api/v1/files/' + entry.id + '/content?download=1' : undefined,
            previewUrl: entry.kind === 'file' ? '/api/v1/files/' + entry.id + '/content' : undefined
          }
        });
      }
      if (rest === '' && method === 'PUT') {
        const nextParent = body?.parentId !== undefined ? body.parentId : entry.parentId;
        const nextName = body?.name !== undefined ? body.name : entry.name;
        const clash = folderChildren(nextParent).some(candidate => candidate.id !== entry.id && candidate.name === nextName);
        if (clash) return fail(res, 409, 'CONFLICT', 'A node named "' + nextName + '" already exists in that folder.');
        entry.name = nextName;
        entry.parentId = nextParent;
        if (body?.expectedVersion !== undefined && body.expectedVersion !== entry.version) {
          return fail(res, 409, 'VERSION_CONFLICT', 'Node is at version ' + entry.version + '.');
        }
        entry.updatedAt = new Date().toISOString();
        return json(res, 200, { node: entry });
      }
      if (rest === '' && method === 'DELETE') {
        entry.deletedAt = new Date().toISOString();
        return json(res, 200, { ok: true });
      }
      if (rest === '/restore' && method === 'POST') {
        entry.deletedAt = null;
        return json(res, 200, { node: entry });
      }
      if (rest === '/permanent' && method === 'DELETE') {
        if (entry.deletedAt === null) return fail(res, 409, 'CONFLICT', 'Only trashed nodes can be purged.');
        state.nodes.delete(id);
        return json(res, 200, { ok: true });
      }
      if (rest === '/star' && method === 'PUT') {
        entry.starred = body?.starred === true;
        return json(res, 200, { starred: entry.starred });
      }
      if (rest === '/copy' && method === 'POST') {
        const copy = node({
          ...entry,
          id: randomUUID(),
          name: body?.name ?? entry.name + ' copy',
          parentId: body?.parentId ?? entry.parentId,
          starred: false,
          version: 1
        });
        state.nodes.set(copy.id, copy);
        return json(res, 201, { node: copy });
      }
      if (rest === '/share' && method === 'POST') {
        const share = {
          id: randomUUID(),
          token: 'shr_' + Math.random().toString(16).slice(2, 8),
          url: '/s/shr_token',
          permission: body?.permission ?? 'viewer',
          expiresAt: body?.expiresInDays ? '2026-03-01T00:00:00.000Z' : null,
          maxDownloads: body?.maxDownloads ?? null,
          downloads: 0,
          hasPassword: typeof body?.password === 'string' && body.password !== '',
          createdAt: new Date().toISOString(),
          nodeId: id
        };
        share.url = '/s/' + share.token;
        state.shares.set(share.id, share);
        const { nodeId, ...published } = share;
        return json(res, 201, { share: published });
      }
      if (rest === '/shares' && method === 'GET') {
        const shares = [...state.shares.values()]
          .filter(share => share.nodeId === id)
          .map(({ nodeId, ...rest2 }) => rest2);
        return json(res, 200, { shares });
      }
    }

    const shareMatch = /^\/api\/v1\/shares\/([^/]+)$/.exec(path);
    if (shareMatch && method === 'DELETE') {
      const id = decodeURIComponent(shareMatch[1]);
      if (!state.shares.has(id)) return fail(res, 404, 'SHARE_NOT_FOUND', 'Share not found.');
      state.shares.delete(id);
      return json(res, 200, { ok: true });
    }

    if (path === '/api/v1/search' && method === 'GET') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const limit = Number(url.searchParams.get('limit') ?? 20);
      const scope = url.searchParams.get('scope') ?? 'all';
      // Name hits first, then content hits — the ranking the real server uses.
      const byName = scope === 'content' ? [] : live()
        .filter(entry => entry.name.toLowerCase().includes(q))
        .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'file' ? -1 : 1))
        .map(entry => ({ entry, matched: 'name', snippet: null }));
      const byContent = scope === 'name' ? [] : live()
        .filter(entry => entry.kind === 'file')
        .map(entry => {
          const original = (state.content.get(entry.id) ?? Buffer.alloc(0)).toString('utf8');
          const at = original.toLowerCase().indexOf(q);
          if (at < 0) return null;
          // Keep the original casing in the snippet; only the comparison is
          // case-insensitive, otherwise the output would not match the file.
          const body = original.replace(/\s+/g, ' ');
          return { entry, matched: 'content', snippet: body.slice(Math.max(0, at - 20), at + q.length + 30) };
        })
        .filter(Boolean);
      const seen = new Set();
      const results = [];
      for (const hit of [...byName, ...byContent]) {
        if (seen.has(hit.entry.id)) continue;
        seen.add(hit.entry.id);
        results.push({
          id: hit.entry.id, name: hit.entry.name, kind: hit.entry.kind, parentId: hit.entry.parentId,
          size: hit.entry.size, mime: hit.entry.mime, updatedAt: hit.entry.updatedAt,
          matched: hit.matched, snippet: hit.snippet
        });
        if (results.length >= limit) break;
      }
      return json(res, 200, { results, scope });
    }

    if (path === '/api/v1/maintenance/storage/tiers' && method === 'GET') {
      const days = Number(url.searchParams.get('days') ?? 90);
      const known = [...state.blobs.entries()];
      const cold = known.map(([hash, info]) => ({ hash, size: info.size, lastAccess: null, hits: 0 }));
      return json(res, 200, {
        tiers: {
          thresholdDays: days,
          cutoff: new Date().toISOString(),
          blobs: known.length,
          hotBytes: 0,
          coldBytes: cold.reduce((sum, entry) => sum + entry.size, 0),
          coldCount: cold.length,
          cold
        }
      });
    }

    if (path === '/api/v1/maintenance/blobs/verify' && method === 'GET') {
      const known = [...state.blobs.keys()];
      const limit = Number(url.searchParams.get('limit') ?? 0);
      const corrupt = state.corruptHash ? [{ hash: state.corruptHash, expected: state.corruptHash, actual: 'deadbeef', size: 4 }] : [];
      return json(res, 200, {
        verification: {
          checkedAt: new Date().toISOString(),
          verified: limit > 0 ? Math.min(limit, known.length) : known.length,
          bytes: 0,
          corrupt,
          missing: [],
          remaining: limit > 0 ? Math.max(0, known.length - limit) : 0
        }
      });
    }

    if (path === '/api/v1/maintenance/blobs/quarantine' && method === 'POST') {
      const hashes = Array.isArray(body?.hashes) ? body.hashes : [];
      state.quarantined = (state.quarantined ?? []).concat(hashes);
      if (state.corruptHash && hashes.includes(state.corruptHash)) state.corruptHash = null;
      return json(res, 200, { moved: hashes.length, quarantined: hashes.length });
    }

    if (path === '/api/v1/maintenance/search' && method === 'GET') {
      const eligible = [...state.nodes.values()].filter((entry) => entry.kind === 'file' && entry.deletedAt === null && /\.(txt|md)$/.test(entry.name)).length;
      const covered = state.indexGap ? Math.max(0, eligible - 1) : eligible;
      return json(res, 200, { coverage: { eligible, covered, missing: eligible - covered }, upToDate: covered === eligible });
    }

    if (path === '/api/v1/maintenance/search/reindex' && method === 'POST') {
      state.indexGap = false;
      const eligible = [...state.nodes.values()].filter((entry) => entry.kind === 'file' && entry.deletedAt === null && /\.(txt|md)$/.test(entry.name)).length;
      return json(res, 200, {
        summary: { scanned: eligible, indexed: eligible, skipped: 0 },
        before: { eligible, covered: Math.max(0, eligible - 1), missing: 1 },
        after: { eligible, covered: eligible, missing: 0 }
      });
    }

    if (path === '/api/v1/workspaces' && method === 'GET') {
      return json(res, 200, {
        workspaces: [
          { id: 'ws-1', name: 'Projects drive', ownerId: IDS.user, role: 'admin', active: true, files: 2, folders: 1, bytes: 34 },
          { id: 'ws-2', name: 'Shared with me', ownerId: 'other-user', role: 'member', active: false, files: 1, folders: 0, bytes: 12 }
        ]
      });
    }

    if (path === '/api/v1/workspace/members' && method === 'GET') {
      return json(res, 200, {
        workspace: { id: 'ws-1', name: 'Projects drive', ownerId: IDS.user, role: 'admin' },
        members: state.members
      });
    }

    if (path === '/api/v1/workspace/members' && method === 'POST') {
      const email = String(body?.email ?? '').toLowerCase();
      if (!email) return fail(res, 400, 'INVALID_INPUT', 'An e-mail is required.');
      if (email === 'nobody@example.com') return fail(res, 404, 'NOT_FOUND', 'No account with that e-mail exists yet.');
      const role = body?.role === 'admin' ? 'admin' : 'member';
      state.members.push({ id: 'user-' + state.members.length, email, name: email.split('@')[0], role, joinedAt: new Date().toISOString() });
      return json(res, 201, { members: state.members });
    }

    const memberMatch = /^\/api\/v1\/workspace\/members\/([^/]+)$/.exec(path);
    if (memberMatch && method === 'DELETE') {
      const id = decodeURIComponent(memberMatch[1]);
      if (id === IDS.user) return fail(res, 400, 'INVALID_INPUT', 'The workspace owner cannot be removed.');
      const before = state.members.length;
      state.members = state.members.filter((member) => member.id !== id);
      if (state.members.length === before) return fail(res, 404, 'NOT_FOUND', 'That account is not a member of this workspace.');
      return json(res, 200, { ok: true });
    }

    if (path === '/api/v1/storage/stats' && method === 'GET') {
      const all = [...state.nodes.values()];
      return json(res, 200, {
        stats: {
          files: all.filter(entry => entry.kind === 'file' && entry.deletedAt === null).length,
          folders: all.filter(entry => entry.kind === 'folder' && entry.deletedAt === null).length,
          trashed: all.filter(entry => entry.deletedAt !== null).length,
          bytes: all.reduce((sum, entry) => sum + entry.size, 0),
          quotaBytes: 10 * 1024 * 1024 * 1024,
          starred: all.filter(entry => entry.starred).length,
          shares: state.shares.size,
          uploads: state.sessions.size
        }
      });
    }

    /* ── content ── */

    const contentMatch = /^\/api\/v1\/files\/([^/]+)\/content$/.exec(path);
    if (contentMatch && method === 'GET') {
      const entry = state.nodes.get(decodeURIComponent(contentMatch[1]));
      if (!entry) return fail(res, 404, 'NOT_FOUND', 'File not found.');
      if (entry.kind !== 'file') return fail(res, 400, 'NOT_A_FILE', 'Node is not a file.');
      const data = state.content.get(entry.id) ?? Buffer.alloc(0);
      const range = req.headers.range;
      const headers = { 'content-type': entry.mime ?? 'application/octet-stream', 'accept-ranges': 'bytes' };
      if (url.searchParams.get('download') === '1') {
        headers['content-disposition'] = 'attachment; filename="' + entry.name + '"';
      }
      if (typeof range === 'string') {
        const parsed = /bytes=(\d+)-$/.exec(range);
        if (parsed) {
          const start = Number(parsed[1]);
          const slice = data.subarray(start);
          res.writeHead(206, { ...headers, 'content-length': slice.length, 'content-range': 'bytes ' + start + '-' + (data.length - 1) + '/' + data.length });
          res.end(slice);
          return;
        }
      }
      res.writeHead(200, { ...headers, 'content-length': data.length });
      res.end(data);
      return;
    }

    const versionsMatch = /^\/api\/v1\/files\/([^/]+)\/versions$/.exec(path);
    if (versionsMatch && method === 'GET') {
      const entry = state.nodes.get(decodeURIComponent(versionsMatch[1]));
      if (!entry) return fail(res, 404, 'NOT_FOUND', 'File not found.');
      const stored = state.versions.get(entry.id) ?? [];
      return json(res, 200, {
        versions: stored.length
          ? stored.map((version) => ({
              id: version.id,
              version: version.version,
              size: version.size,
              mime: version.mime,
              createdBy: IDS.user,
              createdAt: version.createdAt,
              downloadUrl: '/api/v1/files/' + entry.id + '/versions/' + version.id + '/content?download=1'
            }))
          // A file that has never been overwritten still answers with its current
          // version, which is what the real server does.
          : [{ id: randomUUID(), version: entry.version, size: entry.size, mime: entry.mime, createdBy: IDS.user, createdAt: entry.updatedAt }],
        currentVersion: entry.version
      });
    }

    const versionContentMatch = /^\/api\/v1\/files\/([^/]+)\/versions\/([^/]+)\/content$/.exec(path);
    if (versionContentMatch && method === 'GET') {
      const entry = state.nodes.get(decodeURIComponent(versionContentMatch[1]));
      if (!entry) return fail(res, 404, 'NOT_FOUND', 'File not found.');
      const version = (state.versions.get(entry.id) ?? []).find((candidate) => candidate.id === decodeURIComponent(versionContentMatch[2]));
      if (!version) return fail(res, 404, 'NOT_FOUND', 'Version not found.');
      const data = Buffer.from(version.content, 'utf8');
      const headers = { 'content-type': version.mime ?? 'application/octet-stream', 'content-length': String(data.length) };
      if (url.searchParams.get('download') === '1') {
        headers['content-disposition'] = 'attachment; filename="' + entry.name + ' (v' + version.version + ')"';
      }
      res.writeHead(200, headers);
      res.end(data);
      return;
    }

    const versionRestoreMatch = /^\/api\/v1\/files\/([^/]+)\/versions\/([^/]+)\/restore$/.exec(path);
    if (versionRestoreMatch && method === 'POST') {
      const entry = state.nodes.get(decodeURIComponent(versionRestoreMatch[1]));
      if (!entry) return fail(res, 404, 'NOT_FOUND', 'File not found.');
      const version = (state.versions.get(entry.id) ?? []).find((candidate) => candidate.id === decodeURIComponent(versionRestoreMatch[2]));
      if (!version) return fail(res, 404, 'NOT_FOUND', 'Version not found.');
      const expected = Number(body?.expectedVersion ?? entry.version);
      if (expected !== entry.version) return fail(res, 409, 'VERSION_CONFLICT', 'File is at version ' + entry.version + '.');
      rememberVersion(state, entry);
      entry.version += 1;
      entry.size = version.size;
      state.content.set(entry.id, Buffer.from(version.content, 'utf8'));
      return json(res, 200, { node: entry });
    }

    /* ── uploads ── */

    if (path === '/api/v1/uploads' && method === 'PUT') {
      const parentId = url.searchParams.get('parentId');
      const name = url.searchParams.get('name') ?? req.headers['x-file-name'] ?? 'upload.bin';
      if (raw.length > state.maxUploadBytes) return fail(res, 413, 'FILE_TOO_LARGE', 'Upload exceeds the configured limit.');
      let entry = folderChildren(parentId).find(candidate => candidate.name === name && candidate.kind === 'file');
      let status = 200;
      if (entry) {
        rememberVersion(state, entry, state.content.get(entry.id));
        entry.version += 1;
        entry.size = raw.length;
        entry.blobHash = createHash('sha256').update(raw).digest('hex');
        entry.updatedAt = new Date().toISOString();
      } else {
        status = 201;
        entry = node({
          id: randomUUID(),
          name: String(name),
          parentId,
          size: raw.length,
          mime: req.headers['content-type'] ?? 'application/octet-stream',
          blobHash: createHash('sha256').update(raw).digest('hex'),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        state.nodes.set(entry.id, entry);
      }
      state.content.set(entry.id, raw);
      rememberBlob(state, entry.blobHash, raw.length);
      return json(res, status, { node: entry });
    }

    // Blob probe + instant upload (dedup). The mock records every hash it has
    // seen so a second upload of the same bytes can be answered without a body.
    const blobMatch = /^\/api\/v1\/blobs\/([a-f0-9]{64})$/.exec(path);
    if (blobMatch && method === 'GET') {
      const known = state.blobs.get(blobMatch[1]);
      if (!known) return fail(res, 404, 'NOT_FOUND', 'No such blob.');
      return json(res, 200, { exists: true, sha256: blobMatch[1], size: known.size, refs: known.refs });
    }

    if (path === '/api/v1/uploads/instant' && method === 'POST') {
      const sha256 = String(body?.sha256 ?? '');
      const name = String(body?.name ?? 'instant.bin');
      const parentId = body?.parentId ?? null;
      const known = state.blobs.get(sha256);
      if (!known) return fail(res, 404, 'BLOB_NOT_FOUND', 'The server does not store those bytes.');
      if (Number(body?.size) !== known.size) return fail(res, 400, 'INVALID_INPUT', 'size does not match the stored blob.');
      known.refs += 1;
      const entry = node({
        id: randomUUID(),
        name,
        parentId,
        size: known.size,
        mime: String(body?.mime ?? 'application/octet-stream'),
        blobHash: sha256,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      state.nodes.set(entry.id, entry);
      return json(res, 201, { node: entry, deduplicated: true });
    }

    if (path === '/api/v1/uploads/sessions' && method === 'POST') {
      const name = body?.name;
      const size = Number(body?.size ?? 0);
      const chunkSize = Number(body?.chunkSize ?? 8 * 1024 * 1024);
      if (typeof name !== 'string') return fail(res, 400, 'INVALID_INPUT', 'name is required.');
      if (size > state.maxUploadBytes) return fail(res, 413, 'FILE_TOO_LARGE', 'Upload exceeds the configured limit.');
      if (chunkSize < 64 * 1024 || chunkSize > 64 * 1024 * 1024) {
        return fail(res, 400, 'INVALID_INPUT', 'chunkSize must be between 64 KiB and 64 MiB.');
      }
      const id = randomUUID();
      const totalChunks = Math.max(1, Math.ceil(size / chunkSize));
      const session = {
        id,
        name,
        size,
        parentId: body?.parentId ?? null,
        chunkSize,
        totalChunks,
        receivedChunks: [],
        expiresAt: '2026-02-01T00:00:00.000Z',
        chunks: new Map(),
        sha256: body?.sha256
      };
      state.sessions.set(id, session);
      const { chunks, sha256, ...published } = session;
      return json(res, 201, { upload: published });
    }

    const chunkMatch = /^\/api\/v1\/uploads\/sessions\/([^/]+)\/chunks\/(\d+)$/.exec(path);
    if (chunkMatch && method === 'PUT') {
      const session = state.sessions.get(decodeURIComponent(chunkMatch[1]));
      if (!session) return fail(res, 404, 'NOT_FOUND', 'Upload session not found.');
      const index = Number(chunkMatch[2]);
      if (index < 0 || index >= session.totalChunks) return fail(res, 400, 'INVALID_INPUT', 'Chunk index out of range.');
      if (raw.length > session.chunkSize) return fail(res, 400, 'INVALID_INPUT', 'Chunk exceeds chunkSize.');
      session.chunks.set(index, raw);
      if (!session.receivedChunks.includes(index)) session.receivedChunks.push(index);
      session.receivedChunks.sort((a, b) => a - b);
      const { chunks, sha256, ...published } = session;
      return json(res, 200, { upload: published });
    }

    const sessionMatch = /^\/api\/v1\/uploads\/sessions\/([^/]+)(\/complete)?$/.exec(path);
    if (sessionMatch) {
      const session = state.sessions.get(decodeURIComponent(sessionMatch[1]));
      if (!session) return fail(res, 404, 'NOT_FOUND', 'Upload session not found.');
      if (sessionMatch[2] === '/complete' && method === 'POST') {
        if (session.receivedChunks.length !== session.totalChunks) {
          return fail(res, 409, 'UPLOAD_INCOMPLETE', 'Upload is missing chunks.');
        }
        const parts = [];
        for (let index = 0; index < session.totalChunks; index += 1) parts.push(session.chunks.get(index));
        const assembled = Buffer.concat(parts);
        if (assembled.length !== session.size) {
          return fail(res, 409, 'UPLOAD_INCOMPLETE', 'Assembled size does not match the declared size.');
        }
        if (session.sha256) {
          const digest = createHash('sha256').update(assembled).digest('hex');
          if (digest !== session.sha256) return fail(res, 409, 'CHECKSUM_MISMATCH', 'Assembled sha256 does not match.');
        }
        const entry = node({
          id: randomUUID(),
          name: session.name,
          parentId: session.parentId,
          size: assembled.length,
          mime: 'application/octet-stream',
          blobHash: createHash('sha256').update(assembled).digest('hex'),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        state.nodes.set(entry.id, entry);
        state.content.set(entry.id, assembled);
        state.sessions.delete(session.id);
        return json(res, 201, { node: entry });
      }
      if (sessionMatch[2] === undefined && method === 'GET') {
        const { chunks, sha256, ...published } = session;
        return json(res, 200, { upload: published });
      }
      if (sessionMatch[2] === undefined && method === 'DELETE') {
        state.sessions.delete(session.id);
        return json(res, 200, { ok: true });
      }
    }

    return fail(res, 404, 'NOT_FOUND', 'No route for ' + method + ' ' + path + '.');
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const url = 'http://127.0.0.1:' + address.port;

  return {
    url,
    state,
    requests: state.requests,
    async close() {
      await new Promise(resolve => server.close(resolve));
    }
  };
}
