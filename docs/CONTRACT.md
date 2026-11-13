# Marvelous Drive ‚Ä?implementation contract

This file is the single source of truth shared by the server, the web client and
the CLI. Every module is implemented against the shapes below.

## Product

Marvelous Drive is a self-hosted cloud drive for one person or a small team: a
node tree, content-addressed blobs, versions, resumable uploads, public shares,
full-text content search and a byte-level integrity story. It is a standalone
product and talks to no other service.

Conventions: `/api/v1` JSON, UUID identifiers, ISO-8601 UTC timestamps, a single
error envelope, bearer JWT auth, 12 hour sessions, scrypt password hashes in the
`scrypt:<salt>:<hex>` format.

Drive stores binary files on disk with content-addressed blobs and keeps metadata
in SQLite (`node:sqlite`, no external database), so it runs with
`node apps/server/src/index.js` and no install step.

## Runtime

- Node.js >= 22 (developed against 26). ESM only, no build step, no runtime
  dependencies.
- Default port `4400`, override with `PORT`. Host `127.0.0.1` by default,
  override with `HOST`.
- Data directory: `DRIVE_DATA_DIR` or `<repo>/data`; contains `drive.db`,
  `blobs/`, `tmp/`, `quarantine/`, `.jwt-secret`.

## Error envelope

```json
{ "error": { "code": "FORBIDDEN", "message": "You do not have permission for this operation." } }
```

| HTTP | code |
| --- | --- |
| 400 | `INVALID_INPUT`, `INVALID_ID`, `INVALID_PARENT`, `NOT_A_FILE`, `NOT_FOLDER` |
| 401 | `UNAUTHENTICATED`, `INVALID_CREDENTIALS`, `SHARE_LOCKED` |
| 403 | `FORBIDDEN` |
| 404 | `NOT_FOUND`, `SHARE_NOT_FOUND`, `BLOB_NOT_FOUND` |
| 409 | `CONFLICT` (name already used in the folder), `VERSION_CONFLICT`, `UPLOAD_INCOMPLETE`, `CHECKSUM_MISMATCH`, `DRIVER_UNSUPPORTED`, `LOCKED` |
| 413 | `FILE_TOO_LARGE` |
| 500 | `INTERNAL_ERROR` |
| 503 | `DATABASE_UNAVAILABLE` (health probe could not read SQLite) |

Successful list responses are objects, never bare arrays: `{ "nodes": [...] }`,
`{ "shares": [...] }`, `{ "versions": [...] }`.

## Authentication

- `POST /api/v1/auth/register` `{email,password,name?}` ‚Ü?`201 {token,user}`.
  Password: 8‚Ä?00 chars. Email is lowercased and unique.
- `POST /api/v1/auth/login` `{email,password}` ‚Ü?`200 {token,user}`.
- `GET /api/v1/me` ‚Ü?`{user}`.
- `user` = `{id,email,name,role,createdAt}`, role always `owner` for a personal
  drive.
- JWT HS256, claims `{sub,email,name,exp,iat}`, 12 h TTL, header
  `Authorization: Bearer <token>`.

## Node model

A node is either a `folder` or a `file`; both live in one tree per user.

```ts
type Node = {
  id: string            // uuid
  name: string
  kind: 'folder' | 'file'
  parentId: string | null
  size: number          // bytes, 0 for folders
  mime: string | null   // 'application/octet-stream' when unknown
  version: number       // starts at 1, increments on every mutation (content, rename, move, restore)
  starred: boolean
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  blobHash: string | null  // sha256 hex of the current content
}
```

Detail responses (`GET /api/v1/nodes/:id`) additionally carry
`downloadUrl: "/api/v1/files/<id>/content?download=1"` and
`previewUrl: "/api/v1/files/<id>/content"`.

Endpoints (auth required unless marked public):

