# Deployment

Drive is one Node process that serves both the API and the web client. It needs a
writable data directory and nothing else.

## Bare metal / a small VM

```sh
git clone <repository> marvelous-drive && cd marvelous-drive
node --version                     # 22.5+
DRIVE_DATA_DIR=/srv/mdrive/data PORT=4400 HOST=127.0.0.1 \
JWT_SECRET=$(openssl rand -hex 32) \
  node apps/server/src/index.js
```

Run it under systemd:

```ini
[Unit]
Description=Marvelous Drive
After=network.target

[Service]
User=mdrive
WorkingDirectory=/srv/mdrive
Environment=PORT=4400 HOST=127.0.0.1 DRIVE_DATA_DIR=/srv/mdrive/data
EnvironmentFile=/srv/mdrive/.env
ExecStart=/usr/bin/node apps/server/src/index.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/srv/mdrive/data

[Install]
WantedBy=multi-user.target
```

## Docker

```sh
docker compose up -d --build          # http://localhost:4400, data in the drive_data volume
```

The compose file publishes only `4400` and keeps state in the `drive_data`
volume; nothing else is required.

## TLS in front

Caddy:

```
drive.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:4400
}
```

nginx equivalent, with the two settings a drive actually needs (large bodies,
no proxy buffering for uploads):

```nginx
server {
    listen 443 ssl http2;
    server_name drive.example.com;
    client_max_body_size 2g;
    proxy_request_buffering off;

    location / {
        proxy_pass http://127.0.0.1:4400;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

`proxy_request_buffering off` matters: with buffering on, nginx writes the whole
upload to disk before Drive sees a byte, doubling the I/O for large files and
breaking the progress the client shows.

## Backups

```sh
node scripts/backup.mjs                       # -> backups/drive-<stamp>.tar
node scripts/backup.mjs --data /srv/mdrive/data --out /srv/backups
node scripts/backup.mjs restore backups/drive-<stamp>.tar
```

A backup contains the checkpointed database, the JWT secret and every blob.
Restore while the service is stopped; the script copies the current database
aside first.

## Health and monitoring

- `GET /healthz` → `{ "status": "ok", "version": "0.1.0" }`; `503` when SQLite
  cannot be read.
- `GET /api/v1/storage/stats` (authenticated) → file/folder/byte counts.
- The container image declares a `HEALTHCHECK` that polls `/healthz`.
- `node scripts/smoke.mjs --server https://drive.example.com` runs 19 end-to-end
  checks and exits non-zero on the first regression; good as a post-deploy gate.

## Upgrades

1. `node scripts/backup.mjs`
2. Replace the code (git pull, or a new image tag).
3. Restart the service. Schema changes are applied at boot in `db.js` and are
   idempotent (`CREATE TABLE IF NOT EXISTS`), so a restart is the whole migration.
4. Run `node scripts/smoke.mjs` against the new instance.

Rollback is: stop, restore the archive from step 1, start the previous code.

## Capacity notes

- Metadata is SQLite: expect comfortable operation into the millions of rows,
  which is far beyond a personal or small-team drive.
- Blobs are plain files; the only limit is the filesystem. A 2 TiB data volume
  with 2 GiB uploads serves fine.
- `DRIVE_QUOTA_BYTES` is bytes, per account, not per host. The client divides
  by 1024 and labels the result GB, so `"150000000000"` renders as **140 GB** —
  the same quantity `df` calls 139.7 GiB, and the same quantity the OCI console
  calls 200 GB for a 214.7 GB (200 GiB) volume. Three labels, three units, one
  number: pick bytes and read the rendered figure back instead of assuming the
  field is GB.
- Compare the quota's *headroom* with the volume's free space, not the quota
  with the volume's size. What filling the quota costs is `limit - used`, so a
  139.7 GiB quota at 70.9 GiB used only needs 68.8 GiB more; against 109.8 GiB
  free that still leaves ~41 GiB for the OS, the images and the other containers.
  Reading it as "139.7 GiB quota on a 197.8 GiB disk" looks tighter than it is,
  and comparing it with free space alone looks impossible.
