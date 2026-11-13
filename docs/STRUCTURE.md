# Directory map

Where a file belongs, and what it may import. One rule, applied strictly: a
file's location answers "what does this do and what may it depend on?".

`apps/server/src` is grouped by layer, and the grouping is the dependency rule:
`storage/` knows nothing about HTTP, `text/` knows nothing about the database,
`ops/` is scheduled work, `routes/` is the only layer that speaks HTTP.

## Repository

```
apps/
  server/          Node HTTP API + SQLite + blob store
  web/             Vanilla ES module client (no bundler)
packages/
  cli/             mdrive command line client
docs/              contract, API, architecture, security, development, storage
scripts/           verification and operations (see below)
  lib/browser.mjs  the one Chrome/CDP harness every browser check imports
data/              runtime state: database, blobs, temp files (git-ignored)
```

Only `apps/*` ship processes; only `packages/*` are consumed by other code.
Neither imports the other: the CLI and the web client speak HTTP.

## `apps/server/src`

```
index.js          Process assembly: routes, static client, error mapping, shutdown
config.js         Every environment variable, resolved once; creates data dirs
db.js             Schema DDL, single SQLite connection, transaction()
router.js         Path matcher for /api/v1/nodes/:id style patterns
http.js           Error class, JSON bodies, spooling, Range responses, static files
security.js       scrypt hashing, HS256 JWT, id/token generators
auth.js           Register/login, public user shape, userFromRequest
nodes.js          Tree rules: names, collisions, moves, subtrees, trash, restore
versions.js       The only writer of version rows; blob refcounting for history
workspaces.js     Membership resolution (own drive first) + member management
admin.js          Workspace-owner check (the only role Drive has)
```

### `storage/` — bytes, and nothing above them

```
backend.js        Byte store interface + driver selection (local | s3 | tiered | cluster)
blobs.js          Content-addressed store: refcounts + database (no layout)
s3.js             S3/MinIO backend with hand-rolled SigV4 signing
tiered.js         Hot local disk + cold object store, with verified demotion
cluster.js        Coordinator: placement, replication, node transport
node.js           A node's HTTP service: verify-and-store four verbs, nothing else
```

Nothing outside this directory may call `blobPath()` or open a stream on stored
bytes — `apps/server/test/seam.test.js` is the static guard for that.

### `text/` — documents, and nothing about storage

```
office.js         OOXML → pages/blocks or sheets/rows for pptx/docx/xlsx
office-text.js    Flattens pptx/docx/xlsx and PDFs to searchable text (one-way)
pdf-text.js       Dependency-free PDF text: object scan, Flate, ToUnicode CMaps
zip.js            Stored ZIP writer (CRC32, streaming)
zip-read.js       Minimal ZIP reader (stored/deflate, zip64, bomb caps)
```

### `ops/` — scheduled and cross-cutting work

```
retention.js      Trash expiry: subtree purge plus blob release
scrub.js          Blob integrity: missing files, orphans, size mismatches
audit.js          Append-only action log with a 90 day window
access-log.js     Blob read tracking (one row per blob per day) + hot/cold split
search-index.js   Body index: FTS5 + LIKE merge, index on write, rebuild on boot
locks.js          Advisory edit locks: short TTL, takeover, audit trail
quota.js          Per-account byte ceiling, checked on every write path
rate-limit.js     Login throttle: ten failures per address per fifteen minutes
```

### `routes/` — the only layer that speaks HTTP

```
auth.js           /auth/register, /auth/login, /me
nodes.js          Tree CRUD, trash, copy, star, archive, breadcrumb, edit locks
files.js          Upload (simple), content download, versions, text preview
uploads.js        Resumable sessions: create, chunk, status, complete, delete
shares.js         Share links and the anonymous /shared/:token surface
misc.js           healthz, version, search, storage stats, audit, duplicates
office.js         GET /files/:id/office — OOXML preview extraction
maintenance.js    Blob scan / reclaim / forget-missing (owner only)
cluster.js        Storage nodes: enrol, probe, drain, replication sweep
```

Rules:

- `routes/` may import every layer below it; nothing below imports `routes/`.
- `storage/` never imports `text/`, `ops/` or `routes/`.
- Route modules receive `(ctx)` with `req`, `res`, `url`, `params`, `json()`
  and `fail()`; they never import `index.js`.
- Multi-table changes go through `transaction()`.
- Blob refcount updates live next to the row change that causes them.

`bin/` holds `storage-node.js`, the standalone node process.

`test/` holds the `node --test` suites: real server, real SQLite, real sockets.
`helpers.js` boots the process on an ephemeral port.

## `apps/web`

