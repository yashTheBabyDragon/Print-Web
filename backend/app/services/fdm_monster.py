"""FDM Monster adapters (mock & live) and background status poller."""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models import (
    JobStatus,
    PrintJob,
    Printer,
    PrinterSlot,
    PrinterStatus,
    PrinterType,
    SystemSettings,
    utcnow,
)
from app.services.notifications import notify_job_completed

logger = logging.getLogger(__name__)


class FdmMonsterError(Exception):
    """Raised when FDM Monster integration fails."""


@dataclass
class RemotePrinterInfo:
    fdm_monster_id: str
    name: str
    printer_type: str
    status: str
    queue_count: int
    bed_x_mm: float
    bed_y_mm: float
    bed_z_mm: float
    mmu_slots_count: int


# In-memory state for MockFdmMonsterAdapter across requests in the same process
_MOCK_JOBS: dict[str, dict[str, str]] = {}

_DEFAULT_MOCK_PRINTERS: list[RemotePrinterInfo] = [
    RemotePrinterInfo(
        fdm_monster_id="klipper-voron-1",
        name="Voron 2.4 — Klipper #1",
        printer_type=PrinterType.KLIPPER.value,
        status=PrinterStatus.IDLE.value,
        queue_count=0,
        bed_x_mm=300.0,
        bed_y_mm=300.0,
        bed_z_mm=300.0,
        mmu_slots_count=4,
    ),
    RemotePrinterInfo(
        fdm_monster_id="klipper-ratrig-1",
        name="RatRig V-Core — Klipper #2",
        printer_type=PrinterType.KLIPPER.value,
        status=PrinterStatus.IDLE.value,
        queue_count=0,
        bed_x_mm=300.0,
        bed_y_mm=300.0,
        bed_z_mm=300.0,
        mmu_slots_count=1,
    ),
    RemotePrinterInfo(
        fdm_monster_id="prusalink-mk4s-1",
        name="Prusa MK4S + MMU3",
        printer_type=PrinterType.PRUSALINK.value,
        status=PrinterStatus.IDLE.value,
        queue_count=0,
        bed_x_mm=250.0,
        bed_y_mm=210.0,
        bed_z_mm=220.0,
        mmu_slots_count=5,
    ),
    RemotePrinterInfo(
        fdm_monster_id="prusalink-coreone-1",
        name="Prusa CORE One + MMU3",
        printer_type=PrinterType.PRUSALINK.value,
        status=PrinterStatus.IDLE.value,
        queue_count=0,
        bed_x_mm=250.0,
        bed_y_mm=220.0,
        bed_z_mm=270.0,
        mmu_slots_count=5,
    ),
    RemotePrinterInfo(
        fdm_monster_id="prusalink-mk35-1",
        name="Prusa MK3.5",
        printer_type=PrinterType.PRUSALINK.value,
        status=PrinterStatus.IDLE.value,
        queue_count=0,
        bed_x_mm=250.0,
        bed_y_mm=210.0,
        bed_z_mm=210.0,
        mmu_slots_count=1,
    ),
]


class MockFdmMonsterAdapter:
    """In-process mock FDM Monster simulator supporting Klipper & PrusaLink printers."""

    async def list_printers(self, db: Optional[Session] = None) -> list[RemotePrinterInfo]:
        results: list[RemotePrinterInfo] = []
        active_by_printer: dict[str, int] = {}
        for meta in _MOCK_JOBS.values():
            if meta["status"] in (JobStatus.QUEUED.value, JobStatus.PRINTING.value):
                pid = meta["fdm_printer_id"]
                active_by_printer[pid] = active_by_printer.get(pid, 0) + 1

        for p in _DEFAULT_MOCK_PRINTERS:
            q_count = active_by_printer.get(p.fdm_monster_id, 0)
            results.append(
                RemotePrinterInfo(
                    fdm_monster_id=p.fdm_monster_id,
                    name=p.name,
                    printer_type=p.printer_type,
                    status=PrinterStatus.PRINTING.value if q_count > 0 else PrinterStatus.IDLE.value,
                    queue_count=q_count,
                    bed_x_mm=p.bed_x_mm,
                    bed_y_mm=p.bed_y_mm,
                    bed_z_mm=p.bed_z_mm,
                    mmu_slots_count=p.mmu_slots_count,
                )
            )
        return results

    async def queue_job(
        self,
        printer: Printer,
        gcode_path: Path,
        job: PrintJob,
    ) -> tuple[str, str]:
        fdm_job_id = f"mock-fdm-{job.id}-{uuid.uuid4().hex[:8]}"
        _MOCK_JOBS[fdm_job_id] = {
            "fdm_printer_id": printer.fdm_monster_id,
            "status": JobStatus.QUEUED.value,
        }
        return fdm_job_id, JobStatus.QUEUED.value

    async def cancel_job(self, fdm_monster_job_id: str) -> None:
        if fdm_monster_job_id in _MOCK_JOBS:
            _MOCK_JOBS[fdm_monster_job_id]["status"] = JobStatus.CANCELLED.value

    async def complete_job(self, fdm_monster_job_id: str) -> None:
        if fdm_monster_job_id in _MOCK_JOBS:
            _MOCK_JOBS[fdm_monster_job_id]["status"] = JobStatus.COMPLETED.value

    async def get_job_status(self, fdm_monster_job_id: str) -> Optional[str]:
        entry = _MOCK_JOBS.get(fdm_monster_job_id)
        return entry["status"] if entry else None