- Leave it at `0` (unlimited) only where the data volume is the only thing on
  the disk. Where the drive shares a volume with the OS and other containers, an
  unset quota lets a full upload take down every service on the host.
- Memory stays flat because every upload and download streams. A 2 GiB upload
  costs roughly the socket buffer, not 2 GiB of RSS.
- `data/tmp` needs room for in-flight uploads (one chunk each for resumable
  sessions, one spool file per simple upload).

## Updating a deployment

A published deployment pulls its image by tag instead of building from source:

```sh
cp .env.example .env            # fill in JWT_SECRET and the update token
docker compose up -d            # pulls DRIVE_IMAGE, starts drive + updater
```

Two things make `docker compose pull` mean something: `DRIVE_IMAGE` in `.env`
names an immutable version tag (`:0.19.0`, never `:latest`), and `DRIVE_VERSION`
records which one the running container is. The updater container writes both
when it applies a release.

A published deployment should have **no `build:` block for the drive**. While one
existed, a failed pull fell through to a local rebuild, so "updated" could mean
"compiled on this box minutes ago" and the running image drifted from the
registry. Without it the registry is the only source of truth: `update.sh` treats
a failed `compose pull` as fatal and restores the snapshot taken at the start of
the run, so `.env`, the compose files and `package.json` never name a release that
did not land. The `updater` service keeps its own `build:` — it is not published.

`DRIVE_UPDATE_MANIFEST_URL` is what turns the check on. Point it at the release
asset:

```sh
DRIVE_UPDATE_MANIFEST_URL=https://github.com/<owner>/marvelous-drive/releases/latest/download/latest.json
```

Then the account menu grows a **软件更新** entry. It reports the running and
published versions, links to the release notes, and — for a workspace admin —
offers **立即更新**. See [RELEASING.md](RELEASING.md) for what runs after that.

### The updater container, and why it exists

`updater` is the only container with `/var/run/docker.sock` and a writable copy
of the compose project. It answers two authenticated routes (`/status`,
`/update`) on an internal port; the API forwards to it and never holds the
socket itself. The cost is one small Alpine container; the benefit is that a
compromise of the HTTP API does not become a compromise of the host.

`DRIVE_UPDATE_AGENT_TOKEN` is the shared secret between the two. Generate it
once, put it in `.env`, and do not reuse it for anything else.

### Upgrading by hand

Without an updater, the same steps in a shell:

```sh
node scripts/backup.mjs                          # data/drive.db + blobs + secret
sed -i 's|^DRIVE_IMAGE=.*|DRIVE_IMAGE=ghcr.io/<owner>/marvelous-drive:0.19.0|' .env
docker compose pull drive && docker compose up -d --no-deps drive
curl -fsS http://127.0.0.1:4400/healthz
```

Schema changes are applied at boot in `db.js` and are idempotent
(`CREATE TABLE IF NOT EXISTS`), so a restart is the whole migration and the
previous image can normally read the upgraded database.

### A private repository

If the repository is private, `releases/latest/download/latest.json` answers
**404** to an anonymous fetch (GitHub hides private assets rather than refusing
them), and GHCR images default to private too. Two settings fix it:

- Leave `DRIVE_UPDATE_MANIFEST_URL` empty. The updater then reads
  `release/latest.json` from the project directory, which it already sees through
  the `/workspace` mount — that file is committed alongside the tag, so it names
  the release the checkout is on.
- Or keep the URL and set `DRIVE_UPDATE_MANIFEST_TOKEN` to a token that can read
  the release asset. The agent sends it as a bearer token.

For the image, either make the package public (Package settings → Change
visibility) or authenticate the host once:

```sh
echo <PAT with read:packages> | docker login ghcr.io -u <username> --password-stdin
```

`DRIVE_UPDATE_AGENT_TOKEN` is unrelated to either: it authenticates the API to
the updater inside the compose network.
