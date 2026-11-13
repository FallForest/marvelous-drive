#!/usr/bin/env bash
# Apply the release manifest the update agent fetched: back up, pull, recreate,
# health-gate, and roll back on failure.
#
# Run by the update agent inside the updater container, which has the Docker
# socket, the compose project and the drive's data volume mounted.
#
#   scripts/deploy/update.sh
#
# The order is the point. The backup and the snapshot of .env/the compose files
# happen *before* the new tag is pinned, so the rollback restores what was
# actually running. An agent that pinned the tag first would produce a rollback
# that changes nothing.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

COMPOSE_FILES="${COMPOSE_FILE:-docker-compose.yml}"
MANIFEST_FILE="${UPDATE_MANIFEST_FILE:-$ROOT/.update-manifest.json}"

compose() {
  # Pin the project name: compose derives it from the working directory, and
  # inside the updater that derivation found a project with no containers, so
  # every "exec" in this script reported the service as not running.
  # shellcheck disable=SC2086
  docker compose --project-name "${COMPOSE_PROJECT_NAME:-marvelous-drive}" \
    $(for f in $COMPOSE_FILES; do printf -- "-f %s " "$f"; done) "$@"
}

BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
mkdir -p "$BACKUP_DIR"
timestamp="$(date -u +%Y%m%d-%H%M%S)"

if [ ! -f "$MANIFEST_FILE" ]; then
  echo "==> no release manifest at $MANIFEST_FILE; nothing to apply" >&2
  exit 1
fi
# The manifest is read from stdin, not by path: the agent may pass a POSIX path
# that a Windows node.exe cannot resolve, and a path argument is one quoting
# bug away from a silent empty value either way.
manifest_fields="$(cat "$MANIFEST_FILE" | node -e \
  "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const m=JSON.parse(s);process.stdout.write(String(m.version||'')+'\\n'+String(m.image||''))})")"
NEW_VERSION="$(printf '%s' "$manifest_fields" | sed -n 1p)"
NEW_IMAGE="$(printf '%s' "$manifest_fields" | sed -n 2p)"
if [ -z "$NEW_VERSION" ] || [ -z "$NEW_IMAGE" ]; then
  echo "==> release manifest is missing version or image" >&2
  exit 1
fi
echo "==> applying $NEW_VERSION ($NEW_IMAGE)"

echo "==> snapshotting compose files and env"
for f in $COMPOSE_FILES; do
  if [ -f "$f" ]; then
    cp "$f" "$BACKUP_DIR/pre-update-$timestamp.$(basename "$f")"
  fi
done
if [ -f .env ]; then
  cp .env "$BACKUP_DIR/pre-update-$timestamp.env"
fi
# The code reports its own version from package.json; the rollback has to put
# that back too, or the running image and the reported version disagree.
if [ -f package.json ]; then
  cp package.json "$BACKUP_DIR/pre-update-$timestamp.package.json"
fi

# Config snapshot above is the rollback unit; the data tarball is optional.
#
# A drive holds tens of gigabytes of blobs, and ./backups sits on the same disk
# as the data. Tarring it needs a second copy of the whole store: on the box this
# was measured on, 71 GB of data produced a 71 GB tarball and drove free space
# from 110 GB to 39 GB mid-update. That is not a backup, it is a way to run out
# of disk while eight containers are running. Schema changes are additive and
# idempotent (CREATE TABLE IF NOT EXISTS), so the previous image reads the new
# database and the tag rollback is enough to undo a bad release.
#
# Set BACKUP_DATA=1 to opt back in; it still refuses when the tarball would not
# fit with headroom, and says so instead of filling the disk.
echo "==> backing up data"
if [ "${BACKUP_DATA:-0}" = "1" ]; then
  need_mb=$(du -sm "${DRIVE_DATA_DIR:-/drive-data}" 2>/dev/null | cut -f1)
  need_mb=${need_mb:-0}
  free_mb=$(df -m "$BACKUP_DIR" | awk 'NR==2 {print $4}')
  # Twice the store plus 1 GiB: the tarball itself, and room for the image pull
  # and the SQLite snapshot that happen in the same run.
  reserve=$(( need_mb * 2 + 1024 ))
  if [ "$free_mb" -lt "$reserve" ]; then
    echo "    skipped: needs ${need_mb} MB of data, ${reserve} MB free required, ${free_mb} MB available"
    echo "    (set BACKUP_DATA=1 only on a volume with room, or back up off the host)"
  else
    bash "$ROOT/scripts/deploy/backup.sh" "$timestamp"
  fi
else
  echo "    skipped: config snapshot only (set BACKUP_DATA=1 to also tar the store)"
fi
# Retention. One run leaves a pre-update-<stamp> set plus one data-<stamp>.tar,
# and nothing used to delete them: a real deployment accumulated 61 files and
# 21 MB over a month. Keep the newest BACKUP_KEEP sets and drop the rest.
KEEP="${BACKUP_KEEP:-5}"
if [ "$KEEP" -gt 0 ]; then
  ls -1 "$BACKUP_DIR" 2>/dev/null \
    | sed -n 's/^\(pre-update-[0-9]\{8\}-[0-9]\{6\}\)\..*/\1/p' \
    | sort -u | head -n -"$KEEP" \
    | while IFS= read -r set; do rm -f "$BACKUP_DIR/$set".*; done
  ls -1 "$BACKUP_DIR" 2>/dev/null \
    | sed -n 's/^\(data-[0-9]\{8\}-[0-9]\{6\}\.tar\)$/\1/p' \
    | sort | head -n -"$KEEP" \
    | while IFS= read -r tar; do rm -f "$BACKUP_DIR/$tar"; done
  echo "==> keeping the newest $KEEP backup sets in $BACKUP_DIR"
