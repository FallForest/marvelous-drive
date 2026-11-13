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
import {
  lookupNode, openPreviewFor, downloadOne, downloadFolderArchive, copyShareLink,
  toggleStarWithToast, startRename, startMove, startDelete, startRestore, startPurge,
  startNewFolder, openUserMenu,
} from './actions.js';
import { openShareDialog } from './share.js';
import { visibleNodes } from './views.js';
import { onRowDragStart, onRowDragEnd, onFolderDragOver, onFolderDragLeave, onFolderDrop } from './dnd.js';

/* The sidebar is re-created on every render, so the search field keeps its
   focus + caret across a debounced navigation. */
const searchFocus = { active: false, start: 0, end: 0 };

export function rememberSearchFocus() {
  const input = document.querySelector('.side-search input');
  if (!input) return;
  searchFocus.active = document.activeElement === input;
  if (searchFocus.active) {
    searchFocus.start = input.selectionStart || 0;
    searchFocus.end = input.selectionEnd || 0;
  }
}

export function restoreSearchFocus() {
  if (!searchFocus.active) return;
  const input = document.querySelector('.side-search input');
  if (!input) return;
  input.focus();
  if (typeof input.setSelectionRange === 'function') {
    try { input.setSelectionRange(searchFocus.start, searchFocus.end); } catch { /* not a text input */ }
  }
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
      runtime.renderShell();
    },
    onSortDirection: () => {
      store.state.sortDir = store.state.sortDir === 'asc' ? 'desc' : 'asc';
      runtime.renderShell();
    },
    onViewChange: (view) => {
      store.state.view = view;
      try { localStorage.setItem('mdrive-view', view); } catch { /* storage disabled */ }
      runtime.renderShell();
    },
    onSearchInput: debounce((event) => {
      rememberSearchFocus();
      const value = String(event.target.value || '').trim();
      if (!value) { if (store.state.route.name === 'search') runtime.navigate('/'); return; }
      if (value.length < 2) return;
      runtime.navigate(routePath({ name: 'search', query: value }), { replace: store.state.route.name === 'search' });
    }, 320),
    onSearchCommit: (value) => {
      const q = String(value || '').trim();
      runtime.navigate(q ? routePath({ name: 'search', query: q }) : '/');
    },
    onSearchClear: () => { if (store.state.route.name === 'search') runtime.navigate('/'); },

    onToggleFolder: (folderId) => {
      const state = store.state;
      if (state.expanded.has(folderId)) state.expanded.delete(folderId);
      else state.expanded.add(folderId);
      runtime.renderShell();
    },

    onRowClick: (node, event) => {
      const state = store.state;
      const additive = event.metaKey || event.ctrlKey;
      if (event.shiftKey && state.anchorId) {
        const order = visibleNodes().map((item) => item.id);
        const from = order.indexOf(state.anchorId);
        const to = order.indexOf(node.id);
        if (from >= 0 && to >= 0) {
          const start = Math.min(from, to);
          const end = Math.max(from, to);
          const next = new Set(state.selection);
          for (let i = start; i <= end; i += 1) next.add(order[i]);
          state.selection = next;
        }
      } else if (additive) {
        const next = new Set(state.selection);
        if (next.has(node.id)) next.delete(node.id);
        else next.add(node.id);
        state.selection = next;
        state.anchorId = node.id;
      } else {
        state.selection = new Set([node.id]);
        state.anchorId = node.id;
      }
      runtime.paintSelection();
    },

    onRowKey: (event, node) => {
      const key = event.key;
      if (key === 'Enter') { event.preventDefault(); event.stopPropagation(); ctx.onOpen(node); }
      else if (key === ' ') { event.preventDefault(); event.stopPropagation(); ctx.onRowClick(node, event); }
      else if (key === 'F2') { event.preventDefault(); event.stopPropagation(); ctx.onRename(node); }
      else if (key === 'Delete') { event.preventDefault(); event.stopPropagation(); ctx.onDelete(node); }
      else if (key === 'ArrowDown' || key === 'ArrowUp') {
        event.preventDefault();
        const rows = Array.from(session.shellEls.viewEl.querySelectorAll('[data-id][tabindex]'));
        const at = rows.indexOf(event.currentTarget);
        const next = rows[key === 'ArrowDown' ? at + 1 : at - 1];
        if (next) next.focus();
      }
    },

    onOpen: (node) => {
      if (node.kind === 'folder') runtime.navigate('/folder/' + encodeURIComponent(node.id));
      else openPreviewFor(node);
    },
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

export { lookupNode };
