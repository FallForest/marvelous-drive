import { usageError } from '../errors.js';
import { formatBytes, formatRelative } from '../output.js';

export const searchCommand = {
  name: 'search',
  category: 'Files',
  summary: 'Search file names and file contents.',
  usage: 'search QUERY [--limit N] [--kind folder|file] [--scope all|name|content]',
  details:
    '--scope defaults to all: a name hit ranks above a content hit, and content ' +
    'hits carry the matching sentence. Only text-like files are indexed.',
  flags: [
    { name: 'limit', value: 'N', description: 'Maximum results, 1–100 (default 20).' },
    { name: 'kind', value: 'KIND', description: 'Only folder or only file results.' },
    { name: 'scope', value: 'SCOPE', description: 'all (default), name, or content.' }
  ],
  positionals: [['QUERY', 'Words to look for in names and file bodies.']],
  examples: [
    'mdrive search report',
    'mdrive search "INV-2026" --scope content',
    'mdrive search plan --limit 50 --kind file'
  ],
  async handler(ctx) {
    const query = ctx.positional.join(' ').trim();
    if (query === '') throw usageError('Missing QUERY. Run "mdrive search --help" for usage.');
    const limit = ctx.flags.integer('limit', { min: 1, max: 100 }) ?? 20;
    const kind = ctx.flags.choice('kind', ['folder', 'file']);
    const scope = ctx.flags.choice('scope', ['all', 'name', 'content']);
    const client = ctx.api();
    const response = await client.get('/search', { query: { q: query, limit, scope } });
    let results = Array.isArray(response?.results) ? response.results : [];
    if (kind !== undefined) results = results.filter(result => result.kind === kind);
    if (ctx.out.data({ ok: true, command: 'search', query, limit, results })) return 0;
    ctx.out.table(
      [
        { header: 'kind', max: 6 },
        { header: 'size', align: 'right', max: 10 },
        { header: 'updated', align: 'right', max: 12 },
        { header: 'id', max: 36 },
        { header: 'name' }
      ],
      results.map(result => [
        { text: result.kind, color: result.kind === 'folder' ? 'cyan' : undefined },
        result.kind === 'folder' ? '-' : formatBytes(result.size),
        formatRelative(result.updatedAt),
        result.id,
        // A content hit is marked so a script or a human can tell why it matched.
        result.matched === 'content' ? result.name + '  (内容)' : result.name
      ]),
      'No matches for "' + query + '".'
    );
    return 0;
  }
};