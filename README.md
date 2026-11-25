# GGPrint — 3D Printing & Slicing Portal (Cégep Gérald-Godin)

**GGPrint** is a self-service 3D printing portal built for **Cégep Gérald-Godin** (FR/EN bilingual UI). Students upload `.stl` models, position and auto-orient them on an interactive 3D build plate without complex slicer menus, stay within their active filament budget, and submit jobs directly to a Klipper/PrusaLink printer fleet managed by **FDM Monster**.

---

## Key Features

- **Student 3D Studio & Mobile-Friendly UI**: Interactive Three.js build plate with automatic flat-face orientation, drag/rotate/scale controls, live bounding-box fit checks, and a simplified mobile layout for phones and tablets.
- **Draft Lifecycle**: Uploaded and sliced models persist as drafts so students can iterate, compare estimates, or resume later before submitting to a printer.
- **Filament Budget & Manual Max-Gram Refresh**: Active filament budget tracking (default 100 g) with automatic refunds on completion/cancellation, oversized-part approval requests, and one-click manual max-gram refresh.
- **Teacher Portal & Master-Detail Class Manager**: Dedicated teacher workspace for managing classes/cohorts, student DA whitelists, per-student filament limits, and class print queues.
- **RBAC Presets & Manual Permissions**: Role-based access control (Student, Teacher, Admin) with preset permission bundles and fine-grained per-user permission overrides.
- **OrcaSlicer & PrusaSlicer `.ini` Selective Import**: Upload OrcaSlicer `.json` profiles or selectively import printer/filament/process profiles from PrusaSlicer `.ini` bundles, then bind them to printers and MMU slots.
- **FDM Monster & Filament API**: Live printer & MMU slot synchronization, queue dispatch, and filament inventory management via FDM Monster.
- **Docker-First Deployment & On-Demand GitHub Release Updates**: Production runs entirely in Docker Compose (PostgreSQL 16 + FastAPI + Nginx) pulling pre-built GHCR images. Updates are strictly **manual / on-demand** — Admins (or users granted `updates:manage`) view the installed version vs. latest GitHub Release and choose when to update via the Admin UI (`ggprint-update.path`) or CLI, with PostgreSQL backups and health-checked rollback.

---

## Repository Layout

```text
.
├── backend/                     # FastAPI + SQLAlchemy + trimesh + OrcaSlicer/FDM Monster adapters
│   ├── Dockerfile               # Python 3.13 slim + xvfb + OrcaSlicer headless wrapper + HEALTHCHECK
│   └── pyproject.toml
├── frontend/                    # React 18 + Vite + TypeScript + Tailwind CSS + Three.js
│   └── Dockerfile               # Multi-stage Node 22 build -> Nginx SPA + /api proxy + HEALTHCHECK
├── deploy/                      # Debian 11/12/13 & Ubuntu Docker Compose deployment kit
│   ├── install-debian.sh        # Automated installer (Docker Engine + Compose, .env, GHCR pull, .path)
│   ├── update-from-release.sh   # On-demand GHCR release updater with PostgreSQL backup & rollback
│   ├── ggprint-update.service   # Oneshot systemd unit for on-demand Docker Compose release updates
│   ├── ggprint-update.path      # Path unit watching /opt/ggprint/updater/request.json (no schedule)
│   └── .env.production.example  # Documented Docker Compose production environment template
├── .github/workflows/
│   ├── ci.yml                   # Backend pytest, frontend test/build, Docker image builds
│   └── release.yml              # Verified automatic GitHub Releases on v* tags
├── sample-models/               # Binary STL fixtures (tilted-bracket.stl, oversized-housing.stl)
├── docker-compose.yml           # PostgreSQL 16 + FastAPI backend + Nginx frontend
├── start-dev.bat                # Windows local dev launcher (cmd.exe / Restricted PS safe)
└── start-dev.ps1                # PowerShell local dev launcher
```

---

## 1. Quick Local Development

### Windows
**Prerequisites:** Python 3.13+ and Node.js 20+ LTS.

Double-click **`start-dev.bat`** or run from Command Prompt:
```bat
start-dev.bat
```
Or from PowerShell:
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-dev.ps1
```
This automatically creates `backend\.venv`, installs dependencies, starts FastAPI (`DEV_SEED=true`) on `http://127.0.0.1:8000` and Vite on `http://localhost:5173`, and opens your browser.

