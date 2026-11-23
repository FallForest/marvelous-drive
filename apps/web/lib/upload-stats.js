/*
 * upload-stats.js — the batch view over an upload queue.
 *
 * The panel already answers "how is this file doing". A user who drops a folder
 * asks a different question: how much of the whole batch is done, how fast, and
 * how long until the bar reaches the end. Those numbers cannot be read off a
 * single row, so they are aggregated here.
 *
 * Everything in this module is pure: no DOM, no timers, no HTTP. The arithmetic
 * is the part that is easy to get subtly wrong (bytes of a deduplicated file,
 * bytes of a failed file, bytes still being hashed), so it is tested directly.
 *
 * `taskRowStatus` is the per-row counterpart: one honest sentence about what a
 * task is doing right now, including the failure reason the panel used to keep
 * in a title attribute where a touch screen could never read it.
 */

import { bytes } from './format.js';
import { formatSpeed, etaSeconds } from './upload.js';

/**
 * One snapshot over every tracked task.
 *
 * doneBytes counts what is genuinely finished or already sent, so a failed file
 * contributes the bytes the server did receive: the batch bar must not jump
 * backwards when one file of a hundred errors out.
 *
 * eta deliberately excludes the files still being hashed. Their throughput is a
 * CPU number, not a network one, and folding it into the same average produces
 * an ETA that swings by minutes per update.
 */
export function aggregateTasks(tasks) {
  const list = Array.from(tasks || []).filter(Boolean);
  let files = 0;
  let finished = 0;
  let failed = 0;
  let canceled = 0;
  let running = 0;
  let hashing = 0;
  let paused = 0;
  let queued = 0;
  let totalBytes = 0;
  let doneBytes = 0;
  let unmeasured = 0;
  let speed = 0;

  for (const task of list) {
    files += 1;
    const size = Math.max(0, Number(task.size) || 0);
    const uploaded = Math.min(size, Math.max(0, Number(task.uploaded) || 0));
    totalBytes += size;

    const state = String(task.state || '');
    if (state === 'done') { finished += 1; doneBytes += size; continue; }
    if (state === 'error') { failed += 1; doneBytes += uploaded; continue; }
    if (state === 'canceled') { canceled += 1; doneBytes += uploaded; continue; }

    doneBytes += uploaded;
    if (state === 'uploading') { running += 1; speed += Math.max(0, Number(task.speed) || 0); }
    else if (state === 'hashing') { hashing += 1; unmeasured += Math.max(0, size - uploaded); }
    else if (state === 'paused') paused += 1;
    else queued += 1;
  }

  const active = files - finished - failed - canceled;
  const remaining = Math.max(0, totalBytes - doneBytes);
  const measurable = Math.max(0, remaining - unmeasured);
  const eta = speed > 0 && measurable > 0 ? Math.max(1, Math.ceil(measurable / speed)) : null;

  return {
    files, finished, failed, canceled, running, hashing, paused, queued, active,
    totalBytes, doneBytes, remaining, speed, eta,
    // A batch made only of zero-byte files is complete once it has settled.
    ratio: totalBytes > 0 ? doneBytes / totalBytes : (files > 0 && active === 0 ? 1 : 0),
  };
}

/** "剩余 1 分 20 秒" / "剩余 8s" — null when nothing is measurable yet. */
export function formatEta(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value < 60) return '剩余 ' + Math.round(value) + 's';
  const minutes = Math.floor(value / 60);
  const rest = Math.round(value % 60);
  if (minutes < 60) return '剩余 ' + minutes + ' 分' + (rest ? ' ' + rest + ' 秒' : '');
  const hours = Math.floor(minutes / 60);
  return '剩余 ' + hours + ' 小时 ' + (minutes % 60) + ' 分';
}

/**
 * The one-line header summary. It lives beside the aggregate so both agree on
 * what "active" means: a failed or canceled file is settled, not in flight.
 */
