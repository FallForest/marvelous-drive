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
release.js        Release manifest: parse, compare, pick the image tag
mime.js           Extension → MIME; a .heic is an image even when the upload
                  declared octet-stream (applied on write and repaired on read)
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
image-normalize.js HEIC frame → downscaled RGBA → PNG (box filter + node:zlib)
heif-loader.js    The only importer of libheif: lazy WASM, LGPL, fails soft
```

### `ops/` — scheduled and cross-cutting work

```
retention.js      Trash expiry (subtree purge + blob release) and session expiry
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
preview-image.js  GET /files/:id/preview-image — HEIC transcoded to PNG, cached
maintenance.js    Blob scan / reclaim / forget-missing (owner only)
cluster.js        Storage nodes: enrol, probe, drain, replication sweep
updates.js        /updates/check and /updates/apply — the update agent bridge
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
  gallery.js      Which files a picture drawer can walk, and which to prefetch
  image-cache.js  Byte-budgeted LRU of decoded bitmaps (disposes on eviction)
  image-fit.js    How big to decode: contain-fit, long-edge cap, pixel budget
  image-loader.js Route choice + createImageBitmap downsampling for one picture
  image-size.js   Reads width/height from a PNG/JPEG/GIF/WebP header
  row-action.js   What a click means: action vs. selection (see the rules below)
  preview.js      Preview drawer: image, PDF, text, markdown, edit lock
  upload.js       Simple + resumable upload, sha256, chunk lanes, retry, progress
  upload-queue.js Scheduler singleton: concurrency 3, pause/resume, history, claims
  upload-resume.js  FileSystemFileHandle store (IndexedDB) + session matching
  upload-stats.js   Batch aggregate over the queue: bytes, speed, ETA, summary
  queue.js        Visible upload queue: batch bar, rows, cancel/retry/resume
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
  select.js       Dropdowns built from the app's own menu (no native <select>)
  updates.js      The update banner: manifest read, apply, progress polling
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
- A plain click runs the row's primary action — a folder navigates, a file
  previews. Selection is the checkbox, Ctrl/Cmd-click, Shift-click or Space.
  `lib/row-action.js` is the only place that rule is written down; a row must
  never grow a second `dblclick` handler. The trash is the exception: nothing
  there is meant to be opened, so a click selects.
- Format support is a table, not a series of `if`s. `apps/server/src/mime.js`
  decides what a file *is* (the extension wins over a generic content-type),
  `lib/format.js` maps that to a row kind, and the drawer branches on the kind.
  A format the server cannot render is `opaque`: the drawer offers a download
  instead of asking an endpoint that must refuse it.
- Animated pictures (GIF/APNG/animated WebP/AVIF) bypass `createImageBitmap`:
  a bitmap is one frame, so the bitmap path would freeze the animation.
- An overlay owns the keyboard, therefore it must take focus: `trapFocus()`
  defers the focus call to the next frame (a synchronously focused detached
  panel is silently ignored, which leaves the whole panel deaf) and returns focus
  to the opener on release. A control that is "unavailable" uses
  `aria-disabled`, never the `disabled` attribute — a disabled button cannot hold
  focus, so disabling it at the end of a list drops the keyboard onto `<body>`.
- Drag and drop has one rule that keeps breaking: a drop target needs BOTH the
  three handlers and the context that carries them. `listContext()` in
  `lib/views.js` is the seam where a handler silently goes missing — the row
  guard reads `if (ctx.onFolderDragOver)` and installs nothing, so the gesture
  looks broken while the sidebar (which reads the context directly) still works.
  Every new list surface must be added to that projection, and
  `scripts/dnd-check.mjs` is what catches it.
- A picture previews as a gallery: `←`/`→` walk the pictures of the current
  view, `Home`/`End` jump to the ends, and the ends do not wrap. Every picture
  is requested from `/thumbnail` (the only route with an immutable cache
  header), decoded straight to the drawer's box, and kept in `image-cache.js`
  keyed by `blobHash`. Nothing here resizes on the server — `image-fit.js` owns
  the size decision, so a change there is a memory change, not a cosmetic one.

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
lib/args.mjs         the one "--name value" reader for the operation scripts
smoke.mjs            API-level checks against a running instance
browser-check.mjs    the shell: login, list, preview, trash, share, mobile
feature-check.mjs    thumbnails, batch bar, draggable rows, duplicates drawer
upload-check.mjs     picker, 9 MiB resumable session, batch bar, cancel
resume-check.mjs     a reloaded page claims its live session and can discard it
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
dead-code.mjs        static: unreachable modules, exports nothing imports (npm run dead-code)
s3-fixture.mjs       S3 server that verifies SigV4 (no Docker needed)
s3-check.mjs         the whole server on DRIVE_STORAGE=s3
tiered-check.mjs     upload hot, demote, read cold
backup.mjs           checkpointed SQLite + blobs into a tar
test/                node --test suites for the shared script helpers
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
