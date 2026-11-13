import { db, nowIso } from './db.js'
import { retainBlob, releaseBlob } from './storage/blobs.js'
import { randomId } from './security.js'

/**
 * Version history for file content.
 *
 * A version row owns its own reference in the blob store, so discarding the
 * current bytes never deletes history. `recordVersion` is the only place that
 * inserts rows, which keeps the refcounting honest.
 */

export function recordVersion(node, userId) {
  if (node.blob_hash) retainBlob(node.blob_hash)
  db.prepare('INSERT INTO node_versions(id,node_id,version,blob_hash,size,mime,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(randomId(), node.id, node.version, node.blob_hash, node.size, node.mime, userId, nowIso())
}

/** Drops every version row of a node and releases the blobs they held. */
export async function dropVersions(nodeIds) {
  if (!nodeIds.length) return
  const placeholders = nodeIds.map(() => '?').join(',')
  const rows = db.prepare(`SELECT blob_hash FROM node_versions WHERE node_id IN (${placeholders})`).all(...nodeIds)
  db.prepare(`DELETE FROM node_versions WHERE node_id IN (${placeholders})`).run(...nodeIds)
  for (const row of rows) await releaseBlob(row.blob_hash)
}

export const listVersions = (nodeId) => db.prepare('SELECT * FROM node_versions WHERE node_id=? ORDER BY version DESC').all(nodeId)
