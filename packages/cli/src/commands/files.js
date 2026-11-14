import { stat } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import sanitizeName from '../naming.js';
import { CliError, EXIT, usageError } from '../errors.js';
import { formatBytes } from '../output.js';
import { RESUMABLE_THRESHOLD, instantUpload, shouldUseResumable, uploadResumable, uploadSimple } from '../http.js';
import { isUuid, requirePath, requirePositional, resolvePath, splitPath } from './support.js';

/** Minimal extension → mime map; unknown types fall back per the contract. */
const MIME = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.ts': 'text/plain',
  '.xml': 'application/xml',
  '.yml': 'text/plain',
  '.yaml': 'text/plain',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
};

export function mimeFor(file) {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

function isTextMime(mime) {
  if (typeof mime !== 'string' || mime === '') return false;
  if (mime.startsWith('text/')) return true;
  return /(json|xml|javascript|ecmascript|svg|x-yaml|csv|markdown|x-sh)/.test(mime);
}

/** Parses "8MiB", "64k", "1048576" into a byte count. */
function parseByteSize(text, options = {}) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(b|k|kb|kib|m|mb|mib|g|gb|gib)?\s*$/i.exec(String(text ?? ''));
  if (!match) {
    throw usageError('Cannot parse "' + text + '" as a byte size. Use a number with an optional unit, for example 1048576, 64KiB, or 8MiB.');
  }
  const amount = Number(match[1]);
  const unit = (match[2] ?? 'b').toLowerCase();
  const factor = unit === 'b' ? 1
    : unit === 'g' || unit === 'gb' || unit === 'gib' ? 1024 * 1024 * 1024
      : unit === 'm' || unit === 'mb' || unit === 'mib' ? 1024 * 1024
        : 1024;
  const value = Math.round(amount * factor);
  if (options.min !== undefined && value < options.min) {
    throw usageError('"' + text + '" is below the minimum of ' + options.min + ' bytes.');
  }
  if (options.max !== undefined && value > options.max) {
    throw usageError('"' + text + '" is above the maximum of ' + options.max + ' bytes.');
  }
  return value;
}

/**
 * Resolves --to into a parent folder. A trailing segment that does not name an
 * existing folder is treated as the target file name.
 */
async function resolveDestination(client, value, workspace) {
  const resolved = await resolvePath(client, value, workspace);
  if (resolved.node && resolved.node.kind === 'folder') {
    return { parentId: resolved.node.id, name: undefined, label: value };
  }
  if (resolved.node && resolved.node.kind === 'file') {
    throw usageError('--to must be a folder; "' + value + '" is a file.');
  }
  const parts = splitPath(value);
  if (parts.length === 0) return { parentId: null, name: undefined, label: '/' };
  const parentPath = '/' + parts.slice(0, -1).join('/');
  const parent = await resolvePath(client, parentPath === '/' ? '/' : parentPath, workspace);
  if (parentPath !== '/' && !parent.node) {
    throw new CliError('Destination folder "' + parentPath + '" does not exist.', EXIT.ERROR, { code: 'NOT_FOUND', status: 404 });
  }
  if (parentPath !== '/' && parent.node.kind !== 'folder') {
    throw usageError('"' + parentPath + '" is a file, not a folder.');
  }
  return {
    parentId: parentPath === '/' ? null : parent.node.id,
    name: sanitizeName(parts[parts.length - 1]),
    label: value
  };
}

