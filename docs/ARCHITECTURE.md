# Architecture

Marvelous Drive is a single Node process with three faces: a JSON API, a static
web client, and a CLI that speaks the same API. It stores bytes on disk and
metadata in SQLite. There is no build step. Core storage uses the standard
library; optional sharp/libheif codecs supply image representations.

## Processes and storage

```
browser ──┐
          ├── HTTP :4400 ──► apps/server/src/index.js
mdrive ───┘                        │
                                   ├── data/drive.db     SQLite (WAL): users, nodes,
                                   │                     blobs, versions, sessions,
                                   │                     shares, audit, locks
                                   ├── data/blobs/xx/<sha256>   immutable file content
                                   ├── data/tmp/          spool + chunk + zip scratch
                                   └── apps/web/          static client (SPA fallback)
```

Why SQLite rather than PostgreSQL: a drive is one tree per account, the working
set is small, and `node:sqlite` ships with Node 22+. `BEGIN IMMEDIATE`
transactions give the same ordering guarantees the tree needs. Online metadata
snapshots use SQLite's transactional snapshot support; complete local backups
require stopped writers so database references and blob bytes stay consistent.

## Module map (apps/server/src)

| File | Responsibility |
| --- | --- |
| `index.js` | Process assembly: router table, static hosting, error mapping, shutdown. No business rules |
| `config.js` | Every environment variable, resolved once; creates the data directories |
| `db.js` | Schema DDL (idempotent), the single connection, `transaction()`, index schema constants |
| `router.js` | Path matcher (`/api/v1/nodes/:id`), registration order wins |
| `http.js` | Error class, JSON helpers, body spooling, `Range` file responses, static files |
| `security.js` | scrypt password hashing, HS256 JWT sign/verify, id and token generators |
| `auth.js` | Register/login, `publicUser`, `userFromRequest` |
| `nodes.js` | Tree rules: names, collisions, moves, subtree walks, trash, restore |
| `versions.js` | The only place version rows are written; refcounting for them |
| `workspaces.js`, `admin.js` | Membership resolution and the owner check |
| `storage/backend.js` | The byte-store seam and driver selection (local \| s3 \| tiered \| cluster) |
| `storage/blobs.js` | Content-addressed store: adopt, retain, release, materialize |
| `storage/s3.js`, `storage/tiered.js`, `storage/cluster.js`, `storage/node.js` | The other drivers and the node process |
| `text/office.js`, `text/office-text.js`, `text/pdf-text.js` | Text extraction for OOXML and PDF |
| `text/zip.js`, `text/zip-read.js` | Streaming ZIP writer and the bomb-capped reader |
| `text/cpu-tasks.js`, `text/cpu-worker.js` | Bounded parsing/codec workers with timeout, input limits and per-task cleanup |
| `ops/thumbnail.js`, `ops/preview-source.js` | Content-addressed thumbnail cache and bounded backend reads admitted with worker slots |
| `ops/search-index.js` | FTS5 body index plus the `LIKE` merge, coverage, rebuild |
| `ops/index-jobs.js` | Durable, versioned Office/PDF indexing jobs, replay, bounded retries and read-after-upload search barrier |
| `ops/retention.js`, `ops/scrub.js`, `ops/audit.js`, `ops/access-log.js` | Scheduled and cross-cutting work |
| `ops/locks.js`, `ops/quota.js`, `ops/rate-limit.js` | Edit locks, byte ceiling, login throttle |
| `routes/*` | One module per resource: auth, nodes, files, uploads, shares, misc, office, maintenance, cluster |

The four directories *are* the layering: `storage/` knows nothing about HTTP,
`text/` knows nothing about the database, `ops/` is work that runs on a timer or
on every write, and `routes/` is the only layer that speaks HTTP.

Rules that keep it honest:

- `routes/` may import every layer below it; nothing below imports `routes/`.
- `storage/` never imports `text/`, `ops/` or `routes/`.
- Anything that touches more than one table goes through `transaction()`.
- Blob refcount changes happen next to the row change that causes them, so a
  deleted version can never leave an orphan file or a dangling hash.

## Data model

```
users ──1:n── nodes ──1:n── node_versions
  │             │
  │             ├──1:n── shares
  │             └──1:n── node_locks
  └──1:n── upload_sessions

blobs (hash PK, refs) is referenced by nodes.blob_hash and node_versions.blob_hash
```

