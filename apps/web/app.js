/*
 * app.js — Marvelous Drive single page shell.
 *
 * This file is now only the shell and the boot sequence. It owns the process:
 * routing, the mounted chrome, and the wiring that hands each module its verbs.
 *
 * What used to be here (and is now its own module):
 *   lib/views.js    the four top-level pages, the skeleton, the status bar
 *   lib/context.js  the handler table every view is handed
 *   lib/actions.js  open / rename / move / delete / restore / share / download
 *   lib/uploads.js  the file picker, the upload menu, the batch toasts
 *   lib/dnd.js      row drags, folder drop targets, desktop file drops
 *   lib/session.js  the shared mutable state those modules agree through
 *   lib/runtime.js  the verbs they call back into the shell with
 */

import { h, raw, mount } from './lib/dom.js';
import { icon, bytes } from './lib/format.js';
import { api, request, putRaw, onUnauthorized, getToken } from './lib/api.js';
import { toast, closeTopLayer } from './lib/ui.js';
import { renderAuth } from './lib/auth.js';
import { renderSidebar, renderBreadcrumb, renderToolbar } from './lib/sidebar.js';
import { renderShared } from './lib/share.js';
import { createSharesView } from './lib/shares-view.js';
import { createQueuePanel } from './lib/queue.js';
import { createUploader } from './lib/upload-queue.js';
import { parseLocation, routePath, buildIndex, ancestorPath } from './lib/state.js';
import {
  DURATION, MOTION_ATTRS, STAGGER, announceEntrance, markAnimating, onceOnRoute, prefersReducedMotion, withViewTransition,
} from './lib/motion.js';
import { store, session } from './lib/session.js';
import { createRouteData, mergeNavigationNodes, searchPagePath, NODE_PAGE_SIZE } from './lib/route-data.js';
import { runtime, wire } from './lib/runtime.js';
import { viewContent, statusContent, titleFor } from './lib/views.js';
import { buildContext, restoreSearchFocus } from './lib/context.js';
import { loadDirectoryPrefs } from './lib/directory-prefs.js';
import {
  openPreviewFor, lookupNode, startRename, startDelete, startPurge, deleteSelection, restoreSelection, moveSelection,
  downloadSelection, downloadSelectionArchive, downloadFolderArchive,
} from './lib/actions.js';
import { downloadEntry, downloadCenter } from './lib/downloads.js';
import { captureFocusAddress, focusRouteContent, restoreFocusAddress } from './lib/focus.js';
import { shortcutsEnabled } from './lib/shortcuts.js';
import { attachDropZone } from './lib/dnd.js';
import { pickFiles, pickUploadKind, uploadFiles, uploadFolderPlan, restoreUploads, currentParentId } from './lib/uploads.js';

/* One uploader for the page: the queue panel is its view, so every path (toolbar,
   drop, folder plan) shares the same 3-slot scheduler and pause switch. */
const queue = createQueuePanel({
  onTogglePause: (paused) => { if (paused) uploader.pauseAll(); else uploader.resumeAll(); },
  onClearFinished: () => uploader.clearFinished(),
});
const uploader = createUploader({ queue, api: { request, putRaw } });

const root = document.getElementById('app');
const routeData = createRouteData(api);
/* The public preview drawer lives outside the shell and outside body's flow, so
   it must be torn down explicitly when a public link is left by back/forward. */
let sharedView = null;
/* The owner's link-management page is built once per visit and re-mounted on a
   local repaint: rebuilding it every render would refetch page one each time
   the toolbar, the sidebar or the scroll state changed. */
let sharesPage = null;

/* ═══ routing ══════════════════════════════════════════════════ */
function navigate(path, options) {
  const opts = options || {};
  const current = window.location.pathname + window.location.search;
  if (current === path) { handleRoute(); return; }
  if (opts.replace) window.history.replaceState({}, '', path);
  else window.history.pushState({}, '', path);
  handleRoute();
}

window.addEventListener('popstate', () => handleRoute());

async function handleRoute() {
  const route = parseLocation(window.location);
  store.state.route = route;
  // A navigation is a dismissal: on a phone the drawer must not stay over the
  // page the user just asked for.
  if (session.shellEls && session.shellEls.shell.classList.contains('nav-open')) setNavOpen(false);
  if (sharedView) { sharedView.destroy(); sharedView = null; }
  // Leaving the management page (or re-entering it) starts from a fresh list,
  // so a link revoked elsewhere can never be shown as still valid.
  if (route.name !== 'shares') sharesPage = null;

  if (route.name === 'shared') {
    session.shellEls = null;
    session.paintedToken = null;
    sharedView = renderShared(root, route.token, { onHome: () => navigate('/') });
    return;
  }
  if (route.name === 'notFound') { navigate('/', { replace: true }); return; }
  if (!getToken()) { mountAuth(); return; }
  if (!store.state.user) {
    const user = await bootstrapSession();
    if (!user) return;
  }
  // The owner's links are not part of the file tree, so they take neither a
  // node page nor the directory preferences: the shell is mounted and the page
  // loads its own first page.
  if (route.name === 'shares') {
    store.state.loading = false;
    store.state.loadError = null;
    store.state.nodes = [];
    store.state.trash = [];
    store.state.searchResults = [];
    store.state.searchMore = null;
    store.state.nodeMore = null;
    store.state.selection = new Set();
    store.state.anchorId = null;
    if (!session.index) session.index = buildIndex([]);
    paintRoute(route);
    return;
  }
  // The directory's own list/grid + sort must be in place before the load paints
  // it. Non-drive routes and a blocked storage leave the state as it was.
  loadDirectoryPrefs(store.state);
  await loadRoute(route);
}

