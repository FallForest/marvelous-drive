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

export const UPLOAD_HISTORY_KEY = 'mdrive-uploads';
export const UPLOAD_HISTORY_LIMIT = 30;

const TERMINAL = new Set(['done', 'error', 'canceled']);
const KNOWN_STATES = new Set(['queued', 'hashing', 'uploading', 'finalizing', 'paused', 'done', 'error', 'canceled']);

/** Is this stored entry a finished task (restorable as history)? */
export function isFinishedState(state) {
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
export function outcomeOf(task) {
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

function notify(handler, payload) {
  if (typeof handler !== 'function') return;
  try { handler(payload); } catch (error) { console.warn('[mdrive] uploader listener failed', error); }
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

  /** Queue one file and wait for it — the folder plan uploads sequentially. */
  async function enqueueAndWait(file, parentId, conflict) {
    const task = enqueue(file, parentId, conflict);
    return outcomeOf(task);
  }

  /** Reads the stored history once at boot; returns how many uploads were cut off. */
  function restore() {
    const stored = sanitizeHistory(readStored(), UPLOAD_HISTORY_LIMIT);
    const split = splitHistory(stored);
    finished = split.history;
    interrupted = split.interrupted.length;
    // Unfinished entries cannot be re-created without their File object, so
    // they are counted once and then dropped instead of faked.
    persist();
    if (queue && typeof queue.trackHistory === 'function') queue.trackHistory(finished);
    return interrupted;
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
    restore,
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
