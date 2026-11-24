"""User print-completion webhook validation and dispatch."""

from __future__ import annotations

import logging
from typing import Any, Optional
from urllib.parse import urlparse

import httpx

from app.models import PrintJob, User

logger = logging.getLogger(__name__)

WEBHOOK_TIMEOUT_SECONDS = 8.0


def normalize_webhook_url(raw_url: Optional[str]) -> Optional[str]:
    """Validate and normalize a user-configured HTTP(S) webhook URL.

    Returns None when blank/None. Raises ValueError for invalid schemes or hosts.
    """
    if raw_url is None:
        return None
    cleaned = raw_url.strip()
    if not cleaned:
        return None
    if len(cleaned) > 500:
        raise ValueError("Webhook URL must be 500 characters or fewer.")
    parsed = urlparse(cleaned)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or not parsed.hostname:
        raise ValueError("Webhook URL must start with http:// or https:// and include a valid host.")
    return cleaned


def _is_discord_webhook(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return host.endswith("discord.com") or host.endswith("discordapp.com")


def build_job_completed_payload(job: PrintJob, webhook_url: str) -> dict[str, Any]:
    """Build a JSON webhook payload compatible with Discord, Slack, and generic endpoints."""
    printer_name = (
        (job.printer.display_name or job.printer.name)
        if job.printer is not None
        else f"Printer #{job.printer_id}"
    )
    filament = job.filament or (job.slot.filament if job.slot is not None else None)
    filament_name = filament.name if filament is not None else None
    completed_iso = job.completed_at.isoformat() if job.completed_at else None

    details_parts = [printer_name]
    if filament_name:
        details_parts.append(filament_name)
    if job.estimated_grams is not None:
        details_parts.append(f"{job.estimated_grams:.1f} g")
    details_str = " · ".join(details_parts)

    summary = f"Print completed: {job.original_filename} ({details_str})"

    payload: dict[str, Any] = {
        "event": "print.completed",
        "message": summary,
        "content": f"✅ **{summary}**",
        "text": summary,
        "job": {
            "id": job.id,
            "filename": job.original_filename,
            "status": job.status,
            "printer_id": job.printer_id,
            "printer_name": printer_name,
            "filament_name": filament_name,
            "estimated_grams": job.estimated_grams,
            "estimated_minutes": job.estimated_minutes,
            "completed_at": completed_iso,
        },
        "user": {
            "id": job.user_id,
            "da": job.user.da if job.user else None,
            "name": job.user.name if job.user else None,
        },
    }

    if _is_discord_webhook(webhook_url):
        fields = [
            {"name": "Model", "value": job.original_filename, "inline": True},
            {"name": "Printer", "value": printer_name, "inline": True},
        ]
        if filament_name:
            fields.append({"name": "Filament", "value": filament_name, "inline": True})
        if job.estimated_grams is not None:
            fields.append({"name": "Weight", "value": f"{job.estimated_grams:.1f} g", "inline": True})
        payload["embeds"] = [
            {
                "title": "GGPrint — Print Completed",
                "description": f"Job #{job.id} is ready for pickup.",
                "color": 0x00A7D9,
                "fields": fields,
                "timestamp": completed_iso,
            }
        ]

    return payload


def build_test_webhook_payload(user: User, webhook_url: str) -> dict[str, Any]:
    """Build a test notification payload for verifying a user's webhook."""
    summary = f"GGPrint test notification for {user.name} ({user.da}). Your webhook is working!"
    payload: dict[str, Any] = {
        "event": "notification.test",
        "message": summary,
        "content": f"🔔 **{summary}**",
        "text": summary,
        "user": {
            "id": user.id,
            "da": user.da,
            "name": user.name,
        },
    }
    if _is_discord_webhook(webhook_url):
        payload["embeds"] = [
            {
                "title": "GGPrint — Test Notification",
                "description": summary,
                "color": 0x00A7D9,
            }
        ]
    return payload


async def post_webhook(url: str, payload: dict[str, Any]) -> tuple[bool, Optional[int], Optional[str]]:
    """Send a JSON POST request to the configured webhook URL."""
    try:
        async with httpx.AsyncClient(timeout=WEBHOOK_TIMEOUT_SECONDS) as client:
            resp = await client.post(
                url,
                json=payload,
                headers={"User-Agent": "GGPrint-Webhook/1.0"},
            )
            if 200 <= resp.status_code < 300:
                return True, resp.status_code, None
            return False, resp.status_code, f"HTTP {resp.status_code}"
    except Exception as exc:
        return False, None, str(exc)


async def notify_job_completed(job: PrintJob) -> bool:
    """Dispatch a webhook notification to the job owner if they configured a webhook URL.

    Never raises; logs a warning if delivery fails so job completion is unaffected.
    """
    owner = job.user
    if owner is None or not owner.notify_webhook_url:
        return False

    try:
        url = normalize_webhook_url(owner.notify_webhook_url)
    except ValueError as exc:
        logger.warning("Skipping invalid webhook URL for user %s: %s", owner.id, exc)
        return False

    if not url:
        return False

    payload = build_job_completed_payload(job, url)
    ok, status_code, error = await post_webhook(url, payload)
    if not ok:
        logger.warning(
            "Webhook delivery failed for job #%s (user %s, status=%s): %s",
            job.id,
            owner.id,
            status_code,
            error,
        )
    return ok
