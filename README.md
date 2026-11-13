# Marvelous Drive

Self-hosted cloud drive for a single person or a small team: one tree of files
and folders, content-addressed storage, versions, resumable uploads, public
shares, full-text search over file contents, and byte-level integrity checking.
It is a standalone product — one Node process, no external database, no service
it depends on.

```
             browser / mdrive CLI
                     |
              +------+------+
              |  Node :4400 |  static web client + JSON API in one process
              |-------------|
              |  node:sqlite|  metadata: nodes, blobs, versions, shares, locks
              |  data/blobs |  content-addressed sha256 files
              +-------------+
```

## Why one process

A drive's primitives are arbitrary bytes, byte ranges, resumable transfers,
content hashing and public links. Those do not need a second service, a message
queue, or a build step: `node:sqlite` is transactional, `node:http` streams, and
`node:crypto` hashes. The whole server is the standard library, so "install" is
`node apps/server/src/index.js` and a backup is a copy of `data/`.

## Features

- **Node tree** — folders and files in one per-account tree, rename/move,
  duplicate, star, breadcrumbs, recursive folder copy, ZIP download of a folder.
- **Content-addressed storage** — every blob is named by its sha256, so an
  upload of identical bytes costs nothing and versions keep their own reference.
- **Versioning** — every content overwrite appends a version. Old versions can be
  **downloaded** without touching the live file (from the preview drawer or
  `mdrive version download`), or made current again with optimistic concurrency.
- **Uploads** — one-shot `PUT /api/v1/uploads` and resumable sessions with
  8 MiB chunks, per-chunk retry, digest verification on completion.
- **Downloads** — `Range` support (`206`, `Content-Range`, `Accept-Ranges`),
  inline preview for images/PDF/text, `?download=1` for attachment disposition.
- **Sharing** — public links with optional password, expiry, download budget, and
  a public page at `/s/<token>`.
- **Search, stats, trash** — case-insensitive name search, **full-text search over
  file contents** (text, Office bodies and PDF text), storage statistics,
  recoverable trash with cascade restore and permanent purge.
- **Instant upload** — identical bytes already in the store are linked, not
  re-sent: the client hashes first and asks the server, so a second copy costs
  nothing. `mdrive upload` does the same.
- **Quota and retention** — an optional per-account ceiling, and a trash that
  expires after 30 days (configurable) instead of growing forever.
- **Batch operations** — the selection bar moves many nodes at once, rows can be
  dragged onto a sidebar folder, and the row menu zips a folder on demand.
- **Duplicates and thumbnails** — a report groups files that share one blob so
  the copies can be dropped, and image rows show a real thumbnail.
- **Activity log** — every mutation is recorded and readable from the account
  menu, newest first and grouped by day.
- **Edit locks** — opening a file takes an advisory lock so a second window learns
  someone else is editing. It never blocks a write, and it expires on its own.
- **Workspaces** — every account owns a drive; add a second account by e-mail and
  the two share a tree. `?workspace=` widens the listing (and `mdrive ls/tree/cat
  --workspace` do the same from a terminal); files you create stay in your own
  drive, and `mdrive team --all` shows every workspace with the id to pass.
- **Folder upload** — the upload menu offers files or a whole folder; the
  directory skeleton (empty folders included) is created before any bytes move,
  and a dropped tree keeps its structure.
- **Office preview** — `.pptx`, `.docx` and `.xlsx` are extracted server-side
  (ZIP + XML, no LibreOffice) into slides/pages/sheets and rendered in the drawer.
- **Pluggable storage** — bytes live behind one interface: local disk by default,
  any S3-compatible bucket (`DRIVE_STORAGE=s3`, hand-written SigV4, no
  dependency), or both at once (`tiered`: hot on disk, cold in the bucket, with a
  verified demotion that rehashes before it deletes). See
  [docs/STORAGE.md](docs/STORAGE.md).
