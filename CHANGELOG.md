# Changelog

All notable changes to Marvelous Drive are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.22.0] - 2026-11-14

A repository tidy-up, and three gestures that had quietly stopped working.

The changelog entry for this batch said "nothing new to use, less of everything
else". That was true of the refactor and false of the rest: two of the diffs
repair behaviour a user could see, and one is a feature that had been landing in
the wrong route since 0.21.0. They are listed under *Fixed* rather than folded
into the cleanup, because that is what someone deciding to upgrade needs to read.

### Added

- **A drag badge.** Dragging a multi-selection showed one browser ghost for the
  whole batch, so there was no way to tell whether one file or twelve were in
  hand. The count now follows the cursor for the duration of the gesture, and the
  source rows step back so the drop targets read as the live surface.
- **Escape cancels a drag.** Every desktop file manager does this and the HTML
  spec leaves it to the page; without it the only way to abandon a drag was to
  drop it somewhere harmless. Dropping the page's drag state is what stops a
  gesture the user abandoned from acting on release.
- **`scripts/dead-code.mjs`** — the import-graph audit the repository never had.
  It resolves static *and* lazy imports (including the `?variant` cache-busters
  the tests use), treats tests, `package.json` scripts, workspace `bin` entries
  and `index.html` as entries, and reports three things: modules nothing
  reaches, exports nothing imports, and local declarations nothing mentions.
  `npm run dead-code` prints it, `--json` is for tooling, `--strict` exits
  non-zero and runs in CI.
- **`scripts/dnd-check.mjs`** — 14 browser assertions over the drop model: a
  folder row accepts a folder, a refused target is not highlighted, finishing a
  drag clears every highlight, a *file* row refuses a node, and the sidebar still
  works. CDP's synthetic mouse drag produces no dragover/drop, so the check
  dispatches the real events the browser would.
- **`apps/web/test/thumbnail-source.test.js`** — pins which route a row asks for
  its thumbnail, including the HEIC case that was reaching the wrong one.
- **`scripts/lib/args.mjs`** — one `--flag value` reader for the operation
  scripts. Five of them (`backup`, `smoke`, `s3-check`, `s3-fixture`,
  `tiered-check`) each carried their own copy, and the copies had already drifted
  (two spellings of the template literal, two of the quote). A missing value now
  falls back instead of swallowing the next switch, and `scripts/test/args.test.mjs`
  pins that contract.

### Changed

- **115 exports became module-local.** Every one was reachable only from inside
  the module that declared it — an `export` that advertised an interface no caller
  used, which is how a module grows a fake public surface. Worked examples:
  `http.js` (`contentTypeFor`, `parseRange`), `auth.js` (`createUser`),
  `config.js` (`repoRoot`), `db.js` (`ensureSearchIndex`, `migrateSearchIndex`,
  `migrateWorkspaces`), `mime.js` (`GENERIC_MIMES`), `nodes.js`
  (`requireFolder`), `workspaces.js` (`ROLES`), `routes/office.js`
  (`MAX_OFFICE_BYTES`), the nine XML helpers in `text/office.js`
  (`localName`, `elements`, `attr`, `textOf`, `runText`…), fifteen constants in
  `upload.js` / `api.js` / `sync.js`, and the page builders in `views.js`
  (see below).
- **`views.js` stopped exporting its page builders** — `listContext`,
  `skeletonView`, `hints`, `describeResults`, `matchNotes`, `searchView`,
  `listView` are now private, and `actions.js`, `context.js`, `files.js`,
  `dom.js` and `state.js` gave up the helpers that only they called. The web
  modules export what other modules use and nothing else, and
  `scripts/dead-code.mjs --strict` is what keeps it that way.

### Removed

- **Code nothing reached**, verified by zero references across source, tests and
  docs: `sendFile`/`sendEmpty` (`http.js`), `createTieredBackend`
  (`storage/tiered.js`, which `backend.js` had stopped calling when it began
  constructing `TieredBackend` directly), `XLSX_LIMITS`, `PDF_PREVIEW_LIMIT`,
  `HASH_CONCURRENCY`, `locksFor`, `expiredTrash`, `sharesWorkspace`,
  `materialize`, `blobSize`, `toReadable`, `isExempt`, `notify`, `uuidArgument`,
  `profileFor`, `decodePreview` (`image-fit.js`), `copyNode`/`shareUrl`
  (`files.js`), `foldersOf`/`folderTree`/`subtreeFolders`/`emptySelection`
  (`state.js`), and `sendWholeFile` in `routes/files.js`.
