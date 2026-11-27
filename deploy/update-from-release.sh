#!/usr/bin/env bash
# Print-Web — On-Demand GitHub Release Updater (GHCR Pre-Built Docker Images)
# Updates Print-Web ONLY when explicitly triggered by an Admin/permitted user
# (via Admin UI -> /opt/print-web/updater/request.json -> print-web-update.path)
# or manually via CLI. Never runs unattended on a schedule and never builds
# containers locally on the host.
#
# Usage:
#   sudo /opt/print-web/deploy/update-from-release.sh [--check] [--force] [tag]
#   sudo /opt/print-web/deploy/update-from-release.sh --from-trigger
#
# Security:
#   - Strictly validates release tags against ^[A-Za-z0-9._-]+$
#   - Optional GPG tag verification: set PRINT_WEB_VERIFY_SIGNATURES=true in .env

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

PRINT_WEB_DIR="${PRINT_WEB_DIR:-${DEFAULT_DIR}}"
PRINT_WEB_PORT="${PRINT_WEB_PORT:-8000}"
PRINT_WEB_REPO="${PRINT_WEB_REPO:-}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
GITHUB_ACTOR="${GITHUB_ACTOR:-}"
PRINT_WEB_VERIFY_SIGNATURES="${PRINT_WEB_VERIFY_SIGNATURES:-${PRINT_WEB_VERIFY_GPG:-}}"
ENV_FILE="${PRINT_WEB_ENV_FILE:-${PRINT_WEB_DIR}/.env}"
UPDATER_DIR="${PRINT_WEB_UPDATER_DIR:-${PRINT_WEB_DIR}/updater}"

CHECK_ONLY=0
FORCE_UPDATE=0
FROM_TRIGGER=0
EXPLICIT_TAG=""
REQUESTED_BY="cli"

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS] [TAG]

On-demand updater for Print-Web. Backs up the Docker PostgreSQL database to
compressed .sql.gz, pulls the pre-built GHCR images for the requested (or
latest) GitHub Release tag, restarts the Docker Compose stack (--no-build),
verifies /api/health, and automatically rolls back on pull or health failure.

Options:
  --check         Dry-run: check current vs latest release and exit 0
  --force         Force pull/restart even if already on the target release
  --from-trigger  Read target_version from ${UPDATER_DIR}/request.json (used by systemd .path)
  --docker        (Default) Docker Compose GHCR pull mode
  -h, --help      Show this help message

Arguments:
  TAG             Optional explicit release tag (e.g. v1.2.0); defaults to latest GitHub Release

Environment overrides:
  PRINT_WEB_DIR                Installation directory (default: ${DEFAULT_DIR})
  PRINT_WEB_UPDATER_DIR        Trigger/status directory (default: ${PRINT_WEB_DIR}/updater)
  PRINT_WEB_REPO               GitHub owner/repo (default: yashTheBabyDragon/Print-Web)
  PRINT_WEB_PORT               Backend healthcheck port (default: 8000)
  PRINT_WEB_VERIFY_SIGNATURES  Set to "true" to require 'git verify-tag' on release tags
  GITHUB_TOKEN               Optional GitHub token for private GHCR packages / API rate limits
  GITHUB_ACTOR               Optional GitHub username for GHCR login (default: x-access-token)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)        CHECK_ONLY=1 ;;
    --force)        FORCE_UPDATE=1 ;;
    --from-trigger) FROM_TRIGGER=1 ;;
    --docker)       ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -z "${EXPLICIT_TAG}" ]]; then
        EXPLICIT_TAG="$1"
      else
        echo "Unexpected extra argument: $1" >&2
        usage >&2
        exit 2
      fi
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
  if [[ -z "${PRINT_WEB_REPO}" ]]; then
    PRINT_WEB_REPO="$(read_env_var "${ENV_FILE}" "GITHUB_REPO")"
  fi
  if [[ -z "${GITHUB_TOKEN}" ]]; then
    GITHUB_TOKEN="$(read_env_var "${ENV_FILE}" "GITHUB_TOKEN")"
  fi
  if [[ -z "${GITHUB_ACTOR}" ]]; then
    GITHUB_ACTOR="$(read_env_var "${ENV_FILE}" "GITHUB_ACTOR")"
  fi
  if [[ -z "${PRINT_WEB_VERIFY_SIGNATURES}" ]]; then
    PRINT_WEB_VERIFY_SIGNATURES="$(read_env_var "${ENV_FILE}" "PRINT_WEB_VERIFY_SIGNATURES")"
    if [[ -z "${PRINT_WEB_VERIFY_SIGNATURES}" ]]; then
      PRINT_WEB_VERIFY_SIGNATURES="$(read_env_var "${ENV_FILE}" "PRINT_WEB_VERIFY_GPG")"
    fi
  fi
  env_port="$(read_env_var "${ENV_FILE}" "BACKEND_PORT")"
  if [[ -n "${env_port}" ]]; then
    PRINT_WEB_PORT="${env_port}"
  fi
  env_updater_dir="$(read_env_var "${ENV_FILE}" "PRINT_WEB_UPDATER_DIR")"
  if [[ -n "${env_updater_dir}" && -z "${PRINT_WEB_UPDATER_DIR:-}" ]]; then
    UPDATER_DIR="${env_updater_dir}"
  fi
