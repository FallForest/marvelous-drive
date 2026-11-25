import { db, nowIso } from '../db.js'
import { userFromRequest } from '../auth.js'
import { HttpError, fail, sendBlob, sendJson } from '../http.js'
import { passwordHash, passwordMatches, randomId, randomToken } from '../security.js'
import { backend } from '../storage/backend.js'
import { releaseBlob } from '../storage/blobs.js'
import { requireNode } from '../nodes.js'
import { resolveMime } from '../mime.js'
import { officePreview } from './office.js'

/**
 * Public share links.
 *
 * The token is the capability: anyone holding it can read the node behind it.
 * `permission` splits that capability in two:
 *
 *   viewer      read-only. The bytes are streamed inline at /preview (and at
 *               /file/:nodeId), a folder share can be browsed child by child,
 *               and nothing here spends the download budget.
 *   downloader  everything viewer gets, plus attachments — /content, a plain
 *               /file/:nodeId and the folder archive — each of which counts
 *               against `maxDownloads`.
 *
 * Preview never counts: a link with a download budget must not be spent by the
 * recipient merely opening the page. Optional password, expiry and budget are
 * enforced on every access through unlockShare, not just at creation.
 */

function shareJson(row, origin = '') {
  return {
    id: row.id,
    nodeId: row.node_id,
    token: row.token,
    url: `${origin}/s/${row.token}`,
    permission: row.permission,
    expiresAt: row.expires_at,
    maxDownloads: row.max_downloads,
    downloads: row.downloads,
    hasPassword: Boolean(row.password_hash),
    createdAt: row.created_at,
  }
}

function requireShareNode(userId, id) {
  const row = requireNode(userId, id)
  if (row.deleted_at) throw fail(404, 'NOT_FOUND', 'File or folder was not found.')
  return row
}

/**
 * Page size bounds for the owner's management list.
 *
 * The same shape /nodes uses — a default page and a ceiling that keeps one
 * request bounded — but a smaller ceiling: a share row is a whole management
 * panel, not a file line, so 100 is already more than a screenful of scrolling.
 */
const SHARE_LIMIT = 50
const SHARE_LIMIT_MAX = 100

/**
 * Longest source-name filter the owner list will look at.
 *
 * The client caps its field at the same number. Slicing (rather than rejecting)
 * keeps a hand-edited URL answering a normal page instead of a 400, and keeps
 * the LIKE pattern bounded however the request was built — the same rule the
 * recycle bin's name filter follows.
 */
const SHARE_QUERY_MAX = 100

/**
 * The closed vocabulary `state` accepts on the owner list, in display order.
 *
 * `all` (or no value) means no state filter. Anything else is rejected loudly:
 * a typo must not silently widen the list to every state, because the page the
 * user bookmarked would then claim to be a filtered view it is not.
 */
const SHARE_STATES = Object.freeze(['active', 'expired', 'exhausted', 'trashed'])

/** Escape the three characters LIKE treats specially, for an ESCAPE '\' query. */
function likeLiteral(value) {
  return String(value).replace(/[\\%_]/g, (char) => '\\' + char)
}

/**
 * The effective state of a link, in the same order resolveShare() refuses it.
 *
 * The public page and the owner's list must never disagree about whether a link
 * works, so both derive that answer from the same columns. `usable` is the only
 * thing the UI needs for its copy/open buttons; `state` is the word it shows.
 *
 * The budget only counts for a downloader. A viewer link never spends it (the
 * byte routes it can reach are all uncounted, see the file header), so a stored
 * `max_downloads` reached by an earlier downloader incarnation must not mark a
 * changed-to-viewer link dead: every preview it offers would still be served.
 * The counter itself is preserved — switching back to downloader resumes it.
 */
function shareState(row, now) {
  if (row.node_deleted_at) return 'trashed'
  if (row.expires_at && row.expires_at < now) return 'expired'
  if (row.permission === 'downloader' && row.max_downloads !== null && row.downloads >= row.max_downloads) return 'exhausted'
  return 'active'
}

/**
 * One row of the owner's list.
 *
 * Deliberately narrow on the node: an owner managing links does not need size,
 * mime, version or blob hashes, only what identifies the source and whether it
 * is in the trash. Everything else is the link's own state.
 */
function ownerShareJson(row, origin, now) {
  const state = shareState(row, now)
  return {
    ...shareJson(row, origin),
    state,
    usable: state === 'active',
    // viewer = read/preview only; downloader = read + download. Mirrors
    // shareCapabilities() on the client and the server's own /content gate.
    canDownload: row.permission === 'downloader',
    node: { id: row.node_id, name: row.node_name, kind: row.node_kind, deletedAt: row.node_deleted_at || null },
  }
}

/**
 * The capability gate for every public route.
 *
 * The budget check is downloader-only, for the same reason shareState() says:
 * a viewer link may carry a spent counter left from its downloader days, and
 * its previews must keep working. The counted routes (/content, /archive, a
 * non-inline /file) each refuse a viewer with 403 before this matters, and
 * countDownload() re-asserts the downloader condition in its own UPDATE, so
 * the budget can never be spent twice or by the wrong permission.
 */
