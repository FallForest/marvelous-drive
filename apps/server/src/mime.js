/*
 * mime.js — the extension → MIME table, and why a cloud drive needs one.
 *
 * Uploads carry whatever `content-type` the browser put on the request, and
 * browsers are honest about formats they know (.png, .pdf, .mp4) and silent
 * about the ones they do not: a .heic from an iPhone arrives as
 * `application/octet-stream`, and so does a .tiff from a scanner. Stored as
 * octet-stream the file loses both its icon and any chance of a preview, so the
 * extension is consulted FIRST for the formats this table knows, and the
 * declared type only fills in what is left.
 *
 * This runs on upload (so the stored row is right) and again on read (so files
 * uploaded before this table existed are repaired without a migration).
 */

/**
 * Extension → canonical MIME.
 *
 * Deliberately not a general-purpose database: it covers the formats a personal
 * drive actually receives, including the ones browsers refuse to name. The image
 * and video entries matter most, because those are the types a preview branches
 * on.
 */
export const EXTENSION_MIME = {
  // ── images ────────────────────────────────────────────────────
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', jfif: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
  svg: 'image/svg+xml', svgz: 'image/svg+xml',
  // Apple's default phone format, and the two "scanner" formats. No browser
  // decodes these on all platforms, but the name and the icon must be right.
  heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff',
  jxl: 'image/jxl', psd: 'image/vnd.adobe.photoshop',
  // ── video ─────────────────────────────────────────────────────
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo', wmv: 'video/x-ms-wmv', flv: 'video/x-flv',
  // ── audio ─────────────────────────────────────────────────────
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/opus', wma: 'audio/x-ms-wma', aiff: 'audio/aiff',
  // ── documents ─────────────────────────────────────────────────
  pdf: 'application/pdf',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation', rtf: 'application/rtf',
  epub: 'application/epub+zip',
  // ── archives ──────────────────────────────────────────────────
  zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
  rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
  // ── text and code ─────────────────────────────────────────────
  txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', mdx: 'text/markdown',
  log: 'text/plain', csv: 'text/csv', tsv: 'text/tab-separated-values',
  json: 'application/json', yml: 'text/yaml', yaml: 'text/yaml', toml: 'text/plain', ini: 'text/plain',
  js: 'text/javascript', mjs: 'text/javascript', ts: 'text/plain', tsx: 'text/plain', jsx: 'text/plain',
  css: 'text/css', html: 'text/html', htm: 'text/html', xml: 'application/xml',
  py: 'text/plain', rb: 'text/plain', go: 'text/plain', rs: 'text/plain',
  java: 'text/plain', c: 'text/plain', h: 'text/plain', cpp: 'text/plain',
  sh: 'text/plain', sql: 'text/plain', srt: 'text/plain', vtt: 'text/vtt',
  ipynb: 'application/x-ipynb+json',
};

/** Lower-case extension without the dot, or ''. */
export function extensionOf(name) {
  const clean = String(name || '');
  const index = clean.lastIndexOf('.');
  if (index <= 0 || index === clean.length - 1) return '';
  return clean.slice(index + 1).toLowerCase();
}

export const GENERIC_MIMES = new Set([
  'application/octet-stream', 'binary/octet-stream', 'application/unknown', '',
]);

/**
 * The MIME a stored file should carry.
 *
 * The extension wins for every format in the table. That is the opposite of the
 * usual rule — a declared type is normally more trustworthy — and it is
 * deliberate: the declared type here is only ever what a browser guessed from
 * the same file name, so it can never be more specific, and it is often
 * `application/octet-stream` where the name is perfectly clear.
 */
export function resolveMime(name, declared) {
  const table = EXTENSION_MIME[extensionOf(name)];
  const given = String(declared || '').split(';')[0].trim().toLowerCase();
  if (table) return table;
  if (!given || GENERIC_MIMES.has(given)) return 'application/octet-stream';
  return given;
}

/** True when the stored MIME can be replaced by the extension's answer. */
export function shouldRepairMime(name, declared) {
  const table = EXTENSION_MIME[extensionOf(name)];
  if (!table) return false;
  const given = String(declared || '').split(';')[0].trim().toLowerCase();
  return !given || GENERIC_MIMES.has(given) || given === 'application/octet-stream';
}
