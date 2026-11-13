import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { db, nowIso } from '../db.js'
import { openSecret } from '../security.js'

/**
 * Cluster storage: one drive, many machines' disks.
 *
 * The coordinator keeps metadata and refcounts (SQLite) and each storage node
 * keeps bytes (see storage-node.js). This class is the backend the rest of the
 * server sees, so a route still talks to `put`/`get`/`stat`/`remove`/`link` and
 * never learns that a file lives on machine three.
 *
 * The hard part is not moving bytes — it is deciding what "written" means when
 * part of the cluster is unreachable. The rules:
 *
 *   1. **Write to `writes` replicas before acknowledging.** With writes=1 a single
 *      power loss loses data that the API already called stored; with writes=2 the
 *      upload only succeeds once two machines hold the bytes.
 *   2. **Capacity is advisory, but the local disk is not.** A node reports
 *      `usedBytes` on every heartbeat; placement keeps `reserveBytes` free so a
 *      full disk becomes "skip this node" rather than a failed upload.
 *   3. **A failed node is not a failed drive.** Reads fall through to any replica.
 *      A node marked offline is skipped for placement but its blobs stay
 *      addressable the moment it comes back.
 *   4. **Never delete the last copy.** `remove` only drops the bytes when the
 *      database says the refcount is zero, and it deletes every replica the
 *      placement table knows about.
 *
 * What this deliberately is not: Cassandra. There is no gossip, no quorum, no
 * hinted handoff. With a handful of machines the coordinator is the single source
 * of truth for placement, and pretending otherwise would add failure modes
 * without adding capacity.
 */

const PENDING = 'pending'
const PRESENT = 'present'

export class ClusterBackend {
  /**
   * @param {object} options
   * @param {string} options.dataDir       coordinator data dir (spool files, staging)
   * @param {number} [options.writes]      replicas that must succeed (default 1)
   * @param {number} [options.reserveBytes] headroom to keep on every node
   * @param {number} [options.timeoutMs]   per-request node timeout
   * @param {Function} [options.fetchImpl] injected for tests
   */
  constructor({ dataDir, writes = 1, reserveBytes = 512 * 1024 * 1024, timeoutMs = 120000, fetchImpl } = {}) {
    this.name = 'cluster'
    this.dataDir = dataDir
    this.spoolDir = join(dataDir, 'tmp')
    this.writes = Math.max(1, Number(writes) || 1)
    this.reserveBytes = Number(reserveBytes) || 0
    this.timeoutMs = Number(timeoutMs) || 120000
    this.fetchImpl = fetchImpl ?? globalThis.fetch
  }

  /* ── node registry ─────────────────────────────────────────────────── */

  /** Every node row, newest heartbeat first within a priority band. */
  nodes({ states = ['active'] } = {}) {
    const placeholders = states.map(() => '?').join(',')
    return db.prepare(`SELECT * FROM storage_nodes WHERE state IN (${placeholders}) ORDER BY priority ASC, name ASC`)
      .all(...states)
  }

  /** One node by id, or null. */
  node(id) {
    return db.prepare('SELECT * FROM storage_nodes WHERE id=?').get(id) ?? null
  }

  /** Which nodes hold a blob, with their state. */
  placementsOf(hash) {
    return db.prepare(`SELECT p.*, n.name AS node_name, n.endpoint, n.state AS node_state
        FROM blob_placements p JOIN storage_nodes n ON n.id=p.node_id
        WHERE p.hash=? ORDER BY p.state='present' DESC, n.priority ASC`).all(hash)
  }

