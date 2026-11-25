/*
 * context.js — the handler object every view is handed.
 *
 * views.js renders from it, sidebar.js/move.js/etc. read it, and app.js builds
 * it once per render. Keeping the construction here means the handler table is
 * one screen long instead of being buried in the shell.
 *
 * The context is rebuilt on every render, so it must stay cheap: closures over
 * module functions, no DOM work, no requests.
 */

import { debounce } from './dom.js';
import { store, session } from './session.js';
import { routePath } from './state.js';
import { runtime } from './runtime.js';
import { rowAction, ROW_ACTION, isSelectionClick, isRepeatClick, noteOpen } from './row-action.js';
import {
  openPreviewFor, downloadOne, downloadFolderArchive, copyShareLink,
  toggleStarWithToast, startRename, startMove, startDelete, startRestore, startPurge,
  startNewFolder, openUserMenu, deleteSelection,
} from './actions.js';
import { openShareDialog } from './share.js';
import { visibleNodes } from './views.js';
import { saveDirectoryPrefs } from './directory-prefs.js';
import { onRowDragStart, onRowDragEnd, onFolderDragOver, onFolderDragLeave, onFolderDrop } from './dnd.js';

/* The sidebar is re-created on every render, so the search field keeps its
   focus + caret across a debounced navigation. */
const searchFocus = { active: false, start: 0, end: 0 };

function rememberSearchFocus() {
  const input = document.querySelector('.side-search input');
  if (!input) return;
  searchFocus.active = document.activeElement === input;
  if (searchFocus.active) {
    searchFocus.start = input.selectionStart || 0;
    searchFocus.end = input.selectionEnd || 0;
  }
}

/**
 * The input that can actually take the caret back.
 *
 * On a narrow window every navigation closes the drawer, and a closed drawer is
 * `inert`: its search field is still in the document, but focusing it is a
 * silent no-op and the caret lands on <body>. The page's own search field is
 * then the only honest target, so it is used as the fallback.
 */
function searchField() {
  const input = document.querySelector('.side-search input');
  if (input) {
    const sidebar = input.closest('.sidebar');
    if (!sidebar || !sidebar.hasAttribute('inert')) return input;
  }
  return document.querySelector('.search-form input[type=search]');
}

export function restoreSearchFocus() {
  if (!searchFocus.active) return;
  const input = searchField();
  if (!input) return;
  input.focus();
  if (typeof input.setSelectionRange === 'function') {
    try { input.setSelectionRange(searchFocus.start, searchFocus.end); } catch { /* not a text input */ }
  }
}

/**
 * The route the sidebar field is asking for.
 *
 * A term typed on the search page narrows what is already there: spreading the
 * current route keeps folderId / kind / updatedAfter / scope in the URL. From a
 * folder, a fresh search carries that folder so the results stay scoped to it.
 * An empty term never borrows a folder — otherwise clearing the box on a folder
 * page would open a scoped, empty search page.
 */
function searchRoute(query) {
  const route = store.state.route || {};
  if (route.name === 'search') return { ...route, query };
  if (query && route.name === 'drive' && route.folderId) {
    return { name: 'search', query, folderId: route.folderId };
  }
  return { name: 'search', query };
}

/** routePath() for that route, except that a bare empty term means the root. */
function searchTarget(query) {
  const route = searchRoute(query);
  const filtered = Boolean(query || route.folderId || route.kind || route.updatedAfter);
  return filtered ? routePath(route) : '/';
}

/**
 * Builds the handler table for one render.
 *
 * `selectionSlot` is the live DOM node the list renders into, so the views can
 * wrap their own body around it without knowing how the shell mounted it.
 */
