import { createInterface } from 'node:readline';
import sanitizeName from '../naming.js';
import { CliError, EXIT, usageError } from '../errors.js';
import { formatBytes, formatRelative, formatTimestamp } from '../output.js';
import {
  NODE_COLUMNS,
  isUuid,
  listChildren,
  nodePath,
  nodeRow,
  optionalPositional,
  requirePath,
  requirePositional,
  resolvePath,
  splitPath
} from './support.js';

/** Resolves the "where" argument shared by ls/tree/mkdir/upload. */
async function targetFolder(client, value, { allowMissing = false } = {}) {
  if (value === undefined || value === '' || value === '/' || value === '.') {
    return { node: null, parentId: null };
  }
  if (isUuid(value)) {
    const response = await client.get('/nodes/' + encodeURIComponent(value));
    const node = response?.node ?? null;
    if (!node) throw new CliError('No node with id ' + value + '.', EXIT.ERROR, { code: 'NOT_FOUND', status: 404 });
    if (node.kind !== 'folder') {
      throw usageError('"' + value + '" is a file; pick a folder.');
    }
    return { node, parentId: node.id };
  }
  const resolved = await resolvePath(client, value);
  if (!resolved.node) {
    if (allowMissing) return { node: null, parentId: resolved.parentId, missing: resolved.missing };
    throw new CliError('No folder at "' + (resolved.missing ?? value) + '". Run "mdrive ls" to inspect the tree.', EXIT.ERROR, { code: 'NOT_FOUND', status: 404 });
  }
  if (resolved.node.kind !== 'folder') {
    throw usageError('"' + value + '" is a file (' + resolved.node.kind + '); pick a folder.');
  }
  return { node: resolved.node, parentId: resolved.node.id };
}

export const lsCommand = {
  name: 'ls',
  category: 'Files',
  summary: 'List the nodes in a folder (or the trash / starred files).',
  usage: 'ls [PATH|ID] [--trash] [--starred] [--long] [--recursive] [--workspace ID]',
  details:
    'Without a path the drive root is listed. Folders come first, then files, each group\n' +
    'sorted by name (case-insensitive), matching the API ordering.',
  flags: [
    { name: 'trash', kind: 'boolean', description: 'List trashed nodes instead of the live tree.' },
    { name: 'starred', kind: 'boolean', description: 'List starred files instead.' },
    { name: 'long', kind: 'boolean', short: 'l', description: 'Add created time and blob hash columns.' },
    { name: 'recursive', kind: 'boolean', short: 'R', description: 'Walk every subfolder.' },
    { name: 'workspace', value: 'ID', description: 'List a shared workspace instead of only your own files.' }
  ],
  positionals: [['PATH|ID', 'Folder to list; defaults to the root.', true]],
  examples: ['mdrive ls', 'mdrive ls /Projects', 'mdrive ls --trash', 'mdrive ls -l --json', 'mdrive ls --workspace <id>'],
  async handler(ctx) {
    const client = ctx.api();
    const target = optionalPositional(ctx, 0);
    const trash = ctx.flags.bool('trash');
    const starred = ctx.flags.bool('starred');
    const workspace = ctx.flags.str('workspace');
    if (trash && starred) throw usageError('--trash and --starred cannot be combined.');

    let nodes;
    let header;
    if (trash) {
      const response = await client.get('/nodes', { query: { trash: 1, workspace } });
      nodes = Array.isArray(response?.nodes) ? response.nodes : [];
      header = 'trash';
    } else if (starred) {
      const response = await client.get('/nodes', { query: { starred: 1 } });
      nodes = Array.isArray(response?.nodes) ? response.nodes : [];
      header = 'starred';
    } else {
      const folder = await targetFolder(client, target);
      const collect = async (parentId, prefix, depth) => {
        const children = await listChildren(client, parentId, workspace);
        const out = [];
        for (const child of children) {
          out.push({ node: child, prefix, depth });
          if (ctx.flags.bool('recursive') && child.kind === 'folder' && depth < 32) {
            out.push(...await collect(child.id, prefix + child.name + '/', depth + 1));
          }
        }
        return out;
      };
      const entries = await collect(folder.parentId, '', 0);
      if (ctx.out.data({ ok: true, command: 'ls', parentId: folder.parentId, nodes: entries.map(entry => entry.node) })) return 0;
      const columns = ctx.flags.bool('long')
        ? [...NODE_COLUMNS.slice(0, 4), { header: 'created', align: 'right', max: 12 }, { header: 'hash', max: 10 }, ...NODE_COLUMNS.slice(4)]
        : NODE_COLUMNS;
      const rows = entries.map(({ node, prefix }) => {
        const row = nodeRow({ ...node, name: prefix + node.name });
        if (!ctx.flags.bool('long')) return row;
        return [
          ...row.slice(0, 4),
          formatRelative(node.createdAt),
          node.blobHash ? String(node.blobHash).slice(0, 8) : '-',
          ...row.slice(4)
        ];
      });
      const label = folder.node ? folder.node.name + '/' : '/';
      ctx.out.note('listing ' + label);
      ctx.out.table(columns, rows, 'Empty folder.');
      if (!ctx.flags.bool('recursive')) {
        const folders = entries.filter(entry => entry.node.kind === 'folder').length;
        ctx.out.note(folders + ' folders, ' + (entries.length - folders) + ' files');
      }
      return 0;
    }

    if (ctx.out.data({ ok: true, command: header, nodes })) return 0;
    ctx.out.table(NODE_COLUMNS, nodes.map(nodeRow), header === 'trash' ? 'Trash is empty.' : 'No starred files.');
    return 0;
  }
};