export function summaryLabel(stats) {
  const s = stats || aggregateTasks([]);
  if (!s.files) return '0 个任务';
  if (!s.active) {
    const parts = [];
    if (s.finished) parts.push(s.finished + ' 个已完成');
    if (s.failed) parts.push(s.failed + ' 个失败');
    if (s.canceled) parts.push(s.canceled + ' 个已取消');
    return parts.join(' · ') || s.files + ' 个已完成';
  }
  if (s.files === 1 && !s.failed && !s.canceled) return '1 个进行中';
  const head = '已完成 ' + s.finished + '/' + s.files;
  const parts = [head];
  if (s.failed) parts.push(s.failed + ' 个失败');
  if (s.canceled) parts.push(s.canceled + ' 个已取消');
  return parts.join(' · ');
}

/* ── one row's status line ─────────────────────────────────────── */

/** The state word a row leads with. */
const ROW_STATE_LABEL = Object.freeze({
  queued: '排队中',
  hashing: '校验中',
  uploading: '上传中',
  finalizing: '服务端收尾',
  paused: '已暂停',
  done: '成功',
  error: '失败',
  canceled: '已取消',
  resumable: '可继续',
});

const ROW_TONES = Object.freeze({
  done: 'success',
  error: 'danger',
  canceled: 'muted',
  paused: 'warning',
  resumable: 'warning',
});

/**
 * What one row should say, split into the state word and its detail line.
 *
 * Rules that took a bug to learn:
 *   - `finalizing` is not success. Every byte is on the server but the node
 *     does not exist yet, so writing "100%" (or worse, 上传成功) is a lie the
 *     user can act on too early;
 *   - the failure reason is returned as text, not as a title attribute: a
 *     320px touch screen has no hover;
 *   - an ETA only exists when speed is known, so 校验中 never borrows one.
 *
 * Returns { state, label, detail, tone }.
 */
export function taskRowStatus(task) {
  const t = task || {};
  const state = String(t.state || 'queued');
  const size = Math.max(0, Number(t.size) || 0);
  const uploaded = Math.min(size, Math.max(0, Number(t.uploaded) || 0));
  const label = ROW_STATE_LABEL[state] || '';
  const tone = ROW_TONES[state] || '';
  const sent = bytes(uploaded) + ' / ' + bytes(size);

  if (state === 'done') {
    return { state, label, tone, detail: t.deduplicated ? '秒传 · ' + bytes(size) : bytes(size) };
  }
  if (state === 'error') {
    const reason = t.error && t.error.message ? String(t.error.message) : '';
    return { state, label, tone, detail: reason || '可以重试' };
  }
  if (state === 'canceled') {
    return { state, label, tone, detail: uploaded > 0 ? '已传 ' + sent : '可以重试' };
  }
  if (state === 'paused') {
    return { state, label, tone, detail: (size ? '已传 ' + sent + ' · ' : '') + '可以继续' };
  }
  if (state === 'resumable') {
    const pct = Math.round(Math.max(0, Math.min(1, Number(t.progress) || 0)) * 100);
    return { state, label, tone, detail: pct ? '已传 ' + pct + '%' : '选择文件后可继续' };
  }
  if (state === 'finalizing') {
    // Bytes are complete; the server is committing the node. Deliberately not
    // "100%" and not "成功" — the drawer must not promise a file that is not there.
    return { state, label, tone, detail: sent };
  }
  if (state === 'uploading') {
    const speed = Math.max(0, Number(t.speed) || 0);
    const rest = Math.max(0, size - uploaded);
    const eta = etaSeconds(rest, speed);
    const parts = [sent];
    const rate = formatSpeed(speed);
    if (rate) parts.push(rate);
    if (eta !== null && eta > 0) parts.push(formatEta(eta));
    return { state, label, tone, detail: parts.join(' · ') };
  }
  if (state === 'hashing') {
    return { state, label, tone, detail: size ? sent : '' };
  }
  return { state, label, tone, detail: size ? sent : '' };
}
