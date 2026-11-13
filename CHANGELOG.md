# Changelog

All notable changes to Marvelous Drive are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Motion as a layer, not a garnish. Plus a structural pass over the whole repository.

### Added

- **`scripts/lib/browser.mjs`** — the one Chrome/CDP harness. Eleven check
  scripts used to carry their own copy of the same eighty lines (find Chrome,
  spawn, poll `/json/version`, open a page, speak the protocol, tally); the copies
  had drifted apart, and the drift was the bug surface. A check script is now only
  its seed data, its interactions and its assertions.
- **`scripts/run-checks.mjs`** — runs every browser check against one server and
  prints one summary. `pnpm browser-checks`.
- **`apps/web/lib/session.js`**, **`lib/runtime.js`** — the shared mutable state
  and the verb seam. They are what made splitting `app.js` possible without a
  cycle: a module reads `session` and calls `runtime`, and nothing imports
  `app.js`.

### Changed

- **`apps/web/app.js` went from 1532 lines to a shell and a boot sequence.**
  The four pages moved to `lib/views.js`, the handler table to `lib/context.js`,
  the row verbs to `lib/actions.js`, the picker and folder plan to
  `lib/uploads.js`, and the drag gestures to `lib/dnd.js`. No behaviour change:
  the 134 web tests and all 15 browser shell checks pass unchanged.
- **`apps/server/src` is grouped by layer.** `storage/` (backend seam, blobs, s3,
  tiered, cluster, node), `text/` (office, pdf, zip), `ops/` (retention, scrub,
  audit, access-log, search-index, locks, quota, rate-limit). The directory *is*
  the rule: `storage/` knows nothing about HTTP, `text/` knows nothing about the
  database, and `routes/` is the only layer that speaks HTTP.
- **`docs/STRUCTURE.md`**, `docs/ARCHITECTURE.md` and `docs/DEVELOPMENT.md`
  rewritten around that layering; the map is the test, so it cannot silently rot.
- **`ci.yml`** calls `scripts/check-syntax.mjs` instead of an inline `find | xargs`,
  which also made the Linux and Windows gates agree.

### Removed

- **`apps/web/lib/ids.js`** — exported `uid()`, which nothing imported.
- **`apps/server/src/routes/_index.js`** — a documentation-only module whose
  route table duplicated `index.js` and had already gone stale.
- **277 MB of `.tmp`** (Chrome profiles and screenshots from past runs) and the
  crash-leftover `.part` chunk files in `data/tmp`. All of it is rebuildable.

### Fixed

- `scripts/upload-check.mjs` created its scratch file into a directory it never
  made; the check had been passing only because a previous run left the folder
  behind.


- **`styles/motion.css`** — keyframes, utilities (`.motion-rise`, `.motion-sheet`,
  `.stagger`, `.press`) and the motion contract, between the tokens and every
  component. Springs are sampled from a damped oscillator and shipped with a
  `cubic-bezier` fallback, so an engine that cannot parse `linear()` still eases.
- **`lib/motion.js`** — the same semantics on the JS side: `prefersReducedMotion()`,
  the stagger cap, `onceOnRoute()`, `withViewTransition()`, `markAnimating()`.
  No component repeats 28, 10 or 400 any more.
- **`scripts/motion-lint.mjs`** — the ten-rule static linter, vendored so CI does
  not need the skill installed. Wired into `ci.yml`.
- **`scripts/feel-check.mjs`** — 27 runtime checks a linter cannot see: a real
  pointer press shrinks a row, row 13 waits 280ms and not 364, a star toggle does
  not replay the row entrance, the view-transition flag is released, no
  `will-change` is left standing.
- **`docs/UI-MOTION.md`** — layer model, vocabulary, the ten rules, and how to add
  motion to a new surface.

### Changed

- **Press feedback everywhere it was missing.** `.btn`, `.icon-btn`, `.side-row`,
  `.frow`, `.gcard`, `.menu-item`, `.segmented button`, `.crumb` and `.user-row`
  now shrink on `:active` on the instant token. Hover changes colour; press
  changes scale.
- **Durations and curves retuned to an intent scale** — `--duration-instant/fast/
  base/slow` at 80/140/220/320ms, replacing `--dur-fast`/`--dur`/`--ease`. The
  old names are gone rather than aliased: an alias keeps a second vocabulary
  alive, and the whole point is that there is one.
- **Overlays present and dismiss properly.** Dialogs spring from `scale(.97)`,
  drawers slide from the inline end, menus arrive from the edge they are anchored
  to, and all three play a 140ms exit before unmounting instead of vanishing.
  A toast is removed on `animationend`, not on a guessed 200ms.
- **One entrance per navigation.** The `.view` column cross-fades through View
  Transitions when the route token changes; a local re-render paints plainly. On
  first paint the rows stagger, and the root keeps `.motion-enter` until the
  **last** row settles.
- **The hard-coded hex hover borders** (`#434a56`) are gone; hover uses
  `--border-strong`.

### Fixed

- **Staggered rows could flash.** The entrance class used to be removed on the
  root's own `animationend` at 220ms, while row 10 was still waiting out its
  280ms delay. Removing the class cancels those rows mid-flight, and a cancelled
  animation has no fill — they snapped back to `opacity:0`. The class now lives
  until the last row settles.
- **A loading skeleton consumed the page's entrance.** Recording the route token
  while the skeleton was up made the real content count as "already entered", so
  the first list never animated.
- **`.skip-link` and the upload progress bar transitioned layout properties**
  (`top`, `width`). Both are transforms now: the skip link slides in, the bar
  scales from the left instead of relayouting a row several times a second.
- **The reduced-motion block killed every entrance.** A document-wide
  `animation:none !important` cancelled in-flight animations, which have no fill,
  so elements blinked before settling. Durations collapse in `tokens.css` instead,
  and only looping animations are slowed here.
- **The search field painted two focus rings** — the wrapper's `box-shadow` plus
  the inner input's outline, the inner one covering the `/` hint.

## [0.19.1] - 2026-11-13

An update that can read a private release, and one that does not copy the whole
drive onto the same disk to do it.