- **Blobs** are content-addressed: the file name is the sha256 of its bytes.
  `refs` counts nodes, version rows and finished uploads pointing at it. A
  release to zero deletes the file, so garbage never accumulates.
- **Nodes** are one tree per user. `parent_id` is nullable; the unique index
  `(user_id, IFNULL(parent_id,''), name) WHERE deleted_at IS NULL` is what makes
  "no two live siblings with the same name" a database guarantee, not a check
  that can race.
- **Versions** hold the *previous* content: overwriting a file appends the old
  blob to history before the row points at the new one. Restoring re-appends the
  current content and moves the pointer back, so history is never lost.
- **Upload sessions** store their chunk directory under `data/tmp/sessions/<id>`
  and the received indexes as JSON; the row is the resume ledger.

## Request lifecycle

1. `createServer` wraps every request: security headers, CORS preflight, timing.
2. `router.match` resolves to a handler; unknown `/api/*` paths answer a JSON
   404, everything else falls through to the static client (SPA fallback).
3. The handler authenticates with `userFromRequest`, validates input, calls a
   domain module, and writes exactly one JSON response.
4. Errors: `HttpError` → its status and code; anything else is logged and
   answered `500 INTERNAL_ERROR` without leaking internals.
5. Uploads stream into `data/tmp`, are hashed while writing, and are renamed
   into the blob store only after the digest is known.

## Consistency and failure modes

- **Crash during upload** leaves a `.part` file in `data/tmp`; nothing references
  it, and it is safe to delete. Session chunks live in their own directory and
  expire after 24 hours.
- **Crash between blob and row write**: the blob is written first and the row
  second; an orphan blob is invisible to the API and reclaimed the next time the
  same bytes are uploaded (adopt path) or by deleting `data/blobs` entries with
  `refs = 0`.
- **Concurrent overwrite**: `expectedVersion` on node updates and version
  restores turns the race into `409 VERSION_CONFLICT` instead of a lost write.
- **Stale extraction**: search extraction checks the current blob/version again
  before publishing; a slow old parse cannot resurrect deleted or replaced text.
- **Interrupted document indexing**: Office/PDF writes persist a versioned job
  before returning. One job runs at a time, interrupted work resumes on boot,
  and three unsuccessful attempts remain visible as failed diagnostics. Content
  searches wait at most 15 seconds for the caller's authorized pending work;
  name-only searches and status reports remain immediate.
- **Name races**: the partial unique index rejects the loser at commit time.

The web client lists only the current directory, 100 rows at a time. A separate
folders-only index supplies navigation and move destinations; it and statistics
have a 30-second cache invalidated by mutations and session changes. Trash is
requested only in the trash view. Unpaged node listings remain available to the
CLI. Images are requested near the viewport with four concurrent client loads;
the server admits at most two CPU jobs and 32 queued jobs, with a 30-second task
deadline. Native thumbnails fit inside the requested square and are cached by
blob hash and width. Original native image content remains the drawer source.

## Security posture

- Passwords: scrypt with a per-user 16-byte salt, constant-time comparison.
- Tokens: HS256 with a 32-byte secret generated on first boot into
  `data/.jwt-secret`, 12 hour expiry, always scoped to one user id.
- Share links: 24 random bytes, base64url; optional scrypt-hashed password,
  expiry and download budget enforced on every read, not only at creation.
- Uploads: size ceiling, streamed to disk (never buffered whole), sanitised file
  names on responses, and `Content-Disposition` quoting that strips quotes and
  newlines.
- Static hosting: path traversal rejected before `stat`, only `apps/web` is
  reachable.
- Responses carry `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  no-referrer`, `X-Frame-Options: SAMEORIGIN`.

## Extension points

- **New node metadata** → add a column (migration block in `db.js`), extend
  `nodeJson`.
- **New storage backend** → `storage-backend.js` is the seam; `LocalBackend`,
  `S3Backend` and `TieredBackend` all implement the same small interface.
- **New file kind** → the CLI/web decide rendering from `mime` and the extension;
  the server stays kind-agnostic, except for the indexer, which needs an extractor
  (`office-text.js`, `pdf-text.js`) before it can search the contents.
