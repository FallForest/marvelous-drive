/*
 * downloads.js — the page's download center.
 *
 * Firefox puts every download in one panel for a reason: a single click on a
 * 2 GiB file gives no feedback for minutes, and the browser's own shelf is not
 * part of this page. This module keeps the same model:
 *
 *   - one compact entry in the global topbar, always reachable while the page
 *     is open, with a count and a progress hairline;
 *   - one panel listing every task: single files, batches and ZIP archives;
 *   - a task that reports exactly what it knows: packaging (real server-side
 *     entry/byte progress when reported, otherwise indeterminate), transferring
 *     (real response bytes, percent only with a trusted length), handed to the
 *     browser, canceled or failed with a readable reason.
 *
 * The transport stays in api.js. A task only describes "prepare (optional) →
 * fetch → save", so the ZIP flow can refuse to delete its carrier until the
 * save really happened, and a retry can reuse a carrier that already exists.
 *
 * A ZIP carrier is either a real node (an older server) or, on a current one, a
 * row in the archive-download registry that carries its own expiry. Only the
 * temporary kind is fetched through its own route, and only it can be dropped:
 * when the registry no longer has it, the next retry packages it again.
 *
 * Rendering is deliberately plain: the panel is built once, rows are keyed by
 * task id and updated in place. Progress repaints are throttled, because a
 * fast LAN can deliver hundreds of chunks per second.
 */

import { h, raw } from './dom.js';
import { icon, bytes } from './format.js';
import { fetchBlob, saveBlob, contentUrl, archiveDownloadUrl, saveDownloadStream } from './api.js';
import { registerPopup } from './focus.js';
import { formatSpeed } from './upload.js';

/* The streamed-to-disk save lives with the transport (api.js) so both download
   paths share one set of status and length rules; it is re-exported here because
   this module is the download surface a page imports from. */
export { saveDownloadStream };

let counter = 0;

function abortError() {
  const error = new Error('已取消下载。');
  error.name = 'AbortError';
  error.code = 'ABORTED';
  return error;
}

function isAbort(error) {
  return Boolean(error) && (error.name === 'AbortError' || error.code === 'ABORTED');
}

function messageOf(error) {
  const text = error && error.message ? String(error.message).trim() : '';
  return text || '下载失败，请重试。';
}

/** A carrier built by the archive-download registry instead of a real node. */
function isTemporaryCarrier(carrier) {
  return Boolean(carrier) && carrier.temporary === true;
}

/**
 * True once a temporary carrier's own expiry has passed.
 *
 * `expiresAt` is the registry's ISO timestamp. A missing or unreadable one is
 * no proof of expiry — the fetch then answers ARCHIVE_DOWNLOAD_UNAVAILABLE,
 * which is handled one step later — so only a parsed, past date qualifies.
 */
function carrierExpired(carrier, now) {
  const expires = carrier && carrier.expiresAt;
  if (!expires) return false;
  const at = Date.parse(String(expires));
  return Number.isFinite(at) && at <= now;
}

/** Remove every child: the fake DOM used by node --test has no replaceChildren. */
function clearNode(el) {
  while (el.childNodes.length) el.removeChild(el.childNodes[0]);
}

/** Show or hide an element without relying on toggleAttribute. */
function setHidden(el, hidden) {
  if (hidden) el.setAttribute('hidden', 'hidden');
  else el.removeAttribute('hidden');
}

/** The state word a task leads with. */
const DOWNLOAD_STATE_LABEL = Object.freeze({
  packaging: '正在打包',
  waiting: '准备保存',
  starting: '准备下载',
  transferring: '正在传输',
  saving: '正在交给浏览器保存',
  done: '已交给浏览器保存',
  failed: '下载失败',
  canceled: '已取消',
});

/** Marks a malformed field in a packaging event (a value the server may not send). */
const INVALID = Symbol('invalid');

/**
 * One numeric field of a packaging event.
 *
 * Missing/null is "unknown"; anything that is not a finite, non-negative number
 * (entry counts must also be whole) invalidates the whole event. Numbers are
 * not coerced from strings: an event the page cannot trust is not shown.
 */
function eventCount(value, integer) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return INVALID;
  if (integer && !Number.isInteger(value)) return INVALID;
  return value;
}

/**
 * The trusted part of a packaging progress event, or null.
 *
 * `{ entriesCompleted, entriesTotal, bytesCompleted, bytesTotal }`: entry counts
 * are whole numbers, byte counts are finite non-negative numbers, and at least
 * one of them has to be present. A completed value above its total is not
 * rejected (a server may count differently) but the ratio is clamped by the
 * caller, exactly like transfer bytes.
 */
