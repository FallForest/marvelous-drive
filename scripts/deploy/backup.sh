#!/usr/bin/env bash
# Always snapshot metadata before changing an image. A requested full local
# backup additionally stops the drive so deletes cannot race the blob copy.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STAMP="${1:-$(date -u +%Y%m%d-%H%M%S)}"
DATA_DIR="${DRIVE_DATA_DIR:-/drive-data}"
OUT_DIR="${BACKUP_DIR:-./backups}"

case "$STAMP" in
  ''|*[!0-9-]*) echo "invalid backup timestamp" >&2; exit 1 ;;
esac

mkdir -p "$OUT_DIR"
# Git Bash cannot reliably auto-convert quoted paths containing apostrophes.
# Native Node on Windows needs its own path spelling; Linux uses paths as-is.
node_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi
}
# Failure is fatal under set -e. A raw database copy is never a fallback.
node "$(node_path "$ROOT/scripts/backup.mjs")" snapshot --data "$(node_path "$DATA_DIR")" --out "$(node_path "$OUT_DIR")" --name "pre-update-$STAMP"

if [ "${BACKUP_DATA:-0}" != "1" ]; then
  echo "    database and generated JWT secret saved; full blob archive disabled (BACKUP_DATA=1 enables it)"
  exit 0
fi

# The archive plus verification/snapshot work needs headroom. Refuse a requested
# full backup when it cannot fit; the already written metadata snapshot remains.
need_mb=$(du -sm "$DATA_DIR" | cut -f1)
free_mb=$(df -m "$OUT_DIR" | awk 'NR==2 {print $4}')
reserve=$(( need_mb * 2 + 1024 ))
if [ "$free_mb" -lt "$reserve" ]; then
  echo "    full backup refused: ${reserve} MB free required, ${free_mb} MB available" >&2
  exit 1
fi

compose() {
  local compose_args=(--project-name "${COMPOSE_PROJECT_NAME:-marvelous-drive}")
  local file
  for file in ${COMPOSE_FILE:-docker-compose.yml}; do compose_args+=(-f "$file"); done
  docker compose "${compose_args[@]}" "$@"
}

restart_needed=0
finish() {
  local status=$?
  trap - EXIT
  if [ "$restart_needed" = "1" ]; then
    if ! compose start drive; then
      echo "    could not restart the drive after backup; operator action required" >&2
      status=1
    fi
  fi
  exit "$status"
}
trap finish EXIT
if [ -n "$(compose ps --status running --quiet drive)" ]; then
  # Set this first: even a partially failed stop must attempt to bring it back.
  restart_needed=1
  compose stop drive
fi
node "$(node_path "$ROOT/scripts/backup.mjs")" --offline --data "$(node_path "$DATA_DIR")" --out "$(node_path "$OUT_DIR")" --name "data-$STAMP"