- `GET /nodes?workspace=<uuid>` narrows or widens the listing: omitted means
  **your own nodes** (the pre-workspace behaviour), present means every node in
  that workspace you belong to. `?trash=1` composes with it. A workspace you are
  not a member of answers an empty list, not an error.
- Inside a folder (`?parentId=<uuid>`), visibility follows the **folder's**
  workspace rather than the caller's ownership: a member's upload into my folder
  must appear when I open it. The root level stays personal.
- `GET /api/v1/nodes` ‚Ä?folders first then files, each group sorted by name
  (case-insensitive). No `parentId` returns the whole live tree in one call, which
  is what the web client caches; `?parentId=<uuid>` returns only that folder's
  direct children; `?parentId=root` returns only the root level. `?trash=1`
  returns the trash instead; `?starred=1` starred nodes; `?kind=file|folder`;
  `?sort=name|size|updated|created`.
- `GET /api/v1/nodes/:id/breadcrumb` and `/nodes/:id/path` ‚Ä?`{path:[{id,name,kind}]}`
  from the root down.
- `POST /api/v1/nodes/:id/archive` ‚Ä?stores the folder as a `.zip` file node next
  to it ‚Ü?`201 {node}`.
- `GET /api/v1/files/:id/text?limit=` ‚Ä?`{text,truncated,mime}`, for previews and
  the push path (default 512 KiB, max 4 MiB).
- `PATCH /api/v1/me` `{name}` ‚Ü?`{user}`.
- `GET /api/v1/nodes/:id` ‚Ä?single node + `children` count.
- `POST /api/v1/nodes` `{name,kind,parentId?}` ‚Ü?`201 {node}`. Folders get an
  empty file? No: folders carry `kind:"folder"`, `size:0`. Names are trimmed,
  1‚Ä?55 chars, must not contain `/` or `\\`.
- `PUT /api/v1/nodes/:id` `{name?,parentId?,expectedVersion?}` ‚Ü?`{node}`.
  Moving into itself or a descendant ‚Ü?`400 INVALID_PARENT`. Name collision in
  the target folder ‚Ü?`409 CONFLICT`.
- `DELETE /api/v1/nodes/:id` ‚Ä?soft delete (trash), cascades to descendants.
  Missing `expectedVersion` is allowed.
- `POST /api/v1/nodes/:id/restore` ‚Ä?restore node and trashed descendants.
- `DELETE /api/v1/nodes/:id/permanent` ‚Ä?only for trashed nodes; removes blobs
  whose refcount drops to zero.
- `PUT /api/v1/nodes/:id/star` `{starred:boolean}` ‚Ü?`{starred}`.
- `POST /api/v1/nodes/:id/copy` `{name?,parentId?}` ‚Ü?`201 {node}` (files only;
  folders copy recursively).

## Content

- `PUT /api/v1/files/:id/content` ‚Ä?raw body, `Content-Type` sets the mime,
  optional `X-Checksum-Sha256` header. Creates a new version and appends the
  previous blob to `/versions`. `200 {node}`. Optional `?onConflict=`:
  `skip` answers `200 {node, skipped:true}` with the current node and writes
  nothing; `overwrite` is the default; `rename` is `400 INVALID_INPUT` because
  the target already exists and there is nothing to rename away from.
- `GET /api/v1/files/:id/content` ‚Ä?streams the blob. Supports `Range`
  (`206`, `Content-Range`, `Accept-Ranges: bytes`), `?download=1` sets
  `Content-Disposition: attachment; filename="..."`; otherwise inline with the
  stored mime (images, pdf, text preview).
- `GET /api/v1/files/:id/versions` ‚Ü?`{versions:[{id,version,size,mime,createdBy,createdAt,downloadUrl}], currentVersion}`.
- `GET /api/v1/files/:id/versions/:versionId/content[?download=1]` ‚Ä?the bytes of
  one stored version, **without touching the live file**; `404` when the version
  belongs to another node, `410 GONE` when the blob is no longer on disk.