export const treeCommand = {
  name: 'tree',
  category: 'Files',
  summary: 'Print the folder hierarchy as an indented tree.',
  usage: 'tree [PATH|ID] [--depth N] [--workspace ID]',
  flags: [
    { name: 'depth', value: 'N', description: 'Maximum depth to walk (default 8).' },
    { name: 'workspace', value: 'ID', description: 'Walk a shared workspace instead of only your own files.' }
  ],
  positionals: [['PATH|ID', 'Folder to start from; defaults to the root.', true]],
  examples: ['mdrive tree', 'mdrive tree /Projects --depth 2', 'mdrive tree --workspace <id>'],
  async handler(ctx) {
    const client = ctx.api();
    const maxDepth = ctx.flags.integer('depth', { min: 1, max: 32 }) ?? 8;
    const workspace = ctx.flags.str('workspace');
    const folder = await targetFolder(client, optionalPositional(ctx, 0));
    const lines = [];
    const flat = [];

    const walk = async (parentId, depth, prefix, path) => {
      if (depth > maxDepth) return;
      const children = await listChildren(client, parentId, workspace);
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        const last = index === children.length - 1;
        const isFolder = child.kind === 'folder';
        lines.push(prefix + (last ? '\u2514\u2500 ' : '\u251c\u2500 ') + child.name + (isFolder ? '/' : ' (' + formatBytes(child.size) + ')'));
        flat.push({ ...child, path: path + '/' + child.name });
        if (isFolder) {
          await walk(child.id, depth + 1, prefix + (last ? '   ' : '\u2502  '), path + '/' + child.name);
        }
      }
    };

    const rootLabel = folder.node ? folder.node.name + '/' : '/';
    const rootPath = folder.node ? '/' + folder.node.name : '';
    await walk(folder.parentId, 1, '', rootPath);

    if (ctx.out.data({ ok: true, command: 'tree', root: rootLabel, nodes: flat })) return 0;
    ctx.out.line(ctx.out.paint(rootLabel, 'cyan'));
    if (lines.length === 0) ctx.out.line(ctx.out.paint('  (empty)', 'dim'));
    for (const line of lines) ctx.out.line(line);
    return 0;
  }
};

