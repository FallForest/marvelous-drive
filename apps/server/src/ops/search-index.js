import { BODY_COLUMN, db, nowIso } from '../db.js'
import { backend, readBlobBuffer } from '../storage/backend.js'
import {
  containerIndexLimit,
  isContainerDocument,
  isOfficeDocument,
  officeText,
  pdfText,
} from '../text/office-text.js'

/**
 * Full-text index over file contents.
 *
 * Name search already existed and is cheap; this adds the question people
 * actually ask — "which file mentions the invoice number?". The index is an
 * FTS5 virtual table, so ranking, tokenising and snippets come from SQLite
 * instead of from us.
 *
 * Rules that keep it honest:
 *   - only text-like files are indexed, with a size ceiling, because indexing a
 *     2 GiB video would be a denial of service against ourselves;
 *   - container documents (OOXML, PDF) are parsed for their text instead of being
 *     decoded as bytes;
 *   - the index is derived data: it can always be rebuilt from the blobs, and a
 *     failed index write never fails the upload that caused it;
 *   - a trashed node is removed from the index, so search never returns
 *     something the user cannot open from the result;
 *   - every examined-but-refused file is recorded in `index_skips`, so "up to
 *     date" means covered + refused, never covered alone.
 */

/** Files bigger than this are not worth tokenising for a search box. */
export const MAX_INDEX_BYTES = 2 * 1024 * 1024

const TEXT_MIME = /^(text\/|application\/(json|xml|x-yaml|javascript|typescript|sql))/
const TEXT_EXTENSION = new Set([
  'md', 'markdown', 'txt', 'log', 'csv', 'tsv', 'json', 'yml', 'yaml', 'toml', 'ini', 'env',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'html', 'htm', 'xml', 'svg',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash',
  'sql', 'dockerfile', 'gitignore', 'tex', 'rst',
])

const extensionOf = (name) => {
  const match = /\.([a-z0-9]+)$/i.exec(String(name || ''))
  return match ? match[1].toLowerCase() : ''
}

/** Whether a node's content is worth putting in the index. */
export function isIndexable(name, mime, size) {
  if (Number(size) > MAX_INDEX_BYTES) return false
  if (TEXT_MIME.test(String(mime || '').toLowerCase())) return true
  return TEXT_EXTENSION.has(extensionOf(name))
}

/** Records that a file was examined and cannot be indexed, with the reason. */
function recordSkip(nodeId, reason) {
  try {
    db.prepare(`INSERT INTO index_skips(node_id,reason,checked_at) VALUES (?,?,?)
      ON CONFLICT(node_id) DO UPDATE SET reason=excluded.reason, checked_at=excluded.checked_at`)
      .run(nodeId, reason, nowIso())
  } catch (error) {
    console.error('[search] failed to record a skip for ' + nodeId + ':', error)
  }
}

/** Drops any existing entry for the node; the index holds one row per node. */
export function removeFromIndex(nodeId) {
  try {
    db.prepare('DELETE FROM node_text WHERE node_id=?').run(nodeId)
    db.prepare('DELETE FROM index_skips WHERE node_id=?').run(nodeId)
  } catch (error) {
    console.error('[search] failed to remove ' + nodeId + ':', error)
  }
}

/**
 * Indexes (or re-indexes) one node.
 *
 * Never throws: a search index that is one file behind is a minor annoyance,
 * while an upload that fails because indexing failed is a bug report.
 */