fi

PRINT_WEB_REPO="${PRINT_WEB_REPO:-yashTheBabyDragon/Print-Web}"
PRINT_WEB_VERIFY_SIGNATURES="${PRINT_WEB_VERIFY_SIGNATURES:-false}"
HEALTH_URL="http://127.0.0.1:${PRINT_WEB_PORT}/api/health"
VERSION_FILE="${PRINT_WEB_DIR}/.print-web-version"
REQUEST_FILE="${UPDATER_DIR}/request.json"
STATUS_FILE="${UPDATER_DIR}/status.json"

log()  { printf '[print-web-update] %s\n' "$*"; }
warn() { printf '[print-web-update] WARNING: %s\n' "$*" >&2; }
err()  { printf '[print-web-update] ERROR: %s\n' "$*" >&2; }

write_job_status() {
  local state="$1"
  local target="${2:-}"
  local message="${3:-}"
  if [[ ! -d "${UPDATER_DIR}" ]]; then
    return 0
  fi
  chmod 0777 "${UPDATER_DIR}" 2>/dev/null || true
  local now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local tmp_file="${STATUS_FILE}.tmp.$$"
  if command -v jq >/dev/null 2>&1; then
    jq -n \
      --arg state "${state}" \
      --arg target_version "${target}" \
      --arg requested_by "${REQUESTED_BY}" \
      --arg updated_at "${now}" \
      --arg message "${message}" \
      '{state: $state, target_version: (if $target_version == "" then null else $target_version end), requested_by: $requested_by, updated_at: $updated_at, message: $message}' \
      > "${tmp_file}"
  else
    local safe_msg
    safe_msg="$(printf '%s' "${message}" | tr '"' "'" | tr '\n' ' ')"
    printf '{"state":"%s","target_version":"%s","requested_by":"%s","updated_at":"%s","message":"%s"}\n' \
      "${state}" "${target}" "${REQUESTED_BY}" "${now}" "${safe_msg}" > "${tmp_file}"
  fi
  chmod 0666 "${tmp_file}" 2>/dev/null || true
  mv -f "${tmp_file}" "${STATUS_FILE}"
}

if [[ ! -d "${PRINT_WEB_DIR}/.git" ]]; then
  err "Not a git repository: ${PRINT_WEB_DIR}"
  exit 1
fi

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  err "Docker Engine and Docker Compose plugin are required."
  exit 1
fi

