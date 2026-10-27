#!/usr/bin/env bash
# ListenerLoop installer for Ubuntu and Debian servers.
#
#   git clone https://github.com/rgblack316/ListenerLoop.git && cd ListenerLoop
#   sudo ./scripts/install.sh
#
# It installs Docker if needed, asks for your settings, writes .env, starts the app and
# creates the admin login. Run it again at any time to change settings: your current
# answers are offered as defaults and secrets are kept when you press Enter.
#
# Options:  --yes   Ask nothing. Answers come from environment variables named like the
#                   .env settings (APP_DOMAIN, TURNSTILE_SITE_KEY, ...), plus INSTALL_MODE
#                   (https or tunnel), ADMIN_EMAIL, ADMIN_PASSWORD, FIRST_SHOW_NAME,
#                   FIRST_SHOW_ORIGINS and FIRST_SHOW_EMAIL.
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]:-$0}"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" 2>/dev/null && pwd || true)"
REPO_URL="${REPO_URL:-https://github.com/rgblack316/ListenerLoop.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/listenerloop}"

# Run from a pipe (curl ... | sudo bash)? Fetch the repository first, then continue from it.
if [ ! -f "$SCRIPT_DIR/lib.sh" ]; then
  [ "$(id -u)" -eq 0 ] || { echo "Run this with sudo: curl -fsSL <url>/scripts/install.sh | sudo bash" >&2; exit 1; }
  command -v git >/dev/null 2>&1 || { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git ca-certificates; }
  if [ -d "$INSTALL_DIR/.git" ]; then git -C "$INSTALL_DIR" pull --ff-only; else git clone "$REPO_URL" "$INSTALL_DIR"; fi
  exec bash "$INSTALL_DIR/scripts/install.sh" "$@"
fi

# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

for arg in "$@"; do
  case "$arg" in
    --yes | -y) ASSUME_YES=1 ;;
    -h | --help) sed -n '2,15p' "$SCRIPT_PATH" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $arg" ;;
  esac
done

require_root "$@"
check_os
init_input

echo
say "ListenerLoop installer"
echo "  Folder: $APP_DIR"
[ "$ASSUME_YES" = 1 ] && echo "  Mode:   no questions (using environment variables and the current .env)"
echo

ensure_base_tools
ensure_docker

# ---------------------------------------------------------------- settings
[ -f "$APP_DIR/docker-compose.yml" ] || die "docker-compose.yml was not found in $APP_DIR."
if [ ! -f "$ENV_FILE" ]; then
  cp "$APP_DIR/.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok "Created .env from .env.example"
else
  ok "Found an existing .env; your current values are offered as defaults"
fi

cur() { env_get "$1"; }

echo
say "How will people reach ListenerLoop?"
echo "    1) This server serves HTTPS itself (Caddy gets a certificate; ports 80 and 443 must be open)"
echo "    2) Cloudflare Tunnel or another reverse proxy in front (the app listens on 127.0.0.1:3000)"
default_mode=1
case "$(cur COMPOSE_FILE)" in *tunnel*) default_mode=2 ;; esac
case "${INSTALL_MODE:-}" in https) MODE_CHOICE=1 ;; tunnel) MODE_CHOICE=2 ;; *) MODE_CHOICE="" ;; esac
ask_valid MODE_CHOICE "Choose 1 or 2" "$default_mode" '^[12]$' "Please answer 1 or 2."

echo
say "Domain"
current_domain="$(cur APP_DOMAIN)"
case "$current_domain" in *example.com) current_domain="" ;; esac
ask_valid APP_DOMAIN "Domain for this app, without https:// (for example dash.listenerloop.app)" "$current_domain" \
  '^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$' "Enter a domain such as dash.example.com."
APP_DOMAIN="$(printf '%s' "$APP_DOMAIN" | tr 'A-Z' 'a-z')"
if [ "$MODE_CHOICE" = 1 ] && ! getent hosts "$APP_DOMAIN" >/dev/null 2>&1; then
  warn "$APP_DOMAIN does not resolve yet. Point its DNS record at this server before Caddy can get a certificate."
