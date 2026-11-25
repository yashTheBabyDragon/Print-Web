"""User print-completion webhook validation and dispatch."""

from __future__ import annotations

import ipaddress
import logging
import socket
from typing import Any, Optional
from urllib.parse import urlparse

import httpx

from app.models import PrintJob, User

logger = logging.getLogger(__name__)

WEBHOOK_TIMEOUT_SECONDS = 8.0


def _is_disallowed_ip(ip_obj: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    return bool(
        ip_obj.is_loopback
        or ip_obj.is_private
        or ip_obj.is_link_local
        or ip_obj.is_multicast
        or ip_obj.is_unspecified
        or ip_obj.is_reserved
    )


def is_safe_webhook_host(hostname: str, *, resolve_dns: bool = False) -> tuple[bool, str]:
    """Check that a webhook hostname is not a loopback, private, link-local, or internal target."""
    host = hostname.strip().lower().rstrip(".")
    if not host:
        return False, "Missing webhook host"
    if (
        host == "localhost"
        or host.endswith(".localhost")
        or host.endswith(".local")
        or host.endswith(".internal")
    ):
        return False, "Blocked webhook target"

    try:
        ip_literal = ipaddress.ip_address(host)
    except ValueError:
        ip_literal = None

    if ip_literal is not None:
        if _is_disallowed_ip(ip_literal):
            return False, "Blocked webhook target"
        return True, ""

    if resolve_dns:
        try:
            infos = socket.getaddrinfo(host, None)
        except OSError:
            return False, "Webhook host resolution failed"
        if not infos:
            return False, "Webhook host resolution failed"
        for info in infos:
            raw_ip = info[4][0]
            try:
                resolved_ip = ipaddress.ip_address(raw_ip.split("%", 1)[0])
            except ValueError:
                return False, "Blocked webhook target"
            if _is_disallowed_ip(resolved_ip):
                return False, "Blocked webhook target"

    return True, ""


def normalize_webhook_url(raw_url: Optional[str]) -> Optional[str]:
    """Validate and normalize a user-configured HTTP(S) webhook URL.

    Returns None when blank/None. Raises ValueError for invalid schemes or blocked hosts.
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
    safe, reason = is_safe_webhook_host(parsed.hostname, resolve_dns=False)
    if not safe:
        raise ValueError(reason)
    return cleaned


def _is_discord_webhook(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower().rstrip(".")
    return (
        host in ("discord.com", "discordapp.com")
        or host.endswith(".discord.com")
        or host.endswith(".discordapp.com")
    )


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
    """Send a JSON POST request to the configured webhook URL after SSRF DNS validation."""
    parsed = urlparse(url)
    safe, reason = is_safe_webhook_host(parsed.hostname or "", resolve_dns=True)
    if not safe:
        return False, None, reason

    try:
        async with httpx.AsyncClient(
            timeout=WEBHOOK_TIMEOUT_SECONDS,
            follow_redirects=False,
        ) as client:
            resp = await client.post(
                url,
                json=payload,
                headers={"User-Agent": "GGPrint-Webhook/1.0"},
            )
            if 200 <= resp.status_code < 300:
                return True, resp.status_code, None
            return False, resp.status_code, f"HTTP {resp.status_code}"
    except Exception as exc:
        logger.warning("Webhook POST failed for %s: %s", parsed.hostname, exc)
        return False, None, "Webhook request failed"


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