- `POST /api/v1/files/:id/versions/:versionId/restore` `{expectedVersion}` ‚Ü?  `{node}`; `409 VERSION_CONFLICT` when stale.
- Upload limits: `DRIVE_MAX_UPLOAD_BYTES` (default 2 GiB) ‚Ü?`413 FILE_TOO_LARGE`.

### Simple upload

`PUT /api/v1/uploads?parentId=<uuid>&name=<encoded>` ‚Ä?raw body. Returns
`201 {node}`. When `name` is omitted the `X-File-Name` header (or
`Content-Disposition` filename, or `upload.bin`) is used. An existing live file
with the same name in that folder is overwritten as a new version (returns
`200` instead of `201`); folders never overwrite.

`?onConflict=overwrite|rename|skip` selects what a name collision means
(default `overwrite`, i.e. the behaviour above):

- `overwrite` ‚Ä?replace the bytes, `version` +1, one new `/versions` row.
- `rename` ‚Ä?keep both: the new bytes get the existing `uniqueName()` form
  `name (1).ext` (the counter goes before the extension) and the response is
  `201 {node, renamedFrom}`. The old file keeps its content and version.
- `skip` ‚Ä?nothing is written: `200 {node, skipped:true}` with the node that
  already owns the name. The freshly uploaded blob is released again, so
  `blobs.refs` is unchanged.

Any other value is `400 INVALID_INPUT`. The same knob is accepted by
`POST /api/v1/uploads/sessions/:id/complete` (`?onConflict=` or the JSON body)
and by `POST /api/v1/uploads/instant` (`onConflict` in the body).

### Instant upload (dedup)

The server already addresses content by sha256, so a client that knows the hash
of its bytes can skip the transfer entirely.

- `GET /api/v1/blobs/:sha256` (auth) ‚Ü?`200 {exists:true, sha256, size, refs}`
  when the blob is stored, `404 NOT_FOUND` otherwise, `400 INVALID_INPUT`
  unless the path segment matches `^[a-f0-9]{64}$`. Only `size` and `refs` are
  exposed; the on-disk path never is.
- `POST /api/v1/uploads/instant` (auth)
  `{name, sha256, size, parentId?, mime?, onConflict?}` ‚Ü?creates a node that
  points at the stored blob (`retainBlob`, no bytes read, no second copy) and
  answers `201 {node, deduplicated:true}`. The blob is global, so `size` must
  equal the stored blob's size (`400 INVALID_INPUT` otherwise). A missing blob
  is `404 BLOB_NOT_FOUND` so the client can fall back to a real upload.
  `onConflict` works as above (`skip` ‚Ü?`200 {node, skipped:true,
  deduplicated:true}` without touching `refs`).

### Resumable upload

1. `POST /api/v1/uploads/sessions` `{name,size,sha256?,parentId?,chunkSize?}`
   ‚Ü?`201 {upload:{id,name,size,parentId,chunkSize,totalChunks,receivedChunks,expiresAt}}`.
   `chunkSize` default 8 MiB, min 64 KiB, max 64 MiB. `totalChunks` is
   `max(1, ceil(size/chunkSize))`.
2. `PUT /api/v1/uploads/sessions/:id/chunks/:index` raw body, 0-based index,
   length must not exceed `chunkSize`; last chunk may be shorter, total must
   equal `size`. ‚Ü?`200 {upload}` with the updated `receivedChunks` array.
3. `GET /api/v1/uploads/sessions/:id` ‚Ü?`{upload}` (resume support).
4. `POST /api/v1/uploads/sessions/:id/complete` ‚Ü?assembles, verifies sha256 when
   supplied, creates the node ‚Ü?`201 {node}`. Incomplete ‚Ü?`409 UPLOAD_INCOMPLETE`;
   bad hash ‚Ü?`409 CHECKSUM_MISMATCH`.
5. `DELETE /api/v1/uploads/sessions/:id` ‚Ü?`{ok:true}`, drops temp chunks.
6. `GET /api/v1/uploads/sessions` lists the caller's live sessions;
   `DELETE /api/v1/uploads/sessions` drops the expired ones.

