import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, posix, relative, sep } from 'node:path';
import { CliError, EXIT } from './errors.js';
import { configDirectory } from './config.js';
import { instantUpload, shouldUseResumable, uploadResumable, uploadSimple } from './http.js';
import { listChildren } from './commands/support.js';
import { mimeFor } from './commands/files.js';

/**
 * Two-way folder sync.
 *
 * The design problem is not "copy files" — it is **deciding**, for every path,
 * whether the local copy, the remote copy, or neither has changed since the last
 * run. Getting that wrong destroys data, so the rule here is:
 *
 *   - content decides, never timestamps. A photo library is the reason: its
 *     mtimes are the EXIF capture time, not the copy time, so mtime says nothing
 *     about whether a file is new. Two files hashed equal *are* equal.
 *   - a baseline file records the outcome of the last sync (sha256 + remote
 *     version per relative path). Without it there is no way to tell "the user
 *     edited this" from "someone else did", so the first run only adopts.
 *   - a path changed on both sides is a conflict: it is reported and never
 *     guessed at. Downloading over a local edit, or uploading over a remote one,
 *     loses work either way.
 *   - deletion is opt-in (`--delete`), because "the file is missing locally" and
 *     "the user meant to delete it everywhere" are not the same statement.
 *
 * Every upload is preceded by a version check against the baseline, so a remote
 * file that moved under us becomes a conflict instead of a silent overwrite.
 */

const toPosix = (path) => path.split(sep).join('/');

/** sha256 of a file, streamed. */
export async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * Where the baseline for one (local dir, remote path) pair lives.
 *
 * Keyed by the pair, not by a name the user types, so `sync A /Photos` and
 * `sync A /Backup` keep separate memories and moving a folder on disk does not
 * silently inherit the wrong history.
 */
export function baselinePath(localRoot, remotePath, server) {
  const key = createHash('sha256')
    .update(String(server) + '\u0000' + localRoot + '\u0000' + remotePath)
    .digest('hex')
    .slice(0, 16);
  return join(configDirectory(), 'sync', key + '.json');
}

/** Reads a baseline; a missing or unreadable one is an empty merge base. */
export async function readBaseline(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') return parsed;
  } catch { /* absent, or written by an older version: start over */ }
  return { version: 1, entries: {} };
}

/** Writes the baseline atomically: a crash must not leave a half-written map. */
export async function writeBaseline(path, baseline) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.' + process.pid + '.part';
  await writeFile(temporary, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
  await rename(temporary, path);
}

/* ── scanning ──────────────────────────────────────────────────────────── */

/**
 * Walks the local tree and hashes every file.
 *
 * Hashing 70 GB is the expensive half of a first run, so a file whose size and
 * mtime match the cache is trusted without re-reading it (`--rehash` overrides).
 * That is the one place a timestamp is allowed to influence a decision, and it
 * is safe in the direction that matters: a false "unchanged" can only happen if
 * bytes changed while size and mtime did not, which no editor does.
 */
export async function scanLocal(root, { cache = {}, rehash = false, onProgress } = {}) {
  const files = new Map();
  const walk = async (dir, prefix) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      throw new CliError('Cannot read ' + dir + ': ' + error.message, EXIT.ERROR, { code: 'LOCAL_IO' });
    }
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      const rel = prefix === '' ? entry.name : prefix + '/' + entry.name;
      if (entry.isDirectory()) {
        await walk(absolute, rel);
        continue;
      }
      // Symlinks are skipped rather than followed: following one can walk out of
      // the tree, and on Windows a junction can loop.
      if (!entry.isFile()) continue;
      const info = await stat(absolute);
      const cached = cache[rel];
      let sha256;
      if (!rehash && cached && cached.size === info.size && cached.mtimeMs === Math.round(info.mtimeMs) && typeof cached.sha256 === 'string') {
        sha256 = cached.sha256;
      } else {
        sha256 = await hashFile(absolute);
        if (typeof onProgress === 'function') onProgress(rel, info.size);
      }
      files.set(rel, { size: info.size, mtimeMs: Math.round(info.mtimeMs), sha256, absolute });
    }
  };
  await walk(root, '');
  return files;
}

/**
 * Walks the remote tree, reading metadata only.
 *
 * Node payloads already carry `blobHash`, so the remote side of the comparison
 * costs one listing per folder and zero bytes of content.
 */
