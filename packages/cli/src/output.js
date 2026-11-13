import { writeFile } from 'node:fs/promises';
import { CliError, EXIT, messageOf } from './errors.js';

const ANSI = {
  green: '32',
  red: '31',
  yellow: '33',
  cyan: '36',
  blue: '34',
  magenta: '35',
  dim: '2',
  bold: '1'
};

const ANSI_PATTERN = new RegExp('\u001b\\[[0-9;]*m', 'g');

/** Colours only when stdout is a TTY, NO_COLOR is unset, and --no-color is off. */
export function colorEnabled(stream = process.stdout) {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  if (process.env.TERM === 'dumb') return false;
  return Boolean(stream && stream.isTTY);
}

export function stripAnsi(text) {
  return String(text).replace(ANSI_PATTERN, '');
}

/**
 * Display width in terminal cells: East Asian wide characters (CJK, fullwidth
 * forms) occupy two columns, everything else one.
 */
export function displayWidth(text) {
  const plain = stripAnsi(String(text));
  let width = 0;
  for (const character of plain) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x200b || code === 0xfe0f) continue;
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f64f) ||
      (code >= 0x1f900 && code <= 0x1f9ff) ||
      (code >= 0x20000 && code <= 0x3fffd)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

/** Human readable byte size: "0 B", "1.4 KiB", "3.00 MiB". */
export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '-';
  if (bytes < 1024) return bytes + ' B';
  const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return value.toFixed(digits) + ' ' + units[unit];
}