- **28 dead import bindings** across server, web, CLI and scripts that imported a
  name and then never used it — `blobPath`, `randomId`, `tmpdir`, `writeFileSync`,
  `unlinkSync`, `createHash`, `Readable`, `canThumbnail`, `nodeJson`,
  `requireFile`, `safeMime`… Each is invisible in review and each one makes the
  dependency graph lie.
- **Four copies of the same `flag()`** — one per operation script, all replaced
  by `scripts/lib/args.mjs`.

### Fixed

- **A folder could not be dropped onto a folder in the main list.** The rows had
  lost their drop handlers when the list context was split out of `app.js`:
  `lib/files.js` guards with `if (ctx.onFolderDragOver)`, the projection in
  `listContext()` never carried the three handlers, and the guard installed
  nothing. The sidebar kept working because it reads the context directly — so
  the gesture looked half broken, and no check covered the half that was gone.
  The row is now a real drop target (a *file* row still refuses, since dropping
  onto a file means nothing), and `scripts/dnd-check.mjs` is the gate.
- **An internal drag was rejected by some engines.** `isMoveDrag()` decided from
  `dataTransfer.types` alone, which not every engine exposes for a custom MIME
  while the drag is in flight. A drag that started in this page has already
  recorded its ids, so that is now the first signal — with `Files` excluded
  ahead of it, so an OS file drop keeps going to the window uploader.
- **A HEIC row had no thumbnail.** `/thumbnail` answers 415 for HEIC and the row
  only asked `canThumbnail()`, so a folder of phone photos rendered as a grid of
  generic picture icons — the decoder added in 0.21.0 was never asked. Rows and
  grid cards now choose between `/thumbnail` and `/preview-image` by format
  (`thumbnailSourceFor()`), which is one decode per blob either way.
- **A drag started during boot was dropped.** `onRowDragStart` bailed on
  `session.shellEls === null`, true for a moment during boot and any time the
  shell rebuilds. What a drag needs is the tree index, not the shell.
- **A drag whose payload could not be set failed silently.** Firefox refuses a
  drag with no data at all; the `catch` swallowed it and the user got a cursor
  that never picked anything up.
- **`docs/STRUCTURE.md` had drifted again.** `release.js`, `routes/updates.js`,
  `lib/updates.js` and three script entries were missing, and the file listed
  `dead-code.mjs` twice. The map is what the dead-code gate is compared against,
  so it is checked, not trusted.
- **Three files ended in a stray blank line**, which `git diff --check` reports
  as whitespace noise on every future change to them.

## [0.21.0] - 2026-11-14

The photos an iPhone produces, and the files a browser refuses to name.

### Added

- **`apps/server/src/routes/preview-image.js`** — `GET /files/:id/preview-image`
  decodes a HEIC and answers a downscaled PNG, cached on disk by
  `blobHash@width` and de-duplicated in flight, so opening a folder of twenty
  phone photos starts one decode per distinct file rather than twenty.
- **`apps/server/src/text/image-normalize.js`** — HEIC frame → downscaled RGBA →
  PNG, using a box filter over the decoded frame and `node:zlib` for the encode,
  so the server gains no image dependency of its own. The long edge matches
  `lib/image-fit.js` (1600px), which is why a preview lands at 1–2 MB rather
  than the 48 MB an undownscaled 12 MP frame would take.
- **`apps/server/src/text/heif-loader.js`** — the only file that imports libheif.
  A dynamic import behind a cached promise, so a deployment that never receives
  a HEIC never loads the WebAssembly module, and a missing optional dependency
  degrades to "no HEIC preview" instead of a boot failure. The failure is not
  cached: installing the decoder later works without a restart.
- **`apps/server/src/mime.js`** — the extension → MIME table, applied on upload
  and again on read. The read-side repair is what fixes files stored before the
  table existed, with no migration and no re-upload.