### Fixed

- **The API read the release manifest anonymously.** `readManifest()` sent no
  Authorization header while `update-agent.mjs` sent `UPDATE_MANIFEST_TOKEN`, so
  a private repository answered 404 to the API's own check and the account menu
  reported "已是最新" forever — even though the agent, which does send the token,
  would have applied the release. `DRIVE_UPDATE_MANIFEST_TOKEN` is now read in
  `config.update` and travels on that request, and a test asserts the header.

### Changed

- **The pre-update data tarball is opt-in.** `scripts/deploy/update.sh` tarred
  the entire store into `./backups` on every update — the same disk the store
  lives on. On a deployment holding 71 GB of blobs that produced a 71 GB tarball
  and drove free space from 110 GB to 39 GB while eight containers were running.
  The config snapshot (`.env`, compose files, `package.json`) is still taken
  unconditionally and is still what a rollback restores; the data tarball now
  needs `BACKUP_DATA=1` and, even then, refuses unless twice the store plus a
  gigabyte is free, saying so instead of filling the disk.
- **Both backup retentions are bounded.** A run leaves a `pre-update-<stamp>` set
  and a `data-<stamp>.tar`, and nothing deleted them: one deployment reached 61
  files and 21 MB in a month. `BACKUP_KEEP` (default 5) keeps the newest sets and
  drops the rest.
## [0.19.0] - 2026-11-13

Releases, and a deployment that can move to one without being ssh'd into.

### Added

- **`release/latest.json`** — the manifest a deployment checks: version, image
  tag, release URL. Committed so the repository shows what the running deployment
  should be, and republished by the Release workflow as a release asset so an
  instance can read it without cloning.
- **`apps/updater/update-agent.mjs`** — the one container allowed to hold
  `/var/run/docker.sock`. It rewrites the image tag from the manifest, runs
  `scripts/deploy/update.sh`, and reports progress on `/status` for the client to
  poll. The API forwards to it and never holds the socket itself.
- **`scripts/deploy/update.sh`** — pull, recreate, health-gate, roll back. The
  previous compose files and `.env` are copied to `backups/` before anything
  changes, so a failed health check is a restore and one recreate, not a hand
  repair.
- **`scripts/deploy/backup.sh`** — the data snapshot the update takes first.
- **`GET /api/v1/system/update-check`** — current vs. published version. Needs no
  account, so the login screen can show it too.
- **`POST /api/v1/system/update`**, **`GET /api/v1/system/update-status`** —
  workspace admin only. The POST answers 200 with `started: false` when there is
  nothing newer, rather than restarting the stack for no change.
- **Account menu → 软件更新** (`apps/web/lib/updates.js`) — versions, release notes
  link, and the update button; the panel polls to a terminal state because a
  silent no-op is indistinguishable from a broken button.
- **`apps/server/src/release.js`** — manifest validation and numeric version
  comparison. The manifest is untrusted input from the network: a malformed one
  degrades to "no update", never to a 500.
- **`docs/RELEASING.md`** — cadence, the four files a version bump touches, what
  runs after **立即更新**, and how to roll back by hand.

### Changed

- **`docker-compose.yml`** — `drive` pulls `DRIVE_IMAGE` (falling back to a local
  build), and a second `updater` service mounts the Docker socket and the
  compose project. The drive's health check moved into compose so the update
  script can rely on it.
- **`.env.example`** — the release/self-update block, with the token generation
  command next to the variable that needs it.
- **`.github/workflows/release.yml`** — one multi-arch (amd64 + arm64) image
  instead of two, and the manifest is written and attached to the release.
- **`apps/server/src/config.js`** — the three `DRIVE_UPDATE_*` variables, read in
  one place like every other setting.

### Fixed

- **`compareVersions` is numeric.** `'0.9.0' > '0.10.0'` as strings, which would
  have offered a downgrade as an upgrade.

## [0.18.0] - 2026-11-13

Several machines' disks as one drive.

### Added

- **`DRIVE_STORAGE=cluster`** — a coordinator plus N storage nodes. The coordinator
  keeps metadata, refcounts and placement in SQLite; a node keeps bytes and knows
  nothing else (no database, no users, no folders), which is what makes it safe to
  put on a machine you do not fully trust.
- **`apps/server/bin/storage-node.js`** — the standalone node process. Four blob
  verbs plus `/health`; `PUT` verifies the sha256 against the key it was sent under
  and deletes what it wrote on a mismatch, so a mis-keyed blob can never be served
  under a name that lies. `Range` works, so a resume works.
- **`DRIVE_CLUSTER_WRITES`** — how many nodes must hold the bytes before an upload
  is acknowledged. If fewer have room the upload fails with
  `INSUFFICIENT_REPLICAS` instead of succeeding with a weaker guarantee.
- **`mdrive node` / `mdrive cluster`** — list/probe/enrol/update/remove nodes, and
  `cluster status` + `cluster replicate` to report and repair under-replication in
  bounded passes.

### Fixed

- **The coordinator lost every node token on restart.** Tokens were held in memory,
  so one `systemctl restart` left the whole cluster unusable with "No runtime token
  for node". They are now sealed with AES-256-GCM under the coordinator key:
  presentable on every request (a hash would be useless here), but not readable
  from a database dump. Rotating `JWT_SECRET` invalidates them on purpose —
  `mdrive node verify` re-adopts one by proving it against the node itself.
- **A whole tree could have landed on one machine after raising `writes`.**
  `putFromFile` short-circuited on "the blob exists", so a drive that once ran with
  `writes=1` stayed single-replica forever after the operator raised it. It now
  tops up the missing replicas instead of skipping.
- **An upload could report success before its bytes were read.** `fetch` resolves
  when the response arrives, not when the request body has drained; the spool file
  could be deleted while still being read. The byte stream is now awaited to
  `close` (bounded, and tolerant of a node that answers early).
- **`NODE_NOT_EMPTY` was reported as a folder name collision.** The generic 409
  branch in the CLI blamed "a node with that name already exists in the target
  folder", sending the operator to the wrong problem entirely.