function resolveShare(token) {
  const row = db.prepare(`SELECT s.*, n.name, n.size, n.mime, n.kind, n.blob_hash, n.deleted_at, n.workspace_id
      FROM shares s JOIN nodes n ON n.id=s.node_id WHERE s.token=?`).get(token)
  if (!row) throw fail(404, 'SHARE_NOT_FOUND', 'This link is not valid.')
  if (row.deleted_at) throw fail(404, 'SHARE_NOT_FOUND', 'This link is not valid.')
  if (row.expires_at && row.expires_at < nowIso()) throw fail(404, 'SHARE_NOT_FOUND', 'This link has expired.')
  if (row.permission === 'downloader' && row.max_downloads !== null && row.downloads >= row.max_downloads) {
    throw fail(404, 'SHARE_NOT_FOUND', 'This link has reached its download limit.')
  }
  return row
}

/**
 * Token first, password second — the pair every public route needs.
 *
 * These two steps used to be copied into each handler, and the fourth copy is
 * exactly the one that forgets the password; one function means a locked link
 * cannot leak bytes through a route somebody added later.
 */
async function unlockShare(ctx) {
  const row = resolveShare(ctx.params.token)
  if (row.password_hash) {
    const supplied = ctx.url.searchParams.get('password') || ctx.req.headers['x-share-password'] || ''
    const ok = supplied ? await passwordMatches(String(supplied), row.password_hash) : false
    if (!ok) throw fail(401, 'SHARE_LOCKED', 'This link is password protected.')
    // Hashing is the only await in this gate, and the owner can rotate the
    // password while it runs. The check above proved the *old* hash, so re-read
    // once it resolves: a rotated hash must refuse here instead of carrying
    // that stale proof into the handler (and, on a counted route, into a
    // download). No rotation means the same link, now at its live values.
    const fresh = resolveShare(ctx.params.token)
    if ((fresh.password_hash ?? null) !== row.password_hash) {
      throw fail(401, 'SHARE_LOCKED', 'This link is password protected.')
    }
    return fresh
  }
  return row
}

/**
 * Headers for a body the public page renders inline, on our own origin.
 *
 * The bytes are user-supplied: an uploaded .html or .svg opened directly would
 * otherwise run its script against this origin, with this visitor's storage and
 * this link's password in the URL. `sandbox` without allow-* tokens makes that
 * document opaque and script-free; nosniff stops the declared type from being
 * ignored in favour of a sniffed one.
 */
const INLINE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': 'sandbox',
}

/** One node inside the share's subtree; anything else is a 404, not a 403. */
function shareNodeOf(row, nodeId) {
  const node = db.prepare('SELECT * FROM nodes WHERE id=? AND workspace_id=? AND deleted_at IS NULL').get(nodeId, row.workspace_id)
  if (!node || !isInside(node.id, row.node_id, row.workspace_id)) throw fail(404, 'NOT_FOUND', 'File was not found.')
  return node
}

/**
 * Claims one download from the link's budget, atomically.
 *
 * The claim is a single UPDATE with the permission and the remaining budget in
 * its WHERE clause, so two concurrent requests cannot both take the last slot
 * and a link that was downgraded to viewer while this response was being
 * prepared cannot spend a budget it no longer offers. `onStart` runs before the
 * response headers, so the refusal below still reaches the recipient as an
 * error envelope rather than a truncated 200.
 *
 * A refusal re-reads the row to say which of the two conditions fired: a
 * downgraded link is a 403 (its new permission is the reason), an exhausted one
 * keeps the 404 this route has always answered with.
 */
function countDownload(row) {
  const claimed = db.prepare(`UPDATE shares SET downloads=downloads+1 WHERE id=? AND permission='downloader'
      AND (max_downloads IS NULL OR downloads<max_downloads)`).run(row.id)
  if (claimed.changes) return
  const fresh = db.prepare('SELECT permission FROM shares WHERE id=?').get(row.id)
  if (!fresh) throw fail(404, 'SHARE_NOT_FOUND', 'This link is not valid.')
  if (fresh.permission !== 'downloader') throw fail(403, 'FORBIDDEN', 'This link does not allow downloads.')
  throw fail(404, 'SHARE_NOT_FOUND', 'This link has reached its download limit.')
}

/**
 * The public shape of a folder entry.
 *
 * Deliberately narrower than nodeJson: a recipient of a folder link should learn
 * what the browser needs to draw a row, never blob hashes, versions, parents or
 * ids of anything outside the shared subtree.
 */
function entryJson(row) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    size: row.size,
    mime: resolveMime(row.name, row.mime),
    updatedAt: row.updated_at,
  }
}