export const mkdirCommand = {
  name: 'mkdir',
  category: 'Files',
  summary: 'Create a folder.',
  usage: 'mkdir PATH [--parents]',
  flags: [
    { name: 'parents', kind: 'boolean', short: 'p', description: 'Create missing intermediate folders; succeed silently when it already exists.' }
  ],
  positionals: [['PATH', 'Folder path to create, for example /Projects/2026.']],
  examples: ['mdrive mkdir /Projects', 'mdrive mkdir -p /Projects/2026/Q1'],
  async handler(ctx) {
    const raw = requirePositional(ctx, 0, 'PATH');
    const parts = splitPath(raw);
    if (parts.length === 0) throw usageError('Folder path must name at least one segment.');
    const client = ctx.api();
    let parentId = null;
    let created = null;
    let path = '';
    for (const part of parts) {
      path += '/' + part;
      const children = await listChildren(client, parentId);
      const existing = children.find(child => child.name === part || child.name.toLowerCase() === part.toLowerCase());
      if (existing) {
        if (existing.kind !== 'folder') {
          throw new CliError('"' + path + '" already exists and is a file. Pick another name.', EXIT.ERROR, { code: 'CONFLICT', status: 409 });
        }
        if (!ctx.flags.bool('parents')) {
          throw new CliError(
            'Folder "' + path + '" already exists (' + existing.id + '). Nothing to do — pick another name.',
            EXIT.ERROR,
            { code: 'CONFLICT', status: 409 }
          );
        }
        parentId = existing.id;
        created = existing;
        continue;
      }
      if (!ctx.flags.bool('parents') && part !== parts[parts.length - 1]) {
        throw usageError('Parent "' + path + '" does not exist. Add --parents to create the whole chain.');
      }
      const response = await client.post('/nodes', { name: sanitizeName(part), kind: 'folder', parentId });
      created = response?.node ?? null;
      if (!created) throw new CliError('The server did not return the new folder.', EXIT.ERROR, { code: 'PROTOCOL' });
      parentId = created.id;
    }
    if (ctx.out.data({ ok: true, command: 'mkdir', path, node: created })) return 0;
    ctx.out.success('Created folder ' + path + ' (' + created.id + ').');
    return 0;
  }
};

export const mvCommand = {
  name: 'mv',
  category: 'Files',
  summary: 'Move and/or rename a node.',
  usage: 'mv SOURCE DEST',
  details:
    'When DEST is an existing folder the node is moved into it keeping its name.\n' +
    'Otherwise the last segment of DEST becomes the new name and the rest its parent.',
  positionals: [['SOURCE', 'Node to move (path or id).'], ['DEST', 'Destination folder or new path.']],
  examples: ['mdrive mv /plan.md /Projects', 'mdrive mv /plan.md /Projects/renamed.md'],
  async handler(ctx) {
    const source = requirePositional(ctx, 0, 'SOURCE');
    const destination = requirePositional(ctx, 1, 'DEST');
    const client = ctx.api();
    const node = isUuid(source)
      ? (await client.get('/nodes/' + encodeURIComponent(source)))?.node
      : await requirePath(client, source);
    if (!node) throw new CliError('No node at "' + source + '".', EXIT.ERROR, { code: 'NOT_FOUND', status: 404 });

    const resolvedDest = await resolvePath(client, destination);
    const body = {};
    let targetLabel;
    if (resolvedDest.node && resolvedDest.node.kind === 'folder' && !isUuid(destination)) {
      body.parentId = resolvedDest.node.id;
      targetLabel = destination;
    } else if (resolvedDest.node && resolvedDest.node.id === node.id) {
      throw usageError('Cannot move a node onto itself.');
    } else {
      const parts = splitPath(destination);
      if (parts.length === 0) throw usageError('Destination must contain at least one segment.');
      const namePart = parts[parts.length - 1];
      const parentPath = '/' + parts.slice(0, -1).join('/');
      const parent = await resolvePath(client, parentPath === '/' ? '/' : parentPath);
      if (parentPath !== '/' && !parent.node) {
        throw usageError('Destination folder "' + parentPath + '" does not exist.');
      }
      if (parentPath !== '/' && parent.node.kind !== 'folder') {
        throw usageError('Destination parent "' + parentPath + '" is a file.');
      }
      body.parentId = parentPath === '/' ? null : parent.node.id;
      if (namePart !== node.name) body.name = sanitizeName(namePart);
      targetLabel = destination;
    }
    if (body.parentId === undefined && body.name === undefined) {
      if (ctx.out.data({ ok: true, command: 'mv', node, moved: false })) return 0;
      ctx.out.line('Nothing to do: "' + node.name + '" is already there.');
      return 0;
    }
    const response = await client.put('/nodes/' + encodeURIComponent(node.id), body);
    const updated = response?.node ?? node;
    if (ctx.out.data({ ok: true, command: 'mv', node: updated })) return 0;
    ctx.out.success('Moved ' + node.name + ' -> ' + targetLabel + ' (' + updated.id + ').');
    return 0;
  }
};