fi

echo
say "Cloudflare Turnstile (spam protection)"
echo "  Create ONE Turnstile widget in the Cloudflare dashboard and list only $APP_DOMAIN as its hostname."
echo "  Sites that embed ListenerLoop do not need a Turnstile key of their own."
echo "  Type 'test' to use Cloudflare's dummy keys, which accept everything. Testing only, never for a live site."
TURNSTILE_SITE_KEY="${TURNSTILE_SITE_KEY:-}"
ask_valid TURNSTILE_SITE_KEY "Turnstile site key" "$(cur TURNSTILE_SITE_KEY)" '^[^[:space:]]+$' "A Turnstile site key is required."
if [ "$TURNSTILE_SITE_KEY" = test ]; then
  warn "Using Cloudflare's dummy Turnstile keys. Bots will not be blocked. Run this installer again with real keys before going live."
  TURNSTILE_SITE_KEY="1x00000000000000000000AA"
  TURNSTILE_SECRET_KEY="1x0000000000000000000000000000000AA"
else
  TURNSTILE_SECRET_KEY="${TURNSTILE_SECRET_KEY:-}"
  while true; do
    ask_secret TURNSTILE_SECRET_KEY "Turnstile secret key" "$(cur TURNSTILE_SECRET_KEY)"
    [ -n "$TURNSTILE_SECRET_KEY" ] && break
    [ "$ASSUME_YES" = 1 ] && die "A Turnstile secret key is required (TURNSTILE_SECRET_KEY)."
    warn "A Turnstile secret key is required."
  done
fi

echo
say "Where should recordings be stored?"
echo "  s3    = an S3-compatible bucket (Cloudflare R2, Backblaze B2, MinIO, AWS). Use a PRIVATE bucket made just for"
echo "          ListenerLoop, with its own access key, and not your public podcast CDN bucket."
echo "  local = a folder on this server (inside the Docker volume)"
ask_valid STORAGE_DRIVER "Storage (s3 or local)" "$(cur STORAGE_DRIVER)" '^(s3|local)$' "Answer s3 or local."
if [ "$STORAGE_DRIVER" = s3 ]; then
  ask_valid S3_ENDPOINT "S3 endpoint URL (R2: https://<account-id>.r2.cloudflarestorage.com)" "$(cur S3_ENDPOINT)" '^https?://[^[:space:]]+$' "Enter a full URL starting with https://"
  ask S3_REGION "S3 region (use auto for Cloudflare R2)" "$(cur S3_REGION)"
  S3_REGION="${S3_REGION:-auto}"
  ask_valid S3_BUCKET "Bucket name" "$(cur S3_BUCKET)" '^[^[:space:]]+$' "A bucket name is required."
  ask_valid S3_ACCESS_KEY_ID "Access key ID" "$(cur S3_ACCESS_KEY_ID)" '^[^[:space:]]+$' "An access key ID is required."
  S3_SECRET_ACCESS_KEY="${S3_SECRET_ACCESS_KEY:-}"
  while true; do
    ask_secret S3_SECRET_ACCESS_KEY "Secret access key" "$(cur S3_SECRET_ACCESS_KEY)"
    [ -n "$S3_SECRET_ACCESS_KEY" ] && break
    [ "$ASSUME_YES" = 1 ] && die "An S3 secret access key is required (S3_SECRET_ACCESS_KEY)."
    warn "A secret access key is required."
  done
  path_default=n; [ "$(cur S3_FORCE_PATH_STYLE)" = true ] && path_default=y
  if ask_yn "Use path-style addressing? (needed by some self-hosted services such as MinIO; R2 and AWS do not)" "$path_default"; then S3_FORCE_PATH_STYLE=true; else S3_FORCE_PATH_STYLE=false; fi
fi

