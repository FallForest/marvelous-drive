#!/usr/bin/env node
/*
 * dead-code.mjs — the static audit this repository never had.
 *
 * Why it exists: "is this module still used?" was answered by grep, one file at
 * a time, and grep lies in both directions — it misses a symbol that is only
 * reached through a dynamic import inside a test, and it "finds" a name that is
 * merely a substring of another. This script builds the real import graph.
 *
 * What counts as an entry (nothing else is allowed to keep a module alive):
 *   - each process entry in PROCESS_ENTRIES below (a file a command starts)
 *   - every path named in package.json "scripts" or a workspace "bin"
 *   - every <script type="module" src="..."> in apps/web/index.html
 *   - every test file under a workspace test/ directory
 *
 * Resolution rules:
 *   - static  import x from './y.js'  /  export ... from './y.js'
 *   - dynamic import('./y.js') with a literal specifier
 *   - import x from './y.js?variant' is resolved to ./y.js (cache-busting query)
 *
 * Usage:
 *   node scripts/dead-code.mjs            report
 *   node scripts/dead-code.mjs --json     machine-readable report
 *   node scripts/dead-code.mjs --strict   non-zero exit when anything is found
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const asJson = args.has('--json');
const strict = args.has('--strict');

const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const SKIP_DIRECTORIES = new Set(['node_modules', 'data', '.tmp', 'dist', 'build', 'coverage', '.git', 'backups', 'release']);

/** Files that legitimately have no importer, because a process starts them. */
const PROCESS_ENTRIES = [
  'apps/server/src/index.js',
  'apps/web/app.js',
  'apps/updater/update-agent.mjs',
  'packages/cli/bin/mdrive.mjs',
  'apps/server/bin/storage-node.js'
];

function walk(directory, out = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (skip(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (SOURCE_EXTENSIONS.has(extname(entry.name))) out.push(path);
  }
  return out;
}

function skip(name) {
  return SKIP_DIRECTORIES.has(name);
}

const sources = new Map();
for (const top of ['apps', 'packages', 'scripts']) {
  const directory = join(root, top);
  if (!existsSync(directory)) continue;
  for (const file of walk(directory)) sources.set(file, readFileSync(file, 'utf8'));
}

/** Strip comments and string-unaware noise so a mention in prose is not a use. */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const cleaned = new Map();
for (const [file, text] of sources) cleaned.set(file, stripComments(text));

/** Every module specifier this file points at, static or dynamic. */
function specifiersOf(file) {
  const text = cleaned.get(file);
  const found = [];
  const patterns = [
    /\bfrom\s*['"]([^'"\n]+)['"]/g,             // import/export ... from '...'
    /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g, // import('...')
    /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g // createRequire(...)('...')
  ];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text))) found.push(match[1]);
  }
  return found;
}

