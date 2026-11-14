/*
 * format.js — pure formatting helpers: byte sizes, zh-CN dates, file kinds,
 * inline SVG icon strings and a small escaped Markdown renderer.
 * Everything here is side-effect free and unit-testable without a DOM.
 */

const KB = 1024;
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** 0 -> "0 B", 1536 -> "1.5 KB", 8388608 -> "8.0 MB". */
export function bytes(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < KB) return Math.round(n) + ' B';
  let size = n;
  let unit = 0;
  while (size >= KB && unit < UNITS.length - 1) { size /= KB; unit += 1; }
  const digits = size < 10 ? 1 : 0;
  return size.toFixed(digits) + ' ' + UNITS[unit];
}

/** Full timestamp for metadata rows: 2026/11/10 20:34. */
export function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

/** Compact date used in list columns: 11月10日 20:34. */
function formatShortDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Relative time in the UI voice: 刚刚 / 3 分钟前 / 2 天前. */
export function relativeTime(value, now) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const reference = Number.isFinite(now) ? now : Date.now();
  const diff = Math.max(0, reference - date.getTime());
  const minute = 60 * 1000;
  if (diff < minute) return '刚刚';
  if (diff < 60 * minute) return Math.floor(diff / minute) + ' 分钟前';
  if (diff < 24 * 60 * minute) return Math.floor(diff / (60 * minute)) + ' 小时前';
  if (diff < 7 * 24 * 60 * minute) return Math.floor(diff / (24 * 60 * minute)) + ' 天前';
  return formatShortDate(value);
}

/** Expiry countdown: "3 天后过期" / "已过期". */
export function expiryLabel(expiresAt, now) {
  if (!expiresAt) return '永不过期';
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return '永不过期';
  const reference = Number.isFinite(now) ? now : Date.now();
  const diff = date.getTime() - reference;
  if (diff <= 0) return '已过期';
  const hours = diff / 3600000;
  if (hours < 1) return Math.max(1, Math.round(diff / 60000)) + ' 分钟后过期';
  if (hours < 48) return Math.round(hours) + ' 小时后过期';
  return Math.round(hours / 24) + ' 天后过期';
}

const EXT_KIND = {
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  txt: 'text', log: 'text', csv: 'text', tsv: 'text', json: 'code', yml: 'code', yaml: 'code',
  js: 'code', mjs: 'code', cjs: 'code', ts: 'code', tsx: 'code', jsx: 'code', css: 'code', html: 'code',
  py: 'code', rb: 'code', go: 'code', rs: 'code', java: 'code', kt: 'code', swift: 'code',
  c: 'code', h: 'code', cpp: 'code', hpp: 'code', cs: 'code', php: 'code',
  sh: 'code', bash: 'code', zsh: 'code', ps1: 'code', sql: 'code', toml: 'code', ini: 'code',
  xml: 'code', vue: 'code', svelte: 'code', dart: 'code', lua: 'code', r: 'code', scala: 'code',
  ipynb: 'code', dockerfile: 'code', env: 'code',
  // Images. The four after webp are the ones a browser will NOT decode
  // everywhere, which is exactly why the icon has to be right even when the
  // preview cannot be: heic/heif are the iPhone defaults, tif/tiff come from
  // scanners, psd from Photoshop.
  png: 'image', jpg: 'image', jpeg: 'image', jpe: 'image', gif: 'image', webp: 'image',
  svg: 'image', avif: 'image', bmp: 'image', ico: 'image', jfif: 'image',
  heic: 'image', heif: 'image', tiff: 'image', tif: 'image', psd: 'image', jxl: 'image',
  pdf: 'pdf', epub: 'epub',
  zip: 'archive', gz: 'archive', tgz: 'archive', tar: 'archive', rar: 'archive', '7z': 'archive', bz2: 'archive', xz: 'archive',
  mp3: 'audio', wav: 'audio', flac: 'audio', m4a: 'audio', ogg: 'audio', oga: 'audio',
  opus: 'audio', aac: 'audio', wma: 'audio', aiff: 'audio', amr: 'audio',
  mp4: 'video', webm: 'video', mov: 'video', mkv: 'video', m4v: 'video',
  avi: 'video', wmv: 'video', flv: 'video', mpg: 'video', mpeg: 'video', '3gp': 'video',
  // Office documents get their own kind so the row icon and the preview can
  // branch on it; the server renders them through /files/:id/office.
  ppt: 'slides', pptx: 'slides', odp: 'slides', key: 'slides',
  doc: 'doc', docx: 'doc', odt: 'doc', rtf: 'doc',
  xls: 'sheet', xlsx: 'sheet', ods: 'sheet',
  // Apple iWork (.pages/.numbers/.key) and legacy binary Office are NOT
  // extractable: they are ZIP-of-IWA and OLE compound files respectively. They
  // get their own kind so the drawer offers an honest "download to open"
  // instead of asking /office for something it must refuse.
  pages: 'opaque', numbers: 'opaque', key: 'opaque',
  // Subtitles are text; a player would read them, the drawer shows them.
  srt: 'text', vtt: 'text', ass: 'text', ssa: 'text',
};

