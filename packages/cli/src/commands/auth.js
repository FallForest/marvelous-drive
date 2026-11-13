import { createInterface } from 'node:readline';
import { CliError, EXIT, usageError } from '../errors.js';
import { removeProfile, serverKey, upsertProfile } from '../config.js';
import { ApiClient } from '../http.js';
import { formatTimestamp } from '../output.js';

/** Reads a password without echoing it when stdin is a TTY. */
export function readPassword(promptText) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stderr;
    if (!stdin.isTTY) {
      const rl = createInterface({ input: stdin, terminal: false });
      let collected = '';
      rl.on('line', line => { collected += line; });
      rl.on('close', () => resolve(collected.trim()));
      rl.on('error', reject);
      return;
    }
    stdout.write(promptText);
    const rl = createInterface({ input: stdin, output: stdout, terminal: true });
    rl._writeToOutput = () => {};
    rl.question('', answer => {
      stdout.write('\n');
      rl.close();
      resolve(answer);
    });
    rl.on('close', () => resolve(''));
    rl.on('error', reject);
  });
}

async function resolvePassword(ctx) {
  const flag = ctx.flags.str('password');
  if (flag !== undefined) return flag;
  const env = process.env.MDRIVE_PASSWORD;
  if (env !== undefined && env !== '') return env;
  if (!process.stdin.isTTY) {
    throw usageError('login needs a password: pass --password, set MDRIVE_PASSWORD, or pipe it on stdin.');
  }
  const entered = await readPassword('Password: ');
  if (entered === '') throw usageError('login needs a non-empty password.');
  return entered;
}

export const loginCommand = {
  name: 'login',
  category: 'Account',
  summary: 'Sign in and cache the token in the profile for this server.',
  usage: 'login [--email EMAIL] [--password PASSWORD] [--server URL]',
  details:
    'Without --server the value from MDRIVE_SERVER is used, then the last saved profile.\n' +
    'Prefer MDRIVE_PASSWORD over --password so the secret stays out of shell history.',
  flags: [
    { name: 'email', value: 'EMAIL', description: 'Account email address.' },
    { name: 'password', value: 'PASSWORD', description: 'Account password (or use MDRIVE_PASSWORD).' }
  ],
  examples: [
    'mdrive login --server http://127.0.0.1:4400 --email you@example.com',
    'MDRIVE_PASSWORD=secret mdrive login --server https://drive.example.com --email you@example.com',
    'mdrive login --server http://127.0.0.1:4400 --token "$TOKEN"'
  ],
  async handler(ctx) {
    if (ctx.server === undefined) {
      throw usageError('login needs a server: pass --server URL or set MDRIVE_SERVER.');
    }
    const key = serverKey(ctx.server);
    const client = new ApiClient({ server: key });
    let token;
    let user = null;
    if (ctx.flags.str('token') ?? ctx.globalToken) {
      token = ctx.flags.str('token') ?? ctx.globalToken;
      const me = await new ApiClient({ server: key, token }).get('/me');
      user = me?.user ?? null;
    } else {
      const email = ctx.flags.required('email');
      const password = await resolvePassword(ctx);
      const response = await client.post('/auth/login', { email, password });
      if (typeof response?.token !== 'string' || response.token === '') {
        throw new CliError('The server did not return an access token.', EXIT.ERROR, { code: 'PROTOCOL' });
      }
      token = response.token;
      user = response.user ?? null;
    }
    const config = upsertProfile(ctx.config, key, {
      ...ctx.config.profiles[key],
      server: key,
      token,
      email: user?.email,
      name: user?.name
    });
    await ctx.saveConfig(config);
    if (ctx.out.data({ ok: true, command: 'login', server: key, profile: key, user })) return 0;
    const who = user ? user.name + ' <' + user.email + '>' : 'the supplied token';
    ctx.out.success('Signed in as ' + who + ' on ' + key);
    ctx.out.line('Profile "' + key + '" saved to ' + ctx.configFile + '.');
    return 0;
  }
};

export const logoutCommand = {
  name: 'logout',
  category: 'Account',
  summary: 'Forget the cached token for the current server.',
  usage: 'logout [--server URL] [--all]',
  flags: [
    { name: 'all', kind: 'boolean', description: 'Remove every saved profile, not only the current one.' }
  ],
  examples: ['mdrive logout', 'mdrive logout --all'],
  async handler(ctx) {
    const key = serverKey(ctx.server ?? ctx.profileKey);
    if (ctx.flags.bool('all')) {
      await ctx.saveConfig({ version: 1, defaultProfile: null, profiles: {} });
      if (ctx.out.data({ ok: true, command: 'logout', removed: Object.keys(ctx.config.profiles) })) return 0;
      ctx.out.success('Removed every saved profile from ' + ctx.configFile + '.');
      return 0;
    }
    if (ctx.config.profiles[key] === undefined) {
      if (ctx.out.data({ ok: true, command: 'logout', removed: [] })) return 0;
      ctx.out.line('No saved credentials for ' + key + '.');
      return 0;
    }
    await ctx.saveConfig(removeProfile(ctx.config, key));
    if (ctx.out.data({ ok: true, command: 'logout', removed: [key] })) return 0;
    ctx.out.success('Signed out of ' + key + '.');
    return 0;
  }
};

export const whoamiCommand = {
  name: 'whoami',
  category: 'Account',
  summary: 'Show the signed-in user, the active server, and the token source.',
  usage: 'whoami',
  examples: ['mdrive whoami', 'mdrive whoami --json'],
  async handler(ctx) {
    const response = await ctx.api().get('/me');
    const user = response?.user ?? null;
    if (ctx.out.data({ ok: true, command: 'whoami', server: ctx.server, profile: ctx.profileKey, user })) return 0;
    if (!user) {
      ctx.out.warn('The server returned no user for this token.');
      return 0;
    }
    ctx.out.fields([
      ['id', user.id],
      ['email', user.email],
      ['name', user.name],
      ['role', user.role],
      ['created', formatTimestamp(user.createdAt)],
      ['server', ctx.server],
      ['profile', ctx.profileKey],
      ['token', ctx.tokenHint + ' (' + ctx.tokenSource + ')']
    ]);
    return 0;
  }
};
