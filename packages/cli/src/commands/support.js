import { CliError, EXIT, usageError } from '../errors.js';
import { formatBytes, formatRelative, truncate } from '../output.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export { formatBytes, formatRelative, truncate };

export function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function requirePositional(ctx, index, label) {
  const value = ctx.positional[index];
  if (value === undefined || value === '') {
    throw usageError('Missing ' + label + '. Run "mdrive ' + ctx.commandName + ' --help" for usage.');
  }
  return value;
}

export function optionalPositional(ctx, index) {
  const value = ctx.positional[index];
  return value === undefined || value === '' ? undefined : value;
}

export function uuidArgument(value, label) {
  if (!isUuid(value)) {
    throw usageError(label + ' must be a uuid, received "' + value + '". Use "mdrive ls" to list ids.');
  }
  return value;
}

/* ── paths ─────────────────────────────────────────────────────────────── */

/** Splits "/a/b/c" into ["a", "b", "c"], dropping empty segments. */
export function splitPath(value) {
  return String(value)
    .split(/[\\/]+/)
    .map(part => part.trim())
    .filter(part => part !== '');
}

export function normalizePath(value) {
  return '/' + splitPath(value).join('/');
}

export function joinPath(parent, name) {
  const base = normalizePath(parent ?? '/');
  return base === '/' ? '/' + name : base + '/' + name;
}

/**
 * Lists one folder; parentId null lists the drive root.
 *
 * `workspace` widens the scope to a whole shared workspace. It has to travel with
 * the listing, otherwise a recursive walk would silently fall back to the
 * caller's own files halfway down the tree.
 */
export async function listChildren(client, parentId, workspace) {
  const response = await client.get('/nodes', {
    // `root` rather than `undefined`: an absent parentId means "the whole tree" in
    // the API, which made a root listing show every file at every depth.
    query: { parentId: parentId ?? 'root', workspace: workspace ?? undefined }
  });
  return Array.isArray(response?.nodes) ? response.nodes : [];
}

/** The workspaces the caller belongs to, as `[{ id, name, role, ownerId }]`. */
export async function listWorkspaces(client) {
  const payload = await client.get('/workspace/members');
  const workspace = payload?.workspace;
  return workspace ? [workspace] : [];
}

/**
 * Resolves "/Projects/2026/plan.md" segment by segment.
 *
 * @returns {Promise<{node: object|null, missing: string|null}>}
 */
export async function resolvePath(client, path, workspace) {
  const parts = splitPath(path);
  let parentId = null;
  let node = null;
  const consumed = [];
  for (const part of parts) {
    const children = await listChildren(client, parentId, workspace);
    const match = children.find(child => child.name === part)
      ?? children.find(child => child.name.toLowerCase() === part.toLowerCase());
    if (!match) {
      return { node: null, missing: joinPath('/' + consumed.join('/'), part) };
    }
    node = match;
    consumed.push(match.name);
    parentId = match.id;
    if (match.kind !== 'folder' && consumed.length < parts.length) {
      return { node: null, missing: joinPath('/' + consumed.join('/'), parts[consumed.length]) };
    }
  }
  return { node, missing: null };
}

/** resolvePath, but fails with an actionable message when the node is absent. */
export async function requirePath(client, path, workspace) {
  const resolved = await resolvePath(client, path, workspace);
  if (!resolved.node) {
    throw new CliError(
      'No node at "' + (resolved.missing ?? path) + '". Run "mdrive ls" to inspect the tree.',
      EXIT.ERROR,
      { code: 'NOT_FOUND', status: 404 }
    );
  }
  return resolved.node;
}

/** Absolute path of a node, walking parentId links (cached per call). */
export async function nodePath(client, node, cache = new Map()) {
  const parts = [node.name];
  let current = node;
  const guard = new Set();
  while (current && current.parentId && !guard.has(current.parentId)) {
    guard.add(current.parentId);
    let parent = cache.get(current.parentId);
    if (!parent) {
      const response = await client.get('/nodes/' + encodeURIComponent(current.parentId));
      parent = response?.node ?? null;
      if (parent) cache.set(parent.id, parent);
    }
    if (!parent) break;
    parts.unshift(parent.name);
    current = parent;
  }
  return '/' + parts.join('/');
}

/* ── rendering ─────────────────────────────────────────────────────────── */

export const NODE_COLUMNS = [
  { header: 'kind', max: 6 },
  { header: 'size', align: 'right', max: 10 },
  { header: 'version', align: 'right', max: 7 },
  { header: 'updated', align: 'right', max: 12 },
  { header: 'id', max: 36 },
  { header: 'name' }
];

export function nodeRow(node) {
  const folder = node.kind === 'folder';
  return [
    { text: folder ? 'folder' : 'file', color: folder ? 'cyan' : undefined },
    folder ? '-' : formatBytes(node.size),
    folder ? '-' : 'v' + (node.version ?? 1),
    formatRelative(node.updatedAt ?? node.createdAt),
    node.id,
    (node.starred ? '* ' : '') + truncate(node.name, 60)
  ];
}