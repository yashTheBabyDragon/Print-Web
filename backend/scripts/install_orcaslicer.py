"""Download and extract the latest Linux x86_64 OrcaSlicer AppImage for Docker builds."""

from __future__ import annotations

import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional

ORCA_REPO = "OrcaSlicer/OrcaSlicer"
USER_AGENT = "print-web-docker-build"
_HREF_RE = re.compile(
    r'href="(/[^"\'<>]+/releases/download/[^"\'<>]+\.AppImage)"',
    re.IGNORECASE,
)


def detect_arch(arch: Optional[str] = None) -> str:
    """Normalize host architecture to 'aarch64' or 'x86_64'."""
    raw = (arch or platform.machine() or "").strip().lower()
    if raw in ("aarch64", "arm64"):
        return "aarch64"
    if raw in ("x86_64", "amd64"):
        return "x86_64"
    raise RuntimeError(f"Unsupported architecture for OrcaSlicer AppImage: {raw or 'unknown'}")


def score_asset(name: str, arch: Optional[str] = None) -> int:
    """Rank Linux OrcaSlicer AppImage assets for `arch`; return -1 if incompatible."""
    target_arch = detect_arch(arch)
    lower = (name or "").lower()
    if not lower.endswith(".appimage") or "linux" not in lower:
        return -1
    is_arm = "aarch64" in lower or "arm64" in lower or "_arm" in lower or "-arm" in lower
    if target_arch == "aarch64":
        if not is_arm:
            return -1
    elif is_arm:
        return -1
    if "ubuntu2404" in lower:
        return 3
    if "ubuntu2204" in lower:
        return 2
    return 1


def _read_github_token() -> Optional[str]:
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    if token:
        return token
    secret_path = Path("/run/secrets/github_token")
    try:
        if secret_path.is_file():
            val = secret_path.read_text(encoding="utf-8").strip()
            if val:
                return val
    except OSError:
        pass
    return None


def discover_via_web(version: str = "latest", arch: Optional[str] = None) -> tuple[str, str, str]:
    """Discover the OrcaSlicer release tag and AppImage URL from github.com HTML (no API rate limit)."""
    target_arch = detect_arch(arch)
    ver = (version or "latest").strip() or "latest"
    if ver.lower() == "latest":
        req = urllib.request.Request(
            f"https://github.com/{ORCA_REPO}/releases/latest",
            headers={"User-Agent": USER_AGENT},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            final_url = resp.geturl()
        tag = final_url.rstrip("/").split("/")[-1].strip()
        if not tag or tag.lower() in ("latest", "releases"):
            raise RuntimeError(f"Could not determine latest release tag from redirect URL: {final_url}")
    else:
        tag = ver

    expanded_url = f"https://github.com/{ORCA_REPO}/releases/expanded_assets/{tag}"
    req = urllib.request.Request(expanded_url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        html = resp.read().decode("utf-8", errors="ignore")

    matches: list[tuple[int, str, str]] = []
    seen_hrefs: set[str] = set()
    for href in _HREF_RE.findall(html):
        if href in seen_hrefs:
            continue
        seen_hrefs.add(href)
        asset_name = href.rsplit("/", 1)[-1]
        sc = score_asset(asset_name, arch=target_arch)
        if sc > 0:
            matches.append((sc, asset_name, f"https://github.com{href}"))

    if not matches:
        raise RuntimeError(f"No compatible Linux {target_arch} OrcaSlicer AppImage found on {expanded_url}")

    matches.sort(key=lambda item: item[0], reverse=True)
    _, best_name, best_url = matches[0]
    return tag, best_name, best_url


def discover_via_api(version: str = "latest", arch: Optional[str] = None) -> tuple[str, str, str]:
    """Discover the OrcaSlicer release tag and AppImage URL via the GitHub REST API."""
    target_arch = detect_arch(arch)
    ver = (version or "latest").strip() or "latest"
    api = (
        f"https://api.github.com/repos/{ORCA_REPO}/releases/latest"
        if ver.lower() == "latest"
        else f"https://api.github.com/repos/{ORCA_REPO}/releases/tags/{ver}"
    )
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": USER_AGENT,
    }
    token = _read_github_token()
    if token:
        headers["Authorization"] = f"Bearer {token}"

    req = urllib.request.Request(api, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))

    tag = str(data.get("tag_name") or ver).strip()
    assets = data.get("assets", []) or []
    candidates = sorted(
        (a for a in assets if score_asset(a.get("name", ""), arch=target_arch) > 0),
        key=lambda a: score_asset(a.get("name", ""), arch=target_arch),
        reverse=True,
    )
    if not candidates:
        raise RuntimeError(f"No compatible Linux {target_arch} OrcaSlicer AppImage found in API response for {tag}")
    return tag, str(candidates[0]["name"]), str(candidates[0]["browser_download_url"])


