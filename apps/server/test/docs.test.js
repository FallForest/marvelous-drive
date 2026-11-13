import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Documentation drift.
 *
 * STRUCTURE.md is the map of this repository, and it went stale twice: it listed
 * files that no longer existed and omitted modules that did (quota.js,
 * retention.js, audit.js…). A map nobody can trust is worse than no map, so the
 * claims are checked here instead of by review.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const structure = readFileSync(join(root, 'docs', 'STRUCTURE.md'), 'utf8');

/** Every source file name in the repository, excluding dependencies and output. */
function repositoryFiles() {
  const names = new Set();
  const skip = new Set(['node_modules', 'data', '.tmp', 'dist', 'coverage', '.git']);
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else names.add(entry.name);
    }
  };
  for (const top of ['apps', 'packages', 'scripts']) walk(join(root, top));
  return names;
}

const files = repositoryFiles();

describe('STRUCTURE.md', () => {
  it('only claims files that exist', () => {
    const claimed = [...structure.matchAll(/^\s+([a-z0-9_.-]+\.(?:js|mjs|css|html))\s{2,}/gm)].map((match) => match[1]);
    const missing = [...new Set(claimed)].filter((name) => !files.has(name));
    assert.deepEqual(missing, [], 'the map lists files that do not exist');
  });

  it('mentions every module that carries real behaviour', () => {
    // A hand-picked list of files a reader would look for by name. Test files and
    // entry points are covered by the case above or are self-evident.
    const important = ['blobs.js', 'nodes.js', 'versions.js', 'zip.js', 'zip-read.js', 'retention.js', 'scrub.js', 'audit.js', 'quota.js', 'rate-limit.js', 'router.js', 'security.js', 'admin.js']
    const unmentioned = important.filter((name) => !structure.includes(name));
    assert.deepEqual(unmentioned, [], 'these modules exist but the map does not name them');
  });
});

describe('docs/', () => {
  it('every path referenced by the docs exists', () => {
    // The list is read from the directory, not hard-coded: a hand-maintained list
    // is how this test failed once already (it kept asserting a deleted file).
    const docs = readdirSync(join(root, 'docs')).filter((name) => name.endsWith('.md'));
    assert.ok(docs.length >= 5, 'docs/ should hold the reference set, found ' + docs.length);
    const broken = [];
    for (const name of docs) {
      const text = readFileSync(join(root, 'docs', name), 'utf8');
      // Globs (`apps/web/lib/*.js`) are patterns, not paths: they are skipped by
      // requiring at least one concrete path segment after the directory.
      for (const match of text.matchAll(/`((?:apps|packages|scripts|docs)\/[^`\s*]+\.(?:js|mjs|md|json))`/g)) {
        if (!existsSync(join(root, match[1]))) broken.push(name + ' -> ' + match[1]);
      }
    }
    assert.deepEqual(broken, []);
  });

  it('the documentation map names files that actually exist', () => {
    // STRUCTURE.md is the index of docs/; a row pointing at a retired file sends
    // the reader to a 404, which is exactly what happened when the Docs-bridge
    // document was removed.
    const structure = readFileSync(join(root, 'docs', 'STRUCTURE.md'), 'utf8');
    const referenced = [...structure.matchAll(/`([A-Z-]+\.md)`/g)].map((match) => match[1]);
    const missing = [...new Set(referenced)].filter((name) => !existsSync(join(root, 'docs', name)));
    assert.deepEqual(missing, [], 'STRUCTURE.md points at documentation that is gone');
  });

  it('README commands reference scripts that exist', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const missing = [...readme.matchAll(/node (scripts\/[a-z-]+\.mjs)/g)]
      .map((match) => match[1])
      .filter((path) => !existsSync(join(root, path)));
    assert.deepEqual([...new Set(missing)], []);
  });
});