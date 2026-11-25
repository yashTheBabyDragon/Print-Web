#!/usr/bin/env bash
# GGPrint — Automatic GitHub Release Updater (Docker Compose)
# Always updates GGPrint inside Docker containers with PostgreSQL backup & rollback.
#
# Usage:
#   sudo /opt/ggprint/deploy/update-from-release.sh [--check] [--force]
#
# Security:
#   - Strictly validates release tags against ^[A-Za-z0-9._-]+$
#   - Optional GPG tag verification: set GGPRINT_VERIFY_SIGNATURES=true in .env

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

GGPRINT_DIR="${GGPRINT_DIR:-${DEFAULT_DIR}}"
GGPRINT_PORT="${GGPRINT_PORT:-8000}"
GGPRINT_REPO="${GGPRINT_REPO:-}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
GGPRINT_VERIFY_SIGNATURES="${GGPRINT_VERIFY_SIGNATURES:-${GGPRINT_VERIFY_GPG:-}}"
ENV_FILE="${GGPRINT_ENV_FILE:-${GGPRINT_DIR}/.env}"

CHECK_ONLY=0
FORCE_UPDATE=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Checks GitHub Releases for a newer version of GGPrint, backs up the Docker
PostgreSQL database to compressed .sql.gz, rebuilds and restarts the Docker
Compose stack, verifies /api/health, and automatically rolls back on failure.

Options:
  --check     Dry-run: check current vs latest release and exit 0
  --force     Force rebuild/restart even if already on the latest release
  --docker    (Default) Docker Compose mode
  -h, --help  Show this help message

Environment overrides:
  GGPRINT_DIR                Installation directory (default: ${DEFAULT_DIR})
  GGPRINT_REPO               GitHub owner/repo (default: yashTheBabyDragon/GGPrint-Web)
  GGPRINT_PORT               Backend healthcheck port (default: 8000)
  GGPRINT_VERIFY_SIGNATURES  Set to "true" to require 'git verify-tag' on release tags
  GITHUB_TOKEN               Optional GitHub token for higher API rate limits
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)  CHECK_ONLY=1 ;;
    --force)  FORCE_UPDATE=1 ;;
    --docker) ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

read_env_var() {
  local file="$1"
  local key="$2"
  grep -E "^${key}=" "${file}" 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '"\r' || true
}

set_env_var() {
  local file="$1"
  local key="$2"
  local val="$3"
  if [[ ! -f "${file}" ]]; then
    return 0
  fi
  if grep -qE "^${key}=" "${file}" 2>/dev/null; then
    sed -i -E "s|^${key}=.*|${key}=${val}|" "${file}"
  else
    printf '%s=%s\n' "${key}" "${val}" >> "${file}"
  fi
}

# Load optional updater settings from .env if present and unset
if [[ -r "${ENV_FILE}" ]]; then
  if [[ -z "${GGPRINT_REPO}" ]]; then
    GGPRINT_REPO="$(read_env_var "${ENV_FILE}" "GITHUB_REPO")"
  fi
  if [[ -z "${GITHUB_TOKEN}" ]]; then
    GITHUB_TOKEN="$(read_env_var "${ENV_FILE}" "GITHUB_TOKEN")"
  fi
  if [[ -z "${GGPRINT_VERIFY_SIGNATURES}" ]]; then
    GGPRINT_VERIFY_SIGNATURES="$(read_env_var "${ENV_FILE}" "GGPRINT_VERIFY_SIGNATURES")"
    if [[ -z "${GGPRINT_VERIFY_SIGNATURES}" ]]; then
      GGPRINT_VERIFY_SIGNATURES="$(read_env_var "${ENV_FILE}" "GGPRINT_VERIFY_GPG")"
    fi
  fi
  env_port="$(read_env_var "${ENV_FILE}" "BACKEND_PORT")"
  if [[ -n "${env_port}" ]]; then
    GGPRINT_PORT="${env_port}"
  fi
fi

