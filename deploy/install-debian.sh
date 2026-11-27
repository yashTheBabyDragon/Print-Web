#!/usr/bin/env bash
# Print-Web — Automated Debian 11/12/13 & Ubuntu Docker Installer
# Always deploys Print-Web using Docker Compose (postgres, backend, and frontend containers).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/yashTheBabyDragon/Print-Web/main/deploy/install-debian.sh | sudo bash
#
# Optional environment overrides:
#   PRINT_WEB_DIR=/opt/print-web
#   PRINT_WEB_HTTP_PORT=80
#   PRINT_WEB_BACKEND_PORT=8000
#   PRINT_WEB_DOMAIN=_
#   PRINT_WEB_REPO=yashTheBabyDragon/Print-Web
#   PRINT_WEB_REF=latest
#   PRINT_WEB_LOCAL_BUILD=false
#   GITHUB_TOKEN=<optional-token-for-private-ghcr-or-github-api>
#   GITHUB_ACTOR=<optional-github-username-for-ghcr-login>

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration (overridable via environment variables)
# ---------------------------------------------------------------------------
PRINT_WEB_DIR="${PRINT_WEB_DIR:-/opt/print-web}"
PRINT_WEB_HTTP_PORT="${PRINT_WEB_HTTP_PORT:-80}"
PRINT_WEB_BACKEND_PORT="${PRINT_WEB_BACKEND_PORT:-8000}"
PRINT_WEB_DOMAIN="${PRINT_WEB_DOMAIN:-_}"
PRINT_WEB_REPO="${PRINT_WEB_REPO:-yashTheBabyDragon/Print-Web}"
PRINT_WEB_REF="${PRINT_WEB_REF:-latest}"
PRINT_WEB_LOCAL_BUILD="${PRINT_WEB_LOCAL_BUILD:-false}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
GITHUB_ACTOR="${GITHUB_ACTOR:-}"

ENV_FILE="${PRINT_WEB_DIR}/.env"
REPO_URL="https://github.com/${PRINT_WEB_REPO}.git"

log()  { printf '\033[1;34m[print-web-install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[print-web-install]\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31m[print-web-install]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. Pre-flight checks
# ---------------------------------------------------------------------------
if [[ "${EUID}" -ne 0 ]]; then
  err "This installer must be run as root (use sudo)."
fi

if ! command -v apt-get >/dev/null 2>&1; then
  err "apt-get not found. This installer targets Debian 11/12/13 and Ubuntu."
fi

log "Installing Print-Web (Docker Compose) into ${PRINT_WEB_DIR} (repo: ${PRINT_WEB_REPO}, ref: ${PRINT_WEB_REF})"

# ---------------------------------------------------------------------------
# 2. Host prerequisites & Docker Engine + Compose plugin
# ---------------------------------------------------------------------------
log "Installing minimal host prerequisites..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  git \
  curl \
  ca-certificates \
  gnupg \
  jq \
  openssl

install_docker_if_needed() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log "Docker ($(docker --version)) and Docker Compose ($(docker compose version --short)) are already installed."
  else
    log "Installing Docker Engine and Docker Compose plugin from official Docker repository..."
    # shellcheck disable=SC1091
    source /etc/os-release
    local distro_id="${ID:-debian}"
    local codename="${VERSION_CODENAME:-}"

    case "${distro_id}" in
      debian|ubuntu) ;;
      *)
        warn "Unrecognized distro ID '${distro_id}'; falling back to 'debian' Docker repository."
        distro_id="debian"
        ;;
    esac

    if [[ -z "${codename}" ]]; then
      err "Unable to determine OS codename from /etc/os-release."
    fi

    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL "https://download.docker.com/linux/${distro_id}/gpg" -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc

    local arch
    arch="$(dpkg --print-architecture)"
    cat > /etc/apt/sources.list.d/docker.list <<EOF
deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${distro_id} ${codename} stable
EOF

    apt-get update -y
    apt-get install -y --no-install-recommends \
      docker-ce \
      docker-ce-cli \
      containerd.io \
      docker-buildx-plugin \
      docker-compose-plugin
  fi

  systemctl enable --now docker
}

