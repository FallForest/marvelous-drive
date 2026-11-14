/*
 * upload-queue.js — the uploader behind the queue panel.
 *
 * Three responsibilities, one instance for the whole page:
 *   1. scheduling: every task (picked files, dropped files, folder plans) goes
 *      through one scheduler, so at most UPLOAD_CONCURRENCY transfers run;
 *   2. 全部暂停 / 全部继续: pause soft-stops the running tasks and parks them,
 *      resume restarts them from the resumable session;
 *   3. history: the summary of every finished task (name, size, parentId,
 *      sessionId, state) is kept in localStorage["mdrive-uploads"]. A refreshed
 *      page cannot rebuild a File object, so old entries are shown as history
 *      and unfinished ones only produce a "last time N uploads did not finish"
 *      notice — nothing here fakes progress.
 */

import { request, putRaw } from './api.js';
import { createUploadTask, createUploadScheduler, UPLOAD_CONCURRENCY } from './upload.js';

const UPLOAD_HISTORY_KEY = 'mdrive-uploads';
const UPLOAD_HISTORY_LIMIT = 30;

const TERMINAL = new Set(['done', 'error', 'canceled']);
const KNOWN_STATES = new Set(['queued', 'hashing', 'uploading', 'finalizing', 'paused', 'done', 'error', 'canceled']);

/** Is this stored entry a finished task (restorable as history)? */
function isFinishedState(state) {
  return TERMINAL.has(String(state || ''));
}

/**
 * One history record for a task. Pure: the caller owns persistence.
 * Only plain data — a File handle cannot survive a reload.
 */
export function summarizeTask(task) {
  const t = task || {};
  return {
    name: String(t.name || ''),
    size: Number(t.size) || 0,
    parentId: t.parentId || null,
    sessionId: t.sessionId || null,
    state: isFinishedState(t.state) ? t.state : 'interrupted',
    deduplicated: t.deduplicated === true,
    at: new Date().toISOString(),
  };
}

/** Drop anything malformed and keep the newest limit entries. Pure. */
export function sanitizeHistory(entries, limit) {
  const max = Number(limit) > 0 ? Number(limit) : UPLOAD_HISTORY_LIMIT;
  const list = Array.isArray(entries) ? entries : [];
  const clean = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const name = String(entry.name || '').trim();
    if (!name) continue;
    const state = String(entry.state || '');
    if (!KNOWN_STATES.has(state) && state !== 'interrupted') continue;
    clean.push({
      name,
      size: Math.max(0, Number(entry.size) || 0),
      parentId: typeof entry.parentId === 'string' && entry.parentId ? entry.parentId : null,
      sessionId: typeof entry.sessionId === 'string' && entry.sessionId ? entry.sessionId : null,
      state,
      deduplicated: entry.deduplicated === true,
      at: typeof entry.at === 'string' ? entry.at : '',
    });
  }
  return clean.slice(-max);
}

/** Split stored entries into "show as history" and "was still running". Pure. */
export function splitHistory(entries) {
  const history = [];
  const interrupted = [];
  for (const entry of entries || []) {
    if (isFinishedState(entry && entry.state)) history.push(entry);
    else interrupted.push(entry);
  }
  return { history, interrupted };
}

