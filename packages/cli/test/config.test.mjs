import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import {
  configDirectory,
  configFile,
  emptyConfig,
  loadConfig,
  maskToken,
  removeProfile,
  resolveTarget,
  saveConfig,
  serverKey,
  upsertProfile
} from '../src/config.js';

async function isolated(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mdrive-config-'));
  const previous = { dir: process.env.MDRIVE_CONFIG_DIR, server: process.env.MDRIVE_SERVER, token: process.env.MDRIVE_TOKEN };
  process.env.MDRIVE_CONFIG_DIR = dir;
  delete process.env.MDRIVE_SERVER;
  delete process.env.MDRIVE_TOKEN;
  t.after(async () => {
    for (const [key, value] of [['MDRIVE_CONFIG_DIR', previous.dir], ['MDRIVE_SERVER', previous.server], ['MDRIVE_TOKEN', previous.token]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('MDRIVE_CONFIG_DIR overrides the platform location', async t => {
  const dir = await isolated(t);
  assert.equal(configDirectory(), dir);
  assert.equal(configFile(), join(dir, 'config.json'));
});

test('the default location matches the contract', async t => {
  await isolated(t);
  delete process.env.MDRIVE_CONFIG_DIR;
  const directory = configDirectory();
  const posix = directory.split('\\').join('/');
  assert.ok(posix.endsWith('/mdrive'), 'config directory must end with mdrive: ' + posix);
  if (process.platform === 'win32' && process.env.APPDATA) {
    assert.equal(directory, join(process.env.APPDATA, 'mdrive'));
  } else {
    assert.ok(posix.endsWith('.config/mdrive'), 'unexpected location: ' + posix);
  }
});

test('config round-trips through disk', async t => {
  const dir = await isolated(t);
  const config = upsertProfile(emptyConfig(), 'http://127.0.0.1:4400', {
    server: 'http://127.0.0.1:4400',
    token: 'abc123',
    email: 'owner@example.com'
  });
  await saveConfig(config);
  const loaded = await loadConfig();
  assert.deepEqual(loaded, config);
  assert.equal(loaded.defaultProfile, 'http://127.0.0.1:4400');
  assert.equal(loaded.profiles['http://127.0.0.1:4400'].token, 'abc123');
  const raw = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
  assert.equal(raw.version, 1);
});

test('loadConfig returns an empty config when the file is missing', async t => {
  await isolated(t);
  assert.deepEqual(await loadConfig(), { version: 1, defaultProfile: null, profiles: {} });
});

test('a legacy flat config is migrated to profiles', async t => {
  const dir = await isolated(t);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'config.json'), JSON.stringify({ server: 'https://drive.example.com', token: 'legacy' }), 'utf8');
  const loaded = await loadConfig();
  assert.equal(loaded.version, 1);
  assert.equal(loaded.profiles['https://drive.example.com'].token, 'legacy');
  const rewritten = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
  assert.equal(rewritten.version, 1, 'the migrated file is written back');
});

test('profiles are keyed by normalised server URL', () => {
  assert.equal(serverKey('http://127.0.0.1:4400/'), 'http://127.0.0.1:4400');
  assert.equal(serverKey('https://h.example.com///'), 'https://h.example.com');
  assert.equal(serverKey('h.example.com'), 'http://h.example.com');
  assert.throws(() => serverKey('ftp://h.example.com'), /must use http or https/);
  assert.throws(() => serverKey(''), /empty/);
});

test('several servers live side by side', () => {
  let config = emptyConfig();
  config = upsertProfile(config, 'http://a:1', { server: 'http://a:1', token: 'ta' });
  config = upsertProfile(config, 'http://b:2', { server: 'http://b:2', token: 'tb' });
  assert.equal(Object.keys(config.profiles).length, 2);
  assert.equal(config.defaultProfile, 'http://b:2', 'the newest profile becomes the default');
  assert.deepEqual(resolveTarget(config).server, 'http://b:2');
  assert.deepEqual(resolveTarget(config).token, 'tb');
  const withoutB = removeProfile(config, 'http://b:2');
  assert.equal(withoutB.profiles['http://b:2'], undefined);
  assert.equal(withoutB.defaultProfile, 'http://a:1');
});

test('resolveTarget precedence is flag > env > profile > default', async t => {
  await isolated(t);
  let config = upsertProfile(emptyConfig(), 'http://saved:4400', { server: 'http://saved:4400', token: 'saved-token' });

  assert.equal(resolveTarget(config).server, 'http://saved:4400');
  assert.equal(resolveTarget(config).token, 'saved-token');
  assert.equal(resolveTarget(config).source.token, 'config');

  process.env.MDRIVE_TOKEN = 'env-token';
  assert.equal(resolveTarget(config).token, 'env-token');
  assert.equal(resolveTarget(config).source.token, 'env');

  assert.equal(resolveTarget(config, { token: 'flag-token' }).token, 'flag-token');
  assert.equal(resolveTarget(config, { token: 'flag-token' }).source.token, 'flag');

  delete process.env.MDRIVE_TOKEN;
  assert.equal(resolveTarget(config, { server: 'http://other:9' }).server, 'http://other:9');
  assert.equal(resolveTarget(config, { server: 'http://other:9' }).token, undefined, 'a token is never sent to a different server');
  assert.equal(resolveTarget(emptyConfig()).server, 'http://127.0.0.1:4400');
});

test('tokens are masked for display', () => {
  assert.equal(maskToken(undefined), '(none)');
  assert.equal(maskToken('short'), 'sh***');
  assert.equal(maskToken('abcdefghijklmnop'), 'abcdef...mnop');
});
