import { db } from '../db.js'
import { fail } from '../http.js'
import { isContainerDocument } from '../text/office-text.js'
import { indexNode, removeFromIndex } from './search-index.js'

/** One durable container job at a time, sharing the bounded CPU pool with previews. */
export function createIndexJobs({ database = db, index = indexNode, remove = removeFromIndex,
  log = console, retryMs = 250 } = {}) {
  let stopped = false
  let timer = null
  let running = null
  const barriers = new Set()
  const stamp = () => new Date().toISOString()
  const nodeFor = (id) => database.prepare('SELECT * FROM nodes WHERE id=?').get(id)
  const same = (a, b) => a && b && !b.deleted_at && a.blob_hash === b.blob_hash && a.version === b.version

  function schedule(delay = 0) {
    if (stopped || running || timer) return
    timer = setTimeout(() => {
      timer = null
      void pump()
    }, delay)
    // Persistent rows, rather than an idle retry timer, keep the work alive.
    timer.unref()
  }

  function nextJob() {
    for (const ids of barriers) {
      for (const [id, generation] of ids) {
        const job = database.prepare("SELECT * FROM index_jobs WHERE node_id=? AND generation=? AND state='pending' AND ready_at<=?")
          .get(id, generation, Date.now())
        if (job) return job
      }
    }
    return database.prepare("SELECT * FROM index_jobs WHERE state='pending' AND ready_at<=? ORDER BY updated_at,node_id LIMIT 1")
      .get(Date.now())
  }

  async function work(job) {
    let snapshot = nodeFor(job.node_id)
    const finish = () => database.prepare('DELETE FROM index_jobs WHERE node_id=? AND generation=?')
      .run(job.node_id, job.generation)
    if (!snapshot || snapshot.deleted_at || !snapshot.blob_hash) { finish(); return }
    database.prepare("UPDATE index_jobs SET state='running',blob_hash=?,version=? WHERE node_id=? AND generation=?")
      .run(snapshot.blob_hash, snapshot.version, job.node_id, job.generation)
    let error
    let ok = false
    try { ok = await index(snapshot) } catch (caught) { error = caught }
    if (stopped) return // Leave the durable running row for the next boot.
    const current = nodeFor(job.node_id)
    if (!current || current.deleted_at || !current.blob_hash) { finish(); return }
    if (!same(snapshot, current)) {
      // Rename/move also increments version. Re-read metadata instead of leaving
      // an otherwise unchanged file permanently absent after a stale parse.
      database.prepare(`UPDATE index_jobs SET state='pending',blob_hash=?,version=?,attempts=0,
        ready_at=0,last_error=NULL,updated_at=? WHERE node_id=? AND generation=?`)
        .run(current.blob_hash, current.version, stamp(), job.node_id, job.generation)
      return
    }
    const refused = database.prepare('SELECT 1 FROM index_skips WHERE node_id=?').get(job.node_id)
    if (ok || refused) { finish(); return }
    const attempts = job.attempts + 1
    database.prepare(`UPDATE index_jobs SET state=?,attempts=?,ready_at=?,last_error=?,updated_at=?
      WHERE node_id=? AND generation=?`).run(attempts >= 3 ? 'failed' : 'pending', attempts,
      Date.now() + retryMs * attempts, String(error?.message || 'Indexing did not produce an entry.').slice(0, 500),
      stamp(), job.node_id, job.generation)
    if (attempts >= 3) log.error?.('[search] background indexing failed for ' + job.node_id)
  }

  async function pump() {
    if (stopped || running) return
    const job = nextJob()
    if (!job) {
      const next = database.prepare("SELECT MIN(ready_at) AS at FROM index_jobs WHERE state='pending'").get()
      if (next.at !== null) schedule(Math.max(1, next.at - Date.now()))
      return
    }
    running = work(job).catch((error) => log.error?.('[search] background job failed:', error))
    try { await running } finally { running = null; schedule() }
  }

  async function queue(node) {
    const current = node?.id && nodeFor(node.id)
    if (!current || current.deleted_at) return false
    if (!isContainerDocument(current.name, current.mime) || !current.blob_hash) {
      database.prepare('DELETE FROM index_jobs WHERE node_id=?').run(current.id)
      return index(current)
    }
    try {
      database.prepare(`INSERT INTO index_jobs(node_id,blob_hash,version,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(node_id) DO UPDATE SET blob_hash=excluded.blob_hash,version=excluded.version,
          generation=index_jobs.generation+1,attempts=0,state='pending',ready_at=0,last_error=NULL,updated_at=excluded.updated_at`)
        .run(current.id, current.blob_hash, current.version, stamp())
      // Never expose the previous content while its replacement is pending.
      remove(current.id)
      schedule()
      return true
    } catch (error) {
      log.error?.('[search] could not queue ' + current.id + ':', error)
      return false
    }
  }

  function resume() {
    stopped = false
    database.exec("UPDATE index_jobs SET state='pending',ready_at=0 WHERE state='running'")
    schedule()
  }

  async function drain(userId, { timeoutMs = 15000 } = {}) {
    const jobs = database.prepare(`SELECT j.node_id,j.generation FROM index_jobs j JOIN nodes n ON n.id=j.node_id
      WHERE j.state IN ('pending','running') AND n.deleted_at IS NULL
        AND (n.user_id=? OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id=? AND m.workspace_id=n.workspace_id))`)
      .all(userId, userId)
    const targets = new Map(jobs.map((job) => [job.node_id, job.generation]))
    if (!targets.size) return
    const deadline = Date.now() + timeoutMs
    barriers.add(targets)
    schedule()
    try {
      while (targets.size) {
        for (const [id, generation] of targets) {
          const job = database.prepare(`SELECT j.state FROM index_jobs j JOIN nodes n ON n.id=j.node_id
            WHERE j.node_id=? AND j.generation=? AND n.deleted_at IS NULL
              AND (n.user_id=? OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id=? AND m.workspace_id=n.workspace_id))`)
            .get(id, generation, userId, userId)
          if (!job || job.state === 'failed') targets.delete(id)
        }
        if (!targets.size) return
        if (stopped || Date.now() >= deadline) throw fail(503, 'SEARCH_INDEX_BUSY', 'Document indexing is still in progress. Try again shortly.')
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    } finally { barriers.delete(targets) }
  }

  async function stop() {
    stopped = true
    clearTimeout(timer)
    timer = null
    if (running) await running
  }

  function summary(userId = null) {
    const scope = userId ? `AND (n.user_id=? OR EXISTS (
      SELECT 1 FROM memberships m WHERE m.user_id=? AND m.workspace_id=n.workspace_id))` : ''
    const rows = database.prepare(`SELECT j.state,COUNT(*) AS total FROM index_jobs j JOIN nodes n ON n.id=j.node_id
      WHERE n.deleted_at IS NULL ${scope} GROUP BY j.state`).all(...(userId ? [userId, userId] : []))
    return Object.assign({ pending: 0, running: 0, failed: 0 }, Object.fromEntries(rows.map((row) => [row.state, row.total])))
  }

  function reconcile() {
    // An explicit rebuild may have repaired a previously failed extraction.
    // New uploads reset state to pending, so they cannot be cleared here.
    return database.prepare(`DELETE FROM index_jobs WHERE state='failed' AND EXISTS (
      SELECT 1 FROM nodes n WHERE n.id=index_jobs.node_id AND n.deleted_at IS NULL
        AND (EXISTS (SELECT 1 FROM node_text t WHERE t.node_id=n.id)
          OR EXISTS (SELECT 1 FROM index_skips s WHERE s.node_id=n.id)))`).run().changes
  }

  return { queue, resume, drain, stop, summary, reconcile }
}

const jobs = createIndexJobs()
export const queueIndex = (node) => jobs.queue(node)
export const resumeIndexJobs = () => jobs.resume()
export const drainIndexJobs = (userId) => jobs.drain(userId)
export const stopIndexJobs = () => jobs.stop()
export const indexJobSummary = (userId = null) => jobs.summary(userId)
export const reconcileIndexJobs = () => jobs.reconcile()
