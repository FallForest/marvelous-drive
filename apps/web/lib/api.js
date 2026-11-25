/*
 * api.js — same-origin JSON client for /api/v1.
 *
 * Responsibilities:
 *  - bearer token persistence in localStorage["mdrive-token"];
 *  - one error type (ApiError) carrying HTTP status + contract error code;
 *  - a single 401 hook so the shell can bounce back to the login screen;
 *  - XHR based raw uploads where fetch cannot report progress;
 *  - one archive POST that can follow a text/event-stream progress body.
 */

const TOKEN_KEY = 'mdrive-token';
const API_BASE = '/api/v1';

/* localStorage throws in private/opaque origins; keep a memory fallback so the
   app still works for the duration of the page. */
const memory = new Map();
function storageGet(key) {
  try { return window.localStorage.getItem(key); } catch { return memory.has(key) ? memory.get(key) : null; }
}
function storageSet(key, value) {
  try { window.localStorage.setItem(key, value); } catch { memory.set(key, value); }
}
function storageRemove(key) {
  try { window.localStorage.removeItem(key); } catch { memory.delete(key); }
}

let token = storageGet(TOKEN_KEY) || '';
const unauthorizedHandlers = new Set();

export function getToken() { return token; }
export function setToken(value) {
  token = value ? String(value) : '';
  if (token) storageSet(TOKEN_KEY, token);
  else storageRemove(TOKEN_KEY);
}
export function clearToken() { setToken(''); }

/** Register a callback fired when an authenticated request returns 401. */
export function onUnauthorized(handler) {
  unauthorizedHandlers.add(handler);
  return () => unauthorizedHandlers.delete(handler);
}
function fireUnauthorized() {
  for (const handler of unauthorizedHandlers) {
    try { handler(); } catch { /* a broken listener must not mask the 401 */ }
  }
}

class ApiError extends Error {
  constructor(message, options) {
    super(message || 'Request failed');
    this.name = 'ApiError';
    const opts = options || {};
    this.status = opts.status || 0;
    this.code = opts.code || 'NETWORK_ERROR';
    this.payload = opts.payload || null;
  }
  get isUnauthorized() { return this.status === 401; }
  get isNotFound() { return this.status === 404; }
  get isConflict() { return this.status === 409; }
}

const FALLBACK_MESSAGE = {
  400: '请求参数有误。',
  401: '登录已失效，请重新登录。',
  403: '没有执行该操作的权限。',
  404: '未找到对应的内容。',
  409: '操作与现有数据冲突。',
  413: '文件超出大小限制。',
  429: '请求过于频繁，请稍后再试。',
  500: '服务器内部错误。',
  502: '下游服务不可用。',
  503: '服务暂时不可用。',
};