class LiveFdmMonsterAdapter:
    """HTTP client adapter talking to a live FDM Monster v2 instance."""

    def __init__(self, base_url: str, api_key: str) -> None:
        cleaned = base_url.strip().rstrip("/")
        for suffix in ("/api/v2", "/api/v1", "/api"):
            if cleaned.endswith(suffix):
                cleaned = cleaned[: -len(suffix)].rstrip("/")
                break
        self.base_url = cleaned
        self.api_key = api_key.strip()

    def _headers(self) -> dict[str, str]:
        headers: dict[str, str] = {}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    @staticmethod
    def _parse_printer_type(raw_type: object) -> str:
        # FDM Monster v2 PrinterType enum: 0=OctoPrint, 1=Moonraker/Klipper, 2=PrusaLink, 3=BambuLab
        if isinstance(raw_type, int):
            return PrinterType.KLIPPER.value if raw_type == 1 else PrinterType.PRUSALINK.value
        text = str(raw_type or "").lower()
        if text == "1" or "klipper" in text or "moonraker" in text:
            return PrinterType.KLIPPER.value
        return PrinterType.PRUSALINK.value

    @staticmethod
    def _parse_socket_status(socket_data: dict, enabled: bool) -> str:
        if not enabled:
            return PrinterStatus.OFFLINE.value

        # Klipper / Moonraker payload
        notify = socket_data.get("notify_status_update")
        if isinstance(notify, dict):
            payload = notify.get("payload") or {}
            print_stats = payload.get("print_stats") or {}
            state = str(print_stats.get("state", "")).lower()
            if state in ("printing", "paused"):
                return PrinterStatus.PRINTING.value
            if state == "error":
                return PrinterStatus.ERROR.value
            if state in ("standby", "complete", "cancelled", "ready"):
                return PrinterStatus.IDLE.value

        # PrusaLink / OctoPrint payload
        current = socket_data.get("current")
        if isinstance(current, dict):
            payload = current.get("payload") or {}
            state_obj = payload.get("state") or {}
            flags = state_obj.get("flags") or {}
            if flags.get("error"):
                return PrinterStatus.ERROR.value
            if flags.get("printing") or flags.get("paused") or flags.get("pausing"):
                return PrinterStatus.PRINTING.value
            if flags.get("operational") or flags.get("ready"):
                return PrinterStatus.IDLE.value
            if flags.get("closedOrError"):
                return PrinterStatus.OFFLINE.value

        return PrinterStatus.OFFLINE.value

    @staticmethod
    def _split_remote_job_id(fdm_monster_job_id: str) -> tuple[Optional[str], str]:
        if ":" in fdm_monster_job_id:
            printer_id, job_id = fdm_monster_job_id.split(":", 1)
            return printer_id, job_id
        return None, fdm_monster_job_id

    async def list_printers(self) -> list[RemotePrinterInfo]:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(f"{self.base_url}/api/v2/printer", headers=self._headers())
                resp.raise_for_status()
                data = resp.json()

                items = data if isinstance(data, list) else data.get("printers", [])
                printers: list[RemotePrinterInfo] = []

                for item in items:
                    pid = str(item.get("id", item.get("fdm_monster_id")))
                    enabled = bool(item.get("enabled", True))
                    p_type = self._parse_printer_type(
                        item.get("printerType", item.get("type", item.get("printer_type")))
                    )

                    status_val = PrinterStatus.IDLE.value if enabled else PrinterStatus.OFFLINE.value
                    try:
                        sock_resp = await client.get(
                            f"{self.base_url}/api/v2/printer/{pid}/socket",
                            headers=self._headers(),
                        )
                        if sock_resp.status_code == 200:
                            status_val = self._parse_socket_status(sock_resp.json(), enabled)
                    except Exception as sock_exc:
                        logger.debug("Socket fetch failed for FDM Monster printer %s: %s", pid, sock_exc)

                    queue_count = 0
                    try:
                        q_resp = await client.get(
                            f"{self.base_url}/api/v2/print-queue/{pid}",
                            headers=self._headers(),
                        )
                        if q_resp.status_code == 200:
                            q_data = q_resp.json()
                            queue_count = int(q_data.get("count", len(q_data.get("queue", []))))
                    except Exception as q_exc:
                        logger.debug("Queue fetch failed for FDM Monster printer %s: %s", pid, q_exc)

                    default_bed = (300.0, 300.0, 300.0) if p_type == PrinterType.KLIPPER.value else (250.0, 210.0, 220.0)
                    printers.append(
                        RemotePrinterInfo(
                            fdm_monster_id=pid,
                            name=str(item.get("name", f"Printer {pid}")),
                            printer_type=p_type,
                            status=status_val,
                            queue_count=queue_count,
                            bed_x_mm=float(item.get("bed_x_mm", default_bed[0])),
                            bed_y_mm=float(item.get("bed_y_mm", default_bed[1])),
                            bed_z_mm=float(item.get("bed_z_mm", default_bed[2])),
                            mmu_slots_count=int(item.get("mmu_slots_count", 1)),
                        )
                    )
                return printers
        except Exception as exc:
            raise FdmMonsterError(f"Failed to fetch printers from FDM Monster: {exc}") from exc

    async def queue_job(
        self,
        printer: Printer,
        gcode_path: Path,
        job: PrintJob,
    ) -> tuple[str, str]:
        if not gcode_path.exists():
            raise FdmMonsterError("Sliced G-code file missing on disk")
        unique_name = f"ggprint_j{job.id}_{uuid.uuid4().hex[:6]}_{gcode_path.name}"
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                with gcode_path.open("rb") as fh:
                    files = {"file": (unique_name, fh, "application/octet-stream")}
                    upload_resp = await client.post(
                        f"{self.base_url}/api/v2/file-storage/upload",
                        headers=self._headers(),
                        files=files,
                    )
                upload_resp.raise_for_status()
                upload_payload = upload_resp.json()
                file_storage_id = upload_payload.get("fileStorageId") or upload_payload.get("id")
                if not file_storage_id:
                    raise FdmMonsterError("FDM Monster upload did not return fileStorageId")

                queue_resp = await client.post(
                    f"{self.base_url}/api/v2/print-queue/{printer.fdm_monster_id}/from-file",
                    headers=self._headers(),
                    json={"fileStorageId": file_storage_id, "addToQueue": True},
                )
                queue_resp.raise_for_status()
                payload = queue_resp.json()
                job_obj = payload.get("job") if isinstance(payload.get("job"), dict) else payload
                remote_num_id = str(job_obj.get("id") or payload.get("jobId") or job.id)
                remote_id = f"{printer.fdm_monster_id}:{remote_num_id}"
                raw_status = str(job_obj.get("status", "QUEUED")).upper()
                status_val = JobStatus.PRINTING.value if raw_status == "PRINTING" else JobStatus.QUEUED.value
                return remote_id, status_val
        except FdmMonsterError:
            raise
        except Exception as exc:
            raise FdmMonsterError(f"Failed to submit job to FDM Monster: {exc}") from exc

    async def cancel_job(self, fdm_monster_job_id: str) -> None:
        printer_id, job_id = self._split_remote_job_id(fdm_monster_job_id)
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                if printer_id:
                    resp = await client.delete(
                        f"{self.base_url}/api/v2/print-queue/{printer_id}/{job_id}",
                        headers=self._headers(),
                    )
                    if resp.status_code < 400:
                        return
                resp = await client.post(
                    f"{self.base_url}/api/v2/print-jobs/{job_id}/set-cancelled",
                    headers=self._headers(),
                )
                if resp.status_code < 400:
                    return
                if printer_id:
                    stop_resp = await client.post(
                        f"{self.base_url}/api/v2/printer/{printer_id}/job/cancel",
                        headers=self._headers(),
                    )
                    stop_resp.raise_for_status()
                    return
                resp.raise_for_status()
        except Exception as exc:
            raise FdmMonsterError(f"Failed to cancel job on FDM Monster: {exc}") from exc

    async def get_job_status(self, fdm_monster_job_id: str) -> Optional[str]:
        _, job_id = self._split_remote_job_id(fdm_monster_job_id)
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(
                    f"{self.base_url}/api/v2/print-jobs/{job_id}",
                    headers=self._headers(),
                )
                if resp.status_code in (403, 404):
                    return None
                resp.raise_for_status()
                raw = str(resp.json().get("status", "")).upper()
                mapping = {
                    "PENDING": JobStatus.QUEUED.value,
                    "QUEUED": JobStatus.QUEUED.value,
                    "PRINTING": JobStatus.PRINTING.value,
                    "PAUSED": JobStatus.PRINTING.value,
                    "COMPLETED": JobStatus.COMPLETED.value,
                    "SUCCESS": JobStatus.COMPLETED.value,
                    "FINISHED": JobStatus.COMPLETED.value,
                    "DONE": JobStatus.COMPLETED.value,
                    "CANCELLED": JobStatus.CANCELLED.value,
                    "CANCELED": JobStatus.CANCELLED.value,
                    "FAILED": JobStatus.FAILED.value,
                    "ERROR": JobStatus.FAILED.value,
                }
                return mapping.get(raw)
        except Exception as exc:
            logger.warning("FDM Monster status check failed for %s: %s", fdm_monster_job_id, exc)
            return None


