# Marvelous Drive HTTP API

Versioned under `/api/v1`. JSON in, JSON out; the exception is file content,
which is raw bytes in both directions. All identifiers are UUIDs, all timestamps
ISO-8601 UTC, and every failure uses one envelope.

```json
{ "error": { "code": "FORBIDDEN", "message": "You do not have permission for this operation." } }
```

Clients branch on `error.code`, never on the message.

| HTTP | code | Meaning |
| --- | --- | --- |
| 400 | `INVALID_INPUT` | Body, query or name failed validation |
| 400 | `INVALID_ID` | Path id is not a UUID |
| 400 | `INVALID_PARENT` | Move into itself, into a descendant, or into a missing folder |
| 400 | `NOT_A_FILE` / `NOT_FOLDER` | Wrong node kind for the operation |
| 401 | `UNAUTHENTICATED` | Missing, invalid or expired bearer token |
| 401 | `INVALID_CREDENTIALS` | Wrong e-mail or password |
| 401 | `SHARE_LOCKED` | Share link needs its password |
| 403 | `FORBIDDEN` | Authenticated but not allowed |
| 404 | `NOT_FOUND` | Node, version, session or link not found |
| 404 | `BLOB_NOT_FOUND` | Instant upload asked for bytes the store does not hold |
| 404 | `SHARE_NOT_FOUND` | Link unknown, expired, or out of downloads |
| 409 | `CONFLICT` | Name already used in that folder / duplicate account |
| 409 | `VERSION_CONFLICT` | `expectedVersion` is stale |
| 409 | `UPLOAD_INCOMPLETE` | Chunks are still missing |
| 409 | `CHECKSUM_MISMATCH` | Declared sha256 does not match the bytes |
| 409 | `DRIVER_UNSUPPORTED` | The operation needs a storage driver that is not active |
| 409 | `LOCKED` | Another client holds a live edit lock on the node |
| 413 | `FILE_TOO_LARGE` | Above `DRIVE_MAX_UPLOAD_BYTES` |
| 500 | `INTERNAL_ERROR` | Unexpected failure (logged server side) |
| 503 | `DATABASE_UNAVAILABLE` | Health probe failed |

## Authentication

```http
POST /api/v1/auth/register   { "email": "you@example.com", "password": "8-200 chars", "name": "optional" }
POST /api/v1/auth/login      { "email": "you@example.com", "password": "..." }
GET  /api/v1/me
PATCH /api/v1/me             { "name": "New display name" }
```

`201`/`200` → `{ "token": "<jwt>", "user": { "id", "email", "name", "role", "createdAt" } }`.
Tokens are HS256, valid 12 hours, sent as `Authorization: Bearer <jwt>`. A
`?token=` query parameter is also accepted so a plain `<a download>` link works.
Passwords are stored as `scrypt:<salt>:<hex>`; the salt is 16 random bytes per
account and the comparison is constant time.

## Nodes

