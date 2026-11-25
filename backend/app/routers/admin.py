"""Administrator routes (/api/admin)."""

from __future__ import annotations

import csv
import io
import json
import math
import secrets
import string
from collections.abc import Iterable
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.auth import hash_password
from app.database import get_db
from app.models import (
    ClassEnrollment,
    DAWhitelist,
    Filament,
    JobStatus,
    OrcaProfile,
    PrintJob,
    Printer,
    PrinterSlot,
    ProfileKind,
    SystemSettings,
    TeacherClass,
    User,
    utcnow,
)
from app.permissions import (
    PERMISSION_CATALOG,
    PERMISSION_PRESETS,
    Permission,
    get_permissions_for_role,
    get_user_permissions,
    has_permission,
    require_any_permission,
    require_permission,
    resolve_preset,
    validate_permission_keys,
)
from app.schemas import (
    AccountDecisionRequest,
    AdminPrinterOut,
    AdminPrinterPatch,
    AdminStudentOut,
    AdminStudentPatch,
    AdminTeacherCreate,
    AdminTeacherOut,
    AdminTeacherPatch,
    ApprovalDecisionRequest,
    ApprovalsResponse,
    BudgetRefreshRequest,
    BudgetRefreshResult,
    BulkEnrollRequest,
    BulkEnrollResult,
    ClassCsvResult,
    ClassDeleteOut,
    ClassEnrollmentOut,
    ClassStudentRemoveOut,
    FilamentApiHealthOut,
    FilamentApiPrinterOut,
    FilamentApiTestRequest,
    FilamentCreate,
    FilamentOut,
    FilamentPatch,
    FilamentSyncResponse,
    JobDetail,
    OrcaFilamentImportItem,
    OrcaFilamentImportResult,
    OrcaFilamentSkippedItem,
    OrcaProfileOut,
    PendingAccountOut,
    PermissionCatalogItem,
    PermissionCatalogOut,
    PermissionPresetOut,
    PrinterSlotUpdate,
    PrusaProfileImportItem,
    PrusaSlicerImportResult,
    PrusaSlicerPreviewItem,
    PrusaSlicerPreviewResult,
    ResetPasswordRequest,
    ResetPasswordResponse,
    StudentClassBadge,
    SystemSettingsOut,
    SystemSettingsPatch,
    SystemUpdateStatusOut,
    TeacherClassCreate,
    TeacherClassOut,
    TeacherClassPatch,
    TestSliceRequest,
    TestSliceResponse,
    TransferStudentOut,
    TransferStudentRequest,
    UpdateJobStatusOut,
    UpdateTriggerRequest,
    WhitelistCsvResult,
    WhitelistEntryCreate,
    WhitelistEntryOut,
)
from app.services.budget import (
    get_active_grams_used,
    get_effective_limits,
    get_system_settings,
)
from app.services.fdm_monster import FdmMonsterError, get_fdm_adapter
from app.services.filament_api import (
    FilamentApiClient,
    FilamentApiError,
    sync_all_printers_filaments,
)
from app.services.profiles import (
    delete_profile_file,
    extract_orca_filament_entries,
    parse_orca_filament_json,
    read_upload_bounded,
    save_profile_file,
    test_slice_calibration_cube,
)
from app.services.prusaslicer import (
    extract_prusaslicer_ini_entries,
    parse_prusaslicer_ini,
)
from app.services.serializers import (
    serialize_admin_printer,
    serialize_job,
    serialize_settings,
)
from app.services.slicer import SlicerError, validate_orca_cli_path
from app.services.updater import check_latest_github_release, trigger_update

router = APIRouter(prefix="/api/admin", tags=["admin"])

_PROFILE_UPLOAD_MAX_BYTES = 20 * 1024 * 1024  # 20 MB per profile/archive file
_CSV_UPLOAD_MAX_BYTES = 5 * 1024 * 1024  # 5 MB per CSV file


# ---------------------------------------------------------------------------
# Internal Helpers
# ---------------------------------------------------------------------------

def _disable_orphaned_students(db: Session, candidate_das: Iterable[str]) -> int:
    """Disable approved active student accounts that no longer appear in any ClassEnrollment."""
    disabled_count = 0
    for da in sorted(set(candidate_das)):
        has_enrollment = (
            db.scalar(select(ClassEnrollment.id).where(ClassEnrollment.da == da).limit(1)) is not None
        )
        if has_enrollment:
            continue
        student = db.scalar(select(User).where(User.da == da, User.role == "student"))
        if student is not None and student.is_active:
            student.is_active = False
            disabled_count += 1
    return disabled_count


def _reactivate_enrolled_student(db: Session, da: str) -> bool:
    """Re-activate or approve an existing student user when added to a class roster."""
    student = db.scalar(select(User).where(User.da == da, User.role == "student"))
    if student is None or student.approval_status not in ("approved", "pending"):
        return False
    was_inactive_or_pending = (not student.is_active) or (student.approval_status == "pending")
    student.approval_status = "approved"
    student.is_active = True
    student.requested_teacher_id = None
    return was_inactive_or_pending


def _get_or_create_default_individual_class(db: Session, teacher_id: int) -> TeacherClass:
    """Fetch or lazily create a teacher's default 'Individuel / Hors-classe' roster."""
    default_cls = db.scalar(
        select(TeacherClass).where(
            TeacherClass.teacher_id == teacher_id,
            TeacherClass.is_default_individual == True,  # noqa: E712
        )
    )
    if default_cls is None:
        default_cls = db.scalar(
            select(TeacherClass).where(
                TeacherClass.teacher_id == teacher_id,
                TeacherClass.name == "Individuel / Hors-classe",
            )
        )
    if default_cls is None:
        default_cls = TeacherClass(
            teacher_id=teacher_id,
            name="Individuel / Hors-classe",
            code=None,
            is_default_individual=True,
        )
        db.add(default_cls)
        db.flush()
    return default_cls


def _resolve_legacy_whitelist_class(db: Session, caller: User) -> TeacherClass:
    """Resolve a target class for legacy /api/admin/whitelist endpoints."""
    if caller.role == "teacher":
        first_cls = db.scalar(
            select(TeacherClass)
            .where(TeacherClass.teacher_id == caller.id)
            .order_by(TeacherClass.is_default_individual.asc(), TeacherClass.id.asc())
            .limit(1)
        )
        return first_cls or _get_or_create_default_individual_class(db, caller.id)

    teacher_id = db.scalar(
        select(User.id)
        .where(User.role == "teacher", User.is_active == True)  # noqa: E712
        .order_by(User.id.asc())
        .limit(1)
    )
    if teacher_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "TEACHER_REQUIRED", "message": "No active teacher exists to host class roster entries"},
        )
    first_cls = db.scalar(
        select(TeacherClass)
        .where(TeacherClass.teacher_id == teacher_id)
        .order_by(TeacherClass.is_default_individual.asc(), TeacherClass.id.asc())
        .limit(1)
    )
    return first_cls or _get_or_create_default_individual_class(db, teacher_id)


def _serialize_teacher(db: Session, teacher: User) -> AdminTeacherOut:
    class_count = int(
        db.scalar(select(func.count(TeacherClass.id)).where(TeacherClass.teacher_id == teacher.id)) or 0
    )
    student_count = int(
        db.scalar(
            select(func.count(func.distinct(ClassEnrollment.da)))
            .select_from(ClassEnrollment)
            .join(TeacherClass, ClassEnrollment.class_id == TeacherClass.id)
            .where(TeacherClass.teacher_id == teacher.id)
        )
        or 0
    )
    pending_print_approvals = int(
        db.scalar(
            select(func.count(PrintJob.id)).where(
                PrintJob.teacher_id == teacher.id,
                PrintJob.status == JobStatus.PENDING_APPROVAL.value,
            )
        )
        or 0
    )
    pending_account_requests = int(
        db.scalar(
            select(func.count(User.id)).where(
                User.role == "student",
                User.approval_status == "pending",
                User.requested_teacher_id == teacher.id,
            )
        )
        or 0
    )
    return AdminTeacherOut(
        id=teacher.id,
        da=teacher.da,
        name=teacher.name,
        is_active=teacher.is_active,
        permissions=get_user_permissions(teacher),
        has_custom_permissions=teacher.permissions_json is not None,
        class_count=class_count,
        student_count=student_count,
        pending_print_approvals=pending_print_approvals,
        pending_account_requests=pending_account_requests,
        created_at=teacher.created_at,
    )


def _serialize_teacher_class(db: Session, tc: TeacherClass) -> TeacherClassOut:
    enrollments = sorted(tc.enrollments, key=lambda e: (e.da, e.id))
    das = [e.da for e in enrollments]
    users_by_da: dict[str, User] = {}
    if das:
        users_by_da = {
            u.da: u
            for u in db.scalars(select(User).where(User.da.in_(das), User.role == "student"))
        }
    sys_settings = get_system_settings(db) if users_by_da else None
    out_enrollments: list[ClassEnrollmentOut] = []
    registered_count = 0
    for e in enrollments:
        stu = users_by_da.get(e.da)
        eff_g: Optional[float] = None
        used_g: Optional[float] = None
        eff_m: Optional[int] = None
        if stu is not None and sys_settings is not None:
            registered_count += 1
            eff_g, eff_m = get_effective_limits(stu, sys_settings)
            used_g = get_active_grams_used(db, stu.id)
        out_enrollments.append(
            ClassEnrollmentOut(
                id=e.id,
                class_id=e.class_id,
                da=e.da,
                suggested_name=e.suggested_name,
                max_active_grams_override=e.max_active_grams_override,
                max_print_minutes_override=e.max_print_minutes_override,
                is_registered=stu is not None,
                is_active=stu.is_active if stu is not None else None,
                user_id=stu.id if stu is not None else None,
                registered_name=stu.name if stu is not None else None,
                effective_max_active_grams=eff_g,
                active_grams_used=used_g,
                effective_max_print_minutes=eff_m,
                created_at=e.created_at,
            )
        )
    enrolled_count = len(out_enrollments)
    return TeacherClassOut(
        id=tc.id,
        teacher_id=tc.teacher_id,
        teacher_name=tc.teacher.name if tc.teacher else "",
        name=tc.name,
        code=tc.code,
        description=tc.description,
        default_max_active_grams=tc.default_max_active_grams,
        default_max_print_minutes=tc.default_max_print_minutes,
        is_default_individual=tc.is_default_individual,
        student_count=enrolled_count,
        enrolled_count=enrolled_count,
        registered_count=registered_count,
        unclaimed_count=enrolled_count - registered_count,
        enrollments=out_enrollments,
        created_at=tc.created_at,
    )


def _build_student_classes_map(db: Session, das: list[str]) -> dict[str, list[StudentClassBadge]]:
    if not das:
        return {}
    rows = db.execute(
        select(
            ClassEnrollment.da,
            TeacherClass.id,
            TeacherClass.name,
            User.id,
            User.name,
        )
        .select_from(ClassEnrollment)
        .join(TeacherClass, ClassEnrollment.class_id == TeacherClass.id)
        .join(User, TeacherClass.teacher_id == User.id)
        .where(ClassEnrollment.da.in_(das))
        .order_by(User.name.asc(), TeacherClass.name.asc(), TeacherClass.id.asc())
    ).all()
    mapping: dict[str, list[StudentClassBadge]] = {}
    for s_da, c_id, c_name, t_id, t_name in rows:
        mapping.setdefault(s_da, []).append(
            StudentClassBadge(
                class_id=c_id,
                class_name=c_name,
                teacher_id=t_id,
                teacher_name=t_name,
            )
        )
    return mapping


def _serialize_admin_student(
    db: Session,
    user: User,
    sys_settings: SystemSettings,
    classes: list[StudentClassBadge],
    total_jobs: int,
) -> AdminStudentOut:
    eff_g, eff_m = get_effective_limits(user, sys_settings)
    used_g = get_active_grams_used(db, user.id)
    return AdminStudentOut(
        id=user.id,
        da=user.da,
        name=user.name,
        role=user.role,
        approval_status=user.approval_status,
        classes=classes,
        is_active=user.is_active,
        max_active_grams_override=user.max_active_grams_override,
        max_print_minutes_override=user.max_print_minutes_override,
        effective_max_active_grams=eff_g,
        active_grams_used=used_g,
        available_grams=round(max(0.0, eff_g - used_g), 2),
        effective_max_print_minutes=eff_m,
        total_jobs=total_jobs,
        created_at=user.created_at,
    )


