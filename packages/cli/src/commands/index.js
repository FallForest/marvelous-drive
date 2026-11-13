import { loginCommand, logoutCommand, whoamiCommand } from './auth.js';
import {
  catCommand,
  downloadCommand,
  uploadCommand
} from './files.js';
import {
  cpCommand,
  lsCommand,
  mkdirCommand,
  mvCommand,
  purgeCommand,
  restoreCommand,
  rmCommand,
  starCommand,
  statCommand,
  treeCommand
} from './nodes.js';
import { versionDownloadCommand, versionRestoreCommand, versionsCommand } from './versions.js';
import { searchCommand } from './search.js';
import { syncCommand } from './sync.js';
import { revokeCommand, shareCommand, shareListCommand } from './share.js';
import { indexCommand } from './index-cmd.js';
import {
  clusterReplicateCommand, clusterStatusCommand, nodeAddCommand, nodeCommand,
  nodeRemoveCommand, nodeUpdateCommand,
} from './node.js';
import { verifyCommand } from './verify.js';
import { tiersCommand } from './tiers.js';
import { teamAddCommand, teamCommand, teamRemoveCommand } from './team.js';
import { statsCommand, versionCommand } from './misc.js';

/**
 * Ordered command table. The order drives the grouping in "mdrive --help", so
 * keep related commands next to each other.
 */
export const COMMANDS = [
  loginCommand,
  logoutCommand,
  whoamiCommand,
  lsCommand,
  treeCommand,
  statCommand,
  mkdirCommand,
  mvCommand,
  cpCommand,
  rmCommand,
  restoreCommand,
  purgeCommand,
  starCommand,
  uploadCommand,
  downloadCommand,
  catCommand,
  versionsCommand,
  versionDownloadCommand,
  versionRestoreCommand,
  searchCommand,
  syncCommand,
  indexCommand,
  verifyCommand,
  tiersCommand,
  statsCommand,
  teamCommand,
  teamAddCommand,
  teamRemoveCommand,
  shareCommand,
  shareListCommand,
  revokeCommand,
  nodeCommand,
  nodeAddCommand,
  nodeUpdateCommand,
  nodeRemoveCommand,
  clusterStatusCommand,
  clusterReplicateCommand,
  versionCommand
];

export { resolveCommand, subcommandHint } from '../command.js';