- **Cluster storage** — `DRIVE_STORAGE=cluster` pools several machines' disks into
  one drive: a coordinator keeps the metadata and placement, each node stores only
  bytes. Uploads are acknowledged only once `DRIVE_CLUSTER_WRITES` nodes hold
  them, reads fall through to any replica, and `mdrive cluster replicate` repairs
  under-replication in bounded passes. See [docs/CLUSTER.md](docs/CLUSTER.md).
- **Integrity and tiering** — `mdrive verify` rehashes the store and can quarantine
  corrupt blobs without deleting the evidence; `mdrive tiers` reports which files
  have not been read in months.
- **CLI** — `mdrive` covers the same surface for scripts and terminals.
- **Folder sync** — `mdrive sync ./Photos /Photos` keeps a local folder and a drive
  folder in step by comparing content hashes, not timestamps (a photo library's
  mtime is its EXIF capture time). It keeps a baseline so it can tell "I changed
  this" from "someone else did"; a path changed on both sides is reported as a
  conflict and left untouched, and deletions only propagate with `--delete`.
- **Self-update** — every release publishes `release/latest.json` and a versioned
  image. A deployment points `DRIVE_UPDATE_MANIFEST_URL` at the manifest, sees
  "0.19.0 is available" in the account menu, and **立即更新** hands the job to an
  updater container that backs up `data/`, pulls the new tag, recreates the
  container and rolls back if `/healthz` does not answer. The API never holds the
  Docker socket. See [docs/RELEASING.md](docs/RELEASING.md).
- **Zero dependencies** — the server runs on Node's standard library
  (`node:sqlite`, `node:http`, `node:crypto`); the web client is plain ES
  modules with no bundler.

## Quick start

```sh
node --version                 # 22.5+ (node:sqlite); developed on 26
node apps/server/src/index.js  # http://127.0.0.1:4400
```

Open the URL, create an account, and the drive is live. Data lives in `./data`:
`drive.db` (SQLite, WAL), `blobs/`, `tmp/`, and `.jwt-secret` (generated on
first boot).

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4400` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address; use `0.0.0.0` behind a proxy |
| `DRIVE_DATA_DIR` | `./data` | Database, blobs, temp files |
| `DRIVE_MAX_UPLOAD_BYTES` | `2147483648` | Upload ceiling (2 GiB) |
| `DRIVE_TOKEN_TTL` | `43200` | Session lifetime in seconds |
| `DRIVE_STORAGE` | `local` | `local`, `s3`, `tiered` or `cluster` — see [docs/STORAGE.md](docs/STORAGE.md) and [docs/CLUSTER.md](docs/CLUSTER.md) |
| `DRIVE_CLUSTER_WRITES` | `1` | Replicas that must hold an upload before it is accepted (`cluster` only) |
| `DRIVE_S3_ENDPOINT` / `_BUCKET` / `_REGION` / `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | — | S3-compatible store (AWS, MinIO, R2, B2) |
| `DRIVE_QUOTA_BYTES` | `0` | Per-account byte ceiling; `0` = unlimited |
| `DRIVE_TRASH_RETENTION_DAYS` | `30` | Days a trashed subtree survives before the sweep purges it |
| `JWT_SECRET` | generated | Signing secret; falls back to `data/.jwt-secret` |
| `DRIVE_UPDATE_MANIFEST_URL` | — | Release manifest; enables the in-app update check |
| `DRIVE_UPDATE_AGENT_URL` | — | Updater container, e.g. `http://updater:8080` |
| `DRIVE_UPDATE_AGENT_TOKEN` | — | Shared secret between the API and the updater |

## Project layout

```
apps/
  server/          Node HTTP API, SQLite schema, blob store, content index
  web/             Vanilla ES module client (no bundler)
packages/
  cli/             mdrive command line client
docs/
  CONTRACT.md      the API/behaviour contract all three packages implement
  API.md           HTTP reference
  ARCHITECTURE.md  module map, data model, storage and consistency notes
release/           latest.json — the manifest a deployment checks for updates
apps/updater/      the one container allowed to touch the Docker socket
scripts/deploy/    update.sh + backup.sh, run by that container
data/              runtime state (git-ignored)
```