async function bootstrapSession() {
  try {
    const payload = await api.get('/me');
    store.state.user = payload && payload.user ? payload.user : null;
    return store.state.user;
  } catch (error) {
    if (!getToken()) { mountAuth(); return null; }
    toast((error && error.message) || '无法读取账号信息。', { type: 'error' });
    mountAuth();
    return null;
  }
}

/* ═══ data ═════════════════════════════════════════════════════ */
/**
 * Sequence number of the load that owns the store.
 *
 * Every loadRoute() call takes the next ticket and may only commit while it is
 * still the newest. Without it, two searches that finish out of order leave the
 * URL and the input on one query and the results on another: the loser of the
 * race was simply the slower request, and it painted last. The ticket is a
 * counter rather than an AbortController because three requests run in parallel
 * per load and their responses are still useful as long as the route has not
 * moved on.
 */
let routeLoadSeq = 0;

async function loadRoute(route, options) {
  const opts = options || {};
  // A refresh after a batch action is not a navigation: the rows that are still
  // there keep their ticks (a failed delete must stay selected for a retry), and
  // only ids that no longer exist are dropped. A route change still starts clean.
  const carried = opts.keepSelection ? new Set(store.state.selection) : null;
  const ticket = ++routeLoadSeq;
  const current = () => ticket === routeLoadSeq && store.state.route === route;
  store.state.loading = true;
  store.state.loadError = null;
  // The skeleton is a loading state, not a navigation: paint it plainly and
  // leave the route token alone, so the cross-fade lands on the real content
  // instead of freezing the skeleton into the "old" snapshot.
  renderShell();

  try {
    const result = await routeData.load(route, {
      sortKey: store.state.sortKey,
      sortDir: store.state.sortDir,
      force: opts.force === true,
      count: opts.keepSelection && store.state.nodeMore ? store.state.nodeMore.offset + NODE_PAGE_SIZE : NODE_PAGE_SIZE,
    });
    if (!current()) return;
    const payload = result.payload;
    const rows = route.name === 'search' ? (payload.results || []) : (payload.nodes || []);
    store.state.stats = result.stats || store.state.stats;
    session.navigationNodes = result.folders;
    session.index = buildIndex(mergeNavigationNodes(result.folders, rows));
    store.state.nodes = route.name === 'trash' || route.name === 'search' ? [] : rows;
    store.state.trash = route.name === 'trash' ? rows : [];
    store.state.serverSorted = route.name !== 'search';
    store.state.searchResults = route.name === 'search' ? rows : [];
    store.state.searchQuery = route.name === 'search' ? route.query || '' : '';
    store.state.searchMore = route.name === 'search' && payload.hasMore
      ? { hasMore: true, limit: Number(payload.limit) || 50, offset: Number(payload.offset) || 0, loading: false }
      : null;
    store.state.nodeMore = route.name === 'search' ? null : {
      hasMore: Boolean(payload.hasMore), limit: Number(payload.limit) || NODE_PAGE_SIZE,
      offset: Number(payload.offset) || 0, loading: false,
    };
    store.state.loading = false;
    store.state.selection = carried ? keepLiveIds(carried, session.index) : new Set();
    store.state.anchorId = null;
    paintRoute(route);
  } catch (error) {
    // A failed request from a route the user already left must not paint an
    // error over the page they are looking at now.
    if (!current()) return;
    store.state.loading = false;
    store.state.loadError = error && error.status === 0
      ? '无法连接服务器，请确认 Drive 服务正在运行。'
      : (error && error.message) || '加载失败。';
    paintRoute(route);
  }
}

/**
 * Fetches the next page of search results.
 *
 * Append, never replace: the first page stays on screen while the second
 * arrives, and a failed page leaves the list exactly as it was.
 */
async function loadMoreSearch() {
  const more = store.state.searchMore;
  if (!more || !more.hasMore || more.loading || store.state.route.name !== 'search') return;
  const route = store.state.route;
  const ticket = routeLoadSeq;
  const current = () => ticket === routeLoadSeq && store.state.route === route && store.state.searchMore === more;
  more.loading = true;
  runtime.renderShell();
  try {
    const payload = await api.get(searchPagePath(route, {
      limit: more.limit,
      offset: more.offset + more.limit,
    }));
    if (!current()) return;
    const page = payload && Array.isArray(payload.results) ? payload.results : [];
    store.state.searchResults = mergeNavigationNodes(store.state.searchResults, page);
    session.index = buildIndex(mergeNavigationNodes(session.navigationNodes, store.state.searchResults));
    more.offset = Number(payload.offset) || (more.offset + more.limit);
    more.hasMore = Boolean(payload.hasMore);
  } catch (error) {
    if (current()) toast((error && error.message) || '加载更多结果失败。', { type: 'error' });
  } finally {
    if (current()) { more.loading = false; runtime.renderShell(); }
  }
}