def _serialize_pending_account(user: User) -> PendingAccountOut:
    return PendingAccountOut(
        id=user.id,
        da=user.da,
        name=user.name,
        requested_teacher_id=user.requested_teacher_id,
        requested_teacher_name=user.requested_teacher.name if user.requested_teacher else None,
        approval_status=user.approval_status,
        created_at=user.created_at,
    )


def _ensure_teacher_owns_student(db: Session, teacher_id: int, student_da: str) -> None:
    in_my_class = (
        db.scalar(
            select(ClassEnrollment.id)
            .join(TeacherClass, ClassEnrollment.class_id == TeacherClass.id)
            .where(
                ClassEnrollment.da == student_da,
                TeacherClass.teacher_id == teacher_id,
            )
            .limit(1)
        )
        is not None
    )
    if not in_my_class:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "FORBIDDEN", "message": "Student is not enrolled in your classes"},
        )


# ---------------------------------------------------------------------------
# Printers & MMU Slots (Admin Only)
# ---------------------------------------------------------------------------

@router.get("/printers", response_model=list[AdminPrinterOut])
async def admin_list_printers(
    _admin: User = Depends(require_permission(Permission.PRINTERS_MANAGE)),
    db: Session = Depends(get_db),
) -> list[AdminPrinterOut]:
    sys_settings = get_system_settings(db)
    adapter = get_fdm_adapter(sys_settings)
    try:
        remote_map = {rp.fdm_monster_id: rp for rp in await adapter.list_printers()}
    except FdmMonsterError:
        remote_map = {}

    printers = list(
        db.scalars(
            select(Printer)
            .options(selectinload(Printer.slots).selectinload(PrinterSlot.filament))
            .order_by(Printer.id.asc())
        )
    )
    for p in printers:
        rp = remote_map.get(p.fdm_monster_id)
        if rp:
            p.status = rp.status
            p.queue_count = rp.queue_count
    return [serialize_admin_printer(p) for p in printers]


@router.post("/printers/sync", response_model=list[AdminPrinterOut])
async def admin_sync_printers(
    _admin: User = Depends(require_permission(Permission.PRINTERS_MANAGE)),
    db: Session = Depends(get_db),
) -> list[AdminPrinterOut]:
    sys_settings = get_system_settings(db)
    adapter = get_fdm_adapter(sys_settings)
    try:
        remote_printers = await adapter.list_printers()
    except FdmMonsterError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"code": "FDM_MONSTER_ERROR", "message": str(exc)},
        ) from exc

    remote_ids = {rp.fdm_monster_id for rp in remote_printers}
    existing_printers = list(db.scalars(select(Printer)))
    for old_printer in existing_printers:
        if old_printer.fdm_monster_id not in remote_ids:
            active_jobs = int(
                db.scalar(
                    select(func.count(PrintJob.id)).where(
                        PrintJob.printer_id == old_printer.id,
                        PrintJob.status.in_(
                            (
                                JobStatus.PENDING_APPROVAL.value,
                                JobStatus.QUEUED.value,
                                JobStatus.PRINTING.value,
                            )
                        ),
                    )
                )
                or 0
            )
            if active_jobs > 0:
                old_printer.is_enabled = False
            else:
                stale_jobs = list(
                    db.scalars(select(PrintJob).where(PrintJob.printer_id == old_printer.id))
                )
                for sj in stale_jobs:
                    db.delete(sj)
                db.flush()
                db.delete(old_printer)
    db.flush()

    for rp in remote_printers:
        existing = db.scalar(select(Printer).where(Printer.fdm_monster_id == rp.fdm_monster_id))
        if existing is None:
            printer = Printer(
                name=rp.name,
                display_name=rp.name,
                fdm_monster_id=rp.fdm_monster_id,
                printer_type=rp.printer_type,
                status=rp.status,
                queue_count=rp.queue_count,
                is_enabled=True,
                bed_x_mm=rp.bed_x_mm,
                bed_y_mm=rp.bed_y_mm,
                bed_z_mm=rp.bed_z_mm,
                mmu_slots_count=rp.mmu_slots_count,
            )
            db.add(printer)
            db.flush()
            for idx in range(1, rp.mmu_slots_count + 1):
                db.add(
                    PrinterSlot(
                        printer_id=printer.id,
                        slot_index=idx,
                        label=f"Slot {idx}" if rp.mmu_slots_count > 1 else "Extrudeur",
                        is_loaded=True,
                    )
                )
        else:
            existing.name = rp.name
            existing.printer_type = rp.printer_type
            existing.status = rp.status
            existing.queue_count = rp.queue_count
    db.commit()

    printers = list(
        db.scalars(
            select(Printer)
            .options(selectinload(Printer.slots).selectinload(PrinterSlot.filament))
            .order_by(Printer.id.asc())
        )
    )
    return [serialize_admin_printer(p) for p in printers]


@router.delete("/printers/{printer_id}", status_code=status.HTTP_204_NO_CONTENT)
def admin_delete_printer(
    printer_id: int,
    _admin: User = Depends(require_permission(Permission.PRINTERS_MANAGE)),
    db: Session = Depends(get_db),
) -> None:
    printer = db.get(Printer, printer_id)
    if printer is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Printer not found")

    active_jobs = int(
        db.scalar(
            select(func.count(PrintJob.id)).where(
                PrintJob.printer_id == printer.id,
                PrintJob.status.in_(
                    (
                        JobStatus.PENDING_APPROVAL.value,
                        JobStatus.QUEUED.value,
                        JobStatus.PRINTING.value,
                    )
                ),
            )
        )
        or 0
    )
    if active_jobs > 0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "PRINTER_HAS_ACTIVE_JOBS",
                "message": "Impossible de supprimer une imprimante avec des impressions actives ou en attente.",
            },
        )

    stale_jobs = list(db.scalars(select(PrintJob).where(PrintJob.printer_id == printer.id)))
    for sj in stale_jobs:
        db.delete(sj)
    db.flush()
    db.delete(printer)
    db.commit()


@router.patch("/printers/{printer_id}", response_model=AdminPrinterOut)
def admin_patch_printer(
    printer_id: int,
    body: AdminPrinterPatch,
    _admin: User = Depends(require_permission(Permission.PRINTERS_MANAGE)),
    db: Session = Depends(get_db),
) -> AdminPrinterOut:
    printer = db.scalar(
        select(Printer)
        .where(Printer.id == printer_id)
        .options(selectinload(Printer.slots).selectinload(PrinterSlot.filament))
    )
    if printer is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Printer not found")

    fields = body.model_fields_set
    if "is_enabled" in fields and body.is_enabled is not None:
        printer.is_enabled = body.is_enabled
    if "display_name" in fields and body.display_name is not None:
        printer.display_name = body.display_name.strip()
    if "bed_x_mm" in fields and body.bed_x_mm is not None:
        printer.bed_x_mm = body.bed_x_mm
    if "bed_y_mm" in fields and body.bed_y_mm is not None:
        printer.bed_y_mm = body.bed_y_mm
    if "bed_z_mm" in fields and body.bed_z_mm is not None:
        printer.bed_z_mm = body.bed_z_mm
    if "machine_profile_id" in fields:
        printer.machine_profile_id = body.machine_profile_id
    if "process_profile_id" in fields:
        printer.process_profile_id = body.process_profile_id
    if "filament_api_printer_id" in fields:
        cleaned_api_id = (body.filament_api_printer_id or "").strip()
        printer.filament_api_printer_id = cleaned_api_id or None

    if "mmu_slots_count" in fields and body.mmu_slots_count is not None:
        target_count = body.mmu_slots_count
        printer.mmu_slots_count = target_count
        existing_by_idx = {s.slot_index: s for s in printer.slots}
        for idx in range(1, target_count + 1):
            if idx not in existing_by_idx:
                db.add(
                    PrinterSlot(
                        printer_id=printer.id,
                        slot_index=idx,
                        label=f"Slot {idx}" if target_count > 1 else "Extrudeur",
                        is_loaded=False,
                    )
                )
        for idx, slot in list(existing_by_idx.items()):
            if idx > target_count:
                in_use = db.scalar(select(func.count(PrintJob.id)).where(PrintJob.slot_id == slot.id))
                if not in_use:
                    db.delete(slot)

    db.commit()
    db.refresh(printer)
    refreshed = db.scalar(
        select(Printer)
        .where(Printer.id == printer_id)
        .options(selectinload(Printer.slots).selectinload(PrinterSlot.filament))
    )
    return serialize_admin_printer(refreshed)  # type: ignore[arg-type]


