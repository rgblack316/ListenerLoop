#!/usr/bin/env bash
# ListenerLoop restore: put a backup made by backup.sh back in place.
#
#   sudo ./scripts/restore.sh path/to/listenerloop-YYYYMMDD-HHMMSS.tar.gz [--with-env] [--yes]
#
# Replaces the current database (and local audio files) with the backup. The app is stopped
# while this runs. Your current .env is kept unless you pass --with-env (use that on a new
# server, where there is no .env yet).
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]:-$0}"
# shellcheck source=lib.sh
. "$(cd "$(dirname "$SCRIPT_PATH")" && pwd)/lib.sh"

FILE=""
WITH_ENV=0
YES_FLAG=0
for arg in "$@"; do
  case "$arg" in
    --with-env) WITH_ENV=1 ;;
    --yes | -y) YES_FLAG=1; ASSUME_YES=1 ;;
    -h | --help) sed -n '2,9p' "$SCRIPT_PATH" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "Unknown option: $arg" ;;
    *) FILE="$arg" ;;
  esac
done
[ -n "$FILE" ] || die "Usage: restore.sh <backup.tar.gz> [--with-env] [--yes]"
[ -f "$FILE" ] || die "File not found: $FILE"
command -v docker >/dev/null 2>&1 || die "Docker is not installed. Run ./scripts/install.sh first."
init_input

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
tar -xzf "$FILE" -C "$WORK" || die "Could not read the archive."
[ -s "$WORK/snapshot/app.db" ] || die "This does not look like a ListenerLoop backup (no database inside)."

if [ ! -f "$ENV_FILE" ]; then
  [ -f "$WORK/env" ] || die "No .env here and none in the backup."
  warn "No .env on this server; using the one from the backup."
  WITH_ENV=1
fi
if [ "$WITH_ENV" = 1 ]; then
  [ -f "$WORK/env" ] || die "The backup has no .env."
  cp "$WORK/env" "$ENV_FILE"; chmod 600 "$ENV_FILE"
  ok ".env restored from the backup"
fi

say "Backup from $(cat "$WORK/CREATED" 2>/dev/null || echo unknown)"
if [ -d "$WORK/audio" ]; then echo "  includes audio files"; else echo "  database only (audio lives in S3 or was not saved)"; fi
warn "This replaces the current database and local audio with the backup."
if [ "$YES_FLAG" != 1 ]; then
  [ "$ASSUME_YES" = 0 ] || die "Not running interactively. Pass --yes to confirm the restore."
  ask_yn "Continue?" n || die "Cancelled. Nothing was changed."
fi

say "Stopping the app"
dc stop app >/dev/null 2>&1 || true
chmod -R a+rX "$WORK"

say "Restoring data"
dc run --rm --no-deps -T --entrypoint sh -v "$WORK:/restore:ro" app -c '
set -e
cd /data
rm -f app.db app.db-wal app.db-shm
cp /restore/snapshot/app.db app.db
if [ -d /restore/audio ]; then rm -rf audio; cp -a /restore/audio audio; fi
' || die "The restore failed. The app is stopped; fix the problem and run this again."
ok "Data restored"

say "Starting the app"
dc up -d
wait_healthy || die "The app did not become healthy. Check: docker compose logs app"
ok "Restored and running"