install_docker_if_needed

# ---------------------------------------------------------------------------
# 3. Clone or update repository & resolve release ref
# ---------------------------------------------------------------------------
if [[ -d "${PRINT_WEB_DIR}/.git" ]]; then
  log "Existing repository found at ${PRINT_WEB_DIR}; fetching latest refs..."
  git -C "${PRINT_WEB_DIR}" remote set-url origin "${REPO_URL}"
  git -C "${PRINT_WEB_DIR}" fetch --tags --force origin
else
  log "Cloning ${REPO_URL} into ${PRINT_WEB_DIR}..."
  mkdir -p "$(dirname "${PRINT_WEB_DIR}")"
  git clone "${REPO_URL}" "${PRINT_WEB_DIR}"
  git -C "${PRINT_WEB_DIR}" fetch --tags --force origin
fi

resolve_target_ref() {
  if [[ "${PRINT_WEB_REF}" != "latest" ]]; then
    echo "${PRINT_WEB_REF}"
    return 0
  fi

  local api_url="https://api.github.com/repos/${PRINT_WEB_REPO}/releases/latest"
  local curl_args=(-fsSL -H "Accept: application/vnd.github+json" -H "User-Agent: print-web-installer")
  if [[ -n "${GITHUB_TOKEN}" ]]; then
    curl_args+=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
  fi

  local tag=""
  if response="$(curl "${curl_args[@]}" "${api_url}" 2>/dev/null)"; then
    tag="$(printf '%s' "${response}" | jq -r '.tag_name // empty')"
  fi

  if [[ -n "${tag}" ]]; then
    echo "${tag}"
    return 0
  fi

  # Fallback: latest remote semver tag if no GitHub Release is published yet
  local git_tag
  git_tag="$(git -C "${PRINT_WEB_DIR}" tag -l 'v*' --sort=-v:refname | head -n 1 || true)"
  if [[ -n "${git_tag}" ]]; then
    echo "${git_tag}"
    return 0
  fi

  echo "main"
}

TARGET_REF="$(resolve_target_ref)"
log "Checking out target ref: ${TARGET_REF}"
if git -C "${PRINT_WEB_DIR}" rev-parse --verify --quiet "refs/tags/${TARGET_REF}" >/dev/null; then
  git -C "${PRINT_WEB_DIR}" checkout --force "tags/${TARGET_REF}"
elif git -C "${PRINT_WEB_DIR}" rev-parse --verify --quiet "origin/${TARGET_REF}" >/dev/null; then
  git -C "${PRINT_WEB_DIR}" checkout --force -B "${TARGET_REF}" "origin/${TARGET_REF}"
else
  git -C "${PRINT_WEB_DIR}" checkout --force "${TARGET_REF}"
fi

printf '%s\n' "${TARGET_REF}" > "${PRINT_WEB_DIR}/.print-web-version"

# ---------------------------------------------------------------------------
# 4. Generate persistent Docker Compose .env file (never overwrite existing)
# ---------------------------------------------------------------------------
set_env_var() {
  local file="$1"
  local key="$2"
  local val="$3"
  if grep -qE "^${key}=" "${file}" 2>/dev/null; then
    sed -i -E "s|^${key}=.*|${key}=${val}|" "${file}"
  else
    printf '%s=%s\n' "${key}" "${val}" >> "${file}"
  fi
}

SELECTED_IMAGE_TAG="${TARGET_REF}"
if [[ "${SELECTED_IMAGE_TAG}" == "main" ]]; then
  SELECTED_IMAGE_TAG="latest"
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  log "Generating initial ${ENV_FILE} with strong random secrets..."
  JWT_SECRET="$(openssl rand -hex 32)"
  POSTGRES_PASSWORD="$(openssl rand -hex 24)"

  if [[ "${PRINT_WEB_DOMAIN}" != "_" ]]; then
    CORS_ORIGINS="[\"https://${PRINT_WEB_DOMAIN}\",\"http://${PRINT_WEB_DOMAIN}\"]"
  else
    CORS_ORIGINS="[\"http://localhost\",\"http://127.0.0.1\"]"
  fi

  cat > "${ENV_FILE}" <<EOF
