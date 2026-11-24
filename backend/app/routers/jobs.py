"""Student job upload, 3D transform/slice, submit, approval request, and cancel routes (/api/jobs)."""

from __future__ import annotations

import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.auth import get_current_user
from app.config import settings
from app.database import get_db
from app.models import (
    ClassEnrollment,
    JobStatus,
    PrintJob,
    Printer,
    PrinterSlot,
    TeacherClass,
    User,
    utcnow,
)
from app.schemas import (
    JobDetail,
    MyJobsResponse,
    RequestApprovalBody,
    TransformPayload,
)
from app.services.budget import (
    build_user_summary,
    compute_budget_check,
    get_system_settings,
)
from app.services.fdm_monster import FdmMonsterError, get_fdm_adapter
from app.services.serializers import serialize_job
from app.services.slicer import (
    OutOfBoundsError,
    SlicerError,
    run_auto_orient,
    run_slice,
)

router = APIRouter(prefix="/api/jobs", tags=["jobs"])


def _load_job_for_user(db: Session, job_id: int, user: User) -> PrintJob:
    job = db.scalar(
        select(PrintJob)
        .where(PrintJob.id == job_id)
        .options(
            selectinload(PrintJob.user),
            selectinload(PrintJob.teacher),
            selectinload(PrintJob.printer).selectinload(Printer.machine_profile),
            selectinload(PrintJob.printer).selectinload(Printer.process_profile),
            selectinload(PrintJob.slot).selectinload(PrinterSlot.filament),
            selectinload(PrintJob.filament),
        )
    )
    if job is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "JOB_NOT_FOUND", "message": "Print job not found"},
        )
    can_access = (
        job.user_id == user.id
        or user.role == "admin"
        or (user.role == "teacher" and job.teacher_id == user.id)
    )
    if not can_access:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "FORBIDDEN", "message": "You do not have access to this job"},
        )
    return job


def _validate_printer_and_slot(db: Session, printer_id: int, slot_id: int) -> tuple[Printer, PrinterSlot]:
    printer = db.scalar(
        select(Printer)
        .where(Printer.id == printer_id)
        .options(
            selectinload(Printer.machine_profile),
            selectinload(Printer.process_profile),
        )
    )
    if printer is None or not printer.is_enabled:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "PRINTER_NOT_FOUND", "message": "Printer not found or disabled"},
        )

    slot = db.scalar(
        select(PrinterSlot)
        .where(PrinterSlot.id == slot_id, PrinterSlot.printer_id == printer.id)
        .options(
            selectinload(PrinterSlot.filament),
        )
    )
    if slot is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "INVALID_SLOT", "message": "Selected slot does not belong to the selected printer"},
        )
    return printer, slot


