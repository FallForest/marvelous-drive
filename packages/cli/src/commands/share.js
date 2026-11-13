import { CliError, EXIT } from '../errors.js';
import { formatRelative, formatTimestamp } from '../output.js';
import { isUuid, requirePath, requirePositional } from './support.js';

/** Resolves NODE (path or uuid) into a live node. */
async function resolveNode(client, target) {
  const node = isUuid(target)
    ? (await client.get('/nodes/' + encodeURIComponent(target)))?.node
    : await requirePath(client, target);
  if (!node) {
    throw new CliError('No node at "' + target + '". Run "mdrive ls" to inspect the tree.', EXIT.ERROR, { code: 'NOT_FOUND', status: 404 });
  }
  return node;
}

export const shareCommand = {
  name: 'share',
  category: 'Sharing',
  summary: 'Create a public share link for a node.',
  usage: 'share NODE [--permission viewer|downloader] [--expires-days N] [--password PASSWORD] [--max-downloads N]',
  details:
    'The printed url is "/s/<token>" on the server origin. "viewer" lets the recipient\n' +
    'preview; "downloader" also allows the file to be downloaded.',
  flags: [
    { name: 'permission', value: 'MODE', description: 'viewer (default) or downloader.' },
    { name: 'expires-days', value: 'N', description: 'Expire the link after N days.' },
    { name: 'password', value: 'PASSWORD', description: 'Require a password before the link opens.' },
    { name: 'max-downloads', value: 'N', description: 'Cap how many times the content may be fetched.' }
  ],
  positionals: [['NODE', 'Node to share (path or id).']],
  examples: [
    'mdrive share /plan.md',
    'mdrive share /plan.md --permission downloader --expires-days 7',
    'mdrive share /report.pdf --password hunter2 --max-downloads 3'
  ],
  async handler(ctx) {
    const target = requirePositional(ctx, 0, 'NODE');
    const permission = ctx.flags.choice('permission', ['viewer', 'downloader']) ?? 'viewer';
    const expiresInDays = ctx.flags.integer('expires-days', { min: 1, max: 3650 });
    const maxDownloads = ctx.flags.integer('max-downloads', { min: 1 });
    const password = ctx.flags.str('password');
    const client = ctx.api();
    const node = await resolveNode(client, target);
    const body = { permission };
    if (expiresInDays !== undefined) body.expiresInDays = expiresInDays;
    if (password !== undefined && password !== '') body.password = password;
    if (maxDownloads !== undefined) body.maxDownloads = maxDownloads;
    const response = await client.post('/nodes/' + encodeURIComponent(node.id) + '/share', body);
    const share = response?.share ?? null;
    if (!share) throw new CliError('The server did not return a share.', EXIT.ERROR, { code: 'PROTOCOL' });
    const url = share.url.startsWith('http') ? share.url : client.origin + share.url;
    if (ctx.out.data({ ok: true, command: 'share', node: node.name, share: { ...share, absoluteUrl: url } })) return 0;
    ctx.out.success('Shared ' + node.name + ' (' + share.permission + ').');
    ctx.out.fields([
      ['url', url],
      ['token', share.token],
      ['id', share.id],
      ['expires', share.expiresAt ? formatTimestamp(share.expiresAt) : 'never'],
      ['password', share.hasPassword ? 'required' : 'none'],
      ['downloads', String(share.downloads ?? 0) + (share.maxDownloads ? ' / ' + share.maxDownloads : '')]
    ]);
    return 0;
  }
};

export const shareListCommand = {
  name: 'share list',
  category: 'Sharing',
  summary: 'List the share links of one node, or every share on the drive.',
  usage: 'share list [NODE]',
  positionals: [['NODE', 'Node whose shares are listed; omit to list everything.', true]],
  examples: ['mdrive share list', 'mdrive share list /plan.md'],
  async handler(ctx) {
    const client = ctx.api();
    const target = ctx.positional[0];
    let shares;
    if (target !== undefined) {
      const node = await resolveNode(client, target);
      const response = await client.get('/nodes/' + encodeURIComponent(node.id) + '/shares');
      shares = (Array.isArray(response?.shares) ? response.shares : []).map(share => ({ ...share, nodeName: node.name }));
    } else {
      shares = await collectAllShares(client);
    }
    if (ctx.out.data({ ok: true, command: 'share list', shares })) return 0;
    ctx.out.table(
      [
        { header: 'token', max: 18 },
        { header: 'node', max: 28 },
        { header: 'permission', max: 12 },
        { header: 'expires', align: 'right', max: 12 },
        { header: 'downloads', align: 'right', max: 10 },
        { header: 'password', max: 9 },
        { header: 'id' }
      ],
      shares.map(share => [
        share.token,
        share.nodeName ?? share.nodeId ?? '-',
        share.permission,
        share.expiresAt ? formatRelative(share.expiresAt) : 'never',
        String(share.downloads ?? 0) + (share.maxDownloads ? '/' + share.maxDownloads : ''),
        share.hasPassword ? 'yes' : 'no',
        share.id
      ]),
      'No share links.'
    );
    return 0;
  }
};

/** Walks the tree and collects the shares of every node (the API is per-node). */
async function collectAllShares(client) {
  const out = [];
  const queue = [null];
  const seen = new Set();
  while (queue.length > 0) {
    const parentId = queue.shift();
    const response = await client.get('/nodes', { query: { parentId: parentId ?? undefined } });
    const nodes = Array.isArray(response?.nodes) ? response.nodes : [];
    for (const node of nodes) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      if (node.kind === 'folder') queue.push(node.id);
      const sharesResponse = await client.get('/nodes/' + encodeURIComponent(node.id) + '/shares');
      const shares = Array.isArray(sharesResponse?.shares) ? sharesResponse.shares : [];
      for (const share of shares) out.push({ ...share, nodeName: node.name, nodeId: node.id });
    }
  }
  return out;
}

export const revokeCommand = {
  name: 'revoke',
  category: 'Sharing',
  summary: 'Revoke a share link by share id or token.',
  usage: 'revoke SHARE',
  details: 'Pass the share id printed by "mdrive share list", or its token.',
  positionals: [['SHARE', 'Share id (uuid) or share token.']],
  examples: ['mdrive revoke 8a1d...', 'mdrive revoke 4f2c9a'],
  async handler(ctx) {
    const target = requirePositional(ctx, 0, 'SHARE');
    const client = ctx.api();
    let shareId = target;
    if (!isUuid(target)) {
      const shares = await collectAllShares(client);
      const match = shares.find(share => share.token === target);
      if (!match) {
        throw new CliError('No share with token "' + target + '". Run "mdrive share list".', EXIT.ERROR, { code: 'SHARE_NOT_FOUND', status: 404 });
      }
      shareId = match.id;
    }
    await client.del('/shares/' + encodeURIComponent(shareId));
    if (ctx.out.data({ ok: true, command: 'revoke', shareId })) return 0;
    ctx.out.success('Revoked share ' + shareId + '.');
    return 0;
  }
};

export { resolveNode };
