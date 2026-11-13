import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

/**
 * A guard for the storage seam.
 *
 * The whole point of `storage-backend.js` is that no route assumes a blob is a
 * local file. Two things break that promise silently: calling `blobPath()` (it
 * exists, but only for the local backend's assembly helpers) and importing
 * `node:fs` to open a blob directly. Both still work today, which is exactly why
 * they need a test: the failure would only appear once a second backend exists.
 */

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (entry.name.endsWith('.js')) out.push(path);
  }
  return out;
}

/**
 * Files allowed to know about paths: the backend itself, the store facade, and the
 * storage node — which *is* a local backend for someone else's coordinator, so a
 * path is exactly what it is supposed to compute.
 */
const MAY_USE_PATHS = new Set([
  'storage/backend.js', 'storage/blobs.js', 'ops/scrub.js', 'storage/node.js',
  // ops/* legitimately counts or repairs blobs, so it needs the layout too.
  'ops/retention.js',
]);

describe('storage seam', () => {
  it('no module outside the backend calls blobPath()', () => {
    const offenders = [];
    for (const file of sourceFiles(srcRoot)) {
      const rel = file.replace(srcRoot, '').replace(/\\/g, '/').replace(/^\//, '');
      const name = rel.split('/').pop();
      if (MAY_USE_PATHS.has(rel) || MAY_USE_PATHS.has(name)) continue;
      const text = readFileSync(file, 'utf8');
      if (/\bblobPath\s*\(/.test(text)) offenders.push(file.replace(srcRoot, 'src'));
    }
    assert.deepEqual(offenders, [], 'these modules still assume a local blob path');
  });

  it('routes stream blobs instead of piping a stored file', () => {
    const offenders = [];
    const routes = join(srcRoot, 'routes');
    for (const file of sourceFiles(routes)) {
      const text = readFileSync(file, 'utf8');
      // `uploads.js` legitimately reads its own temp chunk files while assembling
      // an upload — those are not blobs. What must never happen is a route opening
      // a stream on stored content.
      if (file.endsWith('uploads.js')) continue;
      if (/createReadStream\(/.test(text)) offenders.push(file.replace(srcRoot, 'src'));
    }
    assert.deepEqual(offenders, [], 'a route opened a file stream; use sendBlob()');
  });

  it('the backend exposes the whole interface a second tier would need', async () => {
    const { backend, LocalBackend, readBlobBuffer } = await import('../src/storage/backend.js');
    for (const method of ['put', 'get', 'stat', 'remove', 'link', 'path']) {
      assert.equal(typeof backend[method], 'function', 'backend.' + method + ' is missing');
    }
    assert.equal(backend.name, 'local');
    assert.equal(typeof LocalBackend, 'function');
    assert.equal(typeof readBlobBuffer, 'function');
  });
});
