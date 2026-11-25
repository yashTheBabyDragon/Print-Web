"""Active weight budget and print duration policy helpers."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import (
    ACTIVE_BUDGET_STATUSES,
    ClassEnrollment,
    PrintJob,
    SystemSettings,
    TeacherClass,
    User,
)
from app.permissions import get_user_permissions
from app.schemas import BudgetCheckOut, StudentTeacherOut, UserSummary


def _as_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def get_system_settings(db: Session) -> SystemSettings:
    """Fetch the singleton SystemSettings row, creating defaults if missing."""
    row = db.get(SystemSettings, 1)
    if row is None:
        row = SystemSettings(id=1)
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


def get_active_grams_used(
    db: Session,
    user_id: int,
    exclude_job_id: Optional[int] = None,
    budget_reset_at: Optional[datetime] = None,
) -> float:
    """Sum estimated grams of all active budget jobs for a user since budget_reset_at."""
    reset_at = budget_reset_at
    if reset_at is None:
        reset_at = db.scalar(select(User.budget_reset_at).where(User.id == user_id))

    if reset_at is None:
        stmt = select(func.coalesce(func.sum(PrintJob.estimated_grams), 0.0)).where(
            PrintJob.user_id == user_id,
            PrintJob.status.in_(ACTIVE_BUDGET_STATUSES),
        )
        if exclude_job_id is not None:
            stmt = stmt.where(PrintJob.id != exclude_job_id)
        total = db.scalar(stmt)
        return round(float(total or 0.0), 2)

    cutoff = _as_utc(reset_at)
    stmt_rows = select(PrintJob.estimated_grams, PrintJob.created_at).where(
        PrintJob.user_id == user_id,
        PrintJob.status.in_(ACTIVE_BUDGET_STATUSES),
    )
    if exclude_job_id is not None:
        stmt_rows = stmt_rows.where(PrintJob.id != exclude_job_id)

    total_grams = 0.0
    for est_grams, created_at in db.execute(stmt_rows).all():
        if created_at is not None and _as_utc(created_at) >= cutoff:
            total_grams += float(est_grams or 0.0)
    return round(total_grams, 2)


def get_active_job_count(
    db: Session,
    user_id: int,
    exclude_job_id: Optional[int] = None,
    budget_reset_at: Optional[datetime] = None,
) -> int:
    """Count jobs currently occupying an active budget slot since budget_reset_at."""
    reset_at = budget_reset_at
    if reset_at is None:
        reset_at = db.scalar(select(User.budget_reset_at).where(User.id == user_id))

    if reset_at is None:
        stmt = select(func.count(PrintJob.id)).where(
            PrintJob.user_id == user_id,
            PrintJob.status.in_(ACTIVE_BUDGET_STATUSES),
        )
        if exclude_job_id is not None:
            stmt = stmt.where(PrintJob.id != exclude_job_id)
        return int(db.scalar(stmt) or 0)

    cutoff = _as_utc(reset_at)
    stmt_rows = select(PrintJob.created_at).where(
        PrintJob.user_id == user_id,
        PrintJob.status.in_(ACTIVE_BUDGET_STATUSES),
    )
    if exclude_job_id is not None:
        stmt_rows = stmt_rows.where(PrintJob.id != exclude_job_id)

    return sum(
        1
        for (created_at,) in db.execute(stmt_rows).all()
        if created_at is not None and _as_utc(created_at) >= cutoff
    )


def get_effective_limits(user: User, sys_settings: SystemSettings) -> tuple[float, int]:
    """Return (effective_max_active_grams, effective_max_print_minutes) for a user."""
    max_grams = (
        float(user.max_active_grams_override)
        if user.max_active_grams_override is not None
        else float(sys_settings.default_max_active_grams)
    )
    max_minutes = (
        int(user.max_print_minutes_override)
        if user.max_print_minutes_override is not None
        else int(sys_settings.default_max_print_minutes)
    )
    return round(max_grams, 2), max_minutes


def build_user_summary(
    db: Session,
    user: User,
    sys_settings: Optional[SystemSettings] = None,
) -> UserSummary:
    """Construct the UserSummary DTO including live budget usage and student teacher rosters."""
    cfg = sys_settings or get_system_settings(db)
    max_grams, max_minutes = get_effective_limits(user, cfg)
    used_grams = get_active_grams_used(db, user.id)
    available_grams = round(max(0.0, max_grams - used_grams), 2)

    teachers: list[StudentTeacherOut] = []
    if user.role == "student":
        rows = db.execute(
            select(User.id, User.name, TeacherClass.name)
            .select_from(ClassEnrollment)
            .join(TeacherClass, ClassEnrollment.class_id == TeacherClass.id)
            .join(User, TeacherClass.teacher_id == User.id)
            .where(
                ClassEnrollment.da == user.da,
                User.is_active == True,  # noqa: E712
            )
            .order_by(User.id.asc(), TeacherClass.created_at.asc(), TeacherClass.id.asc())
        ).all()
        grouped: dict[int, StudentTeacherOut] = {}
        for t_id, t_name, c_name in rows:
            entry = grouped.get(t_id)
            if entry is None:
                entry = StudentTeacherOut(id=t_id, name=t_name, classes=[])
                grouped[t_id] = entry
            if c_name not in entry.classes:
                entry.classes.append(c_name)
        teachers = list(grouped.values())

    return UserSummary(
        id=user.id,
        da=user.da,
        name=user.name,
        role=user.role,  # type: ignore[arg-type]
        permissions=get_user_permissions(user),
        approval_status=user.approval_status,  # type: ignore[arg-type]
        teachers=teachers,
        is_active=user.is_active,
        effective_max_active_grams=max_grams,
        active_grams_used=used_grams,
        available_grams=available_grams,
        enforce_duration_limit=cfg.enforce_duration_limit,
        effective_max_print_minutes=max_minutes,
        notify_browser=bool(getattr(user, "notify_browser", False)),
        notify_webhook_url=getattr(user, "notify_webhook_url", None),
    )


def compute_budget_check(
    db: Session,
    user: User,
    estimated_grams: float,
    estimated_minutes: int,
    sys_settings: Optional[SystemSettings] = None,
    exclude_job_id: Optional[int] = None,
) -> BudgetCheckOut:
    """Evaluate whether a sliced job fits within the user's active budget and duration limit."""
    cfg = sys_settings or get_system_settings(db)
    max_grams, max_minutes = get_effective_limits(user, cfg)
    active_used = get_active_grams_used(db, user.id, exclude_job_id=exclude_job_id)
    active_count = get_active_job_count(db, user.id, exclude_job_id=exclude_job_id)

    projected_grams = active_used + float(estimated_grams)
    within_grams = projected_grams <= max_grams + 1e-6
    exceeds_grams_by = round(max(0.0, projected_grams - max_grams), 2)

    if cfg.enforce_duration_limit:
        within_duration = int(estimated_minutes) <= max_minutes
        exceeds_minutes_by = max(0, int(estimated_minutes) - max_minutes)
    else:
        within_duration = True
        exceeds_minutes_by = 0

    multiple_ok = cfg.allow_multiple_jobs_within_budget or active_count == 0
    can_auto_submit = bool(within_grams and within_duration and multiple_ok)

    return BudgetCheckOut(
        within_grams=within_grams,
        within_duration=within_duration,
        can_auto_submit=can_auto_submit,
        exceeds_grams_by=exceeds_grams_by,
        exceeds_minutes_by=exceeds_minutes_by,
    )