function apiUrl(path) {
  if (/^https?:\/\//i.test(path)) return path;
  if (path.startsWith(API_BASE)) return path;
  return API_BASE + (path.startsWith('/') ? path : '/' + path);
}

function parseBody(text, contentType) {
  if (!text) return null;
  if (contentType && contentType.includes('application/json')) {
    try { return JSON.parse(text); } catch { return null; }
  }
  return text;
}

/** The shared 401 rule: once, for an authenticated call that actually had a
 *  token, clear it and let the shell bounce to login. */
function expireSession(auth) {
  if (!auth || !token) return;
  clearToken();
  fireUnauthorized();
}

/* A malformed server that never emits the blank line between frames must not
   grow the carry string forever; past this the stream is not the contract. */
const MAX_EVENT_CARRY = 1024 * 1024;

/**
 * Splits complete `data: JSON\n\n` frames out of the carry and hands each
 * decoded JSON to `onEvent`. The server's own framing is two newlines; `\r\n`
 * is tolerated so a proxy rewrite cannot wedge the parser. A blank or unknown
 * event is ignored. Returns the unterminated remainder.
 */
function drainFrames(carry, onEvent) {
  let rest = carry;
  for (;;) {
    const match = /\r?\n\r?\n/.exec(rest);
    if (!match) break;
    const raw = rest.slice(0, match.index);
    rest = rest.slice(match.index + match[0].length);
    if (raw.length > MAX_EVENT_CARRY) throw new ApiError('进度流响应无效。', { code: 'INVALID_RESPONSE' });
    const data = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    // Only `data:` lines become an event; keep-alives and comments are blank.
    if (!data) continue;
    onEvent(JSON.parse(data));
  }
  if (rest.length > MAX_EVENT_CARRY) {
    throw new ApiError('进度流响应无效。', { code: 'INVALID_RESPONSE' });
  }
  return rest;
}

/** The four counters the archive stream reports, coalesced to numbers. */
function archiveProgress(frame) {
  return {
    entriesCompleted: Number(frame.entriesCompleted) || 0,
    entriesTotal: Number(frame.entriesTotal) || 0,
    bytesCompleted: Number(frame.bytesCompleted) || 0,
    bytesTotal: Number(frame.bytesTotal) || 0,
  };
}

/**
 * POSTs an archive build and follows its progress.
 *
 * One request only: `?progress=1&temporary=1` plus `Accept: text/event-stream`
 * asks the current server for SSE over an ephemeral ZIP; an older backend
 * ignores `temporary` and answers the same POST with `application/json` —
 * request() handles `{ node }` from that legacy body without a retry, so a
 * build can never run twice.
 *
 * `onProgress({entriesCompleted, entriesTotal, bytesCompleted, bytesTotal})` is
 * optional. Resolves `{ node }` on the frame-complete event; a frame-error
 * throws the ApiError it carried. A stream that closes before either event is
 * an error, never a silent success. The caller's AbortError is preserved.
 */
export async function requestArchive(path, { body, signal, onProgress } = {}) {
  const report = typeof onProgress === 'function' ? onProgress : null;
  let terminal = null;
  let failure = null;

  const payload = await request(path + (path.includes('?') ? '&' : '?') + 'progress=1&temporary=1', {
    method: 'POST',
    body,
    signal,
    headers: { Accept: 'text/event-stream' },
    onEvent(frame) {
      if (!frame || typeof frame !== 'object') return;
      if (frame.type === 'progress') {
        if (report) {
          try { report(archiveProgress(frame)); } catch { /* a broken listener must not stop the stream */ }
        }
        return;
      }
      if (frame.type === 'complete') { terminal = { node: frame.node }; return; }
      if (frame.type === 'error') {
        const envelope = frame.error && typeof frame.error === 'object' ? frame.error : {};
        failure = new ApiError(envelope.message || '打包失败。', {
          status: Number(envelope.status) || 0,
          code: envelope.code || 'INTERNAL_ERROR',
          payload: frame,
        });
      }
      // Unknown frame types are ignored, the same as an unknown SSE event.
    },
  });

  // A legacy JSON answer is already the complete result; no stream, no retry.
  if (payload !== null && typeof payload === 'object') return payload;
  if (failure) throw failure;
  if (!terminal) throw new ApiError('打包进度流意外中断。', { code: 'NETWORK_ERROR' });
  return terminal;
}

/**
 * request('/nodes', { method: 'POST', body: {...} })
 * - body objects are JSON encoded; FormData/Blob pass through untouched;
 * - auth defaults on, so public share calls pass { auth: false };
 * - `opts.onEvent(message)` is internal: only a successful text/event-stream
 *   response hands the raw body over, every ordinary caller reads JSON exactly
 *   as before.
 */
export async function request(path, options) {
  const opts = options || {};
  const method = (opts.method || 'GET').toUpperCase();
  const headers = new Headers(opts.headers || {});
  const auth = opts.auth !== false;
  if (auth && token) headers.set('Authorization', 'Bearer ' + token);
  let body = opts.body;
  if (body !== undefined && body !== null && !(body instanceof FormData) && !(body instanceof Blob) && typeof body !== 'string') {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(body);
  } else if (typeof body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let response;
  try {
    response = await fetch(apiUrl(path), {
      method,
      headers,
      body: body === undefined ? undefined : body,
      signal: opts.signal,
      credentials: 'same-origin',
    });
  } catch (error) {
    if (error && error.name === 'AbortError') throw error;
    throw new ApiError('无法连接服务器，请检查网络后重试。', { code: 'NETWORK_ERROR' });
  }

  if (!response.ok) {
    const text = method === 'HEAD' ? '' : await response.text();
    const payload = parseBody(text, response.headers.get('content-type') || '');
    const envelope = payload && typeof payload === 'object' ? payload.error : null;
    const code = (envelope && envelope.code) || 'HTTP_' + response.status;
    const message = (envelope && envelope.message) || FALLBACK_MESSAGE[response.status] || ('请求失败（' + response.status + '）');
    const error = new ApiError(message, { status: response.status, code, payload });
    if (response.status === 401) expireSession(auth);
    throw error;
  }

  // Only an opt-in caller and a real event stream take the streaming path; a
  // legacy JSON answer to the same POST is read below, in this same request.
  const contentType = response.headers.get('content-type') || '';
  if (typeof opts.onEvent === 'function' && contentType.toLowerCase().includes('text/event-stream')) {
    if (!response.body) throw new ApiError('服务器未返回进度流。', { code: 'INVALID_RESPONSE' });
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let carry = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        carry += decoder.decode(value, { stream: true });
        carry = drainFrames(carry, opts.onEvent);
      }
      carry += decoder.decode();
      // An unterminated remainder is not a frame; whether its absence is fatal
      // belongs to the caller (requestArchive), which knows the terminal event.
      return null;
    } catch (error) {
      // Abort first: the caller's AbortError is the contract, not a wrapping.
      if (error && error.name === 'AbortError') throw error;
      if (error instanceof ApiError) throw error;
      if (error instanceof SyntaxError) throw new ApiError('进度流响应无效。', { code: 'INVALID_RESPONSE' });
      throw new ApiError('无法连接服务器，请检查网络后重试。', { code: 'NETWORK_ERROR' });
    } finally {
      // On every exit, not just failure: a completed stream is already closed,
      // and an aborted or malformed one must release the lock and cancel bytes.
      try { await reader.cancel(); } catch { /* the stream may already be gone */ }
      try { reader.releaseLock(); } catch { /* already released */ }
    }
  }

  const text = method === 'HEAD' ? '' : await response.text();
  return parseBody(text, contentType);
}