export async function scanRemote(client, remotePath, workspace) {
  const folders = new Map();   // relative dir -> node id
  const files = new Map();     // relative path -> {id, sha256, size, version}

  const resolved = remotePath === '/' ? null : await resolveFolder(client, remotePath, workspace);
  if (remotePath !== '/' && !resolved) {
    throw new CliError('The remote folder ' + remotePath + ' does not exist. Create it with "mdrive mkdir -p ' + remotePath + '".',
      EXIT.ERROR, { code: 'NOT_FOUND', status: 404 });
  }
  folders.set('', resolved ? resolved.id : null);

  const walk = async (parentId, prefix, depth) => {
    if (depth > 64) return; // a tree this deep is a loop, not a photo library
    const children = await listChildren(client, parentId, workspace);
    for (const child of children) {
      const rel = prefix === '' ? child.name : prefix + '/' + child.name;
      if (child.kind === 'folder') {
        folders.set(rel, child.id);
        await walk(child.id, rel, depth + 1);
      } else {
        files.set(rel, {
          id: child.id,
          sha256: child.blobHash ?? null,
          size: child.size ?? 0,
          version: child.version ?? 1,
        });
      }
    }
  };
  await walk(folders.get(''), '', 0);
  return { files, folders };
}

/** Resolves a remote folder path, creating nothing. */
async function resolveFolder(client, path, workspace) {
  const parts = path.split('/').filter(Boolean);
  let parentId = null;
  let node = null;
  for (const part of parts) {
    const children = await listChildren(client, parentId, workspace);
    node = children.find((child) => child.name === part && child.kind === 'folder')
      ?? children.find((child) => child.name.toLowerCase() === part.toLowerCase() && child.kind === 'folder');
    if (!node) return null;
    parentId = node.id;
  }
  return node;
}

/* ── planning ──────────────────────────────────────────────────────────── */

/**
 * Turns three snapshots into a list of operations.
 *
 * Pure: no I/O, no client, so the decision table can be tested exhaustively.
 * Each operation names what will happen and why, because the report is the
 * product on a `--dry-run`.
 */
export function planSync({ local, remote, baseline }) {
  const entries = baseline.entries ?? {};
  const ops = [];
  const paths = new Set([...local.keys(), ...remote.keys(), ...Object.keys(entries)]);

  for (const rel of [...paths].sort()) {
    const localEntry = local.get(rel) ?? null;
    const remoteEntry = remote.get(rel) ?? null;
    const base = entries[rel] ?? null;

    const localSha = localEntry ? localEntry.sha256 : null;
    const remoteSha = remoteEntry ? remoteEntry.sha256 : null;

    if (localEntry && remoteEntry) {
      if (localSha === remoteSha) {
        // Identical bytes: nothing to transfer. The baseline is refreshed below so
        // an adopted file stops looking new.
        ops.push({ rel, action: 'unchanged', size: localEntry.size, remoteId: remoteEntry.id, sha256: localSha, remoteVersion: remoteEntry.version });
        continue;
      }
      if (base === null) {
        // No history and the two sides differ: adopting either one is a guess, and
        // a wrong guess on a photo library is unrecoverable.
        ops.push({ rel, action: 'conflict', reason: 'no-baseline', size: localEntry.size, remoteId: remoteEntry.id, localSha, remoteSha });
        continue;
      }
      const localMoved = localSha !== base.sha256;
      const remoteMoved = remoteSha !== base.sha256;
      if (localMoved && remoteMoved) {
        ops.push({ rel, action: 'conflict', reason: 'both-changed', size: localEntry.size, remoteId: remoteEntry.id, localSha, remoteSha });
        continue;
      }
      if (localMoved) {
        ops.push({ rel, action: 'upload', reason: 'local-changed', size: localEntry.size, remoteId: remoteEntry.id, localSha, remoteVersion: remoteEntry.version });
        continue;
      }
      if (remoteMoved) {
        ops.push({ rel, action: 'download', reason: 'remote-changed', size: remoteEntry.size, remoteId: remoteEntry.id, remoteSha, remoteVersion: remoteEntry.version });
        continue;
      }
      // Unreachable by construction: if both sides differ from each other, at most
      // one of them can equal the baseline, so one branch above always fired. Kept
      // as an explicit conflict rather than a silent no-op, so a future change to
      // this table cannot make a mismatch disappear from the report.
      ops.push({ rel, action: 'conflict', reason: 'baseline-desync', size: localEntry.size, remoteId: remoteEntry.id, localSha, remoteSha });
      continue;
    }

    if (localEntry && !remoteEntry) {
      if (base === null) {
        ops.push({ rel, action: 'upload', reason: 'new', size: localEntry.size, localSha });
      } else if (localSha === base.sha256) {
        // Unchanged locally but gone remotely: a remote deletion.
        ops.push({ rel, action: 'remote-deleted', size: 0, remoteId: base.remoteId ?? null });
      } else {
        ops.push({ rel, action: 'conflict', reason: 'deleted-remotely-but-changed-locally', size: localEntry.size, localSha });
      }
      continue;
    }

    if (!localEntry && remoteEntry) {
      if (base === null) {
        ops.push({ rel, action: 'download', reason: 'remote-only', size: remoteEntry.size, remoteId: remoteEntry.id, remoteSha, remoteVersion: remoteEntry.version });
      } else if (remoteSha === base.sha256) {
        ops.push({ rel, action: 'local-deleted', size: remoteEntry.size, remoteId: remoteEntry.id, remoteSha });
      } else {
        ops.push({ rel, action: 'conflict', reason: 'deleted-locally-but-changed-remotely', size: remoteEntry.size, remoteId: remoteEntry.id, remoteSha });
      }
      continue;
    }

    // Gone on both sides: drop the dead baseline row.
    ops.push({ rel, action: 'forget', remoteId: base?.remoteId ?? null });
  }
  return ops;
}

