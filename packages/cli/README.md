# mdrive CLI

`mdrive` is the command line client for **Marvelous Drive**. It speaks the
versioned REST API in [`docs/CONTRACT.md`](../../docs/CONTRACT.md), caches
credentials per server, and covers nodes, uploads (plain and resumable), sharing,
search, storage stats, integrity checks and the team workspace.

- Node.js >= 22, ESM only, **zero runtime dependencies**, no build step.
- Aligned tables on a terminal, machine-readable JSON with `--json`.
- Documented exit codes so scripts can branch on the failure class.
- Paths or uuids everywhere: `mdrive cat /Projects/plan.md` and
  `mdrive cat 8a1d...` are interchangeable.

## Quick start

```sh
node packages/cli/bin/mdrive.mjs login --server http://127.0.0.1:4400 --email you@example.com
node packages/cli/bin/mdrive.mjs whoami
node packages/cli/bin/mdrive.mjs ls
node packages/cli/bin/mdrive.mjs upload ./notes.md --to /Projects
```

Install the `mdrive` command globally (optional, no registry publish needed):

```sh
cd packages/cli
npm link          # or: pnpm link --global
mdrive --help
```

`login` never prints the token. Keep the password out of your shell history with
`MDRIVE_PASSWORD`:

```sh
MDRIVE_PASSWORD=secret mdrive login --server https://drive.example.com --email you@example.com
```

## Commands

### Account

| Command | What it does |
| --- | --- |
| `login [--email E] [--password P] [--server URL] [--token T]` | `POST /auth/login`, stores the token in the profile for that server. |
| `logout [--all]` | Forgets the token of the current profile, or every profile. |
| `whoami` | `GET /me` plus the active server, profile, and token source. |

### Files

| Command | What it does |
| --- | --- |
| `ls [PATH] [--trash] [--starred] [-l] [-R] [--workspace ID]` | Lists a folder (folders first, then files, both by name), the trash, or starred files. |
| `tree [PATH] [--depth N] [--workspace ID]` | Indented hierarchy, folders marked with `/`, files with their size. |
| `stat NODE` | Every field of one node plus its absolute path and download/preview URLs. |
| `mkdir PATH [-p]` | Creates a folder; `--parents` creates the whole missing chain. |
| `mv SOURCE DEST` | Move into a folder, or move-and-rename with the full target path. |
| `cp SOURCE [DEST] [--name N] [--parent P]` | Copies a file or a folder recursively. |
| `rm NODE... [-f]` | Soft delete into the trash (cascades to descendants). |
| `restore NODE` | Restores a trashed node and its trashed descendants. |
| `purge NODE... [-y]` | Permanent delete of trashed nodes; blobs are reclaimed. |
| `star NODE [--off]` | Stars or unstars a node. |
| `upload FILE... [--to PATH] [--name N] [--chunk-size B] [--simple] [--session ID] [--on-conflict MODE] [--workspace ID]` | Uploads. Files over 1 MiB are hashed first: if the server already stores those bytes the node is created without sending them ("秒传"). Files over 8 MiB use the resumable session protocol. `--on-conflict` is `overwrite` (default), `rename` or `skip`. |
| `download NODE [DEST] [--resume] [-f]` | Streams to disk (or `-` for stdout); `--resume` continues with a Range request. |
| `cat NODE [--max-bytes N] [-f]` | Prints a text file to stdout. |
| `search QUERY [--limit N] [--kind folder\|file] [--scope all\|name\|content]` | Searches names and file contents; content hits carry the matching sentence. |
| `sync LOCAL_DIR REMOTE_PATH [--dry-run] [--direction up\|down\|both] [--delete] [--rehash]` | Keeps a local folder and a drive folder in step, deciding by content hash. See below. |
| `stats` | `GET /storage/stats`: files, folders, trash, bytes, quota, shares. |

### Sync

`mdrive sync` is the answer to "I backed up a folder, and then edited it locally".
It compares **content, not timestamps**, and keeps a baseline so it can tell "I
changed this" from "somebody else did".

```sh
mdrive sync ./Photos /Photos --dry-run    # show the plan, write nothing
mdrive sync ./Photos /Photos              # apply it
mdrive sync ./Photos /Photos              # run again: 0 to upload, 0 to download
```

Why not mtime: a photo library keeps its EXIF capture time as the file mtime, so
a file copied in today still reads as "shot in 2012". Only a hash answers "is
this the same photo".