- **`apps/server/THIRD-PARTY.md`** — the LGPL-3.0 notice libheif requires, with
  the four things that keep it satisfied written down: use-not-link, keep the
  `.wasm` replaceable, ship the notice, claim no other licence for it.
- **`scripts/heic-check.mjs`** — 10 browser assertions against libheif's own
  example file: it uploads as an image with no content-type, renders as a
  picture, keeps the 1280×854 aspect ratio, and comes from the transcoding route.
  The fixture is fetched into `.tmp/` on first run rather than committed, so a
  fresh clone is green without a manual pre-step.
- **`package-lock.json`** — the decoder pinned at 1.18.2, which is the version
  the notice describes and the only runtime dependency in the image.

### Changed

- **HEIC now previews.** An iPhone stores photos as HEIC, no Chromium build
  decodes HEVC stills, so a whole camera roll used to be a wall of "this format
  cannot be previewed". The server decodes on demand — libheif as WebAssembly,
  loaded only when a HEIC actually arrives — downscales, and re-encodes a PNG
  cached by `blobHash@width`, so one decode serves every node pointing at those
  bytes. The browser gains zero bytes.
- **File types are no longer guessed by the browser.** An upload carries whatever
  `content-type` it was given, and browsers say `application/octet-stream` for
  `.heic`, `.tiff` and anything else they do not know. The extension table now
  decides first and the declared type only fills in what is left, so
  `readme.md` is Markdown rather than unknown binary. Uploads and `nodeJson()`
  both consult it, which is what repairs rows written before it existed.
- **The extension table grew by about 60 formats** — heic/heif/tiff/psd/jxl/ico/
  jfif; mov/avi/wmv/flv/m4v/3gp; opus/aac/wma/aiff/amr; epub; srt/vtt/ass; ipynb;
  and the language set the code preview was already lexing but could not name.
- **Animated pictures keep their animation.** A decoded `ImageBitmap` is a single
  frame, so routing a GIF, an APNG or an animated WebP through the bitmap path
  drew frame one and silently discarded the timeline. Those four now go straight
  to an `<img>`, which every engine this app supports decodes natively — correct
  and cheaper, since there is no decode of ours to pay for.
- **Apple iWork and legacy binary Office stop pretending to be previewable.**
  `.pages/.numbers/.key` are ZIP containers of IWA protobuf and `.doc/.ppt/.xls`
  are OLE compound files; both were routed to `/office` by extension, answered
  400, and surfaced as "无法预览". They are now `opaque`: the drawer offers a
  download instead of asking an endpoint that must refuse.
- **Static assets are gzipped.** Nothing was compressed before, including `.wasm`;
  a 1.4 MB `libheif.wasm` is about 480 KB gzipped, which is the precondition for
  loading the decoder on demand at all. Only the extensions where it pays are
  compressed, and only above 1 KB, with `Vary: Accept-Encoding`.
- **The image installs its decoder.** The Dockerfile copied source only, so
  `libheif-js` was never present in the image and every HEIC answered 503. It now
  installs from the lockfile in a layer of its own — manifests first, source
  after — so a source edit does not invalidate it, and `npm ci` pins the decoder
  to the version the licence notice is written against.

### Fixed

- **文件夹拖不进另一个文件夹。** `lib/views.js` 的 `listContext()` 只转发了
  `onRowDragStart`/`onRowDragEnd`，三个 drop handler
  （`onFolderDragOver`/`onFolderDragLeave`/`onFolderDrop`）没有转发，于是行上的
  `if (ctx.onFolderDragOver)` 全部跳过——行和卡片根本不是放置目标。侧边栏和面包屑
  直接读同一个 ctx，所以**只有它们能拖**，这就是"一半能用"的来源。
- **HEIC 在列表和网格里没有缩略图。** `/thumbnail` 对 HEIC 返回 415，而门禁只问
  `canThumbnail()`，所以整片手机相册渲染成一片通用图片图标。现在按
  `thumbnailSourceFor()` 分流：三种原生格式走 `/thumbnail`，HEIC/HEIF 走
  `/preview-image`，两者都按 blob 不可变缓存，列表与抽屉共用一次解码。