/** Counts the plan into the summary the CLI prints before doing anything. */
export function summarize(ops) {
  const summary = { unchanged: 0, upload: 0, download: 0, conflict: 0, 'remote-deleted': 0, 'local-deleted': 0, forget: 0, bytesUp: 0, bytesDown: 0 };
  for (const op of ops) {
    summary[op.action] = (summary[op.action] ?? 0) + 1;
    if (op.action === 'upload') summary.bytesUp += op.size ?? 0;
    if (op.action === 'download') summary.bytesDown += op.size ?? 0;
  }
  return summary;
}

/* ── execution ─────────────────────────────────────────────────────────── */

/**
 * Creates the remote folders an upload plan needs, in one pass per depth.
 *
 * Called before any file moves, not lazily inside the upload loop: a file's
 * parentId must be the id of a folder that exists now. Leaving it to the upload
 * loop is how a whole photo tree lands flat in the root while every individual
 * upload reports success.
 *
 * Idempotent: a folder already in `folders` is skipped, so a resume after a crash
 * costs one listing per folder that is still missing and nothing else.
 */
async function ensureRemoteFolders(client, folders, ops, workspace, write, log = () => {}) {
  const needed = new Set();
  for (const op of ops) {
    if (op.action !== 'upload') continue;
    const dir = posix.dirname(op.rel);
    if (dir === '.') continue;
    let prefix = '';
    for (const part of dir.split('/')) {
      prefix = prefix === '' ? part : prefix + '/' + part;
      needed.add(prefix);
    }
  }
  // Shallow first: a child cannot be created before its parent exists.
  const ordered = [...needed].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  const created = [];
  for (const rel of ordered) {
    if (folders.has(rel)) continue;
    const parentRel = posix.dirname(rel);
    const parentId = folders.get(parentRel === '.' ? '' : parentRel) ?? null;
    const name = posix.basename(rel);
    const node = await write('/nodes', { name, kind: 'folder', parentId }, workspace);
    folders.set(rel, node.id);
    created.push(rel);
    log('mkdir ' + rel);
  }
  return created;
}

/**
 * Executes a plan.
 *
 * Uploading is deliberately resumable-capable and dedup-aware: the client probes
 * the sha256 first, so a file already in the store costs a pointer, not a
 * transfer. That is what makes the second run of a 70 GB library cheap even if
 * the baseline was lost.
 *
 * The three transfer functions are injected (`transfers`) rather than imported
 * directly. That is not for elegance: a test must be able to assert the
 * `parentId` an upload was given, and the flat-tree bug this file was written to
 * fix was invisible precisely because the transfer layer could not be observed.
 */