export const rmCommand = {
  name: 'rm',
  category: 'Files',
  summary: 'Move a node to the trash (soft delete, cascades to descendants).',
  usage: 'rm NODE... [--force]',
  details: 'Use "mdrive purge" to delete permanently and "mdrive restore" to bring it back.',
  flags: [
    { name: 'force', kind: 'boolean', short: 'f', description: 'Do not complain when a node is already gone.' }
  ],
  positionals: [['NODE...', 'One or more nodes (paths or ids).']],
  examples: ['mdrive rm /plan.md', 'mdrive rm /Projects /old.md --force'],
  async handler(ctx) {
    if (ctx.positional.length === 0) throw usageError('Missing node. Run "mdrive rm --help" for usage.');
    const client = ctx.api();
    const removed = [];
    for (const target of ctx.positional) {
      let node = null;
      try {
        node = isUuid(target) ? (await client.get('/nodes/' + encodeURIComponent(target)))?.node : await requirePath(client, target);
      } catch (error) {
        if (ctx.flags.bool('force')) continue;
        throw error;
      }
      if (!node) {
        if (ctx.flags.bool('force')) continue;
        throw new CliError('No node at "' + target + '".', EXIT.ERROR, { code: 'NOT_FOUND', status: 404 });
      }
      await client.del('/nodes/' + encodeURIComponent(node.id));
      removed.push(node);
      if (!ctx.out.json) ctx.out.line(ctx.out.paint('trashed ', 'yellow') + node.name + '  ' + node.id);
    }
    if (ctx.out.data({ ok: true, command: 'rm', removed })) return 0;
    if (removed.length === 0) ctx.out.line('Nothing to remove.');
    else ctx.out.note(removed.length + ' node(s) moved to the trash; restore with "mdrive restore ID".');
    return 0;
  }
};

export const restoreCommand = {
  name: 'restore',
  category: 'Files',
  summary: 'Restore a trashed node and its trashed descendants.',
  usage: 'restore NODE',
  positionals: [['NODE', 'Trashed node (path or id).']],
  examples: ['mdrive restore 8a1d...', 'mdrive ls --trash'],
  async handler(ctx) {
    const target = requirePositional(ctx, 0, 'NODE');
    const client = ctx.api();
    let node = null;
    if (isUuid(target)) {
      node = (await client.get('/nodes/' + encodeURIComponent(target)))?.node ?? null;
    } else {
      const response = await client.get('/nodes', { query: { trash: 1 } });
      const candidates = Array.isArray(response?.nodes) ? response.nodes : [];
      const wanted = target.replace(/^\/+/, '');
      node = candidates.find(candidate => candidate.name === wanted)
        ?? candidates.find(candidate => candidate.name.toLowerCase() === wanted.toLowerCase())
        ?? null;
    }
    if (!node) {
      throw new CliError('No trashed node named "' + target + '". List the trash with "mdrive ls --trash".', EXIT.ERROR, { code: 'NOT_FOUND', status: 404 });
    }
    const response = await client.post('/nodes/' + encodeURIComponent(node.id) + '/restore');
    const restored = response?.node ?? node;
    if (ctx.out.data({ ok: true, command: 'restore', node: restored })) return 0;
    ctx.out.success('Restored ' + restored.name + ' (' + restored.id + ').');
    return 0;
  }
};

