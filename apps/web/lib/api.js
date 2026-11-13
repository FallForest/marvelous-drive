/*
 * api.js — same-origin JSON client for /api/v1.
 *
 * Responsibilities:
 *  - bearer token persistence in localStorage["mdrive-token"];
 *  - one error type (ApiError) carrying HTTP status + contract error code;
 *  - a single 401 hook so the shell can bounce back to the login screen;
 *  - XHR based raw uploads where fetch cannot report progress.
 */

export const TOKEN_KEY = 'mdrive-token';
export const API_BASE = '/api/v1';

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
export function hasToken() { return !!token; }
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

export class ApiError extends Error {
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

export function apiUrl(path) {
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

/**
 * request('/nodes', { method: 'POST', body: {...} })
 * - body objects are JSON encoded; FormData/Blob pass through untouched;
 * - auth defaults on, so public share calls pass { auth: false }.
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

  const text = method === 'HEAD' ? '' : await response.text();
  const payload = parseBody(text, response.headers.get('content-type') || '');

  if (!response.ok) {
    const envelope = payload && typeof payload === 'object' ? payload.error : null;
    const code = (envelope && envelope.code) || 'HTTP_' + response.status;
    const message = (envelope && envelope.message) || FALLBACK_MESSAGE[response.status] || ('请求失败（' + response.status + '）');
    const error = new ApiError(message, { status: response.status, code, payload });
    if (response.status === 401 && auth && token) {
      clearToken();
      fireUnauthorized();
    }
    throw error;
  }

  return payload;
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
export function previewUrl(id) { return contentUrl(id); }
export function sharedContentUrl(token) { return API_BASE + '/shared/' + encodeURIComponent(token) + '/content'; }
export function sharedInfoUrl(token) { return API_BASE + '/shared/' + encodeURIComponent(token); }

/**
 * Authenticated URL for links/images: fetching binary content through fetch
 * keeps the bearer header, so blobs are turned into object URLs by the caller.
 */
export async function fetchBlob(path, options) {
  const headers = new Headers();
  if (token) headers.set('Authorization', 'Bearer ' + token);
  let response;
  try {
    response = await fetch(apiUrl(path), { headers, signal: options && options.signal, credentials: 'same-origin' });
  } catch {
    throw new ApiError('无法获取文件内容。', { code: 'NETWORK_ERROR' });
  }
  if (!response.ok) {
    let code = 'HTTP_' + response.status;
    let message = FALLBACK_MESSAGE[response.status] || '无法获取文件内容。';
    try {
      const payload = await response.json();
      if (payload && payload.error) { code = payload.error.code || code; message = payload.error.message || message; }
    } catch { /* non JSON body */ }
    if (response.status === 401 && token) { clearToken(); fireUnauthorized(); }
    throw new ApiError(message, { status: response.status, code });
  }
  return response.blob();
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

/** Download an authenticated file through the API (adds the bearer header). */
export async function downloadNode(node) {
  const blob = await fetchBlob(contentUrl(node.id, { download: true }));
  saveBlob(blob, node.name);
}

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
