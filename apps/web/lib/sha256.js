/* SHA-256 for HTTP deployments without WebCrypto. Reads at most 4 MiB at a
 * time, also keeping large files out of crypto.subtle's whole-file buffer. */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotate = (x, n) => (x >>> n) | (x << (32 - n));
const aborted = (signal) => !!(signal && signal.aborted);

function abortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * Incremental SHA-256 over a blob, with optional cancellation and progress.
 *
 * onProgress(loadedBytes) receives the cumulative number of bytes hashed so far,
 * once per 4 MiB slice, and finally exactly blob.size.
 */
export async function sha256Stream(source, { signal, onProgress } = {}) {
  const blob = source instanceof Blob ? source : new Blob([source]);
  const report = typeof onProgress === 'function' ? onProgress : null;
  if (aborted(signal)) throw abortError();
  const state = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const words = new Uint32Array(64);
  function block(bytes, offset) {
    for (let i = 0; i < 16; i += 1) {
      const j = offset + i * 4;
      words[i] = (bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3];
    }
    for (let i = 16; i < 64; i += 1) {
      const x = words[i - 15], y = words[i - 2];
      words[i] = words[i - 16] + (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3)) + words[i - 7] + (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10));
    }
    // Explicit registers: destructuring the Uint32Array here would allocate and
    // run an array iterator once per 64-byte block, which is the hot path of a
    // multi-hundred-megabyte read.
    let a = state[0], b = state[1], c = state[2], d = state[3];
    let e = state[4], f = state[5], g = state[6], h = state[7];
    for (let i = 0; i < 64; i += 1) {
      const t1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + words[i]) | 0;
      const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    state[0] += a; state[1] += b; state[2] += c; state[3] += d;
    state[4] += e; state[5] += f; state[6] += g; state[7] += h;
  }
  const chunkSize = 4 * 1024 * 1024; // multiple of a SHA-256 block
  const fullSize = blob.size - (blob.size % 64);
  let reported = -1;
  for (let start = 0; start < fullSize; start += chunkSize) {
    if (aborted(signal)) throw abortError();
    const end = Math.min(start + chunkSize, fullSize);
    const bytes = new Uint8Array(await blob.slice(start, end).arrayBuffer());
    for (let offset = 0; offset < bytes.length; offset += 64) block(bytes, offset);
    reported = end;
    if (report) report(reported);
    if (aborted(signal)) throw abortError();
    // Let input, progress painting and cancellation run between CPU batches.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (aborted(signal)) throw abortError();
  const tail = new Uint8Array((blob.size % 64) < 56 ? 64 : 128);
  tail.set(new Uint8Array(await blob.slice(fullSize).arrayBuffer()));
  tail[blob.size % 64] = 0x80;
  const view = new DataView(tail.buffer);
  view.setUint32(tail.length - 8, Math.floor(blob.size / 0x20000000), false);
  view.setUint32(tail.length - 4, (blob.size * 8) >>> 0, false);
  for (let offset = 0; offset < tail.length; offset += 64) block(tail, offset);
  if (aborted(signal)) throw abortError();
  // Every byte is hashed now; report the exact size once, without repeating
  // the last slice's value when blob.size is itself a multiple of 4 MiB.
  if (report && reported !== blob.size) report(blob.size);
  return Array.from(state, (value) => value.toString(16).padStart(8, '0')).join('');
}

/*
 * Background hashing: one dedicated module worker per page, shared by every
 * file and every task. The Blob is structured-cloned into the worker (no bytes
 * are copied through postMessage) and each request has its own id, so a
 * canceled or failed hash can never deliver a stale digest or byte count to
 * another upload.
 *
 * The two failure shapes are deliberate:
 *   - the worker cannot start (no Worker, CSP, a module that never loads) —
 *     fall back to the bounded main-thread stream for this file, disable the
 *     worker for the rest of the page, and never restart it per file;
 *   - a hash fails after the worker has answered — settle that request's
 *     promise and let the caller decide; never silently re-read the file.
 */
/** A worker that never says anything is treated as blocked, not as "slow". */
const WORKER_START_TIMEOUT = 8000;
let sharedWorker = null;
let workerDisabled = false;
let requestSeq = 0;

function workerUnavailableError(reason) {
  const error = new Error(reason || 'worker unavailable');
  error.name = 'WorkerError';
  error.workerUnavailable = true;
  return error;
}

function releaseWorker(state) {
  if (sharedWorker === state) sharedWorker = null;
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  state.worker.onmessage = null;
  state.worker.onmessageerror = null;
  state.worker.onerror = null;
  try { state.worker.terminate(); } catch { /* already gone */ }
}

/** Settles every request this worker still owns; the worker is not reused. */
function failWorker(state, reason) {
  releaseWorker(state);
  // A worker that never answered failed to start at all (no worker-src, a
  // broken module, a script that cannot load). Staying on the main thread from
  // here on is the honest answer: retrying it per file would be a loop of
  // failed starts, and telling the user a hash failed would be a lie.
  if (!state.responded) workerDisabled = true;
  const jobs = Array.from(state.jobs.values());
  state.jobs.clear();
  for (const job of jobs) {
    if (job.removeAbort) job.removeAbort();
    const error = workerUnavailableError(reason);
    // A worker that has answered before is not "unavailable": its failure is a
    // real error for this request, and a retry is the caller's decision.
    error.workerUnavailable = !state.responded;
    job.reject(error);
  }
}

