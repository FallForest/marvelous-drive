import { formatBytes } from '../output.js';

/**
 * Hot/cold split of the store.
 *
 * Read-only by design: it reports which blobs have not been read in N days, which
 * is the input a tiering or archival run needs. Moving bytes requires a second
 * storage backend, so this stops at reporting.
 */

export const tiersCommand = {
  name: 'tiers',
  category: 'Files',
  summary: 'Show which files have not been read recently (hot/cold split).',
  usage: 'tiers [--days N] [--demote] [--limit N]',
  details:
    'A blob with no read recorded since access tracking started counts as cold: ' +
    'for an archival decision that is the safe reading. The biggest cold files are ' +
    'listed first.',
  flags: [
    { name: 'days', value: 'N', description: 'Idle threshold in days (default 90).' },
    { name: 'demote', kind: 'boolean', description: 'Move the listed cold blobs to the cold tier.' },
    { name: 'limit', value: 'N', description: 'How many blobs --demote may move (default 20).' }
  ],
  examples: ['mdrive tiers', 'mdrive tiers --days 180', 'mdrive tiers --demote --limit 50'],
  async handler(ctx) {
    const days = ctx.flags.integer('days', { min: 1, max: 3650 });
    const client = ctx.api();
    const result = await client.get('/maintenance/storage/tiers', { query: { days } });
    const tiers = result.tiers || {};
    let demoted = null;
    if (ctx.flags.bool('demote')) {
      // The report and the action share one round trip each, so what is printed is
      // what was actually acted on.
      const limit = ctx.flags.integer('limit', { min: 1, max: 500 });
      demoted = await client.post('/maintenance/storage/demote', { days, ...(limit === undefined ? {} : { limit }) });
    }
    if (ctx.out.data({ ok: true, command: 'tiers', tiers, demoted })) return 0;
    ctx.out.fields([
      ['threshold', tiers.thresholdDays + ' days'],
      ['blobs', String(tiers.blobs ?? 0)],
      ['hot', formatBytes(tiers.hotBytes ?? 0)],
      ['cold', formatBytes(tiers.coldBytes ?? 0) + ' (' + (tiers.coldCount ?? 0) + ' files)']
    ]);
    if (demoted) {
      ctx.out.success('Moved ' + demoted.moved + '/' + demoted.attempted + ' cold blob(s) to the cold tier.');
      const failures = (demoted.results || []).filter((entry) => !entry.moved && entry.reason !== 'missing');
      for (const failure of failures.slice(0, 5)) ctx.out.line('  skipped ' + failure.hash.slice(0, 12) + ': ' + failure.reason);
    }
    if ((tiers.cold || []).length) {
      ctx.out.table(
        [
          { header: 'size', align: 'right', max: 10 },
          { header: 'last read', align: 'right', max: 14 },
          { header: 'hash', max: 12 }
        ],
        tiers.cold.slice(0, 20).map((entry) => [
          formatBytes(entry.size),
          entry.lastAccess ? entry.lastAccess.slice(0, 10) : 'never',
          entry.hash.slice(0, 12)
        ])
      );
    }
    return 0;
  }
};