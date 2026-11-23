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
 *   - a task that reports exactly what it knows: packaging (total unknown),
 *     transferring (real response bytes, percent only with a trusted length),
 *     handed to the browser, canceled or failed with a readable reason.
 *
 * The transport stays in api.js. A task only describes "prepare (optional) →
 * fetch → save", so the ZIP flow can refuse to delete its carrier until the
 * save really happened, and a retry can reuse a carrier that already exists.
 *
 * Rendering is deliberately plain: the panel is built once, rows are keyed by
 * task id and updated in place. Progress repaints are throttled, because a
 * fast LAN can deliver hundreds of chunks per second.
 */

import { h, raw } from './dom.js';
import { icon, bytes } from './format.js';
import { fetchBlob, saveBlob, contentUrl } from './api.js';
import { registerPopup } from './focus.js';
import { formatSpeed } from './upload.js';

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
  starting: '准备下载',
  transferring: '正在传输',
  saving: '正在交给浏览器保存',
  done: '已交给浏览器保存',
  failed: '下载失败',
  canceled: '已取消',
});

/**
 * The one honest sentence about a task, plus the bar ratio it implies.
 *
 * `percent` is null whenever the response did not give a trustworthy total:
 * packaging, a chunked/compressed response, or an unknown-length stream. The UI
 * then shows an indeterminate bar and the bytes received, never a guessed 0%
 * that would sit at "almost done" for a whole minute.
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

  if (state === 'packaging') return { label, detail: '总量未知 · 打包完成后开始下载', percent: null };
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
  if (state === 'done') return { label, detail: bytes(received) || '已完成', percent: 1 };
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
 */
export function createDownloadCenter(options) {
  const opts = options || {};
  const deps = {
    fetchBlob: opts.fetchBlob || fetchBlob,
    saveBlob: opts.saveBlob || saveBlob,
    contentUrl: opts.contentUrl || contentUrl,
    now: opts.now || (() => Date.now()),
    setTimeout: opts.setTimeout || ((fn, ms) => setTimeout(fn, ms)),
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
  /** Release for focus.js while the panel is open; null while it is closed. */
  let releasePopup = null;

  /* ── task lifecycle ───────────────────────────────────────────── */

  function start(spec) {
    const task = {
      id: 'dl-' + deps.now().toString(36) + '-' + (++counter),
      name: String(spec.name || '下载'),
      kind: spec.kind === 'archive' ? 'archive' : 'file',
      state: spec.prepare ? 'packaging' : 'starting',
      phase: spec.prepare ? 'packaging' : 'transfer',
      received: 0,
      total: null,
      speed: 0,
      error: null,
      message: '',
      carrier: null,
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
      if (signal.aborted) return;
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

    try {
      if (spec.prepare && !task.carrier) {
        task.state = 'packaging';
        task.phase = 'packaging';
        task.total = null;
        publish(true);
        const carrier = await spec.prepare({ signal });
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
      task.state = 'starting';
      publish(true);

      const target = task.carrier || spec.node;
      if (!target || !target.id) throw new Error('找不到要下载的文件。');
      const blob = await deps.fetchBlob(deps.contentUrl(target.id, { download: true }), {
        signal,
        onProgress: progress,
      });
      if (signal.aborted) throw abortError();

      task.phase = 'deliver';
      task.state = 'saving';
      if (blob && Number.isFinite(blob.size)) task.received = Math.max(task.received, blob.size);
      publish(true);
      await deps.saveBlob(blob, target.name || spec.filename || task.name);

      task.state = 'done';
      if (blob && Number.isFinite(blob.size)) task.total = blob.size;
      task.received = task.total !== null ? task.total : task.received;
      task.speed = 0;
      task.settled = true;
      publish(true);
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
    return '已全部交给浏览器保存';
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
      && (task.state === 'packaging' || task.state === 'starting' || task.state === 'transferring' || task.state === 'saving');
    row.bar.classList.toggle('is-indeterminate', indeterminate);
    row.bar.setAttribute('aria-valuetext', status.label + ' ' + status.detail);
    if (percent === null) row.bar.removeAttribute('aria-valuenow');
    else row.bar.setAttribute('aria-valuenow', String(Math.round(percent * 100)));
    if (!indeterminate) row.barFill.style.transform = 'scaleX(' + (percent === null ? 0 : percent).toFixed(3) + ')';
  }

  /* ── panel + entry chrome ─────────────────────────────────────── */

  function ensurePanel() {
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
      attrs: { id: 'downloads-panel', 'aria-label': '下载任务', hidden: 'hidden' },
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
    if (!panel) ensurePanel();
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
      attrs: { type: 'button', 'aria-controls': 'downloads-panel' },
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

  return {
    start,
    entry,
    open,
    close,
    toggle,
    clearFinished,
    reset,
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
