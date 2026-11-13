/**
 * Index maintenance.
 *
 * The search index is derived data, so an operator needs two things: a way to
 * see whether anything has fallen out of it, and a way to fix that. Both
 * endpoints are owner-only on the server.
 */

export const indexCommand = {
  name: 'index',
  category: 'Files',
  summary: 'Show how much of the drive is searchable, or rebuild the index.',
  usage: 'index [--reindex]',
  details:
    'Without --reindex it only reports: how many text-like and Office files are ' +
    'indexed, and how many are not. Files added by an older version, or blobs ' +
    'restored from a backup, are the usual reason for a gap.',
  flags: [{ name: 'reindex', kind: 'boolean', description: 'Rebuild the index before reporting.' }],
  examples: ['mdrive index', 'mdrive index --reindex'],
  async handler(ctx) {
    const client = ctx.api();
    if (ctx.flags.bool('reindex')) {
      const result = await client.post('/maintenance/search/reindex', {});
      if (ctx.out.data({ ok: true, command: 'index', ...result })) return 0;
      const summary = result.summary || {};
      ctx.out.success('Rebuilt: ' + (summary.indexed || 0) + ' files indexed, ' + (summary.skipped || 0) + ' skipped.');
      if (result.after) {
        ctx.out.fields([
          ['searchable', String(result.after.covered)],
          ['missing', String(result.after.missing)]
        ]);
      }
      return 0;
    }
    const status = await client.get('/maintenance/search');
    if (ctx.out.data({ ok: true, command: 'index', ...status })) return 0;
    ctx.out.fields([
      ['searchable', String(status.coverage.covered)],
      ['refused', String(status.coverage.refused ?? 0)],
      ['eligible', String(status.coverage.eligible)],
      ['missing', String(status.coverage.missing)],
      ['up to date', status.upToDate ? 'yes' : 'no']
    ]);
    if (!status.upToDate) ctx.out.line('Run "mdrive index --reindex" to catch up.');
    return 0;
  }
};