export function extension(name) {
  const clean = String(name || '');
  const index = clean.lastIndexOf('.');
  if (index <= 0 || index === clean.length - 1) return '';
  return clean.slice(index + 1).toLowerCase();
}

/**
 * Classify a node. Binary mime types win (the server is authoritative), but a
 * generic text mime still consults the extension so "text/plain" + ".md" is
 * previewed as Markdown instead of plain text.
 */
/** The pre-OOXML Office container: OLE compound file. */
const LEGACY_BINARY_MIMES = new Set([
  'application/msword',
  'application/vnd.ms-powerpoint',
  'application/vnd.ms-excel',
]);

export function fileKind(mime, name) {
  const type = String(mime || '').toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type === 'application/pdf') return 'pdf';
  if (type.startsWith('text/markdown')) return 'markdown';
  const officeByExtension = EXT_KIND[extension(name)];
  if (officeByExtension === 'slides' || officeByExtension === 'doc' || officeByExtension === 'sheet') {
    // The server extracts OOXML/ODF only. A legacy binary .doc that arrives
    // with an OLE mime is not extractable, and pretending otherwise sends the
    // drawer to an endpoint that must answer 400.
    if (LEGACY_BINARY_MIMES.has(type)) return 'opaque';
    return officeByExtension;
  }
  if (officeByExtension === 'opaque') return 'opaque';
  // epub is a ZIP inside, but "a book I can read" outranks "an archive I can
  // only download": the MIME check for zip would otherwise swallow it.
  if (officeByExtension === 'epub' || type === 'application/epub+zip') return 'epub';
  if (type.includes('zip') || type.includes('tar') || type.includes('rar') || type.includes('7z') || type.includes('gzip')) return 'archive';
  const byExtension = EXT_KIND[extension(name)];
  if (type.startsWith('text/') || type === 'application/json' || !type || type === 'application/octet-stream') {
    if (byExtension === 'markdown' || byExtension === 'code') return byExtension;
    if (byExtension) return byExtension;
    if (type.startsWith('text/') || type === 'application/json') return 'text';
  }
  return byExtension || 'file';
}

const TEXT_KINDS = new Set(['markdown', 'text', 'code']);
export function isTextLike(mime, name) {
  return TEXT_KINDS.has(fileKind(mime, name));
}
export function isMarkdown(mime, name) {
  return fileKind(mime, name) === 'markdown';
}

const ICON_BODY = {
  drive: '<path d="M22 12H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><path d="M6 16h.01"/><path d="M10 16h.01"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  'folder-plus': '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="M12 10v6"/><path d="M9 13h6"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  'file-text': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  'file-image': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><circle cx="9" cy="12" r="1.6"/><path d="m20 17-3.5-3.5L9 21"/>',
  'file-pdf': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M9 15h1.5a1.5 1.5 0 0 0 0-3H9v6"/><path d="M15 18v-6h2"/>',
  'file-code': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m10 12-2 2 2 2"/><path d="m14 16 2-2-2-2"/>',
  'file-archive': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9v1"/><path d="M10 12v1"/><path d="M10 15v1"/><path d="M10 18h.01"/>',
  'file-audio': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 16V11l4 2"/>',
  'file-video': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m10 11 5 3-5 3z"/>',
  'file-slides': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><rect x="8" y="11" width="6" height="4" rx="1"/><path d="M11 17h.01"/>',
  'file-doc': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M8 12h8"/><path d="M8 16h8"/><path d="M8 8h3"/>',
  'file-sheet': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M8 12h8"/><path d="M8 12v6"/><path d="M12 12v6"/><path d="M16 12v6"/><path d="M8 15h8"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  share: '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="m16 6-4-4-4 4"/><path d="M12 2v13"/>',
  star: '<path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01Z"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  'more-horizontal': '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  // Reserved space for a menu row that is not the current choice. It exists so
  // every label in a list of choices starts on the same x: without it the
  // checked row's tick shifts that one label to the right.
  blank: '<path d="M0 0"/>',
  'chevron-up': '<path d="m18 15-6-6-6 6"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  'external-link': '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  'arrow-right': '<path d="m12 5 7 7-7 7"/><path d="M5 12h14"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  move: '<path d="M5 9 2 12l3 3"/><path d="m9 5 3-3 3 3"/><path d="m15 19-3 3-3-3"/><path d="m19 9 3 3-3 3"/><path d="M2 12h20"/><path d="M12 2v20"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
  sort: '<path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="M21 8l-4-4-4 4"/><path d="M17 4v16"/>',
  lock: '<rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  unlock: '<rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  'log-out': '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  'rotate-ccw': '<path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.7 3L3 8"/><path d="M3 3v5h5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  menu: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/>',
  'book-open': '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.7-9h1.8a4.5 4.5 0 1 1 0 9Z"/>',
  'cloud-off': '<path d="M22 17.5a4.5 4.5 0 0 0-2-8.4A7 7 0 0 0 5.8 6.8"/><path d="M5 5 2 2"/><path d="m2 2 20 20"/><path d="M5.8 6.8A7 7 0 0 0 9 19h8.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  harddrive: '<path d="M22 12H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><path d="M6 16h.01"/><path d="M10 16h.01"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.3-9.3"/><path d="m16 4 3 3"/><path d="m19 7 2-2"/>',
  'external': '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/>',
  'arrow-up': '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  'arrow-down': '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  'file-plus': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M9 15h6"/><path d="M12 12v6"/>',
  'loader': '<path d="M21 12a9 9 0 1 1-6.2-8.5"/>',
};

