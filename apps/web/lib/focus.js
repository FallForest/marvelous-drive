/*
 * focus.js — the focus lifetime of overlays and the one place a route puts the
 * caret back.
 *
 * Two problems share one module because they share one cause: a popup is not a
 * descendant of the dialog that opened it.
 *
 *   1. A modal traps Tab inside its own subtree (dom.js trapFocus). A menu is
 *      appended to <body> so it can float over anything, which means the trap
 *      never sees it: Tab at the last menu item left the dialog, and choosing an
 *      item removed the focused node and dropped the caret on <body>.
 *   2. A real navigation re-mounts the view and detaches whatever row had focus.
 *      The caret then sits on <body>, so the next Tab restarts at the top of the
 *      document instead of continuing from the folder the user just opened.
 *
 * The registry is deliberately tiny: depth-first, DOM order, no ownership rules.
 * Anything that wants to be part of a modal's tab cycle registers while it is
 * open and unregisters when it closes.
 */

/**
 * The single definition of "focusable" the client uses.
 *
 * It lives here rather than in dom.js because ui.js needs the same selector to
 * compute the dialog + popup cycle, and dom.js already imports this module: a
 * second copy is exactly how a menu item ends up counted by one side and
 * invisible to the other.
 */
export const FOCUSABLE_SELECTOR = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

const popups = new Set();

/** Adds an element to the tab cycle of every open modal. Returns its unregister. */
export function registerPopup(element) {
  if (!element) return () => {};
  popups.add(element);
  return () => { popups.delete(element); };
}

export function unregisterPopup(element) {
  if (element) popups.delete(element);
}

/** Registered popups that are still in the document, in document order. */
export function popupElements() {
  const live = [];
  for (const element of popups) {
    if (element && element.isConnected) live.push(element);
    else popups.delete(element);
  }
  return live.sort(compareDocumentOrder);
}

/**
 * Focusables of the registered popups, in document order.
 *
 * The visibility filter is the same one trapFocus applies to its own subtree: a
 * popup that is mid-close or hidden must drop out of the cycle the moment it
 * stops being reachable, not one animation frame later.
 */
export function popupFocusables(selector) {
  const query = selector || FOCUSABLE_SELECTOR;
  const out = [];
  for (const popup of popupElements()) {
    if (typeof popup.querySelectorAll !== 'function') continue;
    for (const element of popup.querySelectorAll(query)) {
      if (isFocusable(element)) out.push(element);
    }
  }
  return out;
}

/**
 * The tab cycle of a container: its own focusables followed by the registered
 * popups, deduplicated.
 *
 * Popups are appended to <body>, so "the container's focusables then the popups"
 * is already DOM order — the dialog is mounted before anything it opens.
 */
export function tabCycle(container, selector) {
  const query = selector || FOCUSABLE_SELECTOR;
  const items = [];
  const seen = new Set();
  if (container && typeof container.querySelectorAll === 'function') {
    for (const element of container.querySelectorAll(query)) {
      if (seen.has(element) || !isFocusable(element)) continue;
      seen.add(element);
      items.push(element);
    }
  }
  for (const element of popupFocusables(query)) {
    if (seen.has(element)) continue;
    seen.add(element);
    items.push(element);
  }
  return items;
}

/**
 * Puts focus on the page a navigation landed on.
 *
 * Returns true when it moved focus. The caller decides *whether* to call it: a
 * mouse click that opens a folder must not scroll the user away from the row
 * they aimed at, so the shell only asks when the navigation came from a key.
 *
 * The heading is the target, not the first row: it is stable (a folder can be
 * empty), it announces where the user is, and it is one Tab from the list.
 */
export function focusRouteContent(viewEl) {
  if (!viewEl || typeof viewEl.querySelector !== 'function') return false;
  // Only a caret that has nowhere to be is moved: <body>, or an element the last
  // render detached. A control the user is still standing on — the search field
  // that survived the render, a dialog opened by the same key press — keeps it,
  // because stealing focus mid-typing is worse than a missing announcement.
  if (!focusWasLost()) return false;
  const heading = viewEl.querySelector('[data-route-heading]');
  const target = heading || viewEl;
  if (!target || typeof target.focus !== 'function') return false;
  // A heading is not focusable on its own: focus() on an <h1> without a tabindex
  // is a silent no-op, which is exactly how "focus went to the new page" could
  // look implemented while the caret stayed on <body>. tabindex="-1" makes it
  // focusable by script and keeps it out of the tab order, which is what a
  // heading used as a landing target should be.
  if (typeof target.hasAttribute === 'function' && !target.hasAttribute('tabindex')) {
    target.setAttribute('tabindex', '-1');
  }
  target.focus({ preventScroll: true });
  // The return value is the only honest answer: focus() is allowed to do nothing
  // (a hidden view, a transition mid-snapshot), and a caller that assumes success
  // would leave the caret on <body> without ever noticing.
  return document.activeElement === target;
}

/** True when the active element is <body>, missing, or no longer in the document. */
function focusWasLost() {
  if (typeof document === 'undefined') return false;
  const active = document.activeElement;
  if (!active || active === document.body) return true;
  if (active.isConnected === false) return true;
  return typeof document.contains === 'function' ? !document.contains(active) : false;
}

function isFocusable(element) {
  if (!element) return false;
  if (typeof element.hasAttribute === 'function' && element.hasAttribute('hidden')) return false;
  return element.offsetParent !== null;
}

/** Document order for two nodes; 0 (insertion order) when the host cannot tell. */
function compareDocumentOrder(a, b) {
  if (a === b) return 0;
  if (typeof a.compareDocumentPosition !== 'function') return 0;
  const relation = a.compareDocumentPosition(b);
  // Node.DOCUMENT_POSITION_FOLLOWING === 4, PRECEDING === 2.
  if (relation & 4) return -1;
  if (relation & 2) return 1;
  return 0;
}
