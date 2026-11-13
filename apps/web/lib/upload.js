/*
 * upload.js — two upload flows, chosen by size.
 *
 *   <= 8 MiB  PUT /uploads?parentId=&name=      (single request)
 *   >  8 MiB  POST /uploads/sessions + chunked PUTs + complete
 *
 * Before either flow starts, a file above 1 MiB probes GET /blobs/<sha256>:
 * when the server already holds those bytes the upload is reduced to
 * POST /uploads/instant and no content is transferred at all. The probe is a
 * best-effort shortcut — a 404, an old server or a network hiccup falls back to
 * the normal flow silently.
 *
 * Both flows publish progress through an EventTarget-like emitter so the queue
 * UI subscribes once per item. SHA-256 is computed with crypto.subtle and sent
 * as X-Checksum-Sha256 / session sha256 so the server can reject corruption.
 */

import { putRaw, request } from './api.js';

export const SIMPLE_LIMIT = 8 * 1024 * 1024; // 8 MiB
export const CHUNK_SIZE = 8 * 1024 * 1024;   // 8 MiB, matches the contract default
export const INSTANT_LIMIT = 1024 * 1024;    // only files above 1 MiB probe for a dedup hit
export const UPLOAD_CONCURRENCY = 3;         // transfers in flight at once

/** Tiny emitter: on(event, fn) -> off(). Events: progress, state, done. */
export function createEmitter() {
  const listeners = new Map();
  return {
    on(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
      return () => listeners.delete(handler) && listeners.get(type).delete(handler);
    },
    emit(type, payload) {
      const set = listeners.get(type);
      if (!set) return;
      for (const handler of Array.from(set)) {
        try { handler(payload); } catch (error) { console.warn('[mdrive] upload listener failed', error); }
      }
    },
  };
}

export function supportsSubtle() {
  return !!(typeof crypto !== 'undefined' && crypto.subtle && typeof crypto.subtle.digest === 'function');
}

