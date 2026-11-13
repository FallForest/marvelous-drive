import test from 'node:test';
import assert from 'node:assert/strict';
import { Flags, GLOBAL_FLAGS, parseArgs, splitGlobals } from '../src/args.js';
import { CliError } from '../src/errors.js';

const FLAGS = [
  { name: 'name', value: 'NAME' },
  { name: 'force', kind: 'boolean', short: 'f' },
  { name: 'tag', value: 'TAG', repeatable: true },
  { name: 'level', kind: 'count', short: 'v' }
];

test('parses --flag=value and --flag value identically', () => {
  const inline = parseArgs(['--name=a b.md'], FLAGS, 'upload');
  const spaced = parseArgs(['--name', 'a b.md'], FLAGS, 'upload');
  assert.equal(inline.values.get('name'), 'a b.md');
  assert.equal(spaced.values.get('name'), 'a b.md');
});

test('a repeated boolean flag takes its last value', () => {
  const parsed = parseArgs(['--force', '--force=false'], FLAGS, 'rm');
  assert.equal(parsed.values.get('force'), false);
});

test('boolean flag accepts an explicit false', () => {
  const parsed = parseArgs(['--force=false', 'x'], FLAGS, 'rm');
  assert.equal(parsed.values.get('force'), false);
  assert.deepEqual(parsed.positional, ['x']);
});

test('rejects a non-boolean value on a boolean flag', () => {
  assert.throws(() => parseArgs(['--force=maybe'], FLAGS, 'rm'), error => {
    assert.ok(error instanceof CliError);
    assert.equal(error.exitCode, 2);
    assert.match(error.message, /takes true or false/);
    return true;
  });
});

test('repeated -v is counted', () => {
  assert.equal(parseArgs(['-v', '-v'], FLAGS, 'ls').values.get('level'), 2);
  assert.equal(parseArgs(['-vvv'], FLAGS, 'ls').values.get('level'), 3);
  assert.equal(parseArgs(['--level', '--level'], FLAGS, 'ls').values.get('level'), 2);
});

test('repeatable flags collect every value', () => {
  const parsed = parseArgs(['--tag', 'a', '--tag', 'b'], FLAGS, 'x');
  assert.deepEqual(parsed.values.get('tag'), ['a', 'b']);
});

test('duplicate scalar flags are a usage error', () => {
  assert.throws(() => parseArgs(['--name', 'a', '--name', 'b'], FLAGS, 'x'), /more than once/);
});

test('missing value is a usage error', () => {
  assert.throws(() => parseArgs(['--name'], FLAGS, 'upload'), /needs a value/);
  assert.throws(() => parseArgs(['--name', '--force'], FLAGS, 'upload'), /needs a value/);
});

test('unknown option names the command and the help command', () => {
  assert.throws(() => parseArgs(['--nope'], FLAGS, 'ls'), error => {
    assert.equal(error.exitCode, 2);
    assert.match(error.message, /--nope/);
    assert.match(error.message, /mdrive ls --help/);
    return true;
  });
});

test('-- stops option parsing and keeps the rest positional', () => {
  const parsed = parseArgs(['--force', '--', '--not-a-flag', '-x'], FLAGS, 'rm');
  assert.equal(parsed.values.get('force'), true);
  assert.deepEqual(parsed.positional, ['--not-a-flag', '-x']);
});

test('negative numbers are positional, not options', () => {
  assert.deepEqual(parseArgs(['-4'], FLAGS, 'x').positional, ['-4']);
});

test('globals are lifted from anywhere in the token stream', () => {
  const before = splitGlobals(['--json', 'ls', '/x']);
  const after = splitGlobals(['ls', '/x', '--json']);
  assert.equal(before.globals.bool('json'), true);
  assert.equal(after.globals.bool('json'), true);
  assert.deepEqual(before.rest, ['ls', '/x']);
  assert.deepEqual(after.rest, ['ls', '/x']);
});

test('global value flags keep their value and positionals stay intact', () => {
  const { globals, rest } = splitGlobals(['ls', '--server', 'http://h:1', '/Projects']);
  assert.equal(globals.str('server'), 'http://h:1');
  assert.deepEqual(rest, ['ls', '/Projects']);
});

test('global short aliases expand (-h, -V)', () => {
  assert.equal(splitGlobals(['-h']).globals.bool('help'), true);
  assert.equal(splitGlobals(['-V']).globals.bool('version'), true);
});

test('unknown long options are left for the command parser', () => {
  const { rest } = splitGlobals(['upload', '--to', '/x']);
  assert.deepEqual(rest, ['upload', '--to', '/x']);
});

test('Flags helper reads integers, choices, and required values', () => {
  const flags = new Flags(parseArgs(['--limit', '50', '--mode', 'folder'], [
    { name: 'limit', value: 'N' },
    { name: 'mode', value: 'M' }
  ], 'search'));
  assert.equal(flags.integer('limit', { min: 1, max: 100 }), 50);
  assert.equal(flags.choice('mode', ['folder', 'file']), 'folder');
  assert.throws(() => flags.required('missing'), /Missing required option --missing/);
  assert.throws(() => new Flags(parseArgs(['--limit', 'x'], [{ name: 'limit', value: 'N' }], 's')).integer('limit'), /must be an integer/);
});

test('global flag definitions stay in sync with the documented set', () => {
  assert.deepEqual(GLOBAL_FLAGS.map(flag => flag.name), ['server', 'token', 'json', 'no-color', 'verbose', 'help', 'version']);
});