function readStored() {
  try {
    const raw = window.localStorage.getItem(UPLOAD_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStored(entries) {
  try {
    window.localStorage.setItem(UPLOAD_HISTORY_KEY, JSON.stringify(entries));
    return true;
  } catch {
    return false; // private mode / quota: the queue still works, it just forgets
  }
}

/** Resolves with the task node, rejects when the task failed or was canceled. */
function outcomeOf(task) {
  if (task.state === 'done') return Promise.resolve(task.node);
  if (task.state === 'error' || task.state === 'canceled') {
    return Promise.reject(task.error || new Error(task.state === 'canceled' ? '已取消' : '上传失败'));
  }
  return new Promise((resolve, reject) => {
    task.on('state', (event) => {
      if (event.state === 'done') resolve(task.node);
      else if (event.state === 'error') reject(task.error || new Error('上传失败'));
      else if (event.state === 'canceled') reject(task.error || new Error('已取消'));
    });
  });
}

/**
 * options: { queue, api, limit }
 *   queue: the panel from createQueuePanel(); optional, the uploader works
 *          headless (that is what the tests use).
 */
export function createUploader(options) {
  const opts = options || {};
  const queue = opts.queue || null;
  const client = opts.api || { request, putRaw };
  const limit = Math.max(1, Math.floor(Number(opts.limit) || UPLOAD_CONCURRENCY));
  const scheduler = createUploadScheduler({
    limit,
    start: (task) => (task && typeof task.start === 'function' ? task.start() : Promise.resolve()),
  });
  let finished = [];
  let interrupted = 0;

  function persist() {
    writeStored(sanitizeHistory(finished, UPLOAD_HISTORY_LIMIT));
  }

  function remember(task) {
    if (!task) return;
    finished = sanitizeHistory(finished.concat([summarizeTask(task)]), UPLOAD_HISTORY_LIMIT);
    persist();
  }

  /** Register with the panel, record the terminal state, expose pause state. */
  function register(task) {
    if (queue) queue.track(task);
    task.on('state', (event) => {
      if (isFinishedState(event.state)) remember(task);
    });
    return task;
  }

  /** Adopt a task that already exists (its own emitter stays in charge). */
  function add(task) {
    register(task);
    scheduler.add(task);
    return task;
  }

  /** Create a task for one file and queue it. */
  function enqueue(file, parentId, conflict) {
    return add(createUploadTask({
      file,
      parentId: parentId === undefined ? null : parentId,
      onConflict: conflict || null,
      api: client,
    }));
  }

  function enqueueAll(files, parentId, conflict) {
    const tasks = [];
    for (const file of Array.from(files || [])) {
      if (!file) continue;
      tasks.push(createUploadTask({
        file,
        parentId: parentId === undefined ? null : parentId,
        onConflict: conflict || null,
        api: client,
      }));
    }
    for (const task of tasks) register(task);
    scheduler.addAll(tasks);
    return tasks;
  }

  /**
   * Queue a file into an existing server session.
   *
   * The task starts with the session id already set, so it skips the dedup
   * probe and asks the server which chunks it still needs. `uploaded` is
   * pre-seeded with the bytes the server already holds, so the row opens at the
   * real percentage instead of 0%.
   */
  function enqueueResume(file, session, parentId) {
    const task = add(createUploadTask({
      file,
      parentId: parentId === undefined ? null : parentId,
      onConflict: null,
      api: client,
      sessionId: session.id,
    }));
    const already = session.receivedChunks ? session.receivedChunks : [];
    const chunkSize = Number(session.chunkSize) || 0;
    const size = Number(session.size) || file.size;
    let bytes = 0;
    for (const index of already) {
      const start = index * chunkSize;
      if (chunkSize && start < size) bytes += Math.min(size, start + chunkSize) - start;
    }
    if (bytes > 0) {
      task.uploaded = bytes;
      task.progress = size > 0 ? Math.min(1, bytes / size) : 0;
    }
    return task;
  }

  /**
   * Removes the `可继续` row once the user has claimed its session.
   *
   * The queue keeps a placeholder per live session so a resume is one click;
   * as soon as the real task exists the placeholder would be a second row for
   * the same bytes.
   */
  function claimSessionRow(sessionId) {
    if (queue && typeof queue.dropResumable === 'function') queue.dropResumable(sessionId);
  }

  /** Queue one file and wait for it — the folder plan uploads sequentially. */
  async function enqueueAndWait(file, parentId, conflict) {
    const task = enqueue(file, parentId, conflict);
    return outcomeOf(task);
  }

  /**
   * Reads the stored history once at boot, then asks the server which sessions
   * are still alive.
   *
   * This used to stop at history: a page that closed mid-upload showed "上次有
   * N 个上传未完成" and the N entries were deleted. The session, however, lives
   * for another 24 h with every chunk on disk — the client was throwing away a
   * resumable upload it only had to claim. Now the interrupt is counted, the
   * finished rows come back as history, and every live session becomes a row
   * that can actually be resumed.
   *
   * Returns the number of uploads that were cut off by the reload.
   */
  function restore() {
    const stored = sanitizeHistory(readStored(), UPLOAD_HISTORY_LIMIT);
    const split = splitHistory(stored);
    finished = split.history;
    interrupted = split.interrupted.length;
    persist();
    if (queue && typeof queue.trackHistory === 'function') queue.trackHistory(finished);
    return interrupted;
  }

  /**
   * Claims this account's live upload sessions and shows them as resumable.
   *
   * `resolve` maps a server session to a local record (a stored file handle);
   * the caller supplies it because only the page knows about IndexedDB and the
   * picker. A session with no resolver still gets a row — resuming it then goes
   * through the file picker.
   */
  async function claimSessions(options) {
    const opts = options || {};
    if (!queue || typeof queue.trackResumable !== 'function') return { claimed: 0 };
    if (typeof client.request !== 'function') return { claimed: 0 };
    let payload;
    try {
      payload = await client.request('/uploads/sessions');
    } catch {
      return { claimed: 0 }; // an old server, an offline tab: nothing to claim
    }
    const sessions = (payload && (payload.uploads || payload.sessions)) || [];
    if (!Array.isArray(sessions) || !sessions.length) return { claimed: 0 };
    const matched = typeof opts.match === 'function' ? opts.match(sessions) : [];
    // Every live session is worth a row, matched or not: without a stored handle
    // resuming asks for the file again, which is still infinitely better than
    // re-uploading bytes the server already has.
    const claimedIds = new Set(matched.map((item) => item.session && item.session.id));
    for (const session of sessions) {
      if (!session || !session.id || claimedIds.has(session.id)) continue;
      matched.push({ session, record: null });
    }
    for (const item of matched) {
      queue.trackResumable({
        session: item.session,
        ratio: typeof opts.ratio === 'function' ? opts.ratio(item.session) : 0,
        label: item.label,
        onResume: () => { if (typeof opts.onResume === 'function') opts.onResume(item); },
        onDiscard: () => {
          client.request('/uploads/sessions/' + encodeURIComponent(item.session.id), { method: 'DELETE' }).catch(() => {});
          queue.dropResumable(item.session.id);
        },
      });
    }
    return { claimed: matched.length };
  }

  return {
    limit,
    get paused() { return scheduler.paused; },
    get interruptedCount() { return interrupted; },
    get history() { return finished.slice(); },
    add,
    enqueue,
    enqueueAll,
    enqueueAndWait,
    enqueueResume,
    claimSessionRow,
    restore,
    claimSessions,
    whenIdle: () => scheduler.whenIdle(),

    pauseAll() {
      scheduler.pause();
      if (queue && typeof queue.setPaused === 'function') queue.setPaused(true);
      persist();
    },
    resumeAll() {
      scheduler.resume();
      if (queue && typeof queue.setPaused === 'function') queue.setPaused(false);
    },
    clearFinished() {
      finished = [];
      persist();
      if (queue && typeof queue.clearFinished === 'function') queue.clearFinished();
    },
    /** Called from pagehide: unfinished work is remembered as interrupted. */
    markInterrupted() {
      const live = [];
      for (const task of scheduler.activeTasks()) {
        if (!isFinishedState(task.state)) live.push(summarizeTask(task));
      }
      if (!live.length) return 0;
      writeStored(sanitizeHistory(finished.concat(live), UPLOAD_HISTORY_LIMIT));
      return live.length;
    },
  };
}
