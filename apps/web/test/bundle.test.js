import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Static guarantees about the client bundle that a browser check would only
 * catch by accident: imports resolve, file names never become markup, and the
 * token never travels in a URL.
 */

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => readFileSync(join(webRoot, name), 'utf8');
const moduleFiles = () => [
  'app.js',
  ...readdirSync(join(webRoot, 'lib')).filter((name) => name.endsWith('.js')).map((name) => 'lib/' + name),
];

describe('bundle hygiene', () => {
  it('every relative import resolves to a real file', () => {
    const missing = [];
    for (const file of moduleFiles()) {
      for (const match of read(file).matchAll(/from ['"](\.{1,2}\/[^'"]+)['"]/g)) {
        const target = join(webRoot, dirname(file), match[1]);
        if (!existsSync(target)) missing.push(file + ' -> ' + match[1]);
      }
    }
    assert.deepEqual(missing, []);
  });

  it('never builds markup from a file name', () => {
    const risky = [];
    for (const file of ['lib/files.js', 'lib/share.js', 'lib/preview.js', 'lib/queue.js', 'lib/office-preview.js', 'lib/sidebar.js']) {
      for (const match of read(file).matchAll(/raw\(([^)]*)\)/g)) {
        const argument = match[1];
        if (/node\.name|page\.title|task\.name/.test(argument)) risky.push(file + ': raw(' + argument.trim() + ')');
      }
    }
    assert.deepEqual(risky, []);
  });

  it('ships no eval, Function constructor or inline handler', () => {
    const offenders = [];
    for (const file of moduleFiles()) {
      const source = read(file);
      if (/\beval\s*\(/.test(source)) offenders.push(file + ': eval');
      if (/new Function\s*\(/.test(source)) offenders.push(file + ': new Function');
      if (/\son(?:click|load|error)="/.test(source)) offenders.push(file + ': inline handler');
    }
    assert.deepEqual(offenders, []);
  });

  it('keeps the token out of the URL', () => {
    const api = read('lib/api.js');
    assert.ok(!/searchParams\.set\(['"]token/.test(api), 'token must not be a query parameter');
    assert.match(api, /headers\.set\('Authorization'/);
  });
});

describe('index.html', () => {
  it('loads the shell as a module with an absolute path', () => {
    const html = read('index.html');
    assert.match(html, /<script[^>]+type="module"[^>]+src="\/app.js"/);
    assert.match(html, /<div id="app"/);
  });

  it('declares the language and a dark colour scheme', () => {
    const html = read('index.html');
    assert.match(html, /lang="zh-CN"/);
    assert.match(html, /color-scheme" content="dark"/);
  });
});
