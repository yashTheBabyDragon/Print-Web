"""Pydantic v2 request and response schemas aligned with contracts/api-contract.md."""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


# --- Auth ---

class AuthModeOut(BaseModel):
    dev_mode: bool
    slicer_mode: str
    fdm_mode: str
    institution: str


class TeacherPublicOut(BaseModel):
    id: int
    name: str


class CheckDaOut(BaseModel):
    da: str
    is_registered: bool
    in_roster: bool
    suggested_name: Optional[str] = None


class StudentTeacherOut(BaseModel):
    id: int
    name: str
    classes: list[str] = Field(default_factory=list)


class UserSummary(BaseModel):
    id: int
    da: str
    name: str
    role: Literal["student", "teacher", "admin"]
    approval_status: Literal["approved", "pending", "rejected"] = "approved"
    teachers: list[StudentTeacherOut] = Field(default_factory=list)
    is_active: bool
    effective_max_active_grams: float
    active_grams_used: float
    available_grams: float
    enforce_duration_limit: bool
    effective_max_print_minutes: int


class RegisterRequest(BaseModel):
    da: str = Field(min_length=7, max_length=7)
    name: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=4, max_length=128)
    teacher_id: Optional[int] = None

    @field_validator("da")
    @classmethod
    def validate_da(cls, v: str) -> str:
        v = v.strip()
        if not (len(v) == 7 and v.isdigit()):
            raise ValueError("DA must be a 7-digit string")
        return v

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Name cannot be blank")
        return v


class LoginRequest(BaseModel):
    identifier: Optional[str] = Field(default=None, max_length=120)
    da: Optional[str] = Field(default=None, max_length=120)
    password: str = Field(min_length=1, max_length=128)

    @model_validator(mode="after")
    def normalize_login_identifier(self) -> "LoginRequest":
        raw = self.identifier if self.identifier is not None else self.da
        cleaned = (raw or "").strip()
        if not cleaned:
            raise ValueError("Identifier or DA is required")
        if not cleaned.isdigit():
            cleaned = cleaned.lower()
        self.identifier = cleaned
        self.da = cleaned
        return self

    @property
    def normalized_identifier(self) -> str:
        return self.identifier or self.da or ""


class AuthTokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserSummary


class RegisterResponse(BaseModel):
    access_token: Optional[str] = None
    token_type: str = "bearer"
    user: Optional[UserSummary] = None
    pending_approval: bool = False
    requested_teacher_name: Optional[str] = None


# --- Printers & Samples ---

class PrinterSlotOut(BaseModel):
    id: int
    slot_index: int
    label: str
    filament_id: Optional[int] = None
    filament_name: Optional[str] = None
    material: Optional[str] = None
    color_hex: Optional[str] = None
    is_loaded: bool


class PrinterOut(BaseModel):
    id: int
    name: str
    fdm_monster_id: str
    printer_type: str
    status: str
    queue_count: int
    bed_x_mm: float
    bed_y_mm: float
    bed_z_mm: float
    mmu_slots_count: int
    has_mmu: bool
    slots: list[PrinterSlotOut]


class AdminPrinterOut(PrinterOut):
    display_name: str
    is_enabled: bool
    machine_profile_id: Optional[int] = None
    process_profile_id: Optional[int] = None


class AdminPrinterPatch(BaseModel):
    is_enabled: Optional[bool] = None
    display_name: Optional[str] = Field(default=None, min_length=1, max_length=150)
    bed_x_mm: Optional[float] = Field(default=None, gt=20.0, le=1000.0)
    bed_y_mm: Optional[float] = Field(default=None, gt=20.0, le=1000.0)
    bed_z_mm: Optional[float] = Field(default=None, gt=20.0, le=1000.0)
    mmu_slots_count: Optional[int] = Field(default=None, ge=1, le=16)
    machine_profile_id: Optional[int] = None
    process_profile_id: Optional[int] = None


class PrinterSlotUpdate(BaseModel):
    filament_id: Optional[int] = None
    label: Optional[str] = Field(default=None, min_length=1, max_length=120)
    is_loaded: bool = True


class SampleModelOut(BaseModel):
    id: str
    name: str
    description: str


# --- Jobs & Slicing ---

class TransformPayload(BaseModel):
    printer_id: int
    slot_id: int
    pos_x_mm: float = 0.0
    pos_y_mm: float = 0.0
    quat_x: float = 0.0
    quat_y: float = 0.0
    quat_z: float = 0.0
    quat_w: float = 1.0
    scale: float = Field(default=1.0, gt=0.01, le=100.0)
    supports_enabled: bool = True


class BudgetCheckOut(BaseModel):
    within_grams: bool
    within_duration: bool
    can_auto_submit: bool
    exceeds_grams_by: float
    exceeds_minutes_by: int