  /** Marks a node's health after a request, so placement and reports stay honest. */
  #touch(nodeId, error = null) {
    db.prepare('UPDATE storage_nodes SET last_seen_at=?, last_error=? WHERE id=?')
      .run(nowIso(), error, nodeId)
  }

  /**
   * Refresh a node's used bytes from its own report.
   *
   * `usedBytes` always comes from the node — only it knows. `capacityBytes` is
   * different: a node started without `DRIVE_NODE_CAPACITY_BYTES` reports 0, which
   * means "not declared", not "no space". Letting 0 win would erase the ceiling an
   * operator set at enrolment and turn placement into "fill the first disk until
   * it dies".
   */
  async refreshUsage(node) {
    try {
      const health = await this.#request(node, 'GET', '/node/v1/health', { json: true })
      const reportedCapacity = Number(health.capacityBytes) || 0
      db.prepare(`UPDATE storage_nodes SET used_bytes=?,
          capacity_bytes=CASE WHEN ?>0 THEN ? ELSE capacity_bytes END,
          last_seen_at=?, last_error=NULL WHERE id=?`)
        .run(Number(health.usedBytes) || 0, reportedCapacity, reportedCapacity, nowIso(), node.id)
      return health
    } catch (error) {
      this.#touch(node.id, error?.message ?? String(error))
      return null
    }
  }

  /**
   * Chooses `count` nodes for a blob of `size` bytes.
   *
   * Ordering is by free space, not by priority alone: a small node that is nearly
   * full would otherwise keep receiving files and fail. `priority` breaks ties so
   * an operator can still say "prefer this box". Nodes already holding the hash are
   * excluded by the caller, not here.
   */
  chooseNodes(size, count, { exclude = new Set() } = {}) {
    const candidates = this.nodes().filter((node) => !exclude.has(node.id))
    const free = (node) => {
      const capacity = Number(node.capacity_bytes) || 0
      if (capacity <= 0) return Number.MAX_SAFE_INTEGER // unknown capacity: do not gate it
      return capacity - (Number(node.used_bytes) || 0) - this.reserveBytes
    }
    return candidates
      .filter((node) => free(node) >= size)
      .sort((a, b) => free(b) - free(a) || a.priority - b.priority || a.name.localeCompare(b.name))
      .slice(0, Math.max(1, count))
  }

  /* ── node transport ────────────────────────────────────────────────── */

  /** One request to one node. Throws a typed error so callers can fall through. */
  async #request(node, method, path, { body, headers = {}, json = false, signal } = {}) {
    const url = node.endpoint.replace(/\/+$/, '') + path
    const token = this.#tokenOf(node)
    // A streamed body needs `duplex: 'half'`, or fetch rejects the request outright
    // with "RequestInit: duplex option is required". Reporting that as
    // "unreachable" would send an operator to check the network for a protocol bug.
    const streaming = body !== undefined && typeof body?.pipe === 'function'
    let response
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: 'Bearer ' + token,
          ...(body === undefined ? {} : { 'content-type': 'application/octet-stream' }),
          ...headers,
        },
        body,
        ...(streaming ? { duplex: 'half' } : {}),
        signal: signal ?? AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      const message = error?.message ?? String(error)
      // A local protocol/validation failure is not the node's fault, and calling it
      // unreachable would poison `last_error` and hide the real cause.
      const transport = /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket|aborted|EAI_AGAIN/i.test(message)
      if (transport) this.#touch(node.id, message)
      const failure = new Error(node.name + (transport ? ' is unreachable: ' : ' request failed: ') + message)
      failure.code = transport ? 'NODE_UNREACHABLE' : 'NODE_PROTOCOL'
      failure.nodeId = node.id
      throw failure
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      const failure = new Error(node.name + ' answered ' + response.status + ': ' + text.slice(0, 200))
      failure.code = response.status === 404 ? 'NODE_NOT_FOUND' : 'NODE_ERROR'
      failure.status = response.status
      failure.nodeId = node.id
      throw failure
    }
    this.#touch(node.id, null)
    if (json) return response.json()
    return response
  }

  /**
   * The plaintext token for a node.
   *
   * Stored sealed with the coordinator's own key (see `sealSecret`), not hashed:
   * unlike a user password, this token must be *presented* on every request, so a
   * one-way hash cannot work. Sealing keeps a database dump from handing over every
   * node's disk, and keeps the cluster alive across a restart — a token that only
   * lived in memory made the whole cluster unusable after one `systemctl restart`,
   * which is a failure mode this design originally had.
   */
  #tokenOf(node) {
    const row = db.prepare('SELECT token_sealed FROM storage_nodes WHERE id=?').get(node.id)
    const plaintext = row ? openSecret(row.token_sealed) : null
    if (plaintext) return plaintext
    const fallback = process.env.DRIVE_NODE_TOKEN
    if (fallback) return fallback
    throw new Error('No usable token for node ' + node.name +
      '; re-enrol it (the coordinator secret may have been rotated).')
  }

  /* ── backend interface ─────────────────────────────────────────────── */

  /**
   * Stores bytes under `key` on `writes` nodes.
   *
   * The source is a spool file the caller already wrote (that is the contract of
   * `put` in the local backend). It is read once per replica, and the file is only
   * consumed after the last successful write so a partial failure can be retried.
   */
  async put(key, sourcePath) {
    const info = await stat(sourcePath)
    return this.putFromFile(key, sourcePath, info.size)
  }

  /** Same as put(), but with the size known (the upload path always has it). */
  async putFromFile(key, sourcePath, size) {
    // Content-addressed bytes may already exist — but "exists" is not "exists
    // `writes` times". Short-circuiting on presence alone would let a drive that
    // once ran with writes=1 stay single-replica forever after an operator raised
    // the setting, which is exactly when durability matters most.
    const present = this.placementsOf(key).filter((row) => row.state === PRESENT)
    if (present.length >= this.writes) {
      await unlink(sourcePath).catch(() => {})
      return key
    }
    if (present.length > 0) {
      // Top up instead of re-uploading to the nodes that already have it.
      const missing = this.writes - present.length
      const chosen = this.chooseNodes(size, missing, { exclude: new Set(present.map((row) => row.node_id)) })
      if (chosen.length < missing) {
        const error = new Error('Only ' + (present.length + chosen.length) + ' of ' + this.writes +
          ' required replicas can hold ' + size + ' bytes; refusing to accept an upload that is not durable.')
        error.code = 'INSUFFICIENT_REPLICAS'
        throw error
      }
      for (const node of chosen) await this.#putOnNode(node, key, sourcePath)
      await unlink(sourcePath).catch(() => {})
      return key
    }
    const chosen = this.chooseNodes(size, this.writes)
    if (chosen.length === 0) {
      const error = new Error('No storage node has room for ' + size + ' bytes. Add a node or free space.')
      error.code = 'NO_CAPACITY'
      throw error
    }
    if (chosen.length < this.writes) {
      const error = new Error('Only ' + chosen.length + ' of ' + this.writes +
        ' required replicas have room for ' + size + ' bytes; refusing to accept an upload that is not durable.')
      error.code = 'INSUFFICIENT_REPLICAS'
      throw error
    }

    for (const node of chosen) {
      await this.#putOnNode(node, key, sourcePath)
    }
    // `put` consumes the spool file, the same convention LocalBackend follows with
    // rename(). Leaving it behind would grow data/tmp without bound.
    await unlink(sourcePath).catch(() => {})
    return key
  }

  /** Uploads one file to one node and records the placement. */
  async #putOnNode(node, key, sourcePath) {
    const info = await stat(sourcePath)
    db.prepare(`INSERT INTO blob_placements(hash,node_id,size,state,created_at) VALUES (?,?,?,?,?)
                ON CONFLICT(hash,node_id) DO UPDATE SET state=excluded.state`)
      .run(key, node.id, info.size, PENDING, nowIso())
    let stream
    try {
      stream = createReadStream(sourcePath)
      // The length comes from the file, not from the stream (which has none), so a
      // node can reject an over-long body before it fills the disk.
      await this.#request(node, 'PUT', '/node/v1/blobs/' + key, {
        body: stream,
        headers: { 'content-length': String(info.size) },
      })
      // fetch resolves when the response headers arrive; the request body may still
      // be draining. Waiting for `close` makes "the upload finished" true — without
      // it a caller can delete the spool file while bytes are still being read,
      // which surfaced as an ENOENT attributed to an unrelated test.
      //
      // The wait is bounded and swallows an `error`: a server that answers early
      // (or a stub that never reads the body) must not hang the upload path, and a
      // stream error here has already been reported by the response status.
      if (!stream.closed) {
        await new Promise((resolve) => {
          const done = () => resolve()
          stream.once('close', done)
          stream.once('error', done)
          stream.resume()
        })
      }
    } catch (error) {
      db.prepare("UPDATE blob_placements SET state='missing' WHERE hash=? AND node_id=?").run(key, node.id)
      throw error
    } finally {
      stream?.destroy()
    }
    db.prepare("UPDATE blob_placements SET state=?, verified_at=? WHERE hash=? AND node_id=?")
      .run(PRESENT, nowIso(), key, node.id)
  }

  /** Bytes for a key from whichever replica answers first. */
  get(key) {
    const self = this
    return Readable.from((async function* stream() {
      const placements = self.placementsOf(key)
      if (placements.length === 0) throw new Error('Blob ' + key + ' has no known placement.')
      let lastError = null
      for (const placement of placements) {
        const node = self.node(placement.node_id)
        if (!node) continue
        try {
          const response = await self.#request(node, 'GET', '/node/v1/blobs/' + key)
          const body = response.body ? Readable.fromWeb(response.body) : Readable.from([])
          for await (const chunk of body) yield chunk
          return
        } catch (error) {
          lastError = error
          // Try the next replica: one dead node must not make a file unreadable.
        }
      }
      throw lastError ?? new Error('Blob ' + key + ' is unreachable on every node that should hold it.')
    })())
  }

  /** Size from the first node that answers; null when no replica has it. */
  async stat(key) {
    const placements = this.placementsOf(key)
    for (const placement of placements) {
      const node = this.node(placement.node_id)
      if (!node) continue
      try {
        const response = await this.#request(node, 'HEAD', '/node/v1/blobs/' + key)
        const length = Number(response.headers.get('content-length'))
        if (Number.isFinite(length)) return { size: length }
      } catch (error) {
        if (error.code === 'NODE_NOT_FOUND') {
          db.prepare("UPDATE blob_placements SET state='missing' WHERE hash=? AND node_id=?").run(key, node.id)
        }
      }
    }
    return null
  }

  /** Deletes every replica the placement table knows about. */
  async remove(key) {
    const placements = this.placementsOf(key)
    for (const placement of placements) {
      const node = this.node(placement.node_id)
      if (node) {
        try {
          await this.#request(node, 'DELETE', '/node/v1/blobs/' + key)
        } catch { /* a node that is down will be reconciled by scrub */ }
      }
      db.prepare('DELETE FROM blob_placements WHERE hash=? AND node_id=?').run(key, placement.node_id)
    }
  }

  /**
   * A local path with the key's bytes.
   *
   * A remote store cannot hard-link, so this downloads into the temp directory —
   * the same degradation `S3Backend` documents. It exists because ZIP assembly and
   * Office extraction need a path; every user-facing download streams instead.
   */
  async link(key, targetPath) {
    await mkdir(dirname(targetPath), { recursive: true })
    const staging = join(tmpdir(), 'cluster-link-' + randomUUID() + '.part')
    try {
      await pipeline(this.get(key), createWriteStream(staging))
      const { rename } = await import('node:fs/promises')
      await rename(staging, targetPath)
      return targetPath
    } finally {
      await unlink(staging).catch(() => {})
    }
  }

  /**
   * No stable path exists across nodes.
   *
   * Same contract as the S3 and tiered backends: a caller that needs a path must
   * use `link()`, which is honest about the cost.
   */
  path(key) {
    throw new Error('The cluster backend has no stable path; use get() or link() instead.')
  }

  /* ── durability ────────────────────────────────────────────────────── */

  /**
   * Copies a blob to one more node.
   *
   * Used to repair under-replication (a node died, or an upload only met writes=1).
   * The source is read from a replica that has it, so no coordinator-side copy of
   * the whole file is ever needed.
   */
  async replicate(hash, { count = 1, exclude = new Set() } = {}) {
    const placements = this.placementsOf(hash).filter((row) => row.state === PRESENT)
    if (placements.length === 0) return { hash, copied: 0, reason: 'no-source' }
    const size = placements[0].size
    const targets = this.chooseNodes(size, count, {
      exclude: new Set([...exclude, ...placements.map((row) => row.node_id)]),
    })
    if (targets.length === 0) return { hash, copied: 0, reason: 'no-capacity' }

    // Stage once, then push to every target: reading the source repeatedly would
    // multiply the load on a node that may already be the only healthy one.
    const staging = join(this.spoolDir, 'replicate-' + randomUUID() + '.part')
    let copied = 0
    try {
      await pipeline(this.get(hash), createWriteStream(staging))
      const digest = await sha256File(staging)
      if (digest !== hash) return { hash, copied: 0, reason: 'source-corrupt', actual: digest }
      for (const node of targets) {
        try {
          await this.#putOnNode(node, hash, staging)
          copied += 1
        } catch (error) {
          db.prepare("UPDATE blob_placements SET state='missing' WHERE hash=? AND node_id=?").run(hash, node.id)
          void error
        }
      }
      return { hash, copied, targets: targets.map((node) => node.name) }
    } finally {
      await unlink(staging).catch(() => {})
    }
  }

  /**
   * How many replicas a blob has, and where.
   *
   * The coordinator's answer to "is my data safe" — used by the maintenance report
   * and by the replication sweep.
   */
  replicationReport({ underReplicatedBelow = this.writes } = {}) {
    const rows = db.prepare(`
      SELECT b.hash, b.size, b.refs,
             SUM(CASE WHEN p.state='present' THEN 1 ELSE 0 END) AS present,
             GROUP_CONCAT(CASE WHEN p.state='present' THEN n.name END) AS nodes
        FROM blobs b
        LEFT JOIN blob_placements p ON p.hash=b.hash
        LEFT JOIN storage_nodes n ON n.id=p.node_id
       GROUP BY b.hash
       HAVING present < ?
       ORDER BY b.size DESC`).all(underReplicatedBelow)
    return {
      underReplicatedBelow,
      count: rows.length,
      bytes: rows.reduce((sum, row) => sum + Number(row.size || 0), 0),
      blobs: rows.map((row) => ({
        hash: row.hash,
        size: row.size,
        refs: row.refs,
        replicas: Number(row.present || 0),
        nodes: row.nodes ? String(row.nodes).split(',') : [],
      })),
    }
  }
}

/** sha256 of a local file, streamed. */
function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}
