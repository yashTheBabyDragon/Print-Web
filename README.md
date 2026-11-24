# GGPrint — Portail d'impression 3D / 3D Slicing Portal (Cégep Gérald-Godin)

**GGPrint** est un portail web libre-service d'impression 3D conçu pour le **Cégep Gérald-Godin**. Il permet aux étudiants de téléverser un fichier `.stl`, de le positionner sur le plateau en 3D sans exposer de paramètres complexes de tranchage, de valider automatiquement leur budget de filament actif (100 g par défaut) et d'envoyer leurs impressions vers une flotte d'imprimantes Klipper et PrusaLink gérée par **FDM Monster**.

**GGPrint** is a self-service 3D printing portal for **Cégep Gérald-Godin** featuring an interactive Three.js build plate, automatic flat-face orientation, active filament budget & duration enforcement, an admin approval workflow for oversized parts, OrcaSlicer CLI integration, and FDM Monster queue synchronization.

---

## Architecture & Repository Layout

```text
.
├── backend/                  # FastAPI + SQLAlchemy + trimesh + OrcaSlicer/FDM Monster adapters
│   ├── Dockerfile            # Python 3.13 slim + xvfb + OrcaSlicer headless wrapper
│   └── pyproject.toml
├── frontend/                 # React 18 + Vite + TypeScript + Tailwind + Three.js
│   └── Dockerfile            # Multi-stage Node build -> Nginx serving SPA + /api proxy
├── sample-models/            # Ready-to-test binary STL fixtures
│   ├── tilted-bracket.stl    # L-bracket tilted ~37° X / ~18° Y (~15-30g) for auto-orient demo
│   └── oversized-housing.stl # 110x110x60 mm hollow enclosure (>120g) for >100g approval demo
├── contracts/
│   └── api-contract.md       # Frozen v1 API specification
├── docker-compose.yml        # PostgreSQL 16 + FastAPI backend + Nginx frontend
├── start-dev.bat             # One-click Windows local dev launcher (cmd / Restricted PS safe)
└── start-dev.ps1             # PowerShell local dev launcher
```

---

## 1. Quick Start on Windows Laptop (Local Dev / Développement local)