@router.put("/printers/{printer_id}/slots/{slot_index}", response_model=AdminPrinterOut)
def admin_update_printer_slot(
    printer_id: int,
    slot_index: int,
    body: PrinterSlotUpdate,
    _admin: User = Depends(require_permission(Permission.PRINTERS_MANAGE)),
    db: Session = Depends(get_db),
) -> AdminPrinterOut:
    printer = db.get(Printer, printer_id)
    if printer is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Printer not found")

    if body.filament_id is not None and db.get(Filament, body.filament_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Filament not found")

    slot = db.scalar(
        select(PrinterSlot).where(
            PrinterSlot.printer_id == printer_id,
            PrinterSlot.slot_index == slot_index,
        )
    )
    if slot is None:
        slot = PrinterSlot(
            printer_id=printer_id,
            slot_index=slot_index,
            label=body.label or f"Slot {slot_index}",
            filament_id=body.filament_id,
            is_loaded=body.is_loaded,
        )
        db.add(slot)
    else:
        slot.filament_id = body.filament_id
        if body.label is not None:
            slot.label = body.label
        slot.is_loaded = body.is_loaded

    db.commit()
    refreshed = db.scalar(
        select(Printer)
        .where(Printer.id == printer_id)
        .options(selectinload(Printer.slots).selectinload(PrinterSlot.filament))
    )
    return serialize_admin_printer(refreshed)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Filaments & OrcaSlicer Profiles (Admin Only)
# ---------------------------------------------------------------------------

@router.get("/filaments", response_model=list[FilamentOut])
def admin_list_filaments(
    _admin: User = Depends(require_permission(Permission.FILAMENTS_MANAGE)),
    db: Session = Depends(get_db),
) -> list[FilamentOut]:
    filaments = list(db.scalars(select(Filament).order_by(Filament.id.asc())))
    return [FilamentOut.model_validate(f) for f in filaments]


@router.post("/filaments", response_model=FilamentOut, status_code=status.HTTP_201_CREATED)
def admin_create_filament(
    body: FilamentCreate,
    _admin: User = Depends(require_permission(Permission.FILAMENTS_MANAGE)),
    db: Session = Depends(get_db),
) -> FilamentOut:
    filament = Filament(
        name=body.name.strip(),
        material=body.material.strip().upper(),
        color_hex=body.color_hex.strip(),
        density_g_cm3=body.density_g_cm3,
        filament_profile_id=body.filament_profile_id,
        process_override_profile_id=body.process_override_profile_id,
        is_active=True,
    )
    db.add(filament)
    db.commit()
    db.refresh(filament)
    return FilamentOut.model_validate(filament)


@router.post("/filaments/import-orca", response_model=OrcaFilamentImportResult)
async def admin_import_orca_filaments(
    files: list[UploadFile] = File(default=[]),
    update_existing: bool = Form(default=True),
    default_color_hex: Optional[str] = Form(default=None),
    _admin: User = Depends(require_permission(Permission.FILAMENTS_MANAGE)),
    db: Session = Depends(get_db),
) -> OrcaFilamentImportResult:
    """Import one or more OrcaSlicer filament profiles (.json, .orca_filament, or .zip)."""
    if not files:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "NO_FILES", "message": "At least one filament file is required"},
        )

    imported: list[OrcaFilamentImportItem] = []
    skipped: list[OrcaFilamentSkippedItem] = []
    created_count = 0
    updated_count = 0

    for upload in files:
        upload_name = Path(upload.filename or "filament.json").name
        raw = await read_upload_bounded(upload, _PROFILE_UPLOAD_MAX_BYTES)
        try:
            entries = extract_orca_filament_entries(upload_name, raw)
        except ValueError as exc:
            skipped.append(OrcaFilamentSkippedItem(filename=upload_name, reason=str(exc)))
            continue

        for entry_name, entry_bytes in entries:
            try:
                parsed = parse_orca_filament_json(
                    entry_name,
                    entry_bytes,
                    default_color_hex=default_color_hex,
                )
            except ValueError as exc:
                skipped.append(OrcaFilamentSkippedItem(filename=entry_name, reason=str(exc)))
                continue

            existing_filament = db.scalar(
                select(Filament).where(func.lower(Filament.name) == parsed.name.lower())
            )
            if existing_filament is not None and not update_existing:
                skipped.append(
                    OrcaFilamentSkippedItem(
                        filename=entry_name,
                        reason=f"Filament '{parsed.name}' already exists",
                    )
                )
                continue

            try:
                stored_path = save_profile_file(
                    entry_name,
                    entry_bytes,
                    kind=ProfileKind.FILAMENT.value,
                )
            except ValueError as exc:
                skipped.append(OrcaFilamentSkippedItem(filename=entry_name, reason=str(exc)))
                continue

            if existing_filament is not None:
                profile: Optional[OrcaProfile] = (
                    db.get(OrcaProfile, existing_filament.filament_profile_id)
                    if existing_filament.filament_profile_id is not None
                    else None
                )
                if profile is not None:
                    delete_profile_file(profile)
                    profile.name = parsed.name
                    profile.filename = entry_name
                    profile.file_path = str(stored_path)
                    profile.notes = parsed.notes
                else:
                    profile = OrcaProfile(
                        name=parsed.name,
                        kind=ProfileKind.FILAMENT.value,
                        filename=entry_name,
                        file_path=str(stored_path),
                        notes=parsed.notes,
                    )
                    db.add(profile)
                    db.flush()

                existing_filament.name = parsed.name
                existing_filament.material = parsed.material
                existing_filament.color_hex = parsed.color_hex
                existing_filament.density_g_cm3 = parsed.density_g_cm3
                existing_filament.filament_profile_id = profile.id
                existing_filament.is_active = True
                db.flush()
                db.refresh(profile)
                db.refresh(existing_filament)

                updated_count += 1
                imported.append(
                    OrcaFilamentImportItem(
                        filament=FilamentOut.model_validate(existing_filament),
                        profile=OrcaProfileOut.model_validate(profile),
                        action="updated",
                        filename=entry_name,
                    )
                )
            else:
                profile = OrcaProfile(
                    name=parsed.name,
                    kind=ProfileKind.FILAMENT.value,
                    filename=entry_name,
                    file_path=str(stored_path),
                    notes=parsed.notes,
                )
                db.add(profile)
                db.flush()

                filament = Filament(
                    name=parsed.name,
                    material=parsed.material,
                    color_hex=parsed.color_hex,
                    density_g_cm3=parsed.density_g_cm3,
                    filament_profile_id=profile.id,
                    is_active=True,
                )
                db.add(filament)
                db.flush()
                db.refresh(profile)
                db.refresh(filament)

                created_count += 1
                imported.append(
                    OrcaFilamentImportItem(
                        filament=FilamentOut.model_validate(filament),
                        profile=OrcaProfileOut.model_validate(profile),
                        action="created",
                        filename=entry_name,
                    )
                )

    db.commit()
    return OrcaFilamentImportResult(
        imported=imported,
        skipped=skipped,
        created_count=created_count,
        updated_count=updated_count,
        skipped_count=len(skipped),
    )


@router.patch("/filaments/{filament_id}", response_model=FilamentOut)
def admin_patch_filament(
    filament_id: int,
    body: FilamentPatch,
    _admin: User = Depends(require_permission(Permission.FILAMENTS_MANAGE)),
    db: Session = Depends(get_db),
) -> FilamentOut:
    filament = db.get(Filament, filament_id)
    if filament is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Filament not found")

    fields = body.model_fields_set
    if "name" in fields and body.name is not None:
        filament.name = body.name.strip()
    if "material" in fields and body.material is not None:
        filament.material = body.material.strip().upper()
    if "color_hex" in fields and body.color_hex is not None:
        filament.color_hex = body.color_hex.strip()
    if "density_g_cm3" in fields and body.density_g_cm3 is not None:
        filament.density_g_cm3 = body.density_g_cm3
    if "filament_profile_id" in fields:
        filament.filament_profile_id = body.filament_profile_id
    if "process_override_profile_id" in fields:
        filament.process_override_profile_id = body.process_override_profile_id
    if "is_active" in fields and body.is_active is not None:
        filament.is_active = body.is_active

    db.commit()
    db.refresh(filament)
    return FilamentOut.model_validate(filament)


@router.delete("/filaments/{filament_id}", status_code=status.HTTP_204_NO_CONTENT)
def admin_delete_filament(
    filament_id: int,
    _admin: User = Depends(require_permission(Permission.FILAMENTS_MANAGE)),
    db: Session = Depends(get_db),
) -> None:
    filament = db.get(Filament, filament_id)
    if filament is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Filament not found")
    db.delete(filament)
    db.commit()


@router.get("/profiles", response_model=list[OrcaProfileOut])
def admin_list_profiles(
    _admin: User = Depends(require_permission(Permission.PROFILES_MANAGE)),
    db: Session = Depends(get_db),
) -> list[OrcaProfileOut]:
    profiles = list(db.scalars(select(OrcaProfile).order_by(OrcaProfile.kind.asc(), OrcaProfile.id.asc())))
    return [OrcaProfileOut.model_validate(p) for p in profiles]


@router.post("/profiles", response_model=OrcaProfileOut, status_code=status.HTTP_201_CREATED)
async def admin_upload_profile(
    file: UploadFile = File(...),
    name: str = Form(...),
    kind: str = Form(...),
    notes: Optional[str] = Form(default=None),
    _admin: User = Depends(require_permission(Permission.PROFILES_MANAGE)),
    db: Session = Depends(get_db),
) -> OrcaProfileOut:
    valid_kinds = {k.value for k in ProfileKind}
    if kind not in valid_kinds:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "INVALID_PROFILE_KIND", "message": f"kind must be one of {sorted(valid_kinds)}"},
        )

    filename = Path(file.filename or "profile.json").name
    if not filename.lower().endswith(".json"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "INVALID_FILE_TYPE", "message": "OrcaSlicer profile must be a .json file"},
        )

    raw = await read_upload_bounded(file, _PROFILE_UPLOAD_MAX_BYTES)
    try:
        stored_path = save_profile_file(filename, raw)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "INVALID_JSON", "message": str(exc)},
        ) from exc

    profile = OrcaProfile(
        name=name.strip(),
        kind=kind,
        filename=filename,
        file_path=str(stored_path),
        notes=notes.strip() if notes else None,
    )
    db.add(profile)
    db.commit()
    db.refresh(profile)
    return OrcaProfileOut.model_validate(profile)


@router.delete("/profiles/{profile_id}", status_code=status.HTTP_204_NO_CONTENT)
def admin_delete_profile(
    profile_id: int,
    _admin: User = Depends(require_permission(Permission.PROFILES_MANAGE)),
    db: Session = Depends(get_db),
) -> None:
    profile = db.get(OrcaProfile, profile_id)
    if profile is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Profile not found")
    delete_profile_file(profile)
    db.delete(profile)
    db.commit()


@router.post("/profiles/preview-prusaslicer", response_model=PrusaSlicerPreviewResult)
async def admin_preview_prusaslicer(
    files: list[UploadFile] = File(default=[]),
    caller: User = Depends(require_any_permission(Permission.FILAMENTS_MANAGE, Permission.PROFILES_MANAGE)),
    db: Session = Depends(get_db),
) -> PrusaSlicerPreviewResult:
    """Inspect PrusaSlicer .ini / .zip files and return selectable items without modifying the DB."""
    if not files:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "NO_FILES", "message": "At least one .ini or .zip file is required"},
        )

    can_filaments = has_permission(caller, Permission.FILAMENTS_MANAGE)
    can_profiles = has_permission(caller, Permission.PROFILES_MANAGE)

    existing_filament_names = {
        name.lower() for name in db.scalars(select(Filament.name))
    }
    existing_profile_keys = {
        (kind, name.lower())
        for kind, name in db.execute(select(OrcaProfile.kind, OrcaProfile.name)).all()
    }

    items: list[PrusaSlicerPreviewItem] = []
    skipped: list[OrcaFilamentSkippedItem] = []
    seen_keys: set[str] = set()
    filament_count = 0
    process_count = 0
    machine_count = 0

    for upload in files:
        upload_name = Path(upload.filename or "config.ini").name
        raw = await read_upload_bounded(upload, _PROFILE_UPLOAD_MAX_BYTES)
        try:
            ini_entries = extract_prusaslicer_ini_entries(upload_name, raw)
        except ValueError as exc:
            skipped.append(OrcaFilamentSkippedItem(filename=upload_name, reason=str(exc)))
            continue

        for entry_name, entry_bytes in ini_entries:
            try:
                converted_list = parse_prusaslicer_ini(entry_name, entry_bytes)
            except ValueError as exc:
                skipped.append(OrcaFilamentSkippedItem(filename=entry_name, reason=str(exc)))
                continue

            for item in converted_list:
                if item.kind == "filament" and not can_filaments:
                    continue
                if item.kind in ("process", "machine") and not can_profiles:
                    continue

                item_key = f"{item.kind}::{item.name}"
                if item_key in seen_keys:
                    continue
                seen_keys.add(item_key)

                if item.kind == "filament":
                    filament_count += 1
                    already_exists = item.name.lower() in existing_filament_names
                    items.append(
                        PrusaSlicerPreviewItem(
                            key=item_key,
                            kind="filament",
                            name=item.name,
                            filename=entry_name,
                            already_exists=already_exists,
                            material=item.material,
                            density_g_cm3=item.density_g_cm3,
                            color_hex=item.color_hex,
                        )
                    )
                else:
                    if item.kind == "process":
                        process_count += 1
                    else:
                        machine_count += 1
                    already_exists = (item.kind, item.name.lower()) in existing_profile_keys
                    items.append(
                        PrusaSlicerPreviewItem(
                            key=item_key,
                            kind=item.kind,
                            name=item.name,
                            filename=entry_name,
                            already_exists=already_exists,
                        )
                    )

    return PrusaSlicerPreviewResult(
        items=items,
        skipped=skipped,
        filament_count=filament_count,
        process_count=process_count,
        machine_count=machine_count,
        skipped_count=len(skipped),
    )