/** Load another current-directory page without discarding the current selection. */
async function loadMoreNodes() {
  const more = store.state.nodeMore;
  if (!more || !more.hasMore || more.loading) return;
  const route = store.state.route;
  const ticket = routeLoadSeq;
  const current = () => ticket === routeLoadSeq && store.state.route === route && store.state.nodeMore === more;
  more.loading = true;
  runtime.renderShell();
  try {
    const payload = await routeData.page(route, {
      sortKey: store.state.sortKey, sortDir: store.state.sortDir,
      limit: more.limit, offset: more.offset + more.limit,
    });
    if (!current()) return;
    const field = route.name === 'trash' ? 'trash' : 'nodes';
    store.state[field] = mergeNavigationNodes(store.state[field], payload.nodes);
    session.index = buildIndex(mergeNavigationNodes(session.navigationNodes, store.state[field]));
    more.offset = Number(payload.offset) || (more.offset + more.limit);
    more.hasMore = Boolean(payload.hasMore);
  } catch (error) {
    if (current()) toast((error && error.message) || '加载更多文件失败。', { type: 'error' });
  } finally {
    if (current()) { more.loading = false; runtime.renderShell(); }
  }
}

/**
 * Paint the current route, cross-fading only when the route actually changed.
 *
 * A local re-render (star toggle, sort, view switch) keeps the same token and
 * must not run a transition: the chrome would flicker and every entrance in the
 * page would be muted for the duration.
 */
function paintRoute(route) {
  const token = routeToken(route);
  const changed = session.paintedToken !== null && session.paintedToken !== token;
  session.paintedToken = token;
  // A real navigation re-mounts the view, which detaches whatever row had focus
  // and drops the caret on <body>. Flag it so the repaint can put the caret back
  // on the new page's heading (UI13) — but only when the navigation came from the
  // keyboard: a mouse user who clicks a folder should not be teleported to the
  // heading and lose the scroll position they were aiming at.
  if (changed) session.pendingRouteFocus = session.keyboardNav === true;
  if (!changed) { renderShell(); return; }
  withViewTransition(() => renderShell(), { reduced: prefersReducedMotion() });
}

/**
 * Reloads the current route after a mutation.
 *
 * The 120ms window coalesces the bursts a single gesture can produce (a drag
 * that moves ten rows, a batch delete). It must not, however, *drop* the last
 * call: a second mutation that starts inside the window still changes server
 * state, and returning a resolved promise without refreshing left the UI
 * showing the state from before it — a star toggled twice in quick succession
 * ended up unstarred on the server and painted as starred.
 *
 * Callers are queued rather than sharing one in-flight promise. A run takes
 * only the waiters queued when it starts, so a caller that arrives while that
 * load is running belongs to the next batch and waits for its own loadRoute —
 * not for a previous one. Each batch settles exactly its own waiters and then
 * schedules the next batch (if any) in `finally`, so a failed load cannot wedge
 * the queue. `mountAuth` bumps `refreshGeneration` and empties the queue so a
 * sign-out/sign-in cannot let old-account loads settle new waiters.
 */
let refreshTimer = null;
let refreshWaiters = [];
let refreshBatch = null;
let refreshGeneration = 0;

function scheduleRefresh() {
  if (refreshTimer || refreshBatch || !refreshWaiters.length) return;
  const wait = Math.max(0, 120 - (Date.now() - session.lastRefreshAt));
  if (wait === 0) { startRefresh(); return; }
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    startRefresh();
  }, wait);
  if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
}

function startRefresh() {
  if (refreshBatch || !refreshWaiters.length) return;
  const batch = refreshWaiters;
  refreshWaiters = [];
  const generation = refreshGeneration;
  session.lastRefreshAt = Date.now();
  refreshBatch = batch;
  const settle = () => {
    // `refreshBatch` may already have been disowned by mountAuth; only clear it
    // when this is still the current batch.
    if (refreshBatch === batch) refreshBatch = null;
    for (const waiter of batch) waiter.resolve();
    // A refresh that started before mountAuth must not schedule work for the
    // next account. Waiters added after it are already in refreshWaiters.
    if (generation === refreshGeneration) scheduleRefresh();
  };
  let run;
  try {
    // On the links page a refresh reloads the link list; loadRoute() would ask
    // for a node page the route does not have and paint an empty drive over it.
    if (store.state.route && store.state.route.name === 'shares' && sharesPage) {
      run = sharesPage.reload();
    } else {
      run = loadRoute(store.state.route, { keepSelection: true, force: true });
    }
  } catch (error) {
    settle();
    return;
  }
  Promise.resolve(run).then(settle, settle);
}

function refreshData() {
  const waiter = {};
  waiter.promise = new Promise((resolve) => { waiter.resolve = resolve; });
  refreshWaiters.push(waiter);
  scheduleRefresh();
  return waiter.promise;
}

/** Selected ids that still exist in the refreshed tree. */
function keepLiveIds(ids, index) {
  const live = new Set();
  for (const id of ids) if (index.byId.has(id)) live.add(id);
  return live;
}