export const api = {
  request,
  get: (path, options) => request(path, { ...(options || {}), method: 'GET' }),
  post: (path, body, options) => request(path, { ...(options || {}), method: 'POST', body }),
  put: (path, body, options) => request(path, { ...(options || {}), method: 'PUT', body }),
  patch: (path, body, options) => request(path, { ...(options || {}), method: 'PATCH', body }),
  del: (path, options) => request(path, { ...(options || {}), method: 'DELETE' }),
};

/* ── content URLs ─────────────────────────────────────────────── */
export function contentUrl(id, options) {
  const opts = options || {};
  return API_BASE + '/files/' + encodeURIComponent(id) + '/content' + (opts.download ? '?download=1' : '');
}
export function sharedInfoUrl(token) { return API_BASE + '/shared/' + encodeURIComponent(token); }
export function archiveDownloadUrl(id) { return API_BASE + '/archive-downloads/' + encodeURIComponent(id); }

/** A cancellation the download panel can show exactly as it happened. */
function downloadAborted() {
  const error = new Error('已取消下载。');
  error.name = 'AbortError';
  error.code = 'ABORTED';
  return error;
}

/**
 * The response length we are allowed to promise the user, or null.
 *
 * `Content-Length` is only the size of the blob when it describes the bytes the
 * stream hands us. A `Content-Encoding` response advertises the COMPRESSED
 * length while the stream is decoded, and a chunked response has no length at
 * all; in both cases a percentage would eventually pass 100%. Reporting "unknown"
 * makes the panel show received bytes on an indeterminate bar instead.
 */
