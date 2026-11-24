"""Administrator routes (/api/admin)."""

from __future__ import annotations

import csv
import io
import secrets
import string
from collections.abc import Iterable
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.auth import hash_password, require_staff, require_super_admin
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
    ClassCsvResult,
    ClassDeleteOut,
    ClassEnrollmentOut,
    ClassStudentRemoveOut,
    FilamentCreate,
    FilamentOut,
    FilamentPatch,
    JobDetail,
    OrcaProfileOut,
    PendingAccountOut,
    PrinterSlotUpdate,
    ResetPasswordRequest,
    ResetPasswordResponse,
    StudentClassBadge,
    SystemSettingsOut,
    SystemSettingsPatch,
    TeacherClassCreate,
    TeacherClassOut,
    TestSliceRequest,
    TestSliceResponse,
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
from app.services.profiles import (
    delete_profile_file,
    save_profile_file,
    test_slice_calibration_cube,
)
from app.services.serializers import (
    serialize_admin_printer,
    serialize_job,
    serialize_settings,
)
from app.services.slicer import SlicerError

router = APIRouter(prefix="/api/admin", tags=["admin"])


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
    out_enrollments = [
        ClassEnrollmentOut(
            id=e.id,
            class_id=e.class_id,
            da=e.da,
            suggested_name=e.suggested_name,
            max_active_grams_override=e.max_active_grams_override,
            max_print_minutes_override=e.max_print_minutes_override,
            is_registered=e.da in users_by_da,
            is_active=users_by_da[e.da].is_active if e.da in users_by_da else None,
            created_at=e.created_at,
        )
        for e in enrollments
    ]
    return TeacherClassOut(
        id=tc.id,
        teacher_id=tc.teacher_id,
        teacher_name=tc.teacher.name if tc.teacher else "",
        name=tc.name,
        code=tc.code,
        is_default_individual=tc.is_default_individual,
        student_count=len(out_enrollments),
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
# Printers & MMU Slots
# ---------------------------------------------------------------------------

@router.get("/printers", response_model=list[AdminPrinterOut])
async def admin_list_printers(
    _staff: User = Depends(require_staff),
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
    _staff: User = Depends(require_staff),
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
    _staff: User = Depends(require_staff),
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
    _staff: User = Depends(require_staff),
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
    _staff: User = Depends(require_staff),
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
# Filaments & OrcaSlicer Profiles
# ---------------------------------------------------------------------------

@router.get("/filaments", response_model=list[FilamentOut])
def admin_list_filaments(
    _staff: User = Depends(require_staff),
    db: Session = Depends(get_db),
) -> list[FilamentOut]:
    filaments = list(db.scalars(select(Filament).order_by(Filament.id.asc())))
    return [FilamentOut.model_validate(f) for f in filaments]


@router.post("/filaments", response_model=FilamentOut, status_code=status.HTTP_201_CREATED)
def admin_create_filament(
    body: FilamentCreate,
    _staff: User = Depends(require_staff),
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


@router.patch("/filaments/{filament_id}", response_model=FilamentOut)
def admin_patch_filament(
    filament_id: int,
    body: FilamentPatch,
    _staff: User = Depends(require_staff),
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
    _staff: User = Depends(require_staff),
    db: Session = Depends(get_db),
) -> None:
    filament = db.get(Filament, filament_id)
    if filament is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Filament not found")
    db.delete(filament)
    db.commit()


@router.get("/profiles", response_model=list[OrcaProfileOut])
def admin_list_profiles(
    _staff: User = Depends(require_staff),
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
    _staff: User = Depends(require_staff),
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

    raw = await file.read()
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
    _staff: User = Depends(require_staff),
    db: Session = Depends(get_db),
) -> None:
    profile = db.get(OrcaProfile, profile_id)
    if profile is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Profile not found")
    delete_profile_file(profile)
    db.delete(profile)
    db.commit()


@router.post("/profiles/test-slice", response_model=TestSliceResponse)
def admin_test_slice_profile(
    body: TestSliceRequest,
    _staff: User = Depends(require_staff),
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
# Teachers (Super-Admin Only)
# ---------------------------------------------------------------------------

@router.get("/teachers", response_model=list[AdminTeacherOut])
def admin_list_teachers(
    _super_admin: User = Depends(require_super_admin),
    db: Session = Depends(get_db),
) -> list[AdminTeacherOut]:
    teachers = list(
        db.scalars(select(User).where(User.role == "teacher").order_by(User.name.asc(), User.id.asc()))
    )
    return [_serialize_teacher(db, t) for t in teachers]


@router.post("/teachers", response_model=AdminTeacherOut, status_code=status.HTTP_201_CREATED)
def admin_create_teacher(
    body: AdminTeacherCreate,
    _super_admin: User = Depends(require_super_admin),
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
    teacher = User(
        da=body.identifier,
        name=body.name.strip(),
        password_hash=hash_password(body.password),
        role="teacher",
        approval_status="approved",
        is_active=True,
    )
    db.add(teacher)
    db.commit()
    db.refresh(teacher)
    return _serialize_teacher(db, teacher)


@router.patch("/teachers/{teacher_id}", response_model=AdminTeacherOut)
def admin_patch_teacher(
    teacher_id: int,
    body: AdminTeacherPatch,
    _super_admin: User = Depends(require_super_admin),
    db: Session = Depends(get_db),
) -> AdminTeacherOut:
    teacher = db.get(User, teacher_id)
    if teacher is None or teacher.role != "teacher":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Teacher not found")

    fields = body.model_fields_set
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
    _super_admin: User = Depends(require_super_admin),
    db: Session = Depends(get_db),
) -> ResetPasswordResponse:
    teacher = db.get(User, teacher_id)
    if teacher is None or teacher.role != "teacher":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Teacher not found")

    if body and body.new_password:
        temp_pwd = body.new_password
    else:
        alphabet = string.ascii_letters + string.digits
        temp_pwd = "".join(secrets.choice(alphabet) for _ in range(8))

    teacher.password_hash = hash_password(temp_pwd)
    db.commit()
    return ResetPasswordResponse(da=teacher.da, temp_password=temp_pwd)


@router.delete("/teachers/{teacher_id}", status_code=status.HTTP_204_NO_CONTENT)
def admin_delete_teacher(
    teacher_id: int,
    _super_admin: User = Depends(require_super_admin),
    db: Session = Depends(get_db),
) -> None:
    teacher = db.scalar(
        select(User)
        .where(User.id == teacher_id, User.role == "teacher")
        .options(selectinload(User.classes).selectinload(TeacherClass.enrollments))
    )
    if teacher is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Teacher not found")

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

@router.get("/classes", response_model=list[TeacherClassOut])
def admin_list_classes(
    staff_user: User = Depends(require_staff),
    db: Session = Depends(get_db),
) -> list[TeacherClassOut]:
    stmt = (
        select(TeacherClass)
        .options(selectinload(TeacherClass.teacher), selectinload(TeacherClass.enrollments))
        .order_by(TeacherClass.teacher_id.asc(), TeacherClass.created_at.asc(), TeacherClass.id.asc())
    )
    if staff_user.role == "teacher":
        stmt = stmt.where(TeacherClass.teacher_id == staff_user.id)
    classes = list(db.scalars(stmt))
    return [_serialize_teacher_class(db, tc) for tc in classes]


@router.post("/classes", response_model=TeacherClassOut, status_code=status.HTTP_201_CREATED)
def admin_create_class(
    body: TeacherClassCreate,
    staff_user: User = Depends(require_staff),
    db: Session = Depends(get_db),
) -> TeacherClassOut:
    if staff_user.role == "teacher":
        if body.teacher_id is not None and body.teacher_id != staff_user.id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={"code": "FORBIDDEN", "message": "Teachers can only create classes for themselves"},
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


@router.delete("/classes/{class_id}", response_model=ClassDeleteOut)
def admin_delete_class(
    class_id: int,
    staff_user: User = Depends(require_staff),
    db: Session = Depends(get_db),
) -> ClassDeleteOut:
    tc = db.scalar(
        select(TeacherClass)
        .where(TeacherClass.id == class_id)
        .options(selectinload(TeacherClass.enrollments))
    )
    if tc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Class not found")
    if staff_user.role != "admin" and tc.teacher_id != staff_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "FORBIDDEN", "message": "You do not own this class"},
        )

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
    staff_user: User = Depends(require_staff),
    db: Session = Depends(get_db),
) -> ClassEnrollmentOut:
    tc = db.get(TeacherClass, class_id)
    if tc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Class not found")
    if staff_user.role != "admin" and tc.teacher_id != staff_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "FORBIDDEN", "message": "You do not own this class"},
        )

    existing = db.scalar(
        select(ClassEnrollment).where(ClassEnrollment.class_id == tc.id, ClassEnrollment.da == body.da)
    )
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "DA_ALREADY_IN_CLASS", "message": f"DA {body.da} is already in this class"},
        )

    enrollment = ClassEnrollment(
        class_id=tc.id,
        da=body.da,
        suggested_name=body.suggested_name.strip() if body.suggested_name else None,
        max_active_grams_override=body.max_active_grams_override,
        max_print_minutes_override=body.max_print_minutes_override,
    )
    db.add(enrollment)
    _reactivate_enrolled_student(db, body.da)
    db.commit()
    db.refresh(enrollment)

    stu = db.scalar(select(User).where(User.da == enrollment.da, User.role == "student"))
    return ClassEnrollmentOut(
        id=enrollment.id,
        class_id=enrollment.class_id,
        da=enrollment.da,
        suggested_name=enrollment.suggested_name,
        max_active_grams_override=enrollment.max_active_grams_override,
        max_print_minutes_override=enrollment.max_print_minutes_override,
        is_registered=stu is not None,
        is_active=stu.is_active if stu is not None else None,
        created_at=enrollment.created_at,
    )


