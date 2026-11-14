import { db } from '../db.js'
import { config } from '../config.js'
import { fail } from '../http.js'

/**
 * Storage quota.
 *
 * `DRIVE_QUOTA_BYTES` is a per-account ceiling over live files (trash is not
 * counted: a deleted file is meant to be recoverable, not to keep blocking an
 * upload). `0` disables the check entirely, which is the default for a personal
 * drive on your own disk.
 *
 * Bytes are counted from the node rows, not from the blob table: two files can
 * share one blob, and the user is charged for what they store, not for what the
 * store happens to deduplicate.
 */

const quotaEnabled = () => config.quotaBytes > 0

/** Bytes currently used by live files. */
function usedBytes(userId) {
  const row = db.prepare("SELECT SUM(size) AS used FROM nodes WHERE user_id=? AND kind='file' AND deleted_at IS NULL").get(userId)
  return (row && row.used) || 0
}

/**
 * Fails with 413 QUOTA_EXCEEDED when `incoming` more bytes would exceed the
 * ceiling.
 *
 * `replacesBytes` is the size of content that will be replaced (an overwrite, a
 * version restore), so replacing a 10 MB file with an 11 MB one only counts 1 MB
 * against the quota.
 */
export function assertWithinQuota(userId, incoming, replacesBytes = 0) {
  if (!quotaEnabled()) return { used: usedBytes(userId), limit: 0, remaining: null }
  const used = usedBytes(userId)
  const after = used - Math.max(0, replacesBytes) + Math.max(0, incoming)
  if (after > config.quotaBytes) {
    const remaining = Math.max(0, config.quotaBytes - used + Math.max(0, replacesBytes))
    const error = fail(413, 'QUOTA_EXCEEDED', `This upload needs ${incoming} bytes but only ${remaining} remain of ${config.quotaBytes}.`)
    error.quota = { used, limit: config.quotaBytes, remaining }
    throw error
  }
  return { used, limit: config.quotaBytes, remaining: Math.max(0, config.quotaBytes - used + Math.max(0, replacesBytes)) }
}

/** `{used, limit, remaining}` for the stats endpoint. */
export function quotaSnapshot(userId) {
  const used = usedBytes(userId)
  if (!quotaEnabled()) return { used, limit: null, remaining: null }
  return { used, limit: config.quotaBytes, remaining: Math.max(0, config.quotaBytes - used) }
}
