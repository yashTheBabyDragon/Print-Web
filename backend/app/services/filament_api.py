"""FilamentAPI HTTP client and automatic printer filament synchronization service.

Integrates with https://github.com/weegeeday/FilamentAPI:
- GET /health
- GET /printers
- GET /filament/{printer_id}
"""

from __future__ import annotations

import logging
from typing import Optional
from urllib.parse import quote

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models import Filament, Printer, PrinterSlot, SystemSettings
from app.schemas import (
    FilamentApiHealthOut,
    FilamentApiPrinterOut,
    FilamentSyncPrinterResult,
    FilamentSyncResponse,
)

logger = logging.getLogger(__name__)


class FilamentApiError(Exception):
    """Raised when a FilamentAPI request fails."""


class FilamentApiClient:
    """Async HTTP client for the FilamentAPI service."""

    def __init__(self, base_url: str, timeout: float = 5.0) -> None:
        self.base_url = base_url.strip().rstrip("/")
        self.timeout = timeout

    async def check_health(self) -> FilamentApiHealthOut:
        """Query GET /health and GET /printers on FilamentAPI."""
        if not self.base_url:
            return FilamentApiHealthOut(
                ok=False,
                status="error",
                error="FilamentAPI URL is not configured",
            )
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.get(f"{self.base_url}/health")
                resp.raise_for_status()
                data = resp.json()

                printers: list[FilamentApiPrinterOut] = []
                try:
                    p_resp = await client.get(f"{self.base_url}/printers")
                    if p_resp.status_code == 200:
                        p_data = p_resp.json()
                        raw_printers = p_data.get("printers", []) if isinstance(p_data, dict) else []
                        for item in raw_printers:
                            if isinstance(item, dict) and item.get("id"):
                                printers.append(
                                    FilamentApiPrinterOut(
                                        id=str(item["id"]),
                                        type=str(item.get("type", "")),
                                        host=str(item.get("host", "")),
                                    )
                                )
                except Exception as exc:
                    logger.debug("FilamentAPI /printers fetch failed during health check: %s", exc)

                return FilamentApiHealthOut(
                    ok=str(data.get("status", "")).lower() == "ok",
                    status=str(data.get("status", "unknown")),
                    printers_configured=int(data.get("printers_configured", len(printers))),
                    uptime_seconds=(
                        float(data["uptime_seconds"])
                        if data.get("uptime_seconds") is not None
                        else None
                    ),
                    printers=printers,
                )
        except Exception as exc:
            return FilamentApiHealthOut(
                ok=False,
                status="error",
                error=str(exc),
            )

    async def list_printers(self) -> list[FilamentApiPrinterOut]:
        """Return configured printers from GET /printers."""
        if not self.base_url:
            raise FilamentApiError("FilamentAPI URL is not configured")
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.get(f"{self.base_url}/printers")
                resp.raise_for_status()
                data = resp.json()
                raw_printers = data.get("printers", []) if isinstance(data, dict) else []
                return [
                    FilamentApiPrinterOut(
                        id=str(item["id"]),
                        type=str(item.get("type", "")),
                        host=str(item.get("host", "")),
                    )
                    for item in raw_printers
                    if isinstance(item, dict) and item.get("id")
                ]
        except Exception as exc:
            raise FilamentApiError(f"Failed to list printers from FilamentAPI: {exc}") from exc

    async def get_filament(self, printer_id: str) -> Optional[str]:
        """Query GET /filament/{printer_id} and return the loaded filament name, or None if unloaded."""
        if not self.base_url:
            raise FilamentApiError("FilamentAPI URL is not configured")
        encoded_id = quote(printer_id.strip(), safe="")
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.get(f"{self.base_url}/filament/{encoded_id}")
                if resp.status_code == 404:
                    raise FilamentApiError(f"Printer '{printer_id}' not found in FilamentAPI")
                resp.raise_for_status()
                data = resp.json()
                raw = data.get("filament") if isinstance(data, dict) else None
                if raw is None:
                    return None
                cleaned = str(raw).strip()
                return cleaned or None
        except FilamentApiError:
            raise
        except Exception as exc:
            raise FilamentApiError(f"Failed to query filament for '{printer_id}': {exc}") from exc


def match_filament_in_catalog(
    db: Session,
    detected_name: Optional[str],
    current_filament: Optional[Filament] = None,
) -> Optional[Filament]:
    """Match a FilamentAPI filament string (e.g. 'PLA', 'PETG', 'PLA Noir') to an active catalog Filament."""
    if not detected_name or not detected_name.strip():
        return None

    needle = detected_name.strip().upper()
    active_filaments = list(
        db.scalars(
            select(Filament)
            .where(Filament.is_active.is_(True))
            .options(
                selectinload(Filament.filament_profile),
                selectinload(Filament.process_override_profile),
            )
            .order_by(Filament.id.asc())
        )
    )
    if not active_filaments:
        return None

    # 1. Exact case-insensitive match on filament name (e.g. "PLA Noir")
    for fil in active_filaments:
        if fil.name.strip().upper() == needle:
            return fil

    # 2. Preserve currently assigned filament if its material already matches (e.g. "PLA Bleu" when API reports "PLA")
    if (
        current_filament is not None
        and current_filament.is_active
        and current_filament.material.strip().upper() == needle
    ):
        for fil in active_filaments:
            if fil.id == current_filament.id:
                return fil

    # 3. Exact case-insensitive match on material (e.g. "PLA", "PETG")
    for fil in active_filaments:
        if fil.material.strip().upper() == needle:
            return fil

    # 4. Substring fallback (e.g. "PLA+" or "Prusament PETG")
    for fil in active_filaments:
        mat = fil.material.strip().upper()
        name = fil.name.strip().upper()
        if (mat and mat in needle) or (needle in name):
            return fil

    return None