| Situation | What sync does |
| --- | --- |
| Same bytes on both sides | nothing (adopts on the first run) |
| New locally | uploads, creating any missing folders first |
| Changed locally only | uploads a new version |
| Changed remotely only | downloads |
| **Changed on both sides** | **reports a conflict and touches neither** |
| In both, no baseline, different bytes | conflict: adopting either is a guess |
| Gone remotely, unchanged locally | reported; only deleted with `--delete` |
| Gone locally, unchanged remotely | reported; only deleted with `--delete` |

Every upload re-checks the remote version first, so a file that moved under the
run becomes a conflict instead of a silent overwrite. The baseline lives in
`~/.config/mdrive/sync/<key>.json` (one per server + local folder + remote path)
and only advances for paths that actually succeeded — a failed upload is retried
next run, never mistaken for "in sync".

The first run hashes every local file (70 GiB ≈ 90 s on an SSD) and then caches
size+mtime per path, so later runs only re-read what changed. `--rehash` ignores
that cache.

### Sharing

| Command | What it does |
| --- | --- |
| `share NODE [--permission viewer\|downloader] [--expires-days N] [--password P] [--max-downloads N]` | Creates a public link and prints the absolute URL. |
| `share list [NODE]` | Share links of one node, or every share on the drive. |
| `revoke SHARE` | Deletes a share by share id or by token. |
| `team` | Lists the workspace and the accounts that share it. |
| `team add EMAIL [--role admin\|member]` | Adds an existing account to the workspace. |
| `team remove EMAIL` | Removes a member; the owner cannot be removed. |

## Global options

Accepted **before or after** the command name.

| Option | Description |
| --- | --- |
| `--server URL` | Server base URL; overrides the profile and `MDRIVE_SERVER`. |
| `--token TOKEN` | Bearer token; overrides the profile and `MDRIVE_TOKEN`. |
| `--json` | Prints one JSON document instead of tables. |
| `--no-color` | Disables ANSI colours even on a TTY. |
| `-v`, `-vv` | Raises the diagnostic level (diagnostics go to stderr). |
| `-h`, `--help` | Help for the CLI or one command. |
| `-V`, `--version` | Prints `mdrive <semver>`. |

## Environment variables

| Variable | Description |
| --- | --- |
| `MDRIVE_SERVER` | Server base URL; overrides the saved profile. |
| `MDRIVE_TOKEN` | Bearer token; overrides the saved profile. |
| `MDRIVE_CONFIG_DIR` | Configuration directory (see below). |
| `MDRIVE_PASSWORD` | Password for `login`, so it stays out of shell history. |
| `NO_COLOR` | Any value disables ANSI colours, like `--no-color`. |

## Configuration and profiles

Token cache location:

- Windows: `%APPDATA%\mdrive\config.json`
- Linux/macOS: `$XDG_CONFIG_HOME/mdrive/config.json` or `~/.config/mdrive/config.json`
- Any platform: `$MDRIVE_CONFIG_DIR/config.json`

Profiles are keyed by the normalised server URL, so several drives can be used
side by side:

```json
{
  "version": 1,
  "defaultProfile": "http://127.0.0.1:4400",
  "profiles": {
    "http://127.0.0.1:4400": {
      "server": "http://127.0.0.1:4400",
      "token": "eyJhbGci...",
      "email": "you@example.com"
    },
    "https://drive.example.com": {
      "server": "https://drive.example.com",
      "token": "eyJhbGci...",
      "email": "you@example.com"
    }
  }
}
```

The file is written atomically with `0600` and the directory with `0700` on
POSIX systems. A legacy flat `{ "server": ..., "token": ... }` file is migrated
to the profile shape on first read.

Credential precedence (highest first): `--server`/`--token`, `MDRIVE_SERVER`/
`MDRIVE_TOKEN`, the profile of the default server, then `http://127.0.0.1:4400`.
A token is only ever sent to the server it was stored for: `--server other` with
no matching profile sends no token.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | Runtime failure: network error, 4xx/5xx response, authentication, conflict, missing node. |
| `2` | Usage error: unknown command or option, missing argument, invalid value. |

Errors are printed to stderr as `mdrive: <message>`, so stdout stays pipeable.
Common status codes carry actionable advice:

- `401` → run `mdrive login` (or pass `--token`).
- `403` → this drive user may not perform that action.
- `404 NOT_FOUND` → check the id (`mdrive ls`) or the path.
- `404 NOT_A_FILE` / `NOT_A_FOLDER` → the node has the other kind.
- `409 CONFLICT` → a node with that name already exists; use `--name` or rename.
- `409 VERSION_CONFLICT` → reload with `mdrive stat NODE` and retry.
- `409 UPLOAD_INCOMPLETE` → rerun the upload to resume missing chunks.
- `409 CHECKSUM_MISMATCH` → delete the session and upload again.
- `413 FILE_TOO_LARGE` → the file exceeds `DRIVE_MAX_UPLOAD_BYTES`.
- `429 RATE_LIMITED` → back off and retry.
- `502`/`503` → the server is temporarily unavailable; retry once it is back.

## Uploads

A file up to and including 8 MiB is sent with one `PUT /uploads?parentId=&name=`.
Anything larger switches to the resumable protocol automatically:

1. `POST /uploads/sessions` with `{name,size,parentId,chunkSize}` (default
   chunk size 8 MiB, override with `--chunk-size 16MiB`, bounds 64 KiB–64 MiB).
2. One `PUT /uploads/sessions/:id/chunks/:index` per chunk, sequentially, with a
   progress bar on a TTY.
3. `POST /uploads/sessions/:id/complete`.

Interrupted uploads resume without re-sending stored chunks: rerun the same
command with `--session SESSION_ID` and the CLI re-reads
`GET /uploads/sessions/:id`, then sends only the missing indices. `--simple`
forces a single PUT, and a 413 explains which server setting caps the size.

Downloads stream to `.part` and are renamed on success, so an interrupted
download never leaves a half file behind. `--resume` continues an existing
destination with a `Range` request when the server answers `206`.

## JSON output

`--json` prints exactly one document on stdout:

```sh
mdrive ls /Projects --json
```

```json
{ "ok": true, "command": "ls", "parentId": "2222...", "nodes": [ { "id": "3333...", "name": "plan.md", "kind": "file", "size": 22 } ] }
```

Failures still exit non-zero and print the message on stderr; the JSON document
is never mixed with diagnostics.

## Examples

```sh
# Explore
mdrive ls -l
mdrive tree /Projects --depth 2
mdrive search plan --kind file
mdrive stat /Projects/plan.md

# Organise
mdrive mkdir -p /Archive/2026
mdrive mv /Projects/plan.md /Archive/2026/plan.md
mdrive cp /Archive/2026/plan.md --name plan-backup.md
mdrive star /Archive/2026/plan.md
mdrive rm /Archive/2026/plan-backup.md
mdrive restore /Archive/2026/plan-backup.md
mdrive purge /Archive/2026/plan-backup.md --yes

# Content
mdrive upload ./report.pdf --to /Reports
mdrive upload ./backup.tar --chunk-size 16MiB
mdrive download /Reports/report.pdf ./report.pdf --force
mdrive cat /Projects/plan.md | head -20

# Share
mdrive share /Reports/report.pdf --permission downloader --expires-days 7
mdrive share list
mdrive revoke 4f2c9a

# Search inside file contents, and check the store
mdrive search "invoice" --scope content
mdrive index
mdrive verify
```

## Tests

```sh
node --test packages/cli/test/
```

The suites run the real `bin/mdrive.mjs` against an in-process mock of the API
(`test/mock-server.mjs`), so they need no running server. Covered areas: flag and
positional parsing, config round-trip and profile precedence, table rendering
(ANSI, CJK widths, alignment), API error mapping, resumable chunk arithmetic and
session resume, and end-to-end happy paths for account, listing, mutations,
uploads, downloads, sharing, search, versions and the team workspace.

## Layout

```
packages/cli
├── bin/mdrive.mjs        thin entry: exit code only
├── src/cli.js            dispatch loop, global flags, exit-code mapping
├── src/args.js           flag/positional parser, Flags accessor
├── src/config.js         token cache, profiles, credential precedence
├── src/http.js           fetch wrapper, errors, downloads, uploads
├── src/output.js         tables, byte sizes, relative dates, colours
├── src/help.js           root and per-command help
├── src/command.js        command shape, path resolution, hints
├── src/naming.js         node name validation (contract rules)
├── src/sync.js           sync engine: scan, plan, execute, baseline (no HTTP of its own)
├── src/commands/         auth, nodes, files, share, search, sync, team, misc
└── test/                 node:test suites plus the mock API
```