@router.post("/upload", response_model=JobDetail, status_code=status.HTTP_201_CREATED)
async def upload_stl_job(
    file: UploadFile = File(...),
    printer_id: int = Form(...),
    slot_id: int = Form(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JobDetail:
    """Upload a .stl file, auto-orient it flat on the bed centered at (0,0), and create a DRAFT job."""
    sys_settings = get_system_settings(db)
    filename = Path(file.filename or "model.stl").name
    if not filename.lower().endswith(".stl"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "INVALID_FILE_TYPE", "message": "Only .stl files are supported"},
        )

    raw_bytes = await file.read()
    max_bytes = int(sys_settings.max_upload_mb) * 1024 * 1024
    if len(raw_bytes) == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "EMPTY_FILE", "message": "Uploaded STL file is empty"},
        )
    if len(raw_bytes) > max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail={
                "code": "FILE_TOO_LARGE",
                "message": f"File exceeds max upload size of {sys_settings.max_upload_mb} MB",
            },
        )

    printer, slot = _validate_printer_and_slot(db, printer_id, slot_id)

    settings.ensure_directories()
    job_dir = settings.jobs_dir / uuid.uuid4().hex
    job_dir.mkdir(parents=True, exist_ok=True)
    original_path = job_dir / "original.stl"
    oriented_path = job_dir / "oriented.stl"
    original_path.write_bytes(raw_bytes)

    try:
        bounds = run_auto_orient(original_path, oriented_path, sys_settings)
    except SlicerError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "INVALID_STL", "message": str(exc)},
        ) from exc

    job = PrintJob(
        user_id=current_user.id,
        printer_id=printer.id,
        slot_id=slot.id,
        filament_id=slot.filament_id,
        status=JobStatus.DRAFT.value,
        original_filename=filename,
        original_stl_path=str(original_path),
        oriented_stl_path=str(oriented_path),
        pos_x_mm=0.0,
        pos_y_mm=0.0,
        quat_x=0.0,
        quat_y=0.0,
        quat_z=0.0,
        quat_w=1.0,
        scale=1.0,
        bbox_min_x=bounds.min_x,
        bbox_max_x=bounds.max_x,
        bbox_min_y=bounds.min_y,
        bbox_max_y=bounds.max_y,
        bbox_min_z=bounds.min_z,
        bbox_max_z=bounds.max_z,
        supports_enabled=True,
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    loaded = _load_job_for_user(db, job.id, current_user)
    return serialize_job(db, loaded, sys_settings)


@router.post("/{job_id}/reorient", response_model=JobDetail)
def reorient_job(
    job_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JobDetail:
    """Re-run server auto-orient on original.stl and reset transform to centered identity."""
    sys_settings = get_system_settings(db)
    job = _load_job_for_user(db, job_id, current_user)
    if job.status not in (JobStatus.DRAFT.value, JobStatus.SLICED.value, JobStatus.REJECTED.value):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "INVALID_JOB_STATE", "message": "Cannot reorient a job that is already submitted"},
        )

    bounds = run_auto_orient(Path(job.original_stl_path), Path(job.oriented_stl_path), sys_settings)
    job.pos_x_mm = 0.0
    job.pos_y_mm = 0.0
    job.quat_x = 0.0
    job.quat_y = 0.0
    job.quat_z = 0.0
    job.quat_w = 1.0
    job.scale = 1.0
    job.bbox_min_x = bounds.min_x
    job.bbox_max_x = bounds.max_x
    job.bbox_min_y = bounds.min_y
    job.bbox_max_y = bounds.max_y
    job.bbox_min_z = bounds.min_z
    job.bbox_max_z = bounds.max_z
    job.status = JobStatus.DRAFT.value
    job.estimated_grams = None
    job.estimated_minutes = None
    job.layer_count = None
    job.sliced_output_path = None
    job.gcode_filename = None
    db.commit()
    db.refresh(job)
    return serialize_job(db, _load_job_for_user(db, job.id, current_user), sys_settings)


@router.get("/{job_id}/mesh")
def get_job_oriented_mesh(
    job_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> FileResponse:
    """Stream the auto-oriented STL binary for the owner or admin."""
    job = _load_job_for_user(db, job_id, current_user)
    mesh_path = Path(job.oriented_stl_path)
    if not mesh_path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "MESH_NOT_FOUND", "message": "Oriented mesh file not found"},
        )
    return FileResponse(path=mesh_path, media_type="model/stl", filename=f"oriented_{job.original_filename}")


@router.post("/{job_id}/slice", response_model=JobDetail)
def slice_job(
    job_id: int,
    payload: TransformPayload,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JobDetail:
    """Validate bed bounds, bake student transform, and slice using admin profiles."""
    sys_settings = get_system_settings(db)
    job = _load_job_for_user(db, job_id, current_user)
    if job.status not in (JobStatus.DRAFT.value, JobStatus.SLICED.value, JobStatus.REJECTED.value):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "INVALID_JOB_STATE", "message": "Cannot re-slice a job after submission"},
        )

    printer, slot = _validate_printer_and_slot(db, payload.printer_id, payload.slot_id)

    job_dir = Path(job.oriented_stl_path).parent
    stem = Path(job.original_filename).stem
    gcode_path = job_dir / f"{stem}_{printer.fdm_monster_id}_slot{slot.slot_index}.gcode"

    try:
        result = run_slice(
            oriented_stl_path=Path(job.oriented_stl_path),
            output_gcode_path=gcode_path,
            printer=printer,
            slot=slot,
            sys_settings=sys_settings,
            pos_x_mm=payload.pos_x_mm,
            pos_y_mm=payload.pos_y_mm,
            quat_x=payload.quat_x,
            quat_y=payload.quat_y,
            quat_z=payload.quat_z,
            quat_w=payload.quat_w,
            scale=payload.scale,
            supports_enabled=payload.supports_enabled,
        )
    except OutOfBoundsError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "OUT_OF_BOUNDS", "message": str(exc)},
        ) from exc
    except SlicerError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "SLICER_ERROR", "message": str(exc)},
        ) from exc

    job.printer_id = printer.id
    job.slot_id = slot.id
    job.filament_id = slot.filament_id
    job.pos_x_mm = payload.pos_x_mm
    job.pos_y_mm = payload.pos_y_mm
    job.quat_x = payload.quat_x
    job.quat_y = payload.quat_y
    job.quat_z = payload.quat_z
    job.quat_w = payload.quat_w
    job.scale = payload.scale
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
    job.status = JobStatus.SLICED.value

    db.commit()
    db.refresh(job)
    return serialize_job(db, _load_job_for_user(db, job.id, current_user), sys_settings)


