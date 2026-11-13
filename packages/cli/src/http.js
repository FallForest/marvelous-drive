import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { copyFile, open, rename, rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CliError, EXIT, messageOf } from './errors.js';

/** Uploads at or above this size switch to the resumable chunked protocol. */
export const RESUMABLE_THRESHOLD = 8 * 1024 * 1024;
export const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
export const MIN_CHUNK_SIZE = 64 * 1024;
export const MAX_CHUNK_SIZE = 64 * 1024 * 1024;

const API_PREFIX = '/api/v1';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 120_000;

/** Splits a payload into upload chunks (contract: "Resumable upload"). */
export function chunkPlan({ size, chunkSize = DEFAULT_CHUNK_SIZE }) {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new CliError('File size must be a non-negative integer.', EXIT.USAGE, { code: 'USAGE' });
  }
  if (!Number.isSafeInteger(chunkSize) || chunkSize < MIN_CHUNK_SIZE || chunkSize > MAX_CHUNK_SIZE) {
    throw new CliError(
      'Chunk size must be between ' + MIN_CHUNK_SIZE + ' and ' + MAX_CHUNK_SIZE + ' bytes.',
      EXIT.USAGE,
      { code: 'USAGE' }
    );
  }
  const totalChunks = Math.max(1, Math.ceil(size / chunkSize));
  const chunks = [];
  for (let index = 0; index < totalChunks; index += 1) {
    const start = index * chunkSize;
    const end = Math.min(size, start + chunkSize);
    chunks.push({ index, start, end, length: end - start });
  }
  return { size, chunkSize, totalChunks, chunks };
}

export function shouldUseResumable(size, threshold = RESUMABLE_THRESHOLD) {
  return size > threshold;
}

function parseJson(text) {
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function envelopeOf(payload) {
  if (payload !== null && typeof payload === 'object' && payload.error && typeof payload.error === 'object') {
    return { code: typeof payload.error.code === 'string' ? payload.error.code : undefined, message: typeof payload.error.message === 'string' ? payload.error.message : undefined };
  }
  return {};
}

/** Maps an HTTP failure onto an actionable message plus exit code 1. */
export function describeFailure({ status, payload, url, method }) {
  const { code, message } = envelopeOf(payload);
  const detail = message ?? (typeof payload === 'string' && payload !== '' ? payload.slice(0, 400) : '');
  const label = (method ?? 'GET') + ' ' + url.pathname + ' failed (HTTP ' + status + (code ? ' ' + code : '') + ')';
  const suffix = detail === '' ? '' : ': ' + detail;

  if (status === 401) {
    return new CliError(
      label + suffix + '. Run "mdrive login" (or pass --token) to authenticate.',
      EXIT.ERROR, { code, status }
    );
  }
  if (status === 403) {
    return new CliError(
      label + suffix + '. This drive user is not allowed to perform that action.',
      EXIT.ERROR, { code, status }
    );
  }
  if (status === 404) {
    const hint = code === 'SHARE_NOT_FOUND'
      ? ' The share link was revoked, expired, or exceeded its download limit.'
      : code === 'NOT_A_FILE'
        ? ' Run the command against a file, not a folder.'
        : code === 'NOT_A_FOLDER'
          ? ' Run the command against a folder, not a file.'
          : ' Check the id (mdrive ls) or the path, then retry.';
    return new CliError(label + suffix + '.' + hint, EXIT.ERROR, { code, status });
  }
  if (status === 409) {
    if (code === 'VERSION_CONFLICT') {
      return new CliError(label + suffix + '. Reload with "mdrive stat NODE" and retry with the current version.', EXIT.ERROR, { code, status });
    }
    if (code === 'UPLOAD_INCOMPLETE') {
      return new CliError(label + suffix + '. Some chunks are missing; rerun the upload to resume it.', EXIT.ERROR, { code, status });
    }
    if (code === 'CHECKSUM_MISMATCH') {
      return new CliError(label + suffix + '. The assembled file does not match the expected sha256; delete the session and upload again.', EXIT.ERROR, { code, status });
    }
    // Cluster-specific conflicts. Without these two the generic branch below
    // blamed a folder name collision, which is a different problem entirely and
    // sent the operator looking in the wrong place.
    if (code === 'NODE_NOT_EMPTY') {
      return new CliError(label + suffix + '. Drain it first ("mdrive node update ID --state draining"), then run "mdrive cluster replicate" until it holds nothing.', EXIT.ERROR, { code, status });
    }
    if (code === 'DRIVER_UNSUPPORTED') {
      return new CliError(label + suffix + '. Storage nodes need the coordinator to run with DRIVE_STORAGE=cluster.', EXIT.ERROR, { code, status });
    }
    return new CliError(label + suffix + '. A node with that name already exists in the target folder; use --name or move/rename the existing node.', EXIT.ERROR, { code, status });
  }
  if (status === 413) {
    return new CliError(label + suffix + '. The file exceeds the server limit (DRIVE_MAX_UPLOAD_BYTES); split it or raise the limit.', EXIT.ERROR, { code, status });
  }
  if (status === 429) {
    return new CliError(label + suffix + '. Slow down and retry in a moment.', EXIT.ERROR, { code, status });
  }
  if (status === 502 || status === 503) {
    return new CliError(label + suffix + '. The server is temporarily unavailable; retry once it is back.', EXIT.ERROR, { code, status });
  }
  if (status >= 500) {
    return new CliError(label + suffix + '. The server failed; check its logs.', EXIT.ERROR, { code, status });
  }
  return new CliError(label + suffix, EXIT.ERROR, { code, status });
}

function networkFailure(url, error, timeoutMs) {
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new CliError(
      'Request to ' + url.origin + ' timed out after ' + Math.round(timeoutMs / 1000) + 's.',
      EXIT.ERROR,
      { code: 'TIMEOUT' }
    );
  }
  return new CliError(
    'Cannot reach ' + url.origin + ': ' + messageOf(error) + '. Is the server running? (--server / MDRIVE_SERVER)',
    EXIT.ERROR,
    { code: 'NETWORK' }
  );
}

