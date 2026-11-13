import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LIMITS, assertLoginAllowed, recordLoginFailure, resetAll } from '../src/ops/rate-limit.js'

/** The throttling budget itself, exercised without HTTP. */

const fail = (status, code, message) => {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

describe('login throttling', () => {
  it('allows ten failures and then refuses with a retry hint', () => {
    resetAll()
    for (let attempt = 1; attempt <= LIMITS.maxAttempts; attempt++) {
      assert.doesNotThrow(() => assertLoginAllowed('10.0.0.1', fail))
      recordLoginFailure('10.0.0.1')
    }
    let thrown = null
    try { assertLoginAllowed('10.0.0.1', fail) } catch (error) { thrown = error }
    assert.ok(thrown, 'the eleventh attempt must be refused')
    assert.equal(thrown.status, 429)
    assert.equal(thrown.code, 'RATE_LIMITED')
    assert.ok(thrown.retryAfter >= 1 && thrown.retryAfter <= LIMITS.windowMs / 1000)
  })

  it('keeps budgets per client address', () => {
    resetAll()
    for (let attempt = 0; attempt < LIMITS.maxAttempts; attempt++) recordLoginFailure('10.0.0.2')
    assert.throws(() => assertLoginAllowed('10.0.0.2', fail), /Too many sign-in attempts/)
    assert.doesNotThrow(() => assertLoginAllowed('10.0.0.3', fail))
  })

  it('forgets the counter for a fresh bucket after the window', () => {
    resetAll()
    for (let attempt = 0; attempt < LIMITS.maxAttempts; attempt++) recordLoginFailure('10.0.0.4')
    // Simulate the window passing by moving the clock forward.
    const realNow = Date.now
    Date.now = () => realNow() + LIMITS.windowMs + 1000
    try {
      assert.doesNotThrow(() => assertLoginAllowed('10.0.0.4', fail))
    } finally {
      Date.now = realNow
    }
  })

  it('is wired into the login route', async () => {
    const { startServer, uniqueEmail } = await import('./helpers.js')
    const app = await startServer()
    try {
      const email = uniqueEmail()
      await app.client('POST', '/api/v1/auth/register', { body: { email, password: 'rate limit password' } })
      let last
      for (let attempt = 0; attempt < LIMITS.maxAttempts; attempt++) {
        last = await app.client('POST', '/api/v1/auth/login', { body: { email, password: 'wrong password' } })
        assert.equal(last.status, 401, 'attempt ' + attempt)
      }
      const blocked = await app.client('POST', '/api/v1/auth/login', { body: { email, password: 'wrong password' } })
      assert.equal(blocked.status, 429)
      assert.equal(blocked.json.error.code, 'RATE_LIMITED')
      assert.ok(Number(blocked.headers.get('retry-after')) > 0)
      // A correct password is still refused while the window is exhausted.
      const stillBlocked = await app.client('POST', '/api/v1/auth/login', { body: { email, password: 'rate limit password' } })
      assert.equal(stillBlocked.status, 429)
    } finally {
      await app.close()
      app.cleanup()
    }
  })
})
