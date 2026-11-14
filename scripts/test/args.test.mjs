import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { flagReader } from '../lib/args.mjs';

/**
 * The operation scripts share one flag reader, so its contract is worth pinning:
 * a missing value must fall back rather than swallow the next switch, which is
 * exactly the bug the five hand-written copies were free to introduce.
 */

describe('flagReader', () => {
  it('reads a "--name value" pair', () => {
    const flag = flagReader(['--port', '4401']);
    assert.equal(flag('port', 4400), '4401');
  });

  it('falls back when the flag is absent', () => {
    const flag = flagReader(['--other', 'x']);
    assert.equal(flag('port', 4400), 4400);
  });

  it('falls back instead of eating the next flag', () => {
    const flag = flagReader(['--port', '--bucket', 'drive']);
    assert.equal(flag('port', 4400), 4400);
    assert.equal(flag('bucket', 'none'), 'drive');
  });

  it('falls back when the flag is last', () => {
    const flag = flagReader(['--port']);
    assert.equal(flag('port', 4400), 4400);
  });

  it('keeps a value that starts with a single dash', () => {
    const flag = flagReader(['--server', '-http://example']);
    assert.equal(flag('server', ''), '-http://example');
  });
});
