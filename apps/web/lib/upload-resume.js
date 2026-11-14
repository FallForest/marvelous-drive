/*
 * upload-resume.js — the bridge between a stored upload session and a File.
 *
 * A resumable upload survives a pause because the task object keeps its
 * sessionId, and the server keeps the chunks. It does not survive a reload: the
 * File object is gone, and a browser cannot serialize one. What it *can*
 * serialize is a FileSystemFileHandle, so this module keeps that instead:
 *
 *   - right after a file is picked through the handle picker, the handle is put
 *     in IndexedDB under a key derived from (name, size, lastModified);
 *   - on the next page load, restoreCompromisedUploads() asks the server which
 *     upload sessions are still alive, matches them against stored handles, and
 *     hands back enough information to re-create each task;
 *   - a handle is dropped as soon as its upload finishes or is cancelled.
 *
 * Where handles do not exist (Safari, Firefox, or a drop instead of a pick) the
 * module still returns a plan, with `handle: null`: the row then offers "重新
 * 选择文件以继续" and resumes by matching name+size+sha256 against the same
 * server-side session list, which needs no filesystem API at all.
 *
 * Everything that touches IndexedDB is guarded: a private window that throws on
 * open() must degrade to "no resume", never to a broken page.
 */

const DB_NAME = 'mdrive-uploads';
const DB_VERSION = 1;
const STORE = 'handles';

/** A stable identity for one (name, size, mtime) triple. */
export function resumeKey(file) {
  if (!file) return '';
  return [String(file.name || ''), Number(file.size) || 0, Number(file.lastModified) || 0].join(':');
}

function openDb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

/** Remembers the handle for a file so a reload can pick the same bytes again. */
export async function rememberHandle(file, handle, meta) {
  if (!file || !handle) return false;
  const db = await openDb();
  if (!db) return false;
  const record = {
    key: resumeKey(file),
    name: String(file.name || ''),
    size: Number(file.size) || 0,
    lastModified: Number(file.lastModified) || 0,
    sessionId: (meta && meta.sessionId) || null,
    parentId: (meta && meta.parentId) || null,
    at: new Date().toISOString(),
  };
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ ...record, handle });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

/** Drops a remembered handle: the upload is finished or abandoned. */
export async function forgetHandle(fileOrKey) {
  const key = typeof fileOrKey === 'string' ? fileOrKey : resumeKey(fileOrKey);
  if (!key) return false;
  const db = await openDb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

/** Every stored record, newest first. Never throws. */
export async function listHandles() {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).getAll();
      request.onsuccess = () => {
        const rows = Array.isArray(request.result) ? request.result : [];
        rows.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
        resolve(rows);
      };
      request.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

/**
 * Matches live server sessions to local handles.
 *
 * Pure: no IndexedDB, no HTTP. `sessions` is what GET /uploads/sessions returned
 * (`{id, name, size, sha256, parentId, chunkSize, totalChunks, receivedChunks}`);
 * `records` is what listHandles() returned.
 *
 * A match needs name, size and (when both sides have it) sha256 to agree. A
 * name and a size are not proof — two different videos can be the same length —
 * so a sha256 mismatch is a hard "no", while a missing hash on either side is
 * tolerated because an older session may have been opened before hashing.
 */
export function matchSessions(sessions, records) {
  const out = [];
  const used = new Set();
  for (const record of records || []) {
    if (!record || !record.name) continue;
    const candidates = (sessions || []).filter((session) => session
      && !used.has(session.id)
      && session.name === record.name
      && Number(session.size) === Number(record.size));
    const exact = candidates.find((session) => !session.sha256 || !record.sha256 || session.sha256 === record.sha256);
    const chosen = exact || null;
    if (!chosen) continue;
    used.add(chosen.id);
    out.push({ session: chosen, record });
  }
  return out;
}

/**
 * How much of a session is already stored, in bytes. Pure.
 *
 * The server reports chunk indexes, not bytes, so this re-derives the byte
 * count from chunkSize — the last chunk is short when the size is not a
 * multiple, and counting it as a full chunk would report more than 100%.
 */
export function receivedBytes(session) {
  const size = Number(session && session.size) || 0;
  const chunkSize = Number(session && session.chunkSize) || 0;
  if (!size || !chunkSize) return 0;
  let total = 0;
  for (const index of session.receivedChunks || []) {
    const start = index * chunkSize;
    if (start >= size) continue;
    total += Math.min(size, start + chunkSize) - start;
  }
  return Math.min(total, size);
}


/* ── live handles ───────────────────────────────────────────────────────────
 * The picker hands back a FileSystemFileHandle next to the File. The handle is
 * useless to the upload itself (the File is what gets read), but it is the only
 * thing that survives a reload, so it is kept here for the current page and in
 * IndexedDB for the next one. A Map keyed by resumeKey() is enough: one page
 * cannot pick the same name+size+mtime twice.
 */
const liveHandles = new Map();

export function setLiveHandle(file, handle) {
  const key = resumeKey(file);
  if (!key) return;
  if (handle) liveHandles.set(key, handle);
  else liveHandles.delete(key);
}

export function clearLiveHandle(file) {
  setLiveHandle(file, null);
}

/**
 * Re-reads the bytes behind a stored handle and proves they are the same file.
 *
 * A handle is a pointer, not a copy: the user may have edited or replaced the
 * file since. Resuming then would upload a different body under the same
 * session, and the server's sha256 check would reject the completed file — a
 * failure that arrives minutes later with no explanation. Comparing size and
 * mtime up front turns it into an immediate, legible "文件已改变".
 */
export async function fileFromHandle(record, handle) {
  if (!handle || typeof handle.getFile !== 'function') return null;
  let file;
  try {
    file = await handle.getFile();
  } catch {
    return null; // permission revoked, or the file was deleted
  }
  if (!file) return null;
  if (Number(file.size) !== Number(record.size)) return null;
  if (record.lastModified && Number(file.lastModified) !== Number(record.lastModified)) return null;
  return file;
}

/** A row label for a resumable item: "可继续 · 已传 62%". Pure. */
export function resumeLabel(session) {
  const size = Number(session && session.size) || 0;
  const done = receivedBytes(session);
  if (!size) return '可继续';
  const pct = Math.round((done / size) * 100);
  return pct > 0 ? '可继续 · 已传 ' + pct + '%' : '可继续';
}