/** Lowercase hex SHA-256 of a Blob/ArrayBuffer. Returns '' when unavailable. */
export async function sha256(blob) {
  if (!supportsSubtle()) return '';
  let buffer;
  if (blob instanceof Blob) buffer = await blob.arrayBuffer();
  else buffer = blob;
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function mimeOf(file) {
  if (file.type) return file.type;
  const name = String(file.name || '').toLowerCase();
  if (name.endsWith('.md') || name.endsWith('.markdown')) return 'text/markdown';
  if (name.endsWith('.txt') || name.endsWith('.log')) return 'text/plain';
  if (name.endsWith('.json')) return 'application/json';
  if (name.endsWith('.pdf')) return 'application/pdf';
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (name.endsWith('.csv')) return 'text/csv';
  return 'application/octet-stream';
}

/** 1.2 MB/s from a byte rate. */
export function formatSpeed(bytesPerSecond) {
  const value = Number(bytesPerSecond) || 0;
  if (value <= 0) return '';
  if (value < 1024) return Math.round(value) + ' B/s';
  if (value < 1024 * 1024) return (value / 1024).toFixed(0) + ' KB/s';
  return (value / (1024 * 1024)).toFixed(1) + ' MB/s';
}

/** Whole seconds left at the measured speed, or null when nothing is moving. */
export function etaSeconds(remainingBytes, bytesPerSecond) {
  const remaining = Number(remainingBytes) || 0;
  const speed = Number(bytesPerSecond) || 0;
  if (remaining <= 0) return 0;
  if (speed <= 0) return null;
  return Math.max(1, Math.round(remaining / speed));
}

/** Row status line: "1.2 MB/s · 剩余 8s" while bytes move, otherwise "42%". */
export function transferLabel(task) {
  const t = task || {};
  const pct = Math.round((Number(t.progress) || 0) * 100);
  const speed = Number(t.speed) || 0;
  const eta = etaSeconds((Number(t.size) || 0) - (Number(t.uploaded) || 0), speed);
  if (speed > 0 && eta !== null && eta > 0) return formatSpeed(speed) + ' · 剩余 ' + eta + 's';
  return pct + '%';
}

function encodeQuery(params) {
  const search = new URLSearchParams();
  for (const key of Object.keys(params)) {
    const value = params[key];
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? '?' + text : '';
}

let counter = 0;
function nextId() {
  counter += 1;
  return 'up-' + Date.now().toString(36) + '-' + counter;
}

function abortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * Ask the server whether it already holds these bytes.
 *
 * Resolves to { node, deduplicated } when the file was created without a body,
 * or null for every other outcome — the caller then uploads normally. Nothing in
 * here may fail an upload: the probe is a shortcut, not a requirement.
 */
export async function tryInstantUpload(task, file, options) {
  const opts = options || {};
  const client = opts.client || { request, putRaw };
  const hash = opts.hash || '';
  if (!hash || !file || !(file.size > INSTANT_LIMIT)) return null;
  if (typeof client.request !== 'function') return null;

  let probe = null;
  try {
    probe = await client.request('/blobs/' + encodeURIComponent(hash), { signal: opts.signal });
  } catch (error) {
    if (error && error.name === 'AbortError') throw error;
    return null; // 404 on a server without the route, or a network blip
  }
  if (!probe || probe.exists !== true) return null;

  try {
    const payload = await client.request('/uploads/instant', {
      method: 'POST',
      signal: opts.signal,
      body: {
        name: task.name,
        parentId: opts.parentId || undefined,
        sha256: hash,
        size: file.size,
        mime: task.type,
        onConflict: opts.onConflict || undefined,
      },
    });
    const node = payload && payload.node ? payload.node : payload;
    if (!node || !node.id) return null;
    return { node, deduplicated: true };
  } catch (error) {
    if (error && error.name === 'AbortError') throw error;
    // BLOB_NOT_FOUND (the blob was evicted meanwhile) or an old build: upload it.
    return null;
  }
}

/**
 * Create an upload task.
 *
 * options: { file, parentId, onConflict, api }
 *   api: { request, putRaw } — injected so the module stays testable.
 * Returns a task with: id, name, size, state, progress, cancel(), pause(),
 * resume(), retry(), start(), and an emitter (on).
 */
export function createUploadTask(options) {
  const opts = options || {};
  const file = opts.file;
  const parentId = opts.parentId || null;
  const onConflict = opts.onConflict || null;
  const client = opts.api || { request, putRaw };
  const emitter = createEmitter();
  let controller = new AbortController();
  let running = null;
  let pauseRequested = false;

  const task = {
    id: nextId(),
    name: file.name,
    size: file.size,
    type: mimeOf(file),
    parentId,
    onConflict,
    state: 'queued',     // queued | hashing | uploading | finalizing | paused | done | error | canceled
    progress: 0,         // 0..1
    uploaded: 0,
    sessionId: null,
    chunkSize: CHUNK_SIZE,
    deduplicated: false, // true when the server already held these bytes
    error: null,
    node: null,
    attempts: 0,
    startedAt: 0,
    speed: 0,
    on: emitter.on,
  };

  function setState(state, extra) {
    task.state = state;
    emitter.emit('state', { task, state, ...(extra || {}) });
  }
  function setProgress(loaded, total) {
    task.uploaded = loaded;
    task.progress = total > 0 ? Math.min(1, loaded / total) : 0;
    const elapsed = Date.now() - task.startedAt;
    task.speed = elapsed > 400 ? loaded / (elapsed / 1000) : 0;
    emitter.emit('progress', { task, loaded, total, progress: task.progress, speed: task.speed });
  }
  function isPaused() {
    return pauseRequested || task.state === 'paused';
  }
  function fail(error) {
    if (error && error.name === 'AbortError') {
      task.error = null;
      if (isPaused()) {
        pauseRequested = true;
        if (task.state !== 'paused') setState('paused');
        return;
      }
      setState('canceled');
      return;
    }
    task.error = error;
    setState('error', { message: error && error.message ? error.message : '上传失败' });
  }

  /** Hard stop: aborts the transfer and drops the resumable session server side. */
  task.cancel = () => {
    if (task.state === 'done' || task.state === 'canceled') return;
    pauseRequested = false;
    controller.abort();
    if (task.sessionId) {
      // Best effort: drop the temp chunks on the server.
      try {
        client.request('/uploads/sessions/' + encodeURIComponent(task.sessionId), { method: 'DELETE' }).catch(() => {});
      } catch { /* ignore */ }
    }
    if (task.state !== 'canceled') setState('canceled');
  };

  /**
   * Soft stop: aborts the transfer but keeps the session, so resume() continues
   * from the chunks the server already holds.
   */
  task.pause = () => {
    const state = task.state;
    if (state === 'done' || state === 'canceled' || state === 'error' || state === 'paused') return false;
    pauseRequested = true;
    controller.abort();
    if (task.state !== 'paused') setState('paused');
    return true;
  };

  task.resume = () => {
    if (task.state !== 'paused') return Promise.resolve(task.node);
    pauseRequested = false;
    return task.start();
  };

  task.retry = () => {
    if (task.state !== 'error' && task.state !== 'canceled') return Promise.resolve(task.node);
    task.error = null;
    return task.start();
  };

  async function runUpload(signal) {
    task.attempts += 1;
    task.startedAt = Date.now();
    task.progress = 0;
    task.uploaded = 0;
    task.speed = 0;
    if (!task.sessionId) task.deduplicated = false;
    setState('hashing');
    try {
      let hash = '';
      try { hash = await sha256(file); } catch { hash = ''; }
      if (signal.aborted) throw abortError();

      const instant = await tryInstantUpload(task, file, { hash, parentId, onConflict, client, signal });
      if (instant) {
        task.node = instant.node;
        task.deduplicated = true;
        setProgress(task.size, task.size);
        task.progress = 1;
        setState('done');
        emitter.emit('done', { task, node: task.node });
        return task.node;
      }
      if (signal.aborted) throw abortError();

      setState('uploading');
      if (file.size <= SIMPLE_LIMIT) {
        const node = await (client.putRaw || putRaw)(
          '/uploads' + encodeQuery({ parentId, name: file.name, onConflict }),
          file,
          {
            contentType: task.type,
            headers: hash ? { 'X-Checksum-Sha256': hash } : undefined,
            signal,
            onProgress: setProgress,
          },
        );
        task.node = node && node.node ? node.node : node;
      } else {
        task.node = await resumableUpload(task, file, {
          parentId, hash, client, signal, onConflict, setState, setProgress,
        });
      }
      setProgress(task.size, task.size);
      task.progress = 1;
      setState('done');
      emitter.emit('done', { task, node: task.node });
      return task.node;
    } catch (error) {
      fail(error);
      throw error;
    }
  }

  /**
   * One attempt. A paused task keeps its task object (and its session id), so
   * resume() simply calls start() again; the AbortSignal is recreated because an
   * aborted signal can never be reused.
   */
  task.start = function start() {
    if (running) return running;
    task.error = null;
    pauseRequested = false;
    controller = new AbortController();
    const signal = controller.signal;
    running = runUpload(signal).finally(() => { running = null; });
    return running;
  };

  return task;
}

/** Chunked session flow with resume support (GET session -> skip received). */
async function resumableUpload(task, file, options) {
  const client = options.client;
  const request = client.request;
  const chunkSize = Math.min(Math.max(CHUNK_SIZE, 64 * 1024), 64 * 1024 * 1024);
  const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));

  let session = null;
  if (task.sessionId) {
    try {
      const resumed = await request('/uploads/sessions/' + encodeURIComponent(task.sessionId));
      if (resumed && resumed.upload) session = resumed.upload;
    } catch { session = null; }
  }
  if (!session) {
    const created = await request('/uploads/sessions', {
      method: 'POST',
      body: {
        name: file.name,
        size: file.size,
        sha256: options.hash || undefined,
        parentId: options.parentId || undefined,
        chunkSize,
      },
    });
    session = created && created.upload ? created.upload : created;
  }
  task.sessionId = session.id;
  task.chunkSize = session.chunkSize || chunkSize;

  const received = new Set(Array.isArray(session.receivedChunks) ? session.receivedChunks : []);
  const size = task.chunkSize;
  let sent = 0;
  for (let index = 0; index < totalChunks; index += 1) {
    const start = index * size;
    const end = Math.min(file.size, start + size);
    if (received.has(index)) { sent += end - start; continue; }
    const chunk = file.slice(start, end);
    // Progress is reported across the whole file, not per chunk.
    const baseUploaded = sent;
    await (client.putRaw || putRaw)(
      '/uploads/sessions/' + encodeURIComponent(session.id) + '/chunks/' + index,
      chunk,
      {
        contentType: 'application/octet-stream',
        signal: options.signal,
        onProgress: (loaded) => options.setProgress(baseUploaded + loaded, file.size),
      },
    );
    sent += end - start;
    options.setProgress(sent, file.size);
  }

  options.setState('finalizing');
  const completed = await request('/uploads/sessions/' + encodeURIComponent(session.id) + '/complete', { method: 'POST' });
  return completed && completed.node ? completed.node : completed;
}