function trustedByteTotal(response) {
  const encoding = (response.headers.get('content-encoding') || '').trim().toLowerCase();
  if (encoding && encoding !== 'identity') return null;
  const header = response.headers.get('content-length');
  if (header === null || header === '') return null;
  const total = Number(header);
  return Number.isFinite(total) && total >= 0 ? total : null;
}

/**
 * One binary GET: auth header, network mapping and the error envelope rules
 * shared by fetchBlob() and saveDownloadStream().
 *
 * `auth: false` is the public-share path and never sends a bearer token, even
 * when the page still holds a drive session.
 */
async function openBinary(path, options) {
  const opts = options || {};
  const auth = opts.auth !== false;
  const headers = new Headers();
  if (auth && token) headers.set('Authorization', 'Bearer ' + token);
  let response;
  try {
    response = await fetch(apiUrl(path), { headers, signal: opts.signal, credentials: 'same-origin' });
  } catch (error) {
    if (error && error.name === 'AbortError') throw error;
    throw new ApiError('无法获取文件内容。', { code: 'NETWORK_ERROR' });
  }
  if (!response.ok) {
    let code = 'HTTP_' + response.status;
    let message = FALLBACK_MESSAGE[response.status] || '无法获取文件内容。';
    try {
      const payload = await response.json();
      if (payload && payload.error) { code = payload.error.code || code; message = payload.error.message || message; }
    } catch { /* non JSON body */ }
    if (response.status === 401 && auth && token) { clearToken(); fireUnauthorized(); }
    throw new ApiError(message, { status: response.status, code });
  }
  return response;
}