### Linux / macOS
```bash
# Terminal 1 — Backend
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
DEV_SEED=true uvicorn app.main:app --reload --host 127.0.0.1 --port 8000

# Terminal 2 — Frontend
cd frontend
npm ci
npm run dev
```
Open **`http://localhost:5173`**.

---

## 2. Production Deployment (Docker Compose)

GGPrint always deploys in production using **Docker Compose** (`postgres`, `backend`, `frontend`).

### Option A: One-Line Debian / Ubuntu Installer (Recommended)
Run on a fresh Debian 11, 12, 13, or Ubuntu 22.04/24.04 server (VM, Proxmox LXC/VM, or bare metal):

```bash
curl -fsSL https://raw.githubusercontent.com/yashTheBabyDragon/GGPrint-Web/main/deploy/install-debian.sh | sudo bash
```

You can customize the install with environment variables:
```bash
curl -fsSL https://raw.githubusercontent.com/yashTheBabyDragon/GGPrint-Web/main/deploy/install-debian.sh \
  | sudo GGPRINT_DOMAIN=ggprint.example.edu GGPRINT_HTTP_PORT=80 bash
```

#### What `install-debian.sh` does step-by-step
1. Installs minimal host prerequisites (`git`, `curl`, `ca-certificates`, `gnupg`, `jq`, `openssl`).
2. Installs **Docker Engine** and the **Docker Compose plugin** from Docker's official repository (skipped if already installed) and enables `docker.service`.
3. Clones `yashTheBabyDragon/GGPrint-Web` into `/opt/ggprint` and checks out the latest GitHub Release tag (or `main` if no release exists yet), recording `.ggprint-version`.
4. Generates `/opt/ggprint/.env` (`chmod 600`) with random `JWT_SECRET`, `POSTGRES_PASSWORD`, `APP_VERSION`, `GGPRINT_IMAGE_TAG`, and `GGPRINT_UPDATER_DIR=/opt/ggprint/updater` (**never overwrites** an existing `.env`).
5. Pulls the pre-built container images from **GitHub Container Registry (GHCR)** (`docker compose pull`) and starts the stack without building locally (`docker compose up -d --no-build --remove-orphans`). *(Pass `GGPRINT_LOCAL_BUILD=true` only if you explicitly want to build images on the host.)*
6. Installs and enables `ggprint-update.path` + `ggprint-update.service` for **on-demand** updates triggered from the Admin UI (no scheduled auto-update timer is installed).
7. Verifies `http://127.0.0.1:8000/api/health` and prints post-install instructions.

### Option B: Manual Docker Compose Setup (Any Docker Host)
```bash
git clone https://github.com/yashTheBabyDragon/GGPrint-Web.git
cd GGPrint-Web
cp deploy/.env.production.example .env
# Edit .env: set strong POSTGRES_PASSWORD and JWT_SECRET, plus CORS_ORIGINS
chmod 600 .env
docker compose pull
docker compose up -d --no-build
```

Services started (all with `restart: unless-stopped`, `no-new-privileges:true`, and `HEALTHCHECK`):
- **`postgres`**: PostgreSQL 16 (`ggprint_pgdata` volume)
- **`backend`**: FastAPI on `127.0.0.1:8000` with persistent volumes `ggprint_data` (`/data`) and `ggprint_profiles` (`/profiles`)
- **`frontend`**: Nginx serving the Vite bundle on port `80` (`FRONTEND_PORT`) and proxying `/api/*` → `backend:8000` (`client_max_body_size 100M`)

#### Optional: Headless OrcaSlicer CLI on Linux / Proxmox Host
Extract the Linux OrcaSlicer AppImage once on the host:
```bash
wget https://github.com/SoftFever/OrcaSlicer/releases/download/<VERSION>/OrcaSlicer_Linux_V<VERSION>.AppImage
chmod +x OrcaSlicer_Linux_V*.AppImage
./OrcaSlicer_Linux_V*.AppImage --appimage-extract
sudo mv squashfs-root /opt/orcaslicer
```
Uncomment `- /opt/orcaslicer:/opt/orcaslicer:ro` in `docker-compose.yml` and recreate the backend (`docker compose up -d backend`). Then in **Admin → Settings**, set `slicer_mode=orcaslicer` and `orca_cli_path=/usr/local/bin/orca-slicer-headless`.