class BoundingBoxOut(BaseModel):
    min_x: float
    max_x: float
    min_y: float
    max_y: float
    min_z: float
    max_z: float
    size_x_mm: float
    size_y_mm: float
    size_z_mm: float


class JobDetail(BaseModel):
    id: int
    user_id: int
    user_da: Optional[str] = None
    user_name: Optional[str] = None
    teacher_id: Optional[int] = None
    teacher_name: Optional[str] = None
    printer_id: int
    printer_name: str
    slot_id: int
    slot_index: int
    slot_label: str
    filament_id: Optional[int] = None
    filament_name: Optional[str] = None
    filament_material: Optional[str] = None
    filament_color_hex: Optional[str] = None
    status: str
    original_filename: str
    oriented_mesh_url: str
    gcode_filename: Optional[str] = None
    pos_x_mm: float
    pos_y_mm: float
    quat_x: float
    quat_y: float
    quat_z: float
    quat_w: float
    scale: float
    bbox: BoundingBoxOut
    estimated_grams: Optional[float] = None
    estimated_minutes: Optional[int] = None
    layer_count: Optional[int] = None
    supports_enabled: bool
    budget_check: Optional[BudgetCheckOut] = None
    student_note: Optional[str] = None
    admin_note: Optional[str] = None
    fdm_monster_job_id: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    submitted_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None


class MyJobsResponse(BaseModel):
    user: UserSummary
    jobs: list[JobDetail]


class RequestApprovalBody(BaseModel):
    note: Optional[str] = Field(default=None, max_length=1000)
    teacher_id: Optional[int] = None


# --- Admin Filaments & Profiles ---

class FilamentCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    material: str = Field(min_length=1, max_length=40)
    color_hex: str = Field(default="#00A7D9", min_length=4, max_length=16)
    density_g_cm3: float = Field(default=1.24, gt=0.1, le=10.0)
    filament_profile_id: Optional[int] = None
    process_override_profile_id: Optional[int] = None


class FilamentPatch(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    material: Optional[str] = Field(default=None, min_length=1, max_length=40)
    color_hex: Optional[str] = Field(default=None, min_length=4, max_length=16)
    density_g_cm3: Optional[float] = Field(default=None, gt=0.1, le=10.0)
    filament_profile_id: Optional[int] = None
    process_override_profile_id: Optional[int] = None
    is_active: Optional[bool] = None


class FilamentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    material: str
    color_hex: str
    density_g_cm3: float
    filament_profile_id: Optional[int] = None
    process_override_profile_id: Optional[int] = None
    is_active: bool


class OrcaProfileOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    kind: str
    filename: str
    notes: Optional[str] = None
    created_at: datetime


class TestSliceRequest(BaseModel):
    printer_id: int
    slot_id: int


class TestSliceResponse(BaseModel):
    ok: bool
    estimated_grams: float
    estimated_minutes: int
    layer_count: int
    command_preview: str


# --- Admin Whitelist & Students ---

class WhitelistEntryCreate(BaseModel):
    da: str = Field(min_length=7, max_length=7)
    suggested_name: Optional[str] = Field(default=None, max_length=120)
    max_active_grams_override: Optional[float] = Field(default=None, gt=0.0, le=5000.0)
    max_print_minutes_override: Optional[int] = Field(default=None, gt=0, le=10080)

    @field_validator("da")
    @classmethod
    def validate_da(cls, v: str) -> str:
        v = v.strip()
        if not (len(v) == 7 and v.isdigit()):
            raise ValueError("DA must be a 7-digit string")
        return v


class WhitelistEntryOut(BaseModel):
    da: str
    suggested_name: Optional[str] = None
    max_active_grams_override: Optional[float] = None
    max_print_minutes_override: Optional[int] = None
    is_registered: bool
    created_at: datetime


class WhitelistCsvResult(BaseModel):
    added: int
    skipped: int


class StudentClassBadge(BaseModel):
    class_id: int
    class_name: str
    teacher_id: int
    teacher_name: str


class AdminStudentOut(BaseModel):
    id: int
    da: str
    name: str
    role: str
    approval_status: str = "approved"
    classes: list[StudentClassBadge] = Field(default_factory=list)
    is_active: bool
    max_active_grams_override: Optional[float] = None
    max_print_minutes_override: Optional[int] = None
    effective_max_active_grams: float
    active_grams_used: float
    available_grams: float
    effective_max_print_minutes: int
    total_jobs: int
    created_at: datetime


# --- Admin Teachers, Classes & Account Requests ---

class AdminTeacherCreate(BaseModel):
    identifier: str = Field(min_length=2, max_length=120)
    name: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=4, max_length=128)

    @field_validator("identifier")
    @classmethod
    def validate_identifier(cls, v: str) -> str:
        cleaned = v.strip().lower()
        if len(cleaned) < 2:
            raise ValueError("Identifier must be at least 2 characters")
        if len(cleaned) == 7 and cleaned.isdigit():
            raise ValueError("Teacher identifier cannot be a 7-digit student DA")
        return cleaned

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        cleaned = v.strip()
        if not cleaned:
            raise ValueError("Name cannot be blank")
        return cleaned