```ts
type Node = {
  id: string; name: string; kind: 'folder' | 'file'
  parentId: string | null; size: number; mime: string | null
  version: number; starred: boolean; blobHash: string | null
  createdAt: string; updatedAt: string; deletedAt: string | null
}
```

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/nodes` | No `parentId` → the whole live tree (what the web client caches); `?parentId=<uuid>` → direct children; `?parentId=root` → root level. Plus `?trash=1`, `?starred=1`, `?kind=file\|folder`, `?sort=name\|size\|updated\|created`. Folders sort before files |
| GET | `/nodes/:id` | Adds `children`, `path` (breadcrumb), and for files `downloadUrl`/`previewUrl` |
| POST | `/nodes` | `{ name, kind?, parentId? }` → `201 { node }` |
| PUT | `/nodes/:id` | `{ name?, parentId?, expectedVersion? }` → `{ node }` |
| DELETE | `/nodes/:id` | Soft delete with cascade → `{ ok, trashed }` |
| POST | `/nodes/:id/restore` | Restores the node and its trashed descendants → `{ node }` |
| DELETE | `/nodes/:id/permanent` | Trashed nodes only; drops blobs whose refcount hits zero → `{ ok, purged }` |
| PUT | `/nodes/:id/star` | `{ starred: boolean }` → `{ starred }` |
| POST | `/nodes/:id/copy` | `{ name?, parentId? }`; folders copy recursively → `201 { node }` |
| GET | `/nodes/:id/path` | `{ path: [{id,name,kind}] }` root → node |
| POST | `/nodes/:id/archive` | Zips a folder into a `.zip` file node next to it → `201 { node }` |
| POST | `/nodes/archive` | `{ ids: [...] }` (max 200) → one `.zip` node next to the selection, `selection-N-items.zip` by default; same-named folders inside the archive are suffixed ` (1)`, ` (2)`; trashed nodes are skipped |

`version` starts at 1 and increments on every mutation of the row — content
overwrite, rename, move, restore — so `expectedVersion` guards metadata edits as
well as bytes.

Names are trimmed, 1–255 characters, cannot contain `/`, `\` or control
characters, and must be unique among live siblings (`409 CONFLICT`).
Uploads and copies therefore auto-suffix ` (1)`, ` (2)` when needed.

## Content

| Method | Path | Notes |
| --- | --- | --- |
| PUT | `/uploads?parentId=&name=&onConflict=` | Raw body; creates a file or resolves the name collision (`201` created, `200` overwritten/skipped) |
| POST | `/uploads/instant` | JSON `{ name, sha256, size, parentId?, mime?, onConflict? }`; node for an already stored blob → `201 { node, deduplicated: true }` |
| GET | `/blobs/:sha256` | `{ exists, sha256, size, refs }` for a stored blob; `404 NOT_FOUND`; `400` unless 64 lowercase hex |
| PUT | `/files/:id/content` | Raw body, replaces content, appends a version, `X-Checksum-Sha256` optional; `?onConflict=skip` writes nothing |
| GET | `/files/:id/content` | Streams the blob; `Range` → `206`; `?download=1` → attachment |
| GET | `/files/:id/text` | `{ text, truncated, mime }` (first 512 KiB by default, `?limit=`) |
| GET | `/files/:id/versions` | `{ versions: [{ id, version, size, mime, createdBy, createdAt }], currentVersion }` |
| POST | `/files/:id/versions/:versionId/restore` | `{ expectedVersion }` → `{ node }`; `409 VERSION_CONFLICT` when stale |
| GET | `/files/:id/versions/:versionId/content` | Streams one stored version; `?download=1` names it `<name> (vN).<ext>`; the live file is untouched |

The file name for `PUT /uploads` comes from `?name=`, then `X-File-Name`, then
`Content-Disposition: filename=`, then `upload.bin`.

### Conflict strategy and instant upload

`onConflict` is accepted by `PUT /uploads`, `POST /uploads/instant` and
`POST /uploads/sessions/:id/complete`. Any other value → `400 INVALID_INPUT`.

| Value | Result |
| --- | --- |
| `overwrite` (default) | Bytes replaced, `version` +1, previous blob appended to the versions list |
| `rename` | New bytes stored as `name (1).ext` (`uniqueName()`, counter before the extension) → `201 { node, renamedFrom }`; the old file is untouched |
| `skip` | Nothing written → `200 { node, skipped: true }` with the node that already owns the name; the uploaded blob is released, so `blobs.refs` stays the same |

`PUT /files/:id/content` always targets an existing file, so `skip` there means
"keep the current bytes" and `rename` is `400`.

Instant upload skips the transfer when the bytes are already in the store:

```http
GET  /api/v1/blobs/<sha256>     → 200 { exists: true, sha256, size, refs }   (404 NOT_FOUND, 400 INVALID_INPUT)
POST /api/v1/uploads/instant    { name, sha256, size, parentId?, mime?, onConflict? }
                               → 201 { node, deduplicated: true }            (404 BLOB_NOT_FOUND, 400 INVALID_INPUT on size mismatch)
