import { usageError } from './errors.js';

/**
 * Flag definitions.
 *
 *   name          long name without the dashes, for example "chunk-size"
 *   value         placeholder shown in help, for example "BYTES"
 *   kind          "string" (default) | "boolean" | "count"
 *   short         single character alias, for example "v"
 *   repeatable    collect every occurrence into an array
 *   description   one line shown in --help
 */
export const GLOBAL_FLAGS = [
  { name: 'server', value: 'URL', description: 'Server base URL; overrides the saved profile and MDRIVE_SERVER.' },
  { name: 'token', value: 'TOKEN', description: 'Bearer token; overrides the saved profile and MDRIVE_TOKEN.' },
  { name: 'json', kind: 'boolean', description: 'Print a machine-readable JSON document instead of tables.' },
  { name: 'no-color', kind: 'boolean', description: 'Disable ANSI colours even when stdout is a TTY.' },
  { name: 'verbose', kind: 'count', short: 'v', description: 'Raise the diagnostic level; repeat for more detail (-vv).' },
  { name: 'help', kind: 'boolean', short: 'h', description: 'Print help for the CLI or one command and exit.' },
  { name: 'version', kind: 'boolean', short: 'V', description: 'Print the CLI version and exit.' }
];

const GLOBAL_NAMES = new Set(GLOBAL_FLAGS.map(flag => flag.name));
const GLOBAL_SHORTS = new Map(GLOBAL_FLAGS.filter(flag => flag.short).map(flag => [flag.short, flag.name]));

export function flagKind(definition) {
  return definition.kind ?? 'string';
}

/** Renders "--name VALUE" / "--name" for help output. */
export function flagLabel(definition) {
  if (flagKind(definition) !== 'string') return '--' + definition.name;
  return '--' + definition.name + ' ' + (definition.value ?? 'VALUE');
}

function looksLikeOption(token) {
  return typeof token === 'string' && token.length > 1 && token.startsWith('-') && !/^-\d+(\.\d+)?$/.test(token);
}

function isLongOption(token) {
  return token.startsWith('--') && token.length > 2;
}

function longParts(token) {
  const equals = token.indexOf('=');
  return equals < 0
    ? { name: token.slice(2), inline: null }
    : { name: token.slice(2, equals), inline: token.slice(equals + 1) };
}

function parseBoolean(text, name) {
  const raw = text.trim().toLowerCase();
  if (raw === '' || raw === 'true' || raw === 'yes' || raw === '1') return true;
  if (raw === 'false' || raw === 'no' || raw === '0') return false;
  throw usageError('Option --' + name + ' takes true or false, received "' + text + '".');
}

/**
 * Parses command tokens.
 *
 *   --flag=value        inline value
 *   --flag value        value taken from the next token
 *   --flag / --flag=false boolean flags
 *   -v -v / -vv         counted short flags
 *   --                  everything after it is positional
 */
