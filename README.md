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
- **Docker-First Deployment & GitHub Release Auto-Updates**: Production runs entirely in Docker Compose (PostgreSQL 16 + FastAPI + Nginx) with a one-line Debian/Ubuntu Docker bootstrapper, Admin UI release status card, and daily `systemd` auto-update timer with PostgreSQL backups and health-checked rollback.

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
│   ├── install-debian.sh        # Automated installer (Docker Engine + Compose, .env, stack startup, timer)
│   ├── update-from-release.sh   # GitHub Release Docker updater with PostgreSQL backup & auto-rollback
│   ├── ggprint-update.service   # Oneshot systemd unit for Docker Compose release updates
│   ├── ggprint-update.timer     # Daily 03:30 (+15m jitter) auto-update timer
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
  | sudo GGPRINT_DOMAIN=ggprint.example.edu GGPRINT_HTTP_PORT=80 GGPRINT_AUTO_UPDATE=true bash
```

#### What `install-debian.sh` does step-by-step
1. Installs minimal host prerequisites (`git`, `curl`, `ca-certificates`, `gnupg`, `jq`, `openssl`).
2. Installs **Docker Engine** and the **Docker Compose plugin** from Docker's official repository (skipped if already installed) and enables `docker.service`.
3. Clones `yashTheBabyDragon/GGPrint-Web` into `/opt/ggprint` and checks out the latest GitHub Release tag (or `main` if no release exists yet), recording `.ggprint-version`.
4. Generates `/opt/ggprint/.env` (`chmod 600`) with random `JWT_SECRET` and `POSTGRES_PASSWORD` (**never overwrites** an existing `.env`).
5. Builds and starts the Docker Compose stack (`docker compose up -d --build`).
6. Installs and enables `ggprint-update.timer` to run daily Docker updates.
7. Verifies `http://127.0.0.1:8000/api/health` and prints post-install instructions.

### Option B: Manual Docker Compose Setup (Any Docker Host)
```bash
git clone https://github.com/yashTheBabyDragon/GGPrint-Web.git
cd GGPrint-Web
cp deploy/.env.production.example .env
# Edit .env: set strong POSTGRES_PASSWORD and JWT_SECRET, plus CORS_ORIGINS
chmod 600 .env
docker compose up -d --build
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

## 3. Automatic Updates from GitHub Releases

GGPrint checks for new releases in two ways:
1. **Admin UI visibility**: **Admin → Settings → Software Version & GitHub Releases** shows the running version, latest GitHub Release tag, release notes link, and a manual **Check for updates** button.
2. **Automated Docker updater (`ggprint-update.timer`)**: Runs `/opt/ggprint/deploy/update-from-release.sh` daily at `03:30` (with up to 15 minutes random jitter and `Persistent=true`).

### Manual Update Commands
```bash
# Dry-run: check current vs latest GitHub Release without changing anything
sudo /opt/ggprint/deploy/update-from-release.sh --check

# Apply latest release (backs up PostgreSQL, rebuilds & restarts Docker stack)
sudo /opt/ggprint/deploy/update-from-release.sh

# Force rebuild/restart even if already on the latest tag
sudo /opt/ggprint/deploy/update-from-release.sh --force
```

### Backups & Automatic Rollback
Before applying any update, `update-from-release.sh`:
1. Records the previous git commit and `.ggprint-version`.
2. Creates a compressed PostgreSQL dump (`pg_dump`) in `/opt/ggprint/backups/ggprint-<old-version>-<timestamp>.sql.gz` (retaining the last 10 backups).
3. Checks out the new release tag, updates `.ggprint-version` and `APP_VERSION` in `.env`, runs `docker compose up -d --build --remove-orphans`, and polls `http://127.0.0.1:8000/api/health` for up to 60 seconds.
4. **If any build step or health check fails**, it automatically checks out the previous ref, restores `.ggprint-version` / `APP_VERSION`, rebuilds and restarts the previous Docker stack, logs the rollback, and exits non-zero.

### Publishing a New Release
Pushing a semantic version tag (`v*`) triggers `.github/workflows/release.yml`, which runs the full test suite and publishes a GitHub Release with auto-generated release notes:
```bash
git tag v1.1.0
git push origin v1.1.0
```
Every Docker host with `ggprint-update.timer` enabled will pick up `v1.1.0` automatically on its next scheduled check (or immediately when triggered manually).

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
| `APP_VERSION` | *(auto-detected)* | Installed version tag (kept in sync by installer/updater) |
| `GITHUB_REPO` | `yashTheBabyDragon/GGPrint-Web` | GitHub `owner/repo` queried for release updates |
| `GITHUB_TOKEN` | *(empty)* | Optional GitHub token to raise API rate limits or access private repos |

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
- **Inspect auto-update timer & logs**:
  ```bash
  systemctl list-timers ggprint-update.timer
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