```

The probe exposes `size` and `refs` only — never the on-disk path. For files
above the client's threshold the flow is: hash locally, probe, and either call
`/uploads/instant` (hit) or fall back to `PUT /uploads` / `/uploads/sessions`
on `404 BLOB_NOT_FOUND`. The second copy costs one blob reference, not one file
on disk.

## Resumable uploads

1. `POST /uploads/sessions` `{ name, size, sha256?, parentId?, chunkSize? }` →
   `201 { upload: { id, name, size, parentId, chunkSize, totalChunks, receivedChunks, expiresAt } }`.
   `chunkSize` is 64 KiB – 64 MiB, default 8 MiB.
2. `PUT /uploads/sessions/:id/chunks/:index` raw body. Re-uploading a stored
   chunk is idempotent; a short chunk is rejected with `400`.
3. `GET /uploads/sessions/:id` → resume point (`receivedChunks`).
4. `POST /uploads/sessions/:id/complete` `?onConflict=` (or in the JSON body)
   → assembles, verifies sha256, creates or resolves the node →
   `201 { node }` (or `200 { node, skipped: true }`). Missing chunks →
   `409 UPLOAD_INCOMPLETE`, bad digest → `409 CHECKSUM_MISMATCH`.
5. `DELETE /uploads/sessions/:id` → `{ ok }`.
6. `GET /uploads/sessions` lists live sessions; `DELETE /uploads/sessions` drops
   the expired ones.

Sessions expire after 24 hours and then answer `404`.

## Sharing

```http
POST   /nodes/:id/share      { "permission": "viewer"|"downloader", "expiresInDays"?, "password"?, "maxDownloads"? }
GET    /nodes/:id/shares     → { shares: [...] }
DELETE /shares/:shareId      → { ok: true }
```

```ts
type Share = {
  id: string; nodeId: string; token: string; url: string       // url = <origin>/s/<token>
  permission: 'viewer' | 'downloader'
  expiresAt: string | null; maxDownloads: number | null; downloads: number
  hasPassword: boolean; createdAt: string
}
```

Public endpoints (no token):

- `GET /shared/:token[?password=]` → `{ share: { token, permission, expiresAt, node: { id, name, size, mime, kind } }, protected, locked }`;
  `401 SHARE_LOCKED` while the password is missing or wrong.
- `GET /shared/:token/content[?password=]` → bytes, always
  `Content-Disposition: attachment`, counts one download.
- `GET /shared/:token/file/:nodeId[?password=]` → one file inside a shared folder.

## Office preview (OOXML)

`GET /api/v1/files/:id/office` — server-side extraction for `.pptx`, `.docx`
and `.xlsx`. No LibreOffice, no dependency: the OOXML package is a ZIP of XML
parts, so `zip-read.js` reads the container and `office.js` walks the text runs.

```ts
// shape of `office`
{
  kind: 'slides' | 'document' | 'sheet'
  pages: [{ index: number, title: string, blocks: Block[] }]   // slides + document
  sheets: [{ name: string, rows: Cell[][] }]                    // sheet
  meta: { slideCount?, wordCount?, sheetCount?, truncated?: boolean }
}
type Block =
  | { type: 'heading'; text: string; level: number }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; items: string[] }
  | { type: 'table'; rows: Cell[][] }
  | { type: 'image'; alt?: string }