# ---------------------------------------------------------------------------
# 0. Handle --from-trigger mode (systemd .path activation)
# ---------------------------------------------------------------------------
if [[ "${FROM_TRIGGER}" -eq 1 ]]; then
  chmod 0777 "${UPDATER_DIR}" 2>/dev/null || true
  if [[ ! -f "${REQUEST_FILE}" ]]; then
    log "No trigger file at ${REQUEST_FILE}; nothing to do."
    exit 0
  fi

  if command -v jq >/dev/null 2>&1; then
    EXPLICIT_TAG="$(jq -r '.target_version // empty' "${REQUEST_FILE}" 2>/dev/null || true)"
    req_by="$(jq -r '.requested_by // empty' "${REQUEST_FILE}" 2>/dev/null || true)"
    if [[ -n "${req_by}" ]]; then
      REQUESTED_BY="${req_by}"
    fi
  else
    EXPLICIT_TAG="$(sed -nE 's/.*"target_version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "${REQUEST_FILE}" | head -n 1 || true)"
  fi

  # Remove trigger file immediately so systemd .path will not re-fire in a loop
  rm -f "${REQUEST_FILE}"

  if [[ -z "${EXPLICIT_TAG}" ]]; then
    err "Trigger file ${REQUEST_FILE} did not contain a valid target_version."
    write_job_status "failed" "" "Update request was missing target_version."
    exit 1
  fi

  if [[ ! "${EXPLICIT_TAG}" =~ ^[A-Za-z0-9._-]+$ ]]; then
    err "Refusing invalid target_version from trigger file: '${EXPLICIT_TAG}'"
    write_job_status "failed" "" "Refused invalid release tag name."
    exit 1
  fi

  FORCE_UPDATE=1
  write_job_status "updating" "${EXPLICIT_TAG}" "Starting update to ${EXPLICIT_TAG}..."
fi

# ---------------------------------------------------------------------------
# 1. Determine current local version, image tag & git ref
# ---------------------------------------------------------------------------
get_current_version() {
  if [[ -f "${VERSION_FILE}" ]]; then
    tr -d ' \t\r\n' < "${VERSION_FILE}"
  else
    git -C "${PRINT_WEB_DIR}" describe --tags --exact-match 2>/dev/null \
      || git -C "${PRINT_WEB_DIR}" rev-parse --short HEAD
  fi
}

CURRENT_VERSION="$(get_current_version)"
PREV_REF="$(git -C "${PRINT_WEB_DIR}" rev-parse HEAD)"
PREV_IMAGE_TAG="$(read_env_var "${ENV_FILE}" "PRINT_WEB_IMAGE_TAG")"
PREV_IMAGE_TAG="${PREV_IMAGE_TAG:-latest}"
unset APP_VERSION PRINT_WEB_IMAGE_TAG

