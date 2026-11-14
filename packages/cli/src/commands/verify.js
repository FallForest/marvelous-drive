/**
 * Store verification.
 *
 * Size and existence checks (maintenance/blobs) cannot see silent corruption.
 * This command rehashes the blobs and, with --fix, quarantines anything whose
 * bytes no longer hash to their name.
 */

export const verifyCommand = {
  name: 'verify',
  category: 'Files',
  summary: 'Rehash stored blobs to detect corruption, and quarantine what fails.',
  usage: 'verify [--limit N] [--fix]',
  details:
    'Reads every blob, so on a large drive use --limit to check a slice per run ' +
    '(the response says how many are left). A corrupt blob is never deleted: ' +
    '--fix moves it to data/quarantine and drops its row, so downloads fail ' +
    'cleanly instead of serving the wrong bytes.',
  flags: [
    { name: 'limit', value: 'N', description: 'Check at most N blobs this run.' },
    { name: 'fix', kind: 'boolean', description: 'Quarantine every blob that fails.' }
  ],
  examples: ['mdrive verify', 'mdrive verify --limit 500', 'mdrive verify --fix'],
  async handler(ctx) {
    const limit = ctx.flags.integer('limit', { min: 1, max: 5000 });
    const client = ctx.api();
    const query = limit === undefined ? '' : '?limit=' + limit;
    const result = await client.get('/maintenance/blobs/verify' + query);
    const verification = result.verification || {};
    let fixed = null;
    if (ctx.flags.bool('fix') && (verification.corrupt || []).length) {
      fixed = await client.post('/maintenance/blobs/quarantine', {
        hashes: verification.corrupt.map((entry) => entry.hash)
      });
    }
    if (ctx.out.data({ ok: true, command: 'verify', verification, fixed })) return 0;
    ctx.out.fields([
      ['checked', String(verification.verified ?? 0)],
      ['corrupt', String((verification.corrupt || []).length)],
      ['missing', String((verification.missing || []).length)],
      ['remaining', String(verification.remaining ?? 0)]
    ]);
    for (const entry of (verification.corrupt || []).slice(0, 10)) {
      ctx.out.line('  corrupt ' + entry.hash + ' (expected ' + entry.expected + ', got ' + String(entry.actual).slice(0, 12) + '…)');
    }
    if (fixed) ctx.out.success('Quarantined ' + (fixed.moved || 0) + ' blob(s) into data/quarantine.');
    else if ((verification.corrupt || []).length) ctx.out.line('Re-run with --fix to quarantine them.');
    if (verification.remaining > 0) ctx.out.line(verification.remaining + ' blob(s) not checked yet; run again to continue.');
    return 0;
  }
};
