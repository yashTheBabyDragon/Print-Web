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
# - xvfb + GTK/GL/WebKitGTK/GStreamer/NSS/Wayland/X11 libs required by OrcaSlicer Ubuntu 24.04 AppImage on Debian Trixie
# - curl/ca-certificates for healthchecks & OrcaSlicer download
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    xauth \
    ca-certificates \
    curl \
    libgl1 \
    libopengl0 \
    libegl1 \
    libglx-mesa0 \
    libglib2.0-0 \
    libgtk-3-0 \
    libwebkit2gtk-4.1-0 \
    libjavascriptcoregtk-4.1-0 \
    libgstreamer1.0-0 \
    libgstreamer-plugins-base1.0-0 \
    libsecret-1-0 \
    libcurl4t64 \
    libwayland-client0 \
    libwayland-egl1 \
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
# releases during image build and extracts it to /opt/orcaslicer-builtin so
# /opt/orcaslicer remains a clean optional host mount override.
# Set --build-arg INSTALL_ORCASLICER=false to skip.
# ---------------------------------------------------------------------------
RUN if [ "$INSTALL_ORCASLICER" = "true" ] && [ "$(uname -m)" = "x86_64" ]; then \
      ORCASLICER_VERSION="$ORCASLICER_VERSION" python3 -c 'import json, os, sys, urllib.request; \
ver = os.environ.get("ORCASLICER_VERSION", "latest"); \
api = "https://api.github.com/repos/SoftFever/OrcaSlicer/releases/latest" if ver == "latest" else f"https://api.github.com/repos/SoftFever/OrcaSlicer/releases/tags/{ver}"; \
req = urllib.request.Request(api, headers={"Accept": "application/vnd.github+json", "User-Agent": "print-web-docker-build"}); \
resp = urllib.request.urlopen(req, timeout=30); \
data = json.loads(resp.read().decode("utf-8")); \
resp.close(); \
assets = data.get("assets", []); \
score = lambda a: -1 if not a.get("name", "").lower().endswith(".appimage") or "linux" not in a.get("name", "").lower() or "arm" in a.get("name", "").lower() or "aarch64" in a.get("name", "").lower() else (3 if "ubuntu2404" in a.get("name", "").lower() else (2 if "ubuntu2204" in a.get("name", "").lower() else 1)); \
candidates = sorted((a for a in assets if score(a) > 0), key=score, reverse=True); \
candidates or sys.exit("No compatible Linux x86_64 OrcaSlicer AppImage found in release assets"); \
url = candidates[0]["browser_download_url"]; \
print("Downloading OrcaSlicer:", candidates[0]["name"], url); \
urllib.request.urlretrieve(url, "/tmp/OrcaSlicer.AppImage")' && \
      chmod +x /tmp/OrcaSlicer.AppImage && \
      cd /tmp && /tmp/OrcaSlicer.AppImage --appimage-extract >/dev/null && \
      rm -rf /opt/orcaslicer-builtin && mv /tmp/squashfs-root /opt/orcaslicer-builtin && \
      rm -f /tmp/OrcaSlicer.AppImage && \
      chmod -R a+rX /opt/orcaslicer-builtin && \
      mkdir -p /opt/orcaslicer; \
    else \
      mkdir -p /opt/orcaslicer-builtin /opt/orcaslicer; \
    fi

RUN printf '%s\n' \
    '#!/bin/sh' \
    'if [ -z "${HOME:-}" ] || [ ! -w "$HOME" ]; then' \
    '  export HOME=/tmp' \
    'fi' \
    'if [ -x /opt/orcaslicer/AppRun ]; then' \
    '  exec xvfb-run -a -s "-screen 0 1280x1024x24" /opt/orcaslicer/AppRun "$@"' \
    'elif [ -x /opt/orcaslicer/bin/orca-slicer ]; then' \
    '  exec xvfb-run -a -s "-screen 0 1280x1024x24" /opt/orcaslicer/bin/orca-slicer "$@"' \
    'elif [ -x /opt/orcaslicer-builtin/AppRun ]; then' \
    '  exec xvfb-run -a -s "-screen 0 1280x1024x24" /opt/orcaslicer-builtin/AppRun "$@"' \
    'elif [ -x /opt/orcaslicer-builtin/bin/orca-slicer ]; then' \
    '  exec xvfb-run -a -s "-screen 0 1280x1024x24" /opt/orcaslicer-builtin/bin/orca-slicer "$@"' \
    'else' \
    '  echo "OrcaSlicer not installed at /opt/orcaslicer or /opt/orcaslicer-builtin" >&2' \
    '  exit 127' \
    'fi' \
    > /usr/local/bin/orca-slicer-headless && chmod +x /usr/local/bin/orca-slicer-headless

WORKDIR /app/backend

COPY backend/pyproject.toml /app/backend/pyproject.toml
COPY backend/app /app/backend/app
COPY sample-models /app/sample-models

# Verify baked OrcaSlicer binary & shared libs cleanly at build time
RUN if [ "$INSTALL_ORCASLICER" = "true" ] && [ "$(uname -m)" = "x86_64" ]; then \
      /usr/local/bin/orca-slicer-headless --help >/dev/null; \
    fi

# Install backend package + PostgreSQL driver (psycopg2-binary) and print-web-cli console script
RUN pip install --upgrade pip && \
    pip install . psycopg2-binary

RUN groupadd --system printweb && \
    useradd --system --gid printweb --create-home --home-dir /home/printweb --shell /usr/sbin/nologin printweb && \
    mkdir -p /data /profiles /opt/orcaslicer /app/backend/data && \
    chown -R printweb:printweb /data /profiles /app/backend

EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=5 \
    CMD curl -fsS http://127.0.0.1:8000/api/health || exit 1

USER printweb

# Ensure /data/profiles points to the dedicated /profiles volume mount
CMD ["/bin/sh", "-c", "mkdir -p /data/jobs /data/backups /profiles && if [ -d /data/profiles ] && [ ! -L /data/profiles ]; then rmdir /data/profiles 2>/dev/null || true; fi && if [ ! -e /data/profiles ]; then ln -s /profiles /data/profiles; fi && exec uvicorn app.main:app --host 0.0.0.0 --port 8000"]