export const uploadCommand = {
  name: 'upload',
  category: 'Files',
  summary: 'Upload local files; anything over 8 MiB uses resumable chunks.',
  usage: 'upload FILE... [--to PATH] [--name NAME] [--chunk-size BYTES] [--simple] [--workspace ID]',
  details:
    'Targets a folder with --to (default: the drive root); a trailing "/name.ext" in --to\n' +
    'is treated as the destination file name. Files larger than 8 MiB switch to\n' +
    'POST /uploads/sessions plus one PUT per chunk automatically; --simple forces a\n' +
    'single PUT request. Re-running an interrupted resumable upload resumes it because\n' +
    'chunks already recorded by the server are skipped.',
  flags: [
    { name: 'to', value: 'PATH', description: 'Destination folder path or id (default: the drive root).' },
    { name: 'name', value: 'NAME', description: 'Store the file under a different name.' },
    { name: 'chunk-size', value: 'BYTES', description: 'Resumable chunk size, 64KiB–64MiB (default 8MiB).' },
    { name: 'simple', kind: 'boolean', description: 'Always use a single PUT, even above 8 MiB.' },
    { name: 'session', value: 'ID', description: 'Resume an existing resumable upload session by id.' },
    { name: 'on-conflict', value: 'MODE', description: 'overwrite (default), rename, or skip when the name is taken.' },
    { name: 'workspace', value: 'ID', description: 'Resolve --to inside a shared workspace.' },
    { name: 'quiet', kind: 'boolean', short: 'q', description: 'Hide the progress bar.' }
  ],
  positionals: [['FILE...', 'Local files to upload.']],
  examples: [
    'mdrive upload ./notes.md',
    'mdrive upload ./report.pdf --to /Reports',
    'mdrive upload ./report.pdf --to /Reports/2026-report.pdf',
    'mdrive upload ./backup.tar --chunk-size 16MiB',
    'mdrive upload ./backup.tar --session a1b2c3d4'
  ],
  async handler(ctx) {
    if (ctx.positional.length === 0) throw usageError('Missing FILE. Run "mdrive upload --help" for usage.');
    const client = ctx.api();
    const toFlag = ctx.flags.str('to');
    const nameFlag = ctx.flags.str('name');
    const onConflict = ctx.flags.str('on-conflict');
    if (onConflict !== undefined && !['overwrite', 'rename', 'skip'].includes(onConflict)) {
      throw usageError('--on-conflict must be overwrite, rename or skip.');
    }
    if (nameFlag !== undefined && ctx.positional.length > 1) {
      throw usageError('--name can only be used when uploading a single file.');
    }
    const destination = toFlag === undefined
      ? { parentId: null, name: undefined, label: '/' }
      : await resolveDestination(client, toFlag, ctx.flags.str('workspace'));
    const chunkSize = ctx.flags.str('chunk-size') === undefined
      ? undefined
      : parseByteSize(ctx.flags.required('chunk-size'), { min: 64 * 1024, max: 64 * 1024 * 1024 });

    const uploaded = [];
    for (const file of ctx.positional) {
      const absolute = resolve(file);
      let info;
      try {
        info = await stat(absolute);
      } catch (error) {
        throw usageError('Cannot read ' + file + ': ' + (error instanceof Error ? error.message : String(error)));
      }
      if (!info.isFile()) throw usageError(file + ' is not a regular file.');
      const name = sanitizeName(nameFlag ?? destination.name ?? basename(absolute));
      const mime = mimeFor(name);
      const started = Date.now();
      const progress = ctx.flags.bool('quiet') ? undefined : ctx.out.progress('upload ' + name);

      let node;
      let record;
      const sessionId = ctx.flags.str('session');
      // A second copy of the same bytes costs nothing on the server: probe first
      // and create the node without sending a single byte when it is already there.
      const dedup = await instantUpload(client, {
        filePath: absolute,
        name,
        parentId: destination.parentId,
        size: info.size,
        mime,
        onConflict
      });
      if (dedup) {
        node = dedup.node;
        record = { mode: 'instant' };
      } else if (sessionId !== undefined || (!ctx.flags.bool('simple') && shouldUseResumable(info.size, RESUMABLE_THRESHOLD))) {
        const outcome = await uploadResumable(client, {
          filePath: absolute,
          name,
          parentId: destination.parentId,
          size: info.size,
          mime,
          chunkSize: chunkSize ?? RESUMABLE_THRESHOLD,
          session: sessionId,
          onProgress: progress,
          onConflict
        });
        node = outcome.node;
        record = {
          mode: 'resumable',
          totalChunks: outcome.plan.totalChunks,
          chunksSent: outcome.chunksSent,
          chunksSkipped: outcome.skipped,
          sessionId: outcome.session.id
        };
      } else {
        const outcome = await uploadSimple(client, {
          parentId: destination.parentId,
          name,
          filePath: absolute,
          contentType: mime,
          onProgress: progress,
          onConflict
        });
        node = outcome.node;
        record = { mode: 'simple' };
      }
      if (!node) throw new CliError('The server did not return the uploaded node.', EXIT.ERROR, { code: 'PROTOCOL' });
      const seconds = (Date.now() - started) / 1000;
      uploaded.push({ source: absolute, bytes: info.size, node, seconds, ...record });
      if (!ctx.out.json) {
        ctx.out.line(
          ctx.out.paint('uploaded ', 'green') + node.name + '  ' + formatBytes(info.size) +
          '  v' + node.version + '  ' + node.id +
          (record.mode === 'resumable' ? '  (' + record.chunksSent + '/' + record.totalChunks + ' chunks)' : '') +
          (record.mode === 'instant' ? '  (deduplicated, 0 bytes sent)' : '')
        );
      }
    }
    if (ctx.out.data({ ok: true, command: 'upload', destination: destination.label, uploaded })) return 0;
    return 0;
  }
};

/** Resolves NODE (path or uuid) to a live file node. */
export async function resolveFileNode(client, target, workspace) {
  const node = isUuid(target)
    ? (await client.get('/nodes/' + encodeURIComponent(target)))?.node
    : await requirePath(client, target, workspace);
  if (!node) {
    throw new CliError('No node at "' + target + '". Run "mdrive ls" to inspect the tree.', EXIT.ERROR, { code: 'NOT_FOUND', status: 404 });
  }
  if (node.kind !== 'file') {
    throw usageError('"' + node.name + '" is a folder. Use "mdrive tree" or "mdrive download --recursive".');
  }
  return node;
}

