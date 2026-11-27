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
    needs_setup: bool = False


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
    role: Literal["student", "teacher", "tech", "admin"]
    hierarchy_rank: int = 0
    permissions: list[str] = Field(default_factory=list)
    approval_status: Literal["approved", "pending", "rejected"] = "approved"
    teachers: list[StudentTeacherOut] = Field(default_factory=list)
    is_active: bool
    effective_max_active_grams: float
    active_grams_used: float
    available_grams: float
    enforce_duration_limit: bool
    effective_max_print_minutes: int
    notify_browser: bool = False
    notify_webhook_url: Optional[str] = None


class NotificationSettingsOut(BaseModel):
    notify_browser: bool = False
    notify_webhook_url: Optional[str] = None


class NotificationSettingsPatch(BaseModel):
    notify_browser: Optional[bool] = None
    notify_webhook_url: Optional[str] = Field(default=None, max_length=500)


class WebhookTestRequest(BaseModel):
    webhook_url: Optional[str] = Field(default=None, max_length=500)


class WebhookTestResponse(BaseModel):
    ok: bool
    status_code: Optional[int] = None
    error: Optional[str] = None


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
    is_manual: bool = False
    is_fdm_linked: bool = True
    slots: list[PrinterSlotOut]


class AdminPrinterOut(PrinterOut):
    display_name: str
    is_enabled: bool
    machine_profile_id: Optional[int] = None
    process_profile_id: Optional[int] = None
    filament_api_printer_id: Optional[str] = None


class AdminPrinterCreate(BaseModel):
    display_name: str = Field(min_length=1, max_length=150)
    printer_type: Literal["prusalink", "klipper"] = "prusalink"
    bed_x_mm: float = Field(default=250.0, gt=20.0, le=1000.0)
    bed_y_mm: float = Field(default=210.0, gt=20.0, le=1000.0)
    bed_z_mm: float = Field(default=220.0, gt=20.0, le=1000.0)
    mmu_slots_count: int = Field(default=1, ge=1, le=16)
    fdm_monster_id: Optional[str] = Field(default=None, max_length=120)
    filament_api_printer_id: Optional[str] = Field(default=None, max_length=120)
    machine_profile_id: Optional[int] = None
    process_profile_id: Optional[int] = None
    slot_filament_ids: list[Optional[int]] = Field(default_factory=list)
    is_enabled: bool = True


class AdminPrinterPatch(BaseModel):
    is_enabled: Optional[bool] = None
    display_name: Optional[str] = Field(default=None, min_length=1, max_length=150)
    printer_type: Optional[Literal["prusalink", "klipper"]] = None
    fdm_monster_id: Optional[str] = Field(default=None, max_length=120)
    bed_x_mm: Optional[float] = Field(default=None, gt=20.0, le=1000.0)
    bed_y_mm: Optional[float] = Field(default=None, gt=20.0, le=1000.0)
    bed_z_mm: Optional[float] = Field(default=None, gt=20.0, le=1000.0)
    mmu_slots_count: Optional[int] = Field(default=None, ge=1, le=16)
    machine_profile_id: Optional[int] = None
    process_profile_id: Optional[int] = None
    filament_api_printer_id: Optional[str] = Field(default=None, max_length=120)


class FdmMonsterRemotePrinterOut(BaseModel):
    fdm_monster_id: str
    name: str
    printer_type: str
    status: str
    queue_count: int = 0
    bed_x_mm: float
    bed_y_mm: float
    bed_z_mm: float
    mmu_slots_count: int


class OrcaCatalogVendorSummary(BaseModel):
    id: str
    name: str
    version: str = ""
    model_count: int
    machine_count: int
    process_count: int
    filament_count: int
    is_library: bool = False


class OrcaCatalogModelOut(BaseModel):
    id: str
    name: str
    family: str = ""
    manufacturer: str = ""
    nozzles: list[str] = Field(default_factory=list)
    default_materials: list[str] = Field(default_factory=list)
    cover_url: Optional[str] = None
    bed_x_mm: float = 250.0
    bed_y_mm: float = 210.0
    bed_z_mm: float = 220.0
    mmu_slots_count: int = 1
    printer_type: str = "prusalink"
    machine_presets: list[str] = Field(default_factory=list)


class OrcaCatalogMachinePresetOut(BaseModel):
    name: str
    vendor: str
    printer_model: str = ""
    nozzle_diameter: str = "0.4"
    bed_x_mm: float = 250.0
    bed_y_mm: float = 210.0
    bed_z_mm: float = 220.0
    mmu_slots_count: int = 1
    printer_type: str = "prusalink"
    default_print_profile: str = ""


