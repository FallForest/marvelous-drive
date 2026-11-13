import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Output,
  colorEnabled,
  displayWidth,
  formatBytes,
  formatRelative,
  formatTimestamp,
  renderTable,
  stripAnsi,
  truncate
} from '../src/output.js';

function sink() {
  let text = '';
  return {
    isTTY: false,
    write(chunk) { text += chunk; return true; },
    get text() { return text; }
  };
}

test('byte sizes use binary units with compact precision', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(1024), '1.00 KiB');
  assert.equal(formatBytes(1536), '1.50 KiB');
  assert.equal(formatBytes(10 * 1024), '10.0 KiB');
  assert.equal(formatBytes(150 * 1024), '150 KiB');
  assert.equal(formatBytes(8 * 1024 * 1024), '8.00 MiB');
  assert.equal(formatBytes(2 * 1024 * 1024 * 1024), '2.00 GiB');
  assert.equal(formatBytes(undefined), '-');
});

test('relative dates collapse into human buckets', () => {
  const now = Date.parse('2026-01-10T12:00:00.000Z');
  assert.equal(formatRelative('2026-01-10T11:59:40.000Z', now), 'just now');
  assert.equal(formatRelative('2026-01-10T11:30:00.000Z', now), '30m ago');
  assert.equal(formatRelative('2026-01-10T09:00:00.000Z', now), '3h ago');
  assert.equal(formatRelative('2026-01-07T12:00:00.000Z', now), '3d ago');
  assert.equal(formatRelative('2025-12-01T12:00:00.000Z', now), '2025-12-01');
  assert.equal(formatRelative(null, now), '-');
  assert.equal(formatRelative('not-a-date', now), 'not-a-date');
});

test('absolute timestamps are ISO-8601 UTC', () => {
  assert.equal(formatTimestamp('2026-01-02T10:00:00.000Z'), '2026-01-02 10:00:00Z');
  assert.equal(formatTimestamp(null), '-');
});

test('display width counts CJK as two cells', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('\u6587\u6863'), 4);
  assert.equal(displayWidth('a\u6587b'), 4);
  assert.equal(displayWidth('\u001b[32mgreen\u001b[0m'), 5, 'ANSI codes are ignored');
});

test('truncate keeps the column budget and appends an ellipsis', () => {
  assert.equal(truncate('short', 10), 'short');
  assert.equal(truncate('abcdefghij', 6), 'abcde\u2026');
  assert.equal(truncate('\u6587\u6863\u6587\u6863\u6587\u6863', 5), '\u6587\u6863\u2026');
});

test('the table renderer pads left columns to the widest cell', () => {
  const lines = renderTable(
    [{ header: 'kind' }, { header: 'name' }],
    [['folder', 'Projects'], ['file', 'plan.md'], ['file', 'a-very-long-name.txt']]
  );
  const text = lines.map(line => (line.header ? line.text : line.cells.map(cell => cell.text).join('  ')));
  assert.equal(text[0], 'KIND    NAME');
  assert.equal(text[1], 'folder  Projects');
  assert.equal(text[2], 'file    plan.md');
  assert.equal(text[3], 'file    a-very-long-name.txt');
  const rows = lines.slice(1).map(line => line.cells.map(cell => cell.text));
  assert.deepEqual(rows.map(row => displayWidth(row[0])), [6, 6, 6], 'first column padded to the header width');
});

test('right aligned columns end at the same boundary', () => {
  const lines = renderTable(
    [{ header: 'size', align: 'right' }, { header: 'name' }],
    [['-', 'Projects'], ['1.50 KiB', 'plan.md'], ['999 B', 'notes.txt']]
  );
  const rows = lines.slice(1).map(line => line.cells.map(cell => cell.text));
  const widths = rows.map(row => displayWidth(row[0]));
  assert.deepEqual(widths, [8, 8, 8], 'every size cell is padded to the widest value');
  assert.equal(rows[0][0], '       -');
  assert.equal(rows[1][0], '1.50 KiB');
  assert.equal(rows[2][0], '   999 B');
  assert.equal(lines[0].text, 'SIZE      NAME', 'headers stay left aligned inside the column width');
});

test('the last column is never padded so pipes stay clean', () => {
  const lines = renderTable([{ header: 'a' }, { header: 'b' }], [['x', 'y']]);
  assert.equal(lines[1].cells[1].text, 'y');
  assert.equal(lines[1].cells[0].text.length, 1, 'a single cell column is not padded');
});

test('the table renderer keeps CJK columns straight', () => {
  const lines = renderTable([{ header: 'name' }, { header: 'kind' }], [['\u6587\u6863', 'file'], ['plan.md', 'file']]);
  const rows = lines.slice(1).map(line => line.cells.map(cell => cell.text));
  assert.equal(displayWidth(rows[0][0]), displayWidth(rows[1][0]), 'both cells span the same terminal width');
});

test('empty tables produce no lines so callers choose the message', () => {
  assert.deepEqual(renderTable([{ header: 'a' }], []), []);
});

test('colours are only emitted for a TTY', () => {
  const piped = new Output({ json: false, color: false, stdout: sink(), stderr: sink() });
  assert.equal(piped.paint('x', 'green'), 'x');
  const tty = new Output({ json: false, color: true, stdout: sink(), stderr: sink() });
  assert.equal(stripAnsi(tty.paint('x', 'green')), 'x');
  assert.notEqual(tty.paint('x', 'green'), 'x');
  const previous = { NO_COLOR: process.env.NO_COLOR, TERM: process.env.TERM };
  process.env.NO_COLOR = '1';
  assert.equal(colorEnabled({ isTTY: true }), false);
  delete process.env.NO_COLOR;
  process.env.TERM = 'dumb';
  assert.equal(colorEnabled({ isTTY: true }), false);
  if (previous.TERM === undefined) delete process.env.TERM;
  else process.env.TERM = previous.TERM;
  assert.equal(colorEnabled({ isTTY: false }), false);
  assert.equal(colorEnabled({ isTTY: true }), true);
  if (previous.NO_COLOR === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = previous.NO_COLOR;
  if (previous.TERM === undefined) delete process.env.TERM;
  else process.env.TERM = previous.TERM;
});

test('--json data is printed verbatim and suppresses tables', () => {
  const out = sink();
  const json = new Output({ json: true, color: false, stdout: out, stderr: sink() });
  assert.equal(json.data({ ok: true, nodes: [] }), true);
  json.table([{ header: 'a' }], [['x']]);
  assert.deepEqual(JSON.parse(out.text), { ok: true, nodes: [] });
  const human = new Output({ json: false, color: false, stdout: sink(), stderr: sink() });
  assert.equal(human.data({ ok: true }), false);
});

test('notes go to stderr so stdout stays pipeable', () => {
  const stdout = sink();
  const stderr = sink();
  const quiet = new Output({ json: false, color: false, stdout, stderr, verbose: 0 });
  quiet.note('hidden');
  quiet.error('boom');
  assert.equal(stdout.text, '');
  assert.match(stderr.text, /boom/);
  const loud = new Output({ json: false, color: false, stdout, stderr, verbose: 1 });
  loud.note('visible');
  assert.match(stderr.text, /visible/);
});

test('items in a table can be truncated per column', () => {
  const lines = renderTable([{ header: 'name', max: 5 }], [['abcdefghij']]);
  assert.equal(lines[1].cells[0].text, 'abcd\u2026');
});