def resolve_release_asset(version: str = "latest", arch: Optional[str] = None) -> tuple[str, str, str]:
    """Resolve (tag, asset_name, download_url), preferring GitHub web discovery before REST API fallback."""
    target_arch = detect_arch(arch)
    try:
        return discover_via_web(version, arch=target_arch)
    except Exception as web_exc:
        print(f"Web discovery failed ({web_exc}); falling back to GitHub REST API...", file=sys.stderr)
        return discover_via_api(version, arch=target_arch)


def download_file(url: str, dest: Path, retries: int = 3) -> None:
    """Download `url` to `dest` with chunked streaming and retry backoff."""
    last_exc: Optional[Exception] = None
    tmp_dest = dest.with_suffix(dest.suffix + ".part")
    for attempt in range(1, max(1, retries) + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=180) as resp, tmp_dest.open("wb") as fh:
                while True:
                    chunk = resp.read(1024 * 1024)
                    if not chunk:
                        break
                    fh.write(chunk)
            os.replace(tmp_dest, dest)
            return
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last_exc = exc
            tmp_dest.unlink(missing_ok=True)
            if attempt < retries:
                wait_s = 2 * attempt
                print(
                    f"Download attempt {attempt}/{retries} failed ({exc}); retrying in {wait_s}s...",
                    file=sys.stderr,
                )
                time.sleep(wait_s)
    raise RuntimeError(f"Failed to download {url} after {retries} attempts: {last_exc}")


def write_source_notice(dest: Path, tag: str, asset_name: str, url: str) -> None:
    """Write AGPL-3.0 upstream notice and Corresponding Source links for bundled OrcaSlicer."""
    notice = "\n".join(
        [
            f"OrcaSlicer ({ORCA_REPO}) -- GNU Affero General Public License v3.0 (AGPL-3.0)",
            "This directory contains an unmodified extracted release of OrcaSlicer, bundled as a",
            "separate aggregate component and excluded from Print-Web CC BY-NC 4.0 licensing.",
            f"Release Tag: {tag}",
            f"Asset: {asset_name}",
            f"Download URL: {url}",
            f"Upstream Repository: https://github.com/{ORCA_REPO}",
            f"License (AGPL-3.0): https://github.com/{ORCA_REPO}/blob/{tag}/LICENSE.txt",
            f"Corresponding Source Archive: https://github.com/{ORCA_REPO}/archive/refs/tags/{tag}.tar.gz",
            "",
        ]
    )
    dest.write_text(notice, encoding="utf-8")


def main() -> int:
    version = os.environ.get("ORCASLICER_VERSION", "latest")
    tag, asset_name, url = resolve_release_asset(version)
    print(f"Downloading OrcaSlicer {tag}: {asset_name} ({url})", flush=True)

    appimage = Path("/tmp/OrcaSlicer.AppImage")
    extract_dir = Path("/tmp/squashfs-root")
    builtin_dir = Path("/opt/orcaslicer-builtin")
    override_dir = Path("/opt/orcaslicer")

    download_file(url, appimage)
    os.chmod(appimage, 0o755)
    shutil.rmtree(extract_dir, ignore_errors=True)

    subprocess.run(
        [str(appimage), "--appimage-extract"],
        cwd="/tmp",
        check=True,
        stdout=subprocess.DEVNULL,
    )
    if not extract_dir.is_dir():
        raise RuntimeError(f"Expected extracted directory missing: {extract_dir}")

    shutil.rmtree(builtin_dir, ignore_errors=True)
    shutil.move(str(extract_dir), str(builtin_dir))
    write_source_notice(builtin_dir / "ORCASLICER_SOURCE_NOTICE.txt", tag, asset_name, url)
    appimage.unlink(missing_ok=True)
    override_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(["chmod", "-R", "a+rX", str(builtin_dir)], check=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: OrcaSlicer installation failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