/** The caller's Blob limit as a real number, or null when unbounded. */
function byteLimit(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * A body over a caller's limit is not an ordinary network failure: the browser
 * can still save it directly, so the message points at that way out.
 */
function downloadTooLarge() {
  return new ApiError('文件超过在线下载上限，请使用浏览器自带的“另存为”直接下载。', { code: 'DOWNLOAD_TOO_LARGE' });
}

/** Readable text for a failure that should not be swallowed. */
function errorText(error, fallback) {
  const text = error && error.message ? String(error.message).trim() : '';
  return text || fallback;
}

/**
 * Authenticated URL for links/images: fetching binary content through fetch
 * keeps the bearer header, so blobs are turned into object URLs by the caller.
 *
 * `onProgress(loaded, total)` is optional. The body is counted through a
 * TransformStream and re-wrapped as a Response, so the blob is still accumulated
 * by the browser and the client never keeps an unbounded chunk array. When
 * `total` is null the response gave no trustworthy length (chunked, compressed,
 * or a synthetic test stream): callers must show an indeterminate bar.
 *
 * `maxBytes` is optional and only for callers who cannot hold a huge file: a
 * declared length over the limit is refused before buffering, and a chunked
 * body is counted and stopped as soon as it crosses the same limit. Without a
 * limit the old contract is byte-for-byte unchanged.
 */
export async function fetchBlob(path, options) {
  const opts = options || {};
  const response = await openBinary(path, opts);
  const report = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const maxBytes = byteLimit(opts.maxBytes);
  // The old contract — no listener, no limit, no wrapper — stays byte-for-byte.
  if (!report && maxBytes === null) return response.blob();

  const total = trustedByteTotal(response);
  const reportProgress = (loaded) => {
    if (!report) return;
    try { report(loaded, total); } catch { /* a broken listener must not stop the bytes */ }
  };
  reportProgress(0);

  if (maxBytes !== null && total !== null && total > maxBytes) {
    // Refuse a declared oversize before reading any of it.
    try { await response.body.cancel(); } catch { /* body may be absent or locked */ }
    throw downloadTooLarge();
  }

  if (!response.body || typeof TransformStream !== 'function') {
    try {
      const blob = await response.blob();
      if (maxBytes !== null && blob.size > maxBytes) throw downloadTooLarge();
      reportProgress(blob.size);
      return blob;
    } catch (error) {
      if (opts.signal && opts.signal.aborted) throw downloadAborted();
      throw error;
    }
  }

  let received = 0;
  const counter = new TransformStream({
    transform(chunk, controller) {
      received += chunk && typeof chunk.byteLength === 'number' ? chunk.byteLength : 0;
      // A chunked response has no length to check first; stop at the crossing
      // point so the client never buffers past the limit.
      if (maxBytes !== null && received > maxBytes) throw downloadTooLarge();
      reportProgress(received);
      controller.enqueue(chunk);
    },
  });
  try {
    // Response(stream).blob() lets the browser accumulate the bytes. Holding the
    // chunks in an array here would double a 2 GiB download in JS memory.
    const streamed = response.body.pipeThrough(counter);
    const wrapped = new Response(streamed, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    const blob = await wrapped.blob();
    if (opts.signal && opts.signal.aborted) throw downloadAborted();
    // A trusted Content-Length is a promise about the body. A proxy that drops
    // the socket can close the stream early; saving that short blob as the file
    // would silently truncate it.
    if (total !== null && received !== total) throw new ApiError('下载中断，请重新下载。', { code: 'NETWORK_ERROR' });
    if (received !== blob.size && total === null) reportProgress(blob.size);
    return blob;
  } catch (error) {
    if (opts.signal && opts.signal.aborted) throw downloadAborted();
    if (error && error.name === 'AbortError') throw error;
    if (error instanceof ApiError) throw error;
    throw new ApiError('下载中断，请重新下载。', { code: 'NETWORK_ERROR' });
  }
}

/**
 * Streams a binary response straight into a FileSystemFileHandle.
 *
 * `handle.createWritable()` is awaited by the caller (a browser picker must be
 * opened from its own click before this function is called). Bytes are piped,
 * never collected in a Blob, so a multi-GB share download keeps flat memory and
 * honours the writable's backpressure. A trusted Content-Length is verified in
 * the transform's flush, before the writable closes: a short body errors the
 * pipe, the writable is aborted, and no truncated file is committed.
 *
 * Resolves `{ size }` with the bytes actually written. Abort is preserved as an
 * AbortError; other failures carry a readable message (network or disk).
 */
export async function saveDownloadStream(path, handle, options) {
  const opts = options || {};
  if (!handle || typeof handle.createWritable !== 'function') {
    throw new ApiError('当前浏览器不支持直接保存到磁盘。', { code: 'UNSUPPORTED' });
  }
  if (opts.signal && opts.signal.aborted) throw downloadAborted();
  const response = await openBinary(path, opts);
  const total = trustedByteTotal(response);
  const report = (loaded) => {
    try { if (typeof opts.onProgress === 'function') opts.onProgress(loaded, total); } catch { /* listener */ }
  };

  const abortWritable = async (writable) => {
    try { await writable.abort(); } catch { /* already closed or errored */ }
  };

  let writable;
  try {
    writable = await handle.createWritable();
  } catch (error) {
    if (opts.signal && opts.signal.aborted) throw downloadAborted();
    if (error && error.name === 'AbortError') throw error;
    throw new ApiError('无法创建保存文件：' + errorText(error, '请检查保存位置。'), { code: 'SAVE_FAILED' });
  }

  report(0);
  const fail = async (error) => {
    await abortWritable(writable);
    if (opts.signal && opts.signal.aborted) return downloadAborted();
    if (error && error.name === 'AbortError') return downloadAborted();
    if (error instanceof ApiError) return error;
    const name = error && error.name;
    if (name === 'QuotaExceededError' || name === 'NotAllowedError'
      || name === 'NoModificationAllowedError' || name === 'InvalidStateError') {
      return new ApiError('保存到磁盘失败：' + errorText(error, '请检查磁盘空间或保存位置。'), { code: 'SAVE_FAILED' });
    }
    return new ApiError('下载中断，请重新下载。', { code: 'NETWORK_ERROR' });
  };

  if (!response.body) {
    // No stream to pipe: write the one buffer the response still offers.
    let buffer;
    try {
      buffer = await response.arrayBuffer();
      if (total !== null && buffer.byteLength !== total) {
        throw new ApiError('下载中断，请重新下载。', { code: 'NETWORK_ERROR' });
      }
      const writer = writable.getWriter();
      try {
        await writer.write(buffer);
        await writer.close();
      } finally {
        try { writer.releaseLock(); } catch { /* closed */ }
      }
      report(buffer.byteLength);
      return { size: buffer.byteLength };
    } catch (error) {
      throw await fail(error);
    }
  }

  let received = 0;
  const verifier = new TransformStream({
    transform(chunk, controller) {
      received += chunk && typeof chunk.byteLength === 'number' ? chunk.byteLength : 0;
      report(received);
      controller.enqueue(chunk);
    },
    flush() {
      // Runs before the writable's close: a dropped socket must not commit a
      // partial file that looks complete.
      if (total !== null && received !== total) {
        throw new ApiError('下载中断，请重新下载。', { code: 'NETWORK_ERROR' });
      }
    },
  });
  try {
    // pipeTo gives backpressure and cancels the body when the signal aborts.
    await response.body.pipeThrough(verifier).pipeTo(writable, opts.signal ? { signal: opts.signal } : undefined);
    if (opts.signal && opts.signal.aborted) throw downloadAborted();
    return { size: received };
  } catch (error) {
    throw await fail(error);
  }
}

/** Save a Blob under a filename without leaking the object URL. */
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename || 'download';
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 20000);
}