export function buildContext(ancestors, selectionSlot) {
  const ctx = {
    state: store.state,
    index: session.index,
    ancestors,
    selectionSlot,

    navigate: (path) => runtime.navigate(path),
    onSort: (key) => {
      const state = store.state;
      if (state.sortKey === key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      else { state.sortKey = key; state.sortDir = 'asc'; }
      // Per-directory memory for drive; other pages leave it untouched.
      saveDirectoryPrefs(state);
      if (state.serverSorted) runtime.reloadRoute();
      else runtime.renderShell();
    },
    onSortDirection: () => {
      store.state.sortDir = store.state.sortDir === 'asc' ? 'desc' : 'asc';
      saveDirectoryPrefs(store.state);
      if (store.state.serverSorted) runtime.reloadRoute();
      else runtime.renderShell();
    },
    onViewChange: (view) => {
      const state = store.state;
      const changed = state.view !== view;
      state.view = view;
      // A drive directory remembers its own view. Only the non-drive pages keep
      // the old global key, so opening a grid folder never changes their start.
      if (state.route && state.route.name === 'drive') {
        if (changed) saveDirectoryPrefs(state);
      } else {
        try { localStorage.setItem('mdrive-view', view); } catch { /* storage disabled */ }
      }
      runtime.renderShell();
    },
    onSearchInput: debounce((event) => {
      // The field is re-created on every render, so the debounced callback can
      // fire for an input the user has already left behind. Its event is stale:
      // reading it would navigate back to a query typed a moment ago.
      const target = event && event.target;
      if (!target || target.isConnected === false) return;
      rememberSearchFocus();
      const value = String(target.value || '').trim();
      // One character is not a search yet, and the page must not flicker for it.
      if (value.length === 1) return;
      const path = searchTarget(value);
      if (path === '/') {
        // Empty box: leave the page the user is on, unless a search is showing.
        if (store.state.route.name === 'search') runtime.navigate('/');
        return;
      }
      runtime.navigate(path, { replace: store.state.route.name === 'search' });
    }, 320),
    onSearchCommit: (value) => {
      runtime.navigate(searchTarget(String(value || '').trim()));
    },
    onSearchClear: () => {
      const route = store.state.route;
      if (route.name !== 'search') return;
      // Escape leaves the search but keeps the user where the search was scoped:
      // a folder-scoped result set goes back to its folder, a plain one to root.
      runtime.navigate(route.folderId ? '/folder/' + encodeURIComponent(route.folderId) : '/');
    },
    // The search page's "继续加载": the shell owns the request and the append,
    // the view only renders the button and its busy state.
    onSearchMore: () => runtime.loadMoreSearch(),
    onNodesMore: () => runtime.loadMoreNodes(),

    onToggleFolder: (folderId) => {
      const state = store.state;
      if (state.expanded.has(folderId)) state.expanded.delete(folderId);
      else state.expanded.add(folderId);
      runtime.renderShell();
    },

    /* A plain click runs the row's primary action (see row-action.js); modifier
       clicks and the trash view still mean "select". */
    onRowClick: (node, event) => {
      const state = store.state;
      if (isSelectionClick(event) || rowAction(state.route.name, node) === ROW_ACTION.SELECT) {
        selectFor(node, event);
        return;
      }
      // The second click of a double click lands on an item that is already
      // open, or on a row of the page it just opened. Either way it is an echo.
      if (isRepeatClick(node, event)) return;
      noteOpen();
      // A folder is navigated, not highlighted: painting the row first would
      // flash a selection border under the cross-fade. A file keeps the row
      // selected behind its preview drawer, which is where the user left off.
      if (node.kind !== 'folder') {
        state.selection = new Set([node.id]);
        state.anchorId = node.id;
        runtime.paintSelection();
      }
      openFromRow(node);
    },

    /* Right click selects without running the row's action; opening a preview
       (or navigating away) under a context menu would be a trap. */
    onSelectOnly: (node, event) => selectFor(node, event),

    /* The checkbox is the explicit selection gesture: it toggles, never opens. */
    onSelectToggle: (node) => {
      const state = store.state;
      const next = new Set(state.selection);
      if (next.has(node.id)) next.delete(node.id);
      else next.add(node.id);
      state.selection = next;
      state.anchorId = node.id;
      runtime.paintSelection();
    },

    /* Read the live selection, never a value captured at render time: the header
       checkbox is not re-created by a paint, so a closure would stay one click
       behind the list it is selecting. */
    onSelectAll: (nodes) => {
      const state = store.state;
      const list = nodes || [];
      const all = list.length > 0 && list.every((item) => state.selection.has(item.id));
      state.selection = all ? new Set() : new Set(list.map((item) => item.id));
      state.anchorId = all || !list.length ? null : list[0].id;
      runtime.paintSelection();
    },

    onRowKey: (event, node) => {
      // Buttons and editors inside a row keep their native keyboard actions.
      // Stop the event here so the shell's selected-item shortcuts cannot also
      // open or delete a file while its star/menu button has focus.
      if (event.target !== event.currentTarget) { event.stopPropagation(); return; }
      const key = event.key;
      if (key === 'Enter') { event.preventDefault(); event.stopPropagation(); ctx.onOpen(node); }
      // Space is the keyboard's checkbox, not its click: it must never navigate.
      else if (key === ' ') { event.preventDefault(); event.stopPropagation(); ctx.onSelectToggle(node); }
      else if (key === 'F2') { event.preventDefault(); event.stopPropagation(); ctx.onRename(node); }
      else if (key === 'Delete') {
        event.preventDefault();
        event.stopPropagation();
        if (store.state.selection.has(node.id) && store.state.selection.size > 1) {
          deleteSelection(visibleNodes().filter((item) => store.state.selection.has(item.id)));
        }
        else ctx.onDelete(node);
      }
      else if (key === 'ArrowDown' || key === 'ArrowUp') {
        event.preventDefault();
        const rows = Array.from(session.shellEls.viewEl.querySelectorAll('[data-id][tabindex]'));
        const at = rows.indexOf(event.currentTarget);
        const next = rows[key === 'ArrowDown' ? at + 1 : at - 1];
        if (next) next.focus();
      }
    },

    onOpen: (node) => openFromRow(node),
    onPreview: (node) => openPreviewFor(node),
    onDownload: (node) => downloadOne(node),
    onDownloadArchive: (node) => downloadFolderArchive(node),
    onCopyLink: (node) => copyShareLink(node),
    onShare: (node) => openShareDialog(node),
    onToggleStar: (node) => toggleStarWithToast(node),
    onRename: (node) => startRename(node),
    onMove: (node) => startMove(node),
    onDelete: (node) => startDelete(node),
    onRestore: (node) => startRestore(node),
    onPurge: (node) => startPurge(node),
    onNewFolder: (parentId) => startNewFolder(parentId),
    onUploadClick: (anchor) => runtime.pickUploadKind(anchor),
    onUserMenu: (anchor) => openUserMenu(anchor),

    // Drag to move: rows are the source, folder rows / breadcrumbs the targets.
    onRowDragStart,
    onRowDragEnd,
    onFolderDragOver,
    onFolderDragLeave,
    onFolderDrop,
  };
  return ctx;
}

/** The primary action for a row: a folder navigates, a file previews. */
function openFromRow(node) {
  if (!node) return;
  if (node.kind === 'folder') runtime.navigate('/folder/' + encodeURIComponent(node.id));
  else openPreviewFor(node);
}

/**
 * Selection gestures: Shift extends from the anchor, Ctrl/Cmd toggles one row,
 * a bare click replaces the selection.
 */
function selectFor(node, event) {
  const state = store.state;
  if (event && event.shiftKey && state.anchorId) {
    const order = visibleNodes().map((item) => item.id);
    const from = order.indexOf(state.anchorId);
    const to = order.indexOf(node.id);
    if (from >= 0 && to >= 0) {
      const start = Math.min(from, to);
      const end = Math.max(from, to);
      const next = new Set(state.selection);
      for (let i = start; i <= end; i += 1) next.add(order[i]);
      state.selection = next;
      runtime.paintSelection();
      return;
    }
  }
  if (event && (event.metaKey || event.ctrlKey)) {
    const next = new Set(state.selection);
    if (next.has(node.id)) next.delete(node.id);
    else next.add(node.id);
    state.selection = next;
    state.anchorId = node.id;
    runtime.paintSelection();
    return;
  }
  state.selection = new Set([node.id]);
  state.anchorId = node.id;
  runtime.paintSelection();
}