/* ═══ auth ═════════════════════════════════════════════════════ */
function mountAuth() {
  routeLoadSeq += 1;
  // Any refresh queued or running belongs to the account that just left. Stop
  // the timer, disown the in-flight batch (its own loadRoute still settles its
  // waiters) and release queued waiters that will never run, so no caller is
  // left hanging and no old-account response settles a promise of this session.
  refreshGeneration += 1;
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
  refreshBatch = null;
  const abandoned = refreshWaiters;
  refreshWaiters = [];
  for (const waiter of abandoned) waiter.resolve();
  session.lastRefreshAt = 0;
  routeData.clear();
  session.navigationNodes = [];
  session.index = buildIndex([]);
  store.state.nodes = [];
  store.state.trash = [];
  store.state.stats = null;
  store.state.nodeMore = null;
  store.state.searchMore = null;
  store.state.user = null;
  session.shellEls = null;
  session.selectionSlot = null;
  session.paintedToken = null;
  // Download rows carry file names from the account that just signed out; the
  // panel is closed and emptied so the next login never sees them.
  downloadCenter().reset();
  if (session.authHandle && session.authHandle.destroy) session.authHandle.destroy();
  session.authHandle = renderAuth(root, {
    onSuccess: async (user) => {
      store.state.user = user || null;
      if (!store.state.user) await bootstrapSession();
      const route = parseLocation(window.location);
      // A private bookmark may be the public page, the owner's links page or the
      // trash (query included); re-running the route keeps the visitor where the
      // link points instead of dropping them on the drive root.
      if (route.name === 'shared' || route.name === 'shares' || route.name === 'trash') { handleRoute(); return; }
      navigate(routePath({ name: 'drive', folderId: route.folderId || null }), { replace: true });
    },
  });
}

onUnauthorized(() => {
  if (store.state.route.name === 'shared') return;
  const wasSignedIn = !!store.state.user;
  store.state.user = null;
  if (wasSignedIn) toast('登录已过期，请重新登录。', { type: 'warning' });
  mountAuth();
});

/* ═══ shell ════════════════════════════════════════════════════ */
function renderShell() {
  const state = store.state;
  if (!state.user) { mountAuth(); return; }
  // Where the caret is, in terms a re-render can find again. Every rebuild of
  // the view detaches the element the user is standing on, so a mutation that
  // repaints the list (a star toggle, a rename, a refresh after a delete) used
  // to leave the caret on <body> — the next Tab restarted at the top of the
  // document and the next Space went nowhere. Taken here rather than in
  // refreshData() so every repaint heals, including a sort or a view switch.
  const focusBefore = captureFocusAddress(session.shellEls && session.shellEls.viewEl);
  if (session.authHandle && session.authHandle.destroy) { session.authHandle.destroy(); session.authHandle = null; }
  restoreUploads(uploader);

  if (!session.shellEls) {
    const sidebarHost = h('div', { style: { display: 'contents' } });
    const topbar = h('header', { class: 'topbar' });
    const toolbar = h('div', { class: 'toolbar', attrs: { role: 'toolbar', 'aria-label': '文件操作' } });
    // data-vt-scope marks the surface a navigation swaps: View Transitions
    // snapshots this column only, so the sidebar never cross-fades with it.
    const viewEl = h('main', { class: 'view', attrs: { id: 'view', tabindex: '-1', 'data-vt-scope': 'main' } });
    const statusbar = h('div', { class: 'statusbar', attrs: { role: 'status', 'aria-live': 'polite' } });
    const main = h('div', { class: 'main' }, topbar, toolbar, viewEl, statusbar);
    const skip = h('a', {
      class: 'skip-link',
      attrs: { href: '#view' },
      text: '跳到文件列表',
      on: { click: (event) => { event.preventDefault(); viewEl.focus(); } },
    });
    const shell = h('div', {
      class: 'app-shell', attrs: { id: 'shell' },
      // The off-canvas drawer is dismissed by the scrim the stylesheet paints
      // (base.css ::after). A pseudo-element is not a click target, so the tap
      // arrives on the shell itself — which is exactly how we tell "tapped the
      // scrim" from "tapped a row".
      on: { click: (event) => { if (event.target === shell && shell.classList.contains('nav-open')) setNavOpen(false); } },
    }, skip, sidebarHost, main);
    session.shellEls = { shell, sidebarHost, topbar, toolbar, viewEl, statusbar };
    root.replaceChildren(shell);
    attachDropZone(shell);
  }

  const route = state.route;
  const ancestors = route.name === 'drive' && route.folderId ? ancestorPath(session.index, route.folderId) : [];
  session.selectionSlot = h('div', { class: 'selection-slot' });
  const ctx = buildContext(ancestors, session.selectionSlot);

  mount(session.shellEls.sidebarHost, renderSidebar(ctx));
  // renderSidebar() replaces the element, so the attribute has to be re-applied
  // on every render rather than only when the drawer is toggled.
  syncNavInert();
  mount(session.shellEls.topbar, topbarContent(ctx));
  session.shellEls.toolbar.hidden = route.name === 'search';
  mount(session.shellEls.toolbar,
    h('div', { class: 'toolbar-default' }, renderToolbar(ctx)),
    // The selection bar lives beside the default controls inside the same
    // toolbar. Search owns the slot region instead; its view mounts its own.
    route.name === 'search' ? null : session.selectionSlot);
  mount(session.shellEls.viewEl, route.name === 'shares' ? sharesViewContent(route) : viewContent(ctx));
  mount(session.shellEls.statusbar, route.name === 'shares' ? sharesStatusContent() : statusContent());
  // The view is only in the document at this point. A paint that ran while it was
  // being built found the selection slot detached and skipped the bar, which is
  // how a refresh after a partly failed delete lost the visible retry affordance
  // even though the selection itself survived. Re-assert it on a whole shell.
  if (store.state.selection.size) paintSelection();
  document.title = route.name === 'shares' ? '我分享的 · Marvelous Drive' : titleFor(route);
  restoreSearchFocus();
  // restoreSearchFocus() wins when the user was typing: the caret belongs in the
  // field they were using, not on the heading of the page it landed on.
  if (session.pendingRouteFocus) {
    session.pendingRouteFocus = false;
    focusRouteContent(session.shellEls.viewEl);
  } else if (focusBefore) {
    // No navigation asked for the heading, so put the caret back where it was.
    // A row that still exists gets its control back; the route-focus case above
    // deliberately wins because there the user moved to a different page.
    restoreFocusAddress(session.shellEls.viewEl, focusBefore);
  }
  playViewEntrance(route);
}