class AdminTeacherPatch(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    is_active: Optional[bool] = None

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        cleaned = v.strip()
        if not cleaned:
            raise ValueError("Name cannot be blank")
        return cleaned


class AdminTeacherOut(BaseModel):
    id: int
    da: str
    name: str
    is_active: bool
    class_count: int
    student_count: int
    pending_print_approvals: int
    pending_account_requests: int
    created_at: datetime


class TeacherClassCreate(BaseModel):
    name: str = Field(min_length=1, max_length=150)
    code: Optional[str] = Field(default=None, max_length=40)
    teacher_id: Optional[int] = None

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        cleaned = v.strip()
        if not cleaned:
            raise ValueError("Class name cannot be blank")
        return cleaned

    @field_validator("code")
    @classmethod
    def validate_code(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        cleaned = v.strip()
        return cleaned or None


class ClassEnrollmentOut(BaseModel):
    id: int
    class_id: int
    da: str
    suggested_name: Optional[str] = None
    max_active_grams_override: Optional[float] = None
    max_print_minutes_override: Optional[int] = None
    is_registered: bool
    is_active: Optional[bool] = None
    created_at: datetime


class TeacherClassOut(BaseModel):
    id: int
    teacher_id: int
    teacher_name: str
    name: str
    code: Optional[str] = None
    is_default_individual: bool
    student_count: int
    enrollments: list[ClassEnrollmentOut]
    created_at: datetime


class ClassDeleteOut(BaseModel):
    deleted_class_id: int
    disabled_students_count: int


class ClassCsvResult(BaseModel):
    added: int
    skipped: int
    reactivated: int


class ClassStudentRemoveOut(BaseModel):
    removed: bool
    student_disabled: bool


class PendingAccountOut(BaseModel):
    id: int
    da: str
    name: str
    requested_teacher_id: Optional[int] = None
    requested_teacher_name: Optional[str] = None
    approval_status: str
    created_at: datetime


class AccountDecisionRequest(BaseModel):
    decision: Literal["approve", "reject"]
    class_id: Optional[int] = None


class AdminStudentPatch(BaseModel):
    is_active: Optional[bool] = None
    max_active_grams_override: Optional[float] = Field(default=None, gt=0.0, le=5000.0)
    max_print_minutes_override: Optional[int] = Field(default=None, gt=0, le=10080)


class ResetPasswordRequest(BaseModel):
    new_password: Optional[str] = Field(default=None, min_length=4, max_length=128)


class ResetPasswordResponse(BaseModel):
    da: str
    temp_password: str


# --- Approvals ---

class ApprovalDecisionRequest(BaseModel):
    decision: Literal["approve_once", "approve_and_raise", "reject"]
    new_max_active_grams: Optional[float] = Field(default=None, gt=0.0, le=5000.0)
    new_max_print_minutes: Optional[int] = Field(default=None, gt=0, le=10080)
    admin_note: Optional[str] = Field(default=None, max_length=1000)


class ApprovalsResponse(BaseModel):
    pending: list[JobDetail]
    history: list[JobDetail]


# --- System Settings ---

class SystemSettingsOut(BaseModel):
    default_max_active_grams: float
    enforce_duration_limit: bool
    default_max_print_minutes: int
    allow_multiple_jobs_within_budget: bool
    max_upload_mb: int
    fdm_monster_mode: Literal["mock", "live"]
    fdm_monster_url: str
    fdm_monster_api_key: str
    has_fdm_monster_api_key: bool
    slicer_mode: Literal["mock", "orcaslicer"]
    orca_cli_path: str


class SystemSettingsPatch(BaseModel):
    default_max_active_grams: Optional[float] = Field(default=None, gt=0.0, le=5000.0)
    enforce_duration_limit: Optional[bool] = None
    default_max_print_minutes: Optional[int] = Field(default=None, gt=0, le=10080)
    allow_multiple_jobs_within_budget: Optional[bool] = None
    max_upload_mb: Optional[int] = Field(default=None, ge=1, le=500)
    fdm_monster_mode: Optional[Literal["mock", "live"]] = None
    fdm_monster_url: Optional[str] = Field(default=None, max_length=255)
    fdm_monster_api_key: Optional[str] = Field(default=None, max_length=255)
    slicer_mode: Optional[Literal["mock", "orcaslicer"]] = None
    orca_cli_path: Optional[str] = Field(default=None, min_length=1, max_length=255)
