import { db, nowIso } from '../db.js'
import { userFromRequest } from '../auth.js'
import { sendJson } from '../http.js'
import { requireWorkspaceOwner } from '../admin.js'
import { backend } from '../storage/backend.js'
import { randomId, openSecret, sealSecret } from '../security.js'

/**
 * Storage-node administration.
 *
 * These routes exist only on a coordinator running `DRIVE_STORAGE=cluster`. On
 * every other driver they answer `409 DRIVER_UNSUPPORTED` rather than pretending
 * a local disk can have nodes — a client that gets a 404 or a fake success cannot
 * tell "not configured" from "misconfigured".
 *
 * Enrolment is the only moment a plaintext token exists. `POST /nodes` returns it
 * once, stores only its scrypt hash, and the operator puts it on the node's
 * command line. That is the same one-time-secret pattern `share` passwords use,
 * and it means a database dump does not hand over the cluster.
 */

const CLUSTER = () => backend.name === 'cluster'

function nodeJson(row) {
  const capacity = Number(row.capacity_bytes) || 0
  const used = Number(row.used_bytes) || 0
  return {
    id: row.id,
    name: row.name,
    endpoint: row.endpoint,
    state: row.state,
    priority: row.priority,
    capacityBytes: capacity,
    usedBytes: used,
    freeBytes: capacity > 0 ? Math.max(0, capacity - used) : null,
    lastSeenAt: row.last_seen_at ?? null,
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
  }
}

/** Node health as seen by the coordinator, with a live probe when asked. */
async function nodeReport(row, { probe = false } = {}) {
  const base = nodeJson(row)
  if (!probe) return base
  const health = await backend.refreshUsage(row).catch(() => null)
  const refreshed = backend.node(row.id) ?? row
  return { ...nodeJson(refreshed), reachable: Boolean(health), health: health ?? null }
}

