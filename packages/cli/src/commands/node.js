import { CliError, EXIT, usageError } from '../errors.js';
import { formatBytes } from '../output.js';
import { optionalPositional, requirePositional } from './support.js';

/**
 * `mdrive node` — the storage cluster's operator surface.
 *
 * A node is a machine that hands its disk to the coordinator. The commands mirror
 * the four things an operator actually does: list, add, change, remove. Everything
 * else (replication sweeps, capacity reports) lives under `mdrive cluster`.
 */

const BASE = '/storage/nodes';

/** `{nodes, totals, writes}` → the table an operator reads. */
function nodeRows(nodes) {
  return nodes.map((node) => [
    { text: node.name, color: node.state === 'active' ? 'green' : node.state === 'offline' ? 'red' : 'yellow' },
    node.state,
    node.endpoint,
    node.capacityBytes ? formatBytes(node.capacityBytes) : 'unknown',
    node.usedBytes === undefined ? '-' : formatBytes(node.usedBytes),
    node.freeBytes === null || node.freeBytes === undefined ? '-' : formatBytes(node.freeBytes),
    node.reachable === undefined ? '-' : (node.reachable ? 'yes' : 'NO'),
    node.lastError ? String(node.lastError).slice(0, 40) : '-'
  ]);
}

const NODE_COLUMNS = [
  { header: 'name' },
  { header: 'state', max: 9 },
  { header: 'endpoint' },
  { header: 'capacity', align: 'right', max: 10 },
  { header: 'used', align: 'right', max: 10 },
  { header: 'free', align: 'right', max: 10 },
  { header: 'reach', max: 5 },
  { header: 'error', max: 40 }
];

export const nodeCommand = {
  name: 'node',
  category: 'Cluster',
  summary: 'List the storage nodes that contribute disk to this drive.',
  usage: 'node [--probe] [--json]',
  details:
    'Only meaningful when the coordinator runs with DRIVE_STORAGE=cluster. Each node is\n' +
    'one machine holding bytes; the coordinator holds the metadata. --probe asks every\n' +
    'node for its current usage instead of showing the last known value.',
  flags: [
    { name: 'probe', kind: 'boolean', description: 'Query each node for live usage before reporting.' },
    { name: 'state', value: 'LIST', description: 'Only nodes in these states, comma separated.' }
  ],
  examples: ['mdrive node', 'mdrive node --probe', 'mdrive node --state active'],
  async handler(ctx) {
    const query = {
      ...(ctx.flags.bool('probe') ? { probe: '1' } : {}),
      ...(ctx.flags.str('state') ? { state: ctx.flags.str('state') } : {})
    };
    const payload = await ctx.api().get(BASE, { query });
    if (ctx.out.data({ ok: true, command: 'node', ...payload })) return 0;
    const nodes = payload?.nodes ?? [];
    if (nodes.length === 0) {
      ctx.out.line('No storage nodes are enrolled.');
      ctx.out.note('Add one with "mdrive node add NAME --endpoint http://host:4501 --token SECRET".');
      return 0;
    }
    ctx.out.table(NODE_COLUMNS, nodeRows(nodes));
    const totals = payload.totals ?? {};
    ctx.out.fields([
      ['nodes', String(totals.count ?? nodes.length) + ' (' + (totals.active ?? 0) + ' active)'],
      ['capacity', formatBytes(totals.capacityBytes ?? 0)],
      ['used', formatBytes(totals.usedBytes ?? 0)],
      ['free', formatBytes(totals.freeBytes ?? 0)],
      ['replicas required', String(payload.writes ?? '?')]
    ]);
    return 0;
  }
};

