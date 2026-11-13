import { GLOBAL_FLAGS, flagLabel } from './args.js';
import { commandUsage } from './command.js';

const ENVIRONMENT = [
  ['MDRIVE_SERVER', 'Server base URL; overrides the saved profile.'],
  ['MDRIVE_TOKEN', 'Bearer token; overrides the saved profile.'],
  ['MDRIVE_CONFIG_DIR', 'Configuration directory (default: %APPDATA%\\mdrive on Windows, ~/.config/mdrive elsewhere).'],
  ['MDRIVE_PASSWORD', 'Password used by "mdrive login" so it stays out of shell history.'],
  ['NO_COLOR', 'Any value disables ANSI colours, like --no-color.']
];

const EXIT_CODES = [
  ['0', 'Success.'],
  ['1', 'Runtime failure: network, server error, authentication, conflict, or missing node.'],
  ['2', 'Usage error: unknown command or option, missing argument, invalid value.']
];

function width(text) {
  let total = 0;
  for (const character of String(text)) {
    const code = character.codePointAt(0) ?? 0;
    total += (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) ? 2 : 1;
  }
  return total;
}

function pad(text, size) {
  const gap = size - width(text);
  return gap > 0 ? text + ' '.repeat(gap) : text;
}

function flagLines(flags) {
  if (flags.length === 0) return ['  (this command has no options of its own)'];
  const labels = flags.map(flag => flagLabel(flag));
  const size = Math.max(...labels.map(label => width(label))) + 2;
  return flags.map((flag, index) => '  ' + pad(labels[index], size) + flag.description);
}

/** Root help: command list grouped by category, global options, env, exit codes. */
export function rootHelp(commands, version) {
  const lines = [];
  lines.push('mdrive ' + version + ' - Marvelous Drive command line client');
  lines.push('');
  lines.push('Usage:');
  lines.push('  mdrive <command> [options]');
  lines.push('');
  const categories = [];
  for (const command of commands) {
    const category = command.category ?? 'Commands';
    if (!categories.includes(category)) categories.push(category);
  }
  const labels = commands.map(command => 'mdrive ' + command.name);
  const size = Math.max(...labels.map(label => width(label))) + 2;
  lines.push('Commands:');
  for (const category of categories) {
    lines.push('');
    lines.push('  ' + category);
    for (const command of commands) {
      if ((command.category ?? 'Commands') !== category) continue;
      lines.push('    ' + pad('mdrive ' + command.name, size) + command.summary);
    }
  }
  lines.push('');
  lines.push('Global options:');
  lines.push(...flagLines(GLOBAL_FLAGS));
  lines.push('');
  lines.push('Environment:');
  const envSize = Math.max(...ENVIRONMENT.map(item => item[0].length)) + 2;
  for (const [name, description] of ENVIRONMENT) lines.push('  ' + pad(name, envSize) + description);
  lines.push('');
  lines.push('Exit codes:');
  for (const [code, description] of EXIT_CODES) lines.push('  ' + pad(code, 4) + description);
  lines.push('');
  lines.push('Nodes are addressed by path ("/Projects/plan.md") or by uuid ("mdrive stat 8a1d...").');
  lines.push('Run "mdrive <command> --help" for options and examples.');
  lines.push('');
  return lines.join('\n');
}

/** Per-command help: usage, summary, positionals, options, examples. */
export function commandHelp(command) {
  const lines = [];
  lines.push('Usage: ' + commandUsage(command));
  lines.push('');
  lines.push(command.summary);
  if (command.details) {
    lines.push('');
    for (const paragraph of command.details.split('\n')) lines.push(paragraph);
  }
  if (command.positionals && command.positionals.length > 0) {
    lines.push('');
    lines.push('Arguments:');
    const size = Math.max(...command.positionals.map(item => item[0].length)) + 2;
    for (const [name, description, optional] of command.positionals) {
      lines.push('  ' + pad(name, size) + description + (optional ? ' (optional)' : ''));
    }
  }
  lines.push('');
  lines.push('Options:');
  lines.push(...flagLines([...(command.flags ?? []), ...GLOBAL_FLAGS]));
  const examples = command.examples ?? [];
  if (examples.length > 0) {
    lines.push('');
    lines.push('Examples:');
    for (const example of examples) lines.push('  ' + example);
  }
  lines.push('');
  return lines.join('\n');
}
