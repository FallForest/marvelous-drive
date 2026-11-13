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
import { api } from './api.js';
import { toast } from './ui.js';
import {
  NODE_MIME, clearDropTargets, decodeNodeIds, encodeNodeIds, hasNodeDrag, markDropTarget, planMoves, selectionForDrag,
} from './drag-move.js';
import { planFromDataTransfer } from './folder-upload.js';
import { store, session } from './session.js';
import { runtime } from './runtime.js';
import { lookupNode } from './actions.js';

export function onRowDragStart(node, event) {
  if (!event.dataTransfer || session.shellEls === null) return;
  if (store.state.route.name === 'trash') { event.preventDefault(); return; }
  // Dragging a row that is part of the selection carries the whole selection;
  // dragging any other row carries just that row. The selection itself is left
  // alone — a cancelled drag must not change what is highlighted.
  const ids = selectionForDrag(store.state.selection, node.id).filter((id) => lookupNode(id));
  if (!ids.length) { event.preventDefault(); return; }
  session.draggingIds = ids;
  try {
    event.dataTransfer.setData(NODE_MIME, encodeNodeIds(ids));
    // Some browsers reset the payload unless a text/plain copy exists too; drop
    // targets still key off NODE_MIME only, so a Files drop stays a Files drop.
    event.dataTransfer.setData('text/plain', node.name || '');
  } catch { /* older engines without setData still get effectAllowed */ }
  event.dataTransfer.effectAllowed = 'move';
  document.body.classList.add('is-moving');
}

export function onRowDragEnd() {
  session.draggingIds = [];
  document.body.classList.remove('is-moving');
  clearDropTargets(document);
}

/** True when this event is one of our row drags (never an OS file drop). */
export function isMoveDrag(event) {
  if (!event || !hasNodeDrag(event.dataTransfer)) return false;
  if (Array.from(event.dataTransfer.types || []).includes('Files')) return false;
  return true;
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
  const plan = planMoves(session.draggingIds, folderId, session.index);
  if (!plan.allowed.length) {
    // Blocked (self / subtree): refuse the drop instead of accepting it and
    // failing server-side. The row stays unpainted so the user gets no signal
    // that the drop would work.
    event.dataTransfer.dropEffect = 'none';
    markDropTarget(event.currentTarget, false);
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  event.dataTransfer.dropEffect = 'move';
  markDropTarget(event.currentTarget, true);
}

export function onFolderDragLeave(folderId, event) {
  if (!event || !settled(event.currentTarget, event.relatedTarget)) return;
  markDropTarget(event.currentTarget, false);
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
  markDropTarget(event.currentTarget, false);
  const ids = decodeNodeIds(payload).length ? decodeNodeIds(payload) : session.draggingIds.slice();
  session.draggingIds = [];
  document.body.classList.remove('is-moving');
  await moveByDrag(ids, folderId === undefined ? null : folderId);
}

/** Serial PUTs, one toast: "已移动 N 项 / M 项失败". */
export async function moveByDrag(ids, targetFolderId) {
  const target = targetFolderId || null;
  const plan = planMoves(ids, target, session.index);
  if (!plan.allowed.length) {
    const first = plan.blocked[0];
    if (first) toast(blockedMessage(first.reason), { type: 'warning' });
    return;
  }
  const folder = target ? session.index.byId.get(target) : null;
  const label = folder ? folder.name : '我的云盘';

  let moved = 0;
  let failed = plan.blocked.length;
  for (const id of plan.allowed) {
    try {
      await api.put('/nodes/' + id, { parentId: target });
      moved += 1;
    } catch (error) {
      failed += 1;
    }
  }
  if (moved && failed) toast('已移动 ' + moved + ' 项到 ' + label + '，' + failed + ' 项失败', { type: 'warning' });
  else if (moved) toast('已移动 ' + moved + ' 项到 ' + label, { type: 'success', timeout: 2200 });
  else toast('没有可移动的项目（' + moved + ' 项成功，' + failed + ' 项失败）', { type: 'warning' });
  if (folder) store.state.expanded.add(folder.id);
  await runtime.refreshData();
}

function blockedMessage(reason) {
  switch (reason) {
    case 'self': return '不能把文件夹移动到它自己里面。';
    case 'descendant': return '不能把文件夹移动到它自己的子文件夹里。';
    case 'target-missing': return '目标文件夹不存在或已删除。';
    case 'target-not-folder': return '只能拖动到文件夹上。';
    default: return '无法移动这些项目。';
  }
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
    const types = Array.from(event.dataTransfer.types || []);
    if (!types.includes('Files')) {
      if (types.includes(NODE_MIME)) event.dataTransfer.dropEffect = 'move';
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