/**
 * Thin JSON + streaming client for the versioned REST API. Mutating calls are
 * never retried automatically.
 */
export class ApiClient {
  constructor({ server, token, timeoutMs, uploadTimeoutMs, fetchImpl } = {}) {
    if (typeof server !== 'string' || server.trim() === '') {
      throw new CliError('Server is not configured. Run "mdrive login --server URL" or set MDRIVE_SERVER.', EXIT.USAGE, { code: 'USAGE' });
    }
    let parsed;
    try {
      parsed = new URL(server.includes('://') ? server : 'http://' + server);
    } catch {
      throw new CliError('Invalid server URL: ' + server, EXIT.USAGE, { code: 'USAGE' });
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new CliError('Server URL must use http or https: ' + server, EXIT.USAGE, { code: 'USAGE' });
    }
    const prefix = parsed.pathname.replace(/\/+$/, '');
    this.server = parsed.origin + prefix;
    this.origin = parsed.origin;
    this.base = this.server + API_PREFIX;
    this.token = token;
    this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.uploadTimeoutMs = uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
  }

  buildUrl(path, query) {
    const suffix = path.startsWith('/') ? path : '/' + path;
    const url = new URL(this.base + suffix);
    if (query) {
      for (const [name, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue;
        url.searchParams.set(name, String(value));
      }
    }
    return url;
  }

  headers(extra = {}) {
    const headers = new Headers({ accept: 'application/json' });
    for (const [name, value] of Object.entries(extra)) {
      if (value !== undefined && value !== null) headers.set(name, value);
    }
    if (this.token) headers.set('authorization', 'Bearer ' + this.token);
    return headers;
  }

  async #decode(response, url, method) {
    const text = await response.text();
    const payload = parseJson(text);
    if (!response.ok) {
      throw describeFailure({ status: response.status, payload, url, method });
    }
    return payload;
  }