@router.post("/classes/{class_id}/import-csv", response_model=ClassCsvResult)
async def admin_import_class_csv(
    class_id: int,
    file: UploadFile = File(...),
    staff_user: User = Depends(require_staff),
    db: Session = Depends(get_db),
) -> ClassCsvResult:
    tc = db.get(TeacherClass, class_id)
    if tc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Class not found")
    if staff_user.role != "admin" and tc.teacher_id != staff_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "FORBIDDEN", "message": "You do not own this class"},
        )

    raw = await file.read()
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
                max_grams = float(row[2].strip())
            if len(row) > 3 and row[3].strip():
                max_mins = int(row[3].strip())
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
        existing_das.add(first)
        added += 1
        if _reactivate_enrolled_student(db, first):
            reactivated += 1

    db.commit()
    return ClassCsvResult(added=added, skipped=skipped, reactivated=reactivated)


@router.delete("/classes/{class_id}/students/{da}", response_model=ClassStudentRemoveOut)
def admin_remove_class_student(
    class_id: int,
    da: str,
    staff_user: User = Depends(require_staff),
    db: Session = Depends(get_db),
) -> ClassStudentRemoveOut:
    tc = db.get(TeacherClass, class_id)
    if tc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Class not found")
    if staff_user.role != "admin" and tc.teacher_id != staff_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "FORBIDDEN", "message": "You do not own this class"},
        )

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
    staff_user: User = Depends(require_staff),
    db: Session = Depends(get_db),
) -> list[WhitelistEntryOut]:
    registered_das = set(db.scalars(select(User.da).where(User.role == "student")))
    if staff_user.role == "teacher":
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
    staff_user: User = Depends(require_staff),
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
    staff_user: User = Depends(require_staff),
    db: Session = Depends(get_db),
) -> WhitelistCsvResult:
    tc = _resolve_legacy_whitelist_class(db, staff_user)
    raw = await file.read()
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
                max_grams = float(row[2].strip())
            if len(row) > 3 and row[3].strip():
                max_mins = int(row[3].strip())
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
    staff_user: User = Depends(require_staff),
    db: Session = Depends(get_db),
) -> None:
    if staff_user.role == "teacher":
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
        legacy = db.get(DAWhitelist, da)
        if legacy is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Whitelist entry not found")
        db.delete(legacy)
        db.commit()
        return
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
    staff_user: User = Depends(require_staff),
    db: Session = Depends(get_db),
) -> list[AdminStudentOut]:
    sys_settings = get_system_settings(db)
    if staff_user.role == "teacher":
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


