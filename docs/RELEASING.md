# Releasing

How a version reaches a deployment, and when to cut one.

## Cadence

Release in batches, not per commit.

Each release costs a tag, a changelog section, a version bump across three
`package.json` files plus `release/latest.json`, and a deploy with a rollback
window. Paying that for a one-line fix is noise. Cut a release when:

- a user-visible batch is done (a feature plus the fixes it needed);
- a security or data-integrity fix landed — these do not wait;
- a regression is live — fix and release immediately.

Otherwise keep committing to `main`. Untagged commits are not risky: CI runs the
suites, the syntax check and the motion linter on every push, so `main` is always
known-good. What waiting costs is only that the running image lags `main`.

## The pieces

| Piece | Who writes it | Who reads it |
| --- | --- | --- |
| `release/latest.json` | a person at release time, then the workflow | the API and the update agent |
| `ghcr.io/<owner>/marvelous-drive:<version>` | the Release workflow | `docker compose pull` on the host |
| the GitHub release | the Release workflow (`softprops/action-gh-release`) | people |

`release/latest.json` is the contract between the three:

```json
{
  "version": "0.19.0",
  "image": "ghcr.io/fallforest/marvelous-drive:0.19.0",
  "releaseUrl": "https://github.com/FallForest/marvelous-drive/releases/tag/v0.19.0",
  "notesUrl": "https://github.com/FallForest/marvelous-drive/releases"
}
```

## Steps

1. Confirm the batch is coherent: `pnpm test`, `pnpm lint`, `pnpm check` clean.
2. Bump the version in `package.json`, `apps/server/package.json`,
   `packages/cli/package.json`, and `release/latest.json` (all four `version`
   fields plus the three URLs in the manifest).
3. Write one `CHANGELOG.md` section for the whole batch, grouped by
   Added / Changed / Fixed / Removed. A changelog entry is for someone deciding
   whether to upgrade, not a commit log.
4. Commit, push `main`, then tag and push the tag:

   ```sh
   git tag -a v0.19.0 -m 'Marvelous Drive 0.19.0'
   git push origin main --tags
   ```

5. The Release workflow builds a multi-arch image, pushes it to GHCR, rewrites
   `release/latest.json` and publishes it as a release asset. Watch it:

   ```sh
   gh run watch
   gh release view v0.19.0
   ```

## How a deployment updates itself

1. `.env` names the manifest:

   ```sh
   DRIVE_UPDATE_MANIFEST_URL=https://github.com/<owner>/marvelous-drive/releases/latest/download/latest.json
   DRIVE_UPDATE_AGENT_TOKEN=<openssl rand -hex 32>
   DRIVE_UPDATE_AGENT_URL=http://updater:8080
   ```

2. The account menu's **软件更新** entry asks
   `GET /api/v1/system/update-check`, which compares the manifest with the
   running version.
3. **立即更新** calls `POST /api/v1/system/update`. The API checks the caller is a
   workspace admin and forwards the request to the updater container.
4. The updater rewrites `DRIVE_IMAGE`/`DRIVE_VERSION` in `.env`, then runs
   `scripts/deploy/update.sh`: back up `data/`, `docker compose pull`, recreate
   the `drive` service, and poll `/healthz`.
5. On a failed health check the script restores the previous `.env` and compose
   files and recreates the old container. The failure is reported back through
   `GET /api/v1/system/update-status`, which the panel has been polling.

The API never touches the Docker socket. That is the whole reason the updater is
a second container: a remote-code-execution bug in the drive must not be able to
start containers.

## Rolling back by hand

The previous image keeps its tag in GHCR forever, and every update leaves
`backups/pre-update-<stamp>.env` and `backups/data-<stamp>.tar`:

   ```sh
sed -i 's|^DRIVE_IMAGE=.*|DRIVE_IMAGE=ghcr.io/<owner>/marvelous-drive:0.18.0|' .env
docker compose up -d --no-deps drive
   ```

Restoring `data/` from the tarball is only needed if the schema changed in a way
the old image cannot read. Schema changes are additive (`CREATE TABLE IF NOT
EXISTS`, `ALTER TABLE ... ADD COLUMN` guarded by a column check), so the previous
image normally reads the new database without complaint.

## What not to do

- Do not tag every commit.
- Do not release with a failing test "because it was already failing" — the
  suite is the only thing standing between a typo and a broken drive.
- Do not edit `release/latest.json` without bumping the three `package.json`
  files: the manifest would advertise a version the code does not report, and
  every instance would offer the same update forever.
- Do not batch a security fix with feature work to save a release; ship it.