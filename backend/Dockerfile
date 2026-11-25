FROM python:3.13-slim

ARG INSTALL_ORCASLICER=true
ARG ORCASLICER_VERSION=latest

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    DATA_DIR=/data \
    SAMPLE_MODELS_DIR=/app/sample-models \
    ORCA_CLI_PATH=/usr/local/bin/orca-slicer-headless

# System packages:
# - xvfb + GTK/GL/NSS/X11 libs required by OrcaSlicer AppImage/CLI in headless Linux
# - curl/ca-certificates for healthchecks & OrcaSlicer download
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    xauth \
    ca-certificates \
    curl \
    libgl1 \
    libegl1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnss3 \
    libnspr4 \
    libxkbcommon0 \
    libxkbcommon-x11-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libxi6 \
    libxtst6 \
    libasound2t64 \
    libdbus-1-3 \
    libfontconfig1 \
    libfreetype6 \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Automatic OrcaSlicer CLI installation (extracted AppImage, no FUSE needed):
# Downloads the official Linux x86_64 AppImage from SoftFever/OrcaSlicer
# releases during image build and extracts it to /opt/orcaslicer.
# Set --build-arg INSTALL_ORCASLICER=false to skip (e.g., if mounting /opt/orcaslicer).
# ---------------------------------------------------------------------------
RUN if [ "$INSTALL_ORCASLICER" = "true" ] && [ "$(uname -m)" = "x86_64" ]; then \
      python3 -c '
import json, os, sys, urllib.request
ver = os.environ.get("ORCASLICER_VERSION", "latest")
api = (
    "https://api.github.com/repos/SoftFever/OrcaSlicer/releases/latest"
    if ver == "latest"
    else f"https://api.github.com/repos/SoftFever/OrcaSlicer/releases/tags/{ver}"
)
req = urllib.request.Request(api, headers={"Accept": "application/vnd.github+json", "User-Agent": "ggprint-docker-build"})
with urllib.request.urlopen(req, timeout=30) as resp:
    data = json.loads(resp.read().decode("utf-8"))
assets = data.get("assets", [])
def score(a):
    name = a.get("name", "")
    low = name.lower()
    if not low.endswith(".appimage") or "linux" not in low:
        return -1
    if "arm" in low or "aarch64" in low:
        return -1
    if "ubuntu2404" in low:
        return 3
    if "ubuntu2204" in low:
        return 2
    return 1
candidates = sorted((a for a in assets if score(a) > 0), key=score, reverse=True)
if not candidates:
    sys.exit("No compatible Linux x86_64 OrcaSlicer AppImage found in release assets")
url = candidates[0]["browser_download_url"]
print("Downloading OrcaSlicer:", candidates[0]["name"], url)
urllib.request.urlretrieve(url, "/tmp/OrcaSlicer.AppImage")
' && \
      chmod +x /tmp/OrcaSlicer.AppImage && \
      cd /tmp && /tmp/OrcaSlicer.AppImage --appimage-extract >/dev/null && \
      rm -rf /opt/orcaslicer && mv /tmp/squashfs-root /opt/orcaslicer && \
      rm -f /tmp/OrcaSlicer.AppImage && \
      chmod -R a+rX /opt/orcaslicer; \
    else \
      mkdir -p /opt/orcaslicer; \
    fi

RUN printf '%s\n' \
    '#!/bin/sh' \
    'if [ -x /opt/orcaslicer/AppRun ]; then' \
    '  exec xvfb-run -a -s "-screen 0 1280x1024x24" /opt/orcaslicer/AppRun "$@"' \
    'elif [ -x /opt/orcaslicer/bin/orca-slicer ]; then' \
    '  exec xvfb-run -a -s "-screen 0 1280x1024x24" /opt/orcaslicer/bin/orca-slicer "$@"' \
    'else' \
    '  echo "OrcaSlicer not installed at /opt/orcaslicer" >&2' \
    '  exit 127' \
    'fi' \
    > /usr/local/bin/orca-slicer-headless && chmod +x /usr/local/bin/orca-slicer-headless

WORKDIR /app/backend

COPY backend/pyproject.toml /app/backend/pyproject.toml
COPY backend/app /app/backend/app
COPY sample-models /app/sample-models

# Install backend package + PostgreSQL driver (psycopg2-binary) for Proxmox production
RUN pip install --upgrade pip && \
    pip install . psycopg2-binary

RUN groupadd --system ggprint && \
    useradd --system --gid ggprint --create-home --home-dir /home/ggprint --shell /usr/sbin/nologin ggprint && \
    mkdir -p /data /profiles /opt/orcaslicer /app/backend/data && \
    chown -R ggprint:ggprint /data /profiles /app/backend

EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=5 \
    CMD curl -fsS http://127.0.0.1:8000/api/health || exit 1

USER ggprint

# Ensure /data/profiles points to the dedicated /profiles volume mount
CMD ["/bin/sh", "-c", "mkdir -p /data/jobs /data/backups /profiles && if [ -d /data/profiles ] && [ ! -L /data/profiles ]; then rmdir /data/profiles 2>/dev/null || true; fi && if [ ! -e /data/profiles ]; then ln -s /profiles /data/profiles; fi && exec uvicorn app.main:app --host 0.0.0.0 --port 8000"]
