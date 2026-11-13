import { db, nowIso } from '../db.js'

/**
 * Blob access tracking.
 *
 * The cold/hot split needs a "when was this last read" signal, and nothing else
 * in the schema records reads. Rather than a write per download, a blob's row is
 * touched at most once per day: that is plenty of resolution for deciding what
 * has not been opened in months, and it keeps a download burst from turning into
 * a write burst.
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** Marks a blob as read now, at most once per day. Never throws. */
export function touchBlob(hash) {
  if (!hash) return
  try {
    const row = db.prepare('SELECT last_access FROM blob_access WHERE hash=?').get(hash)
    const now = Date.now()
    if (row) {
      if (now - Date.parse(row.last_access) < DAY_MS) return
      db.prepare('UPDATE blob_access SET last_access=?, hits=hits+1 WHERE hash=?').run(nowIso(), hash)
      return
    }
    db.prepare('INSERT INTO blob_access(hash,last_access,hits) VALUES (?,?,1)').run(hash, nowIso())
  } catch (error) {
    console.error('[access] failed to record a read of ' + hash + ':', error)
  }
}

/**
 * Splits the store into hot and cold by last read.
 *
 * `days` is the idle threshold. A blob with no access row has never been read
 * since this table existed — treated as cold, which is the conservative reading
 * for a tiering decision (moving a never-read file is the cheapest win).
 */
export function accessReport({ days = 90, now = Date.now() } = {}) {
  const cutoff = new Date(now - days * DAY_MS).toISOString()
  const rows = db.prepare(`SELECT b.hash, b.size, b.refs, a.last_access AS lastAccess, a.hits
    FROM blobs b LEFT JOIN blob_access a ON a.hash=b.hash`).all()
  let hotBytes = 0
  let coldBytes = 0
  const cold = []
  for (const row of rows) {
    const isCold = !row.lastAccess || row.lastAccess < cutoff
    if (isCold) {
      coldBytes += row.size
      cold.push({ hash: row.hash, size: row.size, lastAccess: row.lastAccess ?? null, hits: row.hits ?? 0 })
    } else {
      hotBytes += row.size
    }
  }
  cold.sort((a, b) => b.size - a.size)
  return {
    thresholdDays: days,
    cutoff,
    blobs: rows.length,
    hotBytes,
    coldBytes,
    coldCount: cold.length,
    // The biggest cold files first: they are where a tiering run would start.
    cold: cold.slice(0, 100),
  }
}