/**
 * The page root enters once per navigation, never per render.
 *
 * renderShell runs for every local state change too (a star toggle, a sort, a
 * view switch), and an entrance driven by "the class is present" would replay
 * on all of them. onceOnRoute keys the run on the route token, so only a real
 * navigation — a different folder, tab or query — plays it.
 */
function playViewEntrance(route) {
  if (!session.shellEls || !session.shellEls.viewEl) return;
  // A loading skeleton is not the page. Recording its token here would make the
  // real content count as "already entered" and the list would never animate.
  if (store.state.loading) return;
  const view = session.shellEls.viewEl;
  const token = routeToken(route);

  // A view transition already cross-fades this column. Adding the entrance
  // class on top would animate the page twice — and worse, the class outlives
  // the transition, so the entrance would replay the moment the flag clears.
  // Record the token (so the next local render does not replay either) and stop.
  if (document.documentElement.hasAttribute(MOTION_ATTRS.swapAttr)) {
    view.classList.remove(MOTION_ATTRS.enterClass);
    onceOnRoute(view, token, { reduced: true });
    return;
  }

  if (!onceOnRoute(view, token)) return;

  // The root holds .motion-enter only for as long as the entrance runs. Rows
  // stagger off that class (see app.css), so leaving it on would replay the
  // whole list on the next local re-render — a star toggle, a sort, a selection.
  //
  // The settle timer is the LAST row's end, not the root's: the root's own
  // animation finishes at 220ms while row 10 is still waiting out its 280ms
  // delay. Removing the class then cancels those rows mid-flight, and a
  // cancelled animation has no fill — they snap back to opacity:0, which is
  // exactly the flash this system exists to prevent.
  markAnimating(view);
  setTimeout(() => {
    view.classList.remove(MOTION_ATTRS.enterClass);
  }, DURATION.base + STAGGER.cap * STAGGER.step + 120);

  if (prefersReducedMotion()) return;
  // announceEntrance owns both the cap and the `--i` write, so no component
  // ever computes Math.min(index, 10) itself. Decking the rows happens only
  // here — a list that arrives any other way (a new upload, a re-sort) simply
  // appears, because "everything redraws" is not an entrance.
  const rows = Array.from(view.querySelectorAll('.list-body > .frow'));
  const cards = Array.from(view.querySelectorAll('.grid > .gcard'));
  announceEntrance(rows);
  announceEntrance(cards, { from: rows.length });
}

/** Route changes get ONE entrance: either the cross-fade or the row stagger. */

/**
 * Keep the off-canvas sidebar out of the tab order while it is closed.
 *
 * The drawer is moved off-screen with a transform, which hides it from the eye
 * and from nothing else: Tab still walked into its search field at x=-238 and
 * the caret vanished off the left edge (UI12). `inert` removes the subtree from
 * hit-testing, the tab order and the accessibility tree in one attribute, and it
 * is only applied at the width where the sidebar really is a drawer — on a wide
 * window the same element is the permanent column and must stay reachable.
 */
const narrowLayout = typeof window.matchMedia === 'function' ? window.matchMedia('(max-width:880px)') : null;

function syncNavInert() {
  const shell = session.shellEls ? session.shellEls.shell : document.getElementById('shell');
  if (!shell) return;
  const sidebar = shell.querySelector('.sidebar');
  if (!sidebar) return;
  const closed = Boolean(narrowLayout && narrowLayout.matches) && !shell.classList.contains('nav-open');
  if (closed) sidebar.setAttribute('inert', '');
  else sidebar.removeAttribute('inert');
}

