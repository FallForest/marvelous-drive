/*
 * row-action.js — what a plain click on a row means.
 *
 * The drive used to be Windows Explorer: single click selected, double click
 * opened. That is the one gesture Notion, Apple Files, Dropbox and GitHub's file
 * browser all refuse to copy, and it is wrong here for a smaller reason too —
 * a web row has no other "primary action" to take, so a click that only paints
 * a highlight looks like nothing happened.
 *
 * The model this module states, in one place, so the row, the grid card and the
 * keyboard all agree:
 *
 *   plain click  -> the item's primary action (a folder navigates, a file previews)
 *   checkbox     -> selection
 *   Ctrl/Cmd     -> additive selection
 *   Shift        -> range selection
 *   Enter        -> primary action, Space -> selection
 *
 * Trash is the one exception: nothing there is meant to be opened, so a click
 * selects and the restore/purge verbs live in the selection bar and the menu.
 */

/** The two things a click can do. */
export const ROW_ACTION = { OPEN: 'open', SELECT: 'select' };

/** What a plain click on `node` does inside `routeName`. */
export function rowAction(routeName, node) {
  if (!node) return ROW_ACTION.SELECT;
  if (routeName === 'trash') return ROW_ACTION.SELECT;
  return ROW_ACTION.OPEN;
}

/** 'folder' navigates; everything else opens the preview drawer. */
export function openKind(node) {
  return node && node.kind === 'folder' ? 'folder' : 'preview';
}

/**
 * True when the pointer gesture is asking for selection, not for the primary
 * action. Modifier clicks keep working before the pointer ever reaches a row's
 * click handler, so a drag-select never navigates away mid-gesture.
 */
export function isSelectionClick(event) {
  if (!event) return false;
  return !!(event.metaKey || event.ctrlKey || event.shiftKey);
}

/**
 * A double click is two clicks, and both of them now open. Muscles trained on
 * Explorer will keep doing it, so the app has to survive it:
 *
 *  - opening a file twice stacks two preview drawers;
 *  - opening a folder twice pushes the same route twice;
 *  - worse, the second click lands on the *new* page, so a double-clicked
 *    folder can open whichever row appeared under the pointer.
 *
 * The second click of a double click arrives within the system threshold of the
 * first, and no honest gesture asks for a second action that fast, so any row
 * click inside the window after an open is swallowed. The window is deliberately
 * shorter than a typical double-click time: the guard only has to catch the
 * echo, not to police how quickly a user may move on.
 */
const OPEN_ECHO_MS = 320;
let lastOpenAt = -Infinity;

/** Record that an open just ran, so its echo can be recognised. */
export function noteOpen(now) {
  lastOpenAt = now === undefined ? Date.now() : now;
}

/** True when this click is the echo of the click that already opened something. */
export function isRepeatClick(node, event, now) {
  const stamp = now === undefined ? Date.now() : now;
  void node;
  void event;
  return stamp - lastOpenAt < OPEN_ECHO_MS;
}

/** Test seam: forget the last open so a test starts from a clean gesture. */
export function resetClickGuard() {
  lastOpenAt = -Infinity;
}
