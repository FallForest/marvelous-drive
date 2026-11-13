import { authenticate, publicUser, registerUser, userFromRequest } from '../auth.js'
import { fail, sendJson } from '../http.js'
import { assertLoginAllowed, recordLoginFailure, resetLoginFailures } from '../ops/rate-limit.js'

/**
 * Registration, login, and the session identity check.
 *
 * Login is throttled per client address (ten failures per fifteen minutes) and
 * the response carries the remaining budget, so a client can warn before it is
 * locked out.
 */

const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown'

export function registerAuthRoutes(router) {
  router.post('/api/v1/auth/register', async (ctx) => {
    const input = await ctx.json()
    const result = await registerUser({ email: input.email, password: input.password, name: input.name })
    sendJson(ctx.res, 201, result)
  })

  router.post('/api/v1/auth/login', async (ctx) => {
    const ip = clientIp(ctx.req)
    // `fail` returns the HttpError; ctx.fail throws it, which would skip the
    // retryAfter annotation the throttler adds.
    const bucket = assertLoginAllowed(ip, fail)
    const input = await ctx.json()
    try {
      const result = await authenticate({ email: input.email, password: input.password })
      resetLoginFailures(ip)
      sendJson(ctx.res, 200, result)
    } catch (error) {
      if (error && error.status === 401) {
        recordLoginFailure(ip)
        if (bucket.count >= 1) {
          ctx.res.setHeader?.('x-login-attempts-remaining', String(Math.max(0, 10 - bucket.count)))
        }
      }
      throw error
    }
  })

  router.get('/api/v1/me', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    sendJson(ctx.res, 200, { user })
  })

  router.patch('/api/v1/me', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const input = await ctx.json()
    const name = String(input.name ?? '').trim().slice(0, 80)
    if (!name) ctx.fail(400, 'INVALID_INPUT', 'A name is required.')
    const { db } = await import('../db.js')
    db.prepare('UPDATE users SET name=? WHERE id=?').run(name, user.id)
    const row = db.prepare('SELECT * FROM users WHERE id=?').get(user.id)
    sendJson(ctx.res, 200, { user: publicUser(row) })
  })
}
