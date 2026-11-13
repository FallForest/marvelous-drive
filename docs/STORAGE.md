# Storage

Blob bytes are reached through one seam (`apps/server/src/storage/backend.js`),
so the store can be a folder on disk or an S3-compatible bucket. Nothing else in
the codebase knows which.

## Drivers

| `DRIVE_STORAGE` | Backend | Where the bytes go |
| --- | --- | --- |
| `local` (default) | `LocalBackend` | `$DRIVE_DATA_DIR/blobs/<xx>/<sha256>` |
| `s3` | `S3Backend` | `<bucket>/<prefix>/<sha256>` â€?AWS S3, MinIO, R2, B2 |
| `tiered` | `TieredBackend` | hot: local `blobs/`; cold: `<bucket>/<coldPrefix>/<sha256>` |

The driver is chosen once at import time, and the boot log says which one is
live:

```
Storage backend: s3 (bucket marvelous-drive)
```

A misconfigured driver fails at boot, not at the first upload: an `s3` driver
without an endpoint and bucket throws `S3 backend needs DRIVE_S3_ENDPOINT and
DRIVE_S3_BUCKET.`

## S3 configuration

```sh
DRIVE_STORAGE=s3
DRIVE_S3_ENDPOINT=https://s3.eu-central-1.amazonaws.com   # or http://127.0.0.1:9000 for MinIO
DRIVE_S3_BUCKET=marvelous-drive
DRIVE_S3_REGION=eu-central-1
DRIVE_S3_ACCESS_KEY_ID=...
DRIVE_S3_SECRET_ACCESS_KEY=...
DRIVE_S3_PREFIX=drive            # optional, keeps other data out of the way
DRIVE_S3_PATH_STYLE=true         # true for MinIO; false for virtual-host style
DRIVE_S3_SESSION_TOKEN=...       # optional, for temporary credentials
```

### MinIO, locally

```sh
docker run -d --name minio -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
  -v minio-data:/data minio/minio server /data --console-address ":9001"
```

Then create the bucket (console at http://127.0.0.1:9001) and run the server with
the variables above and `DRIVE_S3_PATH_STYLE=true`.

## Verifying the driver without Docker

Docker Hub is not always reachable, and a stub that ignores the `Authorization`
header proves nothing about a signature. `scripts/s3-fixture.mjs` is a small
S3-compatible server that **recomputes SigV4 from the wire** and answers `403`
with the canonical request when it does not match:

```sh
node scripts/s3-fixture.mjs --port 9100          # bucket drive, minioadmin/minioadmin
DRIVE_STORAGE=s3 DRIVE_S3_ENDPOINT=http://127.0.0.1:9100 \
DRIVE_S3_BUCKET=drive DRIVE_S3_ACCESS_KEY_ID=minioadmin \
DRIVE_S3_SECRET_ACCESS_KEY=minioadmin node apps/server/src/index.js
```

`node scripts/s3-check.mjs` does all of that by itself (fixture + server + eleven
checks) and is part of the verification suite. An unsigned request answers `403`,
which is also how the gate knows the fixture is up.

## Two tiers: `DRIVE_STORAGE=tiered`

Local disk for what is being used, an object store for what is not:

- **Writes land hot.** A blob is hot when it arrives; that is the definition.
- **Reads do not care.** `get()`/stat()/link() consult the local tier first, then
  cold. A cold read is slower exactly once.
- **Demotion is explicit.** `mdrive tiers` reports what has been idle;
  `mdrive tiers --demote` (or `POST /maintenance/storage/demote`) moves at most
  `limit` blobs per run. Each one is copied, **rehashed**, and only then deleted
  locally â€?an interrupted run is safe to repeat, and a checksum mismatch leaves
  the source in place.
- **Recency and tier are different things.** Reading a cold blob records an access
  (so the report stops calling it idle) but does not move it back to disk unless
  you ask with `promoteToHot()`. The report is about use, the tier is about bytes.

```sh
DRIVE_STORAGE=tiered
DRIVE_COLD_AFTER_DAYS=90        # what "idle" means for the report
DRIVE_S3_ENDPOINT=...           # the cold tier
DRIVE_S3_COLD_BUCKET=marvelous-drive-cold
DRIVE_S3_COLD_PREFIX=cold
```

`node scripts/tiered-check.mjs` proves the loop against the fixture: upload â†?confirm hot â†?demote â†?confirm the local copy is gone â†?read (and range-read) the
same file back through the object store.

## What changes on S3

Two properties of the local backend cannot be reproduced remotely, and the code
is honest about both:

- **`link()` downloads.** A local blob can be hard-linked into a temp file for ZIP
  assembly; an S3 object cannot. `S3Backend.link()` downloads it instead, so
  building a large ZIP is slower and uses bandwidth.
- **There is no `path()`.** Calls to `backend.path()` (only ever used by assembly
  helpers) throw on S3. `seam.test.js` keeps routes from acquiring that habit.

Everything else is unchanged: Range downloads, shares, versions, thumbnails,
Office preview, text preview, the search indexer, trash retention and checksum
verification all work because they go through `get()` / `stat()` / `remove()`.

## SigV4

The signature is implemented by hand (`signRequest` in `s3-backend.js`) because
this project has no runtime dependencies. The canonical request is asserted
against the worked example in the AWS documentation
(`apps/server/test/s3.test.js`), which is the only practical way to catch a
signing bug: S3 answers `403` with no useful detail.

Three details that are easy to get wrong, all covered by tests:

1. **Encoding** â€?AWS wants RFC 3986 percent-encoding, not `encodeURIComponent`
   (`(paren)` becomes `%28paren%29`, `/ ` becomes `%20`, and a key's slashes are
   encoded per segment).
2. **Streaming bodies** â€?`fetch()` requires `duplex: 'half'` for a stream, and the
   signature needs a `content-length` the stream does not have, so `put()` takes
   it from `stat()`.
3. **Session tokens** â€?a temporary credential adds `x-amz-security-token` to the
   signed headers; forgetting it produces a 403 that looks like a bad key.

## Checksums and the store

`mdrive verify` rehashes whatever the backend returns and compares it with the
object key, so it works the same on S3. A corrupt object is copied into
`data/quarantine/` and its row is dropped â€?on S3 the object itself is deleted
after the copy, so the same evidence rule holds.

## Migration between drivers

There is no automatic migration: the two stores use different layouts and the
database only records hashes. Moving from local to S3 means uploading every blob
under its hash as the key, which is exactly what `backend.put(hash, path)` does:

```js
// Pseudo-code for an operator script; not shipped, because a half-migrated store
// is worse than a reported one.
for (const row of db.prepare('SELECT hash FROM blobs').all()) {
  const local = new LocalBackend(oldBlobDir)
  if (!(await s3.stat(row.hash))) await s3.put(row.hash, await local.link(row.hash, tmp))
}
```