@router.patch("/students/{user_id}", response_model=AdminStudentOut)
def admin_patch_student(
    user_id: int,
    body: AdminStudentPatch,
    staff_user: User = Depends(require_staff),
    db: Session = Depends(get_db),
) -> AdminStudentOut:
    user = db.get(User, user_id)
    if user is None or user.role != "student":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Student not found")

    if staff_user.role == "teacher":
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
    staff_user: User = Depends(require_staff),
    db: Session = Depends(get_db),
) -> ResetPasswordResponse:
    user = db.get(User, user_id)
    if user is None or user.role != "student":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Student not found")

    if staff_user.role == "teacher":
        _ensure_teacher_owns_student(db, staff_user.id, user.da)

    if body and body.new_password:
        temp_pwd = body.new_password
    else:
        alphabet = string.ascii_letters + string.digits
        temp_pwd = "".join(secrets.choice(alphabet) for _ in range(8))

    user.password_hash = hash_password(temp_pwd)
    db.commit()
    return ResetPasswordResponse(da=user.da, temp_password=temp_pwd)


@router.get("/account-requests", response_model=list[PendingAccountOut])
def admin_list_account_requests(
    staff_user: User = Depends(require_staff),
    db: Session = Depends(get_db),
) -> list[PendingAccountOut]:
    stmt = (
        select(User)
        .where(User.role == "student", User.approval_status == "pending")
        .options(selectinload(User.requested_teacher))
        .order_by(User.created_at.asc(), User.id.asc())
    )
    if staff_user.role == "teacher":
        stmt = stmt.where(User.requested_teacher_id == staff_user.id)
    pending_users = list(db.scalars(stmt))
    return [_serialize_pending_account(u) for u in pending_users]