- **拖拽期间没有任何视觉状态。** `body.is-moving` 一直被加上又摘掉，却没有一条
  CSS 消费它；现在被拖的行降到 45% 不透明度、光标变 `grabbing`。
- **`setData` 的异常被 `catch {}` 吞掉。** Firefox 在没有 data 时拒绝启动拖拽，
  所以那条路径等于"在某浏览器里功能消失且无日志"；现在打一次 warn。
- **`onRowDragStart` 用 `session.shellEls === null` 提前返回**，而 shell 在启动
  和重建时正是 null——那个窗口里的拖拽会被静默丢弃。改为检查树索引。

- **A missing HEIC fixture failed the whole browser sweep.** `heic-check` exited
  with a curl instruction when `.tmp/sample.heic` was absent, which is the state
  of every fresh clone — so the one check that proves the feature works was the
  one that went red for a reason that was not a bug. It now downloads the fixture
  itself, caches it in the git-ignored scratch directory, and reports a fetch
  failure as its own failed check rather than a crash.
- **`image.display()` in libheif-js is asynchronous.** Reading the pixel buffer
  set by its callback on the next line always finds it empty; the callback is the
  only place the pixels exist. Decoding is now a promise, with a 20-second guard
  so a malformed frame cannot hold a request open.
- **A compressed HEIC can declare a canvas it does not carry.** `MAX_SOURCE_BYTES`
  bounds the input, not the output — HEIC compresses about 10:1, so a 9 MB file
  can claim 100 MP and ask for 400 MB of RGBA. The frame is refused above 50 MP
  before anything is allocated.

## [0.20.0] - 2026-11-14

A drive you open with one click, and an upload a reload can no longer throw away.

This section also records the work that reached the tree in 0.19.0–0.19.2 without
an entry of its own — the motion layer, the `app.js` split and the server layer
move — at the end of *Added* and *Changed*.

### Added

- **`apps/web/lib/row-action.js`** — the click model as a pure module: a plain
  click runs the row's action, modifier clicks and the checkbox select. The rows,
  the grid cards and the keyboard all read the same rule, so they cannot drift.
- **`scripts/click-check.mjs`** — 23 browser assertions for that model: one
  click enters a folder, one click previews a file, a double click still leaves
  one drawer, the checkbox never navigates, Ctrl+click selects, the header
  checkbox selects all and clears, and the trash keeps selecting.
- **A picture browser in the preview drawer.** `←`/`→` walk the pictures of the
  current folder in the order they are listed, `Home`/`End` jump to the ends,
  the header shows `3 / 12`, and each move is announced to screen readers. The
  ends clamp instead of wrapping, because on a slow connection a wrap looks like
  a reload.
- **`apps/web/lib/gallery.js`** — which files a drawer may walk and which
  neighbours to warm, as two pure functions. `PREFETCH_RADIUS` is two: that is
  how many times a person presses by habit before deciding to wait, and the window
  is recomputed from the current index, so holding the arrow never accumulates
  requests.
- **`apps/web/lib/image-fit.js`** — the decode-size policy this server needs:
  contain-fit to the drawer box, a 1600px long-edge cap and a pixel budget chosen
  from the platform's texture limit. Without a server-side resizer this is the
  only lever on decoded memory.
- **`apps/web/lib/image-size.js`** — reads width and height out of a PNG, JPEG,
  GIF or WebP header before decoding, so a small picture is never upscaled to the
  drawer width and the decode box is right the first time.
- **`apps/web/lib/image-cache.js`** — byte-budgeted LRU of *decoded bitmaps*
  (64 MiB, 24 entries) keyed by `blobHash`, so two nodes with the same bytes share
  one bitmap, with a disposer per entry so an evicted `ImageBitmap` is `close()`d
  instead of waiting for GC.
- **`apps/web/lib/image-loader.js`** — the route choice and the
  `createImageBitmap` downsample for one picture. A decoder failure falls back to
  an `<img>` over an object URL, because a picture that only decodes the slow way
  is still a picture.