export const downloadCommand = {
  name: 'download',
  category: 'Files',
  summary: 'Download a file to disk (resumable), or stream it to stdout with "-".',
  usage: 'download NODE [DEST] [--resume] [--force]',
  details:
    'Without DEST the bytes land in the current directory under the node name.\n' +
    'Pass "-" as DEST to stream to stdout. --resume continues a partial file with a\n' +
    'Range request when the server answers 206.',
  flags: [
    { name: 'resume', kind: 'boolean', description: 'Continue a partial destination file with a Range request.' },
    { name: 'force', kind: 'boolean', short: 'f', description: 'Overwrite DEST when it already exists.' },
    { name: 'quiet', kind: 'boolean', short: 'q', description: 'Hide the progress bar.' }
  ],
  positionals: [
    ['NODE', 'File to download (path or id).'],
    ['DEST', 'Destination path, or "-" to write to stdout.', true]
  ],
  examples: [
    'mdrive download /plan.md',
    'mdrive download /plan.md ./plan.md --force',
    'mdrive download 8a1d... --resume',
    'mdrive download /plan.md - | head'
  ],
  async handler(ctx) {
    const target = requirePositional(ctx, 0, 'NODE');
    const client = ctx.api();
    const node = await resolveFileNode(client, target);
    let destination = ctx.positional[1] ?? node.name;
    if (destination !== '-') {
      destination = resolve(destination);
      if (!ctx.flags.bool('resume')) {
        const existing = await stat(destination).catch(() => null);
        if (existing && !ctx.flags.bool('force')) {
          throw new CliError(
            destination + ' already exists. Pass --force to overwrite or --resume to continue it.',
            EXIT.ERROR,
            { code: 'EEXIST' }
          );
        }
      }
    }
    const started = Date.now();
    const progress = ctx.flags.bool('quiet') ? undefined : ctx.out.progress('download ' + node.name);
    const result = await client.download('/files/' + encodeURIComponent(node.id) + '/content', {
      destination,
      query: { download: 1 },
      resume: ctx.flags.bool('resume'),
      onProgress: progress
    });
    if (destination === '-') {
      ctx.out.raw(result.data.toString('utf8'));
      return 0;
    }
    const seconds = (Date.now() - started) / 1000;
    if (ctx.out.data({
      ok: true,
      command: 'download',
      path: result.path,
      bytes: result.bytes,
      resumed: result.resumed,
      seconds,
      node: { id: node.id, name: node.name, size: node.size, version: node.version, blobHash: node.blobHash }
    })) return 0;
    ctx.out.success(
      'downloaded ' + node.name + ' -> ' + result.path + '  ' + formatBytes(result.bytes) +
      (result.resumed ? '  (resumed)' : '')
    );
    return 0;
  }
};

export const catCommand = {
  name: 'cat',
  category: 'Files',
  summary: 'Print a text file to stdout.',
  usage: 'cat NODE [--max-bytes N] [--force] [--workspace ID]',
  details: 'Non-text mime types are refused unless --force is given, so the terminal stays readable.\n' +
    'With --workspace the path is resolved inside that shared workspace.',
  flags: [
    { name: 'max-bytes', value: 'N', description: 'Refuse files larger than N bytes (default 8 MiB).' },
    { name: 'force', kind: 'boolean', short: 'f', description: 'Print non-text content anyway.' },
    { name: 'workspace', value: 'ID', description: 'Resolve the path inside a shared workspace.' }
  ],
  positionals: [['NODE', 'File to print (path or id).']],
  examples: ['mdrive cat /plan.md', 'mdrive cat /plan.md --max-bytes 4096', 'mdrive cat /team/note.md --workspace <id>'],
  async handler(ctx) {
    const target = requirePositional(ctx, 0, 'NODE');
    const client = ctx.api();
    const node = await resolveFileNode(client, target, ctx.flags.str('workspace'));
    const limit = ctx.flags.integer('max-bytes', { min: 0 }) ?? 8 * 1024 * 1024;
    if (node.size > limit && !ctx.flags.bool('force')) {
      throw usageError(
        node.name + ' is ' + formatBytes(node.size) + ', above the ' + formatBytes(limit) +
        ' cat limit. Raise --max-bytes or use "mdrive download".'
      );
    }
    const mime = node.mime ?? 'application/octet-stream';
    if (!isTextMime(mime) && !ctx.flags.bool('force')) {
      throw usageError(node.name + ' is ' + mime + ', not text. Use "mdrive download" or add --force.');
    }
    const result = await client.download('/files/' + encodeURIComponent(node.id) + '/content');
    ctx.out.raw(result.data.toString('utf8'));
    return 0;
  }
};