- Declared capacity is no longer erased by a node reporting `0`: `0` means "not
  declared", not "no space".

### Measured

Verified end to end against real processes: one node serving a 70 GiB-capable
tree, `writes=2` placing a blob on both boxes, killing a node while its files
stayed readable from the survivor, and the replicate sweep taking an
under-replicated blob to `after: 0`.

## [0.17.0] - 2026-11-13

Folder sync, decided by content.

### Added

- **`mdrive sync LOCAL_DIR REMOTE_PATH`** — keeps a local folder and a drive
  folder in step. The comparison is sha256 against the remote `blobHash`, never
  mtime: a photo library's mtime is its EXIF capture time, so a file copied in
  today still reads as "shot in 2012", and only a hash answers "is this the same
  photo".
- **A baseline** at `~/.config/mdrive/sync/<key>.json`, one per (server, local
  root, remote path) triple, recording `{sha256, size, remoteId, version}` per
  relative path. It is what separates "I changed this" from "someone else did";
  without it a first run adopts identical files and refuses to guess.
- **Conflicts are reported, never resolved.** A path changed on both sides is
  listed and left untouched — uploading loses the remote edit, downloading loses
  the local one, and neither is a decision a tool gets to make on a photo library.
- `--dry-run` prints the plan, `--direction up|down|both` restricts what may
  move, `--delete` opts into propagating deletions, `--rehash` ignores the local
  size+mtime cache.

### Fixed

- **A whole tree could flatten into the remote root.** `ensureRemoteFolders` was
  written but never called, so every subdirectory file uploaded with
  `parentId=null`: each upload reported success and the drive ended up with a flat
  pile. The regression test asserts the folder order *and* the `parentId` the file
  upload actually received, because the bug was invisible while the transfer layer
  could not be observed — `executePlan` now takes injectable transfers for exactly
  that reason.
- `baseline-desync` was unreachable: `both-changed` always fired first. The branch
  is now an explicit conflict so a future change to the table cannot make a
  mismatch vanish from the report.

### Measured

Dry-run over the real library (11 374 files, 70.9 GiB): 93.8 s to hash everything
and print the plan. The second run is a no-op, which is how a sync earns trust
before it is allowed to move bytes.

## [0.16.0] - 2026-11-12

The Docs bridge is gone. This is a standalone drive.

### Removed

- **The entire Docs integration**: `docs-client.js`, `routes/docs.js`, the nine
  `/api/v1/integrations/docs/*` endpoints, the `mdrive docs` command group, the
  web Docs panel and its drawer, the `docsLink` field on every node payload, the
  `DOCS_SERVER_URL` / `DOCS_TOKEN` configuration, and the `docs_accounts` /
  `docs_links` tables. `docs/ECOSYSTEM.md` went with them.

### Changed

- **The boot drops the retired tables.** `dropRetiredTables()` runs after the
  migrations and removes `docs_accounts` and `docs_links` when they exist. This
  is not tidiness: `docs_accounts.token` held a bearer token for another service,
  and leaving it on disk while nothing reads it is a liability, not a leftover.
  Idempotent, and it logs what it dropped.
- **Tests assert the absence, not just the happy path.**
  `docs-removal.test.js` checks four separate claims: no source file imports the
  client, only the migration names the tables, all nine retired routes answer
  `404 NOT_FOUND` (a half-registered group would answer `401`), and a node
  payload has no `docsLink`. A removed feature that still answers is worse than
  one that never existed.
- The docs-drift test now enumerates `docs/*.md` from the directory instead of a
  hard-coded list — that list was itself the reason the suite failed once
  (`ECOSYSTEM.md` gone, still asserted). A new case checks that every file named
  in `STRUCTURE.md` exists.
- `scripts/smoke.mjs` replaced its bridge check with content search and index
  coverage; `scripts/browser-check.mjs` dropped the panel block. 20 checks pass
  against a live server.

### Fixed

- **`403` and `409` error codes in the docs.** `CONTRACT.md` and `API.md` listed
  `DOCS_NOT_CONNECTED` and `502 DOCS_UNAVAILABLE`; the tables now describe the
  codes the server actually emits (`DRIVER_UNSUPPORTED`, `LOCKED`, `FORBIDDEN`).

## [0.15.0] - 2026-11-11

Search you can trust, and PDFs in it.

### Added

- **PDF text indexing.** A PDF was previewable from day one and invisible to
  search, so "which file mentions INV-2026-0042?" had no answer when the answer
  was a contract. `pdf-text.js` reads a PDF without a dependency: it finds objects
  by scanning for `N G obj` (a stale xref is common in repaired and linearised
  files), inflates `/FlateDecode` streams in both zlib and raw spellings, resolves
  each font's `/ToUnicode` CMap so a CJK PDF decodes to real characters instead of
  a wall of glyphs, and decodes simple fonts as WinAnsi. `Tj`/`TJ`/`'`/`"`
  produce text, `Td`/`TD`/`T*`/`ET` produce the line structure a snippet needs.
  Ceiling: 24 MiB (`MAX_PDF_INDEX_BYTES`), every loop bounded.
- **Honest refusals for the unreadable ones.** An encrypted PDF is recorded as
  `encrypted` and a scan as `no-text`, not as a silent hole. `index_skips` gains
  `pdf-too-big`, `encrypted`, `unreadable`; coverage still reaches "up to date"
  *and* says why a file is not searchable.
- **`search-snippet.test.js`.** The `snippet()` trap is now pinned from both
  sides: the test asserts that FTS5 still silently returns column 0 for a column
  *name* (so the guard is still warranted) and that the query our code runs
  returns the matching sentence instead of a UUID.

### Changed

- **The index schema has one definition.** `SEARCH_COLUMNS` and
  `SEARCH_INDEX_DDL` in `db.js` are the only place that knows the column order;
  `BODY_COLUMN` is derived from the list instead of a literal `4`, and
  `migrateSearchIndex()` compares the whole shape rather than checking for one
  column. A table with the right columns in the wrong order is now treated as
  stale — that is the failure mode that produces wrong output with no error.