export const nodeAddCommand = {
  name: 'node add',
  category: 'Cluster',
  summary: 'Enrol a storage node that is already running.',
  usage: 'node add NAME --endpoint URL --node-token SECRET [--capacity BYTES] [--priority N]',
  details:
    'The node must already be running with the same token: the coordinator proves the\n' +
    'pair before it accepts the node, so a typo fails here instead of during an upload.\n' +
    'The token is sealed with the coordinator key and never echoed back.\n\n' +
    'The secret is --node-token rather than --token because --token is the CLI\'s own\n' +
    'auth flag; reusing it here would make the two indistinguishable on one command line.',
  flags: [
    { name: 'endpoint', value: 'URL', description: 'Where the node listens, for example http://10.0.0.5:4501.' },
    { name: 'node-token', value: 'SECRET', description: 'The DRIVE_NODE_TOKEN the node was started with.' },
    { name: 'capacity', value: 'BYTES', description: 'Ceiling this node may use; 0 or omitted means "ask the node".' },
    { name: 'priority', value: 'N', description: 'Lower is preferred when free space ties (default 100).' }
  ],
  positionals: [['NAME', 'Unique name for this node.']],
  examples: [
    'mdrive node add nas-1 --endpoint http://10.0.0.5:4501 --node-token "$NODE_TOKEN"',
    'mdrive node add old-pc --endpoint http://10.0.0.9:4501 --node-token "$T" --capacity 500GiB --priority 200'
  ],
  async handler(ctx) {
    const name = requirePositional(ctx, 0, 'NAME');
    const endpoint = ctx.flags.required('endpoint');
    const token = ctx.flags.str('node-token')
      ?? ctx.flags.str('token')
      ?? process.env.MDRIVE_NODE_TOKEN
      ?? '';
    if (token === '') {
      throw usageError('Missing --node-token. Pass the DRIVE_NODE_TOKEN the node was started with (or set MDRIVE_NODE_TOKEN).');
    }
    const body = {
      name,
      endpoint,
      token,
      ...(ctx.flags.str('capacity') === undefined ? {} : { capacityBytes: parseBytes(ctx.flags.required('capacity')) }),
      ...(ctx.flags.str('priority') === undefined ? {} : { priority: ctx.flags.integer('priority', { min: 0, max: 10000 }) })
    };
    const payload = await ctx.api().post(BASE, body);
    if (ctx.out.data({ ok: true, command: 'node add', node: payload?.node })) return 0;
    const node = payload?.node ?? {};
    ctx.out.success('Enrolled ' + node.name + ' at ' + node.endpoint + '.');
    ctx.out.fields([
      ['id', node.id],
      ['state', node.state],
      ['capacity', node.capacityBytes ? formatBytes(node.capacityBytes) : 'as reported by the node']
    ]);
    return 0;
  }
};

export const nodeUpdateCommand = {
  name: 'node update',
  category: 'Cluster',
  summary: 'Change a node\'s state, priority, endpoint or declared capacity.',
  usage: 'node update ID [--state active|draining|offline|disabled] [--priority N] [--capacity BYTES] [--endpoint URL]',
  details:
    'Drain a node before removing it: state=draining keeps it readable but stops new\n' +
    'placements, so the replication sweep can move its blobs elsewhere.',
  flags: [
    { name: 'state', value: 'STATE', description: 'active, draining, offline or disabled.' },
    { name: 'priority', value: 'N', description: 'Lower is preferred when free space ties.' },
    { name: 'capacity', value: 'BYTES', description: 'Declared ceiling; higher overrides what the node reports.' },
    { name: 'endpoint', value: 'URL', description: 'New address, after moving the node.' }
  ],
  positionals: [['ID', 'Node id or name.']],
  examples: ['mdrive node update nas-1 --state draining', 'mdrive node update <id> --priority 50'],
  async handler(ctx) {
    const target = requirePositional(ctx, 0, 'ID');
    const id = await resolveNode(ctx, target);
    const body = {};
    if (ctx.flags.str('state') !== undefined) body.state = ctx.flags.required('state');
    if (ctx.flags.str('priority') !== undefined) body.priority = ctx.flags.integer('priority', { min: 0, max: 10000 });
    if (ctx.flags.str('capacity') !== undefined) body.capacityBytes = parseBytes(ctx.flags.required('capacity'));
    if (ctx.flags.str('endpoint') !== undefined) body.endpoint = ctx.flags.required('endpoint');
    if (Object.keys(body).length === 0) throw usageError('Nothing to change. Pass --state, --priority, --capacity or --endpoint.');
    const payload = await ctx.api().request('PATCH', BASE + '/' + encodeURIComponent(id), { body });
    if (ctx.out.data({ ok: true, command: 'node update', node: payload?.node })) return 0;
    ctx.out.success('Updated ' + (payload?.node?.name ?? id) + '.');
    return 0;
  }
};

export const nodeRemoveCommand = {
  name: 'node remove',
  category: 'Cluster',
  summary: 'Remove a node that no longer holds any blobs.',
  usage: 'node remove ID [--force]',
  details:
    'The coordinator refuses while the node still holds blobs: deleting the row would\n' +
    'forget where those bytes are. Drain it, run "mdrive cluster replicate" until it is\n' +
    'empty, then remove it. --force is deliberately not supported.',
  positionals: [['ID', 'Node id or name.']],
  examples: ['mdrive node remove old-pc'],
  async handler(ctx) {
    const target = requirePositional(ctx, 0, 'ID');
    const id = await resolveNode(ctx, target);
    await ctx.api().del(BASE + '/' + encodeURIComponent(id));
    if (ctx.out.data({ ok: true, command: 'node remove', id })) return 0;
    ctx.out.success('Removed node ' + id + '.');
    return 0;
  }
};

