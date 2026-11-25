"""GitHub Releases update checker (10-min cache) and safe on-demand systemd .path trigger."""

from __future__ import annotations

import json
import logging
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import httpx
from fastapi import HTTPException, status

from app.config import settings
from app.schemas import SystemUpdateStatusOut, UpdateJobStatusOut

logger = logging.getLogger(__name__)

_CACHE_TTL_SECONDS = 600.0
_VERSION_TAG_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
_VALID_JOB_STATES = frozenset({"idle", "queued", "updating", "succeeded", "failed"})

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


def _get_updater_dir() -> Optional[Path]:
    raw = (settings.updater_dir or "").strip()
    if not raw:
        return None
    p = Path(raw)
    try:
        if p.is_dir():
            return p
    except OSError:
        return None
    return None


def is_updater_configured() -> bool:
    """Return True when UPDATER_DIR is configured and exists on disk."""
    return _get_updater_dir() is not None


def read_update_job_status() -> Optional[UpdateJobStatusOut]:
    """Read <updater_dir>/status.json safely if configured and present."""
    upd_dir = _get_updater_dir()
    if upd_dir is None:
        return None
    status_file = upd_dir / "status.json"
    if not status_file.is_file():
        return None
    try:
        data = json.loads(status_file.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return None
        raw_state = str(data.get("state") or "idle").strip().lower()
        state = raw_state if raw_state in _VALID_JOB_STATES else "idle"
        return UpdateJobStatusOut(
            state=state,  # type: ignore[arg-type]
            target_version=str(data["target_version"]) if data.get("target_version") else None,
            requested_by=str(data["requested_by"]) if data.get("requested_by") else None,
            updated_at=str(data["updated_at"]) if data.get("updated_at") else None,
            message=str(data["message"]) if data.get("message") else None,
        )
    except Exception as exc:
        logger.warning("Failed to parse updater status.json: %s", exc)
        return None


def _atomic_write_json(dest: Path, payload: dict) -> None:
    tmp_path = dest.with_suffix(dest.suffix + ".tmp")
    tmp_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    os.replace(tmp_path, dest)


def trigger_update(target_version: str, requested_by: str) -> UpdateJobStatusOut:
    """Validate and queue an on-demand host update by writing status.json and request.json."""
    cleaned = (target_version or "").strip()
    if not _VERSION_TAG_RE.match(cleaned):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "INVALID_VERSION_TAG",
                "message": "Target version tag must match ^[A-Za-z0-9._-]{1,64}$",
            },
        )

    upd_dir = _get_updater_dir()
    if upd_dir is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "UPDATER_NOT_CONFIGURED",
                "message": "Host updater directory (UPDATER_DIR) is not configured on this server.",
            },
        )

    existing = read_update_job_status()
    if existing is not None and existing.state in ("queued", "updating"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "UPDATE_IN_PROGRESS",
                "message": f"An update to {existing.target_version or 'latest'} is already {existing.state}.",
            },
        )

    now_iso = datetime.now(timezone.utc).isoformat()
    status_payload = {
        "state": "queued",
        "target_version": cleaned,
        "requested_by": requested_by,
        "updated_at": now_iso,
        "message": f"Update to {cleaned} queued.",
    }
    request_payload = {
        "target_version": cleaned,
        "requested_by": requested_by,
        "requested_at": now_iso,
    }

    _atomic_write_json(upd_dir / "status.json", status_payload)
    _atomic_write_json(upd_dir / "request.json", request_payload)

    return UpdateJobStatusOut(
        state="queued",
        target_version=cleaned,
        requested_by=requested_by,
        updated_at=now_iso,
        message=status_payload["message"],
    )


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
        return _cached_result.model_copy(
            update={
                "updater_configured": is_updater_configured(),
                "update_job": read_update_job_status(),
            }
        )

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
    return result.model_copy(
        update={
            "updater_configured": is_updater_configured(),
            "update_job": read_update_job_status(),
        }
    )