  async request(method, path, options = {}) {
    const url = this.buildUrl(path, options.query);
    const headers = this.headers(options.headers);
    let body;
    if (options.body !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(options.body);
    }
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      throw networkFailure(url, error, timeoutMs);
    }
    return this.#decode(response, url, method);
  }

  get(path, options = {}) { return this.request('GET', path, options); }
  post(path, body, options = {}) { return this.request('POST', path, { ...options, body }); }
  put(path, body, options = {}) { return this.request('PUT', path, { ...options, body }); }
  del(path, options = {}) { return this.request('DELETE', path, options); }

  /** Raw-byte request used by uploads; body is a Buffer or Uint8Array. */
  async putBytes(path, bytes, options = {}) {
    const url = this.buildUrl(path, options.query);
    const headers = this.headers(options.headers);
    headers.set('content-type', options.contentType ?? 'application/octet-stream');
    headers.set('content-length', String(bytes.length));
    const timeoutMs = options.timeoutMs ?? this.uploadTimeoutMs;
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: 'PUT',
        headers,
        body: bytes,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      throw networkFailure(url, error, timeoutMs);
    }
    const result = await this.#decode(response, url, 'PUT');
    return { payload: result, status: response.status };
  }

  /**
   * Streams a response body to disk. Resumes when the destination already
   * holds a prefix and the server answers 206.
   *
   * @returns {{path: string, bytes: number, status: number, resumed: boolean}}
   */
  async download(path, options = {}) {
    const url = this.buildUrl(path, options.query);
    const headers = this.headers(options.headers);
    let start = 0;
    if (options.resume === true && options.destination) {
      try {
        start = (await stat(options.destination)).size;
      } catch {
        start = 0;
      }
    }
    if (start > 0) headers.set('range', 'bytes=' + start + '-');

    let response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(options.timeoutMs ?? this.uploadTimeoutMs)
      });
    } catch (error) {
      throw networkFailure(url, error, options.timeoutMs ?? this.uploadTimeoutMs);
    }
    if (!response.ok) {
      const text = await response.text();
      throw describeFailure({ status: response.status, payload: parseJson(text), url, method: 'GET' });
    }
    const resumed = response.status === 206 && start > 0;
    const total = Number(response.headers.get('content-length') ?? 0) + (resumed ? start : 0);

    if (!options.destination || options.destination === '-') {
      const buffer = Buffer.from(await response.arrayBuffer());
      return { data: buffer, bytes: buffer.length, status: response.status, resumed, total, headers: response.headers };
    }

    const temporary = options.destination + '.' + process.pid + '.part';
    if (resumed) {
      // Keep the bytes already on disk: they are the prefix the server skipped.
      await copyFile(options.destination, temporary);
    } else {
      await rm(temporary, { force: true });
    }
    const write = createWriteStream(temporary, resumed ? { flags: 'a' } : {});
    let received = resumed ? start : 0;
    if (response.body) {
      const source = Readable.fromWeb(response.body);
      if (typeof options.onProgress === 'function') {
        source.on('data', chunk => {
          received += chunk.length;
          options.onProgress(received, total);
        });
      }
      await pipeline(source, write);
    } else {
      write.end();
    }
    await rename(temporary, options.destination);
    return { path: options.destination, bytes: received, status: response.status, resumed, total, headers: response.headers };
  }
}

/** Reads a file in slice ranges without loading the whole payload at once. */
export async function readChunk(filePath, start, end) {
  const handle = await open(filePath, 'r');
  try {
    const length = end - start;
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}


/** sha256 of a file, streamed so a multi-GB upload does not need a buffer. */
export async function sha256File(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    createReadStream(filePath).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', resolve);
  });
  return hash.digest('hex');
}

/**
 * Instant upload ("秒传").
 *
 * Hashes the file locally, asks the server whether it already stores those bytes,
 * and if so asks it to create the node directly. Returns null whenever the fast
 * path does not apply, so the caller falls back to a real upload — a 404, a
 * network hiccup or a size disagreement must never fail the command.
 *
 * Only files above `minBytes` are hashed: reading a 2 KB file twice is slower
 * than just sending it.
 */
export async function instantUpload(client, { filePath, name, parentId, size, mime, onConflict, minBytes = 1024 * 1024 }) {
  if (size < minBytes) return null;
  let hash;
  try {
    hash = await sha256File(filePath);
  } catch {
    return null;
  }
  let probe;
  try {
    probe = await client.get('/blobs/' + hash);
  } catch {
    return null;
  }
  if (!probe || probe.exists !== true) return null;
  if (Number(probe.size) !== Number(size)) return null;
  try {
    const created = await client.post('/uploads/instant', {
      name, parentId, sha256: hash, size, mime,
      ...(onConflict === undefined ? {} : { onConflict }),
    });
    if (!created?.node) return null;
    return { node: created.node, sha256: hash, refs: probe.refs, deduplicated: Boolean(created.deduplicated) };
  } catch (error) {
    // A race (someone deleted the blob between probe and create) must not fail.
    if (error instanceof CliError && error.code === 'BLOB_NOT_FOUND') return null;
    throw error;
  }
}