export async function indexNode(node) {
  try {
    if (!node || node.kind !== 'file') return false
    removeFromIndex(node.id)
    // The caller passes a node JSON that may predate workspaces (or come from a
    // route's `nodeJson`), so the workspace is read from the row, not trusted.
    const stored = db.prepare('SELECT workspace_id FROM nodes WHERE id=?').get(node.id)
    const workspaceId = node.workspace_id ?? (stored ? stored.workspace_id : null)
    // A node created without content (POST /nodes) has no blob at all. It is not
    // a failure — there is simply nothing to index — so it is recorded as a
    // skip, otherwise it stays a permanent gap in the coverage report.
    if (!node.blob_hash) { recordSkip(node.id, 'empty'); return false }

    // Container documents (OOXML, PDF) carry their text inside a wrapper, so they
    // take a different route: no NUL check, no UTF-8 decode — the extractor reads
    // the parts and hands back plain prose plus, for a PDF, a reason when it
    // found nothing.
    if (isContainerDocument(node.name, node.mime)) {
      const limit = containerIndexLimit(node.name, node.mime)
      if (Number(node.size) > limit) { recordSkip(node.id, isOfficeDocument(node.name, node.mime) ? 'office-too-big' : 'pdf-too-big'); return false }
      const raw = await readBlobBuffer(backend, node.blob_hash)
      const extracted = isOfficeDocument(node.name, node.mime)
        ? officeText(raw, node.name, node.mime)
        : pdfText(raw, node.name, node.mime)
      const text = typeof extracted === 'string' ? extracted : String(extracted.text || '')
      if (!text.trim()) {
        // A named reason is the difference between "we know why this is missing"
        // and "search is broken": `encrypted` and `no-text` (a scan) are not the
        // same thing to the person wondering where their file went.
        recordSkip(node.id, typeof extracted === 'string' ? 'no-text' : (extracted.reason || 'no-text'))
        return false
      }
      db.prepare('INSERT INTO node_text(node_id,user_id,workspace_id,name,body) VALUES (?,?,?,?,?)')
        .run(node.id, node.user_id, workspaceId, node.name, text)
      return true
    }

    if (!isIndexable(node.name, node.mime, node.size)) { recordSkip(node.id, 'not-text'); return false }
    const buffer = await readBlobBuffer(backend, node.blob_hash)
    // A lone NUL byte is the cheapest reliable "this is binary" signal.
    if (buffer.includes(0)) { recordSkip(node.id, 'binary'); return false }
    const body = buffer.toString('utf8')
    db.prepare('INSERT INTO node_text(node_id,user_id,workspace_id,name,body) VALUES (?,?,?,?,?)')
      .run(node.id, node.user_id, workspaceId, node.name, body)
    return true
  } catch (error) {
    console.error('[search] failed to index ' + (node && node.id) + ':', error)
    return false
  }
}

/** Keeps the denormalised name in sync when a file is renamed. */
export function renameInIndex(nodeId, name) {
  try {
    const row = db.prepare('SELECT rowid FROM node_text WHERE node_id=?').get(nodeId)
    if (!row) return
    db.prepare('UPDATE node_text SET name=? WHERE node_id=?').run(name, nodeId)
  } catch (error) {
    console.error('[search] failed to rename ' + nodeId + ':', error)
  }
}

/**
 * Searches file bodies.
 *
 * `term` is turned into an FTS5 query with a prefix wildcard per token so
 * "invo" finds "invoice". Every token is quoted, which is what keeps a stray
 * `"` or `*` from turning into a syntax error — the query language belongs to
 * us, not to the user.
 */
export function searchContents(userId, term, limit = 20) {
  const text = String(term || '').trim()
  if (!text) return []
  const cap = Math.min(Math.max(limit, 1), 50)

  // Two mechanisms, deliberately both:
  //   - FTS5 gives ranking and snippets, but its unicode61 tokeniser only splits
  //     on script boundaries, so "1765" does not match 由黑格尔于1765年提出 and
  //     营收 does not match 本季度营收 — the digit or word is glued to CJK.
  //   - A LIKE scan is a substring match: the superset FTS cannot provide.
  // Merging them means a search never misses because of how SQLite decided to
  // tokenise; FTS hits stay on top because they matched a real token boundary.
  const ranked = searchFts(userId, text, cap)
  const rankedIds = new Set(ranked.map((hit) => hit.nodeId))
  const merged = [...ranked]
  for (const hit of searchSubstring(userId, text, cap)) {
    if (rankedIds.has(hit.nodeId)) continue
    merged.push(hit)
    if (merged.length >= cap) break
  }
  return merged
}

