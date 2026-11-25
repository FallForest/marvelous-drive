/*
 * sha256-worker.js — background SHA-256 for large local files.
 *
 * One module worker per page (see sha256.js), shared by every upload. The page
 * posts the Blob itself, so the bytes are structured-cloned by the browser and
 * never travel through postMessage as an ArrayBuffer. `sha256Stream` reads at
 * most 4 MiB at a time, so peak memory stays bounded no matter the file size.
 *
 * Protocol (each message carries the request id):
 *   in:  { type: 'hash', id, blob }
 *        { type: 'cancel', id }
 *   out: { type: 'progress', id, loaded }
 *        { type: 'done', id, hash }
 *        { type: 'error', id, message }
 *
 * The worker keeps no state beyond the requests it is running: a canceled
 * request is aborted and forgotten, so a late result has nowhere to go.
 */
import { sha256Stream } from './sha256.js';

const running = new Map();

function send(message) {
  try {
    self.postMessage(message);
  } catch {
    // A terminated page: nothing is listening and there is nothing to clean up.
  }
}

async function hash(id, blob) {
  const controller = new AbortController();
  running.set(id, controller);
  try {
    const hashValue = await sha256Stream(blob, {
      signal: controller.signal,
      onProgress: (loaded) => send({ type: 'progress', id, loaded }),
    });
    if (running.get(id) !== controller) return; // canceled mid-read
    send({ type: 'done', id, hash: hashValue });
  } catch (error) {
    if (running.get(id) !== controller) return;
    if (error && error.name === 'AbortError') return;
    send({ type: 'error', id, message: error && error.message ? error.message : 'hash failed' });
  } finally {
    if (running.get(id) === controller) running.delete(id);
  }
}

self.onmessage = (event) => {
  const data = event && event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'hash' && data.id !== undefined && data.blob instanceof Blob) {
    // A duplicate id would make two reads race for one slot; the page never
    // reuses ids, so the newer request wins only when the older one is gone.
    if (running.has(data.id)) return;
    hash(data.id, data.blob);
    return;
  }
  if (data.type === 'cancel' && data.id !== undefined) {
    const controller = running.get(data.id);
    running.delete(data.id);
    if (controller) controller.abort();
  }
};

// The handler is installed, so this module really loaded and can accept a hash.
// The page's start-up watchdog waits for this instead of the first hash byte,
// which a slow first 4 MiB read can delay past the deadline.
send({ type: 'ready' });
