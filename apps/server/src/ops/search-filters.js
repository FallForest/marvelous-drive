/**
 * The search filters shared by the name query and the content index.
 *
 * This is the lowest layer of search: it knows the `kind` vocabulary and how to
 * turn the three external filters (`folderId`, `kind`, `updatedAfter`) into ONE
 * fixed SQL fragment with bound values. The name branch in `routes/misc.js` and
 * the FTS/LIKE mechanisms in `ops/search-index.js` both consume the same
 * fragment, so they can never drift into answering slightly different questions.
 *
 * Fixed SQL only: every caller-supplied value arrives as a `?` parameter.
 */

/**
 * The closed vocabulary `kind` accepts, and the MIME/extension pairs behind it.
 *
 * Files are classified by BOTH signals because neither is reliable alone: a
 * `.heic` from an iPhone is stored as octet-stream but is still an image, while
 * a `report.pdf` uploaded as `application/pdf` is a PDF regardless of its name.
 * `folder` is a node kind, not a file type; `other` is the complement of every
 * file entry here, computed below rather than written out twice.
 */
const SEARCH_KINDS = Object.freeze({
  folder: { nodeKind: 'folder' },
  image: {
    mimes: ['image/'],
    extensions: ['png', 'jpg', 'jpeg', 'jpe', 'jfif', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg', 'svgz', 'heic', 'heif', 'tif', 'tiff', 'jxl', 'psd'],
  },
  pdf: { mimes: ['application/pdf'], extensions: ['pdf'] },
  document: {
    mimes: [
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/rtf',
      'application/vnd.oasis.opendocument.text',
      'application/epub+zip',
    ],
    extensions: ['doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'markdown', 'mdx', 'epub', 'tex', 'rst', 'log'],
  },
  sheet: {
    mimes: [
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.oasis.opendocument.spreadsheet',
      'text/csv',
      'text/tab-separated-values',
    ],
    extensions: ['xls', 'xlsx', 'ods', 'csv', 'tsv'],
  },
  slides: {
    mimes: [
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.oasis.opendocument.presentation',
    ],
    extensions: ['ppt', 'pptx', 'odp'],
  },
  video: {
    mimes: ['video/'],
    extensions: ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'wmv', 'flv'],
  },
  audio: {
    mimes: ['audio/'],
    extensions: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wma', 'aiff'],
  },
  archive: {
    mimes: ['application/zip', 'application/gzip', 'application/x-tar', 'application/vnd.rar', 'application/x-7z-compressed', 'application/x-bzip2'],
    extensions: ['zip', 'gz', 'tar', 'rar', '7z', 'bz2', 'xz'],
  },
  code: {
    mimes: ['application/json', 'application/xml', 'text/javascript', 'application/javascript'],
    extensions: [
      'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'html', 'htm', 'xml', 'py', 'rb', 'go', 'rs',
      'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'sql', 'json', 'yml', 'yaml',
      'toml', 'ini', 'env', 'dockerfile',
    ],
  },
  other: {},
})

/** Every `kind` a request may ask for. The route validates against this list. */
export const SEARCH_KIND_NAMES = Object.freeze(Object.keys(SEARCH_KINDS))

/** True when `kind` is part of the closed vocabulary. */
export function isSearchKind(kind) {
  return Object.hasOwn(SEARCH_KINDS, kind)
}

/**
 * Every descendant id of one folder, excluding the folder itself.
 *
 * Written as a `WITH RECURSIVE` inside the `IN (...)` subquery on purpose: it
 * stays ONE bindable filter fragment, so the name query and the content query
 * can share the exact same string instead of two subtly different tree walks.
 * `UNION` (not `UNION ALL`) makes the walk cycle-proof for free.
 */
const SEARCH_DESCENDANTS_SQL = `n.id IN (
    WITH RECURSIVE descendants(id) AS (
      SELECT id FROM nodes WHERE parent_id = ?
      UNION
      SELECT child.id FROM nodes child JOIN descendants d ON child.parent_id = d.id
    )
    SELECT id FROM descendants
  )`

/** MIME/extension disjunction for one kind definition. */
function describeKind(definition) {
  const parts = []
  const params = []
  // The extension is tested FIRST, and that ordering is load-bearing rather than
  // cosmetic. A `.bin` upload sniffed as octet-stream is repaired to
  // `application/json` on the way out (see `resolveMime`) when the name is
  // unknown, so a MIME-only test would file it under `code`. The stored name is
  // the same signal `resolveMime` trusts, so the two classifications agree.
  for (const extension of definition.extensions || []) {
    // The dot is part of the pattern, so '.js' cannot match '.json'.
    parts.push('lower(n.name) LIKE ?')
    params.push('%.' + extension)
  }
  for (const mime of definition.mimes || []) {
    if (mime.endsWith('/')) {
      parts.push("lower(COALESCE(n.mime,'')) LIKE ?")
      params.push(mime + '%')
    } else {
      parts.push("lower(COALESCE(n.mime,'')) = ?")
      params.push(mime)
    }
  }
  if (!parts.length) return { sql: '0', params: [] }
  return { sql: '(' + parts.join(' OR ') + ')', params }
}

/**
 * The SQL + bound values for a validated `kind`, with `other` as the complement.
 *
 * Every file kind is gated on `n.kind = 'file'`: the taxonomy is about files, so
 * a directory called "手册.pdf" must not answer a `kind=pdf` question.
 */
function kindCondition(kind) {
  const definition = SEARCH_KINDS[kind]
  if (definition.nodeKind) return { sql: 'n.kind = ?', params: [definition.nodeKind] }
  if (kind !== 'other') {
    const described = describeKind(definition)
    return { sql: "(n.kind = 'file' AND " + described.sql + ')', params: described.params }
  }
  const classified = SEARCH_KIND_NAMES
    .filter((name) => name !== 'folder' && name !== 'other')
    .map((name) => describeKind(SEARCH_KINDS[name]))
  return {
    sql: "(n.kind = 'file' AND NOT (" + classified.map((entry) => entry.sql).join(' OR ') + '))',
    params: classified.flatMap((entry) => entry.params),
  }
}

/**
 * Builds the reusable filter fragment for one search request.
 *
 * Returns `{ sql, params }`; `sql` is a parenthesised-free conjunction of
 * clauses meant to be spliced into `WHERE ...`, and `params` binds positionally
 * in exactly the same order.
 */
export function buildSearchFilters(userId, { folderId = null, updatedAfter = null, kind = null } = {}) {
  if (kind && !isSearchKind(kind)) throw new Error(`Unknown search kind: ${kind}`)
  const clauses = [
    'n.deleted_at IS NULL',
    '(n.user_id = ? OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = ? AND m.workspace_id = n.workspace_id))',
  ]
  const params = [userId, userId]
  if (folderId) {
    clauses.push(SEARCH_DESCENDANTS_SQL)
    params.push(folderId)
  }
  if (updatedAfter) {
    clauses.push('n.updated_at >= ?')
    params.push(updatedAfter)
  }
  if (kind) {
    const condition = kindCondition(kind)
    clauses.push(condition.sql)
    params.push(...condition.params)
  }
  return { sql: clauses.join(' AND '), params }
}