# ---------------------------------------------------------------------------
# 2. Determine target release tag (explicit or latest GitHub Release)
# ---------------------------------------------------------------------------
get_latest_release_tag() {
  local api_url="https://api.github.com/repos/${PRINT_WEB_REPO}/releases/latest"
  local curl_args=(-fsSL --connect-timeout 10 --max-time 20 -H "Accept: application/vnd.github+json" -H "User-Agent: print-web-updater")
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
    git -C "${PRINT_WEB_DIR}" ls-remote --tags --refs origin 'v*' 2>/dev/null \
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

if [[ -n "${EXPLICIT_TAG}" ]]; then
  TARGET_TAG="${EXPLICIT_TAG}"
else
  TARGET_TAG="$(get_latest_release_tag)"
fi

if [[ -z "${TARGET_TAG}" ]]; then
  log "No GitHub Release or version tags found for ${PRINT_WEB_REPO}. Nothing to update."
  exit 0
fi

# Strictly validate tag format to prevent ref/argument injection
if [[ ! "${TARGET_TAG}" =~ ^[A-Za-z0-9._-]+$ ]]; then
  err "Refusing invalid release tag name: '${TARGET_TAG}'"
  write_job_status "failed" "" "Refused invalid release tag name."
  exit 1
fi

log "Current version: ${CURRENT_VERSION} (image tag: ${PREV_IMAGE_TAG}) | Target release: ${TARGET_TAG}"

if [[ "${CHECK_ONLY}" -eq 1 ]]; then
  if [[ "${CURRENT_VERSION}" == "${TARGET_TAG}" ]]; then
    log "Status: up to date."
  else
    log "Status: update available (${CURRENT_VERSION} -> ${TARGET_TAG})."
  fi
  exit 0
fi

if [[ "${CURRENT_VERSION}" == "${TARGET_TAG}" && "${FORCE_UPDATE}" -eq 0 ]]; then
  log "Already up to date (${CURRENT_VERSION}). Use --force to re-pull and restart."
  exit 0
fi

write_job_status "updating" "${TARGET_TAG}" "Backing up database and pulling GHCR images for ${TARGET_TAG}..."

# ---------------------------------------------------------------------------
# 3. Optional GHCR login (for private GitHub Packages)
# ---------------------------------------------------------------------------
if [[ -n "${GITHUB_TOKEN}" ]]; then
  log "Logging in to ghcr.io..."
  printf '%s' "${GITHUB_TOKEN}" | docker login ghcr.io -u "${GITHUB_ACTOR:-x-access-token}" --password-stdin >/dev/null
fi

# ---------------------------------------------------------------------------
# 4. Backup Docker PostgreSQL database (retaining last 10 .sql.gz backups)
# ---------------------------------------------------------------------------
backup_postgres() {
  local backup_dir="${PRINT_WEB_DIR}/backups"
  mkdir -p "${backup_dir}"

  local pg_user pg_db safe_ver ts backup_file
  pg_user="$(read_env_var "${ENV_FILE}" "POSTGRES_USER")"
  pg_db="$(read_env_var "${ENV_FILE}" "POSTGRES_DB")"
  pg_user="${pg_user:-printweb}"
  pg_db="${pg_db:-printweb}"
  safe_ver="$(printf '%s' "${CURRENT_VERSION}" | tr -cs 'A-Za-z0-9._-' '_')"
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_file="${backup_dir}/printweb-${safe_ver}-${ts}.sql.gz"

  if (cd "${PRINT_WEB_DIR}" && docker compose ps --status running --services 2>/dev/null | grep -qx "postgres"); then
    log "Creating compressed PostgreSQL backup: ${backup_file}"
    if ! (cd "${PRINT_WEB_DIR}" && docker compose exec -T postgres pg_dump -U "${pg_user}" "${pg_db}" | gzip -9 > "${backup_file}"); then
      warn "PostgreSQL backup failed; removing partial file and continuing."
      rm -f "${backup_file}"
    fi

    mapfile -t backups < <(ls -1t "${backup_dir}"/printweb-*.sql.gz 2>/dev/null || true)
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
# 5. Version state, GHCR pull, restart & health check helpers
# ---------------------------------------------------------------------------
write_release_state() {
  local ver="$1"
  local img_tag="$2"
  printf '%s\n' "${ver}" > "${VERSION_FILE}"
  set_env_var "${ENV_FILE}" "APP_VERSION" "${ver}"
  set_env_var "${ENV_FILE}" "PRINT_WEB_IMAGE_TAG" "${img_tag}"
  export APP_VERSION="${ver}"
  export PRINT_WEB_IMAGE_TAG="${img_tag}"
}

start_stack_no_build() {
  log "Starting Print-Web Docker Compose stack (pre-built GHCR images, --no-build)..."
  (cd "${PRINT_WEB_DIR}" && docker compose up -d --no-build --remove-orphans)
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

rollback_state_only() {
  local reason="$1"
  err "${reason} Rolling back git ref and .env to ${CURRENT_VERSION} (image tag: ${PREV_IMAGE_TAG})..."
  set +e
  git -C "${PRINT_WEB_DIR}" checkout --force "${PREV_REF}"
  chmod +x "${PRINT_WEB_DIR}/deploy/install-debian.sh" "${PRINT_WEB_DIR}/deploy/update-from-release.sh" 2>/dev/null || true
  write_release_state "${CURRENT_VERSION}" "${PREV_IMAGE_TAG}"
  write_job_status "failed" "${TARGET_TAG}" "${reason} Rolled back to ${CURRENT_VERSION}."
  exit 1
}

rollback_full() {
  local reason="$1"
  err "${reason} Rolling back to ${CURRENT_VERSION} (image tag: ${PREV_IMAGE_TAG})..."
  set +e
  git -C "${PRINT_WEB_DIR}" checkout --force "${PREV_REF}"
  chmod +x "${PRINT_WEB_DIR}/deploy/install-debian.sh" "${PRINT_WEB_DIR}/deploy/update-from-release.sh" 2>/dev/null || true
  write_release_state "${CURRENT_VERSION}" "${PREV_IMAGE_TAG}"
  start_stack_no_build
  if wait_for_health; then
    warn "Rollback to ${CURRENT_VERSION} succeeded and Docker stack is healthy."
    write_job_status "failed" "${TARGET_TAG}" "${reason} Rolled back cleanly to ${CURRENT_VERSION}."
  else
    err "Rollback completed, but health check is still failing. Check 'docker compose logs' immediately!"
    write_job_status "failed" "${TARGET_TAG}" "${reason} Rollback attempted; check container logs."
  fi
  exit 1
}

# ---------------------------------------------------------------------------
# 6. Checkout release compose/deploy files, pull GHCR images & restart
# ---------------------------------------------------------------------------
log "Fetching tags..."
if ! git -C "${PRINT_WEB_DIR}" fetch --tags --force origin; then
  rollback_state_only "Failed to fetch git tags from origin."
fi

resolve_git_tag() {
  local cand="$1"
  if git -C "${PRINT_WEB_DIR}" rev-parse --verify --quiet "refs/tags/${cand}" >/dev/null; then
    echo "${cand}"
    return 0
  fi
  if [[ "${cand}" != v* ]] && git -C "${PRINT_WEB_DIR}" rev-parse --verify --quiet "refs/tags/v${cand}" >/dev/null; then
    echo "v${cand}"
    return 0
  fi
  if [[ "${cand}" == v* ]] && git -C "${PRINT_WEB_DIR}" rev-parse --verify --quiet "refs/tags/${cand#v}" >/dev/null; then
    echo "${cand#v}"
    return 0
  fi
  return 1
}

if RESOLVED_GIT_TAG="$(resolve_git_tag "${TARGET_TAG}")"; then
  TARGET_TAG="${RESOLVED_GIT_TAG}"
else
  rollback_state_only "Release tag ${TARGET_TAG} not found in git repository."
fi

if [[ "${PRINT_WEB_VERIFY_SIGNATURES}" == "true" ]]; then
  log "Verifying GPG signature on tag ${TARGET_TAG}..."
  if ! git -C "${PRINT_WEB_DIR}" verify-tag "${TARGET_TAG}"; then
    rollback_state_only "GPG signature verification failed for tag ${TARGET_TAG}."
  fi
fi

log "Checking out ${TARGET_TAG} for updated docker-compose.yml and deploy scripts..."
if ! git -C "${PRINT_WEB_DIR}" checkout --force "tags/${TARGET_TAG}"; then
  rollback_state_only "Release tag ${TARGET_TAG} not found in git repository."
fi
chmod +x "${PRINT_WEB_DIR}/deploy/install-debian.sh" "${PRINT_WEB_DIR}/deploy/update-from-release.sh" 2>/dev/null || true

TAG_NO_V="${TARGET_TAG#v}"
IMAGE_CANDIDATES=("${TARGET_TAG}")
if [[ "${TAG_NO_V}" != "${TARGET_TAG}" ]]; then
  IMAGE_CANDIDATES+=("${TAG_NO_V}")
fi
if [[ "v${TAG_NO_V}" != "${TARGET_TAG}" ]]; then
  IMAGE_CANDIDATES+=("v${TAG_NO_V}")
fi

PULLED_IMAGE_TAG=""
for img_cand in "${IMAGE_CANDIDATES[@]}"; do
  write_release_state "${TARGET_TAG}" "${img_cand}"
  log "Pulling pre-built GHCR images for ${TARGET_TAG} (image tag: ${img_cand})..."
  if (cd "${PRINT_WEB_DIR}" && docker compose pull backend frontend); then
    PULLED_IMAGE_TAG="${img_cand}"
    break
  fi
done

if [[ -z "${PULLED_IMAGE_TAG}" ]]; then
  rollback_state_only "GHCR image pull failed for ${TARGET_TAG} (package may still be publishing)."
fi

if ! start_stack_no_build; then
  rollback_full "Failed to start Docker containers for ${TARGET_TAG}."
fi

if ! wait_for_health; then
  rollback_full "Health check failed after starting ${TARGET_TAG}."
fi

write_job_status "succeeded" "${TARGET_TAG}" "Updated Print-Web from ${CURRENT_VERSION} to ${TARGET_TAG}."
log "Successfully updated Print-Web from ${CURRENT_VERSION} to ${TARGET_TAG} using GHCR images."