export function registerClusterRoutes(router) {
  router.get('/api/v1/storage/nodes', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    requireWorkspaceOwner(user, ctx.fail)
    if (!CLUSTER()) {
      ctx.fail(409, 'DRIVER_UNSUPPORTED', 'Storage nodes exist only with DRIVE_STORAGE=cluster.')
      return
    }
    const probe = ctx.url.searchParams.get('probe') === '1'
    const states = (ctx.url.searchParams.get('state') || '')
      .split(',').map((value) => value.trim()).filter(Boolean)
    const rows = states.length
      ? db.prepare(`SELECT * FROM storage_nodes WHERE state IN (${states.map(() => '?').join(',')}) ORDER BY priority, name`).all(...states)
      : db.prepare('SELECT * FROM storage_nodes ORDER BY priority, name').all()
    const nodes = []
    for (const row of rows) nodes.push(await nodeReport(row, { probe }))
    const totals = nodes.reduce((acc, node) => {
      acc.capacityBytes += node.capacityBytes || 0
      acc.usedBytes += node.usedBytes || 0
      if (node.state === 'active') acc.active += 1
      return acc
    }, { capacityBytes: 0, usedBytes: 0, active: 0 })
    sendJson(ctx.res, 200, {
      nodes,
      totals: {
        ...totals,
        freeBytes: Math.max(0, totals.capacityBytes - totals.usedBytes),
        count: nodes.length,
      },
      writes: backend.writes ?? null,
    })
  })

  /**
   * Enrols a node.
   *
   * The caller may supply the token the node already runs with (`token`), which is
   * the normal case: a node is started first, then enrolled. Supplying one is not
   * optional — a generated token would have to be copied onto a machine that is
   * already running, and a token that exists in two places is a token that leaks.
   *
   * Only the sealed form is stored; the response echoes the id, never the secret.
   */
  router.post('/api/v1/storage/nodes', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    requireWorkspaceOwner(user, ctx.fail)
    if (!CLUSTER()) {
      ctx.fail(409, 'DRIVER_UNSUPPORTED', 'Storage nodes exist only with DRIVE_STORAGE=cluster.')
      return
    }
    const input = await ctx.json()
    const name = String(input.name || '').trim()
    const endpoint = String(input.endpoint || '').trim().replace(/\/+$/, '')
    const token = String(input.token || '').trim()
    if (!name) ctx.fail(400, 'INVALID_INPUT', 'A node name is required.')
    if (!/^https?:\/\/[^\s]+$/.test(endpoint)) ctx.fail(400, 'INVALID_INPUT', 'endpoint must be an http(s) URL.')
    if (token.length < 16) ctx.fail(400, 'INVALID_INPUT', 'token must be the 16+ character secret the node was started with.')
    const existing = db.prepare('SELECT id FROM storage_nodes WHERE name=?').get(name)
    if (existing) ctx.fail(409, 'CONFLICT', 'A node named "' + name + '" is already enrolled.')

    const id = randomId()
    db.prepare(`INSERT INTO storage_nodes(id,name,endpoint,token_sealed,capacity_bytes,used_bytes,state,priority,created_at)
                VALUES (?,?,?,?,?,?,?,?,?)`).run(
      id, name, endpoint, sealSecret(token),
      Math.max(0, Number(input.capacityBytes) || 0), 0,
      'active', Number(input.priority) || 100, nowIso(),
    )
    const row = db.prepare('SELECT * FROM storage_nodes WHERE id=?').get(id)
    // Prove the pair now, not on the first upload: enrolling a wrong token and
    // discovering it hours later during a write is a worse failure than a 400 here.
    const health = await backend.refreshUsage(row)
    if (!health) {
      db.prepare('DELETE FROM storage_nodes WHERE id=?').run(id)
      ctx.fail(400, 'NODE_UNREACHABLE',
        'The node did not answer with that token at ' + endpoint + '. Check it is running, bound to a reachable address, and started with this token.')
      return
    }
    sendJson(ctx.res, 201, { node: nodeJson(backend.node(id)) })
  })

  router.patch('/api/v1/storage/nodes/:id', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    requireWorkspaceOwner(user, ctx.fail)
    if (!CLUSTER()) { ctx.fail(409, 'DRIVER_UNSUPPORTED', 'Storage nodes exist only with DRIVE_STORAGE=cluster.'); return }
    const row = backend.node(ctx.params.id)
    if (!row) { ctx.fail(404, 'NOT_FOUND', 'That storage node is not enrolled.'); return }
    const input = await ctx.json()
    if (input.name !== undefined && String(input.name).trim() === '') ctx.fail(400, 'INVALID_INPUT', 'name cannot be empty.')
    if (input.state !== undefined && !['active', 'draining', 'offline', 'disabled'].includes(input.state)) {
      ctx.fail(400, 'INVALID_INPUT', 'state must be active, draining, offline or disabled.')
    }
    if (input.endpoint !== undefined && !/^https?:\/\/[^\s]+$/.test(String(input.endpoint))) {
      ctx.fail(400, 'INVALID_INPUT', 'endpoint must be an http(s) URL.')
    }
    db.prepare(`UPDATE storage_nodes SET
        name=COALESCE(?,name), endpoint=COALESCE(?,endpoint), state=COALESCE(?,state),
        priority=COALESCE(?,priority), capacity_bytes=COALESCE(?,capacity_bytes)
        WHERE id=?`).run(
      input.name === undefined ? null : String(input.name).trim(),
      input.endpoint === undefined ? null : String(input.endpoint).replace(/\/+$/, ''),
      input.state ?? null,
      input.priority === undefined ? null : Number(input.priority),
      input.capacityBytes === undefined ? null : Math.max(0, Number(input.capacityBytes)),
      row.id,
    )
    sendJson(ctx.res, 200, { node: nodeJson(backend.node(row.id)) })
  })

  /**
   * Removes a node from the cluster.
   *
   * Refuses while it still holds blobs: deleting the row would orphan those bytes
   * and drop the only record of where they are. Drain first (`state=draining`), let
   * the replication sweep move the bytes, then delete.
   */
  router.delete('/api/v1/storage/nodes/:id', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    requireWorkspaceOwner(user, ctx.fail)
    if (!CLUSTER()) { ctx.fail(409, 'DRIVER_UNSUPPORTED', 'Storage nodes exist only with DRIVE_STORAGE=cluster.'); return }
    const row = backend.node(ctx.params.id)
    if (!row) { ctx.fail(404, 'NOT_FOUND', 'That storage node is not enrolled.'); return }
    const holding = db.prepare("SELECT COUNT(*) AS total FROM blob_placements WHERE node_id=? AND state='present'").get(row.id)
    if (holding.total > 0) {
      ctx.fail(409, 'NODE_NOT_EMPTY',
        'This node still holds ' + holding.total + ' blob(s). Set state=draining and run the replication sweep until it is empty.')
      return
    }
    db.prepare('DELETE FROM storage_nodes WHERE id=?').run(row.id)
    // Placements cascade with the row, so nothing is left pointing at a ghost node.
    sendJson(ctx.res, 200, { ok: true, removed: row.name })
  })

  /** Probes every node and refreshes its reported usage. */
  router.post('/api/v1/storage/nodes/refresh', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    requireWorkspaceOwner(user, ctx.fail)
    if (!CLUSTER()) { ctx.fail(409, 'DRIVER_UNSUPPORTED', 'Storage nodes exist only with DRIVE_STORAGE=cluster.'); return }
    const rows = db.prepare('SELECT * FROM storage_nodes').all()
    const results = []
    for (const row of rows) {
      const health = await backend.refreshUsage(row)
      results.push({ node: row.name, reachable: Boolean(health), health })
    }
    sendJson(ctx.res, 200, { probed: results.length, results })
  })

  /**
   * Replication sweep.
   *
   * Finds under-replicated blobs and copies them until each has `writes` copies.
   * Bounded per run (`limit`) because it reads and writes real bytes: a 2 TB drive
   * that lost a node must be repairable in slices, not in one unbounded pass.
   */
  router.post('/api/v1/maintenance/cluster/replicate', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    requireWorkspaceOwner(user, ctx.fail)
    if (!CLUSTER()) { ctx.fail(409, 'DRIVER_UNSUPPORTED', 'Replication needs DRIVE_STORAGE=cluster.'); return }
    const input = await ctx.json().catch(() => ({}))
    const limit = Math.min(Math.max(Number(input.limit ?? 50), 1), 1000)
    const report = backend.replicationReport()
    const todo = report.blobs.slice(0, limit)
    const results = []
    for (const blob of todo) {
      const needed = Math.max(0, backend.writes - blob.replicas)
      results.push(await backend.replicate(blob.hash, { count: needed || 1 }))
    }
    sendJson(ctx.res, 200, {
      considered: report.count,
      attempted: todo.length,
      remaining: Math.max(0, report.count - todo.length),
      // A copy only counts when it actually landed: `copied: 0` means no node had
      // room, which is capacity, not success.
      copied: results.reduce((sum, row) => sum + (row.copied || 0), 0),
      results,
      after: backend.replicationReport().count,
    })
  })

  /** Which blobs are under-replicated, and by how much. */
  router.get('/api/v1/maintenance/cluster/replication', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    requireWorkspaceOwner(user, ctx.fail)
    if (!CLUSTER()) { ctx.fail(409, 'DRIVER_UNSUPPORTED', 'Replication needs DRIVE_STORAGE=cluster.'); return }
    const report = backend.replicationReport()
    sendJson(ctx.res, 200, { replication: report })
  })

  /**
   * Re-adopts a node token.
   *
   * Only needed when the coordinator's key changed (a new JWT_SECRET), which
   * invalidates every sealed token at once. The operator pastes the token that is
   * already in the node's environment; the coordinator seals it again and verifies
   * the node answers.
   */
  router.post('/api/v1/storage/nodes/:id/verify', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    requireWorkspaceOwner(user, ctx.fail)
    if (!CLUSTER()) { ctx.fail(409, 'DRIVER_UNSUPPORTED', 'Storage nodes exist only with DRIVE_STORAGE=cluster.'); return }
    const row = backend.node(ctx.params.id)
    if (!row) { ctx.fail(404, 'NOT_FOUND', 'That storage node is not enrolled.'); return }
    const input = await ctx.json().catch(() => ({}))
    const token = String(input.token || '')
    if (!token) ctx.fail(400, 'INVALID_INPUT', 'A token is required.')

    // Prove the token against the node itself, not against a stored hash: the node
    // is the only party that can say whether this secret is its own.
    const previous = openSecret(row.token_sealed)
    db.prepare('UPDATE storage_nodes SET token_sealed=? WHERE id=?').run(sealSecret(token), row.id)
    const health = await backend.refreshUsage(backend.node(row.id))
    if (!health) {
      // Put the old value back: a wrong token must not lock out a working node.
      if (previous) db.prepare('UPDATE storage_nodes SET token_sealed=? WHERE id=?').run(sealSecret(previous), row.id)
      ctx.fail(401, 'INVALID_CREDENTIALS', 'The node rejected that token; nothing was changed.')
      return
    }
    sendJson(ctx.res, 200, { ok: true, node: nodeJson(backend.node(row.id)), reachable: true })
  })
}