echo
say "Email alerts"
echo "  smtp   = any mail provider with a host, user and password"
echo "  resend = Resend, using an API key"
echo "  none   = no email (you check the inbox yourself)"
ask_valid MAIL_PROVIDER "Email provider (smtp, resend or none)" "$(cur MAIL_PROVIDER)" '^(smtp|resend|none)$' "Answer smtp, resend or none."
if [ "$MAIL_PROVIDER" != none ]; then
  ask_valid MAIL_FROM "Send alerts from (for example ListenerLoop <alerts@yourdomain.com>)" "$(cur MAIL_FROM)" '^[^[:space:]].*@.*$' "Enter a sender address."
fi
if [ "$MAIL_PROVIDER" = smtp ]; then
  ask_valid SMTP_HOST "SMTP host" "$(cur SMTP_HOST)" '^[^[:space:]]+$' "An SMTP host is required."
  ask_valid SMTP_PORT "SMTP port" "${SMTP_PORT:-$(cur SMTP_PORT)}" '^[0-9]{1,5}$' "Enter a port number such as 587."
  ask SMTP_USER "SMTP username" "$(cur SMTP_USER)"
  ask_secret SMTP_PASS "SMTP password" "$(cur SMTP_PASS)"
elif [ "$MAIL_PROVIDER" = resend ]; then
  RESEND_API_KEY="${RESEND_API_KEY:-}"
  while true; do
    ask_secret RESEND_API_KEY "Resend API key" "$(cur RESEND_API_KEY)"
    [ -n "$RESEND_API_KEY" ] && break
    [ "$ASSUME_YES" = 1 ] && die "A Resend API key is required (RESEND_API_KEY)."
    warn "A Resend API key is required."
  done
fi

# ---------------------------------------------------------------- write .env
echo
say "Writing .env"
SESSION_SECRET_NOW="$(cur SESSION_SECRET)"
case "$SESSION_SECRET_NOW" in change-me* | "") SESSION_SECRET_NOW="" ;; esac
if [ "${#SESSION_SECRET_NOW}" -lt 32 ]; then
  SESSION_SECRET_NOW="$(openssl rand -hex 32)"
  ok "Generated a new SESSION_SECRET. Keep it: changing it later signs everyone out and breaks stored per-show Turnstile secrets."
fi

env_set APP_URL "https://$APP_DOMAIN"
env_set APP_DOMAIN "$APP_DOMAIN"
env_set SESSION_SECRET "$SESSION_SECRET_NOW"
env_set TURNSTILE_SITE_KEY "$TURNSTILE_SITE_KEY"
env_set TURNSTILE_SECRET_KEY "$TURNSTILE_SECRET_KEY"
env_set STORAGE_DRIVER "$STORAGE_DRIVER"
if [ "$STORAGE_DRIVER" = s3 ]; then
  env_set S3_ENDPOINT "$S3_ENDPOINT"
  env_set S3_REGION "$S3_REGION"
  env_set S3_BUCKET "$S3_BUCKET"
  env_set S3_ACCESS_KEY_ID "$S3_ACCESS_KEY_ID"
  env_set S3_SECRET_ACCESS_KEY "$S3_SECRET_ACCESS_KEY"
  env_set S3_FORCE_PATH_STYLE "$S3_FORCE_PATH_STYLE"
fi
env_set MAIL_PROVIDER "$MAIL_PROVIDER"
[ "$MAIL_PROVIDER" != none ] && env_set MAIL_FROM "$MAIL_FROM"
if [ "$MAIL_PROVIDER" = smtp ]; then
  env_set SMTP_HOST "$SMTP_HOST"; env_set SMTP_PORT "$SMTP_PORT"; env_set SMTP_USER "$SMTP_USER"; env_set SMTP_PASS "$SMTP_PASS"
fi
[ "$MAIL_PROVIDER" = resend ] && env_set RESEND_API_KEY "$RESEND_API_KEY"
env_set TRUST_PROXY true

# docker compose reads these two from .env, so plain `docker compose` commands (and update.sh) use the same mode.
if [ "$MODE_CHOICE" = 1 ]; then
  env_set COMPOSE_PROFILES caddy
  env_unset COMPOSE_FILE
else
  env_unset COMPOSE_PROFILES
  env_set COMPOSE_FILE docker-compose.yml:docker-compose.tunnel.yml