# Print-Web Production Configuration (Docker Compose + GHCR)
# Generated by install-debian.sh — never overwritten on reinstall/update.

POSTGRES_DB=printweb
POSTGRES_USER=printweb
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}

JWT_SECRET=${JWT_SECRET}
JWT_EXPIRE_MINUTES=10080

# Set DEV_SEED=true only for initial demo/testing, then change admin password and set false.
DEV_SEED=false
INSTITUTION=3D Print Lab

POLL_INTERVAL_SECONDS=15
CORS_ORIGINS=${CORS_ORIGINS}

FRONTEND_PORT=${PRINT_WEB_HTTP_PORT}
BACKEND_PORT=${PRINT_WEB_BACKEND_PORT}

# Pre-built GitHub Container Registry (GHCR) image settings
PRINT_WEB_IMAGE_TAG=${SELECTED_IMAGE_TAG}
PRINT_WEB_UPDATER_DIR=${PRINT_WEB_DIR}/updater
APP_VERSION=${TARGET_REF}
GITHUB_REPO=${PRINT_WEB_REPO}
# Optional GitHub token for private GHCR packages or higher GitHub API rate limits:
# GITHUB_TOKEN=
# GITHUB_ACTOR=
EOF
  chmod 600 "${ENV_FILE}"
else
  log "Preserving existing ${ENV_FILE} (updating APP_VERSION, PRINT_WEB_IMAGE_TAG, and PRINT_WEB_UPDATER_DIR)."
  set_env_var "${ENV_FILE}" "APP_VERSION" "${TARGET_REF}"
  set_env_var "${ENV_FILE}" "PRINT_WEB_IMAGE_TAG" "${SELECTED_IMAGE_TAG}"
  set_env_var "${ENV_FILE}" "PRINT_WEB_UPDATER_DIR" "${PRINT_WEB_DIR}/updater"
fi

# Read BACKEND_PORT and FRONTEND_PORT from .env if customized on an existing install
ENV_BACKEND_PORT="$(grep -E '^BACKEND_PORT=' "${ENV_FILE}" | tail -n 1 | cut -d= -f2- | tr -d '"\r' || true)"
ENV_FRONTEND_PORT="$(grep -E '^FRONTEND_PORT=' "${ENV_FILE}" | tail -n 1 | cut -d= -f2- | tr -d '"\r' || true)"
PRINT_WEB_BACKEND_PORT="${ENV_BACKEND_PORT:-${PRINT_WEB_BACKEND_PORT}}"
PRINT_WEB_HTTP_PORT="${ENV_FRONTEND_PORT:-${PRINT_WEB_HTTP_PORT}}"

mkdir -p "${PRINT_WEB_DIR}/backups" "${PRINT_WEB_DIR}/updater"
# Allow both root (systemd updater) and the non-root backend container user to read/replace request.json & status.json
chmod 0777 "${PRINT_WEB_DIR}/updater"
chmod +x "${PRINT_WEB_DIR}/deploy/install-debian.sh" "${PRINT_WEB_DIR}/deploy/update-from-release.sh"

# ---------------------------------------------------------------------------
# 5. Pull pre-built GHCR images and start Docker Compose stack
# ---------------------------------------------------------------------------
if [[ -n "${GITHUB_TOKEN}" ]]; then
  log "Logging in to ghcr.io..."
  printf '%s' "${GITHUB_TOKEN}" | docker login ghcr.io -u "${GITHUB_ACTOR:-x-access-token}" --password-stdin >/dev/null
fi

if [[ "${PRINT_WEB_LOCAL_BUILD}" == "true" ]]; then
  log "PRINT_WEB_LOCAL_BUILD=true: building and starting Print-Web Docker containers locally..."
  (
    cd "${PRINT_WEB_DIR}"
    docker compose up -d --build --remove-orphans
  )
