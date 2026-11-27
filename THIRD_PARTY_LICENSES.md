# Third-Party Licenses & Notices

Print-Web's own original source code, documentation, and assets are licensed under **CC BY-NC 4.0** (see [`LICENSE`](./LICENSE)). None of the third-party software, libraries, or container base-image packages listed below are covered by CC BY-NC 4.0; each remains governed solely by its own license.

---

## 1. External Slicer Binary (Separate Aggregate Component)

| Component | Upstream | License | How Print-Web Uses / Distributes It |
| :--- | :--- | :--- | :--- |
| **OrcaSlicer** | https://github.com/SoftFever/OrcaSlicer | **GNU Affero General Public License v3.0 (AGPL-3.0)** | Invoked unmodified as an external CLI subprocess. Pre-built Linux `x86_64` Docker backend images bundle the extracted official AppImage in `/opt/orcaslicer-builtin` strictly as a separate aggregate component alongside `/opt/orcaslicer-builtin/ORCASLICER_SOURCE_NOTICE.txt` pointing to the exact release tag's license and Corresponding Source archive (`https://github.com/SoftFever/OrcaSlicer/archive/refs/tags/<tag>.tar.gz`). Building with `--build-arg INSTALL_ORCASLICER=false` omits OrcaSlicer from the image so admins can mount a host binary at `/opt/orcaslicer`. |

Upstream license text: https://github.com/SoftFever/OrcaSlicer/blob/main/LICENSE.txt

---

## 2. Weak-Copyleft Runtime Dependencies

| Component | Ecosystem | License | Notes |
| :--- | :--- | :--- | :--- |
| `psycopg2-binary` | Python (Docker backend) | **GNU LGPL-3.0** (with OpenSSL exception) + BSD-style alternative for adapter/microprotocol files | Installed dynamically via `pip` inside the backend container to connect to PostgreSQL (`https://github.com/psycopg/psycopg2`). |
| `certifi` | Python (transitive via `httpx`) | **MPL-2.0** | CA certificate bundle; unmodified upstream package (`https://github.com/certifi/python-certifi`). |

---

## 3. Permissive Backend Dependencies (Python)

All remaining direct and transitive runtime dependencies in `backend/pyproject.toml` use permissive licenses:

- **MIT**: `fastapi`, `pydantic`, `pydantic-settings`, `pyjwt`, `trimesh`, `anyio`, `annotated-doc`, `annotated-types`, `h11`, `httptools`, `pluggy`, `pydantic_core`, `PyYAML`, `SQLAlchemy`, `typing-inspection`, `watchfiles` (plus dev dependency `pytest`, `iniconfig`)
- **BSD-3-Clause**: `uvicorn`, `httpx`, `httpcore`, `click`, `idna`, `starlette`, `websockets`, `python-dotenv`, `scipy`, `numpy` (multi-licensed `BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0`), `colorama` (`BSD License`)
- **BSD-2-Clause**: `packaging` (`Apache-2.0 OR BSD-2-Clause`), `Pygments`
- **Apache-2.0**: `bcrypt`, `python-multipart`, `opentelemetry-api`
- **PSF-2.0**: `typing_extensions`

---

## 4. Frontend Dependencies (React / TypeScript / Three.js)

- **Runtime dependencies** (`frontend/package.json`): `react`, `react-dom`, `three`, and their dependencies are **MIT**, with `lucide-react` under **ISC**.
- **Lockfile / build toolchain (`frontend/package-lock.json`)**:
  - `MIT` (234 packages), `ISC` (12 packages), `Apache-2.0` (7 packages), `BSD-3-Clause` (3 packages), `BSD-2-Clause` (2 packages), `BlueOak-1.0.0` (1 package).
  - `caniuse-lite` is **CC-BY-4.0** (used only at build/dev time by Browserslist/Autoprefixer and not shipped in runtime assets).

---

## 5. Docker Container Base Images & OS Packages

Pre-built GHCR images include upstream OS packages governed by their own licenses:

- **Backend image** (`python:3.13-slim` / Debian): System libraries (`xvfb`, `xauth`, `curl`, `ca-certificates`, Mesa/GTK/WebKitGTK/GStreamer/X11/Wayland/NSS libraries required by OrcaSlicer) retain their upstream GPL, LGPL, MIT, BSD, and Apache licenses, with Debian copyright notices preserved in `/usr/share/doc/*/copyright`.
- **Frontend image** (`nginx:1.27-alpine`): Nginx (2-clause BSD) and Alpine Linux base packages.
- **Database service** (`docker-compose.yml` references `postgres:16-alpine`): PostgreSQL License (permissive) and Alpine Linux base packages.

---

## 6. External Network Services (Not Bundled)

- **FDM Monster** (GNU AGPL-3.0 / upstream repo `https://github.com/fdm-monster/fdm-monster`) and **FilamentAPI**: Communicated with solely as separate services over HTTP REST APIs. Neither is bundled into, linked with, or redistributed by Print-Web.