@router.post("/profiles/import-prusaslicer", response_model=PrusaSlicerImportResult)
async def admin_import_prusaslicer(
    files: list[UploadFile] = File(default=[]),
    import_filaments: bool = Form(default=True),
    import_processes: bool = Form(default=True),
    import_machines: bool = Form(default=True),
    update_existing: bool = Form(default=True),
    selected_keys: Optional[str] = Form(default=None),
    caller: User = Depends(require_any_permission(Permission.FILAMENTS_MANAGE, Permission.PROFILES_MANAGE)),
    db: Session = Depends(get_db),
) -> PrusaSlicerImportResult:
    """Import PrusaSlicer .ini config bundles, flat .ini configs, or .zip archives."""
    if not files:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "NO_FILES", "message": "At least one .ini or .zip file is required"},
        )

    selected_set: Optional[set[str]] = None
    if selected_keys is not None:
        try:
            parsed_keys = json.loads(selected_keys)
            if not isinstance(parsed_keys, list) or not all(isinstance(k, str) for k in parsed_keys):
                raise ValueError("selected_keys must be a JSON array of strings")
            selected_set = set(parsed_keys)
        except (ValueError, TypeError) as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"code": "INVALID_SELECTION", "message": f"Invalid selected_keys payload: {exc}"},
            ) from exc

    can_filaments = has_permission(caller, Permission.FILAMENTS_MANAGE)
    can_profiles = has_permission(caller, Permission.PROFILES_MANAGE)

    imported_filaments: list[OrcaFilamentImportItem] = []
    imported_profiles: list[PrusaProfileImportItem] = []
    skipped: list[OrcaFilamentSkippedItem] = []
    filaments_created = 0
    filaments_updated = 0
    profiles_created = 0
    profiles_updated = 0

    for upload in files:
        upload_name = Path(upload.filename or "config.ini").name
        raw = await read_upload_bounded(upload, _PROFILE_UPLOAD_MAX_BYTES)
        try:
            ini_entries = extract_prusaslicer_ini_entries(upload_name, raw)
        except ValueError as exc:
            skipped.append(OrcaFilamentSkippedItem(filename=upload_name, reason=str(exc)))
            continue

        for entry_name, entry_bytes in ini_entries:
            try:
                converted_list = parse_prusaslicer_ini(entry_name, entry_bytes)
            except ValueError as exc:
                skipped.append(OrcaFilamentSkippedItem(filename=entry_name, reason=str(exc)))
                continue

            for item in converted_list:
                item_key = f"{item.kind}::{item.name}"
                if selected_set is not None and item_key not in selected_set:
                    continue
                if item.kind == "filament":
                    if not import_filaments:
                        continue
                    if not can_filaments:
                        skipped.append(
                            OrcaFilamentSkippedItem(
                                filename=f"{entry_name} ({item.name})",
                                reason="Missing 'filaments:manage' permission",
                            )
                        )
                        continue
                elif item.kind == "process":
                    if not import_processes:
                        continue
                    if not can_profiles:
                        skipped.append(
                            OrcaFilamentSkippedItem(
                                filename=f"{entry_name} ({item.name})",
                                reason="Missing 'profiles:manage' permission",
                            )
                        )
                        continue
                elif item.kind == "machine":
                    if not import_machines:
                        continue
                    if not can_profiles:
                        skipped.append(
                            OrcaFilamentSkippedItem(
                                filename=f"{entry_name} ({item.name})",
                                reason="Missing 'profiles:manage' permission",
                            )
                        )
                        continue

                json_bytes = json.dumps(item.orca_json, indent=2).encode("utf-8")

                if item.kind == "filament":
                    existing_filament = db.scalar(
                        select(Filament).where(func.lower(Filament.name) == item.name.lower())
                    )
                    if existing_filament is not None and not update_existing:
                        skipped.append(
                            OrcaFilamentSkippedItem(
                                filename=f"{entry_name} ({item.name})",
                                reason=f"Filament '{item.name}' already exists",
                            )
                        )
                        continue

                    stored_path = save_profile_file(
                        item.filename,
                        json_bytes,
                        kind=ProfileKind.FILAMENT.value,
                    )

                    if existing_filament is not None:
                        profile: Optional[OrcaProfile] = (
                            db.get(OrcaProfile, existing_filament.filament_profile_id)
                            if existing_filament.filament_profile_id is not None
                            else None
                        )
                        if profile is not None:
                            delete_profile_file(profile)
                            profile.name = item.name
                            profile.filename = item.filename
                            profile.file_path = str(stored_path)
                            profile.notes = item.notes
                        else:
                            profile = OrcaProfile(
                                name=item.name,
                                kind=ProfileKind.FILAMENT.value,
                                filename=item.filename,
                                file_path=str(stored_path),
                                notes=item.notes,
                            )
                            db.add(profile)
                            db.flush()

                        existing_filament.name = item.name
                        existing_filament.material = item.material
                        existing_filament.color_hex = item.color_hex
                        existing_filament.density_g_cm3 = item.density_g_cm3
                        existing_filament.filament_profile_id = profile.id
                        existing_filament.is_active = True
                        db.flush()
                        db.refresh(profile)
                        db.refresh(existing_filament)

                        filaments_updated += 1
                        imported_filaments.append(
                            OrcaFilamentImportItem(
                                filament=FilamentOut.model_validate(existing_filament),
                                profile=OrcaProfileOut.model_validate(profile),
                                action="updated",
                                filename=entry_name,
                            )
                        )
                    else:
                        profile = OrcaProfile(
                            name=item.name,
                            kind=ProfileKind.FILAMENT.value,
                            filename=item.filename,
                            file_path=str(stored_path),
                            notes=item.notes,
                        )
                        db.add(profile)
                        db.flush()

                        filament = Filament(
                            name=item.name,
                            material=item.material,
                            color_hex=item.color_hex,
                            density_g_cm3=item.density_g_cm3,
                            filament_profile_id=profile.id,
                            is_active=True,
                        )
                        db.add(filament)
                        db.flush()
                        db.refresh(profile)
                        db.refresh(filament)

                        filaments_created += 1
                        imported_filaments.append(
                            OrcaFilamentImportItem(
                                filament=FilamentOut.model_validate(filament),
                                profile=OrcaProfileOut.model_validate(profile),
                                action="created",
                                filename=entry_name,
                            )
                        )
                else:
                    existing_profile = db.scalar(
                        select(OrcaProfile).where(
                            OrcaProfile.kind == item.kind,
                            func.lower(OrcaProfile.name) == item.name.lower(),
                        )
                    )
                    if existing_profile is not None and not update_existing:
                        skipped.append(
                            OrcaFilamentSkippedItem(
                                filename=f"{entry_name} ({item.name})",
                                reason=f"Profile '{item.name}' ({item.kind}) already exists",
                            )
                        )
                        continue

                    stored_path = save_profile_file(
                        item.filename,
                        json_bytes,
                        kind=item.kind,
                    )

                    if existing_profile is not None:
                        delete_profile_file(existing_profile)
                        existing_profile.name = item.name
                        existing_profile.filename = item.filename
                        existing_profile.file_path = str(stored_path)
                        existing_profile.notes = item.notes
                        db.flush()
                        db.refresh(existing_profile)

                        profiles_updated += 1
                        imported_profiles.append(
                            PrusaProfileImportItem(
                                profile=OrcaProfileOut.model_validate(existing_profile),
                                action="updated",
                                filename=entry_name,
                            )
                        )
                    else:
                        profile = OrcaProfile(
                            name=item.name,
                            kind=item.kind,
                            filename=item.filename,
                            file_path=str(stored_path),
                            notes=item.notes,
                        )
                        db.add(profile)
                        db.flush()
                        db.refresh(profile)

                        profiles_created += 1
                        imported_profiles.append(
                            PrusaProfileImportItem(
                                profile=OrcaProfileOut.model_validate(profile),
                                action="created",
                                filename=entry_name,
                            )
                        )

    db.commit()
    return PrusaSlicerImportResult(
        filaments=imported_filaments,
        profiles=imported_profiles,
        skipped=skipped,
        filaments_created=filaments_created,
        filaments_updated=filaments_updated,
        profiles_created=profiles_created,
        profiles_updated=profiles_updated,
        skipped_count=len(skipped),
    )


@router.post("/profiles/test-slice", response_model=TestSliceResponse)
def admin_test_slice_profile(
    body: TestSliceRequest,
    _admin: User = Depends(require_permission(Permission.PROFILES_MANAGE)),
    db: Session = Depends(get_db),
) -> TestSliceResponse:
    sys_settings = get_system_settings(db)
    printer = db.scalar(
        select(Printer)
        .where(Printer.id == body.printer_id)
        .options(selectinload(Printer.machine_profile), selectinload(Printer.process_profile))
    )
    if printer is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Printer not found")

    slot = db.scalar(
        select(PrinterSlot)
        .where(PrinterSlot.id == body.slot_id, PrinterSlot.printer_id == printer.id)
        .options(selectinload(PrinterSlot.filament))
    )
    if slot is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Printer slot not found")

    try:
        return test_slice_calibration_cube(printer, slot, sys_settings)
    except SlicerError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "SLICER_ERROR", "message": str(exc)},
        ) from exc


# ---------------------------------------------------------------------------
# Permissions Catalog & Teachers (Admin Only)
# ---------------------------------------------------------------------------

def _resolve_custom_permissions_json(
    *,
    permissions: Optional[list[str]],
    preset: Optional[str],
    reset_permissions: bool = False,
) -> tuple[bool, Optional[str]]:
    """Return (should_update, permissions_json_value) after validating preset or manual list."""
    if reset_permissions:
        return True, None
    if preset is not None:
        try:
            resolved = resolve_preset(preset)
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"code": "INVALID_PRESET", "message": str(exc)},
            ) from exc
        return True, json.dumps(resolved)
    if permissions is not None:
        try:
            validated = validate_permission_keys(permissions)
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"code": "INVALID_PERMISSION", "message": str(exc)},
            ) from exc
        return True, json.dumps(validated)
    return False, None


@router.get("/permissions/catalog", response_model=PermissionCatalogOut)
def admin_get_permissions_catalog(
    _admin: User = Depends(require_permission(Permission.TEACHERS_MANAGE)),
) -> PermissionCatalogOut:
    """Return all available permissions, quick presets, and default role permissions."""
    return PermissionCatalogOut(
        permissions=[
            PermissionCatalogItem(key=perm.value, group=group)
            for perm, group in PERMISSION_CATALOG
        ],
        presets=[
            PermissionPresetOut(id=preset_id, permissions=sorted(perms))
            for preset_id, perms in PERMISSION_PRESETS.items()
        ],
        role_defaults={
            role: get_permissions_for_role(role)
            for role in ("student", "teacher", "admin")
        },
    )


@router.get("/teachers", response_model=list[AdminTeacherOut])
def admin_list_teachers(
    _admin: User = Depends(require_permission(Permission.TEACHERS_MANAGE)),
    db: Session = Depends(get_db),
) -> list[AdminTeacherOut]:
    teachers = list(
        db.scalars(select(User).where(User.role == "teacher").order_by(User.name.asc(), User.id.asc()))
    )
    return [_serialize_teacher(db, t) for t in teachers]


def _assert_delegation_ceiling(caller: User, requested_permissions: Iterable[str]) -> None:
    """Prevent non-admin callers from granting permissions they do not themselves hold."""
    if caller.role == "admin":
        return
    caller_perms = set(get_user_permissions(caller))
    requested = set(requested_permissions)
    excess = sorted(requested - caller_perms)
    if excess:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "FORBIDDEN",
                "message": f"Cannot grant permissions you do not hold: {', '.join(excess)}",
            },
        )


def _assert_can_manage_target_teacher(caller: User, target_teacher: User) -> None:
    """Prevent non-admin callers from modifying, resetting, or deleting a teacher with higher permissions."""
    if caller.role == "admin":
        return
    caller_perms = set(get_user_permissions(caller))
    target_perms = set(get_user_permissions(target_teacher))
    excess = sorted(target_perms - caller_perms)
    if excess:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "FORBIDDEN",
                "message": "Cannot manage a teacher who holds permissions you do not have",
            },
        )


@router.post("/teachers", response_model=AdminTeacherOut, status_code=status.HTTP_201_CREATED)
def admin_create_teacher(
    body: AdminTeacherCreate,
    caller: User = Depends(require_permission(Permission.TEACHERS_MANAGE)),
    db: Session = Depends(get_db),
) -> AdminTeacherOut:
    existing = db.scalar(select(User).where(User.da == body.identifier))
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "DA_ALREADY_REGISTERED",
                "message": "Un compte existe déjà avec cet identifiant.",
            },
        )
    should_set_perms, perms_json = _resolve_custom_permissions_json(
        permissions=body.permissions,
        preset=body.preset,
    )
    effective_target_perms = (
        json.loads(perms_json)
        if (should_set_perms and perms_json is not None)
        else get_permissions_for_role("teacher")
    )
    _assert_delegation_ceiling(caller, effective_target_perms)

    teacher = User(
        da=body.identifier,
        name=body.name.strip(),
        password_hash=hash_password(body.password),
        role="teacher",
        approval_status="approved",
        is_active=True,
        permissions_json=perms_json if should_set_perms else None,
    )
    db.add(teacher)
    db.commit()
    db.refresh(teacher)
    return _serialize_teacher(db, teacher)