export const purgeCommand = {
  name: 'purge',
  category: 'Files',
  summary: 'Delete a trashed node permanently (blobs are reclaimed).',
  usage: 'purge NODE... [--yes]',
  details: 'Only nodes already in the trash can be purged. This cannot be undone.',
  flags: [
    { name: 'yes', kind: 'boolean', short: 'y', description: 'Skip the interactive confirmation (required when stdin is not a TTY).' }
  ],
  positionals: [['NODE...', 'Trashed nodes (names or ids).']],
  examples: ['mdrive purge 8a1d...', 'mdrive purge /old.md --yes'],
  async handler(ctx) {
    if (ctx.positional.length === 0) throw usageError('Missing node. Run "mdrive purge --help" for usage.');
    const client = ctx.api();
    if (!ctx.flags.bool('yes')) {
      if (!process.stdin.isTTY) {
        throw usageError('purge is permanent; pass --yes when stdin is not a terminal.');
      }
      const answer = await readConfirmation('Permanently delete ' + ctx.positional.join(', ') + '? [y/N] ');
      if (!/^y(es)?$/i.test(answer.trim())) {
        ctx.out.line('Cancelled.');
        return 0;
      }
    }
    const purged = [];
    for (const target of ctx.positional) {
      const node = isUuid(target) ? (await client.get('/nodes/' + encodeURIComponent(target)))?.node : null;
      const id = node ? node.id : null;
      if (id === null) {
        const response = await client.get('/nodes', { query: { trash: 1 } });
        const candidates = Array.isArray(response?.nodes) ? response.nodes : [];
        const wanted = target.replace(/^\/+/, '');
        const match = candidates.find(candidate => candidate.name === wanted);
        if (!match) {
          throw new CliError('No trashed node named "' + target + '".', EXIT.ERROR, { code: 'NOT_FOUND', status: 404 });
        }
        await client.del('/nodes/' + encodeURIComponent(match.id) + '/permanent');
        purged.push(match);
        continue;
      }
      await client.del('/nodes/' + encodeURIComponent(id) + '/permanent');
      purged.push(node);
    }
    if (ctx.out.data({ ok: true, command: 'purge', purged })) return 0;
    for (const node of purged) ctx.out.line(ctx.out.paint('purged ', 'red') + node.name);
    return 0;
  }
};

function readConfirmation(promptText) {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(promptText, answer => {
      rl.close();
      resolve(answer);
    });
  });
}

export const starCommand = {
  name: 'star',
  category: 'Files',
  summary: 'Star or unstar a node.',
  usage: 'star NODE [--off]',
  flags: [
    { name: 'off', kind: 'boolean', description: 'Remove the star instead of adding it.' }
  ],
  positionals: [['NODE', 'Node to star (path or id).']],
  examples: ['mdrive star /plan.md', 'mdrive star /plan.md --off', 'mdrive ls --starred'],
  async handler(ctx) {
    const target = requirePositional(ctx, 0, 'NODE');
    const client = ctx.api();
    const node = isUuid(target) ? (await client.get('/nodes/' + encodeURIComponent(target)))?.node : await requirePath(client, target);
    if (!node) throw new CliError('No node at "' + target + '".', EXIT.ERROR, { code: 'NOT_FOUND', status: 404 });
    const starred = !ctx.flags.bool('off');
    const response = await client.put('/nodes/' + encodeURIComponent(node.id) + '/star', { starred });
    const value = typeof response?.starred === 'boolean' ? response.starred : starred;
    if (ctx.out.data({ ok: true, command: 'star', id: node.id, name: node.name, starred: value })) return 0;
    ctx.out.success((value ? 'Starred ' : 'Unstarred ') + node.name + '.');
    return 0;
  }
};