@router.post("/{job_id}/submit", response_model=JobDetail)
async def submit_job(
    job_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JobDetail:
    """Atomically verify active budget & duration limit, then queue job in FDM Monster."""
    sys_settings = get_system_settings(db)
    job = _load_job_for_user(db, job_id, current_user)
    if job.status != JobStatus.SLICED.value or job.estimated_grams is None or job.estimated_minutes is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "JOB_NOT_SLICED", "message": "Job must be sliced before submitting"},
        )

    if job.printer and job.printer.status == "printing":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "PRINTER_BUSY",
                "message": "Cette imprimante est actuellement en cours d'impression. Sélectionnez une imprimante libre.",
            },
        )

    # Refresh user and compute budget check atomically
    db.refresh(job.user)
    budget = compute_budget_check(
        db=db,
        user=job.user,
        estimated_grams=job.estimated_grams,
        estimated_minutes=job.estimated_minutes,
        sys_settings=sys_settings,
        exclude_job_id=job.id,
    )
    if not budget.can_auto_submit:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "LIMIT_EXCEEDED",
                "message": "Print exceeds active weight budget, duration limit, or active job policy. Request admin approval instead.",
                "budget_check": budget.model_dump(),
            },
        )

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
    job.submitted_at = utcnow()
    db.commit()
    db.refresh(job)
    return serialize_job(db, _load_job_for_user(db, job.id, current_user), sys_settings)


@router.post("/{job_id}/request-approval", response_model=JobDetail)
def request_job_approval(
    job_id: int,
    body: RequestApprovalBody,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JobDetail:
    """Reserve active grams and route a sliced job in PENDING_APPROVAL to a teacher."""
    sys_settings = get_system_settings(db)
    job = _load_job_for_user(db, job_id, current_user)
    if job.status != JobStatus.SLICED.value or job.estimated_grams is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "JOB_NOT_SLICED", "message": "Job must be sliced before requesting approval"},
        )

    owner = job.user
    student_teacher_ids = list(
        db.scalars(
            select(TeacherClass.teacher_id)
            .join(ClassEnrollment, ClassEnrollment.class_id == TeacherClass.id)
            .join(User, TeacherClass.teacher_id == User.id)
            .where(
                ClassEnrollment.da == owner.da,
                User.role == "teacher",
                User.is_active == True,  # noqa: E712
            )
            .distinct()
        )
    )

    selected_teacher_id: int
    if body.teacher_id is not None:
        teacher = db.get(User, body.teacher_id)
        if teacher is None or teacher.role != "teacher" or not teacher.is_active:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"code": "TEACHER_NOT_FOUND", "message": "Selected teacher not found or inactive"},
            )
        if len(student_teacher_ids) >= 1 and body.teacher_id not in student_teacher_ids:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "code": "INVALID_TEACHER_SELECTION",
                    "message": "Selected teacher does not match your enrolled classes",
                },
            )
        selected_teacher_id = teacher.id
    else:
        if len(student_teacher_ids) == 1:
            selected_teacher_id = student_teacher_ids[0]
        elif len(student_teacher_ids) > 1:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "code": "TEACHER_REQUIRED",
                    "message": "Please choose which teacher should review this request",
                },
            )
        elif owner.requested_teacher_id is not None:
            req_teacher = db.get(User, owner.requested_teacher_id)
            if req_teacher is not None and req_teacher.role == "teacher" and req_teacher.is_active:
                selected_teacher_id = req_teacher.id
            else:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail={
                        "code": "TEACHER_REQUIRED",
                        "message": "Please choose which teacher should review this request",
                    },
                )
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "code": "TEACHER_REQUIRED",
                    "message": "Please choose which teacher should review this request",
                },
            )

    job.teacher_id = selected_teacher_id
    job.student_note = body.note.strip() if body.note else None
    job.status = JobStatus.PENDING_APPROVAL.value
    job.submitted_at = utcnow()
    db.commit()
    db.refresh(job)
    return serialize_job(db, _load_job_for_user(db, job.id, current_user), sys_settings)


