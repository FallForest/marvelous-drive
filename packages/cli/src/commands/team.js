import { CliError, EXIT } from '../errors.js';
import { formatBytes, formatRelative } from '../output.js';
import { requirePositional } from './support.js';

/**
 * Workspace membership from the terminal.
 *
 * The web client has a team panel; a script needs the same three operations.
 * There is no mail delivery in this product, so `team add` takes an e-mail of an
 * account that already exists — the server answers 404 otherwise.
 */

const MEMBERS = '/workspace/members';
const WORKSPACES = '/workspaces';

async function members(client) {
  const payload = await client.get(MEMBERS);
  const workspace = payload?.workspace ?? {};
  const list = Array.isArray(payload?.members) ? payload.members : [];
  return { workspace, members: list };
}

export const teamCommand = {
  name: 'team',
  category: 'Sharing',
  summary: 'List the accounts that share this drive.',
  usage: 'team [--all]',
  details:
    [
      'Every account owns a workspace. Members see the whole tree of the workspace',
      'they belong to; files they create stay in their own drive unless they write',
      'into a folder that belongs to the workspace.'
    ].join('\n'),
  flags: [{ name: 'all', kind: 'boolean', description: 'List every workspace you belong to.' }],
  examples: ['mdrive team', 'mdrive team --all', 'mdrive team --json'],
  async handler(ctx) {
    const client = ctx.api();
    if (ctx.flags.bool('all')) {
      const payload = await client.get(WORKSPACES);
      const list = Array.isArray(payload?.workspaces) ? payload.workspaces : [];
      if (ctx.out.data({ ok: true, command: 'team', workspaces: list })) return 0;
      ctx.out.table(
        [
          { header: '', max: 2 },
          { header: 'role', max: 8 },
          { header: 'files', align: 'right', max: 6 },
          { header: 'size', align: 'right', max: 10 },
          { header: 'id', max: 36 },
          { header: 'name' }
        ],
        list.map((entry) => [
          entry.active ? '*' : '',
          entry.role,
          String(entry.files ?? 0),
          formatBytes(entry.bytes ?? 0),
          entry.id,
          entry.name
        ]),
        'No workspaces.'
      );
      ctx.out.note('* is the active workspace; the id is what --workspace expects.');
      return 0;
    }
    const { workspace, members: list } = await members(client);
    if (ctx.out.data({ ok: true, command: 'team', workspace, members: list })) return 0;
    ctx.out.fields([
      ['workspace', workspace.name ?? '-'],
      // The id is what `ls --workspace` / `tree --workspace` need, so it is not
      // hidden behind --json.
      ['id', workspace.id ?? '-'],
      ['your role', workspace.role ?? '-'],
      ['members', String(list.length)]
    ]);
    ctx.out.table(
      [
        { header: 'role', max: 10 },
        { header: 'joined', align: 'right', max: 12 },
        { header: 'email' },
        { header: 'name' }
      ],
      list.map((member) => [
        member.id === workspace.ownerId ? 'owner' : (member.role || 'member'),
        member.joinedAt ? formatRelative(member.joinedAt) : '-',
        member.email,
        member.name ?? '-'
      ]),
      'No members.'
    );
    return 0;
  }
};

export const teamAddCommand = {
  name: 'team add',
  category: 'Sharing',
  summary: 'Add an existing account to your workspace.',
  usage: 'team add EMAIL [--role admin|member]',
  details:
    [
      'The account must already exist: this product has no mail delivery, so an',
      'invite is immediate membership. Only a workspace admin can add members.'
    ].join('\n'),
  flags: [{ name: 'role', value: 'ROLE', description: 'admin or member (default member).' }],
  positionals: [['EMAIL', 'E-mail of an existing account.']],
  examples: ['mdrive team add ada@example.com', 'mdrive team add bob@example.com --role admin'],
  async handler(ctx) {
    const email = requirePositional(ctx, 0, 'EMAIL');
    const role = ctx.flags.choice('role', ['admin', 'member']);
    const client = ctx.api();
    const body = { email };
    if (role !== undefined) body.role = role;
    const payload = await client.post(MEMBERS, body);
    const list = Array.isArray(payload?.members) ? payload.members : [];
    if (ctx.out.data({ ok: true, command: 'team add', email, members: list })) return 0;
    ctx.out.success('Added ' + email + ' to this workspace (' + list.length + ' members).');
    return 0;
  }
};

export const teamRemoveCommand = {
  name: 'team remove',
  category: 'Sharing',
  summary: 'Remove an account from your workspace.',
  usage: 'team remove EMAIL',
  details:
    [
      'The removed account keeps its own files; it simply loses access to this',
      'workspace. The workspace owner cannot be removed.'
    ].join('\n'),
  positionals: [['EMAIL', 'E-mail of the member to remove.']],
  examples: ['mdrive team remove bob@example.com'],
  async handler(ctx) {
    const email = requirePositional(ctx, 0, 'EMAIL').toLowerCase();
    const client = ctx.api();
    const { workspace, members: list } = await members(client);
    const member = list.find((candidate) => String(candidate.email).toLowerCase() === email);
    if (!member) {
      throw new CliError('No member with the e-mail ' + email + '. Run "mdrive team" to list them.', EXIT.ERROR, { code: 'NOT_FOUND', status: 404 });
    }
    if (member.id === workspace.ownerId) {
      throw new CliError('The workspace owner cannot be removed.', EXIT.ERROR, { code: 'INVALID_INPUT', status: 400 });
    }
    await client.del(MEMBERS + '/' + encodeURIComponent(member.id));
    if (ctx.out.data({ ok: true, command: 'team remove', email })) return 0;
    ctx.out.success('Removed ' + email + ' from this workspace.');
    return 0;
  }
};