- **`scripts/gallery-check.mjs`** — 34 browser assertions: arrows and the
  counter, clamped ends, Home/End, the button and the key agreeing, a non-picture
  keeping its own preview, and — the two that justify the design — every picture
  coming from the immutable route and a revisit issuing no request at all.
- **`scripts/lib/png.mjs`** — a real PNG writer for the checks. A hand-copied
  base64 fixture fails `createImageBitmap` rather than the request, which reads
  like a bug in the preview code.
- **`apps/web/lib/upload-resume.js`** — keeps a `FileSystemFileHandle` in
  IndexedDB, keyed by (name, size, lastModified), so a reloaded page can hand the
  server back the file it was already half-way through. Where handles do not
  exist (Safari, Firefox, a drop instead of a pick) it still returns a plan with
  `handle: null`, and the row offers to match by name, size and sha256 instead.
  Every IndexedDB call is guarded: a private window degrades to "no resume", never
  to a broken page.
- **`apps/web/lib/upload-stats.js`** — the batch readout: bytes, throughput, ETA
  and a one-line summary over the whole queue, as pure functions, so the
  arithmetic (deduplicated bytes, failed bytes, files still hashing) is tested
  directly. Files still hashing are excluded from the ETA on purpose: that
  throughput is a CPU number, not a network one.
- **`scripts/resume-check.mjs`** — 7 browser assertions that a reloaded page
  claims its live session, says how much is already stored, and can discard it.
- **`apps/web/lib/select.js`** — the two dropdown shapes the app needs:
  `renderSelect` for a field and `renderMenu` for a button, both built on
  `openMenu` so the popup is the app's own surface rather than an OS sheet.
- **`apps/server/test/upload-chunks.test.js`**, **`upload-complete.test.js`** —
  the interleaved chunk merge and the four completion paths (adopt an existing
  blob, skip an existing name, assemble, checksum mismatch) as tests rather than
  as comments.
- **Eleven web unit tests** — `row-action`, `gallery`, `image-size`,
  `image-fit`, `image-cache`, `image-loader`, `upload-stats`,
  `upload-resume`, `upload-resume-match`, `upload-claim`, `focus-trap`.

### Changed

- **A click now opens.** Clicking a folder enters it; clicking a file opens the
  preview drawer. Double-click-to-open is gone, because selection no longer owns
  the first click: the row grew a leading checkbox (and the grid card a corner
  one) for that, plus Ctrl/Cmd-click, Shift-click and Space. The trash keeps
  select-on-click, since nothing there is meant to be opened. Explorer's model is
  the one every web-native surface has already dropped: Notion's sidebar opens a
  page on a single click (the caret alone toggles the branch), and on a touch
  screen a double tap does not exist at all.
- **A double click can no longer open twice.** Two clicks both mean "open" now, so
  the second one is swallowed for 320ms after an open: otherwise a preview opens
  two stacked drawers and a double-clicked folder pushes its route twice. A
  double-clicked row on a folder that has just been entered cannot open the row
  that landed under the pointer.
- **Pictures are fetched from the route that may be cached.**
  `/files/:id/content` answers `must-revalidate`, so every visit re-downloads the
  bytes; `/files/:id/thumbnail` carries `max-age=604800, immutable` and serves the
  same bytes. The preview now uses it, and one width is used everywhere: `?w=96`
  and `?w=1024` are different URLs answering identically, which put one 30 MB
  photo in the HTTP cache twice.
- **A picture is decoded to the drawer's box, not to its own size.** A 24 MP photo
  is 96 MB of RGBA against Chromium's 32 MB decoded-image budget, so a folder of
  them thrashed on every arrow press. Decoding now happens once, at contain-fit
  size, with the header read first so a 300px screenshot is never blown up.
- **Chunks of one file go over two lanes.** One at a time leaves the pipe empty
  for a full round trip after every 8 MiB, which on a 40ms link is a ceiling well
  below the line rate; more than two starts to compete with the other files the
  scheduler is already running. A dropped chunk is retried up to four attempts
  with a 1/3/9s backoff, and only for failures that are transient by definition —
  408, 429, 5xx, or a request that never reached the server. A progress bar may
  pause, it may not retreat: a resumed session keeps the bytes it already
  delivered on screen instead of snapping back to 0%.