#### HTTPS Reverse Proxy
If exposing GGPrint over HTTPS, place a reverse proxy (Caddy, Nginx Proxy Manager, Traefik, or Cloudflare Tunnel) in front of `FRONTEND_PORT` (for example set `FRONTEND_PORT=8080` in `.env` and proxy `https://ggprint.example.edu` → `http://127.0.0.1:8080`). Update `CORS_ORIGINS` in `.env` to include `https://ggprint.example.edu` and run `docker compose up -d backend`.

---

## 3. On-Demand Updates from GitHub Releases (Manual Only)

GGPrint **never performs unattended scheduled auto-updates**. Updates are strictly **manual and permission-gated**:
1. **Admin UI (recommended)**: Admins — or staff granted the **`updates:manage`** permission — open **Admin → Settings** (or the **Updates** tab) to see the currently installed version, the latest GitHub Release, release notes, and an **Update to vX.Y.Z** button. Clicking **Update** writes a validated trigger file to `/updater/request.json` (zero Docker socket exposure inside the container), which wakes the host `ggprint-update.path` systemd unit to run the upgrade and report live status (`queued` → `updating` → `succeeded` / `failed`).
2. **CLI**: Server operators can also trigger or dry-run updates directly over SSH.

### Manual CLI Update Commands
```bash
# Dry-run: check current vs latest GitHub Release without changing anything
sudo /opt/ggprint/deploy/update-from-release.sh --check

# Apply latest release (backs up PostgreSQL, pulls GHCR images & restarts stack)
sudo /opt/ggprint/deploy/update-from-release.sh

# Apply a specific release tag
sudo /opt/ggprint/deploy/update-from-release.sh v1.2.0

# Force re-pull & restart even if already on the latest tag
sudo /opt/ggprint/deploy/update-from-release.sh --force
```

### Backups & Automatic Rollback (GHCR Pre-Built Images)
Before applying any update, `update-from-release.sh`:
1. Records the previous git commit, `.ggprint-version`, and `GGPRINT_IMAGE_TAG`.
2. Creates a compressed PostgreSQL dump (`pg_dump`) in `/opt/ggprint/backups/ggprint-<old-version>-<timestamp>.sql.gz` (retaining the last 10 backups).
3. Checks out the requested release tag, updates `.ggprint-version`, `APP_VERSION`, and `GGPRINT_IMAGE_TAG` in `.env`, pulls the pre-built **GitHub Container Registry** images (`docker compose pull backend frontend` from `ghcr.io/yashthebabydragon/ggprint-web-backend` and `ghcr.io/yashthebabydragon/ggprint-web-frontend`), starts with `docker compose up -d --no-build --remove-orphans`, and polls `http://127.0.0.1:8000/api/health` for up to 60 seconds.
4. **If the GHCR pull or health check fails**, it automatically restores the previous git ref, `.ggprint-version`, `APP_VERSION`, and `GGPRINT_IMAGE_TAG`, restarts the previous containers (`--no-build`), writes the failure status to `updater/status.json`, and exits non-zero.

### End-to-End Release Pipeline (`release.yml` → `release-docker.yml` → On-Demand Update)
Pushing a semantic version tag (`v*`) triggers the automated release publishing pipeline:
```bash
git tag v1.1.0
git push origin v1.1.0
```
1. **`.github/workflows/release.yml`** runs the full backend/frontend test suite and publishes the GitHub Release `v1.1.0` with auto-generated release notes.
2. **`.github/workflows/release-docker.yml`** triggers on `release: [published]`, builds the `backend` and `frontend` Docker images, and pushes them to **GitHub Packages (GHCR)** tagged `v1.1.0`, `1.1.0`, `1.1`, `1`, and `latest`.
3. Admins (or users with `updates:manage`) see `v1.1.0` available in the UI and choose when to click **Update** (or run `update-from-release.sh` manually).

---

## 4. Environment Variables Reference

See [`deploy/.env.production.example`](deploy/.env.production.example) for a ready-to-copy Docker Compose template.

