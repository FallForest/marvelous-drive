import { readFile } from 'node:fs/promises';
import { Flags, parseArgs, splitGlobals } from './args.js';
import { resolveCommand, subcommandHint, COMMANDS } from './commands/index.js';
import { configFile, loadConfig, maskToken, resolveTarget, saveConfig } from './config.js';
import { CliError, EXIT, messageOf } from './errors.js';
import { commandHelp, rootHelp } from './help.js';
import { ApiClient } from './http.js';
import { Output } from './output.js';

let cachedVersion;

/** Package version, used by --version and the help banner. */
export async function cliVersion() {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const raw = await readFile(new URL('../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw);
    cachedVersion = typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : '0.0.0';
  } catch {
    cachedVersion = '0.0.0';
  }
  return cachedVersion;
}

function optionString(flags, name) {
  const value = flags.str(name);
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Entry point used by bin/mdrive.mjs and the tests.
 *
 * @param {string[]} argv process.argv.slice(2)
 * @param {{stdout?: object, stderr?: object, env?: object, cwd?: string}} [io]
 * @returns {Promise<number>} process exit code: 0 ok, 1 error, 2 usage
 */
export async function main(argv, io = {}) {
  const version = await cliVersion();
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  let out;
  try {
    const { globals, rest } = splitGlobals(argv);
    out = new Output({
      json: globals.bool('json'),
      color: globals.bool('no-color') ? false : undefined,
      verbose: globals.count('verbose'),
      stdout,
      stderr
    });

    if (globals.bool('version')) {
      out.line('mdrive ' + version);
      return EXIT.OK;
    }

    const helpAlias = rest[0] === 'help';
    const tokens = helpAlias ? rest.slice(1) : rest;
    const helpRequested = globals.bool('help') || helpAlias;

    if (tokens.length === 0) {
      if (helpRequested) out.line(rootHelp(COMMANDS, version));
      else out.error('No command given. Run "mdrive --help" to list the commands.');
      return helpRequested ? EXIT.OK : EXIT.USAGE;
    }

    const resolved = resolveCommand(COMMANDS, tokens);
    if (!resolved) {
      const unknown = tokens.slice(0, 2).join(' ');
      const hint = subcommandHint(COMMANDS, tokens[0] ?? '');
      throw new CliError(
        'Unknown command: ' + unknown + '.' + (hint === '' ? ' Run "mdrive --help" for the command list.' : ' ' + hint),
        EXIT.USAGE,
        { code: 'USAGE' }
      );
    }
    const command = resolved.command;
    if (helpRequested) {
      out.line(commandHelp(command));
      return EXIT.OK;
    }

    const flags = new Flags(parseArgs(resolved.rest, command.flags ?? [], command.name));
    const config = await loadConfig();
    const target = resolveTarget(config, {
      server: optionString(globals, 'server'),
      token: optionString(globals, 'token')
    });

    let client;
    const api = () => {
      if (client) return client;
      client = new ApiClient({ server: target.server, token: target.token });
      return client;
    };

    const ctx = {
      out,
      flags,
      positional: flags.positional,
      commandName: command.name,
      version,
      config,
      configFile: configFile(),
      profileKey: target.key,
      server: target.server,
      token: target.token,
      tokenHint: maskToken(target.token),
      tokenSource: target.source.token,
      api,
      saveConfig
    };
    out.note('server ' + target.server + ' · token ' + target.source.token + ' · profile ' + target.key);
    const code = await command.handler(ctx);
    return typeof code === 'number' ? code : EXIT.OK;
  } catch (error) {
    const cliError = error instanceof CliError ? error : new CliError(messageOf(error), EXIT.ERROR);
    if (out) out.error(cliError.message);
    else stderr.write('mdrive: ' + cliError.message + '\n');
    return cliError.exitCode === undefined ? EXIT.ERROR : cliError.exitCode;
  }
}