else
  log "Pulling pre-built GHCR Docker images (tag: ${SELECTED_IMAGE_TAG})..."
  if ! (cd "${PRINT_WEB_DIR}" && docker compose pull); then
    if [[ "${SELECTED_IMAGE_TAG}" == v* ]]; then
      SELECTED_IMAGE_TAG="${SELECTED_IMAGE_TAG#v}"
      log "Retrying GHCR pull with semver tag: ${SELECTED_IMAGE_TAG}..."
      set_env_var "${ENV_FILE}" "PRINT_WEB_IMAGE_TAG" "${SELECTED_IMAGE_TAG}"
      (cd "${PRINT_WEB_DIR}" && docker compose pull)
    else
      exit 1
    fi
  fi
  (
    cd "${PRINT_WEB_DIR}"
    docker compose up -d --no-build --remove-orphans
  )
fi

# ---------------------------------------------------------------------------
# 6. Install on-demand systemd .path updater (manual UI/CLI trigger only)
# ---------------------------------------------------------------------------
log "Installing on-demand updater systemd units (no scheduled auto-updates)..."
# Disable/remove legacy timer if upgrading from an older install
systemctl disable --now print-web-update.timer 2>/dev/null || true
rm -f /etc/systemd/system/print-web-update.timer

sed \
  -e "s|/opt/print-web|${PRINT_WEB_DIR}|g" \
  "${PRINT_WEB_DIR}/deploy/print-web-update.service" > /etc/systemd/system/print-web-update.service

sed \
  -e "s|/opt/print-web|${PRINT_WEB_DIR}|g" \
  "${PRINT_WEB_DIR}/deploy/print-web-update.path" > /etc/systemd/system/print-web-update.path

systemctl daemon-reload
systemctl enable --now print-web-update.path

# ---------------------------------------------------------------------------
# 7. Verify backend health
# ---------------------------------------------------------------------------
HEALTH_URL="http://127.0.0.1:${PRINT_WEB_BACKEND_PORT}/api/health"
log "Verifying backend health at ${HEALTH_URL}..."
healthy=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 3 "${HEALTH_URL}" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 2
done

if [[ "${healthy}" -ne 1 ]]; then
  warn "Health check failed! Recent container logs:"
  (cd "${PRINT_WEB_DIR}" && docker compose logs --tail=60 backend postgres) >&2 || true
  err "Print-Web backend did not become healthy at ${HEALTH_URL}."
fi

HEALTH_JSON="$(curl -fsS "${HEALTH_URL}")"
log "Health check passed: ${HEALTH_JSON}"

# ---------------------------------------------------------------------------
# 8. Post-install summary
# ---------------------------------------------------------------------------
DISPLAY_HOST="${PRINT_WEB_DOMAIN}"
if [[ "${DISPLAY_HOST}" == "_" ]]; then
  DISPLAY_HOST="$(hostname -I 2>/dev/null | awk '{print $1}')"
  DISPLAY_HOST="${DISPLAY_HOST:-localhost}"
fi

PORT_SUFFIX=""
if [[ "${PRINT_WEB_HTTP_PORT}" != "80" ]]; then
  PORT_SUFFIX=":${PRINT_WEB_HTTP_PORT}"
fi

cat <<EOF

===========================================================================
  Print-Web (Docker) installed successfully!
===========================================================================
  URL:              http://${DISPLAY_HOST}${PORT_SUFFIX}
  Version:          ${TARGET_REF}
  Install dir:      ${PRINT_WEB_DIR}
  Config file:      ${ENV_FILE}
  Containers:       cd ${PRINT_WEB_DIR} && docker compose ps
  On-demand update: Admin UI (updates:manage) or CLI — print-web-update.path active

  Initial Admin Setup:
  - By default DEV_SEED=false in ${ENV_FILE}.
  - To bootstrap demo/initial accounts on a fresh database, temporarily set
    DEV_SEED=true in ${ENV_FILE}, run:
      cd ${PRINT_WEB_DIR} && docker compose up -d backend
    log in as Admin (DA: 0000001 / Password: admin123), change the password
    immediately, then set DEV_SEED=false and restart backend.

  Manual Update & Dry-Run Check:
    sudo ${PRINT_WEB_DIR}/deploy/update-from-release.sh --check
    sudo ${PRINT_WEB_DIR}/deploy/update-from-release.sh

  View Container Logs:
    cd ${PRINT_WEB_DIR} && docker compose logs -f
===========================================================================
EOF
