import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import { sha256Stream } from '../lib/sha256.js'
import { sha256 } from '../lib/upload.js'

describe('streaming SHA-256 for HTTP folder uploads', () => {
  it('matches the native implementation across padding and multi-chunk boundaries', async () => {
    for (const size of [0, 3, 55, 56, 63, 64, 65, 127, 128, 4 * 1024 * 1024 + 79]) {
      const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 31) % 256);
      assert.equal(await sha256Stream(new Blob([bytes])), createHash('sha256').update(bytes).digest('hex'), 'size ' + size);
    }
  });
  it('hashes ArrayBuffers including non-ASCII input', async () => {
    const bytes = new TextEncoder().encode('文件夹增量更新');
    assert.equal(await sha256Stream(bytes.buffer), createHash('sha256').update(bytes).digest('hex'));
  });
  it('still hashes local files when crypto.subtle is unavailable on an HTTP origin', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
    try {
      const file = new File(['HTTP folder bytes'], 'notes.txt');
      assert.equal(await sha256(file), createHash('sha256').update('HTTP folder bytes').digest('hex'));
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
      else delete globalThis.crypto;
    }
  });
});
