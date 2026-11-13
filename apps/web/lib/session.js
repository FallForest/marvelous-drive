/*
 * session.js — the shared mutable state of one running client.
 *
 * app.js used to hold all of this in module scope, and every helper reached for
 * it by closure. That is why the file could not be split: the state and the
 * renderers were the same object. Pulling the bindings into one place makes the
 * dependency explicit — a module imports `session`, reads `session.index`, and
 * nothing else has to know who set it.
 *
 * The rule: only app.js (the shell owner) writes these fields. Everything else
 * reads. A writer anywhere else means two owners for one truth.
 */

import { createStore } from './state.js';

/** The store: current user, route, nodes, selection, sort, search. */
export const store = createStore();

/**
 * The mutable bindings of the running page.
 *
 * `index` is rebuilt on every load; `shellEls` holds the mounted DOM; the
 * upload bookkeeping lives here so the upload module and the shell agree.
 */
export const session = {
  /** id → node and parent id → children, rebuilt from the live list. */
  index: { byId: new Map(), children: new Map() },
  /** The mounted shell: { shell, sidebarHost, topbar, toolbar, viewEl, statusbar }. */
  shellEls: null,
  /** The DOM slot the selection bar renders into, or null when there is none. */
  selectionSlot: null,
  /** The lazily created file <input>. */
  filePicker: null,
  /** The route token of the last paint, so a local re-render is not an entrance. */
  paintedToken: null,
  /** Throttle for refreshData(). */
  lastRefreshAt: 0,
  /** The handle returned by renderAuth(), destroyed when the shell mounts. */
  authHandle: null,
  /** True once the upload history has been restored from storage. */
  uploadsRestored: false,
  /** Node ids in the current drag, if any. */
  draggingIds: [],
};