class OrcaCatalogProcessPresetOut(BaseModel):
    name: str
    vendor: str
    layer_height: str = "0.20"
    compatible_printers: list[str] = Field(default_factory=list)


class OrcaCatalogFilamentOut(BaseModel):
    preset_name: str
    name: str
    vendor: str
    material: str
    color_hex: str
    density_g_cm3: float
    compatible_printers: list[str] = Field(default_factory=list)


class OrcaCatalogVendorDetail(BaseModel):
    id: str
    name: str
    version: str = ""
    is_library: bool = False
    models: list[OrcaCatalogModelOut] = Field(default_factory=list)
    machine_presets: list[OrcaCatalogMachinePresetOut] = Field(default_factory=list)
    process_presets: list[OrcaCatalogProcessPresetOut] = Field(default_factory=list)
    filaments: list[OrcaCatalogFilamentOut] = Field(default_factory=list)


class OrcaCatalogImportPrinterRequest(BaseModel):
    vendor: str = Field(min_length=1, max_length=120)
    machine_preset_name: str = Field(min_length=1, max_length=200)
    process_preset_name: Optional[str] = Field(default=None, max_length=200)
    filament_preset_names: list[str] = Field(default_factory=list)
    display_name: Optional[str] = Field(default=None, max_length=150)
    fdm_monster_id: Optional[str] = Field(default=None, max_length=120)
    filament_api_printer_id: Optional[str] = Field(default=None, max_length=120)
    target_printer_id: Optional[int] = None
    mmu_slots_override: Optional[int] = Field(default=None, ge=1, le=16)


class OrcaCatalogImportPrinterResult(BaseModel):
    printer: AdminPrinterOut
    machine_profile: OrcaProfileOut
    process_profile: Optional[OrcaProfileOut] = None
    filaments: list[FilamentOut] = Field(default_factory=list)


class OrcaCatalogImportFilamentsRequest(BaseModel):
    vendor: str = Field(min_length=1, max_length=120)
    preset_names: list[str] = Field(min_length=1)
    update_existing: bool = True


class OrcaCatalogImportFilamentsResult(BaseModel):
    filaments: list[FilamentOut] = Field(default_factory=list)
    created_count: int = 0
    updated_count: int = 0


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
    gcode_url: Optional[str] = None
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
    slice_error: Optional[str] = None
    slice_queue_position: Optional[int] = None
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


class OrcaFilamentImportItem(BaseModel):
    filament: FilamentOut
    profile: OrcaProfileOut
    action: Literal["created", "updated"]
    filename: str


class OrcaFilamentSkippedItem(BaseModel):
    filename: str
    reason: str


class OrcaFilamentImportResult(BaseModel):
    imported: list[OrcaFilamentImportItem] = Field(default_factory=list)
    skipped: list[OrcaFilamentSkippedItem] = Field(default_factory=list)
    created_count: int = 0
    updated_count: int = 0
    skipped_count: int = 0


class PrusaProfileImportItem(BaseModel):
    profile: OrcaProfileOut
    action: Literal["created", "updated"]
    filename: str


class PrusaSlicerImportResult(BaseModel):
    filaments: list[OrcaFilamentImportItem] = Field(default_factory=list)
    profiles: list[PrusaProfileImportItem] = Field(default_factory=list)
    skipped: list[OrcaFilamentSkippedItem] = Field(default_factory=list)
    filaments_created: int = 0
    filaments_updated: int = 0
    profiles_created: int = 0
    profiles_updated: int = 0
    skipped_count: int = 0


class PrusaSlicerPreviewItem(BaseModel):
    key: str
    kind: Literal["filament", "process", "machine"]
    name: str
    filename: str
    already_exists: bool = False
    material: Optional[str] = None
    density_g_cm3: Optional[float] = None
    color_hex: Optional[str] = None


class PrusaSlicerPreviewResult(BaseModel):
    items: list[PrusaSlicerPreviewItem] = Field(default_factory=list)
    skipped: list[OrcaFilamentSkippedItem] = Field(default_factory=list)
    filament_count: int = 0
    process_count: int = 0
    machine_count: int = 0
    skipped_count: int = 0


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
    role: Literal["teacher", "tech"] = "teacher"
    hierarchy_rank: Optional[int] = Field(default=None, ge=1, le=99)
    permissions: Optional[list[str]] = None
    preset: Optional[str] = None

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
    role: Optional[Literal["teacher", "tech"]] = None
    hierarchy_rank: Optional[int] = Field(default=None, ge=1, le=99)
    is_active: Optional[bool] = None
    permissions: Optional[list[str]] = None
    preset: Optional[str] = None
    reset_permissions: bool = False

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
    role: Literal["student", "teacher", "tech", "admin"] = "teacher"
    hierarchy_rank: int = 50
    can_manage: bool = True
    is_active: bool
    permissions: list[str] = Field(default_factory=list)
    has_custom_permissions: bool = False
    class_count: int
    student_count: int
    pending_print_approvals: int
    pending_account_requests: int
    created_at: datetime