- **A folder upload runs its files concurrently, largest first.** Awaiting each
  file made a 200-file folder a 200-request relay — one round trip of latency per
  file, one connection in flight, and a 200 Mbps link that never went above a few
  MB/s. The default is still `concurrency: 1`, so a caller that wants a strict
  order is unaffected; the web client passes the whole list and lets its own
  scheduler decide.
- **Completion hashes before it writes.** The digest is now known before any byte
  is copied, which buys three things: a checksum mismatch is rejected without ever
  producing the temp file; when the digest is already in the blob store the bytes
  are adopted directly (`201 { node, deduplicated: true }`) and nothing is copied
  at all; and each chunk is unlinked as soon as it has been copied into the
  assembly, so peak disk use is about one copy of the file instead of two — a 2 GiB
  upload no longer needs 4 GiB free to finish.
- **The hourly sweep now drops upload sessions.** Expiry used to be purely lazy:
  `requireSession` deleted a row the moment a client touched it, so a session that
  was abandoned and never resumed kept its row *and* its chunk directory forever.
  The sweep deletes both, and also reclaims session directories whose row is
  already gone. An abandoned upload costs its disk for at most one TTL plus one
  sweep interval.
- **The queue header owns the batch bar.** A queue of 200 files cannot be read
  from 200 rows, so the header carries one bar and one line for the whole batch —
  bytes, speed, ETA, failures. It is throttled to ~4Hz and a settled state forces
  an immediate pass, so the last number on screen is always the true one, and it
  stays hidden for a single file, whose row already shows its own percentage.
- **Every dropdown is the app's own menu.** The native `<select>` cannot be styled
  where it counts — the popup list and its highlight are painted by the browser,
  so a themed control still opens a white (or system-blue) sheet over a near-black
  UI — and it sizes itself from its widest option, which is how one dropdown drags
  a toolbar row out of alignment. Sorting, share permission and expiry are now
  `.select` / `.btn-menu` over `openMenu`: same radius, same shadow, same spring,
  same Escape stack as every other popup. Rows support `checked`
  (`role="menuitemradio"` plus a tick), so the current value is visible, and the
  unchecked rows keep an invisible spacer icon so every label starts on the same x.
- **The sort control is button-shaped** and sits at the height of the 28px buttons
  beside it. The old one was 26px tall at 11px type, with a CSS triangle drawn at
  `13px` of a 26px control — 2px below the optical centre. It is now the shared
  chevron, which rotates and takes the accent colour when open.
- **The shell is an interface, not a document.** `base.css` makes the chrome
  unselectable and removes the caret, and content opts back in: clicking a label
  used to leave the browser a collapsed caret blinking between two words of a
  heading, and dragging across the sidebar painted a text highlight over it. File
  names, previews, counts and error text stay selectable; fields reset both
  properties so typing keeps a real caret.
- **An overlay takes focus on the next frame and gives it back to its opener.**
  `trapFocus()` used to focus synchronously, while the panel was still detached:
  the browser ignored it, focus stayed on `<body>`, and every key handler the panel
  had installed was dead. Release now restores focus to the opener in the frame
  after unmounting, and falls back to the main region rather than to `<body>` (where
  the next Tab restarts from the top of the document).
- **An unavailable control is `aria-disabled`, not `disabled`.** A disabled button
  cannot hold focus, so previous/next going `disabled` at the ends of the gallery
  dropped the keyboard onto `<body>` exactly when the user was still pressing `→`.
- **A deployment keeps one image tag.** `TAG_KEEP` (default 1) keeps the tag this
  run landed on plus the newest entries, by creation time rather than version sort:
  keeping the highest version is wrong on a downgrade, where the highest number is
  exactly the image being replaced. The updater also stops rebuilding itself on
  every run — its Dockerfile copies one `.mjs` file, so a build per update only
  left the previous image dangling.
- **The account quota is a compose variable.** `DRIVE_QUOTA_BYTES` (bytes, 0 =
  unlimited) was hard-coded in one deployment's overlay and absent from the
  repository's compose, so a fresh checkout silently ran unlimited. On a shared
  disk that lets one upload fill the volume the OS and the other containers live
  on. `.env.example` spells out the arithmetic: the client divides by 1024 and
  labels the result GB, so "150 GB" is 161061273600 bytes, not 150000000000 (which
  renders as "140 GB").
