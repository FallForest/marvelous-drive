/**
 * Command definition shared by every subcommand module.
 *
 * @typedef {object} CommandDefinition
 * @property {string} name        command path, for example "docs pull"
 * @property {string} summary     one line shown in the command list
 * @property {string} usage       usage line without the leading "mdrive "
 * @property {string} [details]   extra prose below the usage line
 * @property {string} [category]  group heading in --help
 * @property {object[]} [flags]   command specific flags (see args.js)
 * @property {Array<[string, string, boolean?]>} [positionals] [name, description, optional]
 * @property {string[]} [examples]
 * @property {(ctx: object) => Promise<number|void>} handler
 */

export function commandUsage(command) {
  return 'mdrive ' + command.usage;
}

/**
 * Resolves the longest matching command path, so "docs pull" wins over "docs".
 *
 * @param {CommandDefinition[]} commands
 * @param {string[]} tokens
 */
export function resolveCommand(commands, tokens) {
  for (const length of [2, 1]) {
    if (tokens.length < length) continue;
    const name = tokens.slice(0, length).join(' ');
    const command = commands.find(candidate => candidate.name === name);
    if (command) return { command, rest: tokens.slice(length) };
  }
  return undefined;
}

/** Hint listing subcommands when the user typed a bare command group. */
export function subcommandHint(commands, first) {
  const subs = commands
    .filter(command => command.name.startsWith(first + ' '))
    .map(command => command.name.slice(first.length + 1));
  if (subs.length === 0) return '';
  return 'Did you mean "mdrive ' + first + ' <' + subs.join('|') + '>"?';
}
