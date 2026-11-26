"""SQLAlchemy ORM models and domain enums."""

from __future__ import annotations

import enum
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class JobStatus(str, enum.Enum):
    DRAFT = "DRAFT"
    SLICING_QUEUED = "SLICING_QUEUED"
    SLICING = "SLICING"
    SLICED = "SLICED"
    SLICE_FAILED = "SLICE_FAILED"
    PENDING_APPROVAL = "PENDING_APPROVAL"
    QUEUED = "QUEUED"
    PRINTING = "PRINTING"
    COMPLETED = "COMPLETED"
    CANCELLED = "CANCELLED"
    FAILED = "FAILED"
    REJECTED = "REJECTED"


ACTIVE_BUDGET_STATUSES: tuple[str, ...] = (
    JobStatus.PENDING_APPROVAL.value,
    JobStatus.QUEUED.value,
    JobStatus.PRINTING.value,
)

DRAFT_STATUSES: tuple[str, ...] = (
    JobStatus.DRAFT.value,
    JobStatus.SLICED.value,
)


class PrinterType(str, enum.Enum):
    KLIPPER = "klipper"
    PRUSALINK = "prusalink"


class PrinterStatus(str, enum.Enum):
    IDLE = "idle"
    PRINTING = "printing"
    OFFLINE = "offline"
    ERROR = "error"


class ProfileKind(str, enum.Enum):
    MACHINE = "machine"
    PROCESS = "process"
    FILAMENT = "filament"