/** Open/close the small-screen drawer, keeping focus and aria in step. */
function setNavOpen(open) {
  const shell = session.shellEls ? session.shellEls.shell : document.getElementById('shell');
  if (!shell) return;
  shell.classList.toggle('nav-open', !!open);
  const toggle = shell.querySelector('.nav-toggle');
  if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  syncNavInert();
  if (open) {
    const first = shell.querySelector('.side-scroll .side-row');
    if (first) first.focus();
  }
}

if (narrowLayout) {
  const onLayoutChange = () => {
    syncNavInert();
    // Rotating a phone into a wide layout must not leave the drawer class (and
    // its scrim) behind on a window that now shows the sidebar permanently.
    if (!narrowLayout.matches && session.shellEls && session.shellEls.shell.classList.contains('nav-open')) {
      setNavOpen(false);
    }
  };
  if (typeof narrowLayout.addEventListener === 'function') narrowLayout.addEventListener('change', onLayoutChange);
  else if (typeof narrowLayout.addListener === 'function') narrowLayout.addListener(onLayoutChange);
}

function routeToken(route) {
  if (!route) return 'none';
  if (route.name === 'drive') return 'drive:' + (route.folderId || 'root');
  // A search token must cover the filters too: ?q= alone would let a narrower
  // search paint as unchanged and skip the transition it deserves.
  if (route.name === 'search') return 'search:' + routePath(route);
  // Same rule for the owner's list: /shares?state=trashed is a different page
  // than bare /shares, and a filter change must not paint as "unchanged".
  if (route.name === 'shares') return 'shares:' + routePath(route);
  return route.name;
}

/* ═══ owner share management ═══════════════════════════════════ */
/**
 * The body of /shares.
 *
 * Kept here rather than in views.js because it is its own page with its own
 * data, not a shape of the file list: it never looks at state.nodes, never
 * mounts the file list and never answers a row click as "open this file".
 * `sharesPage` is created once per visit and re-attached on every repaint, so
 * the sidebar or the status bar can be refreshed without re-reading page one.
 * A /shares?q=…&state=… navigation is handed to the same page through show(),
 * so the filter controls (and the caret in them) survive the query change; the
 * page decides whether the filter really changed and re-reads page one only
 * then.
 */
function sharesViewContent(route) {
  if (!sharesPage) sharesPage = createSharesView(route);
  else sharesPage.show(route);
  return sharesPage.el;
}

/** The status bar for /shares: the page counts itself, the shell adds usage. */
function sharesStatusContent() {
  const parts = ['我分享的', store.state.user ? store.state.user.email || '' : ''];
  if (store.state.stats) parts.splice(1, 0, '已用 ' + bytes(store.state.stats.bytes));
  return parts.filter(Boolean).map((text) => h('span', { text }));
}

function topbarContent(ctx) {
  return [
    h('button', {
      class: 'icon-btn nav-toggle',
      attrs: { type: 'button', 'aria-label': '切换侧边栏', 'aria-expanded': 'false', 'aria-controls': 'shell' },
      html: icon('menu', 16),
      on: { click: () => {
        const shell = document.getElementById('shell');
        if (shell) setNavOpen(!shell.classList.contains('nav-open'));
      } },
    }),
    renderBreadcrumb(ctx),
    h('div', { class: 'top-actions' },
      // The download entry sits in the global chrome: a download keeps running
      // while the user moves between folders, so its one control must not be
      // owned by a route. app.js only mounts the button; the list lives in
      // lib/downloads.js so every entry point shares one queue.
      downloadEntry(),
      h('button', {
        class: 'icon-btn', attrs: { type: 'button', 'aria-label': '刷新', title: '刷新 (R)' },
        html: icon('refresh', 15),
        on: { click: () => { refreshData(); } },
      }),
    ),
  ];
}

/* ═══ selection ════════════════════════════════════════════════ */
function paintSelection() {
  const selected = store.state.selection;
  const view = session.shellEls ? session.shellEls.viewEl : null;
  if (view) {
    for (const el of view.querySelectorAll('.frow[data-id], .gcard[data-id]')) {
      const isSelected = selected.has(el.dataset.id);
      el.dataset.selected = isSelected ? 'true' : 'false';
      el.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    }
    // The checkboxes are the selection's own control, so a selection change has
    // to reach them without re-rendering the list: a re-render would replay the
    // row entrance and steal the focus ring off the box the user just clicked.
    const rows = Array.from(view.querySelectorAll('.frow[data-id], .gcard[data-id]'));
    for (const box of view.querySelectorAll('.frow .pick, .gcard .pick')) {
      // Each box names its own node, so a paint never has to guess which row
      // owns it (and the box itself must not carry data-id — that attribute
      // means "a row" to the drag layer and to every browser check).
      const id = box.dataset.for;
      if (id) box.checked = selected.has(id);
    }
    const headAll = view.querySelector('.list-head .pick-all');
    if (headAll) {
      const count = rows.filter((row) => selected.has(row.dataset.id)).length;
      headAll.checked = rows.length > 0 && count === rows.length;
      headAll.indeterminate = count > 0 && count < rows.length;
    }
  }
  if (session.selectionSlot && session.selectionSlot.isConnected) {
    if (selected.size) mount(session.selectionSlot, selectionBar());
    else session.selectionSlot.replaceChildren();
  }
  if (session.shellEls) mount(session.shellEls.statusbar, statusContent());
}