def get_fdm_adapter(sys_settings: SystemSettings) -> MockFdmMonsterAdapter | LiveFdmMonsterAdapter:
    if sys_settings.fdm_monster_mode == "live":
        return LiveFdmMonsterAdapter(
            base_url=sys_settings.fdm_monster_url,
            api_key=sys_settings.fdm_monster_api_key,
        )
    return MockFdmMonsterAdapter()


async def poll_fdm_monster_once(db: Session) -> int:
    """Sync active QUEUED/PRINTING jobs and printer statuses from FDM Monster adapter.

    When a job transitions to COMPLETED, CANCELLED, or FAILED, setting its terminal
    status automatically releases its estimated_grams from the student's active budget.
    """
    sys_settings = db.get(SystemSettings, 1)
    if sys_settings is None:
        return 0

    adapter = get_fdm_adapter(sys_settings)
    updated_count = 0

    active_jobs = list(
        db.scalars(
            select(PrintJob)
            .where(
                PrintJob.status.in_([JobStatus.QUEUED.value, JobStatus.PRINTING.value])
            )
            .options(
                selectinload(PrintJob.user),
                selectinload(PrintJob.printer),
                selectinload(PrintJob.slot).selectinload(PrinterSlot.filament),
                selectinload(PrintJob.filament),
            )
        )
    )
    newly_completed_jobs: list[PrintJob] = []
    for job in active_jobs:
        if not job.fdm_monster_job_id:
            continue
        remote_status = await adapter.get_job_status(job.fdm_monster_job_id)
        if remote_status and remote_status != job.status:
            job.status = remote_status
            if remote_status in (
                JobStatus.COMPLETED.value,
                JobStatus.CANCELLED.value,
                JobStatus.FAILED.value,
            ):
                job.completed_at = utcnow()
            if remote_status == JobStatus.COMPLETED.value:
                newly_completed_jobs.append(job)
            updated_count += 1

    try:
        remote_printers = await adapter.list_printers()
        remote_by_id = {rp.fdm_monster_id: rp for rp in remote_printers}
        for printer in db.scalars(select(Printer)):
            rp = remote_by_id.get(printer.fdm_monster_id)
            if rp:
                printer.status = rp.status
                printer.queue_count = rp.queue_count
    except FdmMonsterError as exc:
        logger.debug("Skipping printer status sync: %s", exc)

    db.commit()

    for completed_job in newly_completed_jobs:
        await notify_job_completed(completed_job)

    return updated_count