export const clusterReplicateCommand = {
  name: 'cluster replicate',
  category: 'Cluster',
  summary: 'Copy under-replicated blobs until each has the required number of copies.',
  usage: 'cluster replicate [--limit N]',
  details:
    'Reads and writes real bytes, so it takes a limit and reports what is left. Run it\n' +
    'after losing a node, after raising DRIVE_CLUSTER_WRITES, or while draining a disk.',
  flags: [{ name: 'limit', value: 'N', description: 'Copy at most N blobs this run (default 50).' }],
  examples: ['mdrive cluster replicate', 'mdrive cluster replicate --limit 500'],
  async handler(ctx) {
    const limit = ctx.flags.integer('limit', { min: 1, max: 1000 });
    const payload = await ctx.api().post('/maintenance/cluster/replicate', limit === undefined ? {} : { limit });
    if (ctx.out.data({ ok: true, command: 'cluster replicate', ...payload })) return 0;
    ctx.out.fields([
      ['under-replicated', String(payload?.considered ?? 0)],
      ['attempted', String(payload?.attempted ?? 0)],
      ['copies written', String(payload?.copied ?? 0)],
      ['still under-replicated', String(payload?.after ?? 0)],
      ['remaining in this sweep', String(payload?.remaining ?? 0)]
    ]);
    for (const row of (payload?.results ?? []).slice(0, 10)) {
      if (!row.copied) ctx.out.line('  skipped ' + String(row.hash).slice(0, 12) + ': ' + (row.reason ?? 'no capacity'));
    }
    if ((payload?.after ?? 0) > 0) ctx.out.note('Run again to continue, or "mdrive cluster status" to see what is short.');
    return 0;
  }
};

export const clusterStatusCommand = {
  name: 'cluster status',
  category: 'Cluster',
  summary: 'Show which blobs are under-replicated, and the capacity across nodes.',
  usage: 'cluster status [--limit N]',
  flags: [{ name: 'limit', value: 'N', description: 'Show at most N under-replicated blobs (default 20).' }],
  examples: ['mdrive cluster status'],
  async handler(ctx) {
    const client = ctx.api();
    const [replication, nodes] = await Promise.all([
      client.get('/maintenance/cluster/replication'),
      client.get(BASE)
    ]);
    if (ctx.out.data({ ok: true, command: 'cluster status', replication: replication?.replication, nodes: nodes?.nodes })) return 0;
    const report = replication?.replication ?? {};
    const limit = ctx.flags.integer('limit', { min: 1, max: 500 }) ?? 20;
    ctx.out.fields([
      ['nodes', String(nodes?.totals?.count ?? 0) + ' (' + (nodes?.totals?.active ?? 0) + ' active)'],
      ['capacity', formatBytes(nodes?.totals?.capacityBytes ?? 0)],
      ['free', formatBytes(nodes?.totals?.freeBytes ?? 0)],
      ['replicas required', String(nodes?.writes ?? '?')],
      ['under-replicated blobs', String(report.count ?? 0)],
      ['bytes at risk', formatBytes(report.bytes ?? 0)]
    ]);
    for (const blob of (report.blobs ?? []).slice(0, limit)) {
      ctx.out.line('  ' + String(blob.hash).slice(0, 12) + '…  ' + formatBytes(blob.size) +
        '  copies=' + blob.replicas + '  on=' + (blob.nodes.join(',') || 'nowhere'));
    }
    if ((report.count ?? 0) > 0) ctx.out.note('Run "mdrive cluster replicate" to repair.');
    return 0;
  }
};

/* ── helpers ──────────────────────────────────────────────────────────── */

/** Resolves a node by name when the operator did not paste an id. */
async function resolveNode(ctx, target) {
  const payload = await ctx.api().get(BASE);
  const nodes = payload?.nodes ?? [];
  const match = nodes.find((node) => node.id === target)
    ?? nodes.find((node) => node.name === target)
    ?? nodes.find((node) => node.name.toLowerCase() === target.toLowerCase());
  if (!match) {
    throw new CliError('No storage node named "' + target + '". Run "mdrive node" to list them.', EXIT.ERROR, { code: 'NOT_FOUND', status: 404 });
  }
  return match.id;
}

/** "500GiB" / "2T" / "1048576" → bytes. */
function parseBytes(text) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(b|k|kb|kib|m|mb|mib|g|gb|gib|t|tb|tib)?\s*$/i.exec(String(text ?? ''));
  if (!match) throw usageError('Cannot parse "' + text + '" as a byte size. Use a number with an optional unit, for example 500GiB.');
  const amount = Number(match[1]);
  const unit = (match[2] ?? 'b').toLowerCase();
  const factor = unit === 'b' ? 1
    : unit === 't' || unit === 'tb' || unit === 'tib' ? 1024 ** 4
      : unit === 'g' || unit === 'gb' || unit === 'gib' ? 1024 ** 3
        : unit === 'm' || unit === 'mb' || unit === 'mib' ? 1024 ** 2
          : 1024;
  return Math.round(amount * factor);
}

void optionalPositional;