export async function executePlan(client, {
  ops, folders, localRoot, baselineEntries, options = {}, write, log,
  transfers = { instantUpload, uploadSimple, uploadResumable },
}) {
  const onConflict = options.onConflict ?? 'overwrite';
  const result = {
    uploaded: 0, downloaded: 0, deletedRemote: 0, deletedLocal: 0,
    conflicts: [], pendingDeletes: [], failed: [], bytesUp: 0, bytesDown: 0,
  };
  const next = { ...baselineEntries };

  // Folders first, always: every upload below resolves its parentId out of this
  // map, and a missing entry silently means "the root".
  await ensureRemoteFolders(client, folders, ops, options.workspace, write, log);

  for (const op of ops) {
    if (op.action === 'unchanged') {
      next[op.rel] = { sha256: op.sha256, size: op.size, remoteId: op.remoteId, version: op.remoteVersion };
      continue;
    }
    if (op.action === 'forget') { delete next[op.rel]; continue; }
    if (op.action === 'conflict') { result.conflicts.push(op); continue; }

    // A remote file whose version moved since the baseline is exactly the
    // "someone else wrote here" case. Refusing now is the only non-destructive
    // answer, and it is cheap: one metadata read.
    if (op.action === 'upload' && op.remoteId) {
      const current = await client.get('/nodes/' + encodeURIComponent(op.remoteId));
      const version = current?.node?.version;
      if (version !== undefined && op.remoteVersion !== undefined && version !== op.remoteVersion) {
        result.conflicts.push({ ...op, action: 'conflict', reason: 'remote-version-moved' });
        continue;
      }
    }

    try {
      if (op.action === 'upload') {
        const absolute = join(localRoot, ...op.rel.split('/'));
        const parentRel = posix.dirname(op.rel);
        const parentId = folders.get(parentRel === '.' ? '' : parentRel) ?? null;
        const name = posix.basename(op.rel);
        const mime = mimeFor(name);
        const dedup = await transfers.instantUpload(client, {
          filePath: absolute, name, parentId, size: op.size, mime, onConflict,
        });
        if (dedup) {
          next[op.rel] = { sha256: op.localSha, size: op.size, remoteId: dedup.node.id, version: dedup.node.version };
        } else if (shouldUseResumable(op.size)) {
          const outcome = await transfers.uploadResumable(client, {
            filePath: absolute, name, parentId, size: op.size, mime, onConflict,
            onProgress: options.onProgress,
          });
          next[op.rel] = { sha256: op.localSha, size: op.size, remoteId: outcome.node.id, version: outcome.node.version };
        } else {
          const outcome = await transfers.uploadSimple(client, {
            parentId, name, filePath: absolute, contentType: mime, onConflict,
            onProgress: options.onProgress,
          });
          next[op.rel] = { sha256: op.localSha, size: op.size, remoteId: outcome.node.id, version: outcome.node.version };
        }
        result.uploaded += 1;
        result.bytesUp += op.size ?? 0;
        log('up   ' + op.rel + '  (' + (op.reason ?? 'changed') + ')');
        continue;
      }

      if (op.action === 'download') {
        const destination = join(localRoot, ...op.rel.split('/'));
        await mkdir(dirname(destination), { recursive: true });
        await client.download('/files/' + encodeURIComponent(op.remoteId) + '/content', { destination });
        const sha256 = await hashFile(destination);
        if (op.remoteSha && sha256 !== op.remoteSha) {
          throw new CliError('Downloaded ' + op.rel + ' does not hash to the remote digest; the file on disk may be truncated.',
            EXIT.ERROR, { code: 'CHECKSUM_MISMATCH' });
        }
        next[op.rel] = { sha256: sha256 ?? op.remoteSha, size: op.size, remoteId: op.remoteId, version: op.remoteVersion };
        result.downloaded += 1;
        result.bytesDown += op.size ?? 0;
        log('down ' + op.rel + '  (' + (op.reason ?? 'changed') + ')');
        continue;
      }

      if (op.action === 'remote-deleted' || op.action === 'local-deleted') {
        if (!options.delete) {
          // Reported, never performed: "missing here" is not "delete everywhere".
          // Treating an absent file as a deletion is how a sync loses a library
          // when a drive letter changes or a folder is momentarily unavailable.
          result.pendingDeletes.push({ ...op, action: 'pending-delete' });
          continue;
        }
        if (op.action === 'remote-deleted') {
          // Unchanged locally, gone remotely → the remote deletion wins.
          const absolute = join(localRoot, ...op.rel.split('/'));
          await unlink(absolute).catch(() => {});
          result.deletedLocal += 1;
          log('del  local  ' + op.rel);
        } else {
          // Unchanged remotely, gone locally → the local deletion wins.
          await write('/nodes/' + encodeURIComponent(op.remoteId), undefined, options.workspace, 'DELETE');
          result.deletedRemote += 1;
          log('del  remote ' + op.rel);
        }
        delete next[op.rel];
        continue;
      }
    } catch (error) {
      result.failed.push({ rel: op.rel, action: op.action, message: error?.message ?? String(error) });
      log('FAIL ' + op.rel + ': ' + (error?.message ?? error));
      // The baseline is not advanced for a failed path, so the next run retries it.
    }
  }
  return { ...result, entries: next };
}

/** Stable, human-facing reason text for the summary table. */
export const REASON_TEXT = {
  new: 'new locally',
  'local-changed': 'local content changed',
  'remote-changed': 'remote content changed',
  'remote-only': 'remote only',
  'no-baseline': 'both sides differ, no history to arbitrate',
  'both-changed': 'changed on both sides',
  'baseline-desync': 'baseline out of step with remote',
  'deleted-remotely-but-changed-locally': 'deleted remotely, edited locally',
  'deleted-locally-but-changed-remotely': 'deleted locally, edited remotely',
  'remote-version-moved': 'remote version moved during the run',
  'gone-remotely': 'missing remotely',
  'gone-locally': 'missing locally',
};

export { toPosix };