/* The one-shot downloadNode() helper is gone: every download now goes through
   lib/downloads.js, which owns the task, its progress and its retry. A second
   fire-and-forget path would be a second set of rules for the same bytes. */

/**
 * XHR raw upload: fetch has no upload progress events, so the two PUT flows
 * (simple and resumable chunk) go through XHR with the same auth header.
 */
export function putRaw(path, blob, options) {
  const opts = options || {};
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', apiUrl(path), true);
    if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    if (opts.contentType) xhr.setRequestHeader('Content-Type', opts.contentType);
    if (opts.headers) {
      for (const key of Object.keys(opts.headers)) {
        if (opts.headers[key] !== undefined && opts.headers[key] !== null) xhr.setRequestHeader(key, String(opts.headers[key]));
      }
    }
    xhr.upload.addEventListener('progress', (event) => {
      if (opts.onProgress && event.lengthComputable) opts.onProgress(event.loaded, event.total);
    });
    xhr.addEventListener('load', () => {
      let payload = null;
      try { payload = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch { payload = null; }
      if (xhr.status >= 200 && xhr.status < 300) { resolve(payload); return; }
      const envelope = payload && payload.error;
      const error = new ApiError(
        (envelope && envelope.message) || FALLBACK_MESSAGE[xhr.status] || '上传失败（' + xhr.status + '）',
        { status: xhr.status, code: (envelope && envelope.code) || 'HTTP_' + xhr.status, payload },
      );
      if (xhr.status === 401 && token) { clearToken(); fireUnauthorized(); }
      reject(error);
    });
    xhr.addEventListener('error', () => reject(new ApiError('上传中断，请重试。', { code: 'NETWORK_ERROR' })));
    xhr.addEventListener('abort', () => {
      const error = new ApiError('已取消上传。', { code: 'ABORTED' });
      error.name = 'AbortError';
      reject(error);
    });
    if (opts.signal) {
      if (opts.signal.aborted) { xhr.abort(); return; }
      opts.signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(blob);
  });
}
