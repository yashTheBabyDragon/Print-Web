"""GitHub Releases update checker with 10-minute in-memory cache and semver comparison."""

from __future__ import annotations

import logging
import re
import time
from datetime import datetime, timezone
from typing import Optional

import httpx

from app.config import settings
from app.schemas import SystemUpdateStatusOut

logger = logging.getLogger(__name__)

_CACHE_TTL_SECONDS = 600.0
_cached_key: Optional[tuple[str, str]] = None
_cached_at_mono: float = 0.0
_cached_result: Optional[SystemUpdateStatusOut] = None


def clear_update_cache() -> None:
    """Clear cached release check result (used by tests)."""
    global _cached_key, _cached_at_mono, _cached_result
    _cached_key = None
    _cached_at_mono = 0.0
    _cached_result = None


def parse_semver(raw: str) -> tuple[int, ...]:
    """Parse a semver-like tag (e.g. 'v1.2.3-rc1') into an integer tuple."""
    cleaned = raw.strip().lstrip("vV")
    core = re.split(r"[-+]", cleaned, maxsplit=1)[0]
    parts: list[int] = []
    for token in core.split("."):
        m = re.match(r"(\d+)", token.strip())
        parts.append(int(m.group(1)) if m else 0)
    return tuple(parts) or (0,)


def is_newer_version(latest: str, current: str) -> bool:
    """Return True if `latest` is strictly newer than `current`."""
    a = parse_semver(latest)
    b = parse_semver(current)
    max_len = max(len(a), len(b))
    a_pad = a + (0,) * (max_len - len(a))
    b_pad = b + (0,) * (max_len - len(b))
    return a_pad > b_pad


async def check_latest_github_release(force: bool = False) -> SystemUpdateStatusOut:
    """Query GitHub Releases API for the latest published release with 10-min caching."""
    global _cached_key, _cached_at_mono, _cached_result

    repo = (settings.github_repo or "yashTheBabyDragon/GGPrint-Web").strip()
    current_version = (settings.app_version or "1.0.0").strip().lstrip("vV")
    cache_key = (repo, current_version)
    now_mono = time.monotonic()

    if (
        not force
        and _cached_result is not None
        and _cached_key == cache_key
        and (now_mono - _cached_at_mono) < _CACHE_TTL_SECONDS
    ):
        return _cached_result

    checked_at = datetime.now(timezone.utc).isoformat()
    url = f"https://api.github.com/repos/{repo}/releases/latest"
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": f"GGPrint-Web/{current_version}",
    }
    if settings.github_token:
        headers["Authorization"] = f"Bearer {settings.github_token}"

    result: SystemUpdateStatusOut
    try:
        async with httpx.AsyncClient(timeout=6.0) as client:
            resp = await client.get(url, headers=headers)

        if resp.status_code == 404:
            result = SystemUpdateStatusOut(
                current_version=current_version,
                latest_version=None,
                update_available=False,
                release_url=f"https://github.com/{repo}/releases",
                release_notes=None,
                published_at=None,
                checked_at=checked_at,
                repo=repo,
                error=None,
            )
        elif resp.status_code in (403, 429):
            result = SystemUpdateStatusOut(
                current_version=current_version,
                latest_version=None,
                update_available=False,
                release_url=f"https://github.com/{repo}/releases",
                checked_at=checked_at,
                repo=repo,
                error=f"GitHub API rate limit or access restricted (HTTP {resp.status_code})",
            )
        elif resp.status_code >= 400:
            result = SystemUpdateStatusOut(
                current_version=current_version,
                latest_version=None,
                update_available=False,
                release_url=f"https://github.com/{repo}/releases",
                checked_at=checked_at,
                repo=repo,
                error=f"GitHub API returned HTTP {resp.status_code}",
            )
        else:
            data = resp.json()
            raw_tag = str(data.get("tag_name") or data.get("name") or "").strip()
            latest_ver = raw_tag.lstrip("vV") if raw_tag else None
            update_avail = bool(latest_ver and is_newer_version(latest_ver, current_version))
            raw_notes = str(data.get("body") or "").strip()
            notes = raw_notes[:2000] if raw_notes else None
            raw_html_url = data.get("html_url")
            safe_release_url = (
                raw_html_url
                if isinstance(raw_html_url, str) and raw_html_url.startswith("https://github.com/")
                else None
            )
            result = SystemUpdateStatusOut(
                current_version=current_version,
                latest_version=latest_ver,
                update_available=update_avail,
                release_url=safe_release_url,
                release_notes=notes,
                published_at=data.get("published_at"),
                checked_at=checked_at,
                repo=repo,
                error=None,
            )
    except Exception as exc:
        logger.warning("GitHub release update check failed for %s: %s", repo, exc)
        result = SystemUpdateStatusOut(
            current_version=current_version,
            latest_version=None,
            update_available=False,
            release_url=f"https://github.com/{repo}/releases",
            checked_at=checked_at,
            repo=repo,
            error=f"Unable to reach GitHub Releases: {exc}",
        )

    _cached_key = cache_key
    _cached_at_mono = now_mono
    _cached_result = result
    return result