async def sync_printer_filament(
    db: Session,
    printer: Printer,
    sys_settings: SystemSettings,
    target_slot: Optional[PrinterSlot] = None,
) -> Optional[FilamentSyncPrinterResult]:
    """Query FilamentAPI for a single printer and update its slot filament if changed."""
    if not sys_settings.filament_api_enabled:
        return None
    api_printer_id = (printer.filament_api_printer_id or "").strip()
    if not api_printer_id or not (sys_settings.filament_api_url or "").strip():
        return None

    slot = target_slot
    if slot is None:
        slot = db.scalar(
            select(PrinterSlot)
            .where(PrinterSlot.printer_id == printer.id, PrinterSlot.slot_index == 1)
            .options(selectinload(PrinterSlot.filament))
        )
    if slot is None:
        return None

    client = FilamentApiClient(base_url=sys_settings.filament_api_url)
    try:
        detected = await client.get_filament(api_printer_id)
    except FilamentApiError as exc:
        logger.warning(
            "FilamentAPI sync failed for printer %s (%s): %s",
            printer.display_name,
            api_printer_id,
            exc,
        )
        return FilamentSyncPrinterResult(
            printer_id=printer.id,
            printer_name=printer.display_name or printer.name,
            filament_api_printer_id=api_printer_id,
            detected_filament=None,
            matched_filament_id=slot.filament_id,
            matched_filament_name=slot.filament.name if slot.filament else None,
            changed=False,
            status="error",
            error=str(exc),
        )

    if detected is None:
        changed = slot.is_loaded or slot.filament_id is not None
        slot.filament_id = None
        slot.filament = None
        slot.is_loaded = False
        return FilamentSyncPrinterResult(
            printer_id=printer.id,
            printer_name=printer.display_name or printer.name,
            filament_api_printer_id=api_printer_id,
            detected_filament=None,
            matched_filament_id=None,
            matched_filament_name=None,
            changed=changed,
            status="unloaded",
        )

    matched = match_filament_in_catalog(db, detected, current_filament=slot.filament)
    if matched is None:
        logger.warning(
            "FilamentAPI detected '%s' on printer %s (%s), but no matching filament exists in catalog",
            detected,
            printer.display_name,
            api_printer_id,
        )
        return FilamentSyncPrinterResult(
            printer_id=printer.id,
            printer_name=printer.display_name or printer.name,
            filament_api_printer_id=api_printer_id,
            detected_filament=detected,
            matched_filament_id=slot.filament_id,
            matched_filament_name=slot.filament.name if slot.filament else None,
            changed=False,
            status="unmatched",
        )

    changed = (slot.filament_id != matched.id) or (not slot.is_loaded)
    slot.filament_id = matched.id
    slot.filament = matched
    slot.is_loaded = True

    return FilamentSyncPrinterResult(
        printer_id=printer.id,
        printer_name=printer.display_name or printer.name,
        filament_api_printer_id=api_printer_id,
        detected_filament=detected,
        matched_filament_id=matched.id,
        matched_filament_name=matched.name,
        changed=changed,
        status="updated" if changed else "unchanged",
    )


async def sync_all_printers_filaments(
    db: Session,
    sys_settings: SystemSettings,
) -> FilamentSyncResponse:
    """Sync loaded filaments for all printers configured with a filament_api_printer_id."""
    if not sys_settings.filament_api_enabled or not (sys_settings.filament_api_url or "").strip():
        return FilamentSyncResponse(synced_count=0, changed_count=0, results=[])

    printers = list(
        db.scalars(
            select(Printer)
            .where(Printer.filament_api_printer_id.is_not(None))
            .options(selectinload(Printer.slots).selectinload(PrinterSlot.filament))
            .order_by(Printer.id.asc())
        )
    )

    results: list[FilamentSyncPrinterResult] = []
    changed_count = 0
    for printer in printers:
        if not (printer.filament_api_printer_id or "").strip():
            continue
        slot1 = next((s for s in printer.slots if s.slot_index == 1), None)
        res = await sync_printer_filament(db, printer, sys_settings, target_slot=slot1)
        if res is not None:
            results.append(res)
            if res.changed:
                changed_count += 1

    if changed_count > 0:
        db.commit()

    return FilamentSyncResponse(
        synced_count=len(results),
        changed_count=changed_count,
        results=results,
    )


async def poll_filament_api_once(db: Session) -> int:
    """Background poller tick to refresh loaded filaments from FilamentAPI."""
    sys_settings = db.get(SystemSettings, 1)
    if sys_settings is None or not sys_settings.filament_api_enabled:
        return 0
    response = await sync_all_printers_filaments(db, sys_settings)
    return response.changed_count