## Testing

```sh
node --test apps/server/test/     # HTTP end-to-end: real SQLite, real sockets
node --test packages/cli/test/    # CLI: args, config, output, mock server
node --test apps/web/test/        # browser logic: routing, tree index, formatting
node scripts/check-syntax.mjs     # node --check over every .js/.mjs in the repo

node scripts/run-checks.mjs       # every browser check below, one server, one summary
node scripts/smoke.mjs            # 20 API checks against a running instance

node scripts/browser-check.mjs    # 15 checks: login, list, preview, trash, share, mobile
node scripts/feature-check.mjs    #  9 checks: thumbnails, batch bar, drag, duplicates
node scripts/versions-check.mjs   #  7 checks: version drawer, download, v1 has none
node scripts/team-check.mjs       #  5 checks: the team panel and roles
node scripts/lock-check.mjs       #  6 checks: claim, supersede, release the edit lock
node scripts/search-check.mjs     #  8 checks: content hit, snippet, .docx text, stats
node scripts/storage-check.mjs    # 10 checks: ZIP menu, selection archive, breakdown
node scripts/folder-check.mjs     #  7 checks: dropped tree, empty folder, nesting
node scripts/upload-check.mjs     # 10 checks: picker, 9 MiB session, cancel
node scripts/feel-check.mjs       # 30 checks: press, stagger cap, VT flag, drawer
node scripts/office-check.mjs --sample DIR   # pptx/docx/xlsx extraction + drawer
node scripts/s3-check.mjs                    # the whole server on DRIVE_STORAGE=s3
node scripts/tiered-check.mjs                # upload hot, demote, read cold
```

The server suites boot the real process on an ephemeral port with a throwaway
data directory. The browser checks all share `scripts/lib/browser.mjs` — one
Chrome launcher, one DevTools page, one ok/FAIL tally — so a check script is only
its seed data, its interactions and its assertions. They fail on any console
error or failed request and write screenshots to `.tmp/shots` so a regression can
be inspected instead of guessed about.

| Suite | Covers |
| --- | --- |
| `api.test.js` | accounts, tree CRUD, uploads, ranges, versions, shares, trash |
| `tree.test.js` | recursive copy, ZIP archive, restore collisions, LIKE escaping, sorting |
| `concurrency.test.js` | `expectedVersion` conflicts, blob refcount balance |
| `rate-limit.test.js` | the ten-attempt login budget and its `Retry-After` header |
| `office.test.js` | ZIP reader, OOXML extraction, the `/office` route and its errors |
| `retention.test.js` | trash expiry: subtree purge, blob refcounts, the stats report |
| `scrub.test.js` | blob integrity: missing files, orphans, size mismatches |
| `archive.test.js` | selection archiving: mixed roots, name disambiguation, trashed nodes |
| `routing.test.js` | literal paths are not shadowed by `/nodes/:id` captures |
| `audit.test.js` | the audit trail records successes and never failures |
| `static-cache.test.js` | no long max-age, ETag revalidation, 304 round trip |
| `thumbnail.test.js`, `duplicates.test.js` | image thumbnails, duplicate grouping |
| `search.test.js` | content hits, ranking, trashing, CJK, FTS query injection |
| `search-snippet.test.js` | the `snippet()` column-index trap, and snippets holding words not UUIDs |
| `pdf-search.test.js` | PDF text extraction, CMaps, encrypted/scanned refusals, PDF hits end to end |
| `index-coverage.test.js` | coverage accounting, refusals, reindex closing a gap |
| `storage-node.test.js` | the node's HTTP surface: digest verification, auth, Range, restart survival |
| `cluster-backend.test.js` | placement by free space, `writes` enforcement, top-up, replication report |

`packages/cli/test/sync.test.mjs` covers the sync decision table exhaustively —
every combination of local/remote/baseline state, plus the folder-before-file
ordering that keeps a tree from flattening into the root.