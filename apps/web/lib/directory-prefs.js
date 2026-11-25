/*
 * directory-prefs.js — per-directory view and sort memory.
 *
 * The list/grid switch and the sort order are a property of the folder, not of
 * the browser: one user's "grid, by size, descending" in a photo folder says
 * nothing about their root directory. Preferences are therefore keyed by the
 * user id and the folder id, with a single key for the root (`null` folder).
 *
 * Only drive routes have a directory to remember. Public shares, search and the
 * trash fall back to the shell's global behaviour. Storage is best-effort: a
 * browser with localStorage disabled must still render and re-sort normally, so
 * both entry points swallow their storage errors.
 */

const PREFIX = 'mdrive-directory:';
const LEGACY_VIEW_KEY = 'mdrive-view';

const VIEWS = new Set(['list', 'grid']);
const SORT_KEYS = new Set(['name', 'size', 'updated']);
const SORT_DIRS = new Set(['asc', 'desc']);

function isDriveRoute(state) {
  return !!state && !!state.route && state.route.name === 'drive';
}

function normalize(value, allowed, fallback) {
  return typeof value === 'string' && allowed.has(value) ? value : fallback;
}

function storageKey(state) {
  const user = state && state.user;
  const userId = user && user.id != null ? String(user.id) : '';
  if (!userId) return null;
  const folderId = state.route && state.route.folderId ? String(state.route.folderId) : '';
  return PREFIX + userId + ':' + (folderId || 'root');
}

/* The pre-directory build stored one global view. It seeds a folder that has no
   preference of its own, so existing users keep the view they last picked. */
function legacyView() {
  try {
    return normalize(localStorage.getItem(LEGACY_VIEW_KEY), VIEWS, '');
  } catch {
    return '';
  }
}

/**
 * Applies the stored preferences for `state.route` to `state`.
 *
 * Each field is validated on its own: a corrupt or half-written record falls
 * back per field instead of discarding the whole entry. Non-drive routes are
 * left untouched.
 */
export function loadDirectoryPrefs(state) {
  if (!isDriveRoute(state)) return;
  let stored = null;
  const key = storageKey(state);
  if (key) {
    try {
      const raw = localStorage.getItem(key);
      stored = raw ? JSON.parse(raw) : null;
    } catch {
      stored = null;
    }
  }
  if (!stored || typeof stored !== 'object') stored = {};

  const fallbackView = legacyView() || 'list';
  state.view = normalize(stored.view, VIEWS, fallbackView);
  state.sortKey = normalize(stored.sortKey, SORT_KEYS, 'name');
  state.sortDir = normalize(stored.sortDir, SORT_DIRS, 'asc');
}

/**
 * Persists the current view and sort for the active drive directory.
 *
 * No-op for non-drive routes and for a signed-out state. Returns whether the
 * write happened; callers never need it to succeed for the UI to continue.
 */
export function saveDirectoryPrefs(state) {
  if (!isDriveRoute(state)) return false;
  const key = storageKey(state);
  if (!key) return false;
  const payload = {
    view: normalize(state.view, VIEWS, 'list'),
    sortKey: normalize(state.sortKey, SORT_KEYS, 'name'),
    sortDir: normalize(state.sortDir, SORT_DIRS, 'asc'),
  };
  try {
    localStorage.setItem(key, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}