### Prerequisites / Prérequis
- **Python 3.13+** (or [`uv`](https://docs.astral.sh/uv/))
- **Node.js LTS** (includes `npm`; default path `C:\Program Files\nodejs` is auto-detected)

### Launch / Démarrage
Double-click **`start-dev.bat`** (or run it from Command Prompt `cmd.exe`):
```bat
start-dev.bat
```
> **Note (Restricted PowerShell):** `start-dev.bat` runs directly in `cmd.exe` without invoking `.ps1` profile scripts, so it works even when Windows PowerShell ExecutionPolicy is `Restricted`.
>
> If you prefer PowerShell, run:
> ```powershell
> powershell -NoProfile -ExecutionPolicy Bypass -File .\start-dev.ps1
> ```

Both launchers automatically:
1. Create `backend\.venv` and install backend dependencies if missing.
2. Run `npm install` in `frontend\` if `node_modules` is missing.
3. Start FastAPI (`DEV_SEED=true`) on `http://127.0.0.1:8000` and Vite on `http://localhost:5173`.
4. Open **`http://localhost:5173`** in your default browser.

---

## 2. Demo Accounts & Testing Walkthrough / Comptes démo et scénario de test

When `DEV_SEED=true` (enabled by default in local dev), the database is seeded with demo accounts, 5 printers (2 Klipper + 3 PrusaLink with MMU slots), 5 filaments, and Orca profiles.

### Seeded Credentials / Identifiants préchargés
| Role / Rôle | DA (7 digits) | Password / Mot de passe | Notes |
| --- | --- | --- | --- |
| **Admin** | `0000001` | `admin123` | Full admin dashboard access |
| **Student** | `2345678` | `student123` | Pre-registered student account |
| **Unclaimed DA** | `2333572` | *(you choose on Register)* | Whitelisted for self-registration test |
| **Unclaimed DAs** | `2399001`, `2401234` | *(you choose on Register)* | Additional whitelisted DAs |

### End-to-End Local Test Plan / Scénario de validation
1. **Test Student Registration (DA `2333572`)**
   - Open `http://localhost:5173` -> click **Register / Créer un compte**.
   - Enter DA `2333572`, your name, and a password (>= 4 chars). Verify you are logged in with a **100.0 g** active filament budget.
   - *(Optional)* Try an un-whitelisted DA such as `9999999` to verify registration is blocked (`DA_NOT_WHITELISTED`).

2. **Test Auto-Orient & Within-Budget Submit (`tilted-bracket.stl`)**
   - In the **Slice Studio**, select **Sample Models** -> **`tilted-bracket.stl`** (or upload `sample-models/tilted-bracket.stl`).
   - Notice the raw STL is intentionally tilted (~37° around X, ~18° around Y); the backend auto-orient step levels its largest flat base onto `Z = 0` and centers it on the build plate.
   - Pick a printer and MMU filament slot, adjust XY position / rotation / scale if desired, and click **Slice / Trancher**.
   - Estimated weight is ~15–30 g (within your 100 g limit). Click **Submit to Print Queue / Envoyer à l'imprimante** and verify your active budget updates.

3. **Test >100 g Admin Approval Flow (`oversized-housing.stl`)**
   - Upload or load **`sample-models/oversized-housing.stl`** (110 × 110 × 60 mm hollow enclosure, >120 g).
   - Click **Slice / Trancher** -> GGPrint flags that the print exceeds your 100 g active limit and blocks direct auto-submit.
   - Click **Request Admin Approval / Demander l'approbation**, add a note (e.g. `Projet cours génie mécanique`), and submit.
   - Sign in as Admin (`0000001` / `admin123`), open **Admin -> Approval Requests**, and test **Approve Once**, **Approve & Raise Limit**, or **Reject**.

4. **Test Auto-Refund Loop / Remboursement automatique du budget**
   - Switch back to the student account (`2333572`) and open **My Prints / Mes impressions**.
   - On any `QUEUED` or `PRINTING` job, click **Complete Print (Dev) / Simuler fin d'impression**.
   - Verify the job transitions to `COMPLETED` and the reserved grams are immediately refunded to your available budget.

---

## 3. Proxmox VM / Docker Production Deployment

### Step 1: Prepare Docker Compose on the Proxmox VM
Clone or copy the repository to your Proxmox VM (Ubuntu/Debian with Docker Engine + Docker Compose v2). Create a `.env` file next to `docker-compose.yml`:

```env
POSTGRES_DB=ggprint
POSTGRES_USER=ggprint
POSTGRES_PASSWORD=replace-with-strong-db-password
JWT_SECRET=replace-with-64-char-random-secret
DEV_SEED=false
FRONTEND_PORT=80
CORS_ORIGINS=["http://ggprint.local","http://localhost"]
```

> **Note on `DEV_SEED`:** In production, keep `DEV_SEED=false` (default in `docker-compose.yml`). On a fresh production database, create or seed your initial admin DA before disabling dev seed, or run the first boot with `DEV_SEED=true` and immediately change the admin password and remove unused demo accounts.

Start the stack:
```bash
docker compose up -d --build
```

Services started:
- **`postgres`**: PostgreSQL 16 (`ggprint_pgdata` volume)
- **`backend`**: FastAPI on port `8000` with persistent mounts `/data` (`ggprint_data`) and `/profiles` (`ggprint_profiles`)
- **`frontend`**: Nginx serving the production Vite build on port `80` and proxying `/api/*` -> `http://backend:8000` (configured with `client_max_body_size 100M` for large STL uploads)

### Step 2: Install OrcaSlicer CLI on the Proxmox Host (Headless via `xvfb`)
Docker containers usually do not expose `/dev/fuse` for running AppImages directly. Extract the Linux OrcaSlicer AppImage once on the Proxmox VM host:

```bash
# On the Proxmox VM host
wget https://github.com/SoftFever/OrcaSlicer/releases/download/<VERSION>/OrcaSlicer_Linux_V<VERSION>.AppImage
chmod +x OrcaSlicer_Linux_V*.AppImage
./OrcaSlicer_Linux_V*.AppImage --appimage-extract
sudo mv squashfs-root /opt/orcaslicer
```

Uncomment the `/opt/orcaslicer` bind mount in `docker-compose.yml`:
```yaml
    volumes:
      - ggprint_data:/data
      - ggprint_profiles:/profiles
      - /opt/orcaslicer:/opt/orcaslicer:ro
```
Then recreate the backend container:
```bash
docker compose up -d backend
```
`backend/Dockerfile` includes `xvfb` and a preinstalled headless wrapper at **`/usr/local/bin/orca-slicer-headless`**.

### Step 3: Switch to Live FDM Monster & Real OrcaSlicer
Log in as Admin and open **Admin -> Settings**:
1. **Slicer Integration:**
   - Set **`slicer_mode`** to `orcaslicer`
   - Set **`orca_cli_path`** to `/usr/local/bin/orca-slicer-headless`
2. **FDM Monster Integration:**
   - Set **`fdm_monster_mode`** to `live`
   - Set **`fdm_monster_url`** to your FDM Monster instance URL (e.g. `http://fdm-monster:4000` or `http://192.168.x.x:4000`)
   - Set **`fdm_monster_api_key`** to your FDM Monster API key
3. **Sync & Bind Profiles:**
   - Open **Admin -> Printers & MMU Slots** and click **Sync from FDM Monster**.
   - Open **Admin -> Filaments & Orca Profiles** to upload your real `.json` `machine`, `process`, and `filament` OrcaSlicer profiles, bind them to each printer/slot, and run **Test Slice** to verify headless slicing end-to-end.
