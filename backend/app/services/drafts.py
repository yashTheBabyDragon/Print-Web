"""Draft lifecycle helpers: file-safe deletion, user draft clearing, and 24h TTL purge."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.models import DRAFT_STATUSES, PrintJob, utcnow

logger = logging.getLogger(__name__)

DRAFT_TTL_HOURS = 24


def _as_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def delete_job_with_files(db: Session, job: PrintJob, *, commit: bool = True) -> None:
    """Safely remove associated STL/G-code files from disk and delete the PrintJob DB row."""
    raw_paths = [job.original_stl_path, job.oriented_stl_path, job.sliced_output_path]
    candidate_dirs: set[Path] = set()

    for raw in raw_paths:
        if not raw:
            continue
        file_path = Path(raw)
        try:
            file_path.unlink(missing_ok=True)
        except OSError as exc:
            logger.warning("Failed to remove job file %s: %s", file_path, exc)
        candidate_dirs.add(file_path.parent)

    try:
        jobs_root = settings.jobs_dir.resolve()
    except OSError:
        jobs_root = None

    if jobs_root is not None:
        for parent in candidate_dirs:
            try:
                resolved_parent = parent.resolve()
                if resolved_parent.parent == jobs_root and resolved_parent.is_dir():
                    if not any(resolved_parent.iterdir()):
                        resolved_parent.rmdir()
            except OSError:
                continue

    db.delete(job)
    if commit:
        db.commit()


def delete_user_drafts(db: Session, user_id: int) -> int:
    """Delete all DRAFT and SLICED jobs (+ files) owned by a user."""
    drafts = list(
        db.scalars(
            select(PrintJob).where(
                PrintJob.user_id == user_id,
                PrintJob.status.in_(DRAFT_STATUSES),
            )
        )
    )
    for job in drafts:
        delete_job_with_files(db, job, commit=False)
    if drafts:
        db.commit()
    return len(drafts)


def purge_expired_drafts(db: Session, max_age_hours: int = DRAFT_TTL_HOURS) -> int:
    """Delete all DRAFT and SLICED jobs older than max_age_hours (based on updated_at or created_at)."""
    cutoff = utcnow() - timedelta(hours=max_age_hours)
    drafts = list(
        db.scalars(select(PrintJob).where(PrintJob.status.in_(DRAFT_STATUSES)))
    )
    expired = [
        job
        for job in drafts
        if _as_utc(job.updated_at or job.created_at) < cutoff
    ]
    for job in expired:
        delete_job_with_files(db, job, commit=False)
    if expired:
        db.commit()
    return len(expired)