/**
 * The upload scheduler: keeps at most limit transfers in flight and refills a
 * slot as soon as one settles, so dropping 200 files starts 3 of them.
 *
 * pause() soft-stops every running task (their sessions stay valid) and parks
 * them; resume() puts the parked tasks back at the front of the queue. A failing
 * task only frees its own slot — the rest of the queue keeps going.
 */
export function createUploadScheduler(options) {
  const opts = options || {};
  const limit = Math.max(1, Math.floor(Number(opts.limit) || UPLOAD_CONCURRENCY));
  const startTask = typeof opts.start === 'function' ? opts.start : (task) => task.start();
  const pending = [];
  const active = new Set();
  const parked = [];
  let paused = false;
  let idleWaiters = [];

  const isIdle = () => active.size === 0 && pending.length === 0 && parked.length === 0;
  function settleIdle() {
    if (!isIdle() || !idleWaiters.length) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function pump() {
    while (!paused && active.size < limit && pending.length) {
      const task = pending.shift();
      active.add(task);
      let job;
      try { job = Promise.resolve(startTask(task)); } catch (error) { job = Promise.reject(error); }
      job.then(() => {}, () => {}).finally(() => {
        active.delete(task);
        // A parked task is unfinished, not settled: resume() restarts it.
        if (task && task.state === 'paused') parked.push(task);
        pump();
        settleIdle();
      });
    }
    settleIdle();
  }

  return {
    limit,
    get paused() { return paused; },
    get activeCount() { return active.size; },
    get pendingCount() { return pending.length; },

    /** Queue one task; it starts immediately when a slot is free. */
    add(task) {
      if (!task) return;
      pending.push(task);
      pump();
    },
    addAll(tasks) {
      for (const task of tasks || []) if (task) pending.push(task);
      pump();
    },

    /** 全部暂停: abort what is running, keep everything else queued. */
    pause() {
      if (paused) return;
      paused = true;
      for (const task of Array.from(active)) {
        if (task && typeof task.pause === 'function') task.pause();
      }
    },

    /** 全部继续: re-queue the parked tasks in front of the untouched ones. */
    resume() {
      if (!paused) return;
      paused = false;
      if (parked.length) pending.unshift(...parked.splice(0));
      pump();
    },

    /** The tasks currently transferring (a snapshot, safe to iterate). */
    activeTasks() { return Array.from(active); },

    /** Resolves once nothing is running and nothing is waiting. */
    whenIdle() {
      if (isIdle()) return Promise.resolve();
      return new Promise((resolve) => { idleWaiters.push(resolve); });
    },
  };
}