export const cpCommand = {
  name: 'cp',
  category: 'Files',
  summary: 'Copy a file or folder (folders copy recursively).',
  usage: 'cp SOURCE [DEST] [--name NAME] [--parent PATH]',
  flags: [
    { name: 'name', value: 'NAME', description: 'Name for the copy.' },
    { name: 'parent', value: 'PATH', description: 'Destination folder path or id.' }
  ],
  positionals: [['SOURCE', 'Node to copy (path or id).'], ['DEST', 'Destination folder or new path.', true]],
  examples: ['mdrive cp /plan.md', 'mdrive cp /plan.md /Archive', 'mdrive cp /plan.md --name plan-copy.md'],
  async handler(ctx) {
    const source = requirePositional(ctx, 0, 'SOURCE');
    const destination = optionalPositional(ctx, 1);
    const client = ctx.api();
    const node = isUuid(source) ? (await client.get('/nodes/' + encodeURIComponent(source)))?.node : await requirePath(client, source);
    if (!node) throw new CliError('No node at "' + source + '".', EXIT.ERROR, { code: 'NOT_FOUND', status: 404 });

    const body = {};
    const parentFlag = ctx.flags.str('parent');
    if (parentFlag !== undefined) {
      const folder = await targetFolder(client, parentFlag);
      body.parentId = folder.parentId;
    }
    if (destination !== undefined) {
      const resolvedDest = await resolvePath(client, destination);
      if (resolvedDest.node && resolvedDest.node.kind === 'folder') {
        body.parentId = resolvedDest.node.id;
      } else {
        const parts = splitPath(destination);
        const namePart = parts[parts.length - 1];
        const parentPath = '/' + parts.slice(0, -1).join('/');
        const parent = await resolvePath(client, parentPath === '/' ? '/' : parentPath);
        if (parentPath !== '/' && !parent.node) throw usageError('Destination folder "' + parentPath + '" does not exist.');
        body.parentId = parentPath === '/' ? null : parent.node.id;
        body.name = sanitizeName(namePart);
      }
    }
    const nameFlag = ctx.flags.str('name');
    if (nameFlag !== undefined) body.name = sanitizeName(nameFlag);

    const response = await client.post('/nodes/' + encodeURIComponent(node.id) + '/copy', body);
    const created = response?.node ?? null;
    if (!created) throw new CliError('The server did not return the copy.', EXIT.ERROR, { code: 'PROTOCOL' });
    if (ctx.out.data({ ok: true, command: 'cp', node: created })) return 0;
    ctx.out.success('Copied to ' + created.name + ' (' + created.id + ').');
    return 0;
  }
};

export const statCommand = {
  name: 'stat',
  category: 'Files',
  summary: 'Show every field of one node, plus its absolute path and URLs.',
  usage: 'stat NODE',
  positionals: [['NODE', 'Node to inspect (path or id).']],
  examples: ['mdrive stat /plan.md', 'mdrive stat 8a1d... --json'],
  async handler(ctx) {
    const target = requirePositional(ctx, 0, 'NODE');
    const client = ctx.api();
    const response = isUuid(target)
      ? await client.get('/nodes/' + encodeURIComponent(target))
      : null;
    const node = response?.node ?? (isUuid(target) ? null : await requirePath(client, target));
    if (!node) throw new CliError('No node at "' + target + '".', EXIT.ERROR, { code: 'NOT_FOUND', status: 404 });
    const detail = response?.node ? node : (await client.get('/nodes/' + encodeURIComponent(node.id)))?.node ?? node;
    const path = await nodePath(client, detail);
    if (ctx.out.data({ ok: true, command: 'stat', path, node: detail })) return 0;
    const rows = [
      ['id', detail.id],
      ['name', detail.name],
      ['path', path],
      ['kind', detail.kind],
      ['size', detail.kind === 'folder' ? '-' : formatBytes(detail.size) + ' (' + detail.size + ' bytes)'],
      ['mime', detail.mime ?? '-'],
      ['version', String(detail.version ?? 1)],
      ['starred', detail.starred ? 'yes' : 'no'],
      ['parent', detail.parentId ?? '(root)'],
      ['children', detail.children === undefined ? '-' : String(detail.children)],
      ['created', formatTimestamp(detail.createdAt)],
      ['updated', formatTimestamp(detail.updatedAt) + ' (' + formatRelative(detail.updatedAt) + ')'],
      ['deleted', detail.deletedAt ? formatTimestamp(detail.deletedAt) : '-'],
      ['blob', detail.blobHash ?? '-'],
      ['download', detail.downloadUrl ?? '-'],
      ['preview', detail.previewUrl ?? '-']
    ];
    ctx.out.fields(rows);
    return 0;
  }
};

export { targetFolder };