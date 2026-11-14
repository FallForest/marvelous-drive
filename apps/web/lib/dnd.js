/*
 * drag-move.js already owns the *rules* (planMoves, selectionForDrag). This module
 * owns the *gestures*: the dragstart on a row, the dragover/drop on a folder row
 * or breadcrumb, and the document-wide file drop that uploads.
 *
 * They were in app.js because they needed the shell element and the selection.
 * Both now live in session, so the gestures can be their own module.
 */

import { h, raw } from './dom.js';
import { icon } from './format.js';
import {
  NODE_MIME, clearDropTargets, decodeNodeIds, encodeNodeIds, hasNodeDrag, markDropTarget, moveRoots, planMoves, selectionForDrag,
} from './drag-move.js';
import { planFromDataTransfer } from './folder-upload.js';
import { store, session } from './session.js';
import { runtime } from './runtime.js';
import { lookupNode, moveItems } from './actions.js';

let dragCancelled = false;

export function onRowDragStart(node, event) {
  // The old guard was `session.shellEls === null`, which is true for a moment
  // during boot and any time the shell is rebuilding — a drag started in that
  // window was silently dropped. What a drag actually needs is the tree index.
  if (!event.dataTransfer || !session.index || !session.index.byId.size) return;
  if (store.state.route.name === 'trash') { event.preventDefault(); return; }
  // Dragging a row that is part of the selection carries the whole selection;
  // dragging any other row carries just that row. The selection itself is left
  // alone — a cancelled drag must not change what is highlighted.
  const ids = selectionForDrag(store.state.selection, node.id).filter((id) => lookupNode(id));
  if (!ids.length) { event.preventDefault(); return; }
  dragCancelled = false;
  session.draggingIds = ids;
  try {
    event.dataTransfer.setData(NODE_MIME, encodeNodeIds(ids));
    // Keep a text fallback for engines that require it, while custom MIME/state
    // distinguishes our move from a file dropped from outside the page.
    event.dataTransfer.setData('text/plain', node.name || '');
  } catch (error) {
    // Firefox refuses a drag with no data at all, so a silent failure here is
    // a feature that simply does not work in that browser. Say so once rather
    // than pretending the drag is fine.
    console.warn('[mdrive] the drag payload could not be set', error);
    event.preventDefault();
    onRowDragEnd();
    return;
  }
  event.dataTransfer.effectAllowed = 'move';
  document.body.classList.add('is-moving');
  for (const row of document.querySelectorAll('.frow[data-id], .gcard[data-id]')) {
    row.classList.toggle('is-drag-source', ids.includes(row.dataset.id));
  }
  showDragBadge(ids.length === 1 ? node.name : ids.length + ' 项');
  moveDragBadge(event);
}

export function onRowDragEnd() {
  session.draggingIds = [];
  document.body.classList.remove('is-moving');
  clearDropTargets(document);
  for (const row of document.querySelectorAll('.is-drag-source')) row.classList.remove('is-drag-source');
  hideDragBadge();
}

/**
 * Name/count and destination feedback follows the pointer for every move.
 */
let badgeEl = null
function showDragBadge(label) {
  if (!badgeEl) {
    badgeEl = h('div', { class: 'drag-badge', attrs: { 'aria-hidden': 'true' } })
    document.body.appendChild(badgeEl)
  }
  badgeEl.dataset.sourceLabel = label;
  badgeEl.textContent = '移动 ' + label;
  badgeEl.classList.add('is-on')
}
function hideDragBadge() {
  if (badgeEl) badgeEl.classList.remove('is-on')
}
function resetDragBadge() {
  if (badgeEl) badgeEl.textContent = '移动 ' + badgeEl.dataset.sourceLabel;
}

/** Puts the badge under the cursor; called from every dragover we handle. */
function moveDragBadge(event) {
  if (!badgeEl || !badgeEl.classList.contains('is-on') || !event) return
  if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return
  badgeEl.style.transform = 'translate(' + (event.clientX) + 'px,' + (event.clientY - 18) + 'px) translate(-50%,-100%)'
}

/**
 * Escape cancels a drag.
 *
 * The browser owns native drag cancellation. Also invalidate our pending state
 * so a delayed drop cannot revive a cancelled gesture or clear the selection.
 */
function onDragKeydown(event) {
  if (event.key !== 'Escape' || !session.draggingIds.length) return
  event.preventDefault();
  event.stopPropagation();
  onRowDragEnd();
  dragCancelled = true;
}
if (typeof document !== 'undefined') document.addEventListener('keydown', onDragKeydown, true)

/**
 * True when this event is one of our row drags (never an OS file drop).
 *
 * The payload is the primary signal, but it is not the only one: a drag that
 * started in this page has already recorded its ids in `session.draggingIds`,
 * and some engines do not expose custom MIME types through `dataTransfer.types`
 * while the drag is in flight. Relying on the payload alone made the drop
 * target reject a real internal drag, which reads to the user as "nothing
 * happens when I drop a folder on a folder".
 *
 * An image's native drag can carry Files as well as our MIME type. Internal
 * signals take precedence; otherwise thumbnails are mistaken for uploads.
 */
function isMoveDrag(event) {
  if (!event || !event.dataTransfer) return false;
  if (session.draggingIds && session.draggingIds.length) return true;
  return hasNodeDrag(event.dataTransfer);
}

