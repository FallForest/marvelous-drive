import { db, nowIso } from './db.js'
import { fail } from './http.js'
import { config } from './config.js'
import { passwordHash, passwordMatches, randomId, signToken, verifyToken } from './security.js'
import { createWorkspace, workspaceFor } from './workspaces.js'

/**
 * Accounts and sessions.
 *
 * Drive is personal: every account owns one workspace, so `role` is always
 * `owner`. A second account joins by e-mail and shares the tree; it never gains
 * a global role.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    createdAt: row.created_at,
    // The active workspace and the caller's role in it, so a client can show
    // "Ada's drive · admin" without a second request.
    workspace: workspaceFor(row.id),
  }
}

function createUser({ email, password, name }) {
  const normalized = String(email || '').trim().toLowerCase()
  if (!EMAIL_RE.test(normalized)) throw fail(400, 'INVALID_INPUT', 'A valid e-mail address is required.')
  const secret = String(password || '')
  if (secret.length < 8 || secret.length > 200) throw fail(400, 'INVALID_INPUT', 'Password must be 8 to 200 characters.')
  const existing = db.prepare('SELECT id FROM users WHERE email=?').get(normalized)
  if (existing) throw fail(409, 'CONFLICT', 'An account with this e-mail already exists.')
  return { id: randomId(), email: normalized, password: secret, name: String(name || '').trim().slice(0, 80) || normalized.split('@')[0] }
}

export async function registerUser(input) {
  const draft = createUser(input)
  const hash = await passwordHash(draft.password)
  const createdAt = nowIso()
  db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES (?,?,?,?,?,?)')
    .run(draft.id, draft.email, draft.name, hash, 'owner', createdAt)
  // Every account starts with a workspace it administers: the personal drive is
  // just the first workspace, not a special case.
  createWorkspace(draft.id, draft.name + "'s drive")
  const row = db.prepare('SELECT * FROM users WHERE id=?').get(draft.id)
  return { user: publicUser(row), token: issueToken(row) }
}

export async function authenticate({ email, password }) {
  const normalized = String(email || '').trim().toLowerCase()
  const row = db.prepare('SELECT * FROM users WHERE email=?').get(normalized)
  if (!row) throw fail(401, 'INVALID_CREDENTIALS', 'Wrong e-mail or password.')
  const ok = await passwordMatches(String(password || ''), row.password_hash)
  if (!ok) throw fail(401, 'INVALID_CREDENTIALS', 'Wrong e-mail or password.')
  return { user: publicUser(row), token: issueToken(row) }
}

function issueToken(row) {
  const issuedAt = Math.floor(Date.now() / 1000)
  return signToken({
    sub: row.id,
    email: row.email,
    name: row.name,
    iat: issuedAt,
    exp: issuedAt + config.tokenTtlSeconds,
  })
}

/** Resolves the caller from the Authorization header or a `token` query. */
export function userFromRequest(req, url) {
  const header = String(req.headers.authorization || '')
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
  const token = bearer || url.searchParams.get('token') || ''
  const claims = token ? verifyToken(token) : null
  if (!claims) throw fail(401, 'UNAUTHENTICATED', 'A valid bearer token is required.')
  const row = db.prepare('SELECT * FROM users WHERE id=?').get(claims.sub)
  if (!row) throw fail(401, 'UNAUTHENTICATED', 'The session no longer maps to an account.')
  return publicUser(row)
}