- `office-text.js` grew `isContainerDocument`/`containerIndexLimit`/`pdfText`, and
  `indexNode` routes every container document through one branch instead of
  treating OOXML as the only special case.

### Fixed

- A PDF whose text lives in an uncompressed stream, a multi-page file, and a
  two-byte Type0 code decoded with the wrong width (each produced `no-text`
  silently during development) are all covered by tests now.

## [0.14.0] - 2026-11-11

Search that respects the workspace.

### Added

- **`workspace_id` on the search index.** A member's upload into my folder is now
  findable by me: the query matches rows I own *or* rows in a workspace I belong
  to, and the FTS table carries the workspace so it can answer that at all.
- **Index migration.** FTS5 tables cannot take `ALTER TABLE ADD COLUMN`, so an
  index that predates workspaces is dropped and rebuilt on boot (it is derived
  data); the boot log says so instead of silently hiding shared files.

### Fixed

- **`snippet()` was reading column 0.** It addresses columns by index, and a
  string name silently falls back to the first column — so every content hit
  showed the node id instead of the matching sentence. The column index is now
  named (`BODY_COLUMN = 4`) with a comment explaining the trap.
- The search route re-fetched each hit with `user_id = caller`, throwing away the
  shared hits the index had just found. It now applies the same visibility rule as
  a direct read.
- `indexNode` trusted `node.workspace_id` from its caller; it now reads the
  workspace from the row, because routes pass a `nodeJson` that may not carry it.

## [0.13.4] - 2026-11-11

Writing into a shared folder, and the listing bug that hid it.

### Added

- **`mdrive upload --to PATH --workspace ID`** — a member can write into a folder
  it can see but does not own, by path. Verified end to end: the member uploads
  into `/team` of the owner's drive and the owner sees the file.

### Fixed

- **A member's file was invisible inside the folder it was written into.** Listing
  a folder filtered by `user_id`, so the owner opening their own folder did not see
  the member's upload — the file existed and was readable by id, but the tree lied.
  Inside a folder, visibility now follows the folder's workspace; the root listing
  stays personal.
- The new CLI test had to run the scoped upload first: the unscoped one creates a
  file literally called `team` at the root (a destination that is not visible
  becomes a rename), which then made the scoped run refuse with "--to must be a
  folder".

## [0.13.3] - 2026-11-11

A member can finally *find* the workspace it was added to.

### Added

- **`GET /api/v1/workspaces`** — every workspace the caller belongs to, with
  `active`, `role` and per-workspace file/folder/byte counts. `/workspace/members`
  only ever reported the *active* one, so a member had no way to learn the id it
  needed for `?workspace=`.
- **`mdrive team --all`** — the same list, with the id column and a `*` on the
  active one. `mdrive team` alone is unchanged (members of the active workspace).
- **`mdrive cat --workspace ID`** — a path is now resolvable inside a shared
  workspace. Verified end to end: a member reads `/team/team-note.md` from the
  owner's drive, and the same path without the flag correctly fails because it is
  not in the member's own tree.

### Changed

- `resolvePath` / `requirePath` / `resolveFileNode` take an optional workspace
  scope, so path resolution and listing agree on what tree they are walking.

## [0.13.2] - 2026-11-11

Workspace scope in the CLI, and a real bug in the root listing.

### Added

- **`mdrive ls --workspace ID`** and **`mdrive tree --workspace ID`** — the shared
  tree is reachable from a script. The scope is threaded through the recursive
  walk too, otherwise a tree would silently collapse to the caller's own files one
  level down.
- `mdrive team` prints the workspace id, so the flag has an input without needing
  `--json`.

### Fixed

- **`mdrive ls` at the root listed every file at every depth.** It omitted
  `parentId`, and the API treats an absent `parentId` as "the whole tree" — so the
  root looked like a flat dump of the entire drive. It now sends `parentId=root`,
  which is what the contract documents for the root level.
- The tree fixture test expected `plan.md` to be the last child of `Projects`
  while `chart.png` sorts after it; the assertion now matches the fixture.

## [0.13.1] - 2026-11-11

Membership from the terminal.

### Added

- **`mdrive team`**, **`mdrive team add EMAIL`**, **`mdrive team remove EMAIL`** —
  the same three operations the web panel offers, for scripts. The refusals are
  surfaced as themselves: an unknown e-mail is `404 NOT_FOUND`, removing the owner
  is refused before the request is sent, and removing a non-member says which
  e-mail was not found.
- Seven CLI tests against the mock server, including the owner-removal refusal.

### Fixed

- The command module's multi-line help strings were written with a literal `\n`
  inside a single-quoted string, so the file did not parse. They are array joins
  now.

## [0.13.0] - 2026-11-11

The team panel, and a workspace scope for the file list.

### Added

- **`GET /nodes?workspace=<uuid>`** — the listing can now span a whole
  workspace. Omitted, it is exactly the old "my nodes" query, so the personal
  view cannot regress; a workspace the caller does not belong to answers an empty
  list rather than an error. `?trash=1` composes with it.
- **Team panel** (`apps/web/lib/workspace.js`) — the account menu opens the member
  list: owner and admin badges, join times, add a member by e-mail (admin only),
  remove a member (never the owner).
- `promptDialog` gained `type` and `placeholder`, which is all an e-mail prompt
  needed on top of the name prompt.
- **`scripts/team-check.mjs`** — five browser checks on the panel.

### Notes

- A file joins a workspace by being written *into* it: a member uploading into a
  folder the owner created stays in that workspace, while their own files stay in
  their own drive. `workspace-scope.test.js` pins both halves.

## [0.12.0] - 2026-11-11

Workspaces: the last roadmap item, and the one that changes the data model.

### Added

- **`workspaces` + `memberships`** with an idempotent migration that gives every
  existing account a workspace it administers and assigns every node to it. The
  migration runs on boot and is safe to repeat.
- **Membership visibility**: a node is readable by its owner *or* by any member of
  its workspace — without that the memberships table would be decoration.
- **One namespace per folder**: name collisions, `uniqueName` and the
  "does this file exist" lookup now span the folder instead of the owner, so a
  shared folder cannot grow two identical-looking rows.