export function parseArgs(tokens, definitions, commandName = '') {
  const known = new Map(definitions.map(definition => [definition.name, definition]));
  const shorts = new Map();
  for (const definition of definitions) {
    if (definition.short) shorts.set(definition.short, definition);
  }
  const values = new Map();
  const positional = [];
  const where = commandName === '' ? 'mdrive' : 'mdrive ' + commandName;

  const assign = (definition, value) => {
    if (definition.repeatable) {
      const current = values.get(definition.name);
      if (Array.isArray(current)) current.push(value);
      else values.set(definition.name, [value]);
      return;
    }
    const kind = flagKind(definition);
    // Switches and counters are idempotent / additive; repeated string flags
    // are almost always a mistake, so they stay an error.
    if (kind !== 'string') {
      values.set(definition.name, value);
      return;
    }
    if (values.has(definition.name)) {
      throw usageError('Option --' + definition.name + ' was given more than once.');
    }
    values.set(definition.name, value);
  };

  const consumeValue = (definition, inline, index) => {
    if (inline !== null) {
      if (inline === '') throw usageError('Option --' + definition.name + ' needs a value.');
      return { value: inline, next: index };
    }
    const next = tokens[index + 1];
    if (next === undefined || looksLikeOption(next)) {
      throw usageError('Option --' + definition.name + ' needs a value.');
    }
    return { value: next, next: index + 1 };
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--') {
      positional.push(...tokens.slice(index + 1));
      break;
    }
    if (isLongOption(token)) {
      const { name, inline } = longParts(token);
      const definition = known.get(name);
      if (!definition) {
        throw usageError('Unknown option --' + name + ' for "' + where + '". Run "' + where + ' --help" to list the supported options.');
      }
      const kind = flagKind(definition);
      if (kind === 'boolean') {
        assign(definition, inline === null ? true : parseBoolean(inline, name));
        continue;
      }
      if (kind === 'count') {
        if (inline !== null) throw usageError('Option --' + name + ' is a switch and takes no value.');
        assign(definition, (values.get(name) ?? 0) + 1);
        continue;
      }
      const consumed = consumeValue(definition, inline, index);
      assign(definition, consumed.value);
      index = consumed.next;
      continue;
    }
    if (token.length > 1 && token.startsWith('-') && !/^-\d/.test(token)) {
      for (let offset = 1; offset < token.length; offset += 1) {
        const character = token[offset];
        const definition = shorts.get(character);
        if (!definition) {
          throw usageError('Unknown option -' + character + ' for "' + where + '". Run "' + where + ' --help" to list the supported options.');
        }
        const kind = flagKind(definition);
        if (kind === 'boolean') {
          assign(definition, true);
          continue;
        }
        if (kind === 'count') {
          assign(definition, (values.get(definition.name) ?? 0) + 1);
          continue;
        }
        const remainder = token.slice(offset + 1);
        const consumed = consumeValue(definition, remainder === '' ? null : remainder, index);
        assign(definition, consumed.value);
        index = consumed.next;
        break;
      }
      continue;
    }
    positional.push(token);
  }
  return { positional, values };
}

export class Flags {
  constructor(parsed) {
    this.positional = parsed.positional;
    this.values = parsed.values;
  }

  has(name) {
    return this.values.has(name);
  }

  bool(name) {
    return this.values.get(name) === true;
  }

  count(name) {
    const value = this.values.get(name);
    return typeof value === 'number' ? value : 0;
  }

  str(name) {
    const value = this.values.get(name);
    return typeof value === 'string' ? value : undefined;
  }

  list(name) {
    const value = this.values.get(name);
    if (Array.isArray(value)) return value;
    return typeof value === 'string' ? [value] : [];
  }

  required(name) {
    const value = this.str(name);
    if (value === undefined || value === '') {
      throw usageError('Missing required option --' + name + '.');
    }
    return value;
  }

  integer(name, options = {}) {
    const raw = this.str(name);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) {
      throw usageError('Option --' + name + ' must be an integer, received "' + raw + '".');
    }
    if (options.min !== undefined && value < options.min) {
      throw usageError('Option --' + name + ' must be at least ' + options.min + '.');
    }
    if (options.max !== undefined && value > options.max) {
      throw usageError('Option --' + name + ' must be at most ' + options.max + '.');
    }
    return value;
  }

  choice(name, allowed) {
    const raw = this.str(name);
    if (raw === undefined) return undefined;
    if (!allowed.includes(raw)) {
      throw usageError('Option --' + name + ' must be one of: ' + allowed.join(', ') + '.');
    }
    return raw;
  }
}

/**
 * Lifts global options out of the token stream so they work before or after the
 * command name: "mdrive --json ls" and "mdrive ls --json" behave the same.
 */
export function splitGlobals(tokens) {
  const collected = [];
  const rest = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--') {
      rest.push(...tokens.slice(index));
      break;
    }
    if (isLongOption(token)) {
      const { name, inline } = longParts(token);
      if (!GLOBAL_NAMES.has(name)) {
        rest.push(token);
        continue;
      }
      const definition = GLOBAL_FLAGS.find(flag => flag.name === name);
      collected.push(token);
      if (flagKind(definition) === 'string' && inline === null) {
        const next = tokens[index + 1];
        if (next !== undefined && !looksLikeOption(next)) {
          collected.push(next);
          index += 1;
        }
      }
      continue;
    }
    if (/^-[A-Za-z]+$/.test(token) && token.length > 1) {
      const characters = token.slice(1).split('');
      if (characters.every(character => GLOBAL_SHORTS.has(character))) {
        for (const character of characters) collected.push('--' + GLOBAL_SHORTS.get(character));
        continue;
      }
    }
    rest.push(token);
  }
  return { globals: new Flags(parseArgs(collected, GLOBAL_FLAGS)), rest };
}