/** FTS5 lookup; returns [] when the query cannot be tokenised or parsed. */
function searchFts(userId, text, limit) {
  const tokens = text
    .split(/\s+/)
    .map((token) => token.replace(/["*():^]/g, '').trim())
    .filter(Boolean)
  if (!tokens.length) return []
  // `snippet()` addresses columns by INDEX; a column name passed as a string does
  // not fail — it silently resolves to column 0 (node_id), so every content hit
  // showed a UUID instead of the matching sentence. `BODY_COLUMN` comes from the
  // schema module, which is the only place that knows the order, and the order is
  // asserted at boot; there is no numeric literal here to drift.
  //
  // The table also stores the name, but a "content" hit must mean the body: the
  // column filter keeps a file called invoice.pdf out of a scope=content search.
  const query = tokens.map((token) => 'body:"' + token + '"*').join(' AND ')
  try {
    return db.prepare(`SELECT node_id AS nodeId,
        snippet(node_text, ${BODY_COLUMN}, '\u0001', '\u0002', '…', 14) AS snippet,
        rank
      FROM node_text
      WHERE node_text MATCH ?
        AND (user_id = ? OR workspace_id IN (SELECT workspace_id FROM memberships WHERE user_id = ?))
      ORDER BY rank LIMIT ?`).all(query, userId, userId, limit)
  } catch (error) {
    // A malformed query must look like "no results", not like a 500.
    console.error('[search] FTS query failed for "' + text + '":', error)
    return []
  }
}


/** Substring scan: the superset FTS cannot produce (CJK, digits glued to CJK). */
function searchSubstring(userId, text, limit) {
  const pattern = '%' + text.replace(/[%_\\]/g, (char) => '\\' + char) + '%'
  try {
    const rows = db.prepare(`SELECT node_id AS nodeId, body FROM node_text
      WHERE (user_id=? OR workspace_id IN (SELECT workspace_id FROM memberships WHERE user_id=?))
        AND body LIKE ? ESCAPE '\\'
      ORDER BY length(body) LIMIT ?`).all(userId, userId, pattern, limit)
    return rows.map((row) => ({
      nodeId: row.nodeId,
      snippet: excerptAround(String(row.body || ''), text),
      rank: 0,
    }))
  } catch (error) {
    console.error('[search] substring query failed for "' + text + '":', error)
    return []
  }
}

/** ~40 characters of context centred on the first match. */
function excerptAround(body, term) {
  const index = body.indexOf(term)
  if (index === -1) return body.slice(0, 80).replace(/\s+/g, ' ').trim()
  const start = Math.max(0, index - 20)
  const end = Math.min(body.length, index + term.length + 30)
  return (start > 0 ? '…' : '') + body.slice(start, end).replace(/\s+/g, ' ').trim() + (end < body.length ? '…' : '')
}

/**
 * Rebuilds the index for one account (or everyone).
 *
 * Runs on boot only when the index is empty, and on demand from the maintenance
 * route; it reads every blob, so it must never be part of a request path.
 */
export async function rebuildIndex({ userId = null, log = console } = {}) {
  const rows = userId
    ? db.prepare("SELECT * FROM nodes WHERE user_id=? AND kind='file' AND deleted_at IS NULL").all(userId)
    : db.prepare("SELECT * FROM nodes WHERE kind='file' AND deleted_at IS NULL").all()
  if (userId) {
    db.prepare('DELETE FROM node_text WHERE user_id=?').run(userId)
  } else {
    db.exec('DELETE FROM node_text')
  }
  let indexed = 0
  let skipped = 0
  for (const row of rows) {
    const ok = await indexNode(row)
    if (ok) indexed += 1
    else skipped += 1
  }
  log.info?.('[search] rebuilt: ' + indexed + ' indexed, ' + skipped + ' skipped')
  return { scanned: rows.length, indexed, skipped }
}

/**
 * How far the index has fallen behind, without reading any content.
 *
 * `covered` counts live text-like/office files that already have a row, so a file
 * added by an older version, or one whose blob came back from a backup, shows up
 * as a gap instead of silently staying invisible to search.
 */
export function indexCoverage(userId = null) {
  const where = userId
    ? "kind='file' AND deleted_at IS NULL AND user_id=?"
    : "kind='file' AND deleted_at IS NULL"
  const params = userId ? [userId] : []
  const files = db.prepare('SELECT id, name, mime, size FROM nodes WHERE ' + where).all(...params)
  const indexed = new Set(
    db.prepare(userId ? 'SELECT node_id FROM node_text WHERE user_id=?' : 'SELECT node_id FROM node_text')
      .all(...params)
      .map((row) => row.node_id),
  )
  const skipped = new Set(
    db.prepare(userId
      ? 'SELECT node_id FROM index_skips WHERE node_id IN (SELECT id FROM nodes WHERE user_id=?)'
      : 'SELECT node_id FROM index_skips')
      .all(...params)
      .map((row) => row.node_id),
  )
  let eligible = 0
  let covered = 0
  let refused = 0
  for (const file of files) {
    const container = isContainerDocument(file.name, file.mime)
    const text = isIndexable(file.name, file.mime, file.size)
    if (!container && !text) continue
    eligible += 1
    if (indexed.has(file.id)) covered += 1
    // A file the indexer examined and deliberately refused is accounted for:
    // counting it as a gap would make "up to date" unreachable.
    else if (skipped.has(file.id)) refused += 1
  }
  return { eligible, covered, refused, missing: Math.max(0, eligible - covered - refused) }
}

/** True when nothing has been indexed yet (used to decide the boot backfill). */
export function indexIsEmpty() {
  const row = db.prepare('SELECT 1 AS present FROM node_text LIMIT 1').get()
  return !row
}