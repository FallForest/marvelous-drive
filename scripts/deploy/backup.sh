#!/usr/bin/env bash
# Snapshot the drive's data before an update moves an image tag.
#
# The drive keeps SQLite plus a blob tree, so a backup is two things: a
# consistent database file and the bytes beside it. Copying drive.db while the
# server writes to it produces a torn database, so the snapshot is taken *by the
# drive container* through SQLite's own VACUUM INTO, which is transactional. The
# tarball then carries that snapshot plus the blobs.
#
# The volume is mounted into the updater at /drive-data: the compose project
# directory does not contain the data, a named volume does.
set -Eeuo pipefail

STAMP="${1:-$(date -u +%Y%m%d-%H%M%S)}"
DATA_DIR="${DRIVE_DATA_DIR:-/drive-data}"
OUT_DIR="${BACKUP_DIR:-./backups}"

if [ ! -d "$DATA_DIR" ]; then
  echo "    no data directory at $DATA_DIR; nothing to back up"
  exit 0
fi

mkdir -p "$OUT_DIR"

# Consistent database snapshot, written inside the container that owns it.
# A failure here is reported and the raw copy is still tarred below, so an
# update never proceeds with no backup at all.
snapshot="/data/tmp/pre-update-$STAMP.db"
if command -v docker >/dev/null 2>&1; then
  if docker compose --project-name "${COMPOSE_PROJECT_NAME:-marvelous-drive}" \
       $(for f in ${COMPOSE_FILE:-docker-compose.yml}; do printf -- "-f %s " "$f"; done) \
       exec -T drive node -e \
       "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/data/drive.db');db.exec(\"VACUUM INTO '$snapshot'\");db.close()" \
       >/dev/null 2>&1; then
    echo "    database snapshot written to $snapshot"
  else
    echo "    WARNING: could not take a consistent SQLite snapshot; the copy may be torn"
  fi
fi

target="$OUT_DIR/data-$STAMP.tar"
echo "    writing $target"
tar -cf "$target" -C "$DATA_DIR" .
echo "    $(du -h "$target" | cut -f1) written"

# The snapshot is a working file, not a second backup: the tarball already has
# it. Leaving it behind would grow the data volume on every update.
if [ -f "$DATA_DIR/tmp/pre-update-$STAMP.db" ]; then
  rm -f "$DATA_DIR/tmp/pre-update-$STAMP.db"
fi
