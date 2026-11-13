import { fail } from './http.js'

/**
 * Drive is personal: every account owns its workspace, so "owner" is the only
 * role that exists. The check is kept as a function (not inlined) so a future
 * multi-user workspace can change the rule in one place.
 */
export function isWorkspaceOwner(user) {
  return Boolean(user) && user.role === 'owner'
}

export function requireWorkspaceOwner(user, failWith = fail) {
  if (isWorkspaceOwner(user)) return true
  throw failWith(403, 'FORBIDDEN', 'This operation requires the workspace owner.')
}
