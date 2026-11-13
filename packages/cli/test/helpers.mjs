import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMAIL, PASSWORD, startMockServer, TOKEN } from './mock-server.mjs';

export const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mdrive.mjs');

const MANAGED = ['MDRIVE_SERVER', 'MDRIVE_TOKEN', 'MDRIVE_CONFIG_DIR', 'MDRIVE_PASSWORD', 'MDRIVE_DOCS_PASSWORD'];

/**
 * Runs the real bin with a clean environment: inherited MDRIVE_* values are
 * removed so the test controls every input.
 */
export function runCli(args, options = {}) {
  const env = { ...process.env };
  for (const key of MANAGED) delete env[key];
  if (options.configDir !== undefined) env.MDRIVE_CONFIG_DIR = options.configDir;
  if (options.server !== undefined) env.MDRIVE_SERVER = options.server;
  if (options.token !== undefined) env.MDRIVE_TOKEN = options.token;
  Object.assign(env, options.env ?? {});
  env.NO_COLOR = '1';
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env,
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ status: null, stdout, stderr: stderr + '\n[timed out after 60s]' });
    }, 60000);
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr: stderr + '\n' + error.message });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
  });
}

export function parseJson(result) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error('expected JSON on stdout, received:\n' + result.stdout + '\n' + error.message);
  }
}

/** Fresh mock server + isolated config directory for one test. */
export async function createHarness(t, options = {}) {
  const server = await startMockServer(options);
  const configDir = await mkdtemp(join(tmpdir(), 'mdrive-cli-'));
  t.after(async () => {
    await server.close();
    await rm(configDir, { recursive: true, force: true });
  });
  const harness = {
    server,
    configDir,
    configPath: join(configDir, 'config.json'),
    workDir: configDir,
    run: (args, extra = {}) => runCli(args, { configDir, server: server.url, token: TOKEN, ...extra }),
    anonymous: (args, extra = {}) => runCli(args, { configDir, server: server.url, ...extra }),
    /** Signs in first so later commands use the stored profile only. */
    async login() {
      return runCli(['login', '--email', EMAIL, '--password', PASSWORD], { configDir, server: server.url, env: { MDRIVE_PASSWORD: PASSWORD } });
    },
    runProfile: (args, extra = {}) => runCli(args, { configDir, ...extra })
  };
  return harness;
}