GGPRINT_REPO="${GGPRINT_REPO:-yashTheBabyDragon/GGPrint-Web}"
GGPRINT_VERIFY_SIGNATURES="${GGPRINT_VERIFY_SIGNATURES:-false}"
HEALTH_URL="http://127.0.0.1:${GGPRINT_PORT}/api/health"
VERSION_FILE="${GGPRINT_DIR}/.ggprint-version"

log()  { printf '[ggprint-update] %s\n' "$*"; }
warn() { printf '[ggprint-update] WARNING: %s\n' "$*" >&2; }
err()  { printf '[ggprint-update] ERROR: %s\n' "$*" >&2; }

if [[ ! -d "${GGPRINT_DIR}/.git" ]]; then
  err "Not a git repository: ${GGPRINT_DIR}"
  exit 1
fi

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  err "Docker Engine and Docker Compose plugin are required."
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. Determine current local version & ref
# ---------------------------------------------------------------------------
get_current_version() {
  if [[ -f "${VERSION_FILE}" ]]; then
    tr -d ' \t\r\n' < "${VERSION_FILE}"
  else
    git -C "${GGPRINT_DIR}" describe --tags --exact-match 2>/dev/null \
      || git -C "${GGPRINT_DIR}" rev-parse --short HEAD
  fi
}

CURRENT_VERSION="$(get_current_version)"
PREV_REF="$(git -C "${GGPRINT_DIR}" rev-parse HEAD)"

# ---------------------------------------------------------------------------
# 2. Query latest GitHub Release (with fallback to latest remote git tag)
# ---------------------------------------------------------------------------
get_latest_release_tag() {
  local api_url="https://api.github.com/repos/${GGPRINT_REPO}/releases/latest"
  local curl_args=(-fsSL --connect-timeout 10 --max-time 20 -H "Accept: application/vnd.github+json" -H "User-Agent: ggprint-updater")
  if [[ -n "${GITHUB_TOKEN}" ]]; then
    curl_args+=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
  fi

  local tag=""
  if response="$(curl "${curl_args[@]}" "${api_url}" 2>/dev/null)"; then
    if command -v jq >/dev/null 2>&1; then
      tag="$(printf '%s' "${response}" | jq -r '.tag_name // empty')"
    else
      tag="$(printf '%s' "${response}" | sed -nE 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -n 1 || true)"
    fi
  fi

  if [[ -n "${tag}" ]]; then
    echo "${tag}"
    return 0
  fi

  # Fallback: query remote git tags if no GitHub Release exists yet
  local fallback_tag
  fallback_tag="$(
    git -C "${GGPRINT_DIR}" ls-remote --tags --refs origin 'v*' 2>/dev/null \
      | awk '{print $2}' \
      | sed 's|refs/tags/||' \
      | sort -V \
      | tail -n 1 || true
  )"
  if [[ -n "${fallback_tag}" ]]; then
    echo "${fallback_tag}"
    return 0
  fi

  echo ""
}

LATEST_TAG="$(get_latest_release_tag)"

if [[ -z "${LATEST_TAG}" ]]; then
  log "No GitHub Release or version tags found for ${GGPRINT_REPO}. Nothing to update."
  exit 0
fi

# Strictly validate tag format to prevent ref/argument injection
if [[ ! "${LATEST_TAG}" =~ ^[A-Za-z0-9._-]+$ ]]; then
  err "Refusing invalid release tag name: '${LATEST_TAG}'"
  exit 1
fi

log "Current version: ${CURRENT_VERSION} | Latest release: ${LATEST_TAG}"

if [[ "${CHECK_ONLY}" -eq 1 ]]; then
  if [[ "${CURRENT_VERSION}" == "${LATEST_TAG}" ]]; then
    log "Status: up to date."
  else
    log "Status: update available (${CURRENT_VERSION} -> ${LATEST_TAG})."
  fi
  exit 0
fi

if [[ "${CURRENT_VERSION}" == "${LATEST_TAG}" && "${FORCE_UPDATE}" -eq 0 ]]; then
  log "Already up to date (${CURRENT_VERSION}). Use --force to reinstall."
  exit 0
fi