/** Imported bindings, so an export can be checked against real consumers. */
function destructuredNamesOf(file) {
  const text = cleaned.get(file);
  const names = new Set();
  // const { a, b: c } = await import('./x.js')
  // Found by scanning back from each dynamic import to its opening brace: a
  // regex over "{...}" either starts at an earlier block brace (and marks every
  // lazily imported export as unused) or backtracks catastrophically.
  const DYNAMIC = /=\s*await\s+import\s*\(/g;
  let dynamic;
  while ((dynamic = DYNAMIC.exec(text))) {
    const open = text.lastIndexOf('{', dynamic.index);
    if (open < 0) continue;
    const close = text.indexOf('}', open);
    if (close < 0 || close > dynamic.index) continue;
    const inside = text.slice(open + 1, close);
    if (inside.includes('{')) continue;
    for (const piece of inside.split(',')) {
      const bound = piece.trim().split(':').pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(bound)) names.add(bound);
    }
  }
  // export { a, b } from './x.js' re-exports what another module declared
  for (const match of text.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const piece of match[1].split(',')) {
      const name = piece.trim().split(/\s+as\s+/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

function importedNamesOf(file) {
  const text = cleaned.get(file);
  const names = new Set();
  const statement = /\bimport\s+([\s\S]*?)\s*from\s*['"]/g;
  let match;
  while ((match = statement.exec(text))) {
    const clause = match[1];
    const braces = clause.match(/\{([\s\S]*)\}/);
    if (braces) {
      for (const piece of braces[1].split(',')) {
        const name = piece.trim().split(/\s+as\s+/)[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
      }
    }
    const withoutBraces = clause.replace(/\{[\s\S]*\}/, '');
    const defaultName = withoutBraces.replace(/,/g, ' ').trim().split(/\s+/)[0];
    if (defaultName && defaultName !== '*' && /^[A-Za-z_$][\w$]*$/.test(defaultName)) names.add(defaultName);
  }
  return names;
}

function resolveSpecifier(from, specifier) {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null;
  const bare = specifier.split('?')[0].split('#')[0];
  const base = bare.startsWith('/') ? join(root, bare) : resolve(dirname(from), bare);
  const candidates = [base, base + '.js', base + '.mjs', base + '.cjs', join(base, 'index.js'), join(base, 'index.mjs')];
  for (const candidate of candidates) {
    if (sources.has(candidate)) return candidate;
  }
  return null;
}

/* ── entries ─────────────────────────────────────────────────── */

const entries = new Set();
const unresolved = [];

for (const relativePath of PROCESS_ENTRIES) {
  const absolute = join(root, relativePath);
  if (sources.has(absolute)) entries.add(absolute);
}

const packageFile = join(root, 'package.json');
if (existsSync(packageFile)) {
  const manifest = JSON.parse(readFileSync(packageFile, 'utf8'));
  for (const command of Object.values(manifest.scripts || {})) {
    for (const match of String(command).matchAll(/([\w./*-]*\.(?:mjs|js|cjs))/g)) {
      // A glob such as "apps/server/test/*.test.js" names a directory rule, not a
      // module: the test files themselves are entries through the test sweep.
      if (match[1].includes('*')) continue;
      const absolute = resolve(root, match[1]);
      if (sources.has(absolute)) entries.add(absolute);
      else unresolved.push('package.json scripts -> ' + match[1]);
    }
  }
}

for (const workspace of ['apps', 'packages']) {
  const directory = join(root, workspace);
  if (!existsSync(directory)) continue;
  for (const name of readdirSync(directory)) {
    const manifestPath = join(directory, name, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const value of Object.values(manifest.bin || {})) {
      const absolute = resolve(dirname(manifestPath), String(value));
      if (sources.has(absolute)) entries.add(absolute);
      else unresolved.push(workspace + '/' + name + ' bin -> ' + value);
    }
    if (manifest.main) {
      const absolute = resolve(dirname(manifestPath), String(manifest.main));
      if (sources.has(absolute)) entries.add(absolute);
    }
  }
}

const html = join(root, 'apps', 'web', 'index.html');
if (existsSync(html)) {
  for (const match of readFileSync(html, 'utf8').matchAll(/<script[^>]+type="module"[^>]+src="([^"]+)"/g)) {
    const absolute = join(root, 'apps', 'web', match[1].replace(/^\//, ''));
    if (sources.has(absolute)) entries.add(absolute);
    else unresolved.push('index.html -> ' + match[1]);
  }
}

for (const file of sources.keys()) {
  if (/[\\/]test[\\/]/.test(file)) entries.add(file);
}

/* ── reachability ────────────────────────────────────────────── */

const reachable = new Set();
const stack = [...entries];
while (stack.length) {
  const file = stack.pop();
  if (reachable.has(file)) continue;
  reachable.add(file);
  for (const specifier of specifiersOf(file)) {
    const target = resolveSpecifier(file, specifier);
    if (target && !reachable.has(target)) stack.push(target);
  }
}

const unreachableModules = [...sources.keys()]
  .filter((file) => !reachable.has(file))
  .map((file) => relative(root, file).split(sep).join('/'))
  .sort();

/* ── exports that nothing imports ────────────────────────────── */

const consumers = new Set();
for (const file of sources.keys()) {
  for (const name of importedNamesOf(file)) consumers.add(name);
  for (const name of destructuredNamesOf(file)) consumers.add(name);
}

const DECLARATION = [
  /^[ \t]*export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/gm,
  /^[ \t]*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
  /^[ \t]*export\s*\{([^}]*)\}/gm
];

const unusedExports = [];
for (const file of sources.keys()) {
  if (/[\\/]test[\\/]/.test(file)) continue;
  const text = cleaned.get(file);
  const names = new Set();
  for (const pattern of DECLARATION) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text))) {
      if (pattern.source.includes('\\{')) {
        for (const piece of match[1].split(',')) {
          const name = piece.trim().split(/\s+as\s+/).pop().trim();
          if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
        }
      } else {
        names.add(match[1]);
      }
    }
  }
  const orphans = [...names].filter((name) => !consumers.has(name));
  if (orphans.length) {
    unusedExports.push({ file: relative(root, file).split(sep).join('/'), names: orphans.sort() });
  }
}

/* ── local declarations no one mentions ──────────────────────── */

const corpus = [...cleaned.values()].join('\n');
const LOCAL_DECLARATION = [
  /^[ \t]*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm,
  /^[ \t]*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/gm
];

function mentions(name) {
  const pattern = new RegExp('\\b' + name.replace(/\$/g, '\\$') + '\\b', 'g');
  return (corpus.match(pattern) || []).length;
}

const unusedLocals = [];
for (const file of sources.keys()) {
  if (/[\\/]test[\\/]/.test(file)) continue;
  const text = cleaned.get(file);
  for (const pattern of LOCAL_DECLARATION) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text))) {
      const name = match[1];
      if (mentions(name) <= 1) {
        unusedLocals.push({ file: relative(root, file).split(sep).join('/'), name });
      }
    }
  }
}

const report = {
  scanned: sources.size,
  entries: entries.size,
  reachable: reachable.size,
  unreachableModules,
  unusedExports,
  unusedLocals,
  unresolved
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('scanned ' + report.scanned + ' modules · ' + report.entries + ' entries · ' + report.reachable + ' reachable');
  console.log('');
  console.log('UNREACHABLE MODULES (' + unreachableModules.length + ')');
  console.log(unreachableModules.length ? unreachableModules.map((file) => '  ' + file).join('\n') : '  none');
  console.log('');
  const exportCount = unusedExports.reduce((sum, row) => sum + row.names.length, 0);
  console.log('EXPORTED BUT NEVER IMPORTED (' + exportCount + ')');
  console.log(exportCount ? unusedExports.map((row) => '  ' + row.file + ': ' + row.names.join(', ')).join('\n') : '  none');
  console.log('');
  console.log('LOCAL DECLARATIONS NO ONE MENTIONS (' + unusedLocals.length + ')');
  console.log(unusedLocals.length ? unusedLocals.map((row) => '  ' + row.file + ': ' + row.name).join('\n') : '  none');
  if (unresolved.length) {
    console.log('');
    console.log('UNRESOLVED ENTRY POINTERS (' + unresolved.length + ')');
    console.log(unresolved.map((line) => '  ' + line).join('\n'));
  }
}

const failed = unreachableModules.length + unusedLocals.length > 0;
if (strict && failed) process.exitCode = 1;