```
index.html        Shell: mounts #app, loads app.js as a module
app.js            Shell + boot only: router, mounted chrome, the wiring table
lib/
  session.js      The shared mutable state every other module agrees through
  runtime.js      The verbs modules call back into the shell with (breaks cycles)
  views.js        The four pages, the skeleton/error states, the status bar
  context.js      The handler table every view is handed
  actions.js      Open / rename / move / delete / restore / share / download
  uploads.js      File picker, upload menu, folder plan, batch toasts
  dnd.js          Row drags, folder drop targets, desktop file drops
  api.js          Fetch wrapper, token storage, error normalisation
  auth.js         Session state, login/register forms
  state.js        Store: current folder, selection, sort, search
  dom.js          h() element helper, mounting, keyboard helpers
  ui.js           Buttons, dialogs, toasts, menus, focus trap
  format.js       Bytes, dates, icons, markdown rendering
  files.js        File rows, breadcrumbs, drag & drop, context actions
  preview.js      Preview drawer: image, PDF, text, markdown, edit lock
  upload.js       Simple + resumable upload, sha256, progress
  upload-queue.js Scheduler singleton: concurrency 3, pause/resume, history
  queue.js        Visible upload queue with cancel/retry
  share.js        Share dialog and the public /s/<token> page
  move.js         Move dialog (folder picker)
  office-preview.js  Renders the office payload: slide/page cards, sheet grids
  folder-upload.js   Directory plans (picker, entry tree) and the skeleton-first upload
  highlight.js    Dependency-free tokeniser for the code preview
  drag-move.js    planMoves(): the rule set shared by drag and "move to…"
  duplicates.js   Duplicate report drawer
  thumb-cache.js  Bounded objectURL cache for list thumbnails
  workspace.js    Team panel: members, roles, add/remove
  sidebar.js      Sidebar tree, breadcrumbs, toolbar
  motion.js       Motion semantics on the JS side: timings, stagger cap, VT guard
styles/
  index.css       Entry: imports the layers below in cascade order
  tokens.css      Design tokens (colour, spacing, type, motion values)
  motion.css      Keyframes, motion utilities, the press/reduced-motion contract
  base.css        Reset, typography, shell geometry
  components.css  Buttons, inputs, dialogs, toasts, badges
  app.css         Drive-specific: sidebar, list/grid, preview, panel
```

Rules:

- `app.js` is the only module that writes `session`. Everything else reads.
- A module that needs to call back into the shell uses `runtime`, never an import
  of `app.js`. That indirection is what keeps the imports acyclic.
- No bundler, no CDN, no framework: only relative ESM imports and platform APIs.
- `motion.css` may only read tokens; components may only use motion utilities and
  tokens. A raw duration, curve or scale in a component is a bug — see
  [UI-MOTION.md](UI-MOTION.md).
- All user-facing strings live in the module that renders them; no i18n layer
  until there is a second language.

## `packages/cli`

```
bin/mdrive.mjs    Entry point: calls src/cli.js
src/cli.js        Dispatch loop, global flags, exit codes
src/args.js       Flag/positional parser
src/command.js    CommandDefinition + context contracts
src/config.js     Profile storage (%APPDATA%\mdrive, ~/.config/mdrive)
src/http.js       API client, streaming download, chunked upload
src/output.js     Table/JSON rendering, byte sizes, colours for TTYs
src/errors.js     CliError with exit codes
src/help.js       Usage text per command
src/naming.js     Path/URL helpers
src/sync.js       Folder sync engine: content-hash scan, plan, execute, baseline
src/commands/     auth, nodes, files, versions, share, search, sync, team, misc
                  index-cmd.js holds the `mdrive index` command (index.js is the registry)
                  team.js holds `mdrive team [add|remove]`
                  support.js owns listChildren/resolvePath, shared by ls/tree/stat
test/             node --test suites against an in-process mock API
```

## `scripts`

Every browser-driven check imports `scripts/lib/browser.mjs`: it finds Chrome,
spawns it, speaks the DevTools protocol, tallies ok/FAIL and returns an exit code.
A check script keeps only its seed data, its page interactions and its assertions.

```
lib/browser.mjs      Chrome launcher, CDP page, check recorder — the shared harness
smoke.mjs            API-level checks against a running instance
browser-check.mjs    the shell: login, list, preview, trash, share, mobile
feature-check.mjs    thumbnails, batch bar, draggable rows, duplicates drawer
upload-check.mjs     picker, 9 MiB resumable session, cancel
folder-check.mjs     a dropped entry tree keeps folders, nesting and empty dirs
versions-check.mjs   the history drawer, and its absence on a v1 file
lock-check.mjs       the advisory edit lock: claim, supersede, release
search-check.mjs     content hit, snippet, .docx text, sidebar usage
storage-check.mjs    folder ZIP menu entry, storage breakdown, archives
office-check.mjs     extracts and renders real pptx/docx/xlsx samples
team-check.mjs       the team panel lists and labels roles
feel-check.mjs       runtime motion: press, stagger cap, VT flag, replay
motion-lint.mjs      static: the ten motion rules (CI gate)
check-syntax.mjs     node --check over the whole repo
s3-fixture.mjs       S3 server that verifies SigV4 (no Docker needed)
s3-check.mjs         the whole server on DRIVE_STORAGE=s3
tiered-check.mjs     upload hot, demote, read cold
backup.mjs           checkpointed SQLite + blobs into a tar
```

## Documentation

| File | Answers |
| --- | --- |
| `CONTRACT.md` | What every endpoint returns; the shared truth for all three packages |
| `API.md` | The HTTP reference, error codes and examples |
| `ARCHITECTURE.md` | Data model, request lifecycle, consistency, security |
| `DEVELOPMENT.md` | Running, testing, conventions, adding an endpoint |
| `STRUCTURE.md` | This file |
| `STORAGE.md` | Local / S3 / tiered storage and what changes with each |
| `CLUSTER.md` | Several machines' disks as one drive: nodes, placement, replication |
| `SECURITY.md` | Threat model, auth, blob integrity, operational hygiene |
| `DEPLOYMENT.md` | Running it in production |
| `ROADMAP-STORAGE.md` | Storage roadmap and what is deliberately out of scope |
