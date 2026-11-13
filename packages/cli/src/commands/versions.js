import { CliError, EXIT, usageError } from '../errors.js';
import { formatBytes, formatRelative } from '../output.js';
import { resolveFileNode } from './files.js';

const FILES = '/files';

/** GET /files/:id/versions → { versions, currentVersion } */
async function listVersions(client, nodeId) {
  const payload = await client.get(FILES + '/' + encodeURIComponent(nodeId) + '/versions');
  return {
    versions: Array.isArray(payload?.versions) ? payload.versions : [],
    currentVersion: Number(payload?.currentVersion ?? 0)
  };
}

export const versionsCommand = {
  name: 'versions',
  category: 'Files',
  summary: 'List the stored versions of a file.',
  usage: 'versions FILE [--json]',
  details:
    'A version appears every time the file content is replaced (or restored). The ' +
    'current content is not a version: the list shows what the file used to be.',
  positionals: [['FILE', 'Path or uuid of the file.']],
  examples: ['mdrive versions /Projects/plan.md', 'mdrive versions 8a1d… --json'],
  async handler(ctx) {
    const target = ctx.positional[0];
    if (!target) throw usageError('versions needs a file: mdrive versions FILE');
    const client = ctx.api();
    const node = await resolveFileNode(client, target);
    const result = await listVersions(client, node.id);
    if (ctx.out.data({ ok: true, command: 'versions', file: { id: node.id, name: node.name, version: node.version }, ...result })) return 0;
    if (!result.versions.length) {
      ctx.out.line(node.name + ' has no stored versions yet (current v' + node.version + ').');
      return 0;
    }
    ctx.out.table(
      [
        { header: 'version', align: 'right', max: 8 },
        { header: 'size', align: 'right', max: 10 },
        { header: 'created', align: 'right', max: 12 },
        { header: 'id', max: 36 },
        { header: 'mime' }
      ],
      result.versions.map((entry) => [
        'v' + entry.version,
        formatBytes(entry.size),
        formatRelative(entry.createdAt),
        entry.id,
        entry.mime ?? '-'
      ]),
      'No stored versions.'
    );
    // A plain stdout line, not note(): note() is a verbose diagnostic and would
    // be invisible in a normal run, and this fact belongs with the table.
    ctx.out.line(ctx.out.paint('Current content is v' + result.currentVersion + '.', 'dim'));
    return 0;
  }
};

export const versionDownloadCommand = {
  name: 'version download',
  category: 'Files',
  summary: 'Download one stored version of a file (or restore it with "version restore").',
  usage: 'version download FILE VERSION_ID [--output PATH] [--force]',
  details:
    'The live file is never touched: only the selected version is downloaded. ' +
    'Use "mdrive version restore" to make it current again.',
  flags: [
    { name: 'output', value: 'PATH', description: 'Where to write the downloaded bytes.' },
    { name: 'force', kind: 'boolean', description: 'Overwrite the output file if it exists.' }
  ],
  positionals: [
    ['FILE', 'Path or uuid of the file.'],
    ['VERSION_ID', 'Version id from "mdrive versions".']
  ],
  examples: ['mdrive version download /notes.md 5f0e… --output notes-v1.md'],
  async handler(ctx) {
    const target = ctx.positional[0];
    const versionId = ctx.positional[1];
    if (!target || !versionId) throw usageError('version needs FILE and VERSION_ID');
    const output = ctx.flags.str('output');
    if (output === undefined) {
      throw usageError('version download needs --output PATH.');
    }
    const client = ctx.api();
    const node = await resolveFileNode(client, target);
    const { writeFile, access } = await import('node:fs/promises');
    if (!ctx.flags.bool('force')) {
      try {
        await access(output);
        throw new CliError(output + ' already exists; pass --force to overwrite.', EXIT.ERROR, { code: 'EXISTS' });
      } catch (error) {
        if (error instanceof CliError) throw error;
      }
    }
    const response = await client.download(
      FILES + '/' + encodeURIComponent(node.id) + '/versions/' + encodeURIComponent(versionId) + '/content?download=1',
      { destination: '-' }
    );
    await writeFile(output, response.data);
    if (ctx.out.data({ ok: true, command: 'version', path: output, bytes: response.data.length })) return 0;
    ctx.out.success('Wrote ' + response.data.length + ' bytes to ' + output + '.');
    return 0;
  }
};
export const versionRestoreCommand = {
  name: 'version restore',
  category: 'Files',
  summary: 'Make a stored version the current content.',
  usage: 'version restore FILE VERSION_ID',
  details:
    'The current content is saved as a new version first, so a restore can itself ' +
    'be undone. Fails with VERSION_CONFLICT if the file moved on since it was read.',
  positionals: [
    ['FILE', 'Path or uuid of the file.'],
    ['VERSION_ID', 'Version id from "mdrive versions".']
  ],
  examples: ['mdrive version restore /notes.md 5f0e…'],
  async handler(ctx) {
    const target = ctx.positional[0];
    const versionId = ctx.positional[1];
    if (!target || !versionId) throw usageError('version restore needs FILE and VERSION_ID');
    const client = ctx.api();
    const node = await resolveFileNode(client, target);
    const payload = await client.post(
      FILES + '/' + encodeURIComponent(node.id) + '/versions/' + encodeURIComponent(versionId) + '/restore',
      { expectedVersion: node.version }
    );
    const restored = payload?.node;
    if (ctx.out.data({ ok: true, command: 'version restore', restored })) return 0;
    ctx.out.success('Restored ' + node.name + ' to ' + versionId + ' (now v' + (restored?.version ?? '?') + ').');
    return 0;
  }
};