- **`scripts/lib/browser.mjs`** — the one Chrome/CDP harness. Eleven check scripts
  used to carry their own copy of the same eighty lines (find Chrome, spawn, poll
  `/json/version`, open a page, speak the protocol, tally); the copies had drifted
  apart, and the drift was the bug surface. A check script is now only its seed
  data, its interactions and its assertions.
- **`scripts/run-checks.mjs`** — runs every browser check against one server and
  prints one summary. `pnpm browser-checks`.
- **`apps/web/lib/session.js`**, **`lib/runtime.js`** — the shared mutable state
  and the verb seam. They are what made splitting `app.js` possible without a
  cycle: a module reads `session` and calls `runtime`, and nothing imports
  `app.js`.
- **`apps/web/app.js` went from 1532 lines to a shell and a boot sequence.** The
  four pages moved to `lib/views.js`, the handler table to `lib/context.js`, the
  row verbs to `lib/actions.js`, the picker and folder plan to `lib/uploads.js`,
  and the drag gestures to `lib/dnd.js`. No behaviour change: the browser shell
  checks pass unchanged.
- **`apps/server/src` is grouped by layer.** `storage/` (backend seam, blobs, s3,
  tiered, cluster, node), `text/` (office, pdf, zip), `ops/` (retention, scrub,
  audit, access-log, search-index, locks, quota, rate-limit). The directory *is*
  the rule: `storage/` knows nothing about HTTP, `text/` knows nothing about the
  database, and `routes/` is the only layer that speaks HTTP.
- **`docs/STRUCTURE.md`**, **`docs/ARCHITECTURE.md`** and **`docs/DEVELOPMENT.md`**
  rewritten around that layering; the map is the test, so it cannot silently rot.
- **`ci.yml`** calls `scripts/check-syntax.mjs` instead of an inline `find | xargs`,
  which also made the Linux and Windows gates agree.
- **Durations and curves retuned to an intent scale** — `--duration-instant/fast/
  base/slow` at 80/140/220/320ms, replacing `--dur-fast`/`--dur`/`--ease`. The old
  names are gone rather than aliased: an alias keeps a second vocabulary alive, and
  the whole point is that there is one.
- **Overlays present and dismiss properly.** Dialogs spring from `scale(.97)`,
  drawers slide from the inline end, menus arrive from the edge they are anchored
  to, and all three play a 140ms exit before unmounting instead of vanishing. A
  toast is removed on `animationend`, not on a guessed 200ms.
- **One entrance per navigation.** The `.view` column cross-fades through View
  Transitions when the route token changes; a local re-render paints plainly. On
  first paint the rows stagger, and the root keeps `.motion-enter` until the
  **last** row settles.

### Fixed

- **A menu opened inside a dialog was painted underneath it.** `--z-menu` was 60
  and `--z-modal` 70, so any menu a dialog opened was behind the scrim — present
  in the DOM, invisible on screen. It never showed before because the dialogs only
  held native selects and never opened an app menu. `--z-menu` is now 75: above
  the modal, below the toast.
- **The thumbnail route answered `cache-control: public` and had no `Vary`.**
  Those bytes are behind a bearer token, and a `public` response is shared by every
  account in the same browser profile: sign out, sign in as someone else, and the
  previous account's picture could come straight out of the HTTP cache. It is now
  `private, max-age=604800, immutable` plus `Vary: Authorization` — the week of
  freshness is kept, the cross-account read is gone.
- **The preview drawer opened and the arrow keys did nothing.** `trapFocus()`
  called `focus()` synchronously, before the panel was in the document; the browser
  ignored it, focus stayed on `<body>`, and the panel's key listeners heard
  nothing. The old check dispatched `keydown` straight at the panel element, which
  is why it stayed green. Focus is deferred to the next frame, and the check now
  presses real keys over CDP.