@router.patch("/teachers/{teacher_id}", response_model=AdminTeacherOut)
def admin_patch_teacher(
    teacher_id: int,
    body: AdminTeacherPatch,
    caller: User = Depends(require_permission(Permission.TEACHERS_MANAGE)),
    db: Session = Depends(get_db),
) -> AdminTeacherOut:
    teacher = db.get(User, teacher_id)
    if teacher is None or teacher.role != "teacher":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Teacher not found")

    _assert_can_manage_target_teacher(caller, teacher)

    fields = body.model_fields_set
    should_set_perms, perms_json = _resolve_custom_permissions_json(
        permissions=body.permissions if "permissions" in fields else None,
        preset=body.preset if "preset" in fields else None,
        reset_permissions=body.reset_permissions,
    )
    if should_set_perms:
        if caller.role != "admin" and teacher.id == caller.id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={
                    "code": "FORBIDDEN",
                    "message": "You cannot modify your own permissions",
                },
            )
        effective_target_perms = (
            json.loads(perms_json)
            if perms_json is not None
            else get_permissions_for_role("teacher")
        )
        _assert_delegation_ceiling(caller, effective_target_perms)
        teacher.permissions_json = perms_json

    if "name" in fields and body.name is not None:
        teacher.name = body.name.strip()
    if "is_active" in fields and body.is_active is not None:
        teacher.is_active = body.is_active

    db.commit()
    db.refresh(teacher)
    return _serialize_teacher(db, teacher)


@router.post("/teachers/{teacher_id}/reset-password", response_model=ResetPasswordResponse)
def admin_reset_teacher_password(
    teacher_id: int,
    body: Optional[ResetPasswordRequest] = None,
    caller: User = Depends(require_permission(Permission.TEACHERS_MANAGE)),
    db: Session = Depends(get_db),
) -> ResetPasswordResponse:
    teacher = db.get(User, teacher_id)
    if teacher is None or teacher.role != "teacher":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Teacher not found")

    _assert_can_manage_target_teacher(caller, teacher)

    if body and body.new_password:
        temp_pwd = body.new_password
    else:
        alphabet = string.ascii_letters + string.digits
        temp_pwd = "".join(secrets.choice(alphabet) for _ in range(8))

    teacher.password_hash = hash_password(temp_pwd)
    teacher.token_version = (getattr(teacher, "token_version", 0) or 0) + 1
    db.commit()
    return ResetPasswordResponse(da=teacher.da, temp_password=temp_pwd)


@router.delete("/teachers/{teacher_id}", status_code=status.HTTP_204_NO_CONTENT)
def admin_delete_teacher(
    teacher_id: int,
    caller: User = Depends(require_permission(Permission.TEACHERS_MANAGE)),
    db: Session = Depends(get_db),
) -> None:
    teacher = db.scalar(
        select(User)
        .where(User.id == teacher_id, User.role == "teacher")
        .options(selectinload(User.classes).selectinload(TeacherClass.enrollments))
    )
    if teacher is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Teacher not found")

    _assert_can_manage_target_teacher(caller, teacher)

    candidate_das = [
        enrollment.da
        for tc in teacher.classes
        for enrollment in tc.enrollments
    ]

    for pj in db.scalars(select(PrintJob).where(PrintJob.teacher_id == teacher.id)):
        pj.teacher_id = None
    for req_user in db.scalars(select(User).where(User.requested_teacher_id == teacher.id)):
        req_user.requested_teacher_id = None

    db.delete(teacher)
    db.flush()

    if candidate_das:
        _disable_orphaned_students(db, candidate_das)
    # Also ensure no approved active student remains active with zero remaining enrollments
    enrolled_das = set(db.scalars(select(ClassEnrollment.da).distinct()))
    for stu in db.scalars(
        select(User).where(
            User.role == "student",
            User.approval_status == "approved",
            User.is_active == True,  # noqa: E712
        )
    ):
        if stu.da not in enrolled_das:
            stu.is_active = False

    db.commit()


# ---------------------------------------------------------------------------
# Teacher Classes & Rosters
# ---------------------------------------------------------------------------

def _assert_class_access(staff_user: User, tc: TeacherClass) -> None:
    if not has_permission(staff_user, Permission.CLASSES_MANAGE_ALL) and tc.teacher_id != staff_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "FORBIDDEN",
                "message": "You do not own this class",
                "required_permission": Permission.CLASSES_MANAGE_ALL.value,
            },
        )


def _parse_bulk_student_line(line: str) -> tuple[str, Optional[str], Optional[float], Optional[int]] | None:
    """Parse a pasted line into (da, suggested_name, max_grams, max_minutes) or None if invalid."""
    raw = line.strip()
    if not raw:
        return None
    if "," in raw or ";" in raw or "\t" in raw:
        delim = "\t" if "\t" in raw else (";" if ";" in raw else ",")
        parts = [p.strip() for p in raw.split(delim)]
    else:
        tokens = raw.split(None, 1)
        parts = [t.strip() for t in tokens]

    da = parts[0] if parts else ""
    if not (len(da) == 7 and da.isdigit()):
        return None

    suggested_name = parts[1] if len(parts) > 1 and parts[1] else None
    max_grams: Optional[float] = None
    max_mins: Optional[int] = None
    try:
        if len(parts) > 2 and parts[2]:
            val_g = float(parts[2])
            if not (math.isfinite(val_g) and 0.0 < val_g <= 5000.0):
                return None
            max_grams = val_g
        if len(parts) > 3 and parts[3]:
            val_m = int(parts[3])
            if not (0 < val_m <= 10080):
                return None
            max_mins = val_m
    except ValueError:
        return None

    return da, suggested_name, max_grams, max_mins


@router.get("/classes", response_model=list[TeacherClassOut])
def admin_list_classes(
    staff_user: User = Depends(require_permission(Permission.CLASSES_MANAGE_OWN)),
    db: Session = Depends(get_db),
) -> list[TeacherClassOut]:
    stmt = (
        select(TeacherClass)
        .options(selectinload(TeacherClass.teacher), selectinload(TeacherClass.enrollments))
        .order_by(TeacherClass.teacher_id.asc(), TeacherClass.created_at.asc(), TeacherClass.id.asc())
    )
    if not has_permission(staff_user, Permission.CLASSES_MANAGE_ALL):
        stmt = stmt.where(TeacherClass.teacher_id == staff_user.id)
    classes = list(db.scalars(stmt))
    return [_serialize_teacher_class(db, tc) for tc in classes]


@router.post("/classes", response_model=TeacherClassOut, status_code=status.HTTP_201_CREATED)
def admin_create_class(
    body: TeacherClassCreate,
    staff_user: User = Depends(require_permission(Permission.CLASSES_MANAGE_OWN)),
    db: Session = Depends(get_db),
) -> TeacherClassOut:
    if not has_permission(staff_user, Permission.CLASSES_MANAGE_ALL):
        if body.teacher_id is not None and body.teacher_id != staff_user.id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={
                    "code": "FORBIDDEN",
                    "message": "Teachers can only create classes for themselves",
                    "required_permission": Permission.CLASSES_MANAGE_ALL.value,
                },
            )
        target_teacher_id = staff_user.id
    else:
        if body.teacher_id is not None:
            teacher = db.get(User, body.teacher_id)
            if teacher is None or teacher.role != "teacher" or not teacher.is_active:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail={"code": "TEACHER_NOT_FOUND", "message": "Target teacher not found or inactive"},
                )
            target_teacher_id = teacher.id
        else:
            first_teacher_id = db.scalar(
                select(User.id)
                .where(User.role == "teacher", User.is_active == True)  # noqa: E712
                .order_by(User.id.asc())
                .limit(1)
            )
            if first_teacher_id is None:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail={"code": "TEACHER_REQUIRED", "message": "No active teacher available"},
                )
            target_teacher_id = first_teacher_id

    dup = db.scalar(
        select(TeacherClass.id).where(
            TeacherClass.teacher_id == target_teacher_id,
            TeacherClass.name == body.name,
        )
    )
    if dup is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "CLASS_ALREADY_EXISTS", "message": "A class with this name already exists for this teacher"},
        )

    tc = TeacherClass(
        teacher_id=target_teacher_id,
        name=body.name,
        code=body.code,
        description=body.description,
        default_max_active_grams=body.default_max_active_grams,
        default_max_print_minutes=body.default_max_print_minutes,
        is_default_individual=False,
    )
    db.add(tc)
    db.commit()

    created = db.scalar(
        select(TeacherClass)
        .where(TeacherClass.id == tc.id)
        .options(selectinload(TeacherClass.teacher), selectinload(TeacherClass.enrollments))
    )
    return _serialize_teacher_class(db, created)  # type: ignore[arg-type]


@router.patch("/classes/{class_id}", response_model=TeacherClassOut)
def admin_patch_class(
    class_id: int,
    body: TeacherClassPatch,
    staff_user: User = Depends(require_permission(Permission.CLASSES_MANAGE_OWN)),
    db: Session = Depends(get_db),
) -> TeacherClassOut:
    tc = db.scalar(
        select(TeacherClass)
        .where(TeacherClass.id == class_id)
        .options(selectinload(TeacherClass.teacher), selectinload(TeacherClass.enrollments))
    )
    if tc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Class not found")
    _assert_class_access(staff_user, tc)

    fields = body.model_fields_set
    if "name" in fields and body.name is not None and body.name != tc.name:
        dup = db.scalar(
            select(TeacherClass.id).where(
                TeacherClass.teacher_id == tc.teacher_id,
                TeacherClass.name == body.name,
                TeacherClass.id != tc.id,
            )
        )
        if dup is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={"code": "CLASS_ALREADY_EXISTS", "message": "A class with this name already exists for this teacher"},
            )
        tc.name = body.name
    if "code" in fields:
        tc.code = body.code
    if "description" in fields:
        tc.description = body.description
    if "default_max_active_grams" in fields:
        tc.default_max_active_grams = body.default_max_active_grams
    if "default_max_print_minutes" in fields:
        tc.default_max_print_minutes = body.default_max_print_minutes

    if body.apply_budget_to_students:
        enrolled_das = [e.da for e in tc.enrollments]
        for enrollment in tc.enrollments:
            if "default_max_active_grams" in fields or tc.default_max_active_grams is not None:
                enrollment.max_active_grams_override = tc.default_max_active_grams
            if "default_max_print_minutes" in fields or tc.default_max_print_minutes is not None:
                enrollment.max_print_minutes_override = tc.default_max_print_minutes
        if enrolled_das:
            students = list(
                db.scalars(select(User).where(User.da.in_(enrolled_das), User.role == "student"))
            )
            for stu in students:
                if "default_max_active_grams" in fields or tc.default_max_active_grams is not None:
                    stu.max_active_grams_override = tc.default_max_active_grams
                if "default_max_print_minutes" in fields or tc.default_max_print_minutes is not None:
                    stu.max_print_minutes_override = tc.default_max_print_minutes

    db.commit()
    refreshed = db.scalar(
        select(TeacherClass)
        .where(TeacherClass.id == tc.id)
        .options(selectinload(TeacherClass.teacher), selectinload(TeacherClass.enrollments))
    )
    return _serialize_teacher_class(db, refreshed)  # type: ignore[arg-type]


@router.delete("/classes/{class_id}", response_model=ClassDeleteOut)
def admin_delete_class(
    class_id: int,
    staff_user: User = Depends(require_permission(Permission.CLASSES_MANAGE_OWN)),
    db: Session = Depends(get_db),
) -> ClassDeleteOut:
    tc = db.scalar(
        select(TeacherClass)
        .where(TeacherClass.id == class_id)
        .options(selectinload(TeacherClass.enrollments))
    )
    if tc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Class not found")
    _assert_class_access(staff_user, tc)

    candidate_das = [e.da for e in tc.enrollments]
    deleted_id = tc.id
    db.delete(tc)
    db.flush()
    disabled_count = _disable_orphaned_students(db, candidate_das)
    db.commit()
    return ClassDeleteOut(deleted_class_id=deleted_id, disabled_students_count=disabled_count)


