/*
 * queue.js — the upload queue panel: one row per task with live progress,
 * speed / ETA, cancel, pause and retry. Rendering is a keyed diff over task ids
 * so a progress event only touches the row it belongs to (no full re-render,
 * no flicker).
 *
 * The header owns the two global controls: 全部暂停 / 全部继续 and 清空已完成.
 * Rows whose source is a stored history record are marked read-only, because a
 * refreshed page cannot rebuild a File object.
 */

import { h, raw, mount } from './dom.js';
import { icon, bytes } from './format.js';
import { transferLabel, formatSpeed } from './upload.js';
import { aggregateTasks, summaryLabel, formatEta } from './upload-stats.js';

/* The two transport controls the queue owns; the shared icon set stays untouched. */
function glyph(body, size) {
  const s = size || 12;
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="' + s + '" height="' + s +
    '" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    body + '</svg>';
}
const PAUSE_GLYPH = '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>';
const PLAY_GLYPH = '<path d="m7 4 13 8-13 8z"/>';
const pauseIcon = (size) => glyph(PAUSE_GLYPH, size);
const playIcon = (size) => glyph(PLAY_GLYPH, size);

export function createQueuePanel(options) {
  const opts = options || {};
  const rows = new Map();
  const list = h('div', { class: 'queue-list' });
  const summary = h('span', { text: '0 个任务' });
  // The batch readout. A queue of 200 files cannot be read from 200 rows: the
  // header owns one bar for the whole batch and the numbers behind it.
  const totalBar = h('i', { style: { transform: 'scaleX(0)' } });
  const totalFill = h('div', {
    class: 'qbar qbar-total',
    attrs: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', 'aria-label': '上传总进度' },
  }, totalBar);
  const meta = h('span', { class: 'qmeta' });
  const totals = h('div', { class: 'queue-total', attrs: { hidden: 'hidden' } }, meta, totalFill);
  let paused = false;
  let totalsTimer = 0;
  let lastTotalsAt = 0;

  const pauseBtn = h('button', {
    class: 'icon-btn',
    attrs: { type: 'button', 'aria-label': '全部暂停', title: '全部暂停' },
    html: pauseIcon(13),
    on: { click: () => { if (opts.onTogglePause) opts.onTogglePause(!paused); } },
  });
  const clearBtn = h('button', {
    class: 'icon-btn',
    attrs: { type: 'button', 'aria-label': '清空已完成', title: '清空已完成' },
    html: icon('trash', 13),
    on: { click: () => { if (opts.onClearFinished) opts.onClearFinished(); } },
  });

  const panel = h('section', {
    class: 'queue',
    attrs: { 'aria-label': '上传队列', hidden: 'hidden' },
  },
    h('header', { class: 'queue-head' },
      raw(icon('upload', 14)),
      h('b', { text: '上传' }),
      summary,
      h('span', { class: 'push' }),
      pauseBtn,
      clearBtn,
      h('button', {
        class: 'icon-btn', attrs: { type: 'button', 'aria-label': '收起上传队列', title: '收起' },
        html: icon('chevron-down', 13),
        on: { click: () => hide() },
      }),
    ),
    totals,
    list,
  );
  document.body.appendChild(panel);

  let visible = false;
  function show() {
    if (visible) return;
    visible = true;
    panel.removeAttribute('hidden');
  }
  function hide() {
    if (!visible) return;
    visible = false;
    panel.setAttribute('hidden', 'hidden');
  }

  /**
   * Repaint the header: the batch one-liner plus one bar for the whole queue.
   *
   * Progress events arrive several times a second per task; three tasks in
   * flight would otherwise relayout this header thirty times a second. Totals
   * are throttled to ~4Hz and a settled state forces an immediate pass, so the
   * last number the user reads is always the true one.
   */
  function updateSummary(immediate) {
    const tasks = Array.from(rows.values());
    const active = tasks.filter((row) => !isSettled(row.task.state)).length;
    // History rows are past uploads re-shown from storage: they are not part of
    // this batch, and counting them would open the bar at 40% before a byte moves.
    const live = tasks.filter((row) => !row.history && !row.resumable);
    const resumable = tasks.filter((row) => row.resumable).length;
    const stats = aggregateTasks(live.map((row) => row.task));
    summary.textContent = paused && active
      ? '已暂停 · ' + active + ' 个待继续'
      : (paused ? '已暂停' : (stats.files ? summaryLabel(stats) : resumable ? resumable + ' 个可继续' : summaryLabel(stats)));
    pauseBtn.setAttribute('aria-label', paused ? '全部继续' : '全部暂停');
    pauseBtn.setAttribute('title', paused ? '全部继续' : '全部暂停');
    pauseBtn.innerHTML = paused ? playIcon(13) : pauseIcon(13);
    pauseBtn.classList.toggle('is-active', paused);
    if (!tasks.length) {
      hide();
      return;
    }
    if (!visible) show();
    paintTotals(stats, immediate === true);
  }

  /** The batch bar and its numbers. Cheap: one transform, one text node. */
  function paintTotals(stats, immediate) {
    const now = Date.now();
    if (!immediate && now - lastTotalsAt < 240) {
      if (!totalsTimer) {
        totalsTimer = setTimeout(() => { totalsTimer = 0; updateSummary(true); }, 260);
      }
      return;
    }
    lastTotalsAt = now;
    const ratio = Math.max(0, Math.min(1, Number(stats.ratio) || 0));
    const pct = Math.round(ratio * 100);
    totalBar.style.transform = 'scaleX(' + ratio.toFixed(3) + ')';
    totalFill.setAttribute('aria-valuenow', String(pct));
    // A single file already shows its own percentage on its row: a second copy
    // in the header is noise, so the batch readout only appears for a batch.
    const multi = stats.files > 1;
    if (multi) totals.removeAttribute('hidden');
    else totals.setAttribute('hidden', 'hidden');
    if (!multi) return;
    // The header already carries "已完成 1/8"; the meta line spends its width on
    // the numbers that are not up there — bytes, throughput, remaining time.
    const parts = [];
    parts.push(bytes(stats.doneBytes) + ' / ' + bytes(stats.totalBytes));
    if (stats.speed > 0) parts.push(formatSpeed(stats.speed));
    const eta = formatEta(stats.eta);
    if (eta) parts.push(eta);
    else if (stats.hashing > 0 && stats.hashing === stats.active) parts.push('校验中');
    if (stats.failed) parts.push(stats.failed + ' 个失败');
    meta.textContent = parts.join(' · ');
  }

  const STATE_LABEL = {
    queued: '等待中', hashing: '校验中', uploading: '上传中', finalizing: '收尾中',
    paused: '已暂停', done: '已完成', error: '失败', canceled: '已取消',
  };

  function ensureRow(task) {
    if (rows.has(task.id)) return rows.get(task.id);
    const name = h('span', { class: 'qname', attrs: { title: task.name }, text: task.name });
    const state = h('span', { class: 'qstate' });
    const bar = h('i', { style: { transform: 'scaleX(0)' } });
    const progress = h('div', { class: 'qbar', attrs: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', 'aria-label': '上传进度：' + task.name } }, bar);
    const retryBtn = h('button', {
      class: 'icon-btn', attrs: { type: 'button', 'aria-label': '重试 ' + task.name, title: '重试', hidden: 'hidden' },
      html: icon('refresh', 11),
      on: { click: () => { task.retry().catch(() => {}); } },
    });
    const pauseBtnRow = h('button', {
      class: 'icon-btn', attrs: { type: 'button', 'aria-label': '暂停 ' + task.name, title: '暂停', hidden: 'hidden' },
      html: pauseIcon(11),
      on: { click: () => { task.pause(); } },
    });
    const resumeBtnRow = h('button', {
      class: 'icon-btn', attrs: { type: 'button', 'aria-label': '继续 ' + task.name, title: '继续', hidden: 'hidden' },
      html: playIcon(11),
      on: { click: () => { task.resume().catch(() => {}); } },
    });
    const cancelBtn = h('button', {
      class: 'icon-btn', attrs: { type: 'button', 'aria-label': '取消 ' + task.name, title: '取消' },
      html: icon('x', 11),
      on: { click: () => task.cancel() },
    });
    const row = h('div', { class: 'qitem', dataset: { id: task.id } },
      name,
      state,
      progress,
      h('span', { class: 'qactions', style: { gridColumn: '1/-1', justifyContent: 'flex-end', marginTop: '2px' } },
        retryBtn, pauseBtnRow, resumeBtnRow, cancelBtn),
    );
    const entry = {
      task, row, state, bar, progress, retryBtn, pauseBtn: pauseBtnRow, resumeBtn: resumeBtnRow, cancelBtn,
      history: task.history === true,
    };
    rows.set(task.id, entry);
    list.appendChild(row);
    paint(entry);
    // A new row fades up; the queue is not re-created per progress event, so
    // this cannot replay. No stagger here — uploads finish out of order, so the
    // order a row joined tells the user nothing.
    row.classList.add('motion-rise');
    return entry;
  }

  function paint(entry) {
    const { task } = entry;
    const pct = Math.round((task.progress || 0) * 100);
    // scaleX, not width: a width transition relayouts the row on every progress
    // event, and there are several per second while a file is uploading.
    entry.bar.style.transform = 'scaleX(' + (pct / 100).toFixed(3) + ')';
    entry.progress.setAttribute('aria-valuenow', String(pct));
    entry.row.classList.toggle('is-error', task.state === 'error');
    entry.row.classList.toggle('is-done', task.state === 'done');
    entry.row.classList.toggle('is-paused', task.state === 'paused');
    entry.state.className = 'qstate' + (task.state === 'error' ? ' is-error' : task.state === 'done' ? ' is-done' : '');
    const show = (el, visible) => {
      if (visible) el.removeAttribute('hidden');
      else el.setAttribute('hidden', 'hidden');
    };
    if (task.state === 'done') {
      entry.state.textContent = (task.deduplicated ? '秒传 · ' : '') + bytes(task.size);
      show(entry.cancelBtn, false);
      show(entry.retryBtn, false);
      show(entry.pauseBtn, false);
      show(entry.resumeBtn, false);
    } else if (task.state === 'error') {
      entry.state.textContent = '失败';
      entry.state.setAttribute('title', task.error && task.error.message ? task.error.message : '');
      show(entry.cancelBtn, false);
      show(entry.retryBtn, !entry.history);
      show(entry.pauseBtn, false);
      show(entry.resumeBtn, false);
    } else if (task.state === 'canceled') {
      entry.state.textContent = '已取消';
      show(entry.cancelBtn, false);
      show(entry.retryBtn, !entry.history);
      show(entry.pauseBtn, false);
      show(entry.resumeBtn, false);
    } else if (task.state === 'paused') {
      entry.state.textContent = '已暂停' + (pct ? ' ' + pct + '%' : '');
      show(entry.cancelBtn, true);
      show(entry.retryBtn, false);
      show(entry.pauseBtn, false);
      show(entry.resumeBtn, true);
    } else {
      entry.state.textContent = (STATE_LABEL[task.state] || '') + ' · ' + transferLabel(task);
      show(entry.cancelBtn, true);
      show(entry.retryBtn, false);
      show(entry.pauseBtn, task.state === 'uploading' || task.state === 'hashing' || task.state === 'finalizing');
      show(entry.resumeBtn, false);
    }
  }

  /** Track a task that has not been started yet. */
  function track(task) {
    const entry = ensureRow(task);
    // The row is repainted per event; the header is throttled inside
    // updateSummary(), so a progress tick is cheap even with the whole batch open.
    task.on('progress', () => { paint(entry); updateSummary(); });
    task.on('state', () => { paint(entry); updateSummary(true); });
    task.on('done', () => {
      paint(entry);
      updateSummary(true);
      // Auto-collapse once everything finished, keeping the rows for retry.
      setTimeout(() => {
        const all = Array.from(rows.values());
        if (all.every((row) => isSettled(row.task.state))) updateSummary();
      }, 1200);
    });
    updateSummary();
    return entry;
  }

  /**
   * A row for an upload that a reload interrupted but that the server can still
   * finish: the chunks are on disk and the session has not expired.
   *
   * This is not a history row. History is a record of something that ended;
   * this is an unfinished task whose File object is missing. The row therefore
   * carries one verb — 继续 — and the caller decides how to rebuild the file
   * (a stored handle, or a picker that must produce matching bytes).
   */
  function trackResumable(item) {
    const session = item.session || {};
    const key = 'resume-' + (session.id || session.name);
    if (rows.has(key)) return rows.get(key);
    const name = h('span', { class: 'qname', attrs: { title: session.name || '' }, text: session.name || '未命名' });
    const state = h('span', { class: 'qstate' });
    const bar = h('i', { style: { transform: 'scaleX(0)' } });
    const progress = h('div', {
      class: 'qbar',
      attrs: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', 'aria-label': '可继续上传：' + (session.name || '') },
    }, bar);
    const resumeBtn = h('button', {
      class: 'icon-btn', attrs: { type: 'button', 'aria-label': '继续 ' + (session.name || ''), title: '继续' },
      html: playIcon(11),
      on: { click: () => { if (typeof item.onResume === 'function') item.onResume(); } },
    });
    const discardBtn = h('button', {
      class: 'icon-btn', attrs: { type: 'button', 'aria-label': '放弃 ' + (session.name || ''), title: '放弃' },
      html: icon('x', 11),
      on: { click: () => { if (typeof item.onDiscard === 'function') item.onDiscard(); } },
    });
    const row = h('div', { class: 'qitem is-resumable', dataset: { id: key } },
      name,
      state,
      progress,
      h('span', { class: 'qactions', style: { gridColumn: '1/-1', justifyContent: 'flex-end', marginTop: '2px' } },
        resumeBtn, discardBtn),
    );
    const ratio = Math.max(0, Math.min(1, item.ratio || 0));
    const pct = Math.round(ratio * 100);
    bar.style.transform = 'scaleX(' + ratio.toFixed(3) + ')';
    progress.setAttribute('aria-valuenow', String(pct));
    state.className = 'qstate is-resumable';
    state.textContent = item.label || (pct ? '可继续 · 已传 ' + pct + '%' : '可继续');
    // Not history: a history row is something that ended. This one is pending,
    // so it must keep the panel open and be counted in the header.
    const entry = { task: { id: key, name: session.name, size: session.size, state: 'resumable', progress: ratio, uploaded: 0, speed: 0 }, row, state, bar, progress, history: false, resumable: true };
    rows.set(key, entry);
    list.appendChild(row);
    row.classList.add('motion-rise');
    updateSummary();
    return entry;
  }

  /** Removes a resumable row after the user resumed or discarded it. */
  function dropResumable(sessionId) {
    const key = 'resume-' + sessionId;
    const entry = rows.get(key);
    if (!entry) return;
    entry.row.remove();
    rows.delete(key);
    updateSummary();
  }

  /**
   * Show stored uploads from a previous page as read-only history rows: they
   * carry a summary, not a File, so they can never be restarted.
   */
  function trackHistory(entries) {
    for (const record of entries || []) {
      if (!record || !record.name) continue;
      const id = 'history-' + (record.at || '') + '-' + record.name + '-' + (record.size || 0);
      if (rows.has(id)) continue;
      const task = {
        id,
        name: record.name,
        size: record.size || 0,
        state: record.state === 'done' ? 'done' : record.state === 'canceled' ? 'canceled' : 'error',
        progress: record.state === 'done' ? 1 : 0,
        uploaded: 0,
        speed: 0,
        deduplicated: record.deduplicated === true,
        error: null,
        history: true,
        on: () => () => {},
        retry: () => Promise.resolve(null),
        pause: () => false,
        resume: () => Promise.resolve(null),
        cancel: () => {},
      };
      ensureRow(task);
    }
    updateSummary();
  }

  return {
    panel,
    track,
    trackHistory,
    trackResumable,
    dropResumable,
    show,
    hide,
    rows,
    /** Header switches to 全部继续 and the summary says 已暂停. */
    setPaused(value) {
      paused = !!value;
      updateSummary();
    },
    /** Drop every settled row (done / canceled) and keep the rest. */
    clearFinished() {
      for (const [id, entry] of Array.from(rows.entries())) {
        if (!isSettled(entry.task.state)) continue;
        entry.row.remove();
        rows.delete(id);
      }
      updateSummary();
    },
    clear() {
      rows.clear();
      mount(list, []);
      updateSummary();
    },
  };
}

function isSettled(state) {
  return state === 'done' || state === 'canceled';
}