| Variable | Default | Description |
| --- | --- | --- |
| `POSTGRES_DB` | `ggprint` | PostgreSQL database name |
| `POSTGRES_USER` | `ggprint` | PostgreSQL user |
| `POSTGRES_PASSWORD` | *(required)* | **Required in production.** Strong password for PostgreSQL |
| `JWT_SECRET` | *(required)* | **Required in production.** 64-char random hex secret for signing JWT tokens |
| `JWT_EXPIRE_MINUTES` | `10080` | JWT token lifetime in minutes (default: 7 days) |
| `DEV_SEED` | `true` (dev) / `false` (prod) | Seeds demo accounts, printers, filaments, and profiles on startup |
| `INSTITUTION` | `Cégep Gérald-Godin` | Institution display name |
| `POLL_INTERVAL_SECONDS` | `15` | Background printer status polling interval |
| `CORS_ORIGINS` | `["http://localhost", ...]` | JSON array of allowed browser origins |
| `FRONTEND_PORT` | `80` | Host port mapped to the Nginx frontend container |
| `BACKEND_PORT` | `8000` | Loopback host port (`127.0.0.1`) mapped to the FastAPI backend container |
| `GGPRINT_IMAGE_TAG` | `latest` | GHCR container image tag pulled by Docker Compose (set to `vX.Y.Z` on releases) |
| `GGPRINT_UPDATER_DIR` | `./data/updater` (`/opt/ggprint/updater`) | Host directory bind-mounted to `/updater` for on-demand UI update triggers |
| `GGPRINT_BACKEND_IMAGE` | `ghcr.io/yashthebabydragon/ggprint-web-backend` | Backend container image repository |
| `GGPRINT_FRONTEND_IMAGE` | `ghcr.io/yashthebabydragon/ggprint-web-frontend` | Frontend container image repository |
| `APP_VERSION` | *(auto-detected)* | Installed version tag (kept in sync by installer/updater) |
| `GITHUB_REPO` | `yashTheBabyDragon/GGPrint-Web` | GitHub `owner/repo` queried for release updates |
| `GITHUB_TOKEN` | *(empty)* | Optional GitHub token for private GHCR packages or higher API rate limits |
| `GITHUB_ACTOR` | `x-access-token` | Optional GitHub username used with `GITHUB_TOKEN` for `docker login ghcr.io` |

---

## 5. Demo Accounts (When `DEV_SEED=true`)

| Role | DA (7 digits) | Password | Notes |
| --- | --- | --- | --- |
| **Admin** | `0000001` | `admin123` | Full admin dashboard & system settings |
| **Student** | `2345678` | `student123` | Pre-registered student account (100 g budget) |
| **Unclaimed DAs** | `2333572`, `2399001`, `2401234` | *(chosen on Register)* | Whitelisted DAs for testing self-registration |

> **Production note:** Keep `DEV_SEED=false` in production. On a brand-new server, you may temporarily set `DEV_SEED=true` in `.env` for the first boot, run `docker compose up -d backend`, log in as `0000001`, change the admin password immediately, remove unused demo accounts, then set `DEV_SEED=false` and recreate the backend container.

---

## 6. Testing Commands

```bash
# Backend unit & integration tests
cd backend
pytest -v

# Frontend unit tests
cd frontend
npm test

# Frontend TypeScript check & production build
cd frontend
npm run build

# Validate Debian Docker deployment shell scripts
bash -n deploy/install-debian.sh
bash -n deploy/update-from-release.sh
```

---

## 7. Troubleshooting

- **Check backend health**:
  ```bash
  curl -s http://127.0.0.1:8000/api/health | jq
  ```
  Returns `status`, `service`, `version`, `db_ok`, and `uptime_seconds` (HTTP `503` if DB check fails).
- **Inspect container status & logs**:
  ```bash
  cd /opt/ggprint
  docker compose ps
  docker compose logs -f --tail=100
  ```
- **Inspect on-demand updater path unit & logs**:
  ```bash
  systemctl status ggprint-update.path
  sudo journalctl -u ggprint-update.service -n 100 --no-pager
  ```
- **Restore a PostgreSQL backup manually**:
  ```bash
  cd /opt/ggprint
  docker compose stop backend
  gunzip -c /opt/ggprint/backups/ggprint-<version>-<ts>.sql.gz \
    | docker compose exec -T postgres psql -U ggprint -d ggprint
  docker compose start backend
  ```
- **Large STL upload returns `413 Request Entity Too Large`**:
  The `frontend` container already sets `client_max_body_size 100M;`. If you placed an external reverse proxy (Caddy/Nginx/Cloudflare) in front of Docker, ensure it also allows at least `100M` request bodies.