type Cell = { text: string; type: 'string' | 'number' | 'boolean' | 'date' | 'error' | 'empty' }
```

| Case | Answer |
| --- | --- |
| `.pptx` / `.docx` / `.xlsx` parsed | `200 { office, file: { id, name, mime, size } }` |
| Not OOXML (wrong extension, or bytes are not a ZIP, or no main part) | `400 NOT_OFFICE` |
| OOXML but damaged / encrypted / unsupported compression | `422 PREVIEW_UNAVAILABLE` |
| Blob larger than 64 MiB | `413 FILE_TOO_LARGE` |
| Folder id | `400 NOT_A_FILE` |

Notes that matter for fidelity:

- **Slide order** follows `ppt/presentation.xml` → `p:sldIdLst` → `r:id` →
  `ppt/_rels/presentation.xml.rels` targets, not the file numbering, because a
  reordered or trimmed deck has slide files whose names no longer match their
  position.
- **Document pages** come from the three page signals Word leaves behind:
  `w:br w:type="page"`, `w:pPr/w:pageBreakBefore` and `w:lastRenderedPageBreak`;
  with none of them the document is one page.
- **Sheets** resolve through `xl/workbook.xml` + rels, decode `sharedStrings`,
  handle `s`/`inlineStr`/`str`/`b`/`e`/`d` and bare numbers, keep sparse column
  positions, and clamp at 200 rows × 50 columns (`meta.truncated`).
- Numeric cells are rendered in the shortest decimal that round-trips, so
  `32.799999999999997` shows as `32.8`, which is what the spreadsheet displays.
- Legacy binary `.ppt`/`.doc`/`.xls` answer `400 NOT_OFFICE` — they are not OOXML.

## Dedup, conflicts and quota

```http
GET  /api/v1/blobs/:sha256                     → { exists, sha256, size, refs }
POST /api/v1/uploads/instant { name, sha256, size, parentId?, mime?, onConflict? }
                                               → 201 { node, deduplicated: true }
                                               → 404 BLOB_NOT_FOUND (fall back to a real upload)
```

`onConflict` applies to `PUT /uploads`, `POST /uploads/sessions/:id/complete` and
`POST /uploads/instant`:

| Value | Behaviour |
| --- | --- |
| `overwrite` (default) | replace the bytes of the same-named file, appending a version |
| `rename` | keep both, the new one becomes `name (1).ext` (`renamedFrom` in the response) |
| `skip` | do nothing, answer `200 { node: <existing>, skipped: true }`; the uploaded bytes are released |

`PUT /files/:id/content` accepts `skip` (keep the current bytes) and rejects
`rename` with `400 INVALID_INPUT` — there is nothing to rename away from.

Quota (`DRIVE_QUOTA_BYTES`, `0` = unlimited) is enforced on every write path and
answers `413 QUOTA_EXCEEDED` with `{ used, limit, remaining }` in the message
tail. Overwrites only count the size difference; `POST /uploads/sessions`
reserves the declared size immediately.

## Storage backend

`GET /api/v1/maintenance/storage/backend` (owner) →
`{ backend: { name, kind, blobs, bytes } }`. `kind` is `filesystem` for the local
store; the field exists so a remote or tiered backend can report itself.

## Tier demotion

`POST /api/v1/maintenance/storage/demote` (owner, `tiered` driver only) —
`{ days?, limit? }` → `{ days, considered, attempted, moved, results }`. Each blob
is copied to the cold tier, rehashed, and only then removed locally; a mismatch
leaves the source untouched and reports `checksum-mismatch`. On the `local` or
`s3` driver it answers `409 DRIVER_UNSUPPORTED`.

## Hot / cold report

`GET /api/v1/maintenance/storage/tiers?days=90` (owner) →
`{ tiers: { thresholdDays, cutoff, blobs, hotBytes, coldBytes, coldCount, cold: [...] } }`,
cold files sorted by size. Access is recorded on download at most once a day per
blob, so the numbers are cheap and do not grow with traffic.

## Blob store maintenance

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/maintenance/blobs` | Cheap scan: rows/files, `missing`, `orphans`, `sizeMismatch` |
| GET | `/maintenance/blobs/verify?limit=&maxBytes=` | **Rehashes** blobs; `{verified, bytes, corrupt:[{hash,expected,actual,size}], missing, remaining}` |
| POST | `/maintenance/blobs/quarantine` | `{hashes?}` or a fresh scan → moves corrupt blobs to `data/quarantine/` and drops their rows |
| POST | `/maintenance/blobs/reclaim` | Deletes files no row references |
| POST | `/maintenance/blobs/forget-missing` | Drops rows whose file is gone |