fi
[ "$(repo_owner)" != root ] && chown "$(repo_owner)" "$ENV_FILE"
chmod 600 "$ENV_FILE"
ok ".env saved (private to its owner)"

# ---------------------------------------------------------------- start
echo
say "Building and starting ListenerLoop (the first build takes a few minutes)"
[ "$MODE_CHOICE" = 2 ] && dc --profile caddy rm -sf caddy >/dev/null 2>&1 || true
dc up -d --build
if wait_healthy; then
  ok "ListenerLoop is running and healthy"
else
  dc logs --tail 40 app || true
  die "The app did not become healthy. Check the log above, fix .env, and run this installer again."
fi

# ---------------------------------------------------------------- admin and first show
echo
say "Admin account"
if cli has-admin >/dev/null 2>&1; then
  ok "An admin account already exists. To replace its login: docker compose exec app node dist/cli.js create-admin you@example.com --force"
else
  ask_valid ADMIN_EMAIL "Admin email (your sign-in name)" "" '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' "Enter a valid email address."
  while true; do
    ask_secret ADMIN_PASSWORD "Admin password (at least 12 characters)" ""
    if [ "${#ADMIN_PASSWORD}" -ge 12 ]; then
      if [ "$ASSUME_YES" = 1 ]; then break; fi
      confirm=""; ask_secret confirm "Repeat the password" ""
      [ "$confirm" = "$ADMIN_PASSWORD" ] && break
      warn "The passwords did not match."
    else
      [ "$ASSUME_YES" = 1 ] && die "The admin password must be at least 12 characters (ADMIN_PASSWORD)."
      warn "Use at least 12 characters."
    fi
    ADMIN_PASSWORD=""
  done
  export ADMIN_PASSWORD
  cli_status=0
  dc exec -T -e ADMIN_PASSWORD app node dist/cli.js create-admin "$ADMIN_EMAIL" || cli_status=$?
  unset ADMIN_PASSWORD
  [ "$cli_status" -eq 0 ] || die "Could not create the admin account."
fi

echo
say "First show"
shows_default=y
cli list-shows 2>/dev/null | grep -q 'No shows yet' || shows_default=n
if [ "$ASSUME_YES" = 1 ]; then
  add_show=0; [ -n "${FIRST_SHOW_NAME:-}" ] && add_show=1
elif ask_yn "Add a show now?" "$shows_default"; then add_show=1; else add_show=0; fi
if [ "$add_show" = 1 ]; then
  ask_valid FIRST_SHOW_NAME "Show name" "" '^.+$' "A show name is required."
  ask FIRST_SHOW_ORIGINS "Website(s) that will embed it, separated by spaces (for example https://mypodcast.com)" ""
  ask_valid FIRST_SHOW_EMAIL "Email address for this show (new-message alerts go here, and listener replies use it as the Reply-To)" "${FIRST_SHOW_EMAIL:-${ADMIN_EMAIL:-}}" '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' "Enter a valid email address."
  args=(add-show --name "$FIRST_SHOW_NAME" --notify-email "$FIRST_SHOW_EMAIL")
  for o in ${FIRST_SHOW_ORIGINS:-}; do args+=(--origin "$o"); done
  cli "${args[@]}" || warn "The show could not be added. Add it later in the admin under Shows."
fi

# ---------------------------------------------------------------- done
echo
say "Done"
echo "  Sign in:  https://$APP_DOMAIN/login"
if [ "$MODE_CHOICE" = 1 ]; then
  echo "  Make sure DNS for $APP_DOMAIN points at this server and ports 80 and 443 are open."
else
  echo "  Point your tunnel or proxy at http://localhost:3000 for $APP_DOMAIN."
fi
echo "  Turnstile: the widget's hostname list must include $APP_DOMAIN."
echo "  Embed code: Shows page in the admin (or: docker compose exec app node dist/cli.js list-shows)."
echo "  Edit settings later: sudo nano $ENV_FILE, then run: sudo ./scripts/update.sh --restart"
echo "  Update to the newest version: sudo ./scripts/update.sh"