class PermissionCatalogItem(BaseModel):
    key: str
    group: str
    resource: str = ""
    admin_only: bool = False


class PermissionPresetOut(BaseModel):
    id: str
    role: str = "teacher"
    default_rank: int = 50
    permissions: list[str]


class PermissionCatalogOut(BaseModel):
    permissions: list[PermissionCatalogItem]
    presets: list[PermissionPresetOut]
    role_defaults: dict[str, list[str]]
    admin_only_permissions: list[str] = Field(default_factory=list)


class TeacherClassCreate(BaseModel):
    name: str = Field(min_length=1, max_length=150)
    code: Optional[str] = Field(default=None, max_length=40)
    description: Optional[str] = Field(default=None, max_length=500)
    default_max_active_grams: Optional[float] = Field(default=None, gt=0.0, le=5000.0)
    default_max_print_minutes: Optional[int] = Field(default=None, gt=0, le=10080)
    teacher_id: Optional[int] = None

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        cleaned = v.strip()
        if not cleaned:
            raise ValueError("Class name cannot be blank")
        return cleaned

    @field_validator("code", "description")
    @classmethod
    def validate_optional_text(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        cleaned = v.strip()
        return cleaned or None


class TeacherClassPatch(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=150)
    code: Optional[str] = Field(default=None, max_length=40)
    description: Optional[str] = Field(default=None, max_length=500)
    default_max_active_grams: Optional[float] = Field(default=None, gt=0.0, le=5000.0)
    default_max_print_minutes: Optional[int] = Field(default=None, gt=0, le=10080)
    apply_budget_to_students: bool = False

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        cleaned = v.strip()
        if not cleaned:
            raise ValueError("Class name cannot be blank")
        return cleaned

    @field_validator("code", "description")
    @classmethod
    def validate_optional_text(cls, v: Optional[str]) -> Optional[str]:
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
    user_id: Optional[int] = None
    registered_name: Optional[str] = None
    effective_max_active_grams: Optional[float] = None
    active_grams_used: Optional[float] = None
    effective_max_print_minutes: Optional[int] = None
    created_at: datetime


class TeacherClassOut(BaseModel):
    id: int
    teacher_id: int
    teacher_name: str
    name: str
    code: Optional[str] = None
    description: Optional[str] = None
    default_max_active_grams: Optional[float] = None
    default_max_print_minutes: Optional[int] = None
    is_default_individual: bool
    student_count: int
    enrolled_count: int
    registered_count: int
    unclaimed_count: int
    enrollments: list[ClassEnrollmentOut]
    created_at: datetime


class BulkEnrollRequest(BaseModel):
    raw_text: Optional[str] = None
    entries: Optional[list[WhitelistEntryCreate]] = None


class BulkEnrollResult(BaseModel):
    added: int
    skipped: int
    invalid: int
    reactivated: int
    invalid_lines: list[str] = Field(default_factory=list)


class TransferStudentRequest(BaseModel):
    da: str = Field(min_length=7, max_length=7)
    target_class_id: int
    remove_from_source: bool = True

    @field_validator("da")
    @classmethod
    def validate_da(cls, v: str) -> str:
        cleaned = v.strip()
        if not (len(cleaned) == 7 and cleaned.isdigit()):
            raise ValueError("DA must be a 7-digit string")
        return cleaned


class TransferStudentOut(BaseModel):
    da: str
    source_class_id: int
    target_class_id: int
    moved: bool
    already_in_target: bool


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


class BudgetRefreshRequest(BaseModel):
    scope: Literal["users", "class", "all"]
    user_ids: list[int] = Field(default_factory=list)
    class_id: Optional[int] = None
    reset_usage: bool = True
    max_grams_mode: Literal["keep", "default", "custom"] = "keep"
    custom_max_grams: Optional[float] = Field(default=None, gt=0.0, le=5000.0)

    @model_validator(mode="after")
    def validate_refresh_request(self) -> "BudgetRefreshRequest":
        if self.scope == "users" and not self.user_ids:
            raise ValueError("user_ids must not be empty when scope is 'users'")
        if self.scope == "class" and self.class_id is None:
            raise ValueError("class_id is required when scope is 'class'")
        if self.max_grams_mode == "custom" and self.custom_max_grams is None:
            raise ValueError("custom_max_grams is required when max_grams_mode is 'custom'")
        return self


class BudgetRefreshResult(BaseModel):
    refreshed_count: int
    user_ids: list[int] = Field(default_factory=list)


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
    max_concurrent_slices: int = 2
    filament_api_enabled: bool
    filament_api_url: str


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
    max_concurrent_slices: Optional[int] = Field(default=None, ge=1, le=4)
    filament_api_enabled: Optional[bool] = None
    filament_api_url: Optional[str] = Field(default=None, max_length=255)


# --- Setup Wizard & Slice Queue ---

class SetupStatusOut(BaseModel):
    needs_setup: bool
    has_admin: bool
    token_valid: bool
    setup_completed: bool
    dev_mode: bool
    institution: str
    suggested_orca_path: str
    current_settings: dict


class SetupTestOrcaRequest(BaseModel):
    orca_cli_path: str = Field(default="", max_length=255)
    token: Optional[str] = Field(default=None, max_length=255)


class SetupTestOrcaOut(BaseModel):
    ok: bool
    path: Optional[str] = None
    version: Optional[str] = None
    detail: str


class SetupTestFdmRequest(BaseModel):
    fdm_monster_url: str = Field(min_length=1, max_length=255)
    fdm_monster_api_key: Optional[str] = Field(default=None, max_length=255)
    token: Optional[str] = Field(default=None, max_length=255)


class SetupTestFdmOut(BaseModel):
    ok: bool
    printer_count: int = 0
    printers: list[dict] = Field(default_factory=list)
    detail: str


class SetupCompleteRequest(BaseModel):
    token: Optional[str] = None
    admin_username: Optional[str] = Field(default=None, max_length=120)
    admin_name: Optional[str] = Field(default=None, max_length=120)
    admin_password: Optional[str] = Field(default=None, max_length=128)
    institution: Optional[str] = Field(default=None, max_length=150)
    slicer_mode: Optional[Literal["mock", "orcaslicer"]] = None
    orca_cli_path: Optional[str] = Field(default=None, max_length=255)
    max_concurrent_slices: Optional[int] = Field(default=None, ge=1, le=4)
    fdm_monster_mode: Optional[Literal["mock", "live"]] = None
    fdm_monster_url: Optional[str] = Field(default=None, max_length=255)
    fdm_monster_api_key: Optional[str] = Field(default=None, max_length=255)
    default_max_active_grams: Optional[float] = Field(default=None, gt=0.0, le=5000.0)
    default_max_print_minutes: Optional[int] = Field(default=None, gt=0, le=10080)


class SliceQueueStatsOut(BaseModel):
    active_workers: int
    queued_count: int
    max_workers: int


class UpdateJobStatusOut(BaseModel):
    state: Literal["idle", "queued", "updating", "succeeded", "failed"] = "idle"
    target_version: Optional[str] = None
    requested_by: Optional[str] = None
    updated_at: Optional[str] = None
    message: Optional[str] = None


class UpdateTriggerRequest(BaseModel):
    target_version: Optional[str] = Field(default=None, max_length=64)


class SystemUpdateStatusOut(BaseModel):
    current_version: str
    latest_version: Optional[str] = None
    update_available: bool = False
    release_url: Optional[str] = None
    release_notes: Optional[str] = None
    published_at: Optional[str] = None
    checked_at: str
    repo: str
    error: Optional[str] = None
    updater_configured: bool = False
    update_job: Optional[UpdateJobStatusOut] = None


# --- FilamentAPI Integration ---

class FilamentApiPrinterOut(BaseModel):
    id: str
    type: str
    host: str


class FilamentApiTestRequest(BaseModel):
    url: Optional[str] = Field(default=None, max_length=255)


class FilamentApiHealthOut(BaseModel):
    ok: bool
    status: str
    printers_configured: int = 0
    uptime_seconds: Optional[float] = None
    printers: list[FilamentApiPrinterOut] = Field(default_factory=list)
    error: Optional[str] = None


class FilamentSyncPrinterResult(BaseModel):
    printer_id: int
    printer_name: str
    filament_api_printer_id: str
    detected_filament: Optional[str] = None
    matched_filament_id: Optional[int] = None
    matched_filament_name: Optional[str] = None
    changed: bool = False
    status: Literal["updated", "unchanged", "unloaded", "unmatched", "error"]
    error: Optional[str] = None


class FilamentSyncResponse(BaseModel):
    synced_count: int
    changed_count: int
    results: list[FilamentSyncPrinterResult] = Field(default_factory=list)
