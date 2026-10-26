#!/usr/bin/env bash
# ListenerLoop updater for Ubuntu and Debian servers.
#
#   sudo ./scripts/update.sh
#
# Checks Docker and the other tools (installing anything missing), backs up the database,
# pulls the latest code, rebuilds and restarts. Your .env and data are left alone.
#
# Options:  --restart  Rebuild and restart with the current code (for example after editing .env).
#           --force    Rebuild even when there is nothing new to pull.
#           --yes      Never ask questions.
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]:-$0}"
# shellcheck source=lib.sh
. "$(cd "$(dirname "$SCRIPT_PATH")" && pwd)/lib.sh"

FORCE=0
RESTART_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --restart) RESTART_ONLY=1 ;;
    --yes | -y) ASSUME_YES=1 ;;
    -h | --help) sed -n '2,12p' "$SCRIPT_PATH" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $arg" ;;
  esac
done

require_root "$@"
check_os
init_input

echo
say "ListenerLoop updater"
echo "  Folder: $APP_DIR"
echo

[ -f "$ENV_FILE" ] || die "No .env found in $APP_DIR. Run ./scripts/install.sh first."
[ -f "$APP_DIR/docker-compose.yml" ] || die "docker-compose.yml was not found in $APP_DIR."

ensure_base_tools
ensure_docker

# ---------------------------------------------------------------- code
OLD_COMMIT=""
if [ "$RESTART_ONLY" = 0 ]; then
  [ -d "$APP_DIR/.git" ] || die "$APP_DIR is not a git checkout, so it cannot be updated. Install with: git clone https://github.com/rgblack316/ListenerLoop.git"
  if [ -n "$(run_git status --porcelain --untracked-files=no)" ]; then
    run_git status --short --untracked-files=no >&2
    die "You have local changes to tracked files (listed above). Commit, stash or discard them, then run this again. Settings belong in .env, which is not affected."
  fi
  BRANCH="$(run_git rev-parse --abbrev-ref HEAD)"
  [ "$BRANCH" != HEAD ] || die "The checkout is not on a branch (detached HEAD). Run: git checkout main"

  say "Checking for updates on $BRANCH"
  run_git fetch --quiet origin "$BRANCH" || die "Could not reach the git remote. Check the server's internet connection."
  OLD_COMMIT="$(run_git rev-parse HEAD)"
  NEW_COMMIT="$(run_git rev-parse "origin/$BRANCH")"
  if [ "$OLD_COMMIT" = "$NEW_COMMIT" ]; then
    ok "Already on the latest version ($(run_git rev-parse --short HEAD))"
    if [ "$FORCE" = 0 ]; then
      say "Making sure the containers are running"
      dc up -d
      wait_healthy && ok "ListenerLoop is running and healthy" || die "The app is not healthy. See: docker compose logs app"
      exit 0
    fi
  else
    echo "  New changes:"
    run_git log --oneline --no-decorate "$OLD_COMMIT..$NEW_COMMIT" | sed 's/^/    /' | head -20
  fi
fi

# ---------------------------------------------------------------- backup
backup_db() {
  [ -n "$(dc ps -q app 2>/dev/null || true)" ] || { warn "The app is not running, so the database backup was skipped."; return 0; }
  local js out
  js="
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const src = process.env.DATABASE_PATH || path.join(process.env.DATA_DIR || '/data', 'app.db');
if (!fs.existsSync(src)) { console.log('none'); process.exit(0); }
const dir = path.join(path.dirname(src), 'backups');
fs.mkdirSync(dir, { recursive: true });
const dest = path.join(dir, 'app-' + new Date().toISOString().replace(/[:.]/g, '-') + '.db');
new Database(src, { readonly: true }).backup(dest).then(() => {
  const old = fs.readdirSync(dir).filter((f) => f.startsWith('app-')).sort().slice(0, -7);
  for (const f of old) fs.rmSync(path.join(dir, f));
  console.log(dest);
}).catch((e) => { console.error(e.message); process.exit(1); });
"
  if out="$(dc exec -T app node -e "$js" 2>&1)"; then
    [ "$out" = none ] && ok "No database yet, nothing to back up" || ok "Database backed up inside the Docker volume: $out (the 7 newest are kept)"
  else
    warn "The database backup failed: $out"
    if ! ask_yn "Continue the update without a backup?" n; then die "Update cancelled. Nothing was changed."; fi
  fi
}
say "Backing up the database"
backup_db

# ---------------------------------------------------------------- update
if [ "$RESTART_ONLY" = 0 ] && [ -n "$OLD_COMMIT" ] && [ "$OLD_COMMIT" != "${NEW_COMMIT:-}" ]; then
  say "Pulling the latest code"
  run_git merge --ff-only "origin/$BRANCH" >/dev/null || die "Could not fast-forward to the latest code (your checkout has diverged from origin/$BRANCH). Nothing was changed."
  ok "Now at $(run_git rev-parse --short HEAD)"
  NEW_KEYS="$(new_env_keys | tr '\n' ' ')"
  if [ -n "${NEW_KEYS// /}" ]; then
    warn "This version has settings your .env does not set yet (the defaults are used): $NEW_KEYS"
    warn "See .env.example for what they do."
  fi
fi

say "Rebuilding and restarting (this takes a few minutes)"
dc up -d --build --remove-orphans
if wait_healthy; then
  ok "ListenerLoop is running and healthy"
else
  dc logs --tail 40 app || true
  echo >&2
  [ -n "$OLD_COMMIT" ] && echo "To go back: cd $APP_DIR && git checkout $OLD_COMMIT && docker compose up -d --build" >&2
  die "The app did not become healthy after the update. Your data and the backup are untouched."
fi
docker image prune -f >/dev/null 2>&1 || true
echo
say "Update complete"
