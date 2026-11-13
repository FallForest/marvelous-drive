import { sendJson } from '../http.js'
import { config } from '../config.js'
import { workspaceFor } from '../workspaces.js'
import { parseManifest, isNewerVersion } from '../release.js'

/**
 * Release checking and self-update.
 *
 * The API never changes containers itself: it owns the account check and the
 * HTTP surface, the `updater` container owns the Docker socket and the compose
 * files. These three routes are the seam between them.
 *
 *   GET  /api/v1/system/update-check   what the deployed manifest offers
 *   POST /api/v1/system/update         ask the agent to start (admin only)
 *   GET  /api/v1/system/update-status  how that run is going (admin only)
 *
 * Every route answers 200 with an `available: false` payload when the feature is
 * unconfigured rather than failing: a deployment without an updater is normal,
 * and the client decides whether to show the entry at all.
 */

const MANIFEST_TIMEOUT_MS = 3000
const AGENT_TIMEOUT_MS = 5000

/** Workspace owners only: an update restarts the whole instance. */
function requireAdmin(user, ctx) {
  const workspace = workspaceFor(user.id)
  if (!workspace || workspace.role !== 'admin') {
    ctx.fail(403, 'ADMIN_REQUIRED', 'Only a workspace admin can update this instance.')
  }
  return workspace
}

/**
 * Fetches and validates the release manifest.
 *
 * Never throws: an unreachable or malformed manifest means "no update to offer",
 * which is the same thing the user sees when the deployment has none configured.
 */
async function readManifest() {
  const url = config.update.manifestUrl
  if (!url) return { manifest: null, error: null }
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
      // A private repository hides its release assets from anonymous requests,
      // so the same token the agent uses has to travel here too.
      headers: config.update.manifestToken
        ? { accept: 'application/json', authorization: 'Bearer ' + config.update.manifestToken }
        : { accept: 'application/json' },
    })
    if (!response.ok) return { manifest: null, error: 'release manifest returned ' + response.status }
    const manifest = parseManifest(await response.json())
    if (!manifest) return { manifest: null, error: 'release manifest is malformed' }
    return { manifest, error: null }
  } catch (error) {
    return { manifest: null, error: error instanceof Error ? error.message : 'release manifest is unreachable' }
  }
}

/** Calls the update agent, mapping its status codes onto ours. */
async function callAgent(ctx, path, options = {}) {
  if (!config.update.agentUrl || !config.update.agentToken) {
    ctx.fail(503, 'UPDATER_UNAVAILABLE', 'No update agent is configured on this instance.')
  }
  let response
  try {
    response = await fetch(config.update.agentUrl + path, {
      method: options.method || 'GET',
      headers: { authorization: 'Bearer ' + config.update.agentToken },
      signal: AbortSignal.timeout(options.timeoutMs || AGENT_TIMEOUT_MS),
    })
  } catch {
    ctx.fail(502, 'UPDATER_UNREACHABLE', 'The update agent could not be reached.')
  }
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const message = (payload && typeof payload.error === 'string' && payload.error) || 'The update agent rejected the request.'
    // A run already in flight is a conflict, not a failure of this request.
    ctx.fail(response.status === 409 ? 409 : 502, 'UPDATE_REJECTED', message)
  }
  return payload
}

export function registerUpdateRoutes(router, { version }, { userFromRequest }) {
  /**
   * Version comparison needs no account: it is the same answer for everyone and
   * the login screen shows it too. Personal data is not involved.
   */
  router.get('/api/v1/system/update-check', async (ctx) => {
    const { manifest, error } = await readManifest()
    sendJson(ctx.res, 200, {
      currentVersion: version,
      latestVersion: manifest ? manifest.version : null,
      updateAvailable: Boolean(manifest && isNewerVersion(manifest.version, version)),
      manifest,
      configured: Boolean(config.update.manifestUrl),
      error,
    })
  })

  /** Starts a run. 202: the work outlives the request by design. */
  router.post('/api/v1/system/update', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    requireAdmin(user, ctx)
    if (!config.update.manifestUrl) {
      ctx.fail(503, 'UPDATER_UNAVAILABLE', 'No release manifest is configured on this instance.')
    }
    // Refuse politely when there is nothing to install: restarting the stack to
    // land the same version is all downtime and no change.
    const { manifest } = await readManifest()
    if (!manifest) ctx.fail(502, 'MANIFEST_UNAVAILABLE', 'The release manifest could not be read.')
    if (!isNewerVersion(manifest.version, version)) {
      sendJson(ctx.res, 200, {
        started: false,
        currentVersion: version,
        latestVersion: manifest.version,
        message: 'This instance is already on the latest release.',
      })
      return
    }
    const state = await callAgent(ctx, '/update', { method: 'POST', timeoutMs: 10000 })
    sendJson(ctx.res, 202, { started: true, requestedBy: user.email, manifest, update: state })
  })

  router.get('/api/v1/system/update-status', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    requireAdmin(user, ctx)
    const update = await callAgent(ctx, '/status')
    sendJson(ctx.res, 200, { update })
  })
}
