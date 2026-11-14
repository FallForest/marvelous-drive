/*
 * drag-move.js — moving nodes by dragging a row onto a folder.
 *
 * The DOM half is deliberately thin: it only decides whether a drag is *ours*
 * (the payload carries application/x-mdrive-node, not Files) and paints the
 * hover state. Every rule about what may move lives in planMoves(), a pure
 * function over the flat-tree index, so a drag can never disagree with the
 * "移动到…" dialog about what is legal.
 *
 * Selection: dragging a row that is part of the current selection carries the
 * whole selection, dragging any other row carries just that row. The selection
 * is never cleared by a drag — a cancelled drag must leave the UI untouched.
 */

import { isDescendant } from './state.js';

/** Payload type written by drag sources and recognised by drop targets. */
export const NODE_MIME = 'application/x-mdrive-node';

/** Why a node was left out of a move; also the key for the UI copy. */
export const BLOCK_REASON = {
  UNKNOWN: 'unknown',                 // not in the live tree (stale id, another account)
  SELF: 'self',                       // dropped a folder onto itself
  DESCENDANT: 'descendant',           // dropped a folder into its own subtree
  TARGET_MISSING: 'target-missing',   // destination folder is gone
  TARGET_NOT_FOLDER: 'target-not-folder',
};

/** [ 'a', 'b' ] -> 'a,b'. Ids are uuids, so a comma is a safe separator. */
export function encodeNodeIds(ids) {
  const list = Array.isArray(ids) ? ids : Array.from(ids || []);
  const out = [];
  for (const id of list) {
    const value = typeof id === 'string' ? id.trim() : '';
    if (value && !out.includes(value)) out.push(value);
  }
  return out.join(',');
}

/** 'a,b' -> [ 'a', 'b' ]; tolerant of blanks, repeats and a missing payload. */
export function decodeNodeIds(payload) {
  if (payload === undefined || payload === null) return [];
  const out = [];
  for (const part of String(payload).split(',')) {
    const id = part.trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** True when the drag carries moveable nodes (an internal row drag). */
export function hasNodeDrag(dataTransfer) {
  if (!dataTransfer) return false;
  const types = dataTransfer.types;
  if (!types) return false;
  if (typeof types.includes === 'function') return types.includes(NODE_MIME);
  return Array.from(types).includes(NODE_MIME);
}

/**
 * The ids a drag of `nodeId` should carry.
 *
 * Dragging a row that is part of the selection moves the whole selection (the
 * gesture the user already sees highlighted); any other row moves on its own.
 */
export function selectionForDrag(selection, nodeId) {
  const ids = [];
  const add = (value) => {
    const id = typeof value === 'string' ? value.trim() : '';
    if (id && !ids.includes(id)) ids.push(id);
  };
  let contains = false;
  if (selection && typeof selection.has === 'function' && typeof selection[Symbol.iterator] === 'function') {
    contains = selection.has(nodeId);
    if (contains) for (const id of selection) add(id);
  } else if (Array.isArray(selection)) {
    contains = selection.includes(nodeId);
    if (contains) for (const id of selection) add(id);
  }
  if (!ids.length) add(nodeId);
  return ids;
}

/** A selected folder carries its selected descendants; do not flatten them. */
export function moveRoots(selectedIds, index) {
  const ids = decodeNodeIds(encodeNodeIds(selectedIds));
  const selected = new Set(ids);
  const byId = index?.byId || new Map();
  return ids.filter((id) => {
    let parent = byId.get(id)?.parentId;
    const visited = new Set([id]);
    while (parent && !visited.has(parent)) {
      if (selected.has(parent) && byId.get(parent)?.kind === 'folder') return false;
      visited.add(parent);
      parent = byId.get(parent)?.parentId;
    }
    return true;
  });
}

/**
 * planMoves(selectedIds, targetFolderId, index) -> { allowed, blocked }
 *
 * `targetFolderId` may be null for the drive root. A node is allowed when it
 * exists in the index and the destination is neither the node itself nor one
 * of its descendants; everything else is blocked with a stable reason so the
 * caller can explain it (and so a future bulk move can skip silently).
 */
export function planMoves(selectedIds, targetFolderId, index) {
  const byId = (index && index.byId) || new Map();
  const target = targetFolderId ? String(targetFolderId) : null;

  const ids = [];
  const source = Array.isArray(selectedIds)
    ? selectedIds
    : (selectedIds && typeof selectedIds[Symbol.iterator] === 'function' ? Array.from(selectedIds) : []);
  for (const value of source) {
    const id = typeof value === 'string' ? value.trim() : '';
    if (id && !ids.includes(id)) ids.push(id);
  }
  if (!ids.length) return { allowed: [], blocked: [] };

  if (target) {
    const folder = byId.get(target);
    if (!folder) return { allowed: [], blocked: ids.map((id) => ({ id, reason: BLOCK_REASON.TARGET_MISSING })) };
    if (folder.kind !== 'folder') {
      return { allowed: [], blocked: ids.map((id) => ({ id, reason: BLOCK_REASON.TARGET_NOT_FOLDER })) };
    }
  }

  const allowed = [];
  const blocked = [];
  for (const id of ids) {
    const node = byId.get(id);
    // Not in this account's live tree: a cross-account id can never be moved,
    // even though the server would answer 404 for it anyway.
    if (!node) { blocked.push({ id, reason: BLOCK_REASON.UNKNOWN }); continue; }
    if (target && id === target) { blocked.push({ id, reason: BLOCK_REASON.SELF }); continue; }
    if (node.kind === 'folder' && target && isDescendant(index, target, id)) {
      blocked.push({ id, reason: BLOCK_REASON.DESCENDANT });
      continue;
    }
    allowed.push(id);
  }
  return { allowed, blocked };
}

/**
 * Paint (or clear) the hover state of a drop target.
 *
 * The class is the whole contract — the appearance lives in app.css
 * (`.is-drop-target`), so the highlight cross-fades through the same
 * --transition-* tokens as every other hover state. Painting it inline used to
 * make it snap on: an inline background change has no transition, and a drop
 * target that appears instantly reads as a glitch rather than an invitation.
 */
export function markDropTarget(element, active) {
  if (!element || !element.classList) return;
  element.classList.toggle('is-drop-target', !!active);
}

/** Clears every hover state — used when a drag ends or a drop settles. */
export function clearDropTargets(root) {
  const host = root || (typeof document === 'undefined' ? null : document);
  if (!host || typeof host.querySelectorAll !== 'function') return;
  for (const element of host.querySelectorAll('.is-drop-target')) markDropTarget(element, false);
}