- **`GET/POST /workspace/members`, `DELETE /workspace/members/:id`** — add an
  existing account by e-mail (there is no mail delivery, so an invite is
  immediate), remove a member, never the owner.
- `user.workspace` (`{ id, name, ownerId, role }`) on every auth response.

### Fixed

- **The active workspace was whichever membership was oldest.** A member of
  someone else's workspace would resolve *to that workspace* and act as a member
  instead of an admin of its own — every invite and every listing would target the
  wrong drive. The order is now owner-first, then oldest.
- `getNode`, `findFileByName`, `childrenCount` and `assertNameFree` all filtered by
  `user_id` only, so a shared folder would have shown members an empty directory.

## [0.11.0] - 2026-11-11

Advisory edit locks — the last "partial" item on the roadmap.

### Added

- **`apps/server/src/locks.js`** and three routes (`GET/POST/DELETE
  /api/v1/nodes/:id/lock`). A lock says "someone is editing this"; it is not a
  write barrier, because refusing an upload over a stale tab would turn a courtesy
  into data loss — `expectedVersion` is what prevents lost updates.
- Locks **expire** (15 min default, 8 h max, renewable), so a crashed client
  cannot hold a file until a human notices.
- A live lock held by another user answers `409 LOCKED` with the holder named in
  the message, and `force: true` takes over — recorded as `lock-takeover` in the
  audit log.
- The preview drawer claims the lock while it is open and releases it on close,
  showing a banner when another window is editing. `node.lock` is embedded in the
  node payload so a client can know before it starts.
- **`scripts/lock-check.mjs`** — six browser checks covering the second-window
  case end to end.

### Fixed

