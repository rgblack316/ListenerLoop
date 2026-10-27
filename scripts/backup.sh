#!/usr/bin/env bash
# ListenerLoop backup: one .tar.gz with a consistent copy of the database, the audio files
# (when STORAGE_DRIVER=local) and your .env (which holds the secrets the database needs).
#
#   sudo ./scripts/backup.sh [destination-folder]
#
# Default destination: ./backups   Keeps the newest 14 archives (KEEP=n to change).
# S3 audio is not copied: turn on versioning or replication on the bucket instead.
# Safe to run from cron while the app is running. The archive contains secrets: keep it private.
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]:-$0}"
# shellcheck source=lib.sh
. "$(cd "$(dirname "$SCRIPT_PATH")" && pwd)/lib.sh"

case "${1:-}" in -h | --help) sed -n '2,10p' "$SCRIPT_PATH" | sed 's/^# \{0,1\}//'; exit 0 ;; esac
DEST="${1:-$APP_DIR/backups}"
KEEP="${KEEP:-14}"

command -v docker >/dev/null 2>&1 || die "Docker is not installed."
[ -f "$ENV_FILE" ] || die "No .env found at $ENV_FILE. Is ListenerLoop installed here?"
[ -n "$(dc ps -q app 2>/dev/null || true)" ] || die "The app container is not running. Start it first: docker compose up -d"

mkdir -p "$DEST"
chmod 700 "$DEST"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; dc exec -T app rm -rf /tmp/snapshot >/dev/null 2>&1 || true' EXIT

say "Snapshotting the database"
dc exec -T app rm -rf /tmp/snapshot
dc exec -T app mkdir -p /tmp/snapshot
dc exec -T app node -e "
const Database = require('better-sqlite3');
const path = require('path');
const src = process.env.DATABASE_PATH || path.join(process.env.DATA_DIR || '/data', 'app.db');
new Database(src, { readonly: true }).backup('/tmp/snapshot/app.db').catch((e) => { console.error(e.message); process.exit(1); });
" || die "The database snapshot failed."
ok "Database copied"

mkdir -p "$WORK/backup"
if [ "$(env_get STORAGE_DRIVER)" = s3 ]; then
  ok "Audio is in S3, so it is not part of this backup (use bucket versioning or replication)"
  dc exec -T app tar -C /tmp -cf - snapshot | tar -xf - -C "$WORK/backup"
else
  say "Copying audio files"
  dc exec -T app sh -c 'cd /tmp && tar -cf - snapshot && if [ -d /data/audio ]; then cd /data && tar -cf - audio; fi' > "$WORK/raw.tar"
  # Two concatenated tars: -i reads past the first end-of-archive marker.
  tar -xif "$WORK/raw.tar" -C "$WORK/backup"
  rm -f "$WORK/raw.tar"
  ok "Audio copied ($(find "$WORK/backup/audio" -type f 2>/dev/null | wc -l | tr -d ' ') files)"
fi
[ -s "$WORK/backup/snapshot/app.db" ] || die "The snapshot is empty; nothing was saved."

cp "$ENV_FILE" "$WORK/backup/env"
date -u +%Y-%m-%dT%H:%M:%SZ > "$WORK/backup/CREATED"

OUT="$DEST/listenerloop-$(date -u +%Y%m%d-%H%M%S).tar.gz"
tar -czf "$OUT" -C "$WORK/backup" .
chmod 600 "$OUT"
ok "Saved $OUT ($(du -h "$OUT" | cut -f1))"

# shellcheck disable=SC2012
ls -1t "$DEST"/listenerloop-*.tar.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do rm -f "$old"; done
echo "Copy this file somewhere off the server (another machine or cloud storage)."