function selectionBar() {
  const nodes = Array.from(store.state.selection).map(lookupNode).filter(Boolean);
  const count = store.state.selection.size;
  const inTrash = store.state.route.name === 'trash';
  // The headline lives in a variable because a restore batch writes its progress
  // into it ("还原中 1/2") instead of remounting the bar. Only the trash can
  // rewrite it while a batch runs, so only there is it a live region: elsewhere
  // it would announce the selection count on every repaint.
  const status = h('b', {
    text: '已选择 ' + count + ' 项',
    attrs: inTrash ? { 'aria-live': 'polite' } : {},
  });
  // The trash is the one route where the bar's verbs are restore/purge: the
  // drive verbs (download, move, delete) would either 404 or re-trash a row
  // that is already there. Same classes and height as the drive bar so the
  // toolbar never resizes when the selection changes route.
  let restoreBtn = null;
  if (inTrash) {
    restoreBtn = h('button', {
      class: 'btn btn-sm', attrs: { type: 'button', 'aria-label': '还原所选项目' },
      on: {
        click: async () => {
          // A batch is serial and can take a while: the press looks accepted,
          // and the headline carries the count so the bar is not simply frozen.
          // The original label is captured first — the progress writes over it.
          const label = status.textContent;
          restoreBtn.disabled = true;
          restoreBtn.setAttribute('aria-busy', 'true');
          try {
            await restoreSelection(nodes, (done, total) => {
              status.textContent = '还原中 ' + done + '/' + total;
            });
          } finally {
            // The refresh at the end of a batch rebuilds this bar, so both nodes
            // may already be detached: write only to a bar still on screen.
            if (status.isConnected) status.textContent = label;
            if (restoreBtn.isConnected) {
              restoreBtn.disabled = false;
              restoreBtn.removeAttribute('aria-busy');
            }
          }
        },
      },
    }, raw(icon('rotate-ccw', 13)), h('span', { class: 'sel-action-label', text: '还原' }));
  }
  const actions = inTrash
    ? [
      restoreBtn,
      h('button', {
        class: 'btn btn-sm sel-delete', attrs: { type: 'button', 'aria-label': '永久删除所选项目' },
        on: { click: () => deleteSelection(nodes) },
      }, raw(icon('trash', 13)), h('span', { class: 'sel-action-label', text: '永久删除' })),
    ]
    : [
      h('button', {
        class: 'btn btn-sm', attrs: { type: 'button', 'aria-label': '下载所选项目' },
        on: { click: () => downloadSelection(nodes) },
      }, raw(icon('download', 13)), h('span', { class: 'sel-action-label', text: '下载' })),
      h('button', {
        class: 'btn btn-sm', attrs: { type: 'button', 'aria-label': '将所选项目移动到…', title: 'Ctrl+Shift+M' },
        on: { click: () => moveSelection(nodes) },
      }, raw(icon('move', 13)), h('span', { class: 'sel-action-label', text: '移动到…' })),
      h('button', {
        class: 'btn btn-sm sel-delete', attrs: { type: 'button', 'aria-label': '删除所选项目' },
        on: { click: () => deleteSelection(nodes) },
      }, raw(icon('trash', 13)), h('span', { class: 'sel-action-label', text: '删除' })),
    ];
  return h('div', { class: 'sel-bar', attrs: { role: 'region', 'aria-label': '批量操作' } },
    status,
    ...actions,
    h('span', { class: 'push' }),
    h('button', {
      class: 'icon-btn', attrs: { type: 'button', 'aria-label': '取消选择' }, html: icon('x', 14),
      on: { click: () => clearSelection() },
    }),
  );
}

/**
 * Clear the selection from the bar without dropping the caret on <body>.
 *
 * Both the X and Escape destroy the bar (or the row it belongs to), so the
 * browser would otherwise leave focus nowhere. When the user was standing in
 * the bar, hand it back to the first selected row's checkbox if that row is
 * still on screen, and to the view when it is not.
 */
function clearSelection() {
  const active = document.activeElement;
  const wasInBar = !!(session.selectionSlot && active && session.selectionSlot.contains(active));
  const firstId = store.state.selection.values().next().value;
  const view = session.shellEls ? session.shellEls.viewEl : null;
  const box = view && firstId
    ? view.querySelector('.frow[data-id="' + firstId + '"] .pick, .gcard[data-id="' + firstId + '"] .pick')
    : null;
  store.state.selection = new Set();
  paintSelection();
  if (!wasInBar) return;
  if (box && box.isConnected) box.focus({ preventScroll: true });
  else if (view) view.focus({ preventScroll: true });
}

/* ═══ global keyboard ══════════════════════════════════════════ */
/* Which input modality produced the navigation. Set here, read by paintRoute();
   pointerdown fires before the click that navigates, so the flag is never stale. */