Sessions expire after 24 h; expired sessions answer `404 NOT_FOUND`.

## Office preview

- `GET /api/v1/files/:id/office` ‚Ü?`200 {office:{kind,pages,sheets,meta}, file}`
  for `.pptx`/`.docx`/`.xlsx`; `400 NOT_OFFICE` when the file is not OOXML,
  `422 PREVIEW_UNAVAILABLE` when it is but cannot be parsed, `413 FILE_TOO_LARGE`
  above 64 MiB. Legacy `.ppt`/`.doc`/`.xls` are `NOT_OFFICE`.
- Shared shape:
  `pages: [{index,title,blocks:[{type:'heading'|'paragraph'|'list'|'table'|'image', ...}]}]`
  and `sheets: [{name, rows:[[{text,type}]]}]`; `meta` carries
  `slideCount|wordCount|sheetCount` and `truncated`.
- The web client renders this shape directly; it never parses a document itself.
  Kinds are `slides`, `doc` and `sheet` in `fileKind()`, each with its own icon.

## Folder upload (client behaviour)

- The toolbar's upload button opens a menu: `‰∏ä‰º†Êñá‰ª∂` (a normal multi-file
  picker) or `‰∏ä‰º†Êñá‰ª∂Â§π`.
- A folder upload creates the whole directory skeleton **before** any bytes are
  sent, so empty directories survive; drag & drop reads
  `DataTransferItem.webkitGetAsEntry()` for the same reason (a `FileList` cannot
  contain an empty folder). The picked/dropped folder itself is created, matching
  desktop clients.
- A `409 CONFLICT` on a folder means it already exists: the plan reuses that
  folder and keeps going instead of failing the branch. Individual file failures
  are counted and reported, and each one stays retryable in the queue.

## Quota

- `DRIVE_QUOTA_BYTES` sets a per-account ceiling over **live file bytes**; `0`
  (the default) means unlimited. The trash is never charged ‚Ä?a deleted file is
  meant to be recoverable, not to keep blocking uploads.
- Enforcement happens on every path that adds bytes: `PUT /uploads` (checked
  from `Content-Length` before spooling, then again against the stored size),
  `PUT /files/:id/content` (only the **difference** counts, because the old size
  is still on the books), `POST /uploads/sessions` (the declared size is reserved
  up front) and `POST /uploads/instant`.
- Over-quota answers `413 QUOTA_EXCEEDED` and nothing is stored: a spooled blob is
  released before the error leaves the server.
- `GET /api/v1/storage/stats` returns `quota: { used, limit, remaining }` and
  `quotaBytes` (the limit, or `null` when unlimited).
- Bytes are counted from node rows, not from the blob table: two files that share
  one blob each count their own size against the quota.

## Workspaces and membership

Every account owns a workspace and is its `admin`; `nodes.user_id` stays the
**owner** of a node (quota, "my files"), while `nodes.workspace_id` decides who may
**see** it.

- `user.workspace` is returned by `POST /auth/register`, `POST /auth/login` and
  `GET /me`: `{ id, name, ownerId, role }`. The active workspace is
  deterministic ‚Ä?the one you own first, then the oldest membership ‚Ä?so being a
  member somewhere never silently changes what "my drive" means.
- **Visibility**: a node is readable when the caller owns it *or* belongs to its
  workspace. This is the whole point of the table: without it every account is an
  island and `memberships` would be decoration.
- **One namespace per folder**: name collisions, `plan.txt`-style renames and the
  "does this file already exist" lookup all span the folder, not the owner, or a
  shared folder would grow two identical-looking rows.
- `GET /api/v1/workspaces` ‚Ü?`{ workspaces: [{ id, name, ownerId, role, active, files, folders, bytes }] }`.
  `/workspace/members` only reports the *active* workspace; a member added to
  someone else's drive needs this list to discover that workspace's id before it
  can pass `?workspace=`.