- **The lock did not catch its own motivating case.** Two windows of the same
  account extend the lock silently, so the second tab never learned anything. It
  is still never blocked (it is the user's own file), but the lock now moves to the
  newest client and reports `supersededClient`, which the drawer names.
- `GET /nodes/:id` did not expose the lock at all, so a client had to make a second
  request to find out.
## [0.10.0] - 2026-11-11

Hot and cold tiers, actually wired: the last half of the storage story.

### Added

- **`TieredBackend`** (`apps/server/src/tiered-backend.js`) — hot bytes on local
  disk, cold bytes in an object store, behind the same interface. Writes land hot;
  reads consult local first and fall through to cold; `link()` is free for hot
  blobs and a download for cold ones.
- **Verified demotion** — `migrateToCold()` copies, **rehashes**, and only then
  deletes the source. A mismatch leaves everything in place and reports
  `checksum-mismatch`; an interrupted run is safe to repeat.
- **`DRIVE_STORAGE=tiered`** with `DRIVE_COLD_AFTER_DAYS` and the cold bucket /
  prefix settings.
- **`POST /api/v1/maintenance/storage/demote`** and **`mdrive tiers --demote`** —
  the hot/cold report can now be acted on, bounded by `limit` per run.
- **`scripts/tiered-check.mjs`** — ten end-to-end checks against the
  signature-verifying fixture: upload, confirm hot, demote, confirm the local copy
  is gone, then read and range-read the same file back through the object store.

### Fixed

- `TieredBackend.get()` was `async`, so it returned a Promise of a stream and
  every `for await (const chunk of store.get(key))` failed. It is a normal method
  whose lazy stream does the tier lookup now.

### Notes

- Recency and tier are deliberately different signals: reading a cold blob makes
  the report stop calling it idle, but does not move the bytes back to disk unless
  `promoteToHot()` is called.

## [0.9.1] - 2026-11-11

The S3 driver, actually proven end to end.

### Added

- **`scripts/s3-fixture.mjs`** — a small S3-compatible server that **recomputes
  SigV4 from the wire** and answers `403` with the canonical request when a
  signature is wrong. Docker Hub was unreachable, and a stub that ignores the
  `Authorization` header would only prove a request can be built, not that it is
  signed correctly. Supports PUT/GET/HEAD/DELETE plus `Range` (`206`/`416`).
- **`scripts/s3-check.mjs`** — eleven checks that boot the fixture and the real
  server together on `DRIVE_STORAGE=s3`: upload into the bucket, download, range,
  text preview, content search over a remote blob, ZIP assembly, purge removing
  the object, and the reported driver name. Part of the suite now.

### Verified

- An unsigned request and a mis-signed request both get `403` from the fixture, so
  a green run means the signature is genuinely checked.
- `docs/STORAGE.md` documents the fixture as the way to test without Docker.

## [0.9.0] - 2026-11-11

An S3 backend, written without a dependency.

### Added

- **`S3Backend`** (`apps/server/src/s3-backend.js`) — any S3-compatible store
  (AWS, MinIO, R2, B2) behind the existing seam. `DRIVE_STORAGE=s3` plus endpoint,
  bucket, region and credentials; the boot log says which driver is live, and a
  missing configuration fails at boot rather than at the first upload.
- **Hand-written SigV4** (`signRequest`) — canonical request, string-to-sign and
  the four chained HMACs, with RFC 3986 encoding as AWS expects it. The canonical
  request is asserted byte for byte against the worked example in the AWS
  documentation, because S3 answers a wrong signature with a bare `403`.
- **`docs/STORAGE.md`** — driver comparison, the MinIO recipe, what changes on
  S3, and the three SigV4 details that are easy to get wrong.

### Fixed

- **Streaming uploads to S3 failed with `400`.** `fetch()` refuses a stream body
  without `duplex: 'half'`, and the signature needs a `content-length` that a
  `ReadStream` does not carry — `put()` now takes the length from `stat()`.
- The driver test asserted the local sharded layout (`<xx>/<hash>`) for S3 keys;
  S3 is flat, so the key is `<prefix>/<hash>`.

### Notes

- `link()` on S3 downloads instead of hard-linking, so ZIP assembly is slower
  there. `path()` throws, and `seam.test.js` keeps routes from depending on it.

## [0.8.1] - 2026-11-11

Finishing the storage seam: no module outside the backend assumes a blob is a
local file any more. This is the prerequisite for an S3/MinIO backend.

### Changed

- **Every stored-content read goes through the backend.** Text preview, Office
  extraction, the Docs push path, the search indexer, retention purge, ZIP
  assembly (both the CRC pass and the byte pump), the public single-file share
  download and the upload-existence probe now call `backend.get()`,
  `backend.stat()`, `backend.remove()` or the new `readBlobBuffer()`.
- `sendBlob()` accepts extra headers and an `acceptRanges` switch, so the
  thumbnail route could move onto it while staying a single 200 response.
- The thumbnail route no longer stats a filesystem path; it asks the backend and
  streams, which also means thumbnails now count as an access for the hot/cold
  report (they already called `touchBlob`, this keeps it symmetric).

### Added

- **`seam.test.js`** — a static guard: no module outside `storage-backend.js`,
  `blobs.js` and `scrub.js` may call `blobPath()`, and no route may open a
  `createReadStream` on stored content. Both violations work today, which is why
  only a test keeps them from creeping back before a second backend exists.
- `readBlobBuffer(store, key)` — the one helper for paths that must parse the
  bytes anyway (preview, extraction, indexing). Downloads still stream.

## [0.8.0] - 2026-11-11

The storage seam that tiering needs (roadmap P2-7), plus a backup fix.

### Added

- **Storage backend interface** (`apps/server/src/storage-backend.js`) —
  `put / get / stat / remove / link / path`, with `LocalBackend` as the only
  implementation. `blobs.js` now owns refcounting and the database but no layout;
  a second tier or an S3 backend can be dropped in without touching a route.
- **`sendBlob()`** in `http.js` — streams a key from the backend with full
  `Range` support (middle, suffix and open-ended ranges, `HEAD`, empty files),
  dropping the bytes before `start` instead of buffering them.
- Downloads, share downloads, version downloads, checksum verification, quarantine
  and orphan reclaim all go through the seam.
- `GET /api/v1/maintenance/storage/backend` reports what is actually serving the
  bytes.

### Fixed

- **Backups dropped the quarantine directory.** Blobs that failed verification are
  evidence, and `scripts/backup.mjs` only archived `drive.db`, `.jwt-secret` and
  `blobs`; `quarantine` is now included.

## [0.7.0] - 2026-11-10

The two storage items that were still "partial" in the roadmap: corruption you
can find, and files you can decide to archive.

### Added

- **Checksum verification** (`verifyChecksums`) and
  `GET /api/v1/maintenance/blobs/verify?limit=&maxBytes=` — rehashes blobs and
  compares each file with the name it is stored under. It is the only check that
  can see silent corruption: a blob can be the right size and still be wrong.
  Sliced by `limit` so a large store is checked across several runs, and the
  response reports `remaining`.
- **Quarantine** — `POST /api/v1/maintenance/blobs/quarantine` moves a corrupt
  blob into `data/quarantine/<hash>.<ts>` and drops its row, so the affected file
  answers `404` instead of serving wrong bytes. The bytes are kept as evidence.
- **`mdrive verify [--limit N] [--fix]`** — the operator surface for both.
- **Hot/cold reporting** (`blob_access` table, `accessReport`) and
  `GET /api/v1/maintenance/storage/tiers?days=` — records at most one access row
  per blob per day on download, then reports hot bytes versus cold bytes, with the
  biggest cold files first. `mdrive tiers [--days N]` prints it.

### Notes

- Tiering stops at reporting on purpose: actually moving bytes needs a second
  storage backend (roadmap P2-7), and a half-migrated store is worse than a
  reported one.

## [0.6.2] - 2026-11-10

Knowing whether search is telling the truth.

### Added

- **Index coverage** (`indexCoverage()`) and `GET /api/v1/maintenance/search` —
  reports `{eligible, covered, refused, missing}` plus `upToDate`. `stats.search`
  exposes the same numbers per account, and the search page warns
  "另有 N 个文件还没有建立索引" instead of presenting an empty result as final.
- **`POST /api/v1/maintenance/search/reindex`** and `mdrive index [--reindex]` —
  rebuild every account's index without restarting the process.
- **`index_skips`** — every file the indexer examined and refused (`not-text`,
  `binary`, `empty`, `no-text`, `office-too-big`) is recorded with its reason.

### Fixed

- **`upToDate` could never be true.** A refused file looked exactly like a file
  that had never been indexed, so a fully rebuilt drive still reported a gap
  (10 files after a reindex, 38 before). Refusals are now accounted for
  separately: `eligible = covered + refused + missing`.
- **A node without content was never examined**, so a file created with
  `POST /nodes` and never uploaded left a permanent gap. It is now recorded as
  `empty` rather than silently missing.

## [0.6.1] - 2026-11-10

Two holes in 0.6.0's search.

### Added

- **Office documents are indexed** (`apps/server/src/office-text.js`) — the text
  of `.pptx`/`.docx`/`.xlsx` (up to 16 MiB) is flattened from the existing
  extractor and stored in the body index, so a deck is findable by a phrase on
  one of its slides. The projection is one-way: search never influences preview.

### Fixed

- **Numbers and words glued to Chinese were unfindable.** FTS5's `unicode61`
  tokeniser keeps 于1765年 as a single token, so searching `1765` returned
  nothing — a real deck ("由黑格尔于1765年提出") was invisible. Content search now
  merges FTS results (ranked, with snippets) with a `LIKE` scan (the superset),
  de-duplicated, FTS first.

## [0.6.0] - 2026-11-10

Search that answers "which file mentions this?".

### Added

- **Content search** (`apps/server/src/search-index.js`) — an FTS5 virtual table
  over the text of indexable files, kept in sync on upload, overwrite, instant
  upload, rename, trash, restore and purge. `GET /search?scope=all|name|content`
  unions name and content hits, ranking names first, and each content hit carries
  a snippet. The index is derived data: it is rebuilt on boot when empty, and a
  failed index write never fails the upload that caused it.
- **Snippets in the web client** — the search page says how many results matched
  *inside* a file and lists the matching sentences under the result rows.
- **`mdrive search --scope`** — name, content or both; a content hit is marked
  `(内容)` in the table and `matched: 'content'` in `--json`.

### Fixed

- **Chinese content search did not work**: FTS5's `unicode61` tokeniser treats a
  run of CJK characters as one token, so 营收 could never match 本季度营收. Terms
  containing CJK now use a substring scan with an excerpt around the match.
- Landing directly on `/search` left the sidebar reporting 已用 0 B, because only
  the drive route fetched the storage stats.

## [0.5.0] - 2026-11-10

Version history became something you can actually use.

### Added

- **Version download** — `GET /api/v1/files/:id/versions/:versionId/content`
  streams one stored version **without touching the live file**. Restoring was
  previously the only way to see an old copy, which is a destructive answer to
  what is usually just "what was in there?". `?download=1` names the file
  `<name> (vN).<ext>`; `404` when the version belongs to another node, `410 GONE`
  when the blob is gone from disk.
- **Version drawer** — a file with history shows 历史版本 in the preview footer,
  listing each version with size and age, a download button and a confirmed
  restore. A v1 file does not show the entry at all.
- **CLI `versions` / `version download` / `version restore`** — `mdrive versions
  FILE` lists history, `version download FILE ID --output PATH` writes the old
  bytes (refusing to clobber without `--force`), `version restore FILE ID` makes
  it current. The bare `mdrive version` still prints the CLI version.

### Fixed

- Version restore now appears in the audit log (`version-restore`).
- The version list in the CLI printed "Current content is vN" through `note()`,
  which only shows at `-v`; it is a normal line now.
- `--force` on the new command needed `kind: 'boolean'` — a bare `boolean: true`
  makes the parser demand a value.

## [0.4.0] - 2026-11-10

Batch work, and the drive telling you what it has been doing.

### Added

- **Batch operations** — the selection bar gains 移动到…; `planMoves()` in
  `apps/web/lib/drag-move.js` is the single rule set shared by the dialog and the
  drag gesture, so neither can move a folder into its own subtree.
- **Cross-folder drag** — rows are draggable and the sidebar tree, breadcrumbs and
  folder rows accept them. The drop handler distinguishes
  `application/x-mdrive-node` (a move) from `Files` (an upload), which used to be
  the same code path.
- **Thumbnails** — `GET /api/v1/files/:id/thumbnail?w=` streams the original bytes
  with a long immutable cache for jpeg/png/webp (no resize: that needs a decoder
  and the dependency budget is zero), and the list shows a 32 px image with a
  200-entry object-URL cache.
- **Duplicate report** — `GET /api/v1/storage/duplicates` groups live files that
  share one blob, with wasted bytes; the account menu opens a drawer that can
  keep the first copy and trash the rest.
- **Activity log** — `GET /api/v1/audit` plus a drawer; every mutation appends a
  row after it succeeds, rows are pruned after 90 days.

### Fixed

- **Stale bundle after a deploy** — assets were served with `max-age=3600` under
  stable filenames, so a browser could run yesterday's `app.js` against today's
  API (it showed up as `drawer is not defined`). Now `no-cache` + weak ETag, with
  `static-cache.test.js` pinning it.
- The activity drawer passed a callback where `drawer()` expects an element or
  array, and its loading placeholder stayed pinned above the list.
- A trash audit entry recorded `1 node(s)` instead of the node's name.

## [0.3.0] - 2026-11-10

Making the drive behave like storage rather than a viewer.

### Added

- **Trash retention** (`apps/server/src/retention.js`) — `DRIVE_TRASH_RETENTION_DAYS`
  (default 30). The sweep runs on boot and hourly, purges whole subtrees whose
  root fell out of the window, and releases the blobs that lose their last
  reference. `POST /api/v1/trash/sweep` runs it on demand.
- **Storage report** — `GET /api/v1/storage/stats` now returns `byKind`
  (document / image / video / audio / archive / code / other, bytes and file
  counts) and `trash` (count, bytes, oldest entry, expiry). The sidebar footer
  shows the top three kinds.
- **Selection archive** — `POST /api/v1/nodes/archive { ids }` zips a mixed
  selection from any folders into one node, disambiguating same-named folders
  inside the archive. The client exposes it through the row menu's
  `下载为 ZIP` for folders and `Ctrl+Shift+D` for a selection; the archive node is
  deleted as soon as the download starts.
- **Blob integrity** (`apps/server/src/scrub.js`, owner only) —
  `GET /api/v1/maintenance/blobs` reports rows whose file is gone, files no row
  references and size mismatches; `POST .../reclaim` deletes orphan files and
  `POST .../forget-missing` drops dead rows. Rehashing every blob stays manual.


### Added (dedup, queue, quota)

- **Instant upload** — `GET /api/v1/blobs/:sha256` probes the store and
  `POST /api/v1/uploads/instant` creates the node when the bytes are already
  there, so a second copy costs zero bytes in either direction. The web client
  hashes files above 1 MiB first, and the CLI does the same with `--on-conflict`;
  both fall back silently when the probe misses.
- **Conflict policy** — `onConflict=overwrite|rename|skip` on `PUT /uploads`,
  `POST /uploads/sessions/:id/complete` and `POST /uploads/instant`; `rename`
  produces `name (1).ext`, `skip` leaves the existing file untouched and releases
  the uploaded bytes. Exposed as `mdrive upload --on-conflict`.
- **Upload queue** — concurrency capped at 3, `全部暂停 / 全部继续` (a pause keeps
  the resumable session), per-row speed and ETA, deduplicated rows marked 秒传,
  and a `localStorage` history that survives a reload without pretending to be a
  resumable upload.
- **Quota** — `DRIVE_QUOTA_BYTES` (0 = unlimited) enforced on every write path:
  from `Content-Length` before spooling, again against the stored size, and as a
  size reservation when a resumable session opens. Overwrites only charge the
  difference; the trash is never charged. `413 QUOTA_EXCEEDED`.


### Added (activity, highlighting, caching)

- **Audit log** (`apps/server/src/audit.js`, `GET /api/v1/audit`) — every
  mutation appends a row after it succeeds: upload, instant upload, overwrite,
  trash, restore, purge. The application never updates or deletes rows; they are
  pruned after 90 days by the hourly sweep. The account menu gains an 操作记录
  drawer that groups entries by day.
- **Code preview highlighting** (`apps/web/lib/highlight.js`) — a dependency-free
  tokeniser for js/ts/json/css/html/md/sh/sql/py/go/rs/java/yaml/toml. It escapes
  every token, so a file containing markup cannot execute in the drawer; unknown
  languages fall back to plain text.
- **ETag revalidation for the web bundle** — assets are served with
  `cache-control: no-cache` and a weak ETag instead of `max-age=3600`.

### Fixed

- **Stale bundle after a deploy**: stable filenames plus a one-hour max-age meant a
  browser could run yesterday's `app.js` against today's API. This surfaced as a
  `drawer is not defined` error in a freshly added feature and would have hit
  every deploy. `static-cache.test.js` now pins the contract (no long max-age, 304
  on match, new ETag when the file changes).
- The activity drawer accepted the `dialog()` footer signature (a callback) where
  `drawer()` wants an element or array; it now passes an array.
- The drawer's loading placeholder is cleared before the first row instead of
  staying pinned above the list.
- A trash audit row recorded `1 node(s)` instead of the node's name.

### Fixed (0.3.0 initial)

- `POST /api/v1/nodes/archive` answered `405` because `/nodes/:id` was registered
  first and swallowed the literal path. Literal routes now register ahead of
  captures, and `routing.test.js` walks every literal POST route to keep it that
  way.

### Tests

- New suites: `retention`, `scrub`, `archive`, `routing` (server) and
  `bundle` (client hygiene: imports resolve, file names never become markup, no
  `eval`, token stays out of the URL). 236 tests total.

## [0.2.0] - 2026-11-10

Storage-focused iteration: folders can be uploaded whole, and Office documents
finally preview.

### Added

- **Folder upload** (`apps/web/lib/folder-upload.js`) — the toolbar's upload
  button opens a menu with `上传文件` and `上传文件夹`. A picked or dropped
  directory creates its full skeleton before any bytes move, so empty folders
  survive (a plain `FileList` cannot carry one); the picked folder itself is
  created, matching desktop clients; a `409` on a folder reuses the existing one
  and keeps going; files that fail stay retryable in the queue.
- **Office preview** (`apps/server/src/zip-read.js`, `office.js`,
  `routes/office.js`, `apps/web/lib/office-preview.js`) — `GET /api/v1/files/:id/office`
  extracts `.pptx` (slides in presentation order), `.docx` (pages from the three
  Word page signals) and `.xlsx` (sheets through the workbook rels, 200×50 cap)
  with a hand-written ZIP reader and XML scanner, then the drawer renders the
  outline as slide cards or a sheet grid. No LibreOffice, no dependency.
- `scripts/folder-check.mjs` (7 checks) and `scripts/office-check.mjs` — the
  latter extracts and renders real `.pptx`/`.docx`/`.xlsx` files through the API
  and the drawer.

### Fixed

- The sidebar search box rendered its text underneath the magnifier: the input
  never carried `class="input"`, so `.search-field .input{padding-left:28px}`
  never applied. It now uses the shared field style, with right padding that
  keeps the `/` hint clear of the text.
- Numeric `.xlsx` cells showed stored binary floats (`32.799999999999997`) instead
  of the shortest round-tripping decimal the spreadsheet displays (`32.8`).
- Slides without a title placeholder no longer render `（无标题）`; the first text
  block becomes the heading, which is what decks built in PowerPoint or WPS need.

### Documentation

- `docs/ROADMAP-STORAGE.md` — a storage-only gap analysis (P0/P1/P2), every entry
  citing the file or route that proves the gap, plus the Docs/Drive boundary.

## [0.1.0] - 2026-11-10

First release: a working drive that pairs with Marvelous Docs.

### Added

- **Node tree** — folders and files per account, rename/move with cycle and
  collision checks, recursive copy, ZIP archive of a folder, star, trash with
  cascade restore and permanent purge, breadcrumbs.
- **Content-addressed storage** — blobs named by sha256 with reference counting,
  so identical uploads cost one copy and history keeps its own references.
- **Versioning** — every content overwrite appends a version; any version can be
  restored with `expectedVersion` optimistic concurrency.
- **Uploads** — one-shot `PUT /uploads` (create or overwrite) and resumable
  sessions with 8 MiB chunks, idempotent chunk retry, digest verification.
- **Downloads** — `Range` support with `206`/`Content-Range`/`Accept-Ranges`,
  inline preview for images, PDF and text, `?download=1` for attachments.
- **Sharing** — public links with optional password, expiry and download budget,
  a public page at `/s/<token>`, and single-file reads inside shared folders.
- **Search and stats** — case-insensitive name search with LIKE escaping, storage
  counters, health and version probes.
- **Docs bridge** — per-user Docs session, document list, import as a file, push a
  markdown file back into Docs, version-aware refresh, link management.
- **Login throttling** — ten failures per address per fifteen minutes with
  `Retry-After`, matching the Docs budget.
- **Web client** — vanilla ES modules, no bundler: login, drive with list/grid and
  drag & drop, upload queue with per-file progress/cancel/retry, preview drawer,
  share dialog, public share page, trash, search, and a Docs panel.
- **CLI** — `mdrive` with nodes, resumable upload/download, sharing, search,
  stats and the Docs bridge; `--json` output and documented exit codes.
- **Operations** — Dockerfile and Compose file, `scripts/backup.mjs` (checkpointed
  SQLite + blobs in a tar), smoke, browser and upload checks, and a syntax gate.

### Notes

- Runtime is Node 22.5+ with `node:sqlite`; there are no runtime dependencies and
  no build step.
- Documentation: `docs/CONTRACT.md` (shared contract), `API.md`,
  `ARCHITECTURE.md`, `ECOSYSTEM.md`, `SECURITY.md`, `DEVELOPMENT.md`,
  `DEPLOYMENT.md`, `STRUCTURE.md`.