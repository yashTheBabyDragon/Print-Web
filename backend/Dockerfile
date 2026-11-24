FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    DATA_DIR=/data \
    SAMPLE_MODELS_DIR=/app/sample-models

# System packages:
# - xvfb + GTK/GL/NSS/X11 libs required by OrcaSlicer AppImage/CLI in headless Linux
# - curl/ca-certificates for healthchecks & OrcaSlicer download if needed
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
# Optional Proxmox OrcaSlicer CLI setup:
# Because Docker containers typically lack FUSE for mounting AppImages,
# extract the OrcaSlicer AppImage on the Proxmox host or bind-mount the
# extracted squashfs-root to /opt/orcaslicer:
#   chmod +x OrcaSlicer_Linux_V*.AppImage
#   ./OrcaSlicer_Linux_V*.AppImage --appimage-extract
#   mv squashfs-root /opt/orcaslicer
# Then mount `- /opt/orcaslicer:/opt/orcaslicer:ro` in docker-compose.yml and
# set Admin Settings -> orca_cli_path to:
#   /usr/local/bin/orca-slicer-headless
# (or directly `/opt/orcaslicer/AppRun` with `xvfb-run -a`).
# ---------------------------------------------------------------------------
RUN printf '%s\n' \
    '#!/bin/sh' \
    'if [ -x /opt/orcaslicer/AppRun ]; then' \
    '  exec xvfb-run -a -s "-screen 0 1280x1024x24" /opt/orcaslicer/AppRun "$@"' \
    'elif [ -x /opt/orcaslicer/bin/orca-slicer ]; then' \
    '  exec xvfb-run -a -s "-screen 0 1280x1024x24" /opt/orcaslicer/bin/orca-slicer "$@"' \
    'else' \
    '  echo "OrcaSlicer not mounted at /opt/orcaslicer" >&2' \
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

RUN mkdir -p /data /profiles /opt/orcaslicer

EXPOSE 8000

# Ensure /data/profiles points to the dedicated /profiles volume mount
CMD ["/bin/sh", "-c", "mkdir -p /data/jobs /profiles && if [ -d /data/profiles ] && [ ! -L /data/profiles ]; then rmdir /data/profiles 2>/dev/null || true; fi && if [ ! -e /data/profiles ]; then ln -s /profiles /data/profiles; fi && exec uvicorn app.main:app --host 0.0.0.0 --port 8000"]