document.addEventListener('pointerdown', () => { session.keyboardNav = false; }, true);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Tab' || event.key === 'Enter' || event.key === ' ' || event.key.startsWith('Arrow')
    || event.key === 'Home' || event.key === 'End') {
    session.keyboardNav = true;
  }
}, true);

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented) return;
  const target = event.target;
  const typing = !!(target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
    || target.tagName === 'SELECT' || target.isContentEditable));

  if (event.key === 'Escape') {
    if (closeTopLayer()) { event.preventDefault(); return; }
    // The small-screen drawer is a layer too, and it is the outermost one the
    // user can see — Escape has to close it before it starts clearing selection.
    if (session.shellEls && session.shellEls.shell.classList.contains('nav-open')) {
      setNavOpen(false);
      const toggle = session.shellEls.shell.querySelector('.nav-toggle');
      if (toggle) toggle.focus();
      event.preventDefault();
      return;
    }
    if (store.state.selection && store.state.selection.size) {
      clearSelection();
      event.preventDefault();
    }
    return;
  }
  if (!store.state.user) return;
  if (typing) return;
  // Native controls and overlays own their keys. In particular, Enter on a
  // dialog's Move/Cancel button must not open the selected file behind it.
  if (target && target.closest('button, a[href], [role="dialog"], [role="menu"], .drawer')) return;

  // Ctrl/Cmd+K is the modified equivalent of "/" and stays available when the
  // single-character shortcuts are switched off (WCAG 2.1.4: a character key
  // shortcut needs an off switch or a non-character alternative — this is the
  // alternative, and lib/shortcuts.js owns the switch).
  if ((event.key === 'k' || event.key === 'K') && (event.ctrlKey || event.metaKey) && !event.shiftKey) {
    const input = document.querySelector('.side-search input');
    if (input) { event.preventDefault(); input.focus(); input.select(); }
    return;
  }

  if (event.key === '/') {
    if (!shortcutsEnabled()) return;
    const input = document.querySelector('.side-search input');
    if (input) { event.preventDefault(); input.focus(); input.select(); }
    return;
  }

  const selected = Array.from(store.state.selection).map(lookupNode).filter(Boolean);
  if (event.key === 'Enter' && selected.length === 1 && !event.metaKey && !event.ctrlKey) {
    event.preventDefault();
    if (selected[0].kind === 'folder') navigate('/folder/' + encodeURIComponent(selected[0].id));
    else openPreviewFor(selected[0]);
    return;
  }
  if ((event.key === 'd' || event.key === 'D') && (event.ctrlKey || event.metaKey) && event.shiftKey) {
    event.preventDefault();
    if (store.state.selection.size) downloadSelectionArchive();
    else if (store.state.route.name === 'drive' && store.state.route.folderId) {
      const folder = lookupNode(store.state.route.folderId);
      if (folder) downloadFolderArchive(folder);
    }
    return;
  }
  // Ctrl+Shift+M is the batch move; it is listed in the hint card and the bar.
  if ((event.key === 'm' || event.key === 'M') && (event.ctrlKey || event.metaKey) && event.shiftKey) {
    event.preventDefault();
    if (store.state.route.name !== 'trash' && selected.length) moveSelection(selected);
    return;
  }
  if (event.key === 'Delete' && selected.length) {
    event.preventDefault();
    if (store.state.route.name === 'trash') {
      // One row keeps the single-item confirmation (its title names the file);
      // several rows go through the batch, which counts them and keeps the
      // failures selected. Purging only selected[0] silently ignored the rest.
      if (selected.length === 1) startPurge(selected[0]);
      else deleteSelection(selected);
    }
    else if (selected.length === 1) startDelete(selected[0]);
    else deleteSelection(selected);
    return;
  }
  if (event.key === 'F2' && selected.length === 1) {
    event.preventDefault();
    startRename(selected[0]);
    return;
  }
  if ((event.key === 'r' || event.key === 'R') && !event.metaKey && !event.ctrlKey && !event.altKey) {
    if (!shortcutsEnabled()) return;
    event.preventDefault();
    refreshData();
  }
});

/* ═══ wiring ═══════════════════════════════════════════════════ */
/* Every verb a module may call back into the shell with. Declared in one place
   so the seam is visible: if this list grows, the module boundary is wrong. */
wire({
  navigate,
  refreshData,
  renderShell,
  paintSelection,
  mountAuth,
  lookupNode,
  pickFiles: () => pickFiles(uploader),
  pickUploadKind: (anchor) => pickUploadKind(uploader, anchor),
  uploadFolderPlan: (plan, parentId) => uploadFolderPlan(uploader, plan, parentId),
  uploadFiles: (files) => uploadFiles(uploader, files),
  loadMoreSearch,
  loadMoreNodes,
  reloadRoute: () => loadRoute(store.state.route),
  currentParentId,
});

/* ═══ boot ═════════════════════════════════════════════════════ */
try {
  const savedView = localStorage.getItem('mdrive-view');
  if (savedView === 'grid' || savedView === 'list') store.state.view = savedView;
} catch { /* storage disabled */ }

handleRoute();

window.addEventListener('pagehide', () => { uploader.markInterrupted(); });

window.mdrive = {
  store, navigate, refresh: refreshData, uploadFiles: (files) => uploadFiles(uploader, files), uploader,
  // Exposed for the browser checks: they drive a real download through the same
  // center the topbar entry opens, instead of rebuilding the panel's markup.
  downloads: downloadCenter(),
};
