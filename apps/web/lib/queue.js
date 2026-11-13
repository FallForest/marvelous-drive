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
import { transferLabel } from './upload.js';

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
  let paused = false;

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

  function updateSummary() {
    const tasks = Array.from(rows.values());
    const active = tasks.filter((row) => !isSettled(row.task.state)).length;
    summary.textContent = paused && active
      ? '已暂停 · ' + active + ' 个待继续'
      : active ? active + ' 个进行中' : tasks.length + ' 个已完成';
    pauseBtn.setAttribute('aria-label', paused ? '全部继续' : '全部暂停');
    pauseBtn.setAttribute('title', paused ? '全部继续' : '全部暂停');
    pauseBtn.innerHTML = paused ? playIcon(13) : pauseIcon(13);
    pauseBtn.classList.toggle('is-active', paused);
    if (!tasks.length) {
      hide();
      return;
    }
    if (!visible) show();
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
    task.on('progress', () => paint(entry));
    task.on('state', () => { paint(entry); updateSummary(); });
    task.on('done', () => {
      paint(entry);
      updateSummary();
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
