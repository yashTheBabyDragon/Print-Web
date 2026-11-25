"""ORM-to-Pydantic serialization helpers."""

from __future__ import annotations

from typing import Optional

from sqlalchemy.orm import Session

from app.models import PrintJob, Printer, PrinterSlot, SystemSettings, User
from app.schemas import (
    AdminPrinterOut,
    BoundingBoxOut,
    JobDetail,
    PrinterOut,
    PrinterSlotOut,
    SystemSettingsOut,
)
from app.services.budget import compute_budget_check


def serialize_slot(slot: PrinterSlot) -> PrinterSlotOut:
    filament = slot.filament
    return PrinterSlotOut(
        id=slot.id,
        slot_index=slot.slot_index,
        label=slot.label,
        filament_id=slot.filament_id,
        filament_name=filament.name if filament else None,
        material=filament.material if filament else None,
        color_hex=filament.color_hex if filament else None,
        is_loaded=slot.is_loaded,
    )


def serialize_printer(printer: Printer) -> PrinterOut:
    return PrinterOut(
        id=printer.id,
        name=printer.display_name or printer.name,
        fdm_monster_id=printer.fdm_monster_id,
        printer_type=printer.printer_type,
        status=printer.status,
        queue_count=printer.queue_count,
        bed_x_mm=printer.bed_x_mm,
        bed_y_mm=printer.bed_y_mm,
        bed_z_mm=printer.bed_z_mm,
        mmu_slots_count=printer.mmu_slots_count,
        has_mmu=printer.mmu_slots_count > 1,
        slots=[serialize_slot(s) for s in sorted(printer.slots, key=lambda x: x.slot_index)],
    )


def serialize_admin_printer(printer: Printer) -> AdminPrinterOut:
    base = serialize_printer(printer)
    return AdminPrinterOut(
        **base.model_dump(),
        display_name=printer.display_name,
        is_enabled=printer.is_enabled,
        machine_profile_id=printer.machine_profile_id,
        process_profile_id=printer.process_profile_id,
        filament_api_printer_id=printer.filament_api_printer_id,
    )


def serialize_job(
    db: Session,
    job: PrintJob,
    sys_settings: Optional[SystemSettings] = None,
) -> JobDetail:
    filament = job.filament or (job.slot.filament if job.slot else None)
    budget_check = None
    if job.estimated_grams is not None and job.estimated_minutes is not None:
        budget_check = compute_budget_check(
            db=db,
            user=job.user,
            estimated_grams=job.estimated_grams,
            estimated_minutes=job.estimated_minutes,
            sys_settings=sys_settings,
            exclude_job_id=job.id,
        )

    teacher_name = None
    if job.teacher_id is not None:
        teacher = job.teacher if job.teacher is not None else db.get(User, job.teacher_id)
        teacher_name = teacher.name if teacher else None

    return JobDetail(
        id=job.id,
        user_id=job.user_id,
        user_da=job.user.da if job.user else None,
        user_name=job.user.name if job.user else None,
        teacher_id=job.teacher_id,
        teacher_name=teacher_name,
        printer_id=job.printer_id,
        printer_name=job.printer.display_name if job.printer else "",
        slot_id=job.slot_id,
        slot_index=job.slot.slot_index if job.slot else 1,
        slot_label=job.slot.label if job.slot else "",
        filament_id=filament.id if filament else None,
        filament_name=filament.name if filament else None,
        filament_material=filament.material if filament else None,
        filament_color_hex=filament.color_hex if filament else None,
        status=job.status,
        original_filename=job.original_filename,
        oriented_mesh_url=f"/api/jobs/{job.id}/mesh",
        gcode_filename=job.gcode_filename,
        gcode_url=f"/api/jobs/{job.id}/gcode" if job.sliced_output_path else None,
        pos_x_mm=job.pos_x_mm,
        pos_y_mm=job.pos_y_mm,
        quat_x=job.quat_x,
        quat_y=job.quat_y,
        quat_z=job.quat_z,
        quat_w=job.quat_w,
        scale=job.scale,
        bbox=BoundingBoxOut(
            min_x=job.bbox_min_x,
            max_x=job.bbox_max_x,
            min_y=job.bbox_min_y,
            max_y=job.bbox_max_y,
            min_z=job.bbox_min_z,
            max_z=job.bbox_max_z,
            size_x_mm=round(job.bbox_max_x - job.bbox_min_x, 3),
            size_y_mm=round(job.bbox_max_y - job.bbox_min_y, 3),
            size_z_mm=round(job.bbox_max_z - job.bbox_min_z, 3),
        ),
        estimated_grams=job.estimated_grams,
        estimated_minutes=job.estimated_minutes,
        layer_count=job.layer_count,
        supports_enabled=job.supports_enabled,
        budget_check=budget_check,
        student_note=job.student_note,
        admin_note=job.admin_note,
        fdm_monster_job_id=job.fdm_monster_job_id,
        created_at=job.created_at,
        updated_at=job.updated_at,
        submitted_at=job.submitted_at,
        completed_at=job.completed_at,
    )


def serialize_settings(sys_settings: SystemSettings) -> SystemSettingsOut:
    from app.config import settings

    raw_key = sys_settings.fdm_monster_api_key or ""
    masked = ("*" * max(4, len(raw_key) - 4) + raw_key[-4:]) if raw_key else ""
    fdm_mode = sys_settings.fdm_monster_mode if settings.dev_seed else "live"
    slicer_mode = sys_settings.slicer_mode if settings.dev_seed else "orcaslicer"
    return SystemSettingsOut(
        default_max_active_grams=sys_settings.default_max_active_grams,
        enforce_duration_limit=sys_settings.enforce_duration_limit,
        default_max_print_minutes=sys_settings.default_max_print_minutes,
        allow_multiple_jobs_within_budget=sys_settings.allow_multiple_jobs_within_budget,
        max_upload_mb=sys_settings.max_upload_mb,
        fdm_monster_mode=fdm_mode,  # type: ignore[arg-type]
        fdm_monster_url=sys_settings.fdm_monster_url,
        fdm_monster_api_key=masked,
        has_fdm_monster_api_key=bool(raw_key),
        slicer_mode=slicer_mode,  # type: ignore[arg-type]
        orca_cli_path=sys_settings.orca_cli_path,
        filament_api_enabled=sys_settings.filament_api_enabled,
        filament_api_url=sys_settings.filament_api_url,
    )