- **The keyboard died at the last picture.** Previous/next used `disabled` at the
  ends, and a disabled button cannot hold focus: one press at the end dropped focus
  to `<body>` and every key after that went nowhere — precisely when the user was
  still pressing `→` to find out whether it wraps.
- **Closing an overlay left focus on `<body>` instead of the button that opened
  it.** `release()` captured its restore target at open time without excluding
  `<body>`; it now excludes it and restores in the frame after release, so focus
  lands back on the opener (or at worst on the main region, not the top of the
  document).
- **The decoded size was computed from the box's long edge, so a landscape photo
  decoded at twice the pixels it needed.** In a 559px drawer a 6000×4000 photo was
  decoded to 867px tall (1600px wide) — about 2.4× the memory it could show. It is
  now a real contain fit (`min(bw·dpr/sw, bh·dpr/sh)`), with the true dimensions
  read from the file header first, so a small picture is never enlarged.
- **The preview's picture was not vertically centred.** `flex:1` was attached to a
  plain block wrapper, where it is inert; `.preview-stage{display:flex;
  flex-direction:column;flex:1 1 0}` is what actually puts the picture in the middle.
- **`lib/preview.js` called a function it never imported.** `galleryOf` used
  `isGalleryImage` while the import list did not have it, so opening any file
  preview threw a `ReferenceError`. The browser check had been failing for reasons
  unrelated to this batch; fixed here.
- **A merge of chunk indexes could silently lose one.** Updating `received` with
  the set read before the request body was consumed is a read-modify-write on a
  stale snapshot: when a client sent several chunks at once, or two tabs resumed
  the same session, the chunk that finished first was dropped from the row — the
  bytes were on disk, the row forgot them, and `complete` answered
  `409 UPLOAD_INCOMPLETE` forever. The merge now re-reads the row inside a
  transaction.
- **`complete` could adopt bytes that were not there.** A `blobs` row can outlive
  its file, and adopting from it produced a node that 500s on download. "Already
  stored" is asked of the backend, not of the database.
- **Staggered rows could flash.** The entrance class was removed on the root's own
  `animationend` at 220ms while row 10 was still waiting out its 280ms delay;
  removing the class cancels those rows mid-flight, and a cancelled animation has
  no fill, so they snapped back to `opacity:0`. The class now lives until the last
  row settles.
- **A loading skeleton consumed the page's entrance.** Recording the route token
  while the skeleton was up made the real content count as "already entered", so
  the first list never animated.
- **`.skip-link` and the upload progress bar transitioned layout properties**
  (`top`, `width`). Both are transforms now: the skip link slides in, and the bar
  scales from the left instead of relayouting a row several times a second.
- **The reduced-motion block killed every entrance.** A document-wide
  `animation:none !important` cancelled in-flight animations, which have no fill,
  so elements blinked before settling. Durations collapse in `tokens.css` instead,
  and only looping animations are slowed here.
- **The search field painted two focus rings** — the wrapper's `box-shadow` plus the
  inner input's outline, the inner one covering the `/` hint.
- **`scripts/upload-check.mjs` wrote its scratch file into a directory it never
  created**, and had been passing only because a previous run left the folder behind.

### Removed

- **`apps/web/lib/ids.js`** — exported `uid()`, which nothing imported.
- **`apps/server/src/routes/_index.js`** — a documentation-only module whose route
  table duplicated `index.js` and had already gone stale.
- **277 MB of `.tmp`** (Chrome profiles and screenshots from past runs) and the
  crash-leftover `.part` chunk files in `data/tmp`. All of it is rebuildable.

## [0.19.2] - 2026-11-13

An update that cannot half-land.

### Fixed

- **A failed pull left the deployment claiming a release it never ran.**
  `scripts/deploy/update.sh` treats a failed `compose pull` as a warning and
  recreated from whatever image was local. On a host with no build section and
  no cached image, the recreate then failed *after* `.env` had been pinned, so
  the tag named a version that was never deployed: the container ran the old
  image while `update-check` reported the new one, and the next update saw
  nothing to do. A pull failure is now fatal and restores the snapshot taken at
  the start of the same run, so `.env`, the compose files and `package.json`
  never outlive a release that did not land. The recreate and health-check
  paths share that one restore instead of carrying their own copies.
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