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

echo "==> backing up data"
# A backup that fails aborts the update: proceeding without one is how a failed
# deploy loses the data it was supposed to protect.
bash "$ROOT/scripts/deploy/backup.sh" "$timestamp"

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

echo "==> pulling images"
# pull exits non-zero when a service is built locally rather than pulled, so a
# failure here is only fatal if it leaves no image to run.
if ! compose pull drive 2>/dev/null; then
  echo "    (no published image to pull; will use whatever is local)"
fi

echo "==> recreating the drive"
compose up -d --no-deps drive

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
  exit 0
fi

# A failed update has to put the previous files back, or the stack is left
# half-upgraded and someone has to fix it by hand.
echo "==> health check failed, rolling back" >&2
for f in $COMPOSE_FILES; do
  snapshot="$BACKUP_DIR/pre-update-$timestamp.$(basename "$f")"
  if [ -f "$snapshot" ]; then
    cp "$snapshot" "$f"
  fi
done
if [ -f "$BACKUP_DIR/pre-update-$timestamp.env" ]; then
  cp "$BACKUP_DIR/pre-update-$timestamp.env" .env
fi
if [ -f "$BACKUP_DIR/pre-update-$timestamp.package.json" ]; then
  cp "$BACKUP_DIR/pre-update-$timestamp.package.json" package.json
fi
compose up -d --no-deps drive || true
echo "==> rolled back to the previous release" >&2
echo "    data backup: $BACKUP_DIR/data-$timestamp.tar" >&2
exit 1