class SystemSettings(Base):
    """Singleton row holding global limits, slicer, and FDM Monster configuration."""

    __tablename__ = "system_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    default_max_active_grams: Mapped[float] = mapped_column(Float, default=100.0, nullable=False)
    enforce_duration_limit: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    default_max_print_minutes: Mapped[int] = mapped_column(Integer, default=360, nullable=False)
    allow_multiple_jobs_within_budget: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    max_upload_mb: Mapped[int] = mapped_column(Integer, default=50, nullable=False)
    fdm_monster_mode: Mapped[str] = mapped_column(String(32), default="mock", nullable=False)
    fdm_monster_url: Mapped[str] = mapped_column(String(255), default="http://fdm-monster:4000", nullable=False)
    fdm_monster_api_key: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    slicer_mode: Mapped[str] = mapped_column(String(32), default="mock", nullable=False)
    orca_cli_path: Mapped[str] = mapped_column(String(255), default="orca-slicer", nullable=False)
    filament_api_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    filament_api_url: Mapped[str] = mapped_column(String(255), default="http://filament-api:8000", nullable=False)
    setup_completed: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    setup_token_hash: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    setup_token_expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    max_concurrent_slices: Mapped[int] = mapped_column(Integer, default=2, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class DAWhitelist(Base):
    """Pre-approved 7-digit student DA numbers eligible for self-registration."""

    __tablename__ = "da_whitelist"

    da: Mapped[str] = mapped_column(String(7), primary_key=True)
    suggested_name: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    max_active_grams_override: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    max_print_minutes_override: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class User(Base):
    """Registered student, teacher, or admin account."""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    da: Mapped[str] = mapped_column(String(120), unique=True, index=True, nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(String(20), default="student", nullable=False)
    hierarchy_rank: Mapped[int] = mapped_column(Integer, default=50, nullable=False)
    approval_status: Mapped[str] = mapped_column(String(20), default="approved", nullable=False)
    requested_teacher_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    max_active_grams_override: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    max_print_minutes_override: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    notify_browser: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    notify_webhook_url: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    permissions_json: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    budget_reset_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    token_version: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    jobs: Mapped[list[PrintJob]] = relationship(
        "PrintJob",
        back_populates="user",
        foreign_keys="PrintJob.user_id",
        cascade="all, delete-orphan",
    )
    classes: Mapped[list[TeacherClass]] = relationship(
        "TeacherClass",
        back_populates="teacher",
        foreign_keys="TeacherClass.teacher_id",
        cascade="all, delete-orphan",
    )
    requested_teacher: Mapped[Optional[User]] = relationship(
        "User",
        remote_side=[id],
        foreign_keys=[requested_teacher_id],
    )


class TeacherClass(Base):
    """A course/group roster (or default individual roster) owned by a teacher."""

    __tablename__ = "teacher_classes"
    __table_args__ = (UniqueConstraint("teacher_id", "name", name="uq_teacher_class_name"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    teacher_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    code: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    default_max_active_grams: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    default_max_print_minutes: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    is_default_individual: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    teacher: Mapped[User] = relationship("User", back_populates="classes", foreign_keys=[teacher_id])
    enrollments: Mapped[list[ClassEnrollment]] = relationship(
        "ClassEnrollment",
        back_populates="teacher_class",
        cascade="all, delete-orphan",
    )


class ClassEnrollment(Base):
    """A 7-digit student DA enrolled in a teacher's class roster."""

    __tablename__ = "class_enrollments"
    __table_args__ = (UniqueConstraint("class_id", "da", name="uq_class_enrollment_da"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    class_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("teacher_classes.id", ondelete="CASCADE"), nullable=False, index=True
    )
    da: Mapped[str] = mapped_column(String(7), nullable=False, index=True)
    suggested_name: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    max_active_grams_override: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    max_print_minutes_override: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    teacher_class: Mapped[TeacherClass] = relationship("TeacherClass", back_populates="enrollments")


class OrcaProfile(Base):
    """Uploaded OrcaSlicer JSON profile (machine, process, or filament)."""

    __tablename__ = "orca_profiles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    file_path: Mapped[str] = mapped_column(String(500), nullable=False)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class Filament(Base):
    """Filament catalog entry bound to an Orca filament profile."""

    __tablename__ = "filaments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    material: Mapped[str] = mapped_column(String(40), nullable=False)
    color_hex: Mapped[str] = mapped_column(String(16), nullable=False, default="#00A7D9")
    density_g_cm3: Mapped[float] = mapped_column(Float, nullable=False, default=1.24)
    filament_profile_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("orca_profiles.id", ondelete="SET NULL"), nullable=True
    )
    process_override_profile_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("orca_profiles.id", ondelete="SET NULL"), nullable=True
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    filament_profile: Mapped[Optional[OrcaProfile]] = relationship(
        "OrcaProfile", foreign_keys=[filament_profile_id]
    )
    process_override_profile: Mapped[Optional[OrcaProfile]] = relationship(
        "OrcaProfile", foreign_keys=[process_override_profile_id]
    )


class Printer(Base):
    """Configured 3D printer managed through FDM Monster."""

    __tablename__ = "printers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    display_name: Mapped[str] = mapped_column(String(150), nullable=False)
    fdm_monster_id: Mapped[str] = mapped_column(String(120), unique=True, index=True, nullable=False)
    filament_api_printer_id: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    printer_type: Mapped[str] = mapped_column(String(32), default=PrinterType.PRUSALINK.value, nullable=False)
    status: Mapped[str] = mapped_column(String(32), default=PrinterStatus.IDLE.value, nullable=False)
    queue_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    is_manual: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    bed_x_mm: Mapped[float] = mapped_column(Float, default=250.0, nullable=False)
    bed_y_mm: Mapped[float] = mapped_column(Float, default=210.0, nullable=False)
    bed_z_mm: Mapped[float] = mapped_column(Float, default=220.0, nullable=False)
    mmu_slots_count: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    machine_profile_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("orca_profiles.id", ondelete="SET NULL"), nullable=True
    )
    process_profile_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("orca_profiles.id", ondelete="SET NULL"), nullable=True
    )

    machine_profile: Mapped[Optional[OrcaProfile]] = relationship(
        "OrcaProfile", foreign_keys=[machine_profile_id]
    )
    process_profile: Mapped[Optional[OrcaProfile]] = relationship(
        "OrcaProfile", foreign_keys=[process_profile_id]
    )
    slots: Mapped[list[PrinterSlot]] = relationship(
        "PrinterSlot",
        back_populates="printer",
        order_by="PrinterSlot.slot_index",
        cascade="all, delete-orphan",
    )


class PrinterSlot(Base):
    """Single extruder or MMU filament slot on a printer."""

    __tablename__ = "printer_slots"
    __table_args__ = (UniqueConstraint("printer_id", "slot_index", name="uq_printer_slot_index"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    printer_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("printers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    slot_index: Mapped[int] = mapped_column(Integer, nullable=False)
    label: Mapped[str] = mapped_column(String(120), nullable=False)
    filament_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("filaments.id", ondelete="SET NULL"), nullable=True
    )
    is_loaded: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    printer: Mapped[Printer] = relationship("Printer", back_populates="slots")
    filament: Mapped[Optional[Filament]] = relationship("Filament")


class PrintJob(Base):
    """Student STL print job through upload, placement, slicing, approval, and printing."""

    __tablename__ = "print_jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    printer_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("printers.id"), nullable=False, index=True
    )
    slot_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("printer_slots.id"), nullable=False
    )
    filament_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("filaments.id", ondelete="SET NULL"), nullable=True
    )
    status: Mapped[str] = mapped_column(String(32), default=JobStatus.DRAFT.value, nullable=False, index=True)

    original_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    original_stl_path: Mapped[str] = mapped_column(String(500), nullable=False)
    oriented_stl_path: Mapped[str] = mapped_column(String(500), nullable=False)
    preview_stl_path: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    sliced_output_path: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    gcode_filename: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    slice_error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    pos_x_mm: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    pos_y_mm: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    quat_x: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    quat_y: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    quat_z: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    quat_w: Mapped[float] = mapped_column(Float, default=1.0, nullable=False)
    scale: Mapped[float] = mapped_column(Float, default=1.0, nullable=False)

    bbox_min_x: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    bbox_max_x: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    bbox_min_y: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    bbox_max_y: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    bbox_min_z: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    bbox_max_z: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)

    estimated_grams: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    estimated_minutes: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    layer_count: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    supports_enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    student_note: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    admin_note: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    reviewed_by_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    teacher_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    reviewed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    fdm_monster_job_id: Mapped[Optional[str]] = mapped_column(String(120), nullable=True, index=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)
    submitted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    user: Mapped[User] = relationship("User", back_populates="jobs", foreign_keys=[user_id])
    printer: Mapped[Printer] = relationship("Printer")
    slot: Mapped[PrinterSlot] = relationship("PrinterSlot")
    filament: Mapped[Optional[Filament]] = relationship("Filament")
    reviewed_by: Mapped[Optional[User]] = relationship("User", foreign_keys=[reviewed_by_id])
    teacher: Mapped[Optional[User]] = relationship("User", foreign_keys=[teacher_id])