@router.get("/mine", response_model=MyJobsResponse)
def get_my_jobs(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> MyJobsResponse:
    """Return the current user's budget summary and jobs ordered newest-first."""
    sys_settings = get_system_settings(db)
    jobs = list(
        db.scalars(
            select(PrintJob)
            .where(PrintJob.user_id == current_user.id)
            .options(
                selectinload(PrintJob.user),
                selectinload(PrintJob.teacher),
                selectinload(PrintJob.printer),
                selectinload(PrintJob.slot).selectinload(PrinterSlot.filament),
                selectinload(PrintJob.filament),
            )
            .order_by(PrintJob.created_at.desc(), PrintJob.id.desc())
        )
    )
    return MyJobsResponse(
        user=build_user_summary(db, current_user, sys_settings),
        jobs=[serialize_job(db, j, sys_settings) for j in jobs],
    )


@router.post("/{job_id}/cancel", response_model=JobDetail)
async def cancel_job(
    job_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JobDetail:
    """Cancel an active job (PENDING_APPROVAL, QUEUED, PRINTING) and refund its active grams."""
    sys_settings = get_system_settings(db)
    job = _load_job_for_user(db, job_id, current_user)
    cancellable = (
        JobStatus.PENDING_APPROVAL.value,
        JobStatus.QUEUED.value,
        JobStatus.PRINTING.value,
    )
    if job.status not in cancellable:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "INVALID_JOB_STATE", "message": f"Cannot cancel job in status {job.status}"},
        )

    if job.status in (JobStatus.QUEUED.value, JobStatus.PRINTING.value) and job.fdm_monster_job_id:
        adapter = get_fdm_adapter(sys_settings)
        try:
            await adapter.cancel_job(job.fdm_monster_job_id)
        except FdmMonsterError as exc:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail={"code": "FDM_MONSTER_ERROR", "message": str(exc)},
            ) from exc

    job.status = JobStatus.CANCELLED.value
    job.completed_at = utcnow()
    db.commit()
    db.refresh(job)
    return serialize_job(db, _load_job_for_user(db, job.id, current_user), sys_settings)


@router.post("/{job_id}/dev-complete", response_model=JobDetail)
async def dev_complete_job(
    job_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JobDetail:
    """Mock-mode helper: mark a QUEUED/PRINTING job COMPLETED so active grams auto-refund immediately."""
    sys_settings = get_system_settings(db)
    if sys_settings.fdm_monster_mode != "mock":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "NOT_IN_MOCK_MODE", "message": "dev-complete is only available when fdm_monster_mode is 'mock'"},
        )

    job = _load_job_for_user(db, job_id, current_user)
    if job.status not in (JobStatus.QUEUED.value, JobStatus.PRINTING.value):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "INVALID_JOB_STATE", "message": "Only QUEUED or PRINTING jobs can be completed"},
        )

    if job.fdm_monster_job_id:
        adapter = get_fdm_adapter(sys_settings)
        if hasattr(adapter, "complete_job"):
            await adapter.complete_job(job.fdm_monster_job_id)  # type: ignore[union-attr]

    job.status = JobStatus.COMPLETED.value
    job.completed_at = utcnow()
    db.commit()
    db.refresh(job)
    return serialize_job(db, _load_job_for_user(db, job.id, current_user), sys_settings)