- `GET /api/v1/workspace/members` ‚Ü?`{ workspace, members:[{id,email,name,role,joinedAt}] }`.
- `POST /api/v1/workspace/members` `{ email, role? }` (admin) ‚Ü?`201 { members }`.
  There is no mail delivery, so an invite means "an account that already exists
  joins my drive" ‚Ä?`404` when no such account exists.
- `DELETE /api/v1/workspace/members/:id` (admin) ‚Ü?`{ ok }`; the workspace owner
  cannot be removed (`400`).

Adding a member does **not** make it their active workspace: their own drive stays
primary, and the shared nodes stay reachable by id (links, search results, shares).

## Edit locks (advisory)

A lock says "someone is editing this"; it is **not** a write barrier.

- `GET /api/v1/nodes/:id/lock` ‚Ü?`{ lock: null | { nodeId, userId, client, acquiredAt, expiresAt } }`.
  `GET /nodes/:id` also embeds `lock` in the node payload.
- `POST /api/v1/nodes/:id/lock` `{ client?, ttlMs?, force? }` ‚Ü?  `{ lock, tookOver, supersededClient }`. `ttlMs` is clamped to 15 minutes by
  default and 8 hours maximum. A live lock held by **another user** answers
  `409 LOCKED` with the holder's client in the message unless `force` is set.
- `DELETE /api/v1/nodes/:id/lock` ‚Ü?`{ released }`; releasing someone else's lock
  is `403`.
- The same user in a second window is never blocked: the lock moves to the newest
  client and `supersededClient` names the window that lost it, which is what the
  preview drawer shows.
- A lock **expires** so a crashed client cannot hold a file, and a write is
  **never** refused because of a lock ‚Ä?`expectedVersion` is the mechanism that
  prevents lost updates.

## Audit log

Every mutation appends one row: `upload`, `instant-upload`, `overwrite`, `trash`,
`restore`, `purge` (plus rename/move/copy/star/share on the same table). The log
is written **after** the change succeeds, so a rejected request leaves no entry,
and it is never updated or deleted by the application ‚Ä?only an account deletion
cascades, and rows older than 90 days are pruned by the hourly sweep.

`GET /api/v1/audit?limit=50&action=upload&nodeId=<uuid>` ‚Ü?`{ entries: [{ id, action, nodeId, detail, ip, createdAt }], retentionDays: 90 }`.
`limit` is clamped to 200; an account only ever sees its own rows.

## Hot / cold storage

- `blob_access(hash, last_access, hits)` records at most **one write per blob per
  day** when it is downloaded (or its thumbnail is) ‚Ä?enough resolution for an
  archival decision, and no write burst behind a download burst.
- `GET /api/v1/maintenance/storage/tiers?days=90` (owner) ‚Ü?  `{tiers:{thresholdDays,cutoff,blobs,hotBytes,coldBytes,coldCount,cold:[{hash,size,lastAccess,hits}]}}`,
  biggest cold file first. A blob with no access row counts as cold.
- This is **report-only**: moving bytes needs a second storage backend, so nothing
  is migrated automatically. `mdrive tiers [--days N]` prints the same report.

## Storage backend

Bytes are reached through `apps/server/src/storage/backend.js`, never through a
path:

```
backend.path(key)        local-only shortcut for assembly/ZIP (LocalBackend)
backend.put(key, src)    adopt a finished file
backend.stat(key)        { size } | null
backend.get(key)         ReadableStream
backend.remove(key)      delete; missing is not an error
backend.link(key, dest)  a path with the same bytes (hard link when possible)
```

`blobs.js` owns refcounting and the database; `http.js`'s `sendBlob()` streams a
key with `Range` support. Downloads, share downloads, version downloads,
verification, quarantine and orphan reclaim all go through the seam, which is what
makes a second tier (or S3) a drop-in rather than a rewrite.

