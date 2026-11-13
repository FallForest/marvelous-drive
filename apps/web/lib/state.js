/*
 * state.js — application state, route parsing and the flat-tree index.
 *
 * The API returns one flat list of live nodes; every screen (breadcrumb, tree,
 * folder listing, star filter) is derived from that single cache, so navigating
 * never issues a second request per folder.
 */

/** Parse location.pathname + search into a route descriptor. */
export function parseLocation(location) {
  const pathname = location.pathname || '/';
  const params = new URLSearchParams(location.search || '');
  const segments = pathname.split('/').filter(Boolean);

  if (segments[0] === 's' && segments[1]) {
    return { name: 'shared', token: decodeURIComponent(segments[1]) };
  }
  if (segments.length === 0) return { name: 'drive', folderId: null };
  if (segments[0] === 'folder' && segments[1]) return { name: 'drive', folderId: decodeURIComponent(segments[1]) };
  if (segments[0] === 'trash') return { name: 'trash' };
  if (segments[0] === 'starred') return { name: 'starred' };
  if (segments[0] === 'search') return { name: 'search', query: params.get('q') || '' };
  return { name: 'notFound', pathname };
}

/** Canonical path for a route (used by pushState and by every link). */
export function routePath(route) {
  switch (route.name) {
    case 'drive': return route.folderId ? '/folder/' + encodeURIComponent(route.folderId) : '/';
    case 'trash': return '/trash';
    case 'starred': return '/starred';
    case 'search': return '/search?q=' + encodeURIComponent(route.query || '');
    case 'shared': return '/s/' + encodeURIComponent(route.token);
    default: return '/';
  }
}

export function createStore(initial) {
  const listeners = new Set();
  const store = {
    state: Object.assign({
      user: null,
      booted: false,
      route: { name: 'drive', folderId: null },
      nodes: [],
      trash: [],
      searchResults: [],
      searchQuery: '',
      loading: false,
      loadError: null,
      view: 'list',        // list | grid
      sortKey: 'name',     // name | size | updated
      sortDir: 'asc',      // asc | desc
      selection: new Set(),
      anchorId: null,
      stats: null,
      expanded: new Set(),
      sidebarOpen: false,
      docsOpen: false,
    }, initial || {}),
    set(patch, options) {
      Object.assign(store.state, patch);
      if (!options || options.silent !== true) store.emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit() {
      for (const listener of Array.from(listeners)) {
        try { listener(store.state); } catch (error) { console.warn('[mdrive] subscriber failed', error); }
      }
    },
  };
  return store;
}

/* ── flat-tree index ──────────────────────────────────────────── */
export function buildIndex(nodes) {
  const byId = new Map();
  const children = new Map();
  for (const node of nodes) byId.set(node.id, node);
  for (const node of nodes) {
    const key = node.parentId || 'root';
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(node);
  }
  return { byId, children };
}

export function childrenOf(index, folderId) {
  return index.children.get(folderId || 'root') || [];
}

export function foldersOf(index, folderId) {
  return childrenOf(index, folderId).filter((node) => node.kind === 'folder');
}

/** Ancestors from root to the folder itself; broken chains stop at the root. */
export function ancestorPath(index, folderId) {
  const path = [];
  let current = folderId ? index.byId.get(folderId) : null;
  let guard = 0;
  while (current && guard < 64) {
    path.unshift(current);
    current = current.parentId ? index.byId.get(current.parentId) : null;
    guard += 1;
  }
  return path;
}

export function descendantIds(index, folderId) {
  const ids = new Set();
  const walk = (id) => {
    for (const child of index.children.get(id) || []) {
      ids.add(child.id);
      if (child.kind === 'folder') walk(child.id);
    }
  };
  walk(folderId);
  return ids;
}

export function isDescendant(index, candidateId, folderId) {
  let current = candidateId ? index.byId.get(candidateId) : null;
  let guard = 0;
  while (current && guard < 64) {
    if (current.parentId === folderId) return true;
    current = current.parentId ? index.byId.get(current.parentId) : null;
    guard += 1;
  }
  return false;
}

/** Folders that can receive a move: every folder except self + descendants. */
export function moveTargets(index, node) {
  const blocked = node && node.kind === 'folder' ? descendantIds(index, node.id) : new Set();
  if (node) blocked.add(node.id);
  return Array.from(index.byId.values())
    .filter((candidate) => candidate.kind === 'folder' && !blocked.has(candidate.id))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'));
}

/** flatten a folder subtree for the sidebar tree (folders only). */
export function folderTree(index) {
  const roots = foldersOf(index, null).map((node) => ({ node, depth: 0, children: [] }));
  return roots;
}

export function subtreeFolders(index, folderId) {
  return foldersOf(index, folderId);
}

export function emptySelection() { return new Set(); }
