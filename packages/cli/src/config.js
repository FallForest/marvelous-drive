import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CliError, EXIT, messageOf } from './errors.js';

/**
 * Credential cache.
 *
 *   Windows: %APPDATA%\\mdrive\\config.json
 *   Other:   ~/.config/mdrive/config.json  (XDG_CONFIG_HOME respected)
 *   Always:  $MDRIVE_CONFIG_DIR/config.json
 *
 * Shape (version 1) — one profile per server origin so several drives can be
 * used side by side:
 *
 *   {
 *     "version": 1,
 *     "defaultProfile": "https://127.0.0.1:4400",
 *     "profiles": {
 *       "https://127.0.0.1:4400": { "server": "https://127.0.0.1:4400", "token": "...", "email": "..." }
 *     }
 *   }
 */
export const CONFIG_VERSION = 1;

export const DEFAULT_SERVER = 'http://127.0.0.1:4400';

function envValue(name) {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function configDirectory() {
  const override = envValue('MDRIVE_CONFIG_DIR');
  if (override !== undefined) return override;
  const xdg = envValue('XDG_CONFIG_HOME');
  if (xdg !== undefined) return join(xdg, 'mdrive');
  if (process.platform === 'win32') {
    const appData = envValue('APPDATA');
    if (appData !== undefined) return join(appData, 'mdrive');
  }
  return join(homedir(), '.config', 'mdrive');
}

export function configFile() {
  return join(configDirectory(), 'config.json');
}

/** Normalises a server URL into the identity used as the profile key. */
export function serverKey(serverUrl) {
  const raw = String(serverUrl ?? '').trim();
  if (raw === '') throw new CliError('Server URL is empty.', EXIT.USAGE, { code: 'USAGE' });
  let parsed;
  try {
    parsed = new URL(raw.includes('://') ? raw : 'http://' + raw);
  } catch {
    throw new CliError('Invalid server URL: ' + raw, EXIT.USAGE, { code: 'USAGE' });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CliError('Server URL must use http or https: ' + raw, EXIT.USAGE, { code: 'USAGE' });
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  return parsed.origin + path;
}

export function emptyConfig() {
  return { version: CONFIG_VERSION, defaultProfile: null, profiles: {} };
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanProfile(value) {
  const profile = {};
  if (!isRecord(value)) return profile;
  if (typeof value.server === 'string' && value.server.trim() !== '') profile.server = value.server.trim();
  if (typeof value.token === 'string' && value.token !== '') profile.token = value.token;
  if (typeof value.email === 'string' && value.email !== '') profile.email = value.email;
  if (typeof value.name === 'string' && value.name !== '') profile.name = value.name;
  return profile;
}

/** Accepts the documented shape and the legacy flat {server, token} file. */
export function normalizeConfig(raw) {
  if (!isRecord(raw)) {
    throw new CliError('Config file is not a JSON object: ' + configFile(), EXIT.USAGE, { code: 'USAGE' });
  }
  if (raw.version !== CONFIG_VERSION) {
    const profiles = {};
    const server = typeof raw.server === 'string' ? raw.server.trim() : '';
    const token = typeof raw.token === 'string' ? raw.token : '';
    let defaultProfile = null;
    if (server !== '' || token !== '') {
      const key = serverKey(server === '' ? DEFAULT_SERVER : server);
      profiles[key] = cleanProfile({ server: key, token });
      defaultProfile = key;
    }
    return { config: { version: CONFIG_VERSION, defaultProfile, profiles }, migrated: true };
  }
  const profiles = {};
  if (isRecord(raw.profiles)) {
    for (const [key, value] of Object.entries(raw.profiles)) {
      const trimmed = key.trim();
      if (trimmed === '') continue;
      profiles[trimmed] = cleanProfile(value);
    }
  }
  const defaultProfile = typeof raw.defaultProfile === 'string' && profiles[raw.defaultProfile]
    ? raw.defaultProfile
    : null;
  return { config: { version: CONFIG_VERSION, defaultProfile, profiles }, migrated: false };
}

export async function loadConfig() {
  const file = configFile();
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptyConfig();
    throw new CliError('Cannot read ' + file + ': ' + messageOf(error), EXIT.ERROR);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CliError(
      'Config file is not valid JSON: ' + file + '. Delete it and run "mdrive login" again.',
      EXIT.USAGE,
      { code: 'USAGE' }
    );
  }
  const { config, migrated } = normalizeConfig(raw);
  if (migrated) {
    try {
      await saveConfig(config);
    } catch {
      // A read-only config directory must not break read-only commands.
    }
  }
  return config;
}

/** Writes atomically (temp file + rename) with owner-only permissions. */
export async function saveConfig(config) {
  const directory = configDirectory();
  const file = configFile();
  const temporary = file + '.' + process.pid + '.tmp';
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, file);
    if (process.platform !== 'win32') {
      await chmod(directory, 0o700);
      await chmod(file, 0o600);
    }
  } catch (error) {
    throw new CliError('Cannot write ' + file + ': ' + messageOf(error), EXIT.ERROR);
  }
}

/* ── profile helpers ───────────────────────────────────────────────────── */

export function profileFor(config, key) {
  return config.profiles[key] ?? {};
}

export function upsertProfile(config, key, profile) {
  return {
    ...config,
    version: CONFIG_VERSION,
    defaultProfile: key,
    profiles: { ...config.profiles, [key]: cleanProfile(profile) }
  };
}

export function removeProfile(config, key) {
  const profiles = { ...config.profiles };
  delete profiles[key];
  const remaining = Object.keys(profiles);
  return {
    ...config,
    version: CONFIG_VERSION,
    defaultProfile: config.defaultProfile === key ? (remaining[0] ?? null) : config.defaultProfile,
    profiles
  };
}

/**
 * Resolves the effective connection settings.
 *
 * Precedence (highest first): explicit --server/--token, MDRIVE_SERVER/
 * MDRIVE_TOKEN, the saved profile for the requested server, the saved default
 * profile, and finally the documented local default.
 */
export function resolveTarget(config, options = {}) {
  const flagServer = options.server;
  const flagToken = options.token;
  const envServer = envValue('MDRIVE_SERVER');
  const envToken = envValue('MDRIVE_TOKEN');

  const savedKey = config.defaultProfile && config.profiles[config.defaultProfile]
    ? config.defaultProfile
    : Object.keys(config.profiles)[0] ?? null;
  const saved = savedKey === null ? {} : config.profiles[savedKey];

  const explicitServer = flagServer ?? envServer;
  let key;
  let profile;
  if (explicitServer !== undefined) {
    key = serverKey(explicitServer);
    profile = config.profiles[key] ?? {};
  } else if (savedKey !== null) {
    key = serverKey(saved.server ?? savedKey);
    profile = saved;
  } else {
    key = DEFAULT_SERVER;
    profile = {};
  }

  const server = explicitServer !== undefined ? serverKey(explicitServer) : (profile.server ?? key);
  const token = flagToken ?? envToken ?? profile.token;
  return {
    key,
    server,
    token,
    saved: savedKey,
    email: profile.email,
    source: {
      server: flagServer !== undefined ? 'flag' : envServer !== undefined ? 'env' : profile.server ? 'config' : 'default',
      token: flagToken !== undefined ? 'flag' : envToken !== undefined ? 'env' : profile.token ? 'config' : 'none'
    }
  };
}

export function maskToken(token) {
  if (typeof token !== 'string' || token === '') return '(none)';
  if (token.length <= 10) return token.slice(0, 2) + '***';
  return token.slice(0, 6) + '...' + token.slice(-4);
}