`GET /api/v1/maintenance/storage/backend` (owner) ‚Ü?`{backend:{name,kind,blobs,bytes}}`
reports what is actually running.

**The seam is enforced**: `seam.test.js` fails if any module outside
`storage-backend.js`, `blobs.js` and `scrub.js` calls `blobPath()`, or if a route
opens a `createReadStream` on stored content. Paths that must parse bytes anyway
(text preview, Office extraction, PDF extraction, indexing) use
`readBlobBuffer(store, key)`; downloads always stream.

## Blob integrity

- Cheap scan: `GET /api/v1/maintenance/blobs` (rows vs disk, missing/orphans/size).
- Checksum pass: `GET /api/v1/maintenance/blobs/verify[?limit=&maxBytes=]` ‚Ä?  rehashes and compares to the blob name; the only check that finds silent
  corruption. Always opt-in, sliced by `limit` so a big drive is checked across
  several runs.
- Repair: `POST /api/v1/maintenance/blobs/quarantine { hashes? }` moves corrupt
  blobs into `data/quarantine/<hash>.<ts>` and deletes their rows, so affected
  files answer `404` rather than serving wrong bytes. The bytes are kept.
- CLI: `mdrive verify [--limit N] [--fix]`.

## Index maintenance

- `index_skips` records every file the indexer examined and deliberately
  refused (`not-text`, `binary`, `empty`, `no-text`, `office-too-big`,
  `pdf-too-big`, `encrypted`, `unreadable`). Without it "up to date" would be
  unreachable: a refused file otherwise looks exactly like a file that was never
  indexed. The reason matters ‚Ä?`encrypted` and `no-text` (a scan) are different
  answers to "why can I not find this?".
- `GET /api/v1/maintenance/search` (owner) ‚Ü?  `{coverage:{eligible,covered,refused,missing}, upToDate}`.
- `POST /api/v1/maintenance/search/reindex` (owner) ‚Ü?`{summary,before,after}`;
  reads every blob, so it is an explicit operation.