fi

echo "==> pinning $NEW_VERSION"
# Both places an image is named: .env (compose interpolates it) and the compose
# file itself (which may hard-code a tag).
set_env() {
  local key="$1" value="$2"
  if [ -f .env ] && grep -q "^$key=" .env; then
    # Use a temp file: rewriting in place truncates before sed reads it on
    # some shells.
    sed "s|^$key=.*|$key=$value|" .env > .env.tmp && mv .env.tmp .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}
set_env DRIVE_VERSION "$NEW_VERSION"
set_env DRIVE_IMAGE "$NEW_IMAGE"
# Keep the code's idea of its own version in step with the manifest.
if [ -f package.json ]; then
  node -e "const fs=require('node:fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));if(p.version!=='$NEW_VERSION'){p.version='$NEW_VERSION';fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')}"
fi

# One way back, used by every failure below.
#
# It restores the files the snapshot step copied. Without this, a pull that fails
# leaves .env pinned to a version whose image does not exist: the container keeps
# running the old one while "current version" reports the new one, and the next
# update thinks it is already there. That is worse than the failed update.
restore_snapshot() {
  for f in $COMPOSE_FILES; do
    snapshot="$BACKUP_DIR/pre-update-$timestamp.$(basename "$f")"
    if [ -f "$snapshot" ]; then cp "$snapshot" "$f"; fi
  done
  if [ -f "$BACKUP_DIR/pre-update-$timestamp.env" ]; then
    cp "$BACKUP_DIR/pre-update-$timestamp.env" .env
  fi
  if [ -f "$BACKUP_DIR/pre-update-$timestamp.package.json" ]; then
    cp "$BACKUP_DIR/pre-update-$timestamp.package.json" package.json
  fi
  echo "    restored the previous .env and compose files" >&2
}

echo "==> pulling images"
# Fatal, now that the image is the only source of truth: this compose file has no
# build section for the drive, so a pull that fails means there is nothing to run.
# Treating it as a warning (the old behaviour) pinned the tag and then recreated
# from whatever image happened to be local, or failed the recreate and left .env
# pointing at a version that was never deployed.
if ! compose pull drive; then
  echo "==> pull failed; nothing was changed" >&2
  restore_snapshot
  exit 1
fi

echo "==> recreating the drive"
if ! compose up -d --no-deps drive; then
  echo "==> recreate failed; rolling back" >&2
  restore_snapshot
  compose up -d --no-deps drive || true
  exit 1
fi

echo "==> waiting for the health check"
healthy=0
for attempt in $(seq 1 30); do
  if compose exec -T drive node -e "fetch('http://127.0.0.1:4400/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 2
done

if [ "$healthy" -eq 1 ]; then
  echo "==> update completed: now running $NEW_VERSION"

  # Image retention. Nothing used to delete old tags, so the registry gained one
  # entry per release and nothing ever removed one. They share almost everything
  # — a drive image reports 238 MB but only ~2.4 MB is unique per version, since
  # the base and the whole source tree are identical — so this is not about space
  # today. It is about not asking a future operator to work out which of forty
  # tags is the live one, and about keeping `docker images` readable.
  #
  # The newest TAG_KEEP tags stay. Removing a tag only unlinks it: layers survive
  # while any kept image still references them, so this cannot break a rollback to
  # a tag inside the window.
  KEEP_TAGS="${TAG_KEEP:-5}"
  if [ "$KEEP_TAGS" -gt 0 ]; then
    repo="${NEW_IMAGE%:*}"
    # The tag this update replaced always stays: it is the one a rollback
    # reaches for, and it can sit outside the newest-KEEP window after a few
    # skipped releases.
    previous_image="$(sed -n 's/^DRIVE_IMAGE=//p' "$BACKUP_DIR/pre-update-$timestamp.env" 2>/dev/null | head -1)"
    keep="$(printf '%s\n' "$previous_image"
      docker image ls --format '{{.Repository}}:{{.Tag}}' "$repo" \
        | grep -v '<none>' | sort -V | tail -n "$KEEP_TAGS")"
    docker image ls --format '{{.Repository}}:{{.Tag}}' "$repo" \
      | grep -v '<none>' \
      | while IFS= read -r tag; do
          if ! printf '%s\n' "$keep" | grep -Fxq "$tag"; then
            echo "    dropping old image tag $tag"
            docker rmi "$tag" >/dev/null 2>&1 || true
          fi
        done
  fi
  exit 0
fi


# A failed update has to put the previous files back, or the stack is left
# half-upgraded and someone has to fix it by hand.
echo "==> health check failed, rolling back" >&2
restore_snapshot
compose up -d --no-deps drive || true
echo "==> rolled back to the previous release" >&2
if [ -f "$BACKUP_DIR/data-$timestamp.tar" ]; then
  echo "    data backup: $BACKUP_DIR/data-$timestamp.tar" >&2
fi
exit 1