/**
 * The identity and password part of the "still authorized?" question.
 *
 * Both the archive and the byte routes authorize cheaply up front, then wait on
 * something — packaging, a backend stat — before the first byte leaves. The
 * link can be revoked, replaced, re-passworded or expired in that window, so
 * the same two facts are re-asserted against the live row at that point:
 *
 *   same link    same row, same source, same workspace as the one authorized
 *   same secret  an unchanged password hash; a rotated one invalidates the
 *                earlier proof, because the visitor only ever presented the old
 *                password
 *
 * Synchronous on purpose: this runs inside sendBlob's `onStart`, which is
 * called immediately before `writeHead` and cannot await. No password is
 * re-hashed here — comparing the stored hash is what detects a rotation; the
 * plaintext is not retained to hash again.
 */
function recheckShare(ctx, before) {
  // The whole live gate (resource, expiry, budget), so an expiry that passed
  // during the wait refuses instead of serving bytes.
  const fresh = resolveShare(ctx.params.token)
  // A different link answering the same token would be serving bytes nobody
  // authorized; the same check the archive path has always made.
  if (fresh.id !== before.id || fresh.node_id !== before.node_id || fresh.workspace_id !== before.workspace_id) {
    throw fail(404, 'SHARE_NOT_FOUND', 'This link is not valid.')
  }
  // The password was verified once, up front; an unchanged hash means the same
  // visitor is still entitled in this request, a changed one means it rotated.
  if ((fresh.password_hash ?? null) !== (before.password_hash ?? null)) {
    throw fail(401, 'SHARE_LOCKED', 'This link is password protected.')
  }
  return fresh
}

/**
 * The same share, re-authorized just before its bytes are served.
 *
 * Packaging an archive takes real time, and the capability it was authorized
 * with can be spent in that window: the link can expire, its budget can be
 * claimed by another request, the source can move to the trash, the node can
 * change kind, or the owner's workspace can lose its member. The pre-build
 * `unlockShare` is the cheap refusal; this is the one that must hold at the
 * moment a body starts.
 *
 * It runs the full gate again — token, password, expiry, budget, live source —
 * rather than trusting the row read before packaging, and then re-asserts the
 * two things packaging itself depends on: the same link, and a folder root.
 */
function recheckArchiveShare(ctx, before) {
  // Synchronous on purpose: sendBlob's onStart runs inside writeHead, so this
  // cannot await. This is the shared identity/password check; the archive adds
  // only the invariants the packaging step itself depends on.
  const fresh = recheckShare(ctx, before)
  if (fresh.permission !== 'downloader') throw fail(403, 'FORBIDDEN', 'This link does not allow downloads.')
  if (fresh.kind !== 'folder') throw fail(400, 'NOT_A_FILE', 'Only a folder share can be archived as a whole.')
  return fresh
}

function originOf(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim()
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '127.0.0.1').split(',')[0].trim()
  return `${proto}://${host}`
}

/**
 * The only keys PATCH /api/v1/shares/:id accepts.
 *
 * An allowlist, not a merge: the fields that must never be writable here are the
 * ones that identify or accumulate — `token`, `url`, `id`, `nodeId`,
 * `createdAt`, `downloads` — plus anything a client might hope is a hash
 * (`passwordHash`, `hasPassword`). Rejecting an unknown key loudly is how a
 * client that tried to patch one of those learns it cannot, instead of having
 * the value silently dropped and believing it was applied.
 */
const SHARE_PATCH_FIELDS = new Set(['permission', 'expiresAt', 'expiresInDays', 'maxDownloads', 'password'])

/** Password length ceiling, matching the creation form's own maxlength. */
const SHARE_PASSWORD_MAX = 200

/** Creation's horizon for a relative expiry; PATCH keeps the same upper bound. */
const SHARE_EXPIRY_MAX_DAYS = 365

/**
 * Validates a sparse share patch and returns only the fields it actually sets.
 *
 * Three distinct states per field, and they are not interchangeable:
 *
 *   absent      the key is not in `changes` at all → keep the stored value
 *   null        an explicit clear (no expiry, no password, no cap)
 *   <value>     an explicit replacement
 *
 * A wrong type is a 400, never a coercion: `maxDownloads: "five"` must not
 * become `NaN` and get written, and `expiresAt: "tomorrow"` must not sort
 * against `nowIso()` as a string that is always "later". Absolute expiries are
 * normalised to `toISOString()` for exactly that reason — the public gate
 * compares these values lexicographically.
 */
function readSharePatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw fail(400, 'INVALID_INPUT', 'Request body must be a JSON object.')
  }
  const unknown = Object.keys(input).filter((key) => !SHARE_PATCH_FIELDS.has(key))
  if (unknown.length) {
    throw fail(400, 'INVALID_INPUT', `This link cannot be changed through: ${unknown.join(', ')}.`)
  }
  if ('expiresAt' in input && 'expiresInDays' in input) {
    throw fail(400, 'INVALID_INPUT', 'Send either expiresAt or expiresInDays, not both.')
  }

  const changes = {}

  if ('permission' in input) {
    const value = input.permission
    // null is not a permission: a link is always one of the two, so "clear the
    // permission" has no meaning and must not be read as "default to viewer".
    if (value !== 'viewer' && value !== 'downloader') {
      throw fail(400, 'INVALID_INPUT', 'permission must be "viewer" or "downloader".')
    }
    changes.permission = value
  }

  if ('expiresAt' in input) {
    const value = input.expiresAt
    if (value === null) changes.expiresAt = null
    else if (typeof value !== 'string' || !value.trim()) {
      throw fail(400, 'INVALID_INPUT', 'expiresAt must be an ISO timestamp or null.')
    } else {
      const when = new Date(value)
      if (Number.isNaN(when.getTime())) throw fail(400, 'INVALID_INPUT', 'expiresAt is not a valid timestamp.')
      // Expiring a link in the past is what revoke is for; accepting it would let
      // a typo silently kill a link that the owner meant to renew.
      if (when.getTime() <= Date.now()) throw fail(400, 'INVALID_INPUT', 'expiresAt must be in the future.')
      changes.expiresAt = when.toISOString()
    }
  }

  if ('expiresInDays' in input) {
    const value = input.expiresInDays
    if (value === null) changes.expiresAt = null
    else {
      const days = typeof value === 'string' && value.trim() ? Number(value) : value
      if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > SHARE_EXPIRY_MAX_DAYS) {
        throw fail(400, 'INVALID_INPUT', `expiresInDays must be an integer between 1 and ${SHARE_EXPIRY_MAX_DAYS}, or null.`)
      }
      changes.expiresAt = new Date(Date.now() + days * 86400000).toISOString()
    }
  }

  if ('maxDownloads' in input) {
    const value = input.maxDownloads
    if (value === null) changes.maxDownloads = null
    else {
      const cap = typeof value === 'string' && value.trim() ? Number(value) : value
      if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 1) {
        throw fail(400, 'INVALID_INPUT', 'maxDownloads must be a positive integer, or null.')
      }
      changes.maxDownloads = cap
    }
  }

  if ('password' in input) {
    const value = input.password
    if (value === null) changes.password = null
    else {
      if (typeof value !== 'string') throw fail(400, 'INVALID_INPUT', 'password must be a new plaintext string, or null.')
      // An empty string is not "remove": only an explicit null is, so a form that
      // failed to collect input cannot silently unlock a protected link.
      if (!value) throw fail(400, 'INVALID_INPUT', 'password must not be empty; send null to remove it.')
      if (value.length > SHARE_PASSWORD_MAX) {
        throw fail(400, 'INVALID_INPUT', `Passwords are limited to ${SHARE_PASSWORD_MAX} characters.`)
      }
      // A stored hash is `scrypt:<salt>:<key>`; accepting that shape as a new
      // password would mean a client could copy a hash from somewhere and make it
      // the plaintext. Only a new secret may cross this boundary.
      if (/^scrypt:/i.test(value)) {
        throw fail(400, 'INVALID_INPUT', 'password must be a new plaintext value, not a stored hash.')
      }
      changes.password = value
    }
  }

  return changes
}

