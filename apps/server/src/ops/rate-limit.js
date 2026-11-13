/**
 * Fixed-window rate limiting for the credential endpoints.
 *
 * Ten failed logins per IP per fifteen minutes. State is in memory — a restart
 * clears it, which is the right trade for one process and avoids a write per
 * login attempt.
 */

const WINDOW_MS = 15 * 60 * 1000
const MAX_ATTEMPTS = 10

const buckets = new Map()

function bucketFor(key) {
  const now = Date.now()
  const existing = buckets.get(key)
  if (!existing || existing.resetAt <= now) {
    const fresh = { count: 0, resetAt: now + WINDOW_MS }
    buckets.set(key, fresh)
    return fresh
  }
  return existing
}

/** Drops expired buckets; called opportunistically, never on a timer. */
function sweep(now) {
  if (buckets.size < 512) return
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key)
}

/** Throws 429 with a Retry-After hint once the window is exhausted. */
export function assertLoginAllowed(ip, fail) {
  const bucket = bucketFor('login:' + ip)
  if (bucket.count >= MAX_ATTEMPTS) {
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - Date.now()) / 1000))
    const error = fail(429, 'RATE_LIMITED', `Too many sign-in attempts. Retry after ${retryAfter} seconds.`)
    error.retryAfter = retryAfter
    throw error
  }
  return bucket
}

/** Records a failed attempt so the next one can be throttled. */
export function recordLoginFailure(ip) {
  const bucket = bucketFor('login:' + ip)
  bucket.count += 1
  sweep(Date.now())
}

/** Clears the counter after a successful sign-in. */
export function resetLoginFailures(ip) {
  buckets.delete('login:' + ip)
}

/** Test seam: forget every bucket. */
export function resetAll() {
  buckets.clear()
}

export const LIMITS = { windowMs: WINDOW_MS, maxAttempts: MAX_ATTEMPTS }
