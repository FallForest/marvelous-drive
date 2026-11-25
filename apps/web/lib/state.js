/*
 * state.js — application state, route parsing and the flat-tree index.
 *
 * The navigation index holds folders and the current page's files. Visible rows
 * are paged separately so opening one directory never downloads the whole drive.
 */

/**
 * The recycle bin's deletion-time presets, in display order.
 *
 * A closed vocabulary, owned here because the route owns it: parseLocation,
 * routePath, the page request and the filter control all read this one list, so
 * the URL, the server query and the `<select>` cannot drift. The durations are
 * rolling (24h/7d/30d from now), never "today", so a preset means the same thing
 * at 00:05 and at 23:55 and in every timezone.
 */
export const TRASH_DELETED_WITHIN = Object.freeze(['24h', '7d', '30d']);

/** Whether `value` is one of the deletion-time presets. */
export function isTrashDeletedWithin(value) {
  return TRASH_DELETED_WITHIN.includes(value);
}

/**
 * The owner's link-state filter, in the same words the server accepts.
 *
 * A closed vocabulary owned by the route for the same reason as the trash's
 * presets: parseLocation, routePath, the request and the <select> all read this
 * one list, so a stale URL can never ask the server a question its own controls
 * cannot represent. "全部状态" is the empty value, not a member of the list.
 */
export const SHARE_STATES = Object.freeze(['active', 'expired', 'exhausted', 'trashed']);

/** Whether `value` is one of the link states the management list filters by. */
export function isShareState(value) {
  return SHARE_STATES.includes(value);
}

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
  if (segments[0] === 'trash') {
    // A bare /trash keeps its old one-key shape. The two optional filters are
    // added only when the URL actually carries them, the same rule /search uses,
    // so code that tests `route.name === 'trash'` keeps working unchanged.
    const route = { name: 'trash' };
    const term = params.get('q');
    if (term) route.query = term;
    const kind = params.get('kind');
    if (kind === 'file' || kind === 'folder') route.kind = kind;
    // The deletion-time preset. Unknown values are dropped here (treated as
    // "全部时间") instead of being carried into the URL: the vocabulary is
    // closed, so a stale or hand-edited value must not survive a reload.
    const deletedWithin = params.get('deletedWithin');
    if (isTrashDeletedWithin(deletedWithin)) route.deletedWithin = deletedWithin;
    return route;
  }
  if (segments[0] === 'starred') return { name: 'starred' };
  // Owner-only link management. Public links stay at /s/<token>, untouched.
  if (segments[0] === 'shares') {
    // A bare /shares keeps its old one-key shape; ?q= / ?state= are added only
    // when the URL carries a value the server would accept, so a hand-edited
    // URL cannot put a control in a state the list can never satisfy.
    const route = { name: 'shares' };
    const term = params.get('q');
    if (term) route.query = term;
    const linkState = params.get('state');
    if (isShareState(linkState)) route.state = linkState;
    return route;
  }
  if (segments[0] === 'search') {
    const route = { name: 'search', query: params.get('q') || '' };
    // Filters are optional and only present when the URL actually carries them,
    // so a plain ?q= search still produces exactly { name, query }.
    for (const key of ['folderId', 'kind', 'updatedAfter', 'scope']) {
      const value = params.get(key);
      if (value) route[key] = value;
    }
    return route;
  }
  return { name: 'notFound', pathname };
}

/** Canonical path for a route (used by pushState and by every link). */
export function routePath(route) {
  switch (route.name) {
    case 'drive': return route.folderId ? '/folder/' + encodeURIComponent(route.folderId) : '/';
    case 'trash': {
      // No filters → exactly '/trash', so old bookmarks and the sidebar entry
      // are byte-identical to what they were before the filters existed.
      // Values outside the closed vocabularies are dropped here for the same
      // reason parseLocation drops them: a URL this app builds must be one it
      // accepts back unchanged.
      const kind = route.kind === 'file' || route.kind === 'folder' ? route.kind : '';
      const deletedWithin = isTrashDeletedWithin(route.deletedWithin) ? route.deletedWithin : '';
      const query = String(route.query || '').trim();
      if (!query && !kind && !deletedWithin) return '/trash';
      const params = new URLSearchParams();
      if (query) params.set('q', query);
      if (kind) params.set('kind', kind);
      if (deletedWithin) params.set('deletedWithin', deletedWithin);
      return '/trash?' + params;
    }
    case 'starred': return '/starred';
    case 'shares': {
      // Bare /shares is the unfiltered page, byte-identical to what the sidebar
      // and old bookmarks already use. Values outside the closed state list and
      // an empty (or whitespace-only) term are dropped for the same reason
      // parseLocation drops them: a URL this app builds must parse back to the
      // same route.
      const query = String(route.query || '').trim();
      const linkState = isShareState(route.state) ? route.state : '';
      if (!query && !linkState) return '/shares';
      const params = new URLSearchParams();
      if (query) params.set('q', query);
      if (linkState) params.set('state', linkState);
      return '/shares?' + params;
    }
    case 'search': {
      const params = new URLSearchParams({ q: route.query || '' });
      // Only non-default filters reach the URL: a bare search stays /search?q=…
      if (route.folderId) params.set('folderId', route.folderId);
      if (route.kind) params.set('kind', route.kind);
      if (route.updatedAfter) params.set('updatedAfter', route.updatedAfter);
      if (route.scope && route.scope !== 'all') params.set('scope', route.scope);
      return '/search?' + params;
    }
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
      /** { hasMore, limit, offset, loading } while a search page has more hits. */
      searchMore: null,
      /** Directory/trashed/starred page metadata; selection covers loaded rows. */
      nodeMore: null,
      serverSorted: false,
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