@router.post("/classes/{class_id}/students", response_model=ClassEnrollmentOut, status_code=status.HTTP_201_CREATED)
def admin_add_class_student(
    class_id: int,
    body: WhitelistEntryCreate,
    staff_user: User = Depends(require_permission(Permission.CLASSES_MANAGE_OWN)),
    db: Session = Depends(get_db),
) -> ClassEnrollmentOut:
    tc = db.get(TeacherClass, class_id)
    if tc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Class not found")
    _assert_class_access(staff_user, tc)

    existing = db.scalar(
        select(ClassEnrollment).where(ClassEnrollment.class_id == tc.id, ClassEnrollment.da == body.da)
    )
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "DA_ALREADY_IN_CLASS", "message": f"DA {body.da} is already in this class"},
        )

    eff_grams_override = (
        body.max_active_grams_override
        if body.max_active_grams_override is not None
        else tc.default_max_active_grams
    )
    eff_mins_override = (
        body.max_print_minutes_override
        if body.max_print_minutes_override is not None
        else tc.default_max_print_minutes
    )

    enrollment = ClassEnrollment(
        class_id=tc.id,
        da=body.da,
        suggested_name=body.suggested_name.strip() if body.suggested_name else None,
        max_active_grams_override=eff_grams_override,
        max_print_minutes_override=eff_mins_override,
    )
    db.add(enrollment)
    _reactivate_enrolled_student(db, body.da)
    db.commit()
    db.refresh(enrollment)

    stu = db.scalar(select(User).where(User.da == enrollment.da, User.role == "student"))
    eff_g: Optional[float] = None
    used_g: Optional[float] = None
    eff_m: Optional[int] = None
    if stu is not None:
        sys_settings = get_system_settings(db)
        eff_g, eff_m = get_effective_limits(stu, sys_settings)
        used_g = get_active_grams_used(db, stu.id)
    return ClassEnrollmentOut(
        id=enrollment.id,
        class_id=enrollment.class_id,
        da=enrollment.da,
        suggested_name=enrollment.suggested_name,
        max_active_grams_override=enrollment.max_active_grams_override,
        max_print_minutes_override=enrollment.max_print_minutes_override,
        is_registered=stu is not None,
        is_active=stu.is_active if stu is not None else None,
        user_id=stu.id if stu is not None else None,
        registered_name=stu.name if stu is not None else None,
        effective_max_active_grams=eff_g,
        active_grams_used=used_g,
        effective_max_print_minutes=eff_m,
        created_at=enrollment.created_at,
    )


@router.post("/classes/{class_id}/students/bulk", response_model=BulkEnrollResult)
def admin_bulk_add_class_students(
    class_id: int,
    body: BulkEnrollRequest,
    staff_user: User = Depends(require_permission(Permission.CLASSES_MANAGE_OWN)),
    db: Session = Depends(get_db),
) -> BulkEnrollResult:
    """Bulk-add students to a class from pasted text lines or structured entries."""
    tc = db.get(TeacherClass, class_id)
    if tc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Class not found")
    _assert_class_access(staff_user, tc)

    existing_das = set(
        db.scalars(select(ClassEnrollment.da).where(ClassEnrollment.class_id == tc.id))
    )

    added = 0
    skipped = 0
    invalid = 0
    reactivated = 0
    invalid_lines: list[str] = []

    parsed_rows: list[tuple[str, Optional[str], Optional[float], Optional[int]]] = []
    if body.entries:
        for item in body.entries:
            parsed_rows.append(
                (
                    item.da,
                    item.suggested_name.strip() if item.suggested_name else None,
                    item.max_active_grams_override,
                    item.max_print_minutes_override,
                )
            )
    if body.raw_text:
        for idx, raw_line in enumerate(body.raw_text.splitlines()):
            stripped = raw_line.strip()
            if not stripped:
                continue
            if idx == 0 and stripped.lower().startswith("da"):
                first_tok = stripped.split(",")[0].split(";")[0].split("\t")[0].strip().lower()
                if first_tok == "da":
                    continue
            parsed = _parse_bulk_student_line(stripped)
            if parsed is None:
                invalid += 1
                if len(invalid_lines) < 25:
                    invalid_lines.append(stripped)
                continue
            parsed_rows.append(parsed)

    for da, suggested_name, max_grams, max_mins in parsed_rows:
        if da in existing_das:
            skipped += 1
            continue
        db.add(
            ClassEnrollment(
                class_id=tc.id,
                da=da,
                suggested_name=suggested_name,
                max_active_grams_override=max_grams if max_grams is not None else tc.default_max_active_grams,
                max_print_minutes_override=max_mins if max_mins is not None else tc.default_max_print_minutes,
            )
        )
        existing_das.add(da)
        added += 1
        if _reactivate_enrolled_student(db, da):
            reactivated += 1

    db.commit()
    return BulkEnrollResult(
        added=added,
        skipped=skipped,
        invalid=invalid,
        reactivated=reactivated,
        invalid_lines=invalid_lines,
    )


@router.post("/classes/{class_id}/import-csv", response_model=ClassCsvResult)
async def admin_import_class_csv(
    class_id: int,
    file: UploadFile = File(...),
    staff_user: User = Depends(require_permission(Permission.CLASSES_MANAGE_OWN)),
    db: Session = Depends(get_db),
) -> ClassCsvResult:
    tc = db.get(TeacherClass, class_id)
    if tc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Class not found")
    _assert_class_access(staff_user, tc)

    raw = await read_upload_bounded(file, _CSV_UPLOAD_MAX_BYTES)
    text = raw.decode("utf-8-sig", errors="replace")
    reader = csv.reader(io.StringIO(text))

    added = 0
    skipped = 0
    reactivated = 0
    existing_das = set(
        db.scalars(select(ClassEnrollment.da).where(ClassEnrollment.class_id == tc.id))
    )

    for idx, row in enumerate(reader):
        if not row:
            continue
        first = row[0].strip()
        if idx == 0 and first.lower() == "da":
            continue
        if not (len(first) == 7 and first.isdigit()) or first in existing_das:
            skipped += 1
            continue

        suggested_name = row[1].strip() if len(row) > 1 and row[1].strip() else None
        max_grams: Optional[float] = None
        max_mins: Optional[int] = None
        try:
            if len(row) > 2 and row[2].strip():
                val_g = float(row[2].strip())
                if not (math.isfinite(val_g) and 0.0 < val_g <= 5000.0):
                    skipped += 1
                    continue
                max_grams = val_g
            if len(row) > 3 and row[3].strip():
                val_m = int(row[3].strip())
                if not (0 < val_m <= 10080):
                    skipped += 1
                    continue
                max_mins = val_m
        except ValueError:
            skipped += 1
            continue

        db.add(
            ClassEnrollment(
                class_id=tc.id,
                da=first,
                suggested_name=suggested_name,
                max_active_grams_override=max_grams if max_grams is not None else tc.default_max_active_grams,
                max_print_minutes_override=max_mins if max_mins is not None else tc.default_max_print_minutes,
            )
        )
        existing_das.add(first)
        added += 1
        if _reactivate_enrolled_student(db, first):
            reactivated += 1

    db.commit()
    return ClassCsvResult(added=added, skipped=skipped, reactivated=reactivated)


@router.post("/classes/{class_id}/transfer", response_model=TransferStudentOut)
def admin_transfer_class_student(
    class_id: int,
    body: TransferStudentRequest,
    staff_user: User = Depends(require_permission(Permission.CLASSES_MANAGE_OWN)),
    db: Session = Depends(get_db),
) -> TransferStudentOut:
    """Move (or copy) a student enrollment from one class to another owned class."""
    source_cls = db.get(TeacherClass, class_id)
    if source_cls is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Source class not found")
    _assert_class_access(staff_user, source_cls)

    target_cls = db.get(TeacherClass, body.target_class_id)
    if target_cls is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Target class not found")
    _assert_class_access(staff_user, target_cls)

    if source_cls.id == target_cls.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "SAME_CLASS", "message": "Source and target classes must be different"},
        )

    source_enrollment = db.scalar(
        select(ClassEnrollment).where(
            ClassEnrollment.class_id == source_cls.id,
            ClassEnrollment.da == body.da,
        )
    )
    if source_enrollment is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Student enrollment not found in source class")

    existing_target = db.scalar(
        select(ClassEnrollment).where(
            ClassEnrollment.class_id == target_cls.id,
            ClassEnrollment.da == body.da,
        )
    )
    already_in_target = existing_target is not None
    if not already_in_target:
        db.add(
            ClassEnrollment(
                class_id=target_cls.id,
                da=body.da,
                suggested_name=source_enrollment.suggested_name,
                max_active_grams_override=source_enrollment.max_active_grams_override,
                max_print_minutes_override=source_enrollment.max_print_minutes_override,
            )
        )

    if body.remove_from_source:
        db.delete(source_enrollment)

    db.commit()
    return TransferStudentOut(
        da=body.da,
        source_class_id=source_cls.id,
        target_class_id=target_cls.id,
        moved=body.remove_from_source,
        already_in_target=already_in_target,
    )


@router.delete("/classes/{class_id}/students/{da}", response_model=ClassStudentRemoveOut)
def admin_remove_class_student(
    class_id: int,
    da: str,
    staff_user: User = Depends(require_permission(Permission.CLASSES_MANAGE_OWN)),
    db: Session = Depends(get_db),
) -> ClassStudentRemoveOut:
    tc = db.get(TeacherClass, class_id)
    if tc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Class not found")
    _assert_class_access(staff_user, tc)

    enrollment = db.scalar(
        select(ClassEnrollment).where(ClassEnrollment.class_id == tc.id, ClassEnrollment.da == da)
    )
    if enrollment is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Student enrollment not found")

    db.delete(enrollment)
    db.flush()
    disabled_count = _disable_orphaned_students(db, [da])
    db.commit()
    return ClassStudentRemoveOut(removed=True, student_disabled=disabled_count > 0)


# ---------------------------------------------------------------------------
# Legacy DA Whitelist (mapped to caller's default/first class)
# ---------------------------------------------------------------------------

@router.get("/whitelist", response_model=list[WhitelistEntryOut])
def admin_list_whitelist(
    staff_user: User = Depends(require_permission(Permission.CLASSES_MANAGE_OWN)),
    db: Session = Depends(get_db),
) -> list[WhitelistEntryOut]:
    registered_das = set(db.scalars(select(User.da).where(User.role == "student")))
    if not has_permission(staff_user, Permission.CLASSES_MANAGE_ALL):
        entries = list(
            db.scalars(
                select(ClassEnrollment)
                .join(TeacherClass, ClassEnrollment.class_id == TeacherClass.id)
                .where(TeacherClass.teacher_id == staff_user.id)
                .order_by(ClassEnrollment.da.asc())
            )
        )
    else:
        entries = list(db.scalars(select(ClassEnrollment).order_by(ClassEnrollment.da.asc())))
    seen: set[str] = set()
    out: list[WhitelistEntryOut] = []
    for e in entries:
        if e.da in seen:
            continue
        seen.add(e.da)
        out.append(
            WhitelistEntryOut(
                da=e.da,
                suggested_name=e.suggested_name,
                max_active_grams_override=e.max_active_grams_override,
                max_print_minutes_override=e.max_print_minutes_override,
                is_registered=e.da in registered_das,
                created_at=e.created_at,
            )
        )
    return out


@router.post("/whitelist", response_model=WhitelistEntryOut, status_code=status.HTTP_201_CREATED)
def admin_add_whitelist(
    body: WhitelistEntryCreate,
    staff_user: User = Depends(require_permission(Permission.CLASSES_MANAGE_OWN)),
    db: Session = Depends(get_db),
) -> WhitelistEntryOut:
    tc = _resolve_legacy_whitelist_class(db, staff_user)
    if db.scalar(select(ClassEnrollment).where(ClassEnrollment.class_id == tc.id, ClassEnrollment.da == body.da)) is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "DA_ALREADY_WHITELISTED", "message": f"DA {body.da} is already whitelisted"},
        )
    entry = ClassEnrollment(
        class_id=tc.id,
        da=body.da,
        suggested_name=body.suggested_name.strip() if body.suggested_name else None,
        max_active_grams_override=body.max_active_grams_override,
        max_print_minutes_override=body.max_print_minutes_override,
    )
    db.add(entry)
    _reactivate_enrolled_student(db, body.da)
    db.commit()
    db.refresh(entry)
    is_reg = db.scalar(select(User.id).where(User.da == entry.da)) is not None
    return WhitelistEntryOut(
        da=entry.da,
        suggested_name=entry.suggested_name,
        max_active_grams_override=entry.max_active_grams_override,
        max_print_minutes_override=entry.max_print_minutes_override,
        is_registered=is_reg,
        created_at=entry.created_at,
    )


