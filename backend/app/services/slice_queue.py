"""Bounded FIFO slice queue with configurable worker pool concurrency."""

from __future__ import annotations

import logging
import threading
from collections import deque
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app import database
from app.models import JobStatus, PrintJob, Printer, PrinterSlot
from app.services.budget import get_system_settings
from app.services.slicer import run_slice

logger = logging.getLogger(__name__)


class SliceQueueFullError(Exception):
    """Raised when the bounded slice queue has reached capacity."""


@dataclass(frozen=True)
class SliceTask:
    job_id: int
    printer_id: int
    slot_id: int
    pos_x_mm: float
    pos_y_mm: float
    quat_x: float
    quat_y: float
    quat_z: float
    quat_w: float
    scale: float
    supports_enabled: bool
    gcode_path: str
    task_seq: int = 0


class SliceQueueManager:
    """Thread-pool-backed bounded FIFO queue for background STL slicing."""

    def __init__(self, max_workers: int = 2, max_queue_size: int = 64) -> None:
        self._cond = threading.Condition()
        self._pending: deque[SliceTask] = deque()
        self._active_jobs: set[int] = set()
        self._workers: list[threading.Thread] = []
        self._max_workers = max(1, min(4, int(max_workers)))
        self._max_queue_size = max(1, int(max_queue_size))
        self._running = False
        self._enqueue_seq = 0
        self._done_seq: dict[int, int] = {}
        self._worker_counter = 0

    def _recover_stale_jobs(self) -> None:
        """Reset any interrupted SLICING_QUEUED or SLICING jobs back to DRAFT."""
        try:
            with database.SessionLocal() as db:
                stale_jobs = list(
                    db.scalars(
                        select(PrintJob).where(
                            PrintJob.status.in_([JobStatus.SLICING_QUEUED.value, JobStatus.SLICING.value])
                        )
                    )
                )
                for job in stale_jobs:
                    job.status = JobStatus.DRAFT.value
                if stale_jobs:
                    db.commit()
                    logger.info("Recovered %d stale slicing job(s) back to DRAFT", len(stale_jobs))
        except Exception as exc:
            logger.warning("Failed to recover stale slicing jobs on startup: %s", exc)

    def _spawn_workers_locked(self) -> None:
        self._workers = [w for w in self._workers if w.is_alive()]
        while len(self._workers) < self._max_workers:
            self._worker_counter += 1
            t = threading.Thread(
                target=self._worker_loop,
                name=f"slice-worker-{self._worker_counter}",
                daemon=True,
            )
            self._workers.append(t)
            t.start()

    def start(self, max_workers: int = 2) -> None:
        """Recover stale slicing jobs and start the worker pool."""
        self._recover_stale_jobs()
        with self._cond:
            self._max_workers = max(1, min(4, int(max_workers or 2)))
            self._running = True
            self._spawn_workers_locked()
            self._cond.notify_all()

    def ensure_started(self, max_workers: Optional[int] = None) -> None:
        """Start worker pool if not yet running without touching already-queued jobs."""
        with self._cond:
            if max_workers is not None:
                self._max_workers = max(1, min(4, int(max_workers)))
            if not self._running:
                self._running = True
            self._spawn_workers_locked()
            self._cond.notify_all()

    def stop(self, timeout: float = 5.0) -> None:
        """Stop worker threads cleanly and clear pending queue items."""
        with self._cond:
            self._running = False
            self._pending.clear()
            workers = list(self._workers)
            self._cond.notify_all()

        current = threading.current_thread()
        for w in workers:
            if w is not current and w.is_alive():
                w.join(timeout=timeout)

        with self._cond:
            self._workers = [w for w in self._workers if w.is_alive()]
            self._active_jobs.clear()

    def set_max_workers(self, n: int) -> int:
        """Update worker concurrency (clamped 1..4) dynamically."""
        clamped = max(1, min(4, int(n)))
        with self._cond:
            self._max_workers = clamped
            if self._running:
                self._spawn_workers_locked()
            self._cond.notify_all()
        return clamped

    def enqueue(self, task: SliceTask) -> int:
        """Enqueue a slice task, replacing any waiting task for the same job_id."""
        with self._cond:
            if not self._running:
                self._running = True
            self._spawn_workers_locked()

            self._enqueue_seq += 1
            seq = self._enqueue_seq
            stamped = replace(task, task_seq=seq)

            replaced = False
            for idx, existing in enumerate(self._pending):
                if existing.job_id == stamped.job_id:
                    self._pending[idx] = stamped
                    replaced = True
                    break

            if not replaced:
                if len(self._pending) >= self._max_queue_size:
                    raise SliceQueueFullError("Slice queue is full; please try again shortly")
                self._pending.append(stamped)

            self._cond.notify_all()
            return seq

    def wait_for_job(self, job_id: int, target_seq: Optional[int] = None, timeout: float = 180.0) -> bool:
        """Block until the specified job_id finishes active/queued slicing or timeout expires."""
        with self._cond:
            def _is_done() -> bool:
                if job_id in self._active_jobs:
                    return False
                if any(t.job_id == job_id for t in self._pending):
                    return False
                if target_seq is not None and self._done_seq.get(job_id, 0) < target_seq:
                    return not self._running
                return True

            return self._cond.wait_for(_is_done, timeout=timeout)

    def get_position(self, job_id: int) -> Optional[int]:
        """Return 0 if actively slicing, 1-based queue position if queued, else None."""
        with self._cond:
            if job_id in self._active_jobs:
                return 0
            for idx, task in enumerate(self._pending, start=1):
                if task.job_id == job_id:
                    return idx
            return None

    def stats(self) -> dict[str, int]:
        """Return current worker and queue metrics."""
        with self._cond:
            return {
                "active_workers": len(self._active_jobs),
                "queued_count": len(self._pending),
                "max_workers": self._max_workers,
            }

    def _worker_loop(self) -> None:
        me = threading.current_thread()
        while True:
            task: Optional[SliceTask] = None
            with self._cond:
                while self._running:
                    if len(self._workers) > self._max_workers:
                        if me in self._workers:
                            self._workers.remove(me)
                        return

                    for idx, cand in enumerate(self._pending):
                        if cand.job_id not in self._active_jobs:
                            del self._pending[idx]
                            self._active_jobs.add(cand.job_id)
                            task = cand
                            break

                    if task is not None:
                        break
                    self._cond.wait(timeout=0.5)

                if not self._running and task is None:
                    if me in self._workers:
                        self._workers.remove(me)
                    return

            if task is not None:
                try:
                    self._execute_task(task)
                finally:
                    with self._cond:
                        self._active_jobs.discard(task.job_id)
                        prev = self._done_seq.get(task.job_id, 0)
                        if task.task_seq > prev:
                            self._done_seq[task.job_id] = task.task_seq
                        self._cond.notify_all()

    def _execute_task(self, task: SliceTask) -> None:
        with database.SessionLocal() as db:
            try:
                job = db.get(PrintJob, task.job_id)
                if job is None:
                    return
                if job.status not in (
                    JobStatus.SLICING_QUEUED.value,
                    JobStatus.SLICING.value,
                    JobStatus.DRAFT.value,
                    JobStatus.SLICED.value,
                    JobStatus.SLICE_FAILED.value,
                    JobStatus.REJECTED.value,
                ):
                    return

                printer = db.scalar(
                    select(Printer)
                    .where(Printer.id == task.printer_id)
                    .options(
                        selectinload(Printer.machine_profile),
                        selectinload(Printer.process_profile),
                    )
                )
                slot = db.scalar(
                    select(PrinterSlot)
                    .where(PrinterSlot.id == task.slot_id, PrinterSlot.printer_id == task.printer_id)
                    .options(selectinload(PrinterSlot.filament))
                )
                if printer is None or slot is None:
                    job.status = JobStatus.SLICE_FAILED.value
                    job.slice_error = "Selected printer or filament slot no longer exists"
                    db.commit()
                    return

                sys_settings = get_system_settings(db)
                job.status = JobStatus.SLICING.value
                job.slice_error = None
                db.commit()

                result = run_slice(
                    oriented_stl_path=Path(job.oriented_stl_path),
                    output_gcode_path=Path(task.gcode_path),
                    printer=printer,
                    slot=slot,
                    sys_settings=sys_settings,
                    pos_x_mm=task.pos_x_mm,
                    pos_y_mm=task.pos_y_mm,
                    quat_x=task.quat_x,
                    quat_y=task.quat_y,
                    quat_z=task.quat_z,
                    quat_w=task.quat_w,
                    scale=task.scale,
                    supports_enabled=task.supports_enabled,
                )

                job.printer_id = printer.id
                job.slot_id = slot.id
                job.filament_id = slot.filament_id
                job.pos_x_mm = task.pos_x_mm
                job.pos_y_mm = task.pos_y_mm
                job.quat_x = task.quat_x
                job.quat_y = task.quat_y
                job.quat_z = task.quat_z
                job.quat_w = task.quat_w
                job.scale = task.scale
                job.bbox_min_x = result.bounds.min_x
                job.bbox_max_x = result.bounds.max_x
                job.bbox_min_y = result.bounds.min_y
                job.bbox_max_y = result.bounds.max_y
                job.bbox_min_z = result.bounds.min_z
                job.bbox_max_z = result.bounds.max_z
                job.estimated_grams = result.estimated_grams
                job.estimated_minutes = result.estimated_minutes
                job.layer_count = result.layer_count
                job.supports_enabled = result.supports_enabled
                job.sliced_output_path = str(result.gcode_path)
                job.gcode_filename = result.gcode_filename
                job.slice_error = None
                job.status = JobStatus.SLICED.value
                db.commit()
            except Exception as exc:
                logger.warning("Slice task failed for job %s: %s", task.job_id, exc)
                db.rollback()
                try:
                    failed_job = db.get(PrintJob, task.job_id)
                    if failed_job is not None:
                        failed_job.status = JobStatus.SLICE_FAILED.value
                        failed_job.slice_error = str(exc)[:2000]
                        db.commit()
                except Exception as inner_exc:
                    logger.error("Failed persisting SLICE_FAILED state for job %s: %s", task.job_id, inner_exc)
                    db.rollback()


slice_queue = SliceQueueManager()
