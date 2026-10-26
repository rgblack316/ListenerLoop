#!/usr/bin/env bash
# Shared helpers for install.sh and update.sh. Source this file; do not run it.

if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'; else B=''; G=''; Y=''; R=''; N=''; fi
say()  { printf '%s\n' "${B}==>${N} $*"; }
ok()   { printf '%s\n' "  ${G}ok${N}  $*"; }
warn() { printf '%s\n' "  ${Y}!!${N}  $*" >&2; }
die()  { printf '%s\n' "${R}Error:${N} $*" >&2; exit 1; }

ASSUME_YES="${ASSUME_YES:-0}"
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$LIB_DIR/.." && pwd)"
ENV_FILE="$APP_DIR/.env"

# ---------------------------------------------------------------- privileges and OS
require_root() {
  [ "$(id -u)" -eq 0 ] && return 0
  command -v sudo >/dev/null 2>&1 || die "Run this script as root (sudo is not installed)."
  say "Needs administrator rights; re-running with sudo."
  exec sudo -E bash "$SCRIPT_PATH" "$@"
}

check_os() {
  [ -r /etc/os-release ] || die "Cannot detect the operating system. This script supports Ubuntu and Debian."
  local id like
  id="$(. /etc/os-release; printf '%s' "${ID:-}")"
  like="$(. /etc/os-release; printf '%s' "${ID_LIKE:-}")"
  CODENAME="$(. /etc/os-release; printf '%s' "${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}")"
  case "$id" in
    ubuntu | debian) DOCKER_DISTRO="$id" ;;
    *) case " $like " in
      *" ubuntu "*) DOCKER_DISTRO=ubuntu ;;
      *" debian "*) DOCKER_DISTRO=debian ;;
      *) die "Unsupported system ($id). This script supports Ubuntu and Debian. Install Docker and Docker Compose yourself, then follow the manual steps in the README." ;;
    esac ;;
  esac
  [ -n "$CODENAME" ] || die "Could not work out the OS release name for the Docker package repository."
  command -v apt-get >/dev/null 2>&1 || die "apt-get was not found."
}

# ---------------------------------------------------------------- dependencies
APT_UPDATED=0
apt_install() {
  if [ "$APT_UPDATED" = 0 ]; then DEBIAN_FRONTEND=noninteractive apt-get update -qq; APT_UPDATED=1; fi
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
}

ensure_base_tools() {
  say "Checking base tools"
  local missing=()
  command -v git >/dev/null 2>&1 || missing+=(git)
  command -v curl >/dev/null 2>&1 || missing+=(curl)
  command -v openssl >/dev/null 2>&1 || missing+=(openssl)
  dpkg -s ca-certificates >/dev/null 2>&1 || missing+=(ca-certificates)
  if [ "${#missing[@]}" -gt 0 ]; then
    say "Installing: ${missing[*]}"
    apt_install "${missing[@]}"
  fi
  ok "git, curl, openssl"
}

install_docker_repo() {
  say "Adding Docker's official package repository"
  apt_install ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$DOCKER_DISTRO/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
    "$(dpkg --print-architecture)" "$DOCKER_DISTRO" "$CODENAME" > /etc/apt/sources.list.d/docker.list
  APT_UPDATED=0
}

ensure_docker() {
  say "Checking Docker"
  if ! command -v docker >/dev/null 2>&1; then
    install_docker_repo
    say "Installing Docker Engine and the Compose plugin"
    apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
  if ! docker compose version >/dev/null 2>&1; then
    say "Installing the Docker Compose plugin"
    if ! apt_install docker-compose-plugin 2>/dev/null; then
      apt_install docker-compose-v2 2>/dev/null || die "Docker is installed but the Compose plugin could not be installed. Install it (docker-compose-plugin) and run this again."
    fi
    docker compose version >/dev/null 2>&1 || die "The Docker Compose plugin is still missing after installing it."
  fi
  if ! docker info >/dev/null 2>&1; then
    say "Starting the Docker service"
    systemctl enable --now docker >/dev/null 2>&1 || service docker start >/dev/null 2>&1 || true
    local i
    for i in 1 2 3 4 5 6 7 8 9 10; do docker info >/dev/null 2>&1 && break; sleep 2; done
    docker info >/dev/null 2>&1 || die "The Docker service is not running. Start it and run this again."
  fi
  systemctl enable docker >/dev/null 2>&1 || true
  ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo installed), $(docker compose version --short 2>/dev/null || echo compose)"
}

# ---------------------------------------------------------------- git
repo_owner() { stat -c %U "$APP_DIR"; }
run_git() {
  local owner; owner="$(repo_owner)"
  if [ "$owner" != root ] && [ "$(id -u)" -eq 0 ] && command -v sudo >/dev/null 2>&1; then
    sudo -u "$owner" git -C "$APP_DIR" "$@"
  else
    git -c "safe.directory=$APP_DIR" -C "$APP_DIR" "$@"
  fi
}