/**
 * Shared dragover handling for every folder drop target.
 *
 * Without preventDefault the browser refuses the drop entirely, which is why
 * the shell used to call it on the whole document: that made *every* element a
 * drop target for files. Now only a real move drag reaches this point, so a
 * file drop from the desktop keeps going to the window-level uploader.
 */
export function onFolderDragOver(folderId, event) {
  if (!isMoveDrag(event)) return;
  event.stopPropagation();
  moveDragBadge(event);
  clearDropTargets(document);
  if (dragCancelled) { event.dataTransfer.dropEffect = 'none'; return; }
  const plan = planMoves(moveRoots(session.draggingIds, session.index), folderId, session.index);
  const movers = plan.allowed.filter((id) => (session.index.byId.get(id)?.parentId || null) !== (folderId || null));
  if (plan.blocked.length || !movers.length) {
    // Blocked (self / subtree): refuse the drop instead of accepting it and
    // failing server-side. The row stays unpainted so the user gets no signal
    // that the drop would work.
    event.dataTransfer.dropEffect = 'none';
    markDropTarget(event.currentTarget, false);
    if (badgeEl) badgeEl.textContent = '无法移动到此处';
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  event.dataTransfer.dropEffect = 'move';
  markDropTarget(event.currentTarget, true);
  if (badgeEl) badgeEl.textContent = '移动 ' + badgeEl.dataset.sourceLabel + ' → ' + (folderId ? session.index.byId.get(folderId).name : '我的云盘');
}

export function onFolderDragLeave(folderId, event) {
  if (!event || !settled(event.currentTarget, event.relatedTarget)) return;
  markDropTarget(event.currentTarget, false);
  if (!document.querySelector('.is-drop-target')) resetDragBadge();
}

/* dragleave also fires when the pointer moves onto a child; only a leave that
   ends outside the row counts. */
function settled(element, related) {
  if (!element) return false;
  if (!related || typeof element.contains !== 'function') return true;
  return !element.contains(related);
}

export async function onFolderDrop(folderId, event) {
  if (!event || !event.dataTransfer) return;
  const payload = event.dataTransfer.getData(NODE_MIME);
  if (!isMoveDrag(event) && !payload) return;
  event.preventDefault();
  event.stopPropagation();
  const decoded = decodeNodeIds(payload);
  const ids = decoded.length ? decoded : session.draggingIds.slice();
  onRowDragEnd();
  if (dragCancelled) return;
  await moveItems(ids, folderId === undefined ? null : folderId);
}

/**
 * Drag & drop from the desktop onto the shell.
 *
 * The overlay is a counter, not a boolean: dragenter/dragleave fire for every
 * child the pointer crosses, so a boolean flickers the overlay off mid-drag.
 */
export function attachDropZone(shell) {
  let depth = 0;
  let overlay = null;

  const show = () => {
    if (overlay) return;
    overlay = h('div', { class: 'drop-overlay', attrs: { 'aria-hidden': 'true' } },
      h('div', { class: 'drop-box' },
        raw(icon('upload', 26)),
        h('span', { text: '松开以上传到当前文件夹' }),
        h('small', { text: '支持多文件 · 超过 8 MiB 自动分片续传' }),
      ),
    );
    document.body.appendChild(overlay);
  };
  const hide = () => {
    depth = 0;
    if (overlay) { overlay.remove(); overlay = null; }
  };

  shell.addEventListener('dragenter', (event) => {
    if (isMoveDrag(event)) return;
    if (!event.dataTransfer || !Array.from(event.dataTransfer.types || []).includes('Files')) return;
    event.preventDefault();
    depth += 1;
    if (store.state.route.name === 'drive' && store.state.user) show();
  });
  // Only a file drop from outside the page is ours here; a row drag has its own
  // targets (folder rows, breadcrumbs) and this document-wide handler must not
  // swallow it — that is what used to make the whole page accept any drop.
  shell.addEventListener('dragover', (event) => {
    if (!event.dataTransfer) return;
    if (isMoveDrag(event)) {
      clearDropTargets(document);
      resetDragBadge();
      moveDragBadge(event);
      return;
    }
    const types = Array.from(event.dataTransfer.types || []);
    if (!types.includes('Files')) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  shell.addEventListener('dragleave', () => {
    depth -= 1;
    if (depth <= 0) hide();
  });
  shell.addEventListener('drop', async (event) => {
    if (!event.dataTransfer) return;
    // A row drag that reaches the shell was dropped outside any folder target:
    // cancel it quietly instead of uploading a phantom file.
    if (isMoveDrag(event)) { onRowDragEnd(); hide(); return; }
    if (!Array.from(event.dataTransfer.types || []).includes('Files')) return;
    event.preventDefault();
    hide();
    const target = runtime.currentParentId();
    if (target === undefined) return;
    const items = Array.from(event.dataTransfer.items || []);
    // A dropped folder only arrives as an entry tree; a flat FileList would lose
    // both the structure and any empty directory.
    const looksLikeFolder = items.some((item) => {
      const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
      return entry ? entry.isDirectory : false;
    });
    if (looksLikeFolder) {
      const plan = await planFromDataTransfer(items);
      await runtime.uploadFolderPlan(plan, target);
      return;
    }
    const files = Array.from(event.dataTransfer.files || []);
    if (files.length) runtime.uploadFiles(files);
  });
  window.addEventListener('blur', hide);
}