export function registerShareRoutes(router) {
  router.post('/api/v1/nodes/:id/share', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const row = requireShareNode(user.id, ctx.params.id)
    const input = await ctx.json().catch(() => ({}))
    const permission = input.permission === 'downloader' ? 'downloader' : 'viewer'
    const expiresInDays = input.expiresInDays === undefined || input.expiresInDays === null ? null : Number(input.expiresInDays)
    if (expiresInDays !== null && (!Number.isFinite(expiresInDays) || expiresInDays <= 0 || expiresInDays > 365)) {
      ctx.fail(400, 'INVALID_INPUT', 'expiresInDays must be between 1 and 365.')
    }
    const maxDownloads = input.maxDownloads === undefined || input.maxDownloads === null ? null : Number(input.maxDownloads)
    if (maxDownloads !== null && (!Number.isInteger(maxDownloads) || maxDownloads < 1)) {
      ctx.fail(400, 'INVALID_INPUT', 'maxDownloads must be a positive integer.')
    }
    const password = input.password ? String(input.password) : ''
    const id = randomId()
    const token = randomToken(24)
    const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 86400000).toISOString() : null
    db.prepare(`INSERT INTO shares(id,node_id,user_id,token,permission,expires_at,password_hash,max_downloads,downloads,created_at)
                VALUES (?,?,?,?,?,?,?,?,0,?)`)
      .run(id, row.id, user.id, token, permission, expiresAt, password ? await passwordHash(password) : null, maxDownloads, nowIso())
    const created = db.prepare('SELECT * FROM shares WHERE id=?').get(id)
    sendJson(ctx.res, 201, { share: shareJson(created, originOf(ctx.req)) })
  })

  router.get('/api/v1/nodes/:id/shares', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const row = requireShareNode(user.id, ctx.params.id)
    // The management boundary is the creator's account, not "who can see the
    // node": requireNode also admits workspace members, and a member who can
    // read a file must not learn (or edit) somebody else's tokens for it. The
    // same `user_id` filter as GET /shares and DELETE /shares/:id, so the three
    // endpoints agree on what "mine" means. An empty list is the honest answer;
    // the node id itself is not a secret to someone who may already read it.
    const shares = db.prepare('SELECT * FROM shares WHERE node_id=? AND user_id=? ORDER BY created_at DESC')
      .all(row.id, user.id)
      .map((share) => shareJson(share, originOf(ctx.req)))
    sendJson(ctx.res, 200, { shares })
  })

  /**
   * The owner's management list: every link this account created.
   *
   * Private (`我分享的`), unlike /shared/:token which stays public. The filter is
   * `s.user_id` and nothing else — not node ownership — so revoking is always
   * possible, including for a link whose source file is already in the trash.
   * The JOIN reaches the node only for the four fields a row displays, and a
   * deleted workspace member still cannot see another account's tokens because
   * the WHERE clause never widens to a workspace.
   *
   * Paging is keyset-stable: `created_at DESC, id DESC` is a total order (two
   * links created in the same millisecond stay deterministic), offset paging
   * rides the shares_owner index, and one extra row answers `hasMore` without a
   * COUNT over the whole table. No per-row query: the state of each link is
   * computed from columns already selected.
   *
   * Two optional filters narrow the same set:
   *
   *   ?q=      trimmed source name (file or folder), `%`/`_` literal, LIKE-folded
   *   ?state=  active | expired | exhausted | trashed (absent = every state)
   *
   * Both are applied in the WHERE clause, BEFORE LIMIT/OFFSET, so a match on
   * what would have been page two is reachable — filtering a page after it
   * arrives would lie about `hasMore` and hide rows. The state predicate repeats
   * the precedence of shareState() exactly (trash beats expiry beats a spent
   * budget), so "有效" in the control selects the same rows the list paints as
   * active. Values are parameterized and the creator scope is never widened: a
   * caller that sends neither filter gets the same SQL, order and answer as
   * before the filters existed.
   */
  router.get('/api/v1/shares', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const query = ctx.url.searchParams
    const limit = Number(query.get('limit') ?? SHARE_LIMIT)
    const offset = Number(query.get('offset') ?? 0)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > SHARE_LIMIT_MAX) {
      ctx.fail(400, 'INVALID_INPUT', `limit must be an integer between 1 and ${SHARE_LIMIT_MAX}.`)
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      ctx.fail(400, 'INVALID_INPUT', 'offset must be a non-negative integer.')
    }
    const state = query.get('state') || ''
    if (state && !SHARE_STATES.includes(state)) {
      ctx.fail(400, 'INVALID_INPUT', `state must be one of: ${SHARE_STATES.join(', ')}.`)
    }
    // One `now` for the whole request: the WHERE predicate below and the state
    // words painted from these rows must agree even if the request crosses a
    // second boundary while it runs.
    const now = nowIso()
    const where = ['s.user_id = ?']
    const params = [user.id]
    const term = String(query.get('q') ?? '').trim().slice(0, SHARE_QUERY_MAX)
    if (term) {
      // Plain LIKE (not lower()): SQLite's intrinsic LIKE folds ASCII case and
      // still matches non-ASCII exactly, while the escaped wildcards keep `%`
      // and `_` literal characters of a real file name.
      where.push("n.name LIKE ? ESCAPE '\\'")
      params.push('%' + likeLiteral(term) + '%')
    }
    if (state) {
      const stateSql = {
        // Trash outranks everything, exactly as shareState() orders its checks.
        trashed: 'n.deleted_at IS NOT NULL',
        // A live source with an expiry in the past: the same lexical comparison
        // of ISO strings that the public gate and shareState() make.
        expired: 'n.deleted_at IS NULL AND s.expires_at IS NOT NULL AND s.expires_at < ?',
        // Expiry outranks the budget, so a link that expired after spending its
        // cap is `expired` and belongs there, not here.
        exhausted: `n.deleted_at IS NULL AND (s.expires_at IS NULL OR s.expires_at >= ?)
          AND s.permission = 'downloader' AND s.max_downloads IS NOT NULL AND s.downloads >= s.max_downloads`,
        active: `n.deleted_at IS NULL AND (s.expires_at IS NULL OR s.expires_at >= ?)
          AND NOT (s.permission = 'downloader' AND s.max_downloads IS NOT NULL AND s.downloads >= s.max_downloads)`,
      }[state]
      where.push('(' + stateSql + ')')
      // The budget checks need no bound value; the other three compare to `now`.
      if (state !== 'trashed') params.push(now)
    }
    const rows = db.prepare(`SELECT s.*, n.name AS node_name, n.kind AS node_kind, n.deleted_at AS node_deleted_at
        FROM shares s JOIN nodes n ON n.id = s.node_id
        WHERE ${where.join(' AND ')}
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT ? OFFSET ?`).all(...params, limit + 1, offset)
    const origin = originOf(ctx.req)
    sendJson(ctx.res, 200, {
      // The owner needs this token to build /s/<token> once, not the row's id.
      shares: rows.slice(0, limit).map((row) => ownerShareJson(row, origin, now)),
      limit,
      offset,
      hasMore: rows.length > limit,
    })
  })

  router.delete('/api/v1/shares/:id', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const row = db.prepare('SELECT * FROM shares WHERE id=? AND user_id=?').get(ctx.params.id, user.id)
    if (!row) ctx.fail(404, 'NOT_FOUND', 'Share link was not found.')
    db.prepare('DELETE FROM shares WHERE id=?').run(row.id)
    sendJson(ctx.res, 200, { ok: true })
  })

  /**
   * Edits one link in place: the same row, token, URL, createdAt and counter.
   *
   * Creation is deliberately the only route that mints a row; an edit must never
   * leave the owner looking at a URL that quietly changed underneath the people
   * they already sent it to. So this is an UPDATE of `permission`, `expires_at`,
   * `password_hash` and `max_downloads` on the row named by :id, and nothing else
   * is touched — `token`, `created_at`, `node_id` and `downloads` are not even in
   * the SET list.
   *
   * The body is a sparse patch; every field is optional and each one has exactly
   * two meanings to keep apart:
   *
   *   absent      keep whatever the link has now (this is what makes a partial
   *               patch from a form that only touched expiry safe)
   *   null        clear this setting (no expiry, no password, no cap)
   *   <value>     set it
   *
   * `password` is a *write-only* field. It is accepted as a new plaintext only;
   * the stored hash is never returned, logged or echoed, and there is no shape
   * of request that asks for the current password (an owner who cannot remember
   * it replaces it — the same rule the product copy states). Anything that looks
   * like a hash or a read-back instruction is rejected instead of being stored,
   * so a compromised client cannot turn the link into a store of secrets.
   *
   * The response is the same share object the list uses (`shareJson`), so both
   * management surfaces can replace one row without re-fetching the page.
   */
  router.patch('/api/v1/shares/:id', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const current = db.prepare('SELECT * FROM shares WHERE id=? AND user_id=?').get(ctx.params.id, user.id)
    // Same boundary and same answer as DELETE: a stranger learns nothing, not
    // even whether the id exists.
    if (!current) ctx.fail(404, 'NOT_FOUND', 'Share link was not found.')
    // Parsed without a fallback: readJson already answers `{}` for an empty body,
    // so the only way this can throw is a body that is not a JSON object — and a
    // patch that arrived malformed must be a 400, never a silent no-op that
    // reports success for settings nobody applied.
    const input = await ctx.json()

    const changes = readSharePatch(input)
    // A hash is the one thing this route can be slow at, and the row can be
    // revoked (or a second edit can land) while scrypt runs. The write below is
    // therefore a single UPDATE guarded by the row's identity and owner — the
    // same predicate DELETE uses — so it never resurrects a revoked link, and it
    // writes only the columns this body named. `downloads` is not one of them:
    // a budget spent during the hash is kept, not reset.
    let passwordHashValue
    if (changes.password !== undefined) {
      passwordHashValue = changes.password === null ? null : await passwordHash(changes.password)
    }

    const fields = []
    const values = []
    if (changes.permission !== undefined) { fields.push('permission=?'); values.push(changes.permission) }
    if (changes.expiresAt !== undefined) { fields.push('expires_at=?'); values.push(changes.expiresAt) }
    if (changes.maxDownloads !== undefined) { fields.push('max_downloads=?'); values.push(changes.maxDownloads) }
    if (changes.password !== undefined) { fields.push('password_hash=?'); values.push(passwordHashValue) }

    if (!fields.length) {
      // Nothing to change is not an error — a form submitting an untouched dialog
      // should be a no-op — but it is also not a licence to answer with a row
      // this request never read. Return the current state as it is *now*.
      const unchanged = db.prepare('SELECT * FROM shares WHERE id=? AND user_id=?').get(current.id, user.id)
      if (!unchanged) ctx.fail(404, 'NOT_FOUND', 'Share link was not found.')
      sendJson(ctx.res, 200, { share: shareJson(unchanged, originOf(ctx.req)) })
      return
    }

    // The SET list is exactly the fields the body named, so an atomic UPDATE is
    // enough: `downloads` is never written here, and a concurrent patch of a
    // different field writes a different column. The guard is the row's identity
    // and owner only — the same predicate as DELETE — so a link revoked while
    // scrypt ran simply matches nothing and is refused below instead of being
    // resurrected by a stale write.
    const updated = db.prepare(`UPDATE shares SET ${fields.join(', ')} WHERE id=? AND user_id=?`)
      .run(...values, current.id, user.id)
    if (!updated.changes) {
      // Gone between the read and the write (revoked, or its account removed).
      // Never recreate it: a revoked token must stay dead.
      throw fail(404, 'NOT_FOUND', 'Share link was not found.')
    }
    const saved = db.prepare('SELECT * FROM shares WHERE id=? AND user_id=?').get(current.id, user.id)
    if (!saved) throw fail(404, 'NOT_FOUND', 'Share link was not found.')
    sendJson(ctx.res, 200, { share: shareJson(saved, originOf(ctx.req)) })
  })

  /** Public metadata read; the password check gates the payload. */
  router.get('/api/v1/shared/:token', async (ctx) => {
    const row = await unlockShare(ctx)
    sendJson(ctx.res, 200, {
      share: {
        token: row.token,
        permission: row.permission,
        expiresAt: row.expires_at,
        maxDownloads: row.max_downloads,
        downloads: row.downloads,
        createdAt: row.created_at,
        node: { id: row.node_id, name: row.name, size: row.size, mime: resolveMime(row.name, row.mime), kind: row.kind },
      },
      protected: Boolean(row.password_hash),
      locked: false,
    })
  })

  /**
   * Inline read of the shared file, for both permissions.
   *
   * This is what the public page points an <img>, an <iframe> or a fetch at, so
   * it must be an inline body and must not count: opening a link is not a
   * download, and a viewer link has no download budget to spend anyway.
   *
   * The bytes cannot start until the backend reports the blob's size, and that
   * wait is a window: a password rotation or an expiry landing in it must refuse
   * before the first header instead of streaming an already-stale authorization.
   */
  router.get('/api/v1/shared/:token/preview', async (ctx) => {
    const row = await unlockShare(ctx)
    if (row.kind !== 'file' || !row.blob_hash) throw fail(404, 'NOT_FOUND', 'File was not found.')
    await sendBlob(ctx.req, ctx.res, backend, row.blob_hash, {
      mime: resolveMime(row.name, row.mime),
      download: false,
      filename: row.name,
      headers: INLINE_HEADERS,
      onStart: () => recheckShare(ctx, row),
    })
  })

  /** Public download; downloader only, attachment, counts against `maxDownloads`. */
  router.get('/api/v1/shared/:token/content', async (ctx) => {
    const row = await unlockShare(ctx)
    if (row.permission !== 'downloader') throw fail(403, 'FORBIDDEN', 'This link does not allow downloads.')
    if (row.kind !== 'file' || !row.blob_hash) throw fail(404, 'NOT_FOUND', 'File was not found.')
    await sendBlob(ctx.req, ctx.res, backend, row.blob_hash, {
      mime: resolveMime(row.name, row.mime),
      download: true,
      filename: row.name,
      // The budget is claimed at the headers, and so is the re-authorization:
      // this request's password proof and expiry were checked before the stat
      // above, which can outlast either. Refusing here spends nothing — the
      // claim never runs when the recheck throws.
      onStart: () => {
        recheckShare(ctx, row)
        countDownload(row)
      },
    })
  })

  /**
   * The direct children of a folder share, one level at a time.
   *
   * `parentId` defaults to the shared folder itself and is validated against the
   * share's subtree, so a recipient can walk down from the link but cannot ask
   * for anything the share does not contain — a sibling folder id is a 404, not
   * an empty list.
   */
  router.get('/api/v1/shared/:token/children', async (ctx) => {
    const row = await unlockShare(ctx)
    const parent = shareNodeOf(row, ctx.url.searchParams.get('parentId') || row.node_id)
    if (parent.kind !== 'folder') throw fail(400, 'NOT_FOLDER', 'The parent must be a folder.')
    // Workspace contributors keep ownership of the files they add. The token
    // grants this subtree, irrespective of who created each child.
    const entries = db.prepare(`SELECT id,name,kind,size,mime,updated_at FROM nodes
        WHERE parent_id=? AND workspace_id=? AND deleted_at IS NULL
        ORDER BY (kind='folder') DESC, lower(name)`).all(parent.id, row.workspace_id)
    sendJson(ctx.res, 200, {
      rootId: row.node_id,
      parentId: parent.id,
      permission: row.permission,
      entries: entries.map(entryJson),
    })
  })

  /**
   * The whole folder share as one ZIP, downloader only.
   *
   * The archive is adopted into the blob store so it can be streamed like any
   * other blob, then released: it is a response body, not a node, so it must not
   * appear in anyone's tree or keep disk alive after the response.
   *
   * Packaging is the slow half of this route, so it is cancellable and its
   * authorization is rechecked afterwards. A recipient who closes the tab while a
   * large folder is zipped must stop the spool instead of finishing an archive
   * nobody will read, and a link that expired, ran out of budget, lost its source
   * or lost its folder kind during that window must not deliver bytes or spend a
   * download. The ordering below is what makes both true:
   *
   *   build -> (cancel? release, stop) -> recheck -> adopt into the response
   *
   * The release lives in one place (`releaseAdopted`) so a disconnect racing
   * adoption can never release the same reference twice, and a failure after
   * adoption (the recheck) still frees it.
   */
  router.get('/api/v1/shared/:token/archive', async (ctx) => {
    const row = await unlockShare(ctx)
    if (row.permission !== 'downloader') throw fail(403, 'FORBIDDEN', 'This link does not allow downloads.')
    if (row.kind !== 'folder') throw fail(400, 'NOT_A_FILE', 'Only a folder share can be archived as a whole.')

    const { res } = ctx
    // The GET body is already consumed, so request "close" fired long ago; the
    // response stream is the only honest hangup signal, as in nodes.js.
    const controller = new AbortController()
    const abort = () => controller.abort(new HttpError(499, 'CLIENT_CLOSED_REQUEST', 'Client closed the request.'))
    res.on('close', abort)
    // A response that died before this line will never emit another close.
    if (res.destroyed) abort()

    let blob = null
    let releasing = null
    /**
     * Gives the adopted reference back exactly once, whatever the exit path.
     *
     * Two exit paths can race here: a disconnect noticed after the build and the
     * `finally`. Sharing the one promise means the reference is dropped once and
     * every caller waits for the same release instead of returning early while
     * the spool is still being unlinked.
     */
    const releaseAdopted = () => {
      if (!blob) return Promise.resolve()
      releasing ??= releaseBlob(blob.hash).catch(() => {})
      return releasing
    }

    try {
      if (controller.signal.aborted) return
      const { buildZipFrom } = await import('../text/zip.js')
      blob = await buildZipFrom(row.user_id, [{ id: row.node_id }], {
        workspaceId: row.workspace_id,
        signal: controller.signal,
      })
      // The client can vanish after the last byte was spooled but before the
      // response starts. There is no reader, so free the archive and count
      // nothing: a canceled request is not a download.
      if (controller.signal.aborted || res.destroyed) {
        await releaseAdopted()
        return
      }
      // Packaging may have outlived the capability: expire, exhaust, trash, a
      // kind change or a rotated password must refuse here, before a byte is
      // served. This re-authorizes against the live row, it does not reuse the
      // one read before the build.
      const fresh = recheckArchiveShare(ctx, row)
      await sendBlob(ctx.req, res, backend, blob.hash, {
        mime: 'application/zip',
        download: true,
        filename: fresh.name + '.zip',
        onStart: () => countDownload(recheckArchiveShare(ctx, row)),
      })
    } catch (error) {
      // Cancellation has no listener left and no socket to answer on.
      if (controller.signal.aborted) return
      throw error
    } finally {
      res.off('close', abort)
      await releaseAdopted()
    }
  })

  /**
   * One file inside the share, permission-aware.
   *
   * A viewer reads it inline — that is how the folder list previews an image or
   * a pdf — and pays nothing. A downloader gets an attachment and the counter
   * moves, unless it passes `inline=1` because it is only previewing; browsing a
   * folder must not drain a link's budget one thumbnail at a time.
   *
   * Like the direct routes, the stat before the body is a window: the same
   * identity/password recheck runs at the headers for the preview path and for
   * the counted attachment path.
   */
  router.get('/api/v1/shared/:token/file/:nodeId', async (ctx) => {
    const row = await unlockShare(ctx)
    const node = shareNodeOf(row, ctx.params.nodeId)
    if (node.kind !== 'file' || !node.blob_hash) throw fail(404, 'NOT_FOUND', 'File was not found.')
    const inline = row.permission !== 'downloader' || ctx.url.searchParams.get('inline') === '1'
    await sendBlob(ctx.req, ctx.res, backend, node.blob_hash, {
      mime: resolveMime(node.name, node.mime),
      download: !inline,
      filename: node.name,
      headers: inline ? INLINE_HEADERS : {},
      onStart: inline ? () => recheckShare(ctx, row) : () => {
        recheckShare(ctx, row)
        countDownload(row)
      },
    })
  })

  const office = async (ctx) => {
    const row = await unlockShare(ctx)
    const node = shareNodeOf(row, ctx.params.nodeId || row.node_id)
    if (node.kind !== 'file') throw fail(400, 'NOT_A_FILE', 'Only a file can be previewed.')
    const preview = await officePreview(node)
    // Parsing is the slow half here. Re-authorize before the JSON body: a
    // password rotated or an expiry passed while it ran must not be answered
    // with the extracted document.
    recheckShare(ctx, row)
    sendJson(ctx.res, 200, preview)
  }
  router.get('/api/v1/shared/:token/office', office)
  router.get('/api/v1/shared/:token/office/:nodeId', office)
}

function isInside(nodeId, ancestorId, workspaceId) {
  let current = nodeId
  let guard = 0
  while (current && guard++ < 512) {
    const row = db.prepare('SELECT parent_id FROM nodes WHERE id=? AND workspace_id=? AND deleted_at IS NULL').get(current, workspaceId)
    if (!row) return false
    if (current === ancestorId) return true
    current = row ? row.parent_id : null
  }
  return false
}