# ---------------------------------------------------------------- docker compose
dc() { (cd "$APP_DIR" && docker compose "$@"); }
cli() { dc exec -T app node dist/cli.js "$@"; }

wait_healthy() {
  local cid status i
  for i in $(seq 1 60); do
    cid="$(dc ps -q app 2>/dev/null || true)"
    if [ -n "$cid" ]; then
      status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || true)"
      [ "$status" = healthy ] && return 0
    fi
    sleep 2
  done
  return 1
}

# ---------------------------------------------------------------- .env file
env_get() {
  local line
  line="$(grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -n1 || true)"
  line="${line#*=}"
  case "$line" in
    \'*\') line="${line:1:${#line}-2}" ;;
    \"*\") line="${line:1:${#line}-2}" ;;
  esac
  printf '%s' "$line"
}

env_set() {
  local key="$1" val="$2" out tmp
  case "$val" in *\'* | *$'\n'*) die "The value for $key contains a quote or line break, which the .env file cannot store safely." ;; esac
  out="$val"
  if [ -n "$val" ] && [[ "$val" =~ [^A-Za-z0-9_./:@,+=-] ]]; then out="'$val'"; fi
  tmp="$(mktemp "$ENV_FILE.XXXXXX")"
  K="$key" V="$out" awk 'BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"]; done = 0 }
    $0 ~ "^" k "=" { if (!done) { print k "=" v; done = 1 } ; next }
    { print }
    END { if (!done) print k "=" v }' "$ENV_FILE" > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

env_unset() {
  local tmp
  tmp="$(mktemp "$ENV_FILE.XXXXXX")"
  K="$1" awk 'BEGIN { k = ENVIRON["K"] } $0 !~ "^" k "=" { print }' "$ENV_FILE" > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

# Names of settings in .env.example (active or commented out) that .env does not have yet.
new_env_keys() {
  [ -f "$APP_DIR/.env.example" ] || return 0
  local key
  grep -oE '^#? ?[A-Z][A-Z0-9_]+=' "$APP_DIR/.env.example" | sed -E 's/^# ?//; s/=$//' | sort -u | while read -r key; do
    grep -qE "^#? ?$key=" "$ENV_FILE" 2>/dev/null || printf '%s\n' "$key"
  done
}

# ---------------------------------------------------------------- prompts
# Questions are read from the terminal, so the script also works when piped from curl.
# With --yes (or no terminal) nothing is asked: each answer comes from an environment
# variable of the same name, then the current .env value, then the default.
init_input() {
  if [ -n "${LL_INPUT:-}" ]; then
    exec 3<"$LL_INPUT"
  elif [ "$ASSUME_YES" = 0 ] && ( : </dev/tty ) 2>/dev/null; then
    exec 3</dev/tty
  else
    ASSUME_YES=1
  fi
}

# ask VAR "Question" [default]
ask() {
  local var="$1" q="$2" def="${3:-}" reply=""
  [ -n "${!var:-}" ] && def="${!var}"
  if [ "$ASSUME_YES" = 1 ]; then printf -v "$var" '%s' "$def"; return 0; fi
  printf '%s' "  $q${def:+ [$def]}: " >&2
  IFS= read -r -u 3 reply || reply=""
  printf -v "$var" '%s' "${reply:-$def}"
}

# ask_secret VAR "Question" [current]: Enter keeps the current value.
ask_secret() {
  local var="$1" q="$2" cur="${3:-}" reply=""
  [ -n "${!var:-}" ] && cur="${!var}"
  if [ "$ASSUME_YES" = 1 ]; then printf -v "$var" '%s' "$cur"; return 0; fi
  printf '%s' "  $q${cur:+ [press Enter to keep the current one]}: " >&2
  IFS= read -r -s -u 3 reply || reply=""
  printf '\n' >&2
  printf -v "$var" '%s' "${reply:-$cur}"
}

# ask_valid VAR "Question" default "regex" "message"  (repeats until the answer matches)
ask_valid() {
  local var="$1" q="$2" def="$3" re="$4" msg="$5"
  while true; do
    ask "$var" "$q" "$def"
    if [[ "${!var}" =~ $re ]]; then return 0; fi
    [ "$ASSUME_YES" = 1 ] && die "$msg (setting: $var)"
    warn "$msg"
    printf -v "$var" '%s' ''
  done
}

# ask_yn "Question" y|n  -> returns 0 for yes
ask_yn() {
  local reply=""
  if [ "$ASSUME_YES" = 1 ]; then [ "$2" = y ]; return; fi
  printf '%s' "  $1 [$([ "$2" = y ] && echo Y/n || echo y/N)]: " >&2
  IFS= read -r -u 3 reply || reply=""
  reply="${reply:-$2}"
  case "$reply" in y | Y | yes | YES) return 0 ;; *) return 1 ;; esac
}