@router.post("/account-requests/{user_id}/decision", response_model=PendingAccountOut)
def admin_decide_account_request(
    user_id: int,
    body: AccountDecisionRequest,
    staff_user: User = Depends(require_staff),
    db: Session = Depends(get_db),
) -> PendingAccountOut:
    user = db.scalar(
        select(User).where(User.id == user_id).options(selectinload(User.requested_teacher))
    )
    if user is None or user.role != "student":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Student account request not found")

    if staff_user.role == "teacher" and user.requested_teacher_id != staff_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "FORBIDDEN", "message": "This account request is assigned to another teacher"},
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
        if staff_user.role == "teacher" and target_cls.teacher_id != staff_user.id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={"code": "FORBIDDEN", "message": "Selected class belongs to another teacher"},
            )
    else:
        target_teacher_id = staff_user.id if staff_user.role == "teacher" else user.requested_teacher_id
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
    staff_user: User = Depends(require_staff),
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
    if staff_user.role == "teacher":
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
    staff_user: User = Depends(require_staff),
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
    if staff_user.role == "teacher" and job.teacher_id != staff_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "FORBIDDEN", "message": "This print approval request is assigned to another teacher"},
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
# Global Settings (Super-Admin Only)
# ---------------------------------------------------------------------------

@router.get("/settings", response_model=SystemSettingsOut)
def admin_get_settings(
    _super_admin: User = Depends(require_super_admin),
    db: Session = Depends(get_db),
) -> SystemSettingsOut:
    return serialize_settings(get_system_settings(db))


@router.patch("/settings", response_model=SystemSettingsOut)
def admin_patch_settings(
    body: SystemSettingsPatch,
    _super_admin: User = Depends(require_super_admin),
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
        sys_settings.orca_cli_path = body.orca_cli_path.strip()

    db.commit()
    db.refresh(sys_settings)
    return serialize_settings(sys_settings)
