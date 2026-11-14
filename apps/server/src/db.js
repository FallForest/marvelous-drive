import { DatabaseSync } from 'node:sqlite'
import { config } from './config.js'
import { randomId } from './security.js'

/**
 * SQLite persistence.
 *
 * A single synchronous connection is enough: every statement is short, and the
 * synchronous API keeps transactions honest without async interleaving.
 * `PRAGMA journal_mode=WAL` lets the CLI and the server read concurrently.
 */

export const db = new DatabaseSync(config.dbPath)

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'owner',
    created_at    TEXT NOT NULL
  );

  -- A workspace is the sharing unit: one per account today, one per team later.
  -- Every node belongs to exactly one workspace AND one owner; membership decides
  -- who may see it, ownership decides whose quota it counts against.
  CREATE TABLE IF NOT EXISTS workspaces (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memberships (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role         TEXT NOT NULL CHECK (role IN ('admin','member','viewer')),
    created_at   TEXT NOT NULL,
    PRIMARY KEY (workspace_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS memberships_user ON memberships(user_id);

  CREATE TABLE IF NOT EXISTS nodes (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id  TEXT REFERENCES nodes(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('file','folder')),
    size       INTEGER NOT NULL DEFAULT 0,
    mime       TEXT,
    version    INTEGER NOT NULL DEFAULT 1,
    starred    INTEGER NOT NULL DEFAULT 0,
    blob_hash  TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS nodes_parent ON nodes(user_id, parent_id);
  CREATE INDEX IF NOT EXISTS nodes_live ON nodes(user_id, deleted_at);
  CREATE UNIQUE INDEX IF NOT EXISTS nodes_unique_name
    ON nodes(user_id, IFNULL(parent_id,''), name)
    WHERE deleted_at IS NULL;

  CREATE TABLE IF NOT EXISTS blobs (
    hash       TEXT PRIMARY KEY,
    size       INTEGER NOT NULL,
    refs       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  -- One row per blob read: the only signal that says a file is "hot". Written
  -- at most once per day per blob so a busy download does not become a write.
  CREATE TABLE IF NOT EXISTS blob_access (
    hash        TEXT PRIMARY KEY,
    last_access TEXT NOT NULL,
    hits        INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS node_versions (
    id         TEXT PRIMARY KEY,
    node_id    TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    version    INTEGER NOT NULL,
    blob_hash  TEXT NOT NULL,
    size       INTEGER NOT NULL,
    mime       TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS versions_node ON node_versions(node_id, version DESC);

  CREATE TABLE IF NOT EXISTS upload_sessions (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    size         INTEGER NOT NULL,
    sha256       TEXT,
    parent_id    TEXT,
    chunk_size   INTEGER NOT NULL,
    total_chunks INTEGER NOT NULL,
    received     TEXT NOT NULL DEFAULT '[]',
    expires_at   TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS shares (
    id            TEXT PRIMARY KEY,
    node_id       TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token         TEXT NOT NULL UNIQUE,
    permission    TEXT NOT NULL DEFAULT 'viewer',
    expires_at    TEXT,
    password_hash TEXT,
    max_downloads INTEGER,
    downloads     INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS shares_node ON shares(node_id);

  CREATE TABLE IF NOT EXISTS audit_log (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action     TEXT NOT NULL,
    node_id    TEXT,
    detail     TEXT,
    ip         TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS audit_user ON audit_log(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS audit_node ON audit_log(node_id, created_at DESC);

  -- Files the indexer looked at and refused (binary, too big, unparsable).
  -- Without this row the coverage report could never reach "up to date": every
  -- refused file would look like a permanent gap.
  CREATE TABLE IF NOT EXISTS index_skips (
    node_id    TEXT PRIMARY KEY,
    reason     TEXT NOT NULL,
    checked_at TEXT NOT NULL
  );

  -- Advisory edit locks. A lock is a promise, not a barrier: uploads still succeed
  -- (a lock must never make the store lose data), but a second client holding a
  -- stale view is told the file is being edited instead of silently overwriting.
  CREATE TABLE IF NOT EXISTS node_locks (
    node_id    TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    client     TEXT NOT NULL DEFAULT '',
    acquired_at TEXT NOT NULL,
    expires_at  TEXT NOT NULL
  );

  -- Storage nodes: one row per machine that contributes disk to this drive.
  --
  -- The coordinator keeps the metadata and the refcounts; each node keeps bytes.
  -- "capacity_bytes" and "used_bytes" are advisory (a node can fill up between
  -- two heartbeats), so a placement decision always leaves headroom rather than
  -- trusting the number exactly.
  --
  -- "token_sealed" is the node's bearer token, AES-GCM sealed with the
  -- coordinator's own key. It cannot be a one-way hash the way a user password is:
  -- the coordinator must *present* this token on every request, so a hash would be
  -- useless. Sealing keeps a database dump from handing over every node's disk, and
  -- keeps the cluster working across a restart (an in-memory token did not).
  CREATE TABLE IF NOT EXISTS storage_nodes (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    endpoint       TEXT NOT NULL,
    token_sealed   TEXT NOT NULL,
    capacity_bytes INTEGER NOT NULL DEFAULT 0,
    used_bytes     INTEGER NOT NULL DEFAULT 0,
    state          TEXT NOT NULL DEFAULT 'active'
                     CHECK (state IN ('active','draining','offline','disabled')),
    priority       INTEGER NOT NULL DEFAULT 100,
    last_seen_at   TEXT,
    last_error     TEXT,
    created_at     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS storage_nodes_state ON storage_nodes(state, priority);

  -- Placement: which nodes hold which blob.
  --
  -- One row per (blob, node) copy, so a blob can live on several nodes — that is
  -- what makes a node failure survivable. The blobs table keeps the refcount; this
  -- table keeps the geography. A blob row without a placement row is a bookkeeping
  -- bug, and scrub reports it rather than guessing where the bytes went.
  CREATE TABLE IF NOT EXISTS blob_placements (
    hash        TEXT NOT NULL,
    node_id     TEXT NOT NULL REFERENCES storage_nodes(id) ON DELETE CASCADE,
    size        INTEGER NOT NULL,
    state       TEXT NOT NULL DEFAULT 'present'
                  CHECK (state IN ('pending','present','missing','corrupt')),
    verified_at TEXT,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (hash, node_id)
  );
  CREATE INDEX IF NOT EXISTS placements_node ON blob_placements(node_id, state);
  CREATE INDEX IF NOT EXISTS placements_hash ON blob_placements(hash);
`)



/**
 * The search index schema, in one place.
 *
 * Three FTS5 properties make a second copy of this definition dangerous:
 *
 *   1. `snippet(table, 4, ...)` and `highlight(table, 4, ...)` address columns by
 *      **index**, and passing a column *name* as a string does not fail — it
 *      silently resolves to column 0. Having exactly one array that knows the
 *      order is the only way `BODY_COLUMN` cannot drift away from the DDL.
 *   2. The DDL exists once, in `SEARCH_INDEX_DDL`: the create path and the
 *      migration path both use it, so a column cannot be added to one and not
 *      the other.
 *   3. `UNINDEXED` columns are still addressable by index, so their position is
 *      part of the contract with every caller. Treat the list as append-only.
 */
export const SEARCH_COLUMNS = Object.freeze(['node_id', 'user_id', 'workspace_id', 'name', 'body'])

/**
 * The `body` column index — what `snippet()`/`highlight()` must be given.
 *
 * This is the one number the search code needs, and it is derived rather than
 * written down, so the DDL above and the query cannot disagree.
 */
export const BODY_COLUMN = SEARCH_COLUMNS.indexOf('body')

/** Index of a search column by name; nothing should hard-code the number. */
export function searchColumn(name) {
  const index = SEARCH_COLUMNS.indexOf(name)
  if (index < 0) throw new Error('unknown search index column "' + name + '"')
  return index
}

export const SEARCH_INDEX_DDL = 'CREATE VIRTUAL TABLE node_text USING fts5(' +
  SEARCH_COLUMNS.map((column) => (column === 'name' || column === 'body' ? column : column + ' UNINDEXED')).join(', ') +
  ", tokenize = 'unicode61 remove_diacritics 2')"

/** The columns an existing FTS5 table actually has, in declared order. */
function liveSearchColumns() {
  try {
    return db.prepare('PRAGMA table_info(node_text)').all().map((row) => row.name)
  } catch {
    return []
  }
}

/**
 * Schema migration for the search index.
 *
 * FTS5 tables cannot take an `ALTER TABLE ADD COLUMN`, and the index is derived
 * data anyway: when the stored table does not match `SEARCH_COLUMNS` it is
 * dropped and the boot-time rebuild fills it again. A stale index either lacks
 * `workspace_id` (shared files silently invisible) or has a different column
 * order (snippets silently return column 0) — neither announces itself, so the
 * comparison is on the full shape rather than on one column's presence.
 */
function migrateSearchIndex() {
  const columns = liveSearchColumns()
  if (columns.join(',') === SEARCH_COLUMNS.join(',')) return false
  db.exec('DROP TABLE IF EXISTS node_text')
  db.exec(SEARCH_INDEX_DDL)
  return true
}

/** Creates the index table when absent; throws when an existing one has another shape. */
function ensureSearchIndex() {
  const actual = liveSearchColumns()
  if (actual.length === 0) {
    db.exec(SEARCH_INDEX_DDL)
    return true
  }
  if (actual.join(',') !== SEARCH_COLUMNS.join(',')) {
    throw new Error('[search] node_text has [' + actual.join(', ') + '] but the code expects [' +
      SEARCH_COLUMNS.join(', ') + ']; it is derived data — drop it and restart to rebuild')
  }
  return false
}

/**
 * Schema migration for workspaces.
 *
 * `CREATE TABLE IF NOT EXISTS` cannot add a column to a database that already has
 * the table, so the workspace columns are added explicitly and backfilled:
 *
 *   - every account gets a workspace it owns (`<name>'s drive`);
 *   - every node of that account is assigned to it;
 *   - nodes.user_id keeps meaning "owner" — every existing query stays valid, and
 *     membership decides visibility on top of it.
 *
 * The backfill is idempotent: a second boot finds the columns and the memberships
 * already in place and changes nothing.
 */
function migrateWorkspaces() {
  const columns = new Set(db.prepare('PRAGMA table_info(nodes)').all().map((row) => row.name))
  if (!columns.has('workspace_id')) {
    db.exec('ALTER TABLE nodes ADD COLUMN workspace_id TEXT')
  }
  db.exec('CREATE INDEX IF NOT EXISTS nodes_workspace ON nodes(workspace_id, deleted_at)')

  const users = db.prepare('SELECT id, name, email FROM users').all()
  for (const user of users) {
    let membership = db.prepare('SELECT workspace_id FROM memberships WHERE user_id=?').get(user.id)
    if (!membership) {
      const existing = db.prepare('SELECT id FROM workspaces WHERE owner_id=?').get(user.id)
      let workspaceId = existing ? existing.id : null
      if (!workspaceId) {
        workspaceId = randomId()
        db.prepare('INSERT INTO workspaces(id,name,owner_id,created_at) VALUES (?,?,?,?)')
          .run(workspaceId, (user.name || user.email.split('@')[0]) + "'s drive", user.id, nowIso())
      }
      db.prepare('INSERT OR IGNORE INTO memberships(workspace_id,user_id,role,created_at) VALUES (?,?,?,?)')
        .run(workspaceId, user.id, 'admin', nowIso())
      membership = { workspace_id: workspaceId }
    }
    db.prepare('UPDATE nodes SET workspace_id=? WHERE user_id=? AND (workspace_id IS NULL OR workspace_id=?)')
      .run(membership.workspace_id, user.id, '')
  }

  // A node without a workspace would be invisible to the membership checks below;
  // this catches rows written by an older version between two boots.
  const orphaned = db.prepare('SELECT COUNT(*) AS total FROM nodes WHERE workspace_id IS NULL').get()
  if (orphaned.total) {
    db.prepare('UPDATE nodes SET workspace_id=(SELECT workspace_id FROM memberships m WHERE m.user_id=nodes.user_id LIMIT 1) WHERE workspace_id IS NULL').run()
  }
}


/** Runs `fn` inside a transaction and rolls back on throw. */
export function transaction(fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const value = fn()
    db.exec('COMMIT')
    return value
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* already rolled back */ }
    throw error
  }
}

export const nowIso = () => new Date().toISOString()

/**
 * Drops tables that belonged to the retired Docs bridge.
 *
 * The bridge was removed as a feature, but an upgraded database still carries
 * `docs_accounts` (which held a bearer token for another service) and
 * `docs_links`. Leaving them would keep that token on disk while nothing reads
 * it, so the rows are dropped on boot. Idempotent: a fresh database has neither
 * table and this is a no-op.
 */
export function dropRetiredTables() {
  const dropped = []
  for (const table of ['docs_links', 'docs_accounts']) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)
    if (!row) continue
    db.exec('DROP TABLE IF EXISTS ' + table)
    dropped.push(table)
  }
  return dropped
}

// Runs after every declaration it needs: `nowIso` is a const, so calling the
// migration earlier hits the temporal dead zone.
migrateWorkspaces()
// Order matters: the index migration only needs the table to exist, and the boot
// rebuild then fills every column from the nodes table. A first boot lands here
// with no table at all, which is exactly the "shape differs" case.
if (migrateSearchIndex()) {
  console.log('[search] index table created or reshaped; it will be rebuilt on boot')
}
ensureSearchIndex()
const retired = dropRetiredTables()
if (retired.length) console.log('[db] dropped retired tables: ' + retired.join(', '))