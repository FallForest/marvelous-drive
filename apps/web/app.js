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
import { icon } from './lib/format.js';
import { api, request, putRaw, onUnauthorized, getToken } from './lib/api.js';
import { toast, closeTopLayer } from './lib/ui.js';
import { renderAuth } from './lib/auth.js';
import { renderSidebar, renderBreadcrumb, renderToolbar } from './lib/sidebar.js';
import { renderShared } from './lib/share.js';
import { createQueuePanel } from './lib/queue.js';
import { createUploader } from './lib/upload-queue.js';
import { parseLocation, routePath, buildIndex, ancestorPath } from './lib/state.js';
import {
  DURATION, MOTION_ATTRS, STAGGER, announceEntrance, markAnimating, onceOnRoute, prefersReducedMotion, withViewTransition,
} from './lib/motion.js';
import { store, session } from './lib/session.js';
import { runtime, wire } from './lib/runtime.js';
import { viewContent, statusContent, titleFor } from './lib/views.js';
import { buildContext, restoreSearchFocus } from './lib/context.js';
import {
  openPreviewFor, lookupNode, startRename, startDelete, startPurge, deleteSelection, moveSelection,
  downloadSelection, downloadSelectionArchive, downloadFolderArchive,
} from './lib/actions.js';
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

  if (route.name === 'shared') {
    session.shellEls = null;
    session.paintedToken = null;
    renderShared(root, route.token, { onHome: () => navigate('/') });
    return;
  }
  if (route.name === 'notFound') { navigate('/', { replace: true }); return; }
  if (!getToken()) { mountAuth(); return; }
  if (!store.state.user) {
    const user = await bootstrapSession();
    if (!user) return;
  }
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
async function loadRoute(route) {
  store.state.loading = true;
  store.state.loadError = null;
  // The skeleton is a loading state, not a navigation: paint it plainly and
  // leave the route token alone, so the cross-fade lands on the real content
  // instead of freezing the skeleton into the "old" snapshot.
  renderShell();

  try {
    if (route.name === 'search') {
      const q = route.query || '';
      // Stats come along even here: landing directly on /search used to leave the
      // sidebar claiming "已用 0 B" because nothing ever fetched them.
      const [payload, stats] = await Promise.all([
        q ? api.get('/search?q=' + encodeURIComponent(q) + '&limit=50') : Promise.resolve({ results: [] }),
        api.get('/storage/stats').catch(() => ({ stats: store.state.stats })),
      ]);
      store.state.searchResults = payload && Array.isArray(payload.results) ? payload.results : [];
      store.state.searchQuery = q;
      if (stats && stats.stats) store.state.stats = stats.stats;
      store.state.loading = false;
      paintRoute(route);
      return;
    }

    const [live, trashed, stats] = await Promise.all([
      api.get('/nodes'),
      api.get('/nodes?trash=1').catch(() => ({ nodes: [] })),
      api.get('/storage/stats').catch(() => ({ stats: null })),
    ]);
    session.index = buildIndex(live && Array.isArray(live.nodes) ? live.nodes : []);
    store.state.nodes = live && Array.isArray(live.nodes) ? live.nodes : [];
    store.state.trash = trashed && Array.isArray(trashed.nodes) ? trashed.nodes : [];
    store.state.stats = stats ? stats.stats : null;
    store.state.loading = false;
    store.state.selection = new Set();
    store.state.anchorId = null;

    if (route.name === 'drive' && route.folderId && !session.index.byId.has(route.folderId)) {
      toast('该文件夹不存在或已删除。', { type: 'warning' });
      navigate('/', { replace: true });
      return;
    }
    paintRoute(route);
  } catch (error) {
    store.state.loading = false;
    store.state.loadError = error && error.status === 0
      ? '无法连接服务器，请确认 Drive 服务正在运行。'
      : (error && error.message) || '加载失败。';
    paintRoute(route);
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
  if (!changed) { renderShell(); return; }
  withViewTransition(() => renderShell(), { reduced: prefersReducedMotion() });
}

function refreshData() {
  const now = Date.now();
  if (now - session.lastRefreshAt < 120) return Promise.resolve();
  session.lastRefreshAt = now;
  return loadRoute(store.state.route);
}

/* ═══ auth ═════════════════════════════════════════════════════ */
function mountAuth() {
  store.state.user = null;
  session.shellEls = null;
  session.selectionSlot = null;
  session.paintedToken = null;
  if (session.authHandle && session.authHandle.destroy) session.authHandle.destroy();
  session.authHandle = renderAuth(root, {
    onSuccess: async (user) => {
      store.state.user = user || null;
      if (!store.state.user) await bootstrapSession();
      const route = parseLocation(window.location);
      if (route.name === 'shared') { handleRoute(); return; }
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
  session.selectionSlot = h('div', { style: { display: 'contents' } });
  const ctx = buildContext(ancestors, session.selectionSlot);

  mount(session.shellEls.sidebarHost, renderSidebar(ctx));
  mount(session.shellEls.topbar, topbarContent(ctx));
  session.shellEls.toolbar.hidden = route.name === 'search';
  mount(session.shellEls.toolbar, renderToolbar(ctx));
  mount(session.shellEls.viewEl, viewContent(ctx));
  mount(session.shellEls.statusbar, statusContent());
  document.title = titleFor(route);
  restoreSearchFocus();
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

/** Open/close the small-screen drawer, keeping focus and aria in step. */
function setNavOpen(open) {
  const shell = session.shellEls ? session.shellEls.shell : document.getElementById('shell');
  if (!shell) return;
  shell.classList.toggle('nav-open', !!open);
  const toggle = shell.querySelector('.nav-toggle');
  if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) {
    const first = shell.querySelector('.side-scroll .side-row');
    if (first) first.focus();
  }
}

function routeToken(route) {
  if (!route) return 'none';
  if (route.name === 'drive') return 'drive:' + (route.folderId || 'root');
  if (route.name === 'search') return 'search:' + (route.query || '');
  return route.name;
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
  return h('div', { class: 'sel-bar motion-sink', attrs: { role: 'region', 'aria-label': '批量操作' } },
    h('b', { text: '已选择 ' + count + ' 项' }),
    h('button', {
      class: 'btn btn-sm', attrs: { type: 'button' },
      on: { click: () => downloadSelection(nodes) },
    }, raw(icon('download', 13)), '下载'),
    h('button', {
      class: 'btn btn-sm', attrs: { type: 'button', title: 'Ctrl+Shift+M' },
      on: { click: () => moveSelection(nodes) },
    }, raw(icon('move', 13)), '移动到…'),
    h('button', {
      class: 'btn btn-sm', attrs: { type: 'button' },
      on: { click: () => deleteSelection(nodes) },
    }, raw(icon('trash', 13)), '删除'),
    h('span', { class: 'push' }),
    h('button', {
      class: 'icon-btn', attrs: { type: 'button', 'aria-label': '取消选择' }, html: icon('x', 14),
      on: { click: () => { store.state.selection = new Set(); paintSelection(); } },
    }),
  );
}

/* ═══ global keyboard ══════════════════════════════════════════ */
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
      store.state.selection = new Set();
      paintSelection();
      event.preventDefault();
    }
    return;
  }
  if (!store.state.user) return;
  if (typing) return;

  if (event.key === '/') {
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
    if (store.state.route.name === 'trash') startPurge(selected[0]);
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
  currentParentId,
});

/* ═══ boot ═════════════════════════════════════════════════════ */
try {
  const savedView = localStorage.getItem('mdrive-view');
  if (savedView === 'grid' || savedView === 'list') store.state.view = savedView;
} catch { /* storage disabled */ }

handleRoute();

window.addEventListener('pagehide', () => { uploader.markInterrupted(); });

window.mdrive = { store, navigate, refresh: refreshData, uploadFiles: (files) => uploadFiles(uploader, files), uploader };
