# Security

Marvelous Drive is designed for a trusted operator running it for themselves or
a small team. "Trusted operator" is not the same as "trusting input": every
request is treated as hostile and every stored value is validated on the way in
and on the way out.

## Identity

| Concern | Implementation |
| --- | --- |
| Password storage | scrypt, per-user 16-byte salt, 64-byte derived key, `scrypt:<salt>:<hex>` |
| Comparison | `timingSafeEqual` on equal-length buffers, no early return |
| Password policy | 8–200 characters, one uppercase/lowercase rule is intentionally absent (length beats composition) |
| Token | HS256 JWT, `{ sub, email, name, iat, exp }`, 12 hour TTL |
| Secret | `JWT_SECRET` when set, otherwise a 32-byte random secret written to `data/.jwt-secret` (0600) on first boot |
| Session binding | every request re-reads the user row; a deleted account invalidates its tokens immediately |
| Token transport | `Authorization: Bearer`, plus `?token=` for direct download links |

Rotating the secret signs everybody out. That is the intended recovery path.

## Authorization

Drive is personal: one account owns its whole tree, so there is no cross-user
read path to defend. The invariant every route keeps is that the `user_id`
filter is part of the SQL, not a check after the fact:

```js
db.prepare('SELECT * FROM nodes WHERE id=? AND user_id=?').get(id, userId)
```

Child rows (`node_versions`, `shares`, `node_locks`, `upload_sessions`) are
always reached through a node that was already resolved for that user, and
deleting a user cascades.

## Uploads

- **Streaming, not buffering**: bodies are written to `data/tmp` while being
  hashed; a 2 GiB upload never sits in memory.
- **Ceiling**: `DRIVE_MAX_UPLOAD_BYTES` (default 2 GiB); the request is cut off
  mid-stream and the temp file is deleted.
- **Chunk sessions**: each chunk is length-checked against `chunkSize` (last
  chunk against the remainder); a wrong length is rejected and deleted.
- **Digest**: when the client declares a sha256 it is verified before the blob is
  adopted, so a truncated or corrupted transfer can never become a file.
- **Names**: trimmed, 1–255 chars, `/`, `\` and control characters rejected;
  response headers quote and sanitise the name again for
  `Content-Disposition`.
- **Temp files** carry the pid and a random suffix, never a client-supplied path.

## Content and downloads

- Blob paths are derived from a 64-hex sha256, so a request can never address a
  file outside `data/blobs`.
- The static handler normalises the path, rejects any `..` segment, and refuses
  targets that escape `apps/web`.
- Every response sets `X-Content-Type-Options: nosniff`, so a stored
  `text/html` cannot be sniffed into a script in another context.
- `Content-Disposition: attachment` is used for every share download, which
  prevents a shared HTML file from executing on the Drive origin.

## Sharing

- Tokens are 24 random bytes, base64url (192 bits), stored as-is because they
  are capability tokens, not passwords.
- Optional password: scrypt-hashed, checked with `timingSafeEqual`; the metadata
  endpoint answers `401 SHARE_LOCKED` without revealing whether the file exists.
- `expiresAt` and `maxDownloads` are enforced on *every* read, not at creation
  time, and an exhausted link answers `404 SHARE_NOT_FOUND` so its existence is
  not confirmed.
- Revoking a share deletes the row; the link is dead immediately.
- Files inside a shared folder are only served when the node is inside the shared
  subtree (the ancestor walk is bounded to 512 hops).

## Outbound trust

Drive makes no outbound requests at all: there is no upstream service to
authenticate to, and no user-supplied URL is ever fetched. The only network
traffic is the storage driver talking to its configured S3 endpoint, which comes
from server-side configuration and never from a request.

That property is worth keeping deliberately: an integration that lets a user type
a server URL turns the API into a request proxy, and the fixes for that (allow
lists, redirect suppression, metadata-address blocking) are always incomplete.

## Rate limiting

`POST /api/v1/auth/login` allows ten failed attempts per client address per
fifteen minutes. Exhausting it answers:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 900

{ "error": { "code": "RATE_LIMITED", "message": "Too many sign-in attempts. Retry after 900 seconds." } }
```

The counter is per address (`X-Forwarded-For` first hop, else the socket
address), cleared by a successful sign-in, and held in memory — a restart forgets
it, which is the right trade for one process and avoids a database write per
attempt. Failed attempts also return `X-Login-Attempts-Remaining` so a client can
warn before it is locked out.

## Deployment checklist

1. Set `JWT_SECRET` (32+ random bytes) unless you rely on the generated file.
2. Bind to `127.0.0.1` and terminate TLS in front (Caddy, nginx).
3. Keep `data/` outside any shared or synced folder; it holds the database, the
   secret, and every file.
4. Back up `data/` (see `scripts/backup.mjs`) and store copies off the machine.
5. Keep the built-in login throttle in place; add a reverse-proxy limit in front
   of `/api/v1/auth/login` as a second layer if the instance is internet-facing.
6. Rotate `JWT_SECRET` after any suspected leak — all sessions end.