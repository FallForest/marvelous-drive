import { formatBytes } from '../output.js';

export const statsCommand = {
  name: 'stats',
  category: 'Files',
  summary: 'Show storage usage for the drive.',
  usage: 'stats',
  examples: ['mdrive stats', 'mdrive stats --json'],
  async handler(ctx) {
    const response = await ctx.api().get('/storage/stats');
    const stats = response?.stats ?? {};
    if (ctx.out.data({ ok: true, command: 'stats', stats })) return 0;
    const quota = typeof stats.quotaBytes === 'number' && stats.quotaBytes > 0 ? stats.quotaBytes : null;
    const used = typeof stats.bytes === 'number' ? stats.bytes : 0;
    const percent = quota === null ? null : Math.min(100, Math.round((used / quota) * 100));
    ctx.out.fields([
      ['files', stats.files ?? 0],
      ['folders', stats.folders ?? 0],
      ['trashed', stats.trashed ?? 0],
      ['starred', stats.starred ?? 0],
      ['shares', stats.shares ?? 0],
      ['open uploads', stats.uploads ?? 0],
      ['bytes', formatBytes(used)],
      ['quota', quota === null ? 'unlimited' : formatBytes(quota) + ' (' + percent + '% used)']
    ]);
    return 0;
  }
};

export const versionCommand = {
  name: 'version',
  category: 'Files',
  summary: 'Print the CLI version (same as --version).',
  usage: 'version',
  examples: ['mdrive version'],
  async handler(ctx) {
    ctx.out.line('mdrive ' + ctx.version);
    return 0;
  }
};
