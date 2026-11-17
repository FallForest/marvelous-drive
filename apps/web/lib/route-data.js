/** Directory pages and the small, shared navigation caches. No DOM or session state. */
export const NODE_PAGE_SIZE = 100;
const CACHE_MS = 30_000;

export function nodePagePath(route, { sortKey = 'name', sortDir = 'asc', offset = 0, limit = NODE_PAGE_SIZE } = {}) {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset), sort: sortKey, direction: sortDir });
  if (route.name === 'trash') params.set('trash', '1');
  else if (route.name === 'starred') params.set('starred', '1');
  else params.set('parentId', route.folderId || 'root');
  return '/nodes?' + params;
}

/** One cache per signed-in session. clear() also invalidates in-flight cache fills. */
export function createRouteData(api, now = Date.now) {
  let generation = 0;
  let folders = null;
  let stats = null;
  const cached = (entry, fetcher, save) => {
    if (entry && (entry.pending || now() - entry.at < CACHE_MS)) return entry.value;
    const ticket = generation;
    const next = { at: now(), pending: true, value: null };
    next.value = fetcher().then((value) => {
      next.pending = false;
      next.at = now();
      return value;
    }, (error) => {
      if (ticket === generation) save(null);
      throw error;
    });
    save(next);
    return next.value;
  };
  const loadFolders = () => cached(folders, () => api.get('/nodes?kind=folder').then((payload) => payload.nodes || []), (value) => { folders = value; });
  const loadStats = () => cached(stats, () => api.get('/storage/stats').then((payload) => payload.stats || null), (value) => { stats = value; });
  const clear = () => { generation += 1; folders = null; stats = null; };

  async function page(route, options = {}) {
    return api.get(nodePagePath(route, options));
  }

  async function load(route, options = {}) {
    if (options.force) clear();
    const rowRequest = route.name === 'search'
      ? (route.query ? api.get('/search?q=' + encodeURIComponent(route.query) + '&limit=50') : Promise.resolve({ results: [] }))
      : (async () => {
        const wanted = Math.max(NODE_PAGE_SIZE, options.count || NODE_PAGE_SIZE);
        let payload = await page(route, options);
        const rows = [...(payload.nodes || [])];
        while (payload.hasMore && Number(payload.offset) + Number(payload.limit) < wanted) {
          payload = await page(route, { ...options, offset: Number(payload.offset) + Number(payload.limit) });
          rows.push(...(payload.nodes || []));
        }
        return { ...payload, nodes: rows };
      })();
    const [payload, tree, usage] = await Promise.all([
      rowRequest,
      loadFolders(),
      loadStats().catch(() => null),
    ]);
    let navigation = tree;
    // A member can open an authorized folder outside their personal tree.
    // Detail supplies the breadcrumb without downloading the workspace's files.
    if (route.name === 'drive' && route.folderId && !tree.some((node) => node.id === route.folderId)) {
      const detail = await api.get('/nodes/' + encodeURIComponent(route.folderId));
      const path = detail.node.path || [];
      const ancestors = path.map((node, index) => ({ ...node, parentId: index ? path[index - 1].id : null }));
      navigation = tree.concat(ancestors, detail.node);
    }
    return { payload, folders: navigation, stats: usage };
  }

  return { load, page, clear };
}

/** Shared folders stay navigable; unloaded files never become visible rows. */
export function mergeNavigationNodes(folders, rows) {
  return [...new Map([...(folders || []), ...(rows || [])].map((node) => [node.id, node])).values()];
}
