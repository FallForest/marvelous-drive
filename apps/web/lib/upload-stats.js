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
 */

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
    if (state === 'error' || state === 'canceled') { failed += 1; doneBytes += uploaded; continue; }

    doneBytes += uploaded;
    if (state === 'uploading') { running += 1; speed += Math.max(0, Number(task.speed) || 0); }
    else if (state === 'hashing') { hashing += 1; unmeasured += Math.max(0, size - uploaded); }
    else if (state === 'paused') paused += 1;
    else queued += 1;
  }

  const active = files - finished - failed;
  const remaining = Math.max(0, totalBytes - doneBytes);
  const measurable = Math.max(0, remaining - unmeasured);
  const eta = speed > 0 && measurable > 0 ? Math.max(1, Math.ceil(measurable / speed)) : null;

  return {
    files, finished, failed, running, hashing, paused, queued, active,
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
 * what "active" means: a failed file is settled, not in flight.
 */
export function summaryLabel(stats) {
  const s = stats || aggregateTasks([]);
  if (!s.files) return '0 个任务';
  if (!s.active) {
    return s.failed ? s.finished + ' 个已完成 · ' + s.failed + ' 个失败' : s.files + ' 个已完成';
  }
  if (s.files === 1 && !s.failed) return '1 个进行中';
  const head = '已完成 ' + s.finished + '/' + s.files;
  return s.failed ? head + ' · ' + s.failed + ' 个失败' : head;
}