- `GET /api/v1/storage/stats` includes `stats.search` (this account's coverage),
  and the search page warns when `missing > 0` instead of pretending "nothing
  found" is the whole truth.

## Trash retention and maintenance

- Trash is a safety net with a clock: `DRIVE_TRASH_RETENTION_DAYS` (default 30)
  days after `deletedAt`, a trashed subtree is purged and blobs that lose their
  last reference are removed from disk. The sweep runs on boot and hourly, and on
  demand via `POST /api/v1/trash/sweep` ‚Ü?`{swept,nodes,bytes,blobs,cutoff,retentionDays}`.
- `GET /api/v1/storage/stats` now also returns:
  - `byKind: { totalBytes, kinds: { document|image|video|audio|archive|code|other: {files,bytes} } }`
  - `trash: { nodes, bytes, oldestAt, expiresAt, retentionDays }`
- Blob integrity (owner only):
  - `GET /api/v1/maintenance/blobs` ‚Ü?`{scan:{rows,files,bytesOnDisk,missing,orphans,sizeMismatch,checkedAt}}`
  - `POST /api/v1/maintenance/blobs/reclaim` ‚Ü?deletes files no row references
  - `POST /api/v1/maintenance/blobs/forget-missing` ‚Ü?drops rows whose file is gone
  - A checksum rehash pass is deliberately **not** automatic: it costs I/O
    proportional to the drive.

## Search and stats

- `GET /api/v1/search?q=&limit=20&scope=all|name|content` ‚Ü?  `{results:[{id,name,kind,parentId,size,mime,updatedAt,matched,snippet}], scope}`.
  `scope=name` is the old case-insensitive substring match on names;
  `scope=content` searches the FTS5 body index; `all` (default) unions them with
  name hits first, and `matched` says which half matched.
  - The index is scoped by **workspace**: a result is returned when the caller
    owns the row or belongs to its workspace, so a member's upload into a shared
    folder is findable by every member.
  - The index covers text-like files up to 2 MiB (`MAX_INDEX_BYTES`), plus
    **container documents**: Office files (`.pptx`/`.docx`/`.xlsx` up to 16 MiB,
    flattened by `office-text.js`) and **PDFs** (`.pdf` up to 24 MiB, read by
    `pdf-text.js` ‚Ä?Flate streams, `/ToUnicode` CMaps so CJK PDFs decode to real
    characters, WinAnsi for simple fonts). A PDF that is encrypted or is a scan
    has no extractable text and is recorded as a refusal with that reason, not as
    a coverage hole. Anything containing a NUL byte is skipped, and the index is
    rebuilt on boot when it is empty.
  - The index schema has exactly one definition (`SEARCH_COLUMNS` in `db.js`).
    `snippet()`/`highlight()` address columns by **index** and a column *name*
    silently resolves to column 0, so the query uses `BODY_COLUMN` derived from
    that list and the boot compares the live table's shape against it. A test
    pins both halves: the silent-fallback behaviour of FTS5 and our column order.
  - Two mechanisms are merged: FTS5 (ranked, with snippets) and a `LIKE` scan.
    FTS5's tokeniser glues digits and words to CJK ‚Ä?`1765` does not match
    Áî±ÈªëÊ†ºÂ∞î‰∫?765Âπ¥ÊèêÂá?‚Ä?so the substring scan is the superset, and FTS hits
    stay on top because they matched a real token boundary.
  - It is derived data: trashing or purging drops the rows, renaming keeps the
    name in sync, restoring re-indexes.
  - Chinese is handled by a substring scan, because FTS5's `unicode61` treats a
    run of CJK characters as a single token and could never match Ëê•Êî∂ inside
    Êú¨Â≠£Â∫¶Ëê•Êî?
- `GET /api/v1/storage/stats` ‚Ü?  `{stats:{files,folders,trashed,bytes,quotaBytes,starred,shares,uploads}}`.

## Sharing

- `POST /api/v1/nodes/:id/share` `{permission:"viewer"|"downloader",expiresInDays?,password?,maxDownloads?}`
  ‚Ü?`201 {share:{id,token,url,permission,expiresAt,maxDownloads,downloads,hasPassword,createdAt}}`.
  `url` is `/s/<token>` on the same origin.
- `GET /api/v1/nodes/:id/shares` ‚Ü?`{shares:[...]}`; `DELETE /api/v1/shares/:shareId`.
- Public, no auth: `GET /api/v1/shared/:token` ‚Ü?`{share:{token,permission,expiresAt,node:{id,name,size,mime,kind}},
  protected:boolean, locked:false}`; when a password is set the response is `401`
  with `code:"SHARE_LOCKED"` until a valid `?password=` (or `X-Share-Password`)
  is supplied.
- Public single file inside a shared folder:
  `GET /api/v1/shared/:token/file/:nodeId` (same password rule).
- Public download: `GET /api/v1/shared/:token/content` (same range handling,
  always `Content-Disposition: attachment`), increments `downloads`; over
  `maxDownloads` ‚Ü?`404 SHARE_NOT_FOUND`.
- Public page: the web client serves `/s/<token>` (same bundle, SPA route).

## Static hosting

The server serves `apps/web` at `/`, with SPA fallback to `index.html` for
`/s/*` and other non-API paths. Assets are served with long cache headers;
`index.html` and `app.js` are no-store during development.

## Web client rules

- Vanilla ES modules, no bundler, no frameworks, no CDN. Files:
  `apps/web/index.html`, `apps/web/app.js`, `apps/web/lib/*.js`,
  `apps/web/styles/*.css`.
- Same origin API base `/api/v1`; token in `localStorage["mdrive-token"]`.
- Views: login/register, drive (sidebar tree, breadcrumb, list/grid, upload with
  progress and resumable chunks for files > 8 MiB, drag & drop), preview drawer
  (image, pdf iframe, text/markdown), share dialog, trash, search, team panel.

### Upload queue (client behaviour)

- Every upload goes through one scheduler (`createUploadScheduler` in
  `lib/upload.js`, wrapped by `lib/upload-queue.js`): at most
  `UPLOAD_CONCURRENCY` (3) transfers are in flight, a settled task frees its
  slot for the next one, and a failing task never blocks the rest of the queue.
- `task.pause()` aborts the transfer but keeps the resumable session and
  records the state as `paused`; `task.resume()` restarts from the chunks the
  server already holds. `task.cancel()` keeps its old meaning: state
  `canceled` and the temp session is dropped.
- The queue header owns ÂÖ®ÈÉ®ÊöÇÂÅú / ÂÖ®ÈÉ®ÁªßÁª≠ (the global switch) and Ê∏ÖÁ©∫Â∑≤ÂÆåÊà?
  A row shows speed and ETA (`1.2 MB/s ¬∑ Ââ©‰Ωô 8s`, percentage only when no rate
  is known yet) and marks a deduplicated upload with `Áßí‰º†`.
- History: the summary of every finished task `{name,size,parentId,sessionId,state}`
  is stored in `localStorage["mdrive-uploads"]` (last 30). A reload shows those
  rows as read-only history, drops the ones that cannot be rebuilt (a `File`
  object cannot survive a page load) and toasts `‰∏äÊ¨°Êú?N ‰∏™‰∏ä‰º†Êú™ÂÆåÊàê`. No
  progress or location is invented for them.
- Dark, quiet, dense: neutral near-black surfaces, one accent, 13px UI text,
  32px rows, focus rings, reduced-motion respected.

## CLI rules

Package `packages/cli` with bin `mdrive` (`bin/mdrive.mjs`).
Commands: `login`, `logout`, `whoami`, `ls`, `tree`, `mkdir`, `mv`, `cp`, `stat`,
`upload`, `download`, `cat`, `rm`, `restore`, `purge`, `star`, `search`, `sync`,
`index`, `verify`, `tiers`, `stats`, `versions`, `version download`,
`version restore`, `share`, `share list`, `revoke`, `team`, `team add`,
`team remove`. Global flags `--server`, `--token`, `--json`. Env `MDRIVE_SERVER`,
`MDRIVE_TOKEN`, `MDRIVE_CONFIG_DIR`. Token cache: `%APPDATA%\\mdrive\\config.json`
on Windows, `~/.config/mdrive/config.json` elsewhere. Exit codes: 0 ok, 1 error,
2 usage.

## Folder sync

`mdrive sync LOCAL_DIR REMOTE_PATH` is a client-side feature: the server exposes
nothing sync-specific, and no schema carries sync state. The rules it follows,
because they decide whether data survives:

- **Content decides, never mtime.** A comparison of sha256 (local, computed) against
  `blobHash` (remote, already in every node payload) answers "are these the same
  bytes". A photo library is the motivating case: its mtimes are EXIF capture
  times, so they say nothing about what was copied when.
- **A baseline is required to arbitrate.** `~/.config/mdrive/sync/<key>.json`
  stores `{sha256, size, remoteId, version}` per relative path. Without history,
  "changed on both sides" and "changed on one side" are indistinguishable, so a
  first run adopts identical files and refuses to guess otherwise.
- **A path changed on both sides is a conflict**, reported and untouched. Neither
  direction is safe: uploading loses the remote edit, downloading loses the local
  one.
- **Deletion needs `--delete`.** "Missing locally" (a detached drive, a half-copied
  folder) is not "delete everywhere".
- **Every upload re-reads the remote version first** and turns a moved version into
  a conflict, so an upload can never silently overwrite a concurrent write.
- **The baseline advances only for successes**, so a failed path is retried rather
  than remembered as "in sync".

`--direction up|down|both` restricts which side may move; `--dry-run` prints the
plan and writes nothing; `--rehash` ignores the local size+mtime cache.