/**
 * Simple single-request upload.
 * Returns the node and a boolean telling whether an existing file was versioned.
 */
export async function uploadSimple(client, { parentId, name, filePath, bytes, contentType, mime, onProgress, onConflict }) {
  const data = bytes ?? (await readChunk(filePath, 0, (await stat(filePath)).size));
  const result = await client.putBytes('/uploads', data, {
    query: { parentId, name, onConflict },
    contentType: mime ?? contentType ?? 'application/octet-stream',
    headers: { 'x-file-name': name },
    timeoutMs: client.uploadTimeoutMs
  });
  if (typeof onProgress === 'function') onProgress(data.length, data.length);
  const node = result.payload?.node ?? null;
  return { node, status: result.status, overwrote: result.status === 200 };
}

/**
 * Resumable upload: create a session, re-read its received chunks, send the
 * missing ones in order, then complete it.
 *
 * @returns {Promise<{node: unknown, session: object, chunksSent: number, skipped: number}>}
 */
export async function uploadResumable(client, options) {
  const {
    filePath, name, parentId, size, mime, chunkSize = DEFAULT_CHUNK_SIZE, onProgress, signal, session: existing
  } = options;

  let session;
  if (existing !== undefined && existing !== null) {
    // Resume: the server owns the session and reports which chunks it kept.
    const resumed = await client.get('/uploads/sessions/' + encodeURIComponent(existing));
    session = resumed?.upload;
    if (!session) {
      throw new CliError('Upload session ' + existing + ' was not found on the server.', EXIT.ERROR, { code: 'NOT_FOUND', status: 404 });
    }
    if (Number(session.size) !== Number(size)) {
      throw new CliError(
        'Session ' + existing + ' expects ' + session.size + ' bytes but the local file has ' + size + '. Pick the right file or start a new upload.',
        EXIT.ERROR,
        { code: 'SIZE_MISMATCH' }
      );
    }
  } else {
    try {
      const created = await client.post('/uploads/sessions', { name, size, parentId, chunkSize });
      session = created?.upload;
    } catch (error) {
      if (error instanceof CliError && error.status === 409 && error.code === 'CONFLICT') {
        throw new CliError(
          'The server refused to open the upload session: ' + error.message +
          ' Finish the existing session with "mdrive upload FILE --session SESSION_ID".',
          EXIT.ERROR,
          { code: 'CONFLICT', status: 409 }
        );
      }
      throw error;
    }
  }
  if (!session || typeof session.id !== 'string') {
    throw new CliError('The server did not return an upload session.', EXIT.ERROR, { code: 'PROTOCOL' });
  }
  const plan = chunkPlan({ size, chunkSize: Number(session.chunkSize ?? chunkSize) });

  const done = new Set(Array.isArray(session.receivedChunks) ? session.receivedChunks : []);
  let sent = 0;
  let skipped = 0;
  let uploaded = done.size === 0 ? 0 : plan.chunks.filter(chunk => done.has(chunk.index)).reduce((sum, chunk) => sum + chunk.length, 0);

  for (const chunk of plan.chunks) {
    if (done.has(chunk.index)) {
      skipped += 1;
      continue;
    }
    if (signal?.aborted) break;
    const bytes = await readChunk(filePath, chunk.start, chunk.end);
    if (bytes.length !== chunk.length) {
      throw new CliError(
        'Short read at byte ' + chunk.start + ' of ' + filePath + ' (expected ' + chunk.length + ', got ' + bytes.length + ').',
        EXIT.ERROR,
        { code: 'LOCAL_IO' }
      );
    }
    const result = await client.putBytes('/uploads/sessions/' + encodeURIComponent(session.id) + '/chunks/' + chunk.index, bytes, {
      contentType: 'application/octet-stream',
      timeoutMs: client.uploadTimeoutMs
    });
    if (result.payload?.upload) session = result.payload.upload;
    sent += 1;
    uploaded += bytes.length;
    if (typeof onProgress === 'function') onProgress(uploaded, size, chunk.index + 1, plan.totalChunks);
  }

  const completed = await client.post('/uploads/sessions/' + encodeURIComponent(session.id) + '/complete',
    options.onConflict === undefined ? undefined : { onConflict: options.onConflict });
  return { node: completed?.node, session, chunksSent: sent, skipped, plan, deduplicated: Boolean(completed?.deduplicated) };
}