/** Compact relative time: "just now", "5m ago", "3h ago", "2d ago", else ISO date. */
export function formatRelative(iso, now = Date.now()) {
  if (iso === null || iso === undefined || iso === '') return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  const diff = now - date.getTime();
  if (diff < 0) {
    const ahead = Math.abs(diff);
    if (ahead < 60_000) return 'in a moment';
    if (ahead < 3_600_000) return 'in ' + Math.round(ahead / 60_000) + 'm';
    if (ahead < 86_400_000) return 'in ' + Math.round(ahead / 3_600_000) + 'h';
    return 'in ' + Math.round(ahead / 86_400_000) + 'd';
  }
  if (diff < 45_000) return 'just now';
  if (diff < 3_600_000) return Math.round(diff / 60_000) + 'm ago';
  if (diff < 86_400_000) return Math.round(diff / 3_600_000) + 'h ago';
  if (diff < 7 * 86_400_000) return Math.round(diff / 86_400_000) + 'd ago';
  if (diff < 365 * 86_400_000) return date.toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

/** Absolute UTC timestamp used by detail views and JSON-free scripts. */
export function formatTimestamp(iso) {
  if (iso === null || iso === undefined || iso === '') return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

export function truncate(text, max) {
  const value = String(text ?? '');
  const width = displayWidth(value);
  if (width <= max) return value;
  let out = '';
  let used = 0;
  for (const character of value) {
    const step = displayWidth(character);
    if (used + step > max - 1) break;
    out += character;
    used += step;
  }
  return out + '\u2026';
}

function padTo(text, width, align = 'left') {
  const current = displayWidth(text);
  if (current >= width) return text;
  const filler = ' '.repeat(width - current);
  return align === 'right' ? filler + text : text + filler;
}

/**
 * Renders rows as an aligned table. The last column is never padded so trailing
 * whitespace stays out of pipes.
 *
 * @param {{header: string, align?: 'left'|'right', max?: number}[]} columns
 * @param {(string|number|boolean|null|undefined|{text: string, color?: string})[][]} rows
 */
export function renderTable(columns, rows) {
  if (rows.length === 0) return [];
  const cells = rows.map(row =>
    columns.map((column, index) => {
      const cell = row[index];
      if (cell !== null && typeof cell === 'object') {
        return { text: String(cell.text ?? ''), color: cell.color };
      }
      return { text: cell === null || cell === undefined ? '-' : String(cell) };
    })
  );
  const widths = columns.map((column, index) => {
    const content = Math.max(
      displayWidth(column.header),
      ...cells.map(row => displayWidth(truncate(row[index].text, column.max ?? Number.MAX_SAFE_INTEGER)))
    );
    return column.max !== undefined ? Math.min(content, column.max) : content;
  });
  const lines = [];
  const header = columns
    .map((column, index) => {
      const text = column.header.toUpperCase();
      return index === columns.length - 1 ? text : padTo(text, widths[index]);
    })
    .join('  ');
  lines.push({ text: header, header: true });
  for (const row of cells) {
    const parts = columns.map((column, index) => {
      const text = truncate(row[index].text, column.max ?? Number.MAX_SAFE_INTEGER);
      const padded = index === columns.length - 1 ? text : padTo(text, widths[index], column.align);
      return { text: padded, color: row[index].color };
    });
    lines.push({ cells: parts });
  }
  return lines;
}

export const DEFAULT_JSON = 2;

export class Output {
  constructor(options = {}) {
    this.json = options.json === true;
    this.color = options.color ?? colorEnabled(options.stdout ?? process.stdout);
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
    this.verbose = options.verbose ?? 0;
    this.now = options.now ?? Date.now();
  }

  paint(text, color) {
    if (!color || !this.color) return text;
    const code = ANSI[color];
    if (code === undefined) return text;
    return '\u001b[' + code + 'm' + text + '\u001b[0m';
  }

  line(text = '') {
    this.stdout.write(text + '\n');
  }

  raw(text) {
    this.stdout.write(text);
  }

  /** Diagnostics go to stderr so stdout stays pipeable. */
  note(text) {
    if (this.verbose < 1) return;
    this.stderr.write(this.paint('mdrive: ' + text, 'dim') + '\n');
  }

  warn(text) {
    this.stderr.write(this.paint('mdrive: warning: ' + text, 'yellow') + '\n');
  }

  error(text) {
    this.stderr.write(this.paint('mdrive: ' + text, 'red') + '\n');
  }

  success(text) {
    if (this.json) return;
    this.line(this.paint(text, 'green'));
  }

  /** Machine-readable payload: printed verbatim when --json is set. */
  data(payload) {
    if (!this.json) return false;
    this.line(JSON.stringify(payload, null, DEFAULT_JSON));
    return true;
  }

  table(columns, rows, emptyMessage = 'Nothing to show.') {
    if (this.json) return;
    if (rows.length === 0) {
      this.line(this.paint(emptyMessage, 'dim'));
      return;
    }
    for (const line of renderTable(columns, rows)) {
      if (line.header) {
        this.line(this.paint(line.text, 'dim'));
        continue;
      }
      this.line(line.cells.map(part => this.paint(part.text, part.color)).join('  '));
    }
  }

  /** key/value block for stat, docs status, whoami. */
  fields(pairs) {
    if (this.json) return;
    const width = Math.max(...pairs.map(pair => displayWidth(String(pair[0]))));
    for (const [label, value] of pairs) {
      this.line(padTo(String(label), width) + '  ' + (value === undefined || value === null ? '-' : String(value)));
    }
  }

  /** Single-line progress renderer that only animates on a TTY. */
  progress(label) {
    const interactive = this.color && Boolean(this.stdout.isTTY);
    let last = -1;
    return (done, total) => {
      if (this.json) return;
      const ratio = total > 0 ? Math.min(1, done / total) : 0;
      const percent = Math.floor(ratio * 100);
      if (!interactive) {
        if (percent === 100) this.stderr.write(label + ': 100% (' + formatBytes(total) + ')\n');
        return;
      }
      if (percent === last) return;
      last = percent;
      const slots = 24;
      const filled = Math.round(ratio * slots);
      const bar = '#'.repeat(filled) + '-'.repeat(slots - filled);
      this.stderr.write('\r' + label + ' [' + bar + '] ' + String(percent).padStart(3) + '%  ' + formatBytes(done) + ' / ' + formatBytes(total));
      if (percent >= 100) this.stderr.write('\n');
    };
  }

  async writeText(text, destination) {
    if (destination === undefined || destination === '' || destination === '-') {
      this.raw(text);
      return;
    }
    try {
      await writeFile(destination, text, 'utf8');
    } catch (error) {
      throw new CliError('Cannot write ' + destination + ': ' + messageOf(error), EXIT.ERROR, { code: 'LOCAL_IO' });
    }
    this.note('wrote ' + destination);
  }
}
