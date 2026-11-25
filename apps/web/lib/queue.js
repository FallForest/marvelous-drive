/*
 * queue.js — the upload queue panel: one row per task with live progress,
 * speed / ETA, cancel, pause and retry. Rendering is a keyed diff over task ids
 * so a progress event only touches the row it belongs to (no full re-render,
 * no flicker).
 *
 * Two rules shape the shell around those rows:
 *
 *   1. A folded panel is still an entrance. Collapsing is a user decision, so it
 *      swaps the panel for a small launcher that keeps the batch counts on
 *      screen. Progress events must never re-open the panel behind the user's
 *      back — that was the old behaviour and it made 收起 useless.
 *   2. A row is one readable sentence. The state word says 排队中 / 校验中 /
 *      上传中 / 服务端收尾 / 成功 / 失败 / 已取消 / 可继续, and the detail line
 *      carries bytes, speed, ETA or the actual failure reason as text (not only
 *      as a title attribute, which a 320px touch screen can never read).
 *
 * The header owns the two global controls: 全部暂停 / 全部继续 and 清空已完成.
 * Rows whose source is a stored history record are marked read-only, because a
 * refreshed page cannot rebuild a File object.
 */

import { h, raw, mount } from './dom.js';
import { icon, bytes } from './format.js';
import { aggregateTasks, summaryLabel, taskRowStatus, formatEta, hashStageProgress } from './upload-stats.js';
import { formatSpeed } from './upload.js';

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
  // Folder walks that have not enqueued a file yet. Kept apart from `rows` on
  // purpose: they are not tasks, so they must not reach the batch arithmetic.
  const preparations = new Map();
  let preparationSeq = 0;
  let destroyed = false;
  const panelId = 'queue-panel-' + Math.random().toString(36).slice(2, 8);
  const list = h('div', { class: 'queue-list' });
  const summary = h('span', { class: 'qsummary', text: '0 个任务' });
  // State changes are announced here; byte progress is not. The region lives
  // outside the panel so folding the panel cannot also mute it.
  const announcer = h('div', {
    class: 'visually-hidden queue-announce',
    attrs: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
  });
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
  let visible = false;
  /** Set only by the user's 收起. No progress event may clear it. */
  let collapsed = false;

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
  const collapseBtn = h('button', {
    class: 'icon-btn', attrs: { type: 'button', 'aria-label': '收起上传队列', title: '收起', 'aria-expanded': 'true', 'aria-controls': panelId },
    html: icon('chevron-down', 13),
    on: { click: () => fold() },
  });

  const panel = h('section', {
    class: 'queue',
    attrs: { id: panelId, 'aria-label': '上传队列', hidden: 'hidden' },
  },
    h('header', { class: 'queue-head' },
      raw(icon('upload', 14)),
      h('b', { text: '上传' }),
      summary,
      h('span', { class: 'push' }),
      pauseBtn,
      clearBtn,
      collapseBtn,
    ),
    totals,
    list,
  );

  /* The folded entrance: always in the DOM, only painted while folded. */
  const launcherLabel = h('span', { class: 'qlaunch-text', text: '上传' });
  const launcher = h('button', {
    class: 'queue-launcher',
    attrs: {
      type: 'button', hidden: 'hidden', 'aria-label': '展开上传队列',
      'aria-expanded': 'false', 'aria-controls': panelId,
    },
    on: { click: () => show() },
  }, raw(icon('upload', 13)), launcherLabel, raw(icon('chevron-up', 13)));

  document.body.appendChild(launcher);
  document.body.appendChild(panel);
  document.body.appendChild(announcer);

  function open() {
    if (visible) return;
    visible = true;
    panel.removeAttribute('hidden');
    launcher.setAttribute('hidden', 'hidden');
    launcher.setAttribute('aria-expanded', 'false');
    collapseBtn.setAttribute('aria-expanded', 'true');
  }

  function close() {
    if (!visible) return;
    visible = false;
    panel.setAttribute('hidden', 'hidden');
  }

  /** User-facing expand: clears the fold so future tasks keep the panel open. */
  function show() {
    collapsed = false;
    open();
  }

  /** User-facing fold: hide the panel, keep the launcher. */
  function fold() {
    collapsed = true;
    close();
    launcher.removeAttribute('hidden');
    launcher.setAttribute('aria-expanded', 'true');
    collapseBtn.setAttribute('aria-expanded', 'false');
    collapseBtn.focus?.({ preventScroll: true });
  }

  function hide() {
    close();
    launcher.setAttribute('hidden', 'hidden');
  }

  /** Who is still working: paused files are unfinished, settled ones are not. */
  function isSettled(state) {
    return state === 'done' || state === 'canceled';
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
    const base = paused && active
      ? '已暂停 · ' + active + ' 个待继续'
      : (paused ? '已暂停' : (stats.files ? summaryLabel(stats) : resumable ? resumable + ' 个可继续' : summaryLabel(stats)));
    // Folders still being walked are neither files nor bytes: they get their
    // own count so the header never pretends a transfer has started.
    const preparing = preparations.size;
    const preparingLabel = preparing
      ? (preparing === 1 ? '1 个文件夹准备中' : preparing + ' 个文件夹准备中')
      : '';
    const label = preparingLabel
      ? (stats.files || resumable || paused ? base + ' · ' + preparingLabel : preparingLabel)
      : base;
    summary.textContent = label;
    launcherLabel.textContent = label;
    pauseBtn.setAttribute('aria-label', paused ? '全部继续' : '全部暂停');
    pauseBtn.setAttribute('title', paused ? '全部继续' : '全部暂停');
    pauseBtn.innerHTML = paused ? playIcon(13) : pauseIcon(13);
    pauseBtn.classList.toggle('is-active', paused);
    if (!tasks.length && !preparing) {
      hide();
      // The fold belonged to the batch that just went away; a brand new drop
      // must announce itself like the first one did.
      collapsed = false;
      return;
    }
    // The fold is the user's: a progress tick reaches this line and stops.
    if (collapsed) {
      close();
      launcher.removeAttribute('hidden');
      launcher.setAttribute('aria-expanded', 'true');
    } else {
      open();
    }
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
    if (stats.canceled) parts.push(stats.canceled + ' 个已取消');
    meta.textContent = parts.join(' · ');
  }

  function ensureRow(task) {
    if (rows.has(task.id)) return rows.get(task.id);
    const name = h('span', { class: 'qname', attrs: { title: task.name } });
    name.textContent = String(task.name || '');
    const stateWord = h('span', { class: 'qstate' });
    const detail = h('span', { class: 'qdetail' });
    // One flex line that may wrap: at 320px the state word and the reason stack
    // instead of overflowing the panel sideways.
    const line = h('span', { class: 'qline' }, stateWord, detail);
    const main = h('div', { class: 'qmain' }, name, line);
    const bar = h('i', { style: { transform: 'scaleX(0)' } });
    const progress = h('div', { class: 'qbar', attrs: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', 'aria-label': '上传进度：' + task.name } }, bar);
    // Hashing has no honest percentage until the transport reports real bytes:
    // the native indeterminate <progress> is the busy answer, and it borrows the
    // preparation row's .qbar-prep-busy style instead of growing a second one.
    // While the network moves it stays hidden and the row keeps its transfer bar.
    const hashBusy = h('progress', {
      class: 'qbar-prep-busy',
      attrs: { max: '1', hidden: 'hidden', 'aria-label': '校验进度：' + task.name },
    });
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
    const actions = h('span', { class: 'qactions' }, retryBtn, pauseBtnRow, resumeBtnRow, cancelBtn);
    const row = h('div', { class: 'qitem', dataset: { id: task.id } }, main, actions, progress, hashBusy);
    const entry = {
      task, row, state: stateWord, detail, bar, progress, hashBusy, actions,
      retryBtn, pauseBtn: pauseBtnRow, resumeBtn: resumeBtnRow, cancelBtn,
      history: task.history === true,
      resumable: task.state === 'resumable',
      announcedState: '',
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
    // Hashing and transferring are two different meters over the same 4px slot.
    // `task.progress` / `task.uploaded` are network bytes and are never borrowed
    // for the hashing stage; `task.hashBytes` is the transport's real read count
    // and stays null until it reports one.
    const stage = hashStageProgress(task);
    if (stage && stage.known) {
      // Honest percentage: floor, and 100% only once every byte was really read.
      // aria-valuenow alone carries it — the row's label already says 校验进度,
      // so an aria-valuetext copy would only be read out twice.
      entry.bar.style.transform = 'scaleX(' + stage.ratio.toFixed(3) + ')';
      entry.progress.setAttribute('aria-valuenow', String(stage.pct));
      entry.progress.removeAttribute('aria-valuetext');
      entry.progress.setAttribute('aria-label', '校验进度：' + task.name);
      entry.progress.removeAttribute('hidden');
      entry.hashBusy.setAttribute('hidden', 'hidden');
    } else if (stage) {
      // Unknown read count (no report yet, a zero-byte file, an older transport):
      // an indeterminate native <progress> — no aria-valuenow at all — instead of
      // an invented 0%. Same element and style the preparation row uses.
      entry.progress.setAttribute('hidden', 'hidden');
      entry.hashBusy.removeAttribute('hidden');
    } else {
      const pct = Math.round((task.progress || 0) * 100);
      // scaleX, not width: a width transition relayouts the row on every progress
      // event, and there are several per second while a file is uploading.
      entry.bar.style.transform = 'scaleX(' + (pct / 100).toFixed(3) + ')';
      entry.progress.removeAttribute('aria-valuetext');
      entry.progress.setAttribute('aria-label', '上传进度：' + task.name);
      entry.progress.setAttribute('aria-valuenow', String(pct));
      entry.progress.removeAttribute('hidden');
      entry.hashBusy.setAttribute('hidden', 'hidden');
    }
    const status = taskRowStatus(task);
    entry.row.classList.toggle('is-error', task.state === 'error');
    entry.row.classList.toggle('is-done', task.state === 'done');
    entry.row.classList.toggle('is-canceled', task.state === 'canceled');
    entry.row.classList.toggle('is-paused', task.state === 'paused');
    entry.row.classList.toggle('is-finalizing', task.state === 'finalizing');
    entry.state.className = 'qstate' + (status.tone ? ' is-' + status.tone : '');
    entry.state.textContent = status.label;
    entry.detail.className = 'qdetail' + (status.tone ? ' is-' + status.tone : '');
    entry.detail.textContent = detailFor(entry, status);
    const show = (el, on) => {
      if (on) el.removeAttribute('hidden');
      else el.setAttribute('hidden', 'hidden');
    };
    const live = !entry.history && !entry.resumable;
    const state = task.state;
    const canRetry = live && (state === 'error' || state === 'canceled');
    const canResume = live && state === 'paused';
    const canPause = live && (state === 'uploading' || state === 'hashing' || state === 'finalizing' || state === 'queued');
    const canCancel = live && state !== 'done' && state !== 'error' && state !== 'canceled' && state !== 'paused';
    show(entry.retryBtn, canRetry);
    show(entry.resumeBtn, canResume);
    show(entry.pauseBtn, canPause);
    show(entry.cancelBtn, canCancel);
    entry.actions.hidden = !(canRetry || canResume || canPause || canCancel);
    announce(entry, status);
  }

  /** A history row cannot retry, so its detail must not promise that it can. */
  function detailFor(entry, status) {
    if (!entry.history) return status.detail;
    if (status.state === 'error') return '上次未完成';
    if (status.state === 'canceled') return '上次已取消';
    return status.detail;
  }

  /**
   * One announcement per state change, none per byte.
   *
   * The live region is quiet for progress on purpose: a screen reader reading
   * "42%" forty times turns the queue into noise, and the row's own progressbar
   * is available on demand. Only the transitions a user acts on are spoken.
   */
  function announce(entry, status) {
    if (entry.announcedState === status.state) return;
    const first = !entry.announcedState;
    entry.announcedState = status.state;
    if (first) return; // the row's arrival is not a change worth speaking
    if (status.state === 'uploading' || status.state === 'hashing') {
      announcer.textContent = String(entry.task.name || '') + '：' + status.label;
      return;
    }
    const detail = detailFor(entry, status);
    announcer.textContent = String(entry.task.name || '') + '：' + status.label + (detail ? '，' + detail : '');
  }

  /** Track a task that has not been started yet. */
  function track(task) {
    const entry = ensureRow(task);
    // The row is repainted per event; the header is throttled inside
    // updateSummary(), so a progress tick is cheap even with the whole batch open.
    task.on('progress', () => { paint(entry); updateSummary(); });
    // Hashing has its own meter, so it has its own event: `hash-progress` carries
    // { task, phase, hashBytes, hashTotal } and repaints only the row. paint()
    // reads `task.hashBytes` off the task; the aggregate header keeps reading
    // network bytes only, so hashing must not repaint the transfer summary.
    task.on('hash-progress', () => paint(entry));
    task.on('state', () => { paint(entry); updateSummary(true); });
    task.on('done', () => {
      paint(entry);
      updateSummary(true);
      // Auto-settle the header once everything finished. It repaints the counts
      // but never re-opens a folded panel (updateSummary honours the fold).
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
    const state = h('span', { class: 'qstate is-warning' });
    const detail = h('span', { class: 'qdetail' });
    const line = h('span', { class: 'qline' }, state, detail);
    const main = h('div', { class: 'qmain' }, name, line);
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
    const actions = h('span', { class: 'qactions' }, resumeBtn, discardBtn);
    const row = h('div', { class: 'qitem is-resumable', dataset: { id: key } }, main, actions, progress);
    const ratio = Math.max(0, Math.min(1, item.ratio || 0));
    const pct = Math.round(ratio * 100);
    bar.style.transform = 'scaleX(' + ratio.toFixed(3) + ')';
    progress.setAttribute('aria-valuenow', String(pct));
    state.textContent = '可继续';
    const label = item.label && String(item.label).replace(/^可继续\s*·?\s*/, '');
    detail.textContent = label || (pct ? '已传 ' + pct + '%' : '选择文件后可继续');
    // Not history: a history row is something that ended. This one is pending,
    // so it must keep the panel open and be counted in the header.
    const entry = {
      task: { id: key, name: session.name, size: session.size, state: 'resumable', progress: ratio, uploaded: 0, speed: 0 },
      row, state, detail, bar, progress, actions,
      retryBtn: null, pauseBtn: null, resumeBtn, cancelBtn: discardBtn,
      history: false, resumable: true, announcedState: 'resumable',
    };
    rows.set(key, entry);
    list.appendChild(row);
    row.classList.add('motion-rise');
    updateSummary();
    return entry;
  }

  /**
   * A folder is being walked before any of its files has a task.
   *
   * Listing directories, hashing and the conflict question can easily outlive
   * the one toast that used to announce them, which left the panel looking idle
   * while the browser was busy. This row is the visible answer: one line per
   * folder, named after it, saying what is still being checked.
   *
   * Preparation rows are kept in their own map, not in `rows`: they are not
   * tasks. They carry no bytes, so nothing here can reach the batch arithmetic
   * in updateSummary() — a folder walk is a stage, not a transfer.
   *
   * The third argument opts into cancelling the walk: `{ onCancel }`. With no
   * callback the row has no cancel control at all (the old shape); with one it
   * grows a 取消准备 button that disables itself on the first click, so a
   * double-tap cannot fire the caller's abort twice.
   *
   * `update({ count, detail, progress })` may report progress as 0..1, or as
   * null for "still working, no honest percentage" (then the row shows an
   * indeterminate native <progress>). Reporting no progress at all keeps the
   * row exactly as it was: one sentence, no bar. Returns a handle whose
   * `end()` is idempotent, so a caller can end it both at first enqueue and
   * from a `finally`.
   */
  function beginPreparation(name, count, options) {
    const opt = options || {};
    const onCancel = typeof opt.onCancel === 'function' ? opt.onCancel : null;
    if (destroyed) {
      return {
        name: String(name || ''),
        update() {},
        end() {},
        cancel() { return false; },
        get canceled() { return false; },
      };
    }
    const key = 'prepare-' + (++preparationSeq);
    const label = String(name || '文件夹');
    const state = h('span', { class: 'qstate' });
    const detail = h('span', { class: 'qdetail' });
    const line = h('span', { class: 'qline' }, state, detail);
    const title = h('span', { class: 'qname', attrs: { title: label } });
    title.textContent = label;
    const main = h('div', { class: 'qmain' }, title, line);
    // The determinate bar reuses the row bar (.qbar + <i>) so it looks like the
    // transfer bars, but it is not one: it carries its own aria-label and its
    // value comes from the folder walk, never from uploaded bytes.
    const barFill = h('i', { style: { transform: 'scaleX(0)' } });
    const bar = h('div', {
      class: 'qbar qbar-prep',
      attrs: {
        role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0',
        'aria-label': '准备进度：' + label, hidden: 'hidden',
      },
    }, barFill);
    // Unknown phase: a native indeterminate <progress> — no value attribute at
    // all — so assistive tech reports busy instead of an invented percentage.
    // max="1" keeps it a 0..1 meter the moment a caller does have a number.
    const busy = h('progress', {
      class: 'qbar-prep-busy',
      attrs: { max: '1', hidden: 'hidden', 'aria-label': '准备中：' + label },
    });
    let cancelBtn = null;
    let actions = null;
    const entry = {
      name: label,
      count: Math.max(0, Math.floor(Number(count) || 0)),
      detail: '',
      // undefined: nobody reports progress. null: reported as unknown. number:
      // a real 0..1 stage ratio.
      progress: undefined,
      row: null,
      state,
      detailEl: detail,
      bar,
      barFill,
      busy,
      ended: false,
      canceled: false,
    };

    /** Swap between the determinate bar, the indeterminate one and neither. */
    function paintPreparationProgress() {
      const value = entry.progress;
      if (typeof value === 'number' && Number.isFinite(value)) {
        const ratio = Math.max(0, Math.min(1, value));
        const pct = Math.round(ratio * 100);
        entry.barFill.style.transform = 'scaleX(' + ratio.toFixed(3) + ')';
        entry.bar.setAttribute('aria-valuenow', String(pct));
        entry.bar.setAttribute('aria-valuetext', pct + '%');
        entry.bar.removeAttribute('hidden');
        entry.busy.setAttribute('hidden', 'hidden');
        return;
      }
      entry.bar.setAttribute('hidden', 'hidden');
      if (value === null) entry.busy.removeAttribute('hidden');
      else entry.busy.setAttribute('hidden', 'hidden');
    }

    const paintPreparation = () => {
      if (entry.ended) return;
      entry.state.textContent = entry.canceled ? '正在取消准备' : '正在准备';
      const fallback = entry.canceled
        ? '正在停止检查目录和文件变更'
        : '正在检查目录和文件变更';
      entry.detailEl.textContent = entry.detail
        || (fallback + (entry.count ? ' · 已知 ' + entry.count + ' 个文件' : ''));
      paintPreparationProgress();
    };

    /**
     * One request per row: the button is disabled on the first click and the
     * flag survives it, so neither a double-tap nor a programmatic call can
     * abort the same walk twice.
     */
    function requestCancel() {
      if (entry.ended || entry.canceled || !onCancel) return false;
      entry.canceled = true;
      if (cancelBtn) {
        cancelBtn.setAttribute('disabled', '');
        cancelBtn.setAttribute('aria-disabled', 'true');
        cancelBtn.classList.add('is-busy');
      }
      paintPreparation();
      // A cancel request is the only thing a preparation row ever speaks; the
      // count and the progress ticks stay out of the live region.
      announcer.textContent = label + '：已请求取消准备';
      try {
        const result = onCancel({ name: entry.name, count: entry.count });
        // A caller that aborts asynchronously must not leave a rejection behind.
        if (result && typeof result.then === 'function') result.catch(() => {});
      } catch {
        // The request stands (the control stays disabled); ending the row is
        // still the caller's `end()`, not this click handler.
      }
      return true;
    }

    if (onCancel) {
      cancelBtn = h('button', {
        class: 'icon-btn',
        attrs: { type: 'button', 'aria-label': '取消准备 ' + label, title: '取消准备' },
        html: icon('x', 11),
        on: { click: () => { requestCancel(); } },
      });
      actions = h('span', { class: 'qactions' }, cancelBtn);
    }

    const row = h('div', { class: 'qitem is-preparing', dataset: { id: key } }, main, actions, bar, busy);
    entry.row = row;
    preparations.set(key, entry);
    list.appendChild(row);
    row.classList.add('motion-rise');
    paintPreparation();
    announcer.textContent = label + '：正在检查目录和文件变更';
    updateSummary(true);

    return {
      name: entry.name,
      get count() { return entry.count; },
      get canceled() { return entry.canceled; },
      /**
       * count/detail change while the walk moves on; `progress` is a 0..1 stage
       * ratio or null for "unknown". Deliberately no updateSummary(): a
       * preparing row has no bytes, and the header repaint is also the one code
       * path that could re-open a folded panel behind the user's back.
       */
      update(patch) {
        if (entry.ended) return;
        const next = patch || {};
        if (next.count !== undefined) entry.count = Math.max(0, Math.floor(Number(next.count) || 0));
        if (next.detail !== undefined) entry.detail = String(next.detail || '');
        if ('progress' in next) {
          const ratio = next.progress === null || next.progress === undefined ? null : Number(next.progress);
          entry.progress = Number.isFinite(ratio) ? ratio : null;
        }
        paintPreparation();
      },
      cancel: requestCancel,
      end() {
        if (entry.ended) return;
        // From here on update() and cancel() are no-ops: a late tick from a
        // stopped walk must not repaint a row that is already gone.
        entry.ended = true;
        preparations.delete(key);
        row.remove();
        updateSummary(true);
      },
    };
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

  function destroy() {
    if (totalsTimer) clearTimeout(totalsTimer);
    totalsTimer = 0;
    destroyed = true;
    // A folder walk may still be in flight after the panel is gone; its handle
    // must keep working (and stay a no-op) instead of resurrecting a row.
    for (const entry of preparations.values()) {
      entry.ended = true;
      entry.row.remove();
    }
    preparations.clear();
    rows.clear();
    mount(list, []);
    panel.remove();
    launcher.remove();
    announcer.remove();
    visible = false;
  }

  return {
    panel,
    launcher,
    track,
    trackHistory,
    trackResumable,
    dropResumable,
    beginPreparation,
    show,
    hide,
    fold,
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
      for (const entry of preparations.values()) {
        entry.ended = true;
        entry.row.remove();
      }
      preparations.clear();
      rows.clear();
      mount(list, []);
      updateSummary();
    },
    destroy,
  };
}