@router.post("/whitelist/csv", response_model=WhitelistCsvResult)
async def admin_upload_whitelist_csv(
    file: UploadFile = File(...),
    staff_user: User = Depends(require_permission(Permission.CLASSES_MANAGE_OWN)),
    db: Session = Depends(get_db),
) -> WhitelistCsvResult:
    tc = _resolve_legacy_whitelist_class(db, staff_user)
    raw = await read_upload_bounded(file, _CSV_UPLOAD_MAX_BYTES)
    text = raw.decode("utf-8-sig", errors="replace")
    reader = csv.reader(io.StringIO(text))

    added = 0
    skipped = 0
    existing_das = set(db.scalars(select(ClassEnrollment.da).where(ClassEnrollment.class_id == tc.id)))

    for idx, row in enumerate(reader):
        if not row:
            continue
        first = row[0].strip()
        if idx == 0 and first.lower() == "da":
            continue
        if not (len(first) == 7 and first.isdigit()) or first in existing_das:
            skipped += 1
            continue

        suggested_name = row[1].strip() if len(row) > 1 and row[1].strip() else None
        max_grams: Optional[float] = None
        max_mins: Optional[int] = None
        try:
            if len(row) > 2 and row[2].strip():
                val_g = float(row[2].strip())
                if not (math.isfinite(val_g) and 0.0 < val_g <= 5000.0):
                    skipped += 1
                    continue
                max_grams = val_g
            if len(row) > 3 and row[3].strip():
                val_m = int(row[3].strip())
                if not (0 < val_m <= 10080):
                    skipped += 1
                    continue
                max_mins = val_m
        except ValueError:
            skipped += 1
            continue

        db.add(
            ClassEnrollment(
                class_id=tc.id,
                da=first,
                suggested_name=suggested_name,
                max_active_grams_override=max_grams,
                max_print_minutes_override=max_mins,
            )
        )
        _reactivate_enrolled_student(db, first)
        existing_das.add(first)
        added += 1

    db.commit()
    return WhitelistCsvResult(added=added, skipped=skipped)


@router.delete("/whitelist/{da}", status_code=status.HTTP_204_NO_CONTENT)
def admin_delete_whitelist(
    da: str,
    staff_user: User = Depends(require_permission(Permission.CLASSES_MANAGE_OWN)),
    db: Session = Depends(get_db),
) -> None:
    if not has_permission(staff_user, Permission.CLASSES_MANAGE_ALL):
        entries = list(
            db.scalars(
                select(ClassEnrollment)
                .join(TeacherClass, ClassEnrollment.class_id == TeacherClass.id)
                .where(TeacherClass.teacher_id == staff_user.id, ClassEnrollment.da == da)
            )
        )
    else:
        entries = list(db.scalars(select(ClassEnrollment).where(ClassEnrollment.da == da)))
    if not entries:
        if has_permission(staff_user, Permission.CLASSES_MANAGE_ALL):
            legacy = db.get(DAWhitelist, da)
            if legacy is not None:
                db.delete(legacy)
                db.commit()
                return
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Whitelist entry not found")
    for e in entries:
        db.delete(e)
    db.flush()
    _disable_orphaned_students(db, [da])
    db.commit()


# ---------------------------------------------------------------------------
# Students & Pending Account Approvals
# ---------------------------------------------------------------------------

@router.get("/students", response_model=list[AdminStudentOut])
def admin_list_students(
    staff_user: User = Depends(require_permission(Permission.STUDENTS_MANAGE_OWN)),
    db: Session = Depends(get_db),
) -> list[AdminStudentOut]:
    sys_settings = get_system_settings(db)
    if not has_permission(staff_user, Permission.STUDENTS_MANAGE_ALL):
        my_das = set(
            db.scalars(
                select(ClassEnrollment.da)
                .join(TeacherClass, ClassEnrollment.class_id == TeacherClass.id)
                .where(TeacherClass.teacher_id == staff_user.id)
            )
        )
        if not my_das:
            return []
        users = list(
            db.scalars(
                select(User)
                .where(User.role == "student", User.da.in_(my_das))
                .order_by(User.is_active.desc(), User.name.asc(), User.created_at.desc())
            )
        )
    else:
        users = list(
            db.scalars(
                select(User)
                .where(User.role == "student")
                .order_by(User.is_active.desc(), User.name.asc(), User.created_at.desc())
            )
        )

    job_counts = dict(
        db.execute(select(PrintJob.user_id, func.count(PrintJob.id)).group_by(PrintJob.user_id)).all()
    )
    classes_map = _build_student_classes_map(db, [u.da for u in users])
    return [
        _serialize_admin_student(
            db=db,
            user=u,
            sys_settings=sys_settings,
            classes=classes_map.get(u.da, []),
            total_jobs=int(job_counts.get(u.id, 0)),
        )
        for u in users
    ]


@router.post("/students/refresh-budget", response_model=BudgetRefreshResult)
def admin_refresh_student_budgets(
    body: BudgetRefreshRequest,
    staff_user: User = Depends(require_permission(Permission.STUDENTS_MANAGE_OWN)),
    db: Session = Depends(get_db),
) -> BudgetRefreshResult:
    """Manually refresh active used grams and/or max gram limits for users, a class, or all students."""
    can_manage_all = has_permission(staff_user, Permission.STUDENTS_MANAGE_ALL)
    tc: Optional[TeacherClass] = None

    if body.scope == "all":
        if not can_manage_all:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={
                    "code": "FORBIDDEN",
                    "message": "Permission 'students:manage_all' is required to refresh all students.",
                    "required_permission": Permission.STUDENTS_MANAGE_ALL.value,
                },
            )
        target_users = list(
            db.scalars(select(User).where(User.role == "student").order_by(User.id.asc()))
        )
    elif body.scope == "class":
        tc = db.scalar(
            select(TeacherClass)
            .where(TeacherClass.id == body.class_id)
            .options(selectinload(TeacherClass.enrollments))
        )
        if tc is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Class not found")
        if not can_manage_all and tc.teacher_id != staff_user.id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={
                    "code": "FORBIDDEN",
                    "message": "You do not own this class",
                    "required_permission": Permission.STUDENTS_MANAGE_ALL.value,
                },
            )
        enrolled_das = [e.da for e in tc.enrollments]
        target_users = (
            list(
                db.scalars(
                    select(User)
                    .where(User.role == "student", User.da.in_(enrolled_das))
                    .order_by(User.id.asc())
                )
            )
            if enrolled_das
            else []
        )
    else:
        unique_ids = sorted(set(body.user_ids))
        target_users = list(
            db.scalars(
                select(User)
                .where(User.role == "student", User.id.in_(unique_ids))
                .order_by(User.id.asc())
            )
        )
        if not can_manage_all:
            for stu in target_users:
                _ensure_teacher_owns_student(db, staff_user.id, stu.da)

    now = utcnow()
    for stu in target_users:
        if body.reset_usage:
            stu.budget_reset_at = now
        if body.max_grams_mode == "default":
            stu.max_active_grams_override = (
                tc.default_max_active_grams if (body.scope == "class" and tc is not None) else None
            )
        elif body.max_grams_mode == "custom":
            stu.max_active_grams_override = body.custom_max_grams

    if body.scope == "class" and tc is not None and body.max_grams_mode in ("default", "custom"):
        enrollment_override = (
            tc.default_max_active_grams if body.max_grams_mode == "default" else body.custom_max_grams
        )
        for enr in tc.enrollments:
            enr.max_active_grams_override = enrollment_override

    db.commit()
    return BudgetRefreshResult(
        refreshed_count=len(target_users),
        user_ids=[stu.id for stu in target_users],
    )


@router.patch("/students/{user_id}", response_model=AdminStudentOut)
def admin_patch_student(
    user_id: int,
    body: AdminStudentPatch,
    staff_user: User = Depends(require_permission(Permission.STUDENTS_MANAGE_OWN)),
    db: Session = Depends(get_db),
) -> AdminStudentOut:
    user = db.get(User, user_id)
    if user is None or user.role != "student":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Student not found")

    if not has_permission(staff_user, Permission.STUDENTS_MANAGE_ALL):
        _ensure_teacher_owns_student(db, staff_user.id, user.da)

    fields = body.model_fields_set
    if "is_active" in fields and body.is_active is not None:
        user.is_active = body.is_active
    if "max_active_grams_override" in fields:
        user.max_active_grams_override = body.max_active_grams_override
    if "max_print_minutes_override" in fields:
        user.max_print_minutes_override = body.max_print_minutes_override

    db.commit()
    db.refresh(user)
    sys_settings = get_system_settings(db)
    total_jobs = int(db.scalar(select(func.count(PrintJob.id)).where(PrintJob.user_id == user.id)) or 0)
    classes_map = _build_student_classes_map(db, [user.da])
    return _serialize_admin_student(
        db=db,
        user=user,
        sys_settings=sys_settings,
        classes=classes_map.get(user.da, []),
        total_jobs=total_jobs,
    )


@router.post("/students/{user_id}/reset-password", response_model=ResetPasswordResponse)
def admin_reset_student_password(
    user_id: int,
    body: Optional[ResetPasswordRequest] = None,
    staff_user: User = Depends(require_permission(Permission.STUDENTS_MANAGE_OWN)),
    db: Session = Depends(get_db),
) -> ResetPasswordResponse:
    user = db.get(User, user_id)
    if user is None or user.role != "student":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Student not found")

    if not has_permission(staff_user, Permission.STUDENTS_MANAGE_ALL):
        _ensure_teacher_owns_student(db, staff_user.id, user.da)

    if body and body.new_password:
        temp_pwd = body.new_password
    else:
        alphabet = string.ascii_letters + string.digits
        temp_pwd = "".join(secrets.choice(alphabet) for _ in range(8))

    user.password_hash = hash_password(temp_pwd)
    user.token_version = (getattr(user, "token_version", 0) or 0) + 1
    db.commit()
    return ResetPasswordResponse(da=user.da, temp_password=temp_pwd)


@router.get("/account-requests", response_model=list[PendingAccountOut])
def admin_list_account_requests(
    staff_user: User = Depends(require_permission(Permission.STUDENTS_MANAGE_OWN)),
    db: Session = Depends(get_db),
) -> list[PendingAccountOut]:
    stmt = (
        select(User)
        .where(User.role == "student", User.approval_status == "pending")
        .options(selectinload(User.requested_teacher))
        .order_by(User.created_at.asc(), User.id.asc())
    )
    if not has_permission(staff_user, Permission.STUDENTS_MANAGE_ALL):
        stmt = stmt.where(User.requested_teacher_id == staff_user.id)
    pending_users = list(db.scalars(stmt))
    return [_serialize_pending_account(u) for u in pending_users]