# ---------------------------------------------------------------------------
# 3. Backup Docker PostgreSQL database (retaining last 10 .sql.gz backups)
# ---------------------------------------------------------------------------
backup_postgres() {
  local backup_dir="${GGPRINT_DIR}/backups"
  mkdir -p "${backup_dir}"

  local pg_user pg_db safe_ver ts backup_file
  pg_user="$(read_env_var "${ENV_FILE}" "POSTGRES_USER")"
  pg_db="$(read_env_var "${ENV_FILE}" "POSTGRES_DB")"
  pg_user="${pg_user:-ggprint}"
  pg_db="${pg_db:-ggprint}"
  safe_ver="$(printf '%s' "${CURRENT_VERSION}" | tr -cs 'A-Za-z0-9._-' '_')"
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_file="${backup_dir}/ggprint-${safe_ver}-${ts}.sql.gz"

  if (cd "${GGPRINT_DIR}" && docker compose ps --status running --services 2>/dev/null | grep -qx "postgres"); then
    log "Creating compressed PostgreSQL backup: ${backup_file}"
    if ! (cd "${GGPRINT_DIR}" && docker compose exec -T postgres pg_dump -U "${pg_user}" "${pg_db}" | gzip -9 > "${backup_file}"); then
      warn "PostgreSQL backup failed; removing partial file and continuing."
      rm -f "${backup_file}"
    fi

    mapfile -t backups < <(ls -1t "${backup_dir}"/ggprint-*.sql.gz 2>/dev/null || true)
    if (( ${#backups[@]} > 10 )); then
      for old_backup in "${backups[@]:10}"; do
        rm -f "${old_backup}"
      done
    fi
  else
    log "PostgreSQL container is not running; skipping pre-update dump."
  fi
}

backup_postgres

# ---------------------------------------------------------------------------
# 4. Docker Compose rebuild, restart & health check helpers
# ---------------------------------------------------------------------------
write_version_file() {
  local ver="$1"
  printf '%s\n' "${ver}" > "${VERSION_FILE}"
  set_env_var "${ENV_FILE}" "APP_VERSION" "${ver}"
}

build_and_restart() {
  log "Rebuilding and restarting GGPrint Docker Compose stack..."
  (cd "${GGPRINT_DIR}" && docker compose up -d --build --remove-orphans)
}

wait_for_health() {
  log "Polling ${HEALTH_URL} for up to 60s..."
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 3 "${HEALTH_URL}" >/dev/null 2>&1; then
      log "Health check passed!"
      return 0
    fi
    sleep 2
  done
  err "Health check failed after 60s at ${HEALTH_URL}."
  return 1
}

rollback() {
  err "Update to ${LATEST_TAG} failed! Rolling back to ${CURRENT_VERSION} (${PREV_REF})..."
  set +e
  git -C "${GGPRINT_DIR}" checkout --force "${PREV_REF}"
  write_version_file "${CURRENT_VERSION}"
  build_and_restart
  if wait_for_health; then
    warn "Rollback to ${CURRENT_VERSION} succeeded and Docker stack is healthy."
  else
    err "Rollback completed, but health check is still failing. Check 'docker compose logs' immediately!"
  fi
  exit 1
}

# ---------------------------------------------------------------------------
# 5. Perform Docker update with automatic rollback on failure
# ---------------------------------------------------------------------------
log "Fetching tags..."
git -C "${GGPRINT_DIR}" fetch --tags --force origin

if [[ "${GGPRINT_VERIFY_SIGNATURES}" == "true" ]]; then
  log "Verifying GPG signature on tag ${LATEST_TAG}..."
  if ! git -C "${GGPRINT_DIR}" verify-tag "${LATEST_TAG}"; then
    err "GPG signature verification failed for tag ${LATEST_TAG}. Aborting update."
    exit 1
  fi
fi

log "Checking out ${LATEST_TAG}..."
git -C "${GGPRINT_DIR}" checkout --force "tags/${LATEST_TAG}"
write_version_file "${LATEST_TAG}"

if ! build_and_restart; then
  rollback
fi

if ! wait_for_health; then
  rollback
fi

log "Successfully updated GGPrint Docker stack from ${CURRENT_VERSION} to ${LATEST_TAG}."