Why two levels: `/maintenance/blobs` is O(files) metadata and can run any time;
`verify` reads every byte, so it takes `limit`/`maxBytes` and reports `remaining`.
Corruption is *quarantined, not deleted* — the bytes are evidence, and the row is
dropped so a download fails with `404` instead of serving the wrong content.

## Search index maintenance

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/maintenance/search` | `{ coverage: { eligible, covered, refused, missing }, upToDate }`; owner only |
| POST | `/maintenance/search/reindex` | Rebuilds every account's index → `{ summary, before, after }` |

"Refused" is not a failure: a binary or oversized file is examined, recorded in
`index_skips` with a reason, and excluded from `missing`. `eligible = covered +
refused + missing`, which is what makes `upToDate` a real signal.

## Workspaces

`GET /nodes?workspace=<uuid>` lists every node in a workspace the caller belongs
to; without the parameter the listing is the caller's own nodes only.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/workspaces` | `{ workspaces:[{ id, name, ownerId, role, active, files, folders, bytes }] }` |
| GET | `/workspace/members` | `{ workspace, members }` — the *active* workspace only |
| POST | `/workspace/members` | `{ email, role? }` (admin) → `201`; `404` for an unknown account |
| DELETE | `/workspace/members/:id` | (admin) → `{ ok }`; the owner cannot be removed |

`user.workspace` (`{ id, name, ownerId, role }`) is part of every auth response.
A node is readable by its owner or by any member of its workspace; names are
unique per folder across the workspace.

## Edit locks

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/nodes/:id/lock` | `{ lock: null \| { nodeId, userId, client, acquiredAt, expiresAt } }` |
| POST | `/nodes/:id/lock` | `{ client?, ttlMs?, force? }` → `{ lock, tookOver, supersededClient }`; `409 LOCKED` for another user's live lock |
| DELETE | `/nodes/:id/lock` | `{ released }`; `403` when the caller is not the holder |

`409 LOCKED` carries the holder's client in the message (the envelope has no
other field) and `409` + `force: true` takes over, recorded as
`lock-takeover` in the audit log.

## Audit

- `GET /api/v1/audit?limit=50&action=upload&nodeId=<uuid>` →
  `{ entries: [{ id, action, nodeId, detail, ip, createdAt }], retentionDays: 90 }`.
  `limit` is clamped to 200; only the caller's own rows are ever returned.
- Actions recorded so far: `upload`, `instant-upload`, `overwrite`, `trash`,
  `restore`, `purge`. A row is written **after** the change succeeds, so a
  rejected request leaves no trace.

## Static hosting

Assets under `/app.js`, `/lib/*.js` and `/styles/*.css` are served with
`cache-control: no-cache` and a weak `ETag` (`W/"<size>-<mtime>"`); a conditional
request that matches answers `304` with no body. `index.html` is `no-store`.
Long-lived caching is deliberately absent: the filenames carry no content hash, so
a long max-age would serve yesterday's code after every deploy.

## Search, stats, system

```http
GET /search?q=&limit=20&scope=all|name|content
                            → { results: [{ id, name, kind, parentId, size, mime, updatedAt, path, matched, snippet }], scope }
GET /storage/stats          → { stats: { files, folders, trashed, bytes, quotaBytes, starred, shares, uploads } }
GET /healthz                → { status: "ok", version }
GET /system/version         → { version, name: "Marvelous Drive" }
```

## Static client

`GET /` and every non-API path serve `apps/web/index.html`; assets under
`/styles` and `/lib` are served with a one hour cache; `index.html` is
`no-store`. `/s/<token>` is the public share page, resolved by the client.