function normalizePackagingProgress(event) {
  if (!event || typeof event !== 'object') return null;
  const entriesCompleted = eventCount(event.entriesCompleted, true);
  const entriesTotal = eventCount(event.entriesTotal, true);
  const bytesCompleted = eventCount(event.bytesCompleted, false);
  const bytesTotal = eventCount(event.bytesTotal, false);
  if ([entriesCompleted, entriesTotal, bytesCompleted, bytesTotal].includes(INVALID)) return null;
  if (entriesCompleted === null && entriesTotal === null && bytesCompleted === null && bytesTotal === null) return null;
  return { entriesCompleted, entriesTotal, bytesCompleted, bytesTotal };
}

/**
 * The frozen snapshot kept on the task: the validated event without the fields
 * the server left out, so `task.packagingProgress` reads like the event itself
 * and a later mutation of the caller's object cannot rewrite painted numbers.
 */
function packagingSnapshot(validated) {
  const snapshot = {};
  for (const key of ['entriesCompleted', 'entriesTotal', 'bytesCompleted', 'bytesTotal']) {
    if (validated[key] !== null) snapshot[key] = validated[key];
  }
  return Object.freeze(snapshot);
}

/**
 * What packaging can honestly say, plus the ratio it implies.
 *
 * The ratio comes from content bytes when the server gave a nonzero byte total,
 * and from processed entries otherwise (an archive with no byte total yet, or a
 * zero-byte one). With neither, `percent` is null and the caller falls back to
 * the indeterminate bar: a packer that never reports stays as unknown as before.
 */
function packagingStatus(progress) {
  const event = normalizePackagingProgress(progress);
  if (!event) return null;
  const { entriesCompleted, entriesTotal, bytesCompleted, bytesTotal } = event;
  const parts = [];
  let percent = null;
  const entriesKnown = entriesTotal !== null && entriesTotal > 0;
  // A server that counts one more entry than it announced must not print
  // "21/20", and the ratio is clamped exactly like transfer bytes.
  const entriesDone = entriesKnown && entriesCompleted !== null
    ? Math.min(entriesCompleted, entriesTotal)
    : entriesCompleted;

  if (bytesTotal !== null && bytesTotal > 0 && bytesCompleted !== null) {
    percent = Math.min(1, bytesCompleted / bytesTotal);
  } else if (entriesKnown && entriesCompleted !== null) {
    percent = Math.min(1, entriesCompleted / entriesTotal);
  }
  if (percent !== null) parts.push(Math.round(percent * 100) + '%');

  // Content bytes as the server counted them: X / Y, or just Y when it has not
  // reported a completed figure yet. "已处理 X" never pretends to be a total.
  if (bytesTotal !== null) {
    parts.push(bytesCompleted !== null
      ? bytes(bytesCompleted) + ' / ' + bytes(bytesTotal)
      : '内容共 ' + bytes(bytesTotal));
  } else if (bytesCompleted !== null && bytesCompleted > 0) {
    parts.push('已处理 ' + bytes(bytesCompleted));
  }

  if (entriesKnown) {
    parts.push(entriesDone === null
      ? '共 ' + entriesTotal + ' 项'
      : '已处理 ' + entriesDone + '/' + entriesTotal + ' 项');
  } else if (entriesCompleted !== null && entriesCompleted > 0) {
    parts.push('已处理 ' + entriesCompleted + ' 项');
  }

  if (!parts.length) return null;
  return { detail: '打包中 · ' + parts.join(' · '), percent };
}

/**
 * The one honest sentence about a task, plus the bar ratio it implies.
 *
 * `percent` is null whenever the task did not give a trustworthy total: packaging
 * without a progress event, a chunked/compressed response, or an unknown-length
 * stream. The UI then shows an indeterminate bar and the bytes received, never a
 * guessed 0% that would sit at "almost done" for a whole minute.
 *
 * Returns { label, detail, percent }.
 */
export function downloadStatus(task) {
  const t = task || {};
  const state = String(t.state || 'starting');
  const label = DOWNLOAD_STATE_LABEL[state] || '准备下载';
  const received = Math.max(0, Number(t.received) || 0);
  const total = Number.isFinite(t.total) && t.total >= 0 ? Number(t.total) : null;
  const speed = Number(t.speed) > 0 ? formatSpeed(t.speed) : '';

  if (state === 'packaging') {
    const pack = packagingStatus(t.packagingProgress);
    if (pack) return { label, detail: pack.detail, percent: pack.percent };
    return { label, detail: '打包中 · 总量未知 · 打包完成后开始下载', percent: null };
  }
  if (state === 'waiting') {
    // Nothing moved yet: the caller's own sentence (a server-side pack, a disk
    // picker) is the only honest detail. Never a guessed percentage.
    return { label, detail: t.waitingDetail || '正在准备下载…', percent: null };
  }
  if (state === 'starting') return { label, detail: '正在连接…', percent: null };
  if (state === 'transferring') {
    if (total === 0) {
      // An empty file has a trusted total of zero and is complete on arrival.
      return { label, detail: bytes(0), percent: 1 };
    }
    if (total !== null) {
      const ratio = Math.min(1, received / total);
      const parts = [Math.round(ratio * 100) + '%', bytes(received) + ' / ' + bytes(total)];
      if (speed) parts.push(speed);
      return { label, detail: parts.join(' · '), percent: ratio };
    }
    return { label, detail: ['已收 ' + bytes(received), speed].filter(Boolean).join(' · '), percent: null };
  }
  if (state === 'saving') {
    // Every byte has arrived; the page is handing the blob to the browser's own
    // download machinery. `total: 0` means an empty file, which is still 100%.
    const percent = total === null ? null : 1;
    return { label, detail: total !== null ? bytes(total) : '已收 ' + bytes(received), percent };
  }
  if (state === 'done') {
    // A streamed save already wrote the file: "交给浏览器保存" would be a lie.
    return {
      label: t.savedToDisk ? '已保存到磁盘' : label,
      detail: bytes(received) || '已完成',
      percent: 1,
    };
  }
  if (state === 'failed') {
    return { label, detail: t.message || '下载失败，可以重试。', percent: total ? Math.min(1, received / total) : null };
  }
  if (state === 'canceled') {
    return { label, detail: received > 0 ? '已收 ' + bytes(received) + ' · 可以重试' : '可以重试', percent: null };
  }
  return { label, detail: '', percent: null };
}

/**
 * One download center. `options` exists for tests: transport and the final save
 * are injectable, and the DOM is only built when entry()/open() ask for it.
 *
 * `options.panelId` names the panel element. The drive keeps the default id, so
 * every existing entry point is unchanged; a second center on the same document
 * (the anonymous share page) passes its own id so two panels never share one.
 */
export function createDownloadCenter(options) {
  const opts = options || {};
  const panelId = String(opts.panelId || 'downloads-panel');
  const deps = {
    fetchBlob: opts.fetchBlob || fetchBlob,
    saveBlob: opts.saveBlob || saveBlob,
    saveDownloadStream: opts.saveDownloadStream || saveDownloadStream,
    contentUrl: opts.contentUrl || contentUrl,
    archiveDownloadUrl: opts.archiveDownloadUrl || archiveDownloadUrl,
    now: opts.now || (() => Date.now()),
    setTimeout: opts.setTimeout || ((fn, ms) => setTimeout(fn, ms)),
    clearTimeout: opts.clearTimeout || ((handle) => clearTimeout(handle)),
    makeAbortController: opts.makeAbortController || (() => new AbortController()),
  };

  const tasks = [];
  const rows = new Map();
  let panel = null;
  let listEl = null;
  let summaryEl = null;
  let entryState = null;
  let panelOpen = false;
  let setDirty = true;
  let paintTimer = 0;
  let lastPaintAt = 0;
  let escapeBound = false;
  let destroyed = false;
  /** Release for focus.js while the panel is open; null while it is closed. */
  let releasePopup = null;

  /* ── task lifecycle ───────────────────────────────────────────── */

  function start(spec) {
    const task = {
      id: 'dl-' + deps.now().toString(36) + '-' + (++counter),
      name: String(spec.name || '下载'),
      kind: spec.kind === 'archive' ? 'archive' : 'file',
      // A caller-supplied transfer may have to prepare something before it can
      // move bytes; say so instead of "connecting" to a URL that is not fetched.
      state: spec.prepare ? 'packaging' : (typeof spec.transfer === 'function' ? 'waiting' : 'starting'),
      phase: spec.prepare ? 'packaging' : 'transfer',
      received: 0,
      total: null,
      speed: 0,
      error: null,
      message: '',
      carrier: null,
      /** Last validated packaging event ({entriesCompleted, ...}) or null. */
      packagingProgress: null,
      /** The sentence a caller-owned transfer shows before its first byte. */
      waitingDetail: typeof spec.waitingDetail === 'string' ? spec.waitingDetail : '',
      /** True once an attempt saved its bytes itself (not through the browser). */
      savedToDisk: false,
      settled: false,
      spec,
      controller: null,
      promise: null,
      cancel() {
        // A packaging request has no bytes to stop, but aborting its signal is
        // still what tells the artifact route to give up.
        if (task.settled) return false;
        if (task.controller) task.controller.abort();
        return true;
      },
      retry() {
        if (!task.settled) return task;
        if (task.state !== 'failed' && task.state !== 'canceled') return task;
        // A temporary carrier past its expiry can never be fetched again: drop
        // it before this attempt starts so it packages exactly once instead of
        // spending a round trip to be told the registry no longer has it. A
        // legacy carrier is a real node with no expiry, and is never touched.
        if (spec.prepare && isTemporaryCarrier(task.carrier) && carrierExpired(task.carrier, deps.now())) {
          task.carrier = null;
        }
        task.promise = execute(task);
        return task;
      },
    };
    tasks.push(task);
    // Keep the list bounded: a page open for a week must not accumulate history
    // the user cannot clear. Failed and active tasks are never dropped.
    let pruned = false;
    while (tasks.filter((item) => item.settled && item.state === 'done').length > 12) {
      const oldest = tasks.find((item) => item.settled && item.state === 'done');
      if (!oldest) break;
      tasks.splice(tasks.indexOf(oldest), 1);
      rows.delete(oldest.id);
      pruned = true;
    }
    // Only a removal invalidates DOM order. A new task is appended, so the panel
    // can add one row instead of rebuilding the list — which would detach the
    // retry button a keyboard user may already be standing on.
    if (pruned) setDirty = true;
    publish(true);
    task.promise = execute(task);
    // A batch opens the panel once (its first file) and then leaves it alone:
    // re-opening a panel the user closed once per file would be a fight.
    if (spec.reveal !== false) reveal();
    const handle = {
      task,
      cancel: () => task.cancel(),
      retry: () => { task.retry(); return handle; },
    };
    // A getter, not a snapshot: retry() replaces the task's promise, and a caller
    // that awaits `done` after pressing 重试 must wait for the new attempt.
    Object.defineProperty(handle, 'done', { get: () => task.promise, enumerable: true });
    return handle;
  }

  async function execute(task) {
    const spec = task.spec;
    task.error = null;
    task.message = '';
    task.received = 0;
    task.total = null;
    task.speed = 0;
    // The disk save flag belongs to one attempt: a failed streamed save retried
    // through a Blob must not still claim "已保存到磁盘".
    task.savedToDisk = false;
    // A caller-owned transfer may have something to finish before its first
    // byte (a server-side pack, a disk picker); say so in its own words.
    task.waitingDetail = typeof spec.waitingDetail === 'string' ? spec.waitingDetail : '';
    // A retry is a new attempt: last attempt's packaging numbers must not be
    // painted over the new one before it reports anything of its own.
    task.packagingProgress = null;
    task.settled = false;
    const controller = deps.makeAbortController();
    task.controller = controller;
    const signal = controller.signal;
    let lastAt = deps.now();
    let lastReceived = 0;

    const stop = (error) => {
      task.settled = true;
      if (isAbort(error) || signal.aborted) {
        task.state = 'canceled';
        task.error = null;
        task.message = '';
      } else {
        task.state = 'failed';
        task.error = error || new Error('下载失败，请重试。');
        task.message = messageOf(error);
      }
      task.speed = 0;
      publish(true);
      return {
        state: task.state, phase: task.phase, error: task.error, message: task.message,
        carrier: task.carrier, task,
      };
    };

    const progress = (loaded, total) => {
      // A late chunk from an abandoned attempt must not paint over the retry
      // that replaced it.
      if (signal.aborted || task.settled || task.controller !== controller) return;
      task.received = Math.max(0, Number(loaded) || 0);
      task.total = Number.isFinite(total) && total >= 0 ? Number(total) : null;
      const now = deps.now();
      const elapsed = now - lastAt;
      // Speed from real deltas, lightly smoothed: a single chunk burst should
      // not print "400 MB/s" and then "2 KB/s" a frame later.
      if (elapsed >= 250) {
        const delta = task.received - lastReceived;
        if (delta > 0) {
          const instant = delta / (elapsed / 1000);
          task.speed = task.speed > 0 ? task.speed * 0.6 + instant * 0.4 : instant;
        }
        lastAt = now;
        lastReceived = task.received;
      }
      if (task.state !== 'transferring') {
        task.state = 'transferring';
        task.phase = 'transfer';
      }
      publish(false);
    };

    /**
     * Packaging progress from the artifact route.
     *
     * The event is validated before it is kept, and it is only kept while THIS
     * attempt is still packaging with THIS controller: a late event from a
     * canceled or already-finished build must not overwrite the live row or
     * paint a stale percentage over a retry that started afterwards.
     */
    const packaging = (event) => {
      if (signal.aborted || task.settled || task.controller !== controller) return;
      if (task.state !== 'packaging') return;
      const validated = normalizePackagingProgress(event);
      if (!validated) return;
      task.packagingProgress = packagingSnapshot(validated);
      publish(false);
    };

    try {
      if (spec.prepare && !task.carrier) {
        task.state = 'packaging';
        task.phase = 'packaging';
        task.total = null;
        task.packagingProgress = null;
        publish(true);
        const carrier = await spec.prepare({ signal, onProgress: packaging });
        if (!carrier || !carrier.id) throw new Error('服务器没有返回压缩包。');
        // Record the carrier BEFORE looking at the signal: a cancel that landed
        // while the archive was being built still created it on the server, and
        // the task has to know that node exists so a retry can reuse it and the
        // caller can say "your archive is still in the list".
        task.carrier = carrier;
        task.name = String(carrier.name || task.name);
        if (signal.aborted) throw abortError();
      }

      if (signal.aborted) throw abortError();
      task.phase = 'transfer';
      // A caller that owns the bytes says so before anything is fetched: the row
      // shows its own sentence, never a guessed percentage over unknown work.
      task.state = typeof spec.transfer === 'function' ? 'waiting' : 'starting';
      publish(true);

      if (typeof spec.transfer === 'function') {
        // The transfer writes the file itself (a disk picker, a server-side pack)
        // and resolves once its bytes are saved to disk. It is called with no
        // await in between, so a picker still holds the click's user activation.
        const saved = await spec.transfer({ signal, onProgress: progress });
        if (signal.aborted) throw abortError();
        let size = saved && Number.isFinite(saved.size) ? Number(saved.size) : null;
        if (size === null && saved && spec.url
          && (typeof saved.createWritable === 'function' || saved.kind === 'file')) {
          // A transfer may answer with the file handle itself instead of saving:
          // stream the bytes into it here, still never through a Blob.
          const written = await deps.saveDownloadStream(String(spec.url), saved, {
            auth: spec.auth !== false,
            signal,
            onProgress: progress,
          });
          if (signal.aborted) throw abortError();
          size = written && Number.isFinite(written.size) ? Number(written.size) : task.received;
        }
        if (size === null) size = task.total;
        task.savedToDisk = true;
        task.speed = 0;
        task.state = 'done';
        if (size !== null) task.total = size;
        task.received = task.total !== null ? task.total : task.received;
        task.settled = true;
        publish(true);
        // Same release contract as a fetched delivery: the caller's cleanup runs
        // only after the save really happened, off the task's own promise.
        if (typeof spec.onDelivered === 'function') {
          Promise.resolve().then(() => spec.onDelivered(task.carrier)).catch(() => {});
        }
        return { state: 'done', error: null, message: '', carrier: task.carrier, task };
      }

      const target = task.carrier || spec.node;
      // A direct URL needs no node: the share page builds its own /shared/…
      // route. The private session keeps reading a node's content route, and a
      // temporary carrier its own archive route.
      let url;
      let direct = false;
      if (target && target.id) {
        // A temporary carrier is only reachable through its own route; every
        // server-supplied URL is ignored, so the page never fetches a full URL it
        // was handed. A legacy carrier node keeps reading its content route.
        url = isTemporaryCarrier(target)
          ? deps.archiveDownloadUrl(target.id)
          : deps.contentUrl(target.id, { download: true });
      } else if (spec.url) {
        url = String(spec.url);
        direct = true;
      } else {
        throw new Error('找不到要下载的文件。');
      }
      // The private session's call shape is untouched: its options carry exactly
      // the signal and listener they always did. A caller-built URL is the
      // anonymous path, so it passes its auth intent and optional limit.
      const fetchOptions = { signal, onProgress: progress };
      if (direct) {
        // Public share bytes never carry the drive session's bearer token.
        fetchOptions.auth = spec.auth !== false;
        if (spec.maxBytes !== undefined) fetchOptions.maxBytes = spec.maxBytes;
      }
      let blob;
      try {
        blob = await deps.fetchBlob(url, fetchOptions);
      } catch (error) {
        // The registry no longer has these bytes. Forget the carrier so the next
        // user retry builds it once more; a cancel and an ordinary transfer
        // failure both keep it, so those retries still reuse what exists.
        if (isTemporaryCarrier(target) && error && error.code === 'ARCHIVE_DOWNLOAD_UNAVAILABLE') {
          task.carrier = null;
        }
        throw error;
      }
      if (signal.aborted) throw abortError();

      task.phase = 'deliver';
      task.state = 'saving';
      if (blob && Number.isFinite(blob.size)) task.received = Math.max(task.received, blob.size);
      publish(true);
      // A spec may name the file it wants saved; the private session keeps
      // using the node name, exactly as before.
      await deps.saveBlob(blob, spec.filename || (target && target.name) || task.name);

      task.state = 'done';
      if (blob && Number.isFinite(blob.size)) task.total = blob.size;
      task.received = task.total !== null ? task.total : task.received;
      task.speed = 0;
      task.settled = true;
      publish(true);
      // Cleanup is the caller's business and this attempt already succeeded: run
      // it in a microtask so a throwing or slow release cannot fail the task.
      if (typeof spec.onDelivered === 'function') {
        Promise.resolve().then(() => spec.onDelivered(task.carrier)).catch(() => {});
      }
      return { state: 'done', error: null, message: '', carrier: task.carrier, task };
    } catch (error) {
      return stop(error);
    }
  }

  /* ── painting ─────────────────────────────────────────────────── */

  function publish(immediate) {
    if (!entryState && !panel) return;
    const now = deps.now();
    if (!immediate && now - lastPaintAt < 100) {
      if (!paintTimer) {
        paintTimer = deps.setTimeout(() => { paintTimer = 0; paint(); }, 120);
        if (paintTimer && typeof paintTimer.unref === 'function') paintTimer.unref();
      }
      return;
    }
    lastPaintAt = now;
    paint();
  }

  /** Drop a throttled repaint that has not run: it would outlive its center. */
  function cancelPaint() {
    if (!paintTimer) return;
    try { deps.clearTimeout(paintTimer); } catch { /* already fired */ }
    paintTimer = 0;
  }

  function paint() {
    paintEntry();
    if (panel && panelOpen) paintPanel();
  }

  function liveTasks() {
    return tasks.filter((task) => !task.settled);
  }

  /** Settled tasks by outcome. Canceled is its own count, never a failure. */
  function counted() {
    const counts = { done: 0, failed: 0, canceled: 0 };
    for (const task of tasks) {
      if (task.state === 'done') counts.done += 1;
      else if (task.state === 'failed') counts.failed += 1;
      else if (task.state === 'canceled') counts.canceled += 1;
    }
    return counts;
  }

  function paintEntry() {
    if (!entryState) return;
    const live = liveTasks();
    const { failed, canceled } = counted();
    // A canceled task is finished but still retriable from the panel, so the
    // entry keeps counting it: without that, canceling the last download made
    // the only way back look like there was nothing left on the page.
    const badge = live.length || failed + canceled;
    if (badge) {
      entryState.count.textContent = String(badge);
      entryState.count.removeAttribute('hidden');
    } else {
      entryState.count.textContent = '';
      entryState.count.setAttribute('hidden', 'hidden');
    }
    entryState.count.classList.toggle('is-error', !live.length && failed > 0);
    entryState.button.classList.toggle('is-active', live.length > 0);
    entryState.button.classList.toggle('has-error', !live.length && failed > 0);
    entryState.button.setAttribute('aria-expanded', panelOpen ? 'true' : 'false');
    const label = !badge
      ? '下载任务'
      : (live.length
        ? '下载任务：' + live.length + ' 个进行中'
        : failed
          ? '下载任务：' + failed + ' 个失败'
          : '下载任务：' + canceled + ' 个已取消');
    entryState.button.setAttribute('aria-label', label);
    entryState.button.setAttribute('title', label);

    if (!live.length) {
      entryState.bar.setAttribute('hidden', 'hidden');
      return;
    }
    entryState.bar.removeAttribute('hidden');
    let ratio = null;
    let unknown = false;
    for (const task of live) {
      if (task.state === 'transferring' || task.state === 'starting' || task.state === 'saving') {
        if (task.total && task.total > 0) ratio = Math.max(ratio || 0, Math.min(1, task.received / task.total));
        else unknown = true;
      } else if (task.state === 'packaging') {
        // Packaging counts toward the hairline only with a real number from the
        // server; without one the whole bar stays indeterminate, as before.
        const pack = packagingStatus(task.packagingProgress);
        if (pack && pack.percent !== null) ratio = Math.max(ratio || 0, pack.percent);
        else unknown = true;
      } else {
        unknown = true;
      }
    }
    entryState.bar.classList.toggle('is-indeterminate', unknown);
    if (!unknown) entryState.barFill.style.transform = 'scaleX(' + (ratio || 0).toFixed(3) + ')';
  }

  function paintPanel() {
    if (!panel || !listEl) return;
    summaryEl.textContent = panelSummary();
    if (setDirty) {
      // Rows are keyed by task id, so a rebuild is only needed when the ORDER
      // changed (a task was pruned). Appending a new task keeps every existing
      // button where the user's focus already is.
      clearNode(listEl);
      rows.clear();
      setDirty = false;
    }
    if (!tasks.length) {
      if (!listEl.querySelector('.dl-empty')) {
        clearNode(listEl);
        listEl.appendChild(h('div', { class: 'dl-empty', text: '暂无下载任务。' }));
      }
      return;
    }
    if (listEl.querySelector('.dl-empty')) clearNode(listEl);
    for (const task of tasks) {
      const row = rowFor(task);
      paintRow(row, task);
      if (row.el.parentNode !== listEl) listEl.appendChild(row.el);
    }
  }

  function panelSummary() {
    const live = liveTasks();
    const { done, failed, canceled } = counted();
    if (live.length) {
      const packaging = live.filter((task) => task.state === 'packaging').length;
      const rest = live.length - packaging;
      const parts = [];
      if (packaging) parts.push(packaging + ' 个正在打包');
      if (rest) parts.push(rest + ' 个进行中');
      if (canceled) parts.push(canceled + ' 个已取消');
      return parts.join(' · ');
    }
    if (failed) {
      // A canceled task is retriable too, so it is named next to the failures but
      // never as one: "2 个失败，1 个已取消，可以重试" is the honest sentence.
      return failed + ' 个失败' + (canceled ? '，' + canceled + ' 个已取消' : '') + '，可以重试';
    }
    if (canceled) {
      // The cancel state is reachable with zero bytes moved: saying "已全部交给
      // 浏览器保存" over a list of canceled rows told the user the opposite of
      // what happened on screen.
      return done
        ? done + ' 个已保存，' + canceled + ' 个已取消'
        : canceled + ' 个已取消，可以重试';
    }
    if (!tasks.length) return '暂无下载';
    // A streamed save wrote its own file; only the Blob path handed bytes to the
    // browser's own download machinery.
    let saved = 0;
    for (const task of tasks) if (task.savedToDisk) saved += 1;
    if (saved === 0) return '已全部交给浏览器保存';
    return saved === tasks.length ? '已全部保存到磁盘' : saved + ' 个已保存到磁盘';
  }

  function rowFor(task) {
    let row = rows.get(task.id);
    if (row) return row;
    const nameEl = h('span', { class: 'dl-name' });
    const stateEl = h('span', { class: 'dl-state' });
    const barFill = h('i', { style: { transform: 'scaleX(0)' } });
    const bar = h('div', {
      class: 'dl-bar',
      attrs: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': '下载进度' },
    }, barFill);
    const metaEl = h('div', { class: 'dl-meta' });
    const cancelBtn = h('button', {
      class: 'icon-btn',
      attrs: { type: 'button', title: '取消下载' },
      html: icon('x', 13),
      on: { click: () => task.cancel() },
    });
    const retryBtn = h('button', {
      class: 'icon-btn',
      attrs: { type: 'button', title: '重试下载' },
      html: icon('refresh', 13),
      on: { click: () => task.retry() },
    });
    const actions = h('div', { class: 'dl-actions' }, cancelBtn, retryBtn);
    const el = h('div', {
      class: 'dl-item',
      dataset: { id: task.id, state: task.state },
      attrs: { role: 'listitem' },
    },
      h('div', { class: 'dl-copy' },
        h('div', { class: 'dl-line' }, nameEl, stateEl),
        bar,
        metaEl,
      ),
      actions,
    );
    row = { el, nameEl, stateEl, bar, barFill, metaEl, cancelBtn, retryBtn };
    rows.set(task.id, row);
    return row;
  }

  function paintRow(row, task) {
    const status = downloadStatus(task);
    row.el.dataset.state = task.state;
    row.nameEl.textContent = task.name;
    row.stateEl.textContent = status.label;
    row.metaEl.textContent = status.detail;
    row.cancelBtn.setAttribute('aria-label', '取消下载 ' + task.name);
    row.retryBtn.setAttribute('aria-label', '重试下载 ' + task.name);
    setHidden(row.cancelBtn, task.settled);
    setHidden(row.retryBtn, !(task.state === 'failed' || task.state === 'canceled'));

    const percent = status.percent;
    const indeterminate = percent === null
      && (task.state === 'waiting' || task.state === 'packaging' || task.state === 'starting'
        || task.state === 'transferring' || task.state === 'saving');
    row.bar.classList.toggle('is-indeterminate', indeterminate);
    row.bar.setAttribute('aria-valuetext', status.label + ' ' + status.detail);
    if (percent === null) row.bar.removeAttribute('aria-valuenow');
    else row.bar.setAttribute('aria-valuenow', String(Math.round(percent * 100)));
    if (!indeterminate) row.barFill.style.transform = 'scaleX(' + (percent === null ? 0 : percent).toFixed(3) + ')';
  }

  /* ── panel + entry chrome ─────────────────────────────────────── */

  function ensurePanel() {
    // A destroyed center must not resurrect itself: a late reveal() from a task
    // that finished after destroy() would otherwise re-add the panel and its
    // Escape listener to a page this instance no longer owns.
    if (destroyed) return null;
    if (panel) return panel;
    listEl = h('div', { class: 'dl-list', attrs: { role: 'list' } });
    summaryEl = h('span', { class: 'dl-summary', attrs: { role: 'status', 'aria-live': 'polite' } });
    const clearBtn = h('button', {
      class: 'icon-btn',
      attrs: { type: 'button', title: '清空已完成', 'aria-label': '清空已完成' },
      html: icon('trash', 13),
      on: { click: () => clearFinished() },
    });
    const closeBtn = h('button', {
      class: 'icon-btn',
      attrs: { type: 'button', title: '关闭下载面板', 'aria-label': '关闭下载面板' },
      html: icon('x', 14),
      on: { click: () => close() },
    });
    panel = h('section', {
      class: 'downloads',
      attrs: { id: panelId, 'aria-label': '下载任务', hidden: 'hidden' },
    },
      h('header', { class: 'dl-head' },
        raw(icon('download', 14)),
        h('b', { text: '下载' }),
        summaryEl,
        h('span', { class: 'push' }),
        clearBtn,
        closeBtn,
      ),
      listEl,
    );
    document.body.appendChild(panel);
    if (!escapeBound) {
      escapeBound = true;
      document.addEventListener('keydown', onEscape, true);
    }
    return panel;
  }

  /** Escape closes the panel before the shell treats it as "clear selection". */
  function onEscape(event) {
    if (!panelOpen || event.key !== 'Escape') return;
    // A dialog, menu or drawer on top of the page owns Escape first.
    if (document.querySelector('.dialog, .menu, .drawer')) return;
    event.preventDefault();
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
    close();
  }

  function open() {
    if (!ensurePanel()) return;
    panelOpen = true;
    panel.removeAttribute('hidden');
    // The panel is appended to <body>, like a menu, so a dialog or drawer on top
    // traps Tab without it. Registering while it is open puts its 清空/关闭 and
    // the per-task cancel/retry into that existing cycle; close() releases it
    // again, so a closed panel never holds a tab stop nobody can see.
    if (!releasePopup) releasePopup = registerPopup(panel);
    paintPanel();
    paintEntry();
  }

  function close() {
    if (!panel) return;
    panelOpen = false;
    panel.setAttribute('hidden', 'hidden');
    if (releasePopup) releasePopup();
    releasePopup = null;
    paintEntry();
  }

  function toggle() {
    if (panelOpen) close();
    else open();
  }

  function reveal() {
    // In the app the topbar has already asked for the entry, so a new download
    // opens the panel like Firefox's shelf. In a DOM-less test nothing happens.
    if (entryState && !panelOpen) open();
  }

  function clearFinished() {
    let removed = false;
    for (let index = tasks.length - 1; index >= 0; index -= 1) {
      const task = tasks[index];
      if (task.settled && task.state !== 'failed') {
        rows.delete(task.id);
        tasks.splice(index, 1);
        removed = true;
      }
    }
    if (removed) {
      setDirty = true;
      publish(true);
    }
  }

  /**
   * Drop everything: used when the session ends.
   *
   * Task names are file names, so a signed-out page must not keep showing the
   * previous account's list. Active transfers are canceled first — they would
   * only fail against the new (absent) token anyway.
   */
  function reset() {
    for (const task of tasks) if (!task.settled) task.cancel();
    tasks.length = 0;
    rows.clear();
    setDirty = true;
    // Clearing tasks alone leaves the old .dl-item children (and their file
    // names) in the hidden panel DOM; the next session would inherit them if
    // the panel were reopened without a full rebuild.
    if (listEl) clearNode(listEl);
    if (summaryEl) summaryEl.textContent = '';
    close();
  }

  /**
   * The compact topbar control. A fresh element is returned on every shell
   * render; the center keeps one reference and repaints it in place.
   */
  function entry() {
    const button = h('button', {
      class: 'icon-btn dl-entry',
      attrs: { type: 'button', 'aria-controls': panelId },
      html: icon('download', 15),
      on: { click: () => toggle() },
    });
    const count = h('span', { class: 'dl-entry-count', attrs: { hidden: 'hidden' } });
    const barFill = h('i', { style: { transform: 'scaleX(0)' } });
    const bar = h('span', { class: 'dl-entry-bar', attrs: { hidden: 'hidden' } }, barFill);
    button.appendChild(count);
    button.appendChild(bar);
    entryState = { button, count, bar, barFill };
    // The panel is created once, hidden: aria-controls then points at a real
    // element from the first paint, and the first open has no build cost.
    ensurePanel();
    // No setDirty here: the shell re-renders the topbar on every local state
    // change, and rebuilding the open list each time would steal focus from the
    // retry button the user is standing on. Only a pruned task reorders rows.
    paintEntry();
    return button;
  }

  /**
   * Release this center completely: used by a page that owns a second center
   * (the public share route) and outlives it.
   *
   * Every task this center started is canceled through its own controller, so a
   * retry that lands afterwards can never be mistaken for the live one. The
   * panel leaves the document, its Escape listener is removed, a queued repaint
   * is cleared and the popup registration is released: nothing of this instance
   * keeps painting into a page it no longer belongs to.
   */
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const task of tasks) {
      if (!task.settled) task.cancel();
    }
    tasks.length = 0;
    rows.clear();
    cancelPaint();
    setDirty = true;
    entryState = null;
    panelOpen = false;
    if (releasePopup) {
      try { releasePopup(); } catch { /* registration is already gone */ }
      releasePopup = null;
    }
    if (escapeBound) {
      escapeBound = false;
      try { document.removeEventListener('keydown', onEscape, true); } catch { /* detached document */ }
    }
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    panel = null;
    listEl = null;
    summaryEl = null;
  }

  return {
    start,
    entry,
    open,
    close,
    toggle,
    clearFinished,
    reset,
    destroy,
    tasks,
    get openState() { return panelOpen; },
  };
}

/* One center for the page: every entry point (row menu, batch bar, preview,
   ZIP) shares the same list, so retrying one file never loses the others. */
let shared = null;
export function downloadCenter() {
  if (!shared) shared = createDownloadCenter();
  return shared;
}

/** The compact entry the global topbar mounts. */
export function downloadEntry() {
  return downloadCenter().entry();
}
