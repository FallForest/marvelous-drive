import { resolve as resolvePathOnDisk } from 'node:path';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { CliError, EXIT, usageError } from '../errors.js';
import { formatBytes, formatRelative } from '../output.js';
import {
  REASON_TEXT, baselinePath, executePlan, planSync, readBaseline, scanLocal, scanRemote,
  summarize, writeBaseline,
} from '../sync.js';
import { requirePositional, splitPath } from './support.js';

/**
 * `mdrive sync LOCAL_DIR REMOTE_PATH`
 *
 * A folder sync whose safety comes from evidence, not from timestamps: see
 * ../sync.js for the decision table. This file is the reporting layer — the plan
 * has to be readable before a single byte moves, because the one unrecoverable
 * mistake a sync can make is overwriting the version somebody wanted.
 */

const ACTIONS = new Set(['upload', 'download', 'both', 'none']);

export const syncCommand = {
  name: 'sync',
  category: 'Files',
  summary: 'Two-way sync a local folder with a drive folder, deciding by content hash.',
  usage: 'sync LOCAL_DIR REMOTE_PATH [--dry-run] [--direction up|down|both] [--delete] [--rehash] [--workspace ID]',
  details:
    'Compares content, not timestamps: a photo library keeps its EXIF capture time as\n' +
    'the file mtime, so mtime cannot say whether a file is new. A baseline under\n' +
    '~/.config/mdrive/sync records the last agreed state per path; the first run\n' +
    'adopts what it finds and the second run is a no-op, which is how you verify it\n' +
    'before trusting it with 70 GB.\n\n' +
    'A path changed on both sides is reported as a conflict and left untouched.\n' +
    'Deletions are never propagated unless --delete is given: a missing file is not\n' +
    'the same statement as "delete it everywhere".',
  flags: [
    { name: 'dry-run', kind: 'boolean', short: 'n', description: 'Print the plan and change nothing.' },
    { name: 'direction', value: 'MODE', description: 'up (local→remote), down (remote→local), or both (default).' },
    { name: 'delete', kind: 'boolean', description: 'Propagate deletions in the chosen direction.' },
    { name: 'rehash', kind: 'boolean', description: 'Re-hash every local file instead of trusting the size+mtime cache.' },
    { name: 'on-conflict', value: 'MODE', description: 'How an upload resolves a taken name: overwrite (default), rename, skip.' },
    { name: 'workspace', value: 'ID', description: 'Resolve REMOTE_PATH inside a shared workspace.' },
    { name: 'quiet', kind: 'boolean', short: 'q', description: 'Only print the summary.' }
  ],
  positionals: [
    ['LOCAL_DIR', 'Local folder to sync.'],
    ['REMOTE_PATH', 'Drive folder, for example /Photos.']
  ],
  examples: [
    'mdrive sync ./Photos /Photos --dry-run',
    'mdrive sync "C:\\Users\\me\\Pictures\\照片_已整理" /照片_已整理',
    'mdrive sync ./Photos /Photos --direction up --delete',
    'mdrive sync ./Photos /Photos --rehash --dry-run'
  ],
  async handler(ctx) {
    const localArg = requirePositional(ctx, 0, 'LOCAL_DIR');
    const remoteRaw = requirePositional(ctx, 1, 'REMOTE_PATH');
    const direction = ctx.flags.str('direction') ?? 'both';
    if (!ACTIONS.has(direction)) throw usageError('--direction must be up, down or both.');
    const onConflict = ctx.flags.str('on-conflict');
    if (onConflict !== undefined && !['overwrite', 'rename', 'skip'].includes(onConflict)) {
      throw usageError('--on-conflict must be overwrite, rename or skip.');
    }
    const dryRun = ctx.flags.bool('dry-run');
    const workspace = ctx.flags.str('workspace');
    const client = ctx.api();

    // The remote path is normalised the way the API stores it; the local path is
    // resolved to an absolute real path so the baseline key is stable across runs
    // started from different working directories.
    const remotePath = '/' + splitPath(remoteRaw).join('/');
    if (remotePath === '/') throw usageError('REMOTE_PATH must name a folder, not the drive root. Use "/Photos" or similar.');

    let localRoot;
    try {
      localRoot = await realpath(resolvePathOnDisk(localArg));
      const info = await stat(localRoot);
      if (!info.isDirectory()) throw new Error('not a directory');
    } catch (error) {
      throw new CliError('Cannot use "' + localArg + '" as a local folder: ' +
        (error instanceof Error ? error.message : String(error)), EXIT.USAGE, { code: 'USAGE' });
    }

    // The remote folder must exist: creating it implicitly would make a typo in
    // the path look like an empty drive and upload 70 GB into the wrong place.
    const remote = await scanRemote(client, remotePath, workspace);

    const store = baselinePath(localRoot, remotePath, ctx.server);
    const baseline = await readBaseline(store);

    const progress = ctx.flags.bool('quiet') || dryRun ? undefined : ctx.out.progress('hash');
    const local = await scanLocal(localRoot, {
      cache: baseline.localCache ?? {},
      rehash: ctx.flags.bool('rehash'),
      onProgress: progress,
    });

    let ops = planSync({ local, remote: remote.files, baseline });

    // Direction filters what is allowed to move; everything else is reported so
    // the plan still explains the whole picture.
    if (direction === 'up') {
      ops = ops.map((op) => (op.action === 'download' ? { ...op, action: 'skipped', reason: 'direction=up' } : op));
    } else if (direction === 'down') {
      ops = ops.map((op) => (op.action === 'upload' ? { ...op, action: 'skipped', reason: 'direction=down' } : op));
    }

    const summary = summarize(ops);
    const interesting = ops.filter((op) => !['unchanged', 'forget'].includes(op.action));

    if (!ctx.out.json) {
      ctx.out.fields([
        ['local', localRoot],
        ['remote', remotePath],
        ['baseline', store],
        ['files', String(local.size) + ' local / ' + remote.files.size + ' remote'],
        ['to upload', summary.upload + ' (' + formatBytes(summary.bytesUp) + ')'],
        ['to download', summary.download + ' (' + formatBytes(summary.bytesDown) + ')'],
        ['conflicts', String(summary.conflict)],
        ['pending deletes', String((summary['remote-deleted'] ?? 0) + (summary['local-deleted'] ?? 0))],
        ['unchanged', String(summary.unchanged)]
      ]);
    }

    if (interesting.length) {
      ctx.out.line('');
      const width = Math.min(72, Math.max(20, ...interesting.map((op) => op.rel.length)));
      for (const op of interesting.slice(0, 400)) {
        const label = op.action === 'conflict' ? 'CONFLICT' : op.action.toUpperCase();
        const reason = op.reason ? '  ' + (REASON_TEXT[op.reason] ?? op.reason) : '';
        ctx.out.line('  ' + label.padEnd(9) + ' ' + op.rel.padEnd(width).slice(0, width) +
          '  ' + formatBytes(op.size ?? 0) + reason);
      }
      if (interesting.length > 400) ctx.out.line('  … and ' + (interesting.length - 400) + ' more');
      ctx.out.line('');
    }

    if (summary.conflict > 0) {
      ctx.out.line(ctx.out.paint(summary.conflict + ' conflict(s) will be left untouched.', 'yellow'));
    }

    if (dryRun) {
      if (ctx.out.data({ ok: true, command: 'sync', dryRun: true, local: localRoot, remote: remotePath, summary, plan: ops })) return 0;
      ctx.out.note('--dry-run: nothing was written.');
      return 0;
    }

    const write = async (path, body, ws, method = 'POST') => {
      if (method === 'DELETE') {
        await client.request('DELETE', path, {});
        return null;
      }
      const response = await client.request('POST', path, { body });
      return response?.node ?? null;
    };

    const outcome = await executePlan(client, {
      ops, folders: remote.folders, localRoot,
      baselineEntries: baseline.entries ?? {},
      options: {
        onConflict, delete: ctx.flags.bool('delete'), workspace,
        onProgress: ctx.flags.bool('quiet') ? undefined : ctx.out.progress('sync'),
      },
      write,
      log: ctx.flags.bool('quiet') ? () => {} : (line) => ctx.out.line('  ' + line),
    });

    // The baseline only advances for paths that succeeded; a failed upload must be
    // retried next run, not mistaken for "already in sync".
    const nextCache = {};
    for (const [rel, entry] of local) nextCache[rel] = { size: entry.size, mtimeMs: entry.mtimeMs, sha256: entry.sha256 };
    await writeBaseline(store, {
      version: 1,
      server: ctx.server,
      localRoot,
      remotePath,
      updatedAt: new Date().toISOString(),
      entries: outcome.entries,
      localCache: nextCache,
    });

    if (ctx.out.data({
      ok: outcome.failed.length === 0,
      command: 'sync', local: localRoot, remote: remotePath,
      summary, uploaded: outcome.uploaded, downloaded: outcome.downloaded,
      deletedRemote: outcome.deletedRemote, deletedLocal: outcome.deletedLocal,
      conflicts: outcome.conflicts, pendingDeletes: outcome.pendingDeletes,
      failed: outcome.failed, bytesUp: outcome.bytesUp, bytesDown: outcome.bytesDown,
    })) return outcome.failed.length ? EXIT.ERROR : 0;

    ctx.out.fields([
      ['uploaded', outcome.uploaded + ' (' + formatBytes(outcome.bytesUp) + ')'],
      ['downloaded', outcome.downloaded + ' (' + formatBytes(outcome.bytesDown) + ')'],
      ['deleted', 'remote ' + outcome.deletedRemote + ' / local ' + outcome.deletedLocal],
      ['conflicts', String(outcome.conflicts.length)],
      ['failed', String(outcome.failed.length)],
      ['baseline', 'saved ' + formatRelative(new Date().toISOString())]
    ]);

    if (outcome.pendingDeletes.length) {
      ctx.out.line('');
      ctx.out.line(ctx.out.paint(outcome.pendingDeletes.length + ' path(s) exist on one side only and were left alone.', 'yellow'));
      ctx.out.note('They are listed above. Re-run with --delete to propagate them.');
    }
    for (const conflict of outcome.conflicts) {
      ctx.out.line('  conflict ' + conflict.rel + ': ' + (REASON_TEXT[conflict.reason] ?? conflict.reason ?? ''));
    }
    for (const failure of outcome.failed) {
      ctx.out.line('  failed   ' + failure.rel + ': ' + failure.message);
    }
    if (outcome.failed.length) return EXIT.ERROR;
    return 0;
  }
};

export { mkdir };