/** Icon names available for file rows. */
export function kindIcon(kind, name) {
  switch (kind) {
    case 'folder': return 'folder';
    case 'markdown': return 'file-text';
    case 'text': return 'file-text';
    case 'code': return 'file-code';
    case 'image': return 'file-image';
    case 'pdf': return 'file-pdf';
    case 'archive': return 'file-archive';
    case 'audio': return 'file-audio';
    case 'video': return 'file-video';
    case 'slides': return 'file-slides';
    case 'doc': return 'file-doc';
    case 'sheet': return 'file-sheet';
    default: return name && extension(name) ? 'file' : 'file';
  }
}

/** Inline SVG string. Colour comes from currentColor, so CSS owns it. */
export function icon(name, size) {
  const body = ICON_BODY[name] || ICON_BODY.file;
  const s = size || 16;
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="' + s + '" height="' + s +
    '" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    body + '</svg>';
}

/**
 * Nodes sorted folders-first, then by the requested key.
 * Folders carry no size, so they always keep name order inside the folder
 * group; the sort key and direction only apply to files.
 */
export function sortNodes(nodes, key, direction) {
  const dir = direction === 'desc' ? -1 : 1;
  const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN', { sensitivity: 'base', numeric: true });
  return [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    if (a.kind === 'folder') return byName(a, b);
    let delta = 0;
    if (key === 'size') delta = (a.size || 0) - (b.size || 0);
    else if (key === 'updated') delta = new Date(a.updatedAt || 0).getTime() - new Date(b.updatedAt || 0).getTime();
    else if (key === 'created') delta = new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
    else delta = byName(a, b);
    if (delta === 0) delta = byName(a, b);
    return delta * dir;
  });
}

/** Two-letter initials for the avatar chip. */
export function initials(value) {
  const text = String(value || '').trim();
  if (!text) return '?';
  const name = text.split('@')[0];
  const parts = name.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inline(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return out;
}

/**
 * Minimal, safe Markdown -> HTML. Input is escaped before any tag is
 * produced, so document text can never inject markup.
 * Supports: headings, lists, fenced code, blockquotes, hr, paragraphs,
 * inline code / bold / italic / links.
 */
export function renderMarkdown(source) {
  const lines = String(source === undefined || source === null ? '' : source).replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let index = 0;
  let listType = null;
  const closeList = () => { if (listType) { html.push('</' + listType + '>'); listType = null; } };
  while (index < lines.length) {
    const line = lines[index];
    if (/^```/.test(line)) {
      closeList();
      const body = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index])) body.push(lines[index++]);
      index += 1;
      html.push('<pre><code>' + escapeHtml(body.join('\n')) + '</code></pre>');
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = Math.min(6, heading[1].length);
      html.push('<h' + level + '>' + inline(heading[2].trim()) + '</h' + level + '>');
      index += 1;
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\S]*$/.test(line) && line.replace(/[\s\-_*]/g, '') === '') {
      closeList();
      html.push('<hr />');
      index += 1;
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      closeList();
      const body = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) body.push(lines[index++].replace(/^>\s?/, ''));
      html.push('<blockquote>' + inline(body.join(' ')) + '</blockquote>');
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      if (listType !== 'ul') { closeList(); html.push('<ul>'); listType = 'ul'; }
      html.push('<li>' + inline(bullet[1]) + '</li>');
      index += 1;
      continue;
    }
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      if (listType !== 'ol') { closeList(); html.push('<ol>'); listType = 'ol'; }
      html.push('<li>' + inline(ordered[1]) + '</li>');
      index += 1;
      continue;
    }
    if (!line.trim()) { closeList(); index += 1; continue; }
    closeList();
    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !/^(#{1,6})\s|^\s*[-*+]\s|^>|^```/.test(lines[index])) {
      paragraph.push(lines[index++]);
    }
    html.push('<p>' + inline(paragraph.join(' ')) + '</p>');
  }
  closeList();
  return html.join('\n');
}

/** Short hash for metadata rows: abc123…def456. */
export function shortHash(hash) {
  const value = String(hash || '');
  if (value.length <= 14) return value;
  return value.slice(0, 8) + '…' + value.slice(-4);
}