@router.post("/account-requests/{user_id}/decision", response_model=PendingAccountOut)
def admin_decide_account_request(
    user_id: int,
    body: AccountDecisionRequest,
    staff_user: User = Depends(require_permission(Permission.STUDENTS_MANAGE_OWN)),
    db: Session = Depends(get_db),
) -> PendingAccountOut:
    user = db.scalar(
        select(User).where(User.id == user_id).options(selectinload(User.requested_teacher))
    )
    if user is None or user.role != "student":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Student account request not found")

    if not has_permission(staff_user, Permission.STUDENTS_MANAGE_ALL) and user.requested_teacher_id != staff_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "FORBIDDEN",
                "message": "This account request is assigned to another teacher",
                "required_permission": Permission.STUDENTS_MANAGE_ALL.value,
            },
        )

    if user.approval_status != "pending":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "NOT_PENDING", "message": "Account request is not pending approval"},
        )

    if body.decision == "reject":
        user.approval_status = "rejected"
        user.is_active = False
        db.commit()
        db.refresh(user)
        return _serialize_pending_account(user)

    if body.class_id is not None:
        target_cls = db.get(TeacherClass, body.class_id)
        if target_cls is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Class not found")
        if not has_permission(staff_user, Permission.CLASSES_MANAGE_ALL) and target_cls.teacher_id != staff_user.id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={
                    "code": "FORBIDDEN",
                    "message": "Selected class belongs to another teacher",
                    "required_permission": Permission.CLASSES_MANAGE_ALL.value,
                },
            )
    else:
        target_teacher_id = (
            staff_user.id
            if not has_permission(staff_user, Permission.CLASSES_MANAGE_ALL)
            else user.requested_teacher_id
        )
        if target_teacher_id is None:
            target_teacher_id = db.scalar(
                select(User.id)
                .where(User.role == "teacher", User.is_active == True)  # noqa: E712
                .order_by(User.id.asc())
                .limit(1)
            )
        if target_teacher_id is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"code": "TEACHER_REQUIRED", "message": "No active teacher available to host enrollment"},
            )
        target_cls = _get_or_create_default_individual_class(db, target_teacher_id)

    existing_enrollment = db.scalar(
        select(ClassEnrollment).where(
            ClassEnrollment.class_id == target_cls.id,
            ClassEnrollment.da == user.da,
        )
    )
    if existing_enrollment is None:
        db.add(
            ClassEnrollment(
                class_id=target_cls.id,
                da=user.da,
                suggested_name=user.name,
            )
        )

    user.approval_status = "approved"
    user.is_active = True
    db.commit()
    db.refresh(user)
    return _serialize_pending_account(user)


# ---------------------------------------------------------------------------
# Oversized Approval Requests
# ---------------------------------------------------------------------------

@router.get("/approvals", response_model=ApprovalsResponse)
def admin_list_approvals(
    staff_user: User = Depends(require_permission(Permission.APPROVALS_MANAGE_OWN)),
    db: Session = Depends(get_db),
) -> ApprovalsResponse:
    sys_settings = get_system_settings(db)
    pending_stmt = (
        select(PrintJob)
        .where(PrintJob.status == JobStatus.PENDING_APPROVAL.value)
        .options(
            selectinload(PrintJob.user),
            selectinload(PrintJob.teacher),
            selectinload(PrintJob.printer),
            selectinload(PrintJob.slot).selectinload(PrinterSlot.filament),
            selectinload(PrintJob.filament),
        )
        .order_by(PrintJob.submitted_at.asc(), PrintJob.id.asc())
    )
    history_stmt = (
        select(PrintJob)
        .where(PrintJob.reviewed_at.is_not(None))
        .options(
            selectinload(PrintJob.user),
            selectinload(PrintJob.teacher),
            selectinload(PrintJob.printer),
            selectinload(PrintJob.slot).selectinload(PrinterSlot.filament),
            selectinload(PrintJob.filament),
        )
        .order_by(PrintJob.reviewed_at.desc(), PrintJob.id.desc())
        .limit(30)
    )
    if not has_permission(staff_user, Permission.APPROVALS_MANAGE_ALL):
        pending_stmt = pending_stmt.where(PrintJob.teacher_id == staff_user.id)
        history_stmt = history_stmt.where(PrintJob.teacher_id == staff_user.id)

    pending_jobs = list(db.scalars(pending_stmt))
    history_jobs = list(db.scalars(history_stmt))
    return ApprovalsResponse(
        pending=[serialize_job(db, j, sys_settings) for j in pending_jobs],
        history=[serialize_job(db, j, sys_settings) for j in history_jobs],
    )


@router.post("/approvals/{job_id}/decision", response_model=JobDetail)
async def admin_decide_approval(
    job_id: int,
    body: ApprovalDecisionRequest,
    staff_user: User = Depends(require_permission(Permission.APPROVALS_MANAGE_OWN)),
    db: Session = Depends(get_db),
) -> JobDetail:
    sys_settings = get_system_settings(db)
    job = db.scalar(
        select(PrintJob)
        .where(PrintJob.id == job_id)
        .options(
            selectinload(PrintJob.user),
            selectinload(PrintJob.teacher),
            selectinload(PrintJob.printer),
            selectinload(PrintJob.slot).selectinload(PrinterSlot.filament),
            selectinload(PrintJob.filament),
        )
    )
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    if not has_permission(staff_user, Permission.APPROVALS_MANAGE_ALL) and job.teacher_id != staff_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "FORBIDDEN",
                "message": "This print approval request is assigned to another teacher",
                "required_permission": Permission.APPROVALS_MANAGE_ALL.value,
            },
        )
    if job.status != JobStatus.PENDING_APPROVAL.value:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "NOT_PENDING_APPROVAL", "message": "Job is not awaiting approval"},
        )

    job.admin_note = body.admin_note.strip() if body.admin_note else None
    job.reviewed_by_id = staff_user.id
    job.reviewed_at = utcnow()

    if body.decision == "reject":
        job.status = JobStatus.REJECTED.value
        db.commit()
        db.refresh(job)
        return serialize_job(db, job, sys_settings)

    if body.decision == "approve_and_raise":
        if not has_permission(staff_user, Permission.STUDENTS_MANAGE_ALL):
            if not has_permission(staff_user, Permission.STUDENTS_MANAGE_OWN):
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail={
                        "code": "FORBIDDEN",
                        "message": "Permission 'students:manage_own' or 'students:manage_all' is required to raise student limits.",
                        "required_permission": Permission.STUDENTS_MANAGE_OWN.value,
                    },
                )
            _ensure_teacher_owns_student(db, staff_user.id, job.user.da)
        if body.new_max_active_grams is not None:
            job.user.max_active_grams_override = body.new_max_active_grams
        if body.new_max_print_minutes is not None:
            job.user.max_print_minutes_override = body.new_max_print_minutes

    adapter = get_fdm_adapter(sys_settings)
    gcode_path = Path(job.sliced_output_path or "")
    try:
        remote_id, remote_status = await adapter.queue_job(job.printer, gcode_path, job)
    except FdmMonsterError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"code": "FDM_MONSTER_ERROR", "message": str(exc)},
        ) from exc

    job.fdm_monster_job_id = remote_id
    job.status = remote_status
    db.commit()
    db.refresh(job)
    return serialize_job(db, job, sys_settings)


# ---------------------------------------------------------------------------
# Global Settings (Admin Only)
# ---------------------------------------------------------------------------

@router.get("/system/update-status", response_model=SystemUpdateStatusOut)
async def admin_get_update_status(
    force: bool = False,
    _caller: User = Depends(require_permission(Permission.UPDATES_MANAGE)),
) -> SystemUpdateStatusOut:
    """Check GitHub Releases for the latest version of GGPrint-Web and current updater job status."""
    return await check_latest_github_release(force=force)


@router.post(
    "/system/update-trigger",
    response_model=UpdateJobStatusOut,
    status_code=status.HTTP_202_ACCEPTED,
)
async def admin_trigger_update(
    body: Optional[UpdateTriggerRequest] = None,
    caller: User = Depends(require_permission(Permission.UPDATES_MANAGE)),
) -> UpdateJobStatusOut:
    """Queue an on-demand host update to a specific release tag (or the latest GitHub release)."""
    target = (body.target_version or "").strip() if body else ""
    if not target:
        latest_status = await check_latest_github_release(force=False)
        target = (latest_status.latest_version or "").strip()
        if not target:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "code": "NO_RELEASE_AVAILABLE",
                    "message": "No target version specified and no latest GitHub release was found.",
                },
            )
    return trigger_update(target_version=target, requested_by=f"{caller.name} ({caller.da})")


@router.get("/settings", response_model=SystemSettingsOut)
def admin_get_settings(
    _admin: User = Depends(require_permission(Permission.SETTINGS_MANAGE)),
    db: Session = Depends(get_db),
) -> SystemSettingsOut:
    return serialize_settings(get_system_settings(db))


@router.patch("/settings", response_model=SystemSettingsOut)
def admin_patch_settings(
    body: SystemSettingsPatch,
    _admin: User = Depends(require_permission(Permission.SETTINGS_MANAGE)),
    db: Session = Depends(get_db),
) -> SystemSettingsOut:
    sys_settings = get_system_settings(db)
    fields = body.model_fields_set

    if "default_max_active_grams" in fields and body.default_max_active_grams is not None:
        sys_settings.default_max_active_grams = body.default_max_active_grams
    if "enforce_duration_limit" in fields and body.enforce_duration_limit is not None:
        sys_settings.enforce_duration_limit = body.enforce_duration_limit
    if "default_max_print_minutes" in fields and body.default_max_print_minutes is not None:
        sys_settings.default_max_print_minutes = body.default_max_print_minutes
    if "allow_multiple_jobs_within_budget" in fields and body.allow_multiple_jobs_within_budget is not None:
        sys_settings.allow_multiple_jobs_within_budget = body.allow_multiple_jobs_within_budget
    if "max_upload_mb" in fields and body.max_upload_mb is not None:
        sys_settings.max_upload_mb = body.max_upload_mb
    if "fdm_monster_mode" in fields and body.fdm_monster_mode is not None:
        sys_settings.fdm_monster_mode = body.fdm_monster_mode
    if "fdm_monster_url" in fields and body.fdm_monster_url is not None:
        sys_settings.fdm_monster_url = body.fdm_monster_url.strip()
    if "fdm_monster_api_key" in fields and body.fdm_monster_api_key is not None:
        # Ignore masked placeholder if client sends back masked value unchanged
        if not body.fdm_monster_api_key.startswith("*"):
            sys_settings.fdm_monster_api_key = body.fdm_monster_api_key.strip()
    if "slicer_mode" in fields and body.slicer_mode is not None:
        sys_settings.slicer_mode = body.slicer_mode
    if "orca_cli_path" in fields and body.orca_cli_path is not None:
        try:
            sys_settings.orca_cli_path = validate_orca_cli_path(body.orca_cli_path)
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"code": "INVALID_SLICER_PATH", "message": str(exc)},
            ) from exc
    if "filament_api_enabled" in fields and body.filament_api_enabled is not None:
        sys_settings.filament_api_enabled = body.filament_api_enabled
    if "filament_api_url" in fields and body.filament_api_url is not None:
        sys_settings.filament_api_url = body.filament_api_url.strip()

    db.commit()
    db.refresh(sys_settings)
    return serialize_settings(sys_settings)


# ---------------------------------------------------------------------------
# FilamentAPI Integration (Admin Only)
# ---------------------------------------------------------------------------

@router.post("/filament-api/test", response_model=FilamentApiHealthOut)
async def admin_test_filament_api(
    body: Optional[FilamentApiTestRequest] = None,
    _admin: User = Depends(require_permission(Permission.SETTINGS_MANAGE)),
    db: Session = Depends(get_db),
) -> FilamentApiHealthOut:
    """Test connectivity to FilamentAPI using the provided URL or saved setting."""
    sys_settings = get_system_settings(db)
    target_url = (body.url if body and body.url else sys_settings.filament_api_url) or ""
    client = FilamentApiClient(base_url=target_url)
    return await client.check_health()


@router.get("/filament-api/printers", response_model=list[FilamentApiPrinterOut])
async def admin_list_filament_api_printers(
    _admin: User = Depends(require_permission(Permission.PRINTERS_MANAGE)),
    db: Session = Depends(get_db),
) -> list[FilamentApiPrinterOut]:
    """List printers configured in FilamentAPI for mapping in the admin panel."""
    sys_settings = get_system_settings(db)
    if not sys_settings.filament_api_enabled or not (sys_settings.filament_api_url or "").strip():
        return []
    client = FilamentApiClient(base_url=sys_settings.filament_api_url)
    try:
        return await client.list_printers()
    except FilamentApiError:
        return []


@router.post("/printers/sync-filaments", response_model=FilamentSyncResponse)
async def admin_sync_printer_filaments(
    _admin: User = Depends(require_permission(Permission.PRINTERS_MANAGE)),
    db: Session = Depends(get_db),
) -> FilamentSyncResponse:
    """Query FilamentAPI for all mapped printers and update their loaded filaments."""
    sys_settings = get_system_settings(db)
    if not sys_settings.filament_api_enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "FILAMENT_API_DISABLED", "message": "FilamentAPI auto-sync is disabled in settings"},
        )
    return await sync_all_printers_filaments(db, sys_settings)