function receive(state, data) {
  if (!data) return;
  // The worker's explicit handshake carries no request id: installing
  // self.onmessage is what it reports, so a slow first 4 MiB read can no longer
  // be mistaken for a worker that never started. Any other id-less message is
  // not ours to act on.
  if (data.id === undefined) {
    if (data.type !== 'ready') return;
    state.responded = true;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    return;
  }
  state.responded = true;
  // The first message proves the module loaded; the watchdog is no longer
  // needed and must not terminate a worker that is busy hashing.
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  const job = state.jobs.get(data.id);
  // A canceled, settled or superseded request: drop the message on the floor.
  // Ids are never reused, so this cannot belong to another task.
  if (!job) return;
  if (data.type === 'progress') {
    const loaded = Math.min(Math.max(0, Number(data.loaded) || 0), job.size);
    if (loaded <= job.loaded) return;
    job.loaded = loaded;
    try { if (job.onProgress) job.onProgress(loaded); } catch { /* listener's problem */ }
    return;
  }
  state.jobs.delete(data.id);
  if (job.removeAbort) job.removeAbort();
  if (data.type === 'done') {
    job.resolve(String(data.hash || ''));
    return;
  }
  const error = new Error(String(data.message || 'worker hash failed'));
  error.name = 'WorkerError';
  error.workerUnavailable = false;
  job.reject(error);
}

function createWorker(startTimeout) {
  if (workerDisabled) return null;
  if (sharedWorker) return sharedWorker;
  if (typeof Worker !== 'function') {
    workerDisabled = true;
    return null;
  }
  let worker;
  try {
    // Module worker, lazily created on the first large file. A browser that
    // blocks workers throws here or fails the script load and reports `error`.
    worker = new Worker(new URL('./sha256-worker.js', import.meta.url), { type: 'module' });
  } catch {
    workerDisabled = true;
    return null;
  }
  const state = { worker, jobs: new Map(), responded: false, timer: null };
  worker.onmessage = (event) => receive(state, event && event.data);
  worker.onmessageerror = () => failWorker(state, 'worker could not read a message');
  worker.onerror = () => failWorker(state, 'worker stopped');
  // A blocked worker-src does not always throw or fire `error`: some policies
  // produce a worker that simply never runs. Without a watchdog the first large
  // file would wait forever, so the start-up is bounded and then given up on.
  state.timer = setTimeout(() => failWorker(state, 'worker did not start'),
    Number(startTimeout) > 0 ? Number(startTimeout) : WORKER_START_TIMEOUT);
  sharedWorker = state;
  return state;
}

function cancelInWorker(state, id) {
  try { state.worker.postMessage({ type: 'cancel', id }); } catch { /* worker is gone */ }
}

function hashInWorker(blob, { signal, onProgress, startTimeout } = {}) {
  if (signal && signal.aborted) return Promise.reject(abortError());
  const state = createWorker(startTimeout);
  if (!state) return Promise.reject(workerUnavailableError('no background worker'));
  return new Promise((resolve, reject) => {
    const id = 'sha256-' + (requestSeq += 1).toString(36);
    const job = {
      size: blob.size,
      loaded: 0,
      onProgress,
      resolve,
      reject,
      removeAbort: null,
    };
    state.jobs.set(id, job);
    const withdraw = () => {
      if (!state.jobs.delete(id)) return false;
      if (job.removeAbort) job.removeAbort();
      return true;
    };
    if (signal) {
      const onAbort = () => {
        // Reject immediately; the worker gets a cancel message and any message
        // it still sends is ignored because its job entry is already gone.
        if (!withdraw()) return;
        cancelInWorker(state, id);
        reject(abortError());
      };
      job.removeAbort = () => signal.removeEventListener('abort', onAbort);
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      // The Blob itself, never its bytes: structured clone keeps the worker's
      // 4 MiB read bound intact and never hands the whole file to this thread.
      state.worker.postMessage({ type: 'hash', id, blob });
    } catch {
      if (!withdraw()) return;
      reject(workerUnavailableError('worker rejected the file'));
    }
  });
}

/**
 * SHA-256 of a local Blob on a background worker.
 *
 * onProgress(loadedBytes) reports bytes the worker really hashed. When no
 * worker can be started, or it dies before reporting anything, this falls back
 * to the bounded main-thread `sha256Stream` — byte-for-byte the old code path.
 * A hash that fails after reporting progress rejects instead of silently
 * reading the file a second time.
 *
 * `startTimeout` is only for tests: it bounds how long a worker may stay silent
 * before it is considered blocked.
 */
export async function sha256Background(blob, { signal, onProgress, startTimeout } = {}) {
  const report = typeof onProgress === 'function' ? onProgress : null;
  let reported = false;
  const watch = report
    ? (loaded) => { reported = true; report(loaded); }
    : null;
  try {
    return await hashInWorker(blob, { signal, onProgress: watch, startTimeout });
  } catch (error) {
    if (error && error.name === 'AbortError') throw error;
    // A worker that already delivered bytes is not "unavailable": re-reading
    // the file silently would double the cost and hide the real failure.
    if (!error || !error.workerUnavailable || reported) throw error;
    return sha256Stream(blob, { signal, onProgress: report });
  }
}
