export type Role = 'student' | 'teacher' | 'admin';
export type ApprovalStatus = 'approved' | 'pending' | 'rejected';

export interface TeacherPublic {
  id: number;
  name: string;
}

export interface CheckDaResponse {
  da: string;
  is_registered: boolean;
  in_roster: boolean;
  suggested_name?: string | null;
}

export interface StudentTeacher {
  id: number;
  name: string;
  classes: string[];
}

export type JobStatus =
  | 'DRAFT'
  | 'SLICED'
  | 'PENDING_APPROVAL'
  | 'QUEUED'
  | 'PRINTING'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'FAILED'
  | 'REJECTED';

export type PrinterType = 'klipper' | 'prusalink';
export type PrinterStatus = 'idle' | 'printing' | 'offline' | 'error';
export type ProfileKind = 'machine' | 'process' | 'filament';

export interface AuthModeResponse {
  dev_mode: boolean;
  slicer_mode: string;
  fdm_mode: string;
  institution: string;
}

export interface UserSummary {
  id: number;
  da: string;
  name: string;
  role: Role;
  permissions?: string[];
  is_active: boolean;
  approval_status?: ApprovalStatus;
  teachers?: StudentTeacher[];
  effective_max_active_grams: number;
  active_grams_used: number;
  available_grams: number;
  enforce_duration_limit: boolean;
  effective_max_print_minutes: number;
  notify_browser?: boolean;
  notify_webhook_url?: string | null;
}

export interface NotificationSettings {
  notify_browser: boolean;
  notify_webhook_url: string | null;
}

export interface WebhookTestResult {
  ok: boolean;
  status_code?: number | null;
  error?: string | null;
}

export interface AuthResponse {
  access_token: string;
  token_type: string;
  user: UserSummary;
}

export interface RegisterResponse {
  access_token?: string | null;
  token_type: string;
  user?: UserSummary | null;
  pending_approval: boolean;
  requested_teacher_name?: string | null;
}

export interface PrinterSlot {
  id: number;
  slot_index: number;
  label: string;
  filament_id: number | null;
  filament_name: string | null;
  material: string | null;
  color_hex: string | null;
  is_loaded: boolean;
}

export interface Printer {
  id: number;
  name: string;
  fdm_monster_id: string;
  printer_type: PrinterType;
  status: PrinterStatus;
  queue_count: number;
  bed_x_mm: number;
  bed_y_mm: number;
  bed_z_mm: number;
  mmu_slots_count: number;
  has_mmu: boolean;
  slots: PrinterSlot[];
}

export interface SampleModel {
  id: string;
  name: string;
  description: string;
}

export interface TransformPayload {
  printer_id: number;
  slot_id: number;
  pos_x_mm: number;
  pos_y_mm: number;
  quat_x: number;
  quat_y: number;
  quat_z: number;
  quat_w: number;
  scale: number;
  supports_enabled?: boolean;
}

export type SliceTransformPayload = TransformPayload;

export interface BudgetCheck {
  within_grams: boolean;
  within_duration: boolean;
  can_auto_submit: boolean;
  exceeds_grams_by: number;
  exceeds_minutes_by: number;
}

export interface JobDetail {
  id: number;
  user_id?: number;
  user_da?: string | null;
  user_name?: string | null;
  printer_id: number;
  printer_name?: string;
  slot_id: number;
  slot_index?: number;
  slot_label?: string;
  filament_id?: number | null;
  filament_name?: string | null;
  filament_material?: string | null;
  filament_color_hex?: string | null;
  original_filename?: string;
  filename?: string;
  status: JobStatus;
  oriented_mesh_url?: string;
  gcode_url?: string | null;
  pos_x_mm: number;
  pos_y_mm: number;
  quat_x: number;
  quat_y: number;
  quat_z: number;
  quat_w: number;
  scale: number;
  estimated_grams?: number | null;
  estimated_minutes?: number | null;
  layer_count?: number | null;
  supports_enabled?: boolean;
  gcode_filename?: string | null;
  budget_check?: BudgetCheck | null;
  student_note?: string | null;
  admin_note?: string | null;
  teacher_id?: number | null;
  teacher_name?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface ApprovalsResponse {
  pending: JobDetail[];
  history: JobDetail[];
}

export interface MyJobsResponse {
  user: UserSummary;
  jobs: JobDetail[];
}

export interface AdminPrinter {
  id: number;
  name: string;
  display_name?: string;
  fdm_monster_id: string;
  printer_type: PrinterType;
  status: PrinterStatus;
  queue_count: number;
  is_enabled: boolean;
  bed_x_mm: number;
  bed_y_mm: number;
  bed_z_mm: number;
  mmu_slots_count: number;
  has_mmu: boolean;
  machine_profile_id: number | null;
  process_profile_id: number | null;
  filament_api_printer_id?: string | null;
  slots: PrinterSlot[];
}

export interface OrcaProfile {
  id: number;
  name: string;
  kind: ProfileKind;
  filename?: string;
  notes?: string | null;
  created_at?: string;
}

export interface Filament {
  id: number;
  name: string;
  material: string;
  color_hex: string;
  density_g_cm3: number;
  filament_profile_id: number | null;
  process_override_profile_id: number | null;
}

export interface OrcaFilamentImportItem {
  filament: Filament;
  profile: OrcaProfile;
  action: 'created' | 'updated';
  filename: string;
}

export interface OrcaFilamentSkippedItem {
  filename: string;
  reason: string;
}

export interface OrcaFilamentImportResult {
  imported: OrcaFilamentImportItem[];
  skipped: OrcaFilamentSkippedItem[];
  created_count: number;
  updated_count: number;
  skipped_count: number;
}

export interface PrusaProfileImportItem {
  profile: OrcaProfile;
  action: 'created' | 'updated';
  filename: string;
}

export interface PrusaSlicerImportResult {
  filaments: OrcaFilamentImportItem[];
  profiles: PrusaProfileImportItem[];
  skipped: OrcaFilamentSkippedItem[];
  filaments_created: number;
  filaments_updated: number;
  profiles_created: number;
  profiles_updated: number;
  skipped_count: number;
}

export interface PrusaSlicerPreviewItem {
  key: string;
  kind: ProfileKind;
  name: string;
  filename: string;
  already_exists: boolean;
  material?: string | null;
  density_g_cm3?: number | null;
  color_hex?: string | null;
}

export interface PrusaSlicerPreviewResult {
  items: PrusaSlicerPreviewItem[];
  skipped: OrcaFilamentSkippedItem[];
  filament_count: number;
  process_count: number;
  machine_count: number;
  skipped_count: number;
}

export interface TestSliceResult {
  ok: boolean;
  estimated_grams: number;
  estimated_minutes: number;
  command_preview: string;
  error?: string;
}

export interface WhitelistEntry {
  da: string;
  suggested_name?: string | null;
  max_active_grams_override?: number | null;
  max_print_minutes_override?: number | null;
  is_registered?: boolean;
  created_at?: string;
}

export interface StudentClassBadge {
  class_id: number;
  class_name: string;
  teacher_id: number;
  teacher_name: string;
}

export interface StudentAccount {
  id: number;
  da: string;
  name: string;
  role: Role;
  is_active: boolean;
  approval_status?: ApprovalStatus;
  classes?: StudentClassBadge[];
  active_grams_used: number;
  effective_max_active_grams: number;
  effective_max_print_minutes: number;
  max_active_grams_override: number | null;
  max_print_minutes_override: number | null;
  total_jobs?: number;
}

export interface BudgetRefreshRequest {
  scope: 'users' | 'class' | 'all';
  user_ids?: number[];
  class_id?: number | null;
  reset_usage?: boolean;
  max_grams_mode?: 'keep' | 'default' | 'custom';
  custom_max_grams?: number | null;
}

export interface BudgetRefreshResult {
  refreshed_count: number;
  user_ids: number[];
}

export interface AdminTeacher {
  id: number;
  da: string;
  name: string;
  is_active: boolean;
  permissions?: string[];
  has_custom_permissions?: boolean;
  class_count: number;
  student_count: number;
  pending_print_approvals: number;
  pending_account_requests: number;
  created_at: string;
}

export interface PermissionCatalogItem {
  key: string;
  group: string;
}

export interface PermissionPreset {
  id: string;
  permissions: string[];
}

export interface PermissionCatalog {
  permissions: PermissionCatalogItem[];
  presets: PermissionPreset[];
  role_defaults: Record<Role, string[]>;
}

export interface ClassEnrollment {
  id: number;
  class_id: number;
  da: string;
  suggested_name?: string | null;
  max_active_grams_override?: number | null;
  max_print_minutes_override?: number | null;
  is_registered: boolean;
  is_active?: boolean | null;
  user_id?: number | null;
  registered_name?: string | null;
  effective_max_active_grams?: number | null;
  active_grams_used?: number | null;
  effective_max_print_minutes?: number | null;
  created_at: string;
}

export interface TeacherClass {
  id: number;
  teacher_id: number;
  teacher_name: string;
  name: string;
  code?: string | null;
  description?: string | null;
  default_max_active_grams?: number | null;
  default_max_print_minutes?: number | null;
  is_default_individual: boolean;
  student_count: number;
  enrolled_count?: number;
  registered_count?: number;
  unclaimed_count?: number;
  enrollments: ClassEnrollment[];
  created_at: string;
}

export interface ClassBulkAddResult {
  added: number;
  skipped: number;
  invalid: number;
  reactivated: number;
  invalid_lines: string[];
}

export interface ClassTransferResult {
  da: string;
  source_class_id: number;
  target_class_id: number;
  moved: boolean;
  already_in_target: boolean;
}

export interface ClassDeleteResult {
  deleted_class_id: number;
  disabled_students_count: number;
}

export interface ClassCsvResult {
  added: number;
  skipped: number;
  reactivated: number;
}

export interface ClassStudentRemoveResult {
  removed: boolean;
  student_disabled: boolean;
}

export interface PendingAccountRequest {
  id: number;
  da: string;
  name: string;
  requested_teacher_id?: number | null;
  requested_teacher_name?: string | null;
  approval_status: ApprovalStatus;
  created_at: string;
}

export interface SystemSettings {
  default_max_active_grams: number;
  enforce_duration_limit: boolean;
  default_max_print_minutes: number;
  allow_multiple_jobs_within_budget: boolean;
  max_upload_mb: number;
  fdm_monster_mode: 'mock' | 'live';
  fdm_monster_url: string;
  fdm_monster_api_key: string;
  slicer_mode: 'mock' | 'orcaslicer';
  orca_cli_path: string;
  filament_api_enabled: boolean;
  filament_api_url: string;
}

export interface FilamentApiPrinter {
  id: string;
  type: string;
  host: string;
}

export interface FilamentApiHealth {
  ok: boolean;
  status: string;
  printers_configured: number;
  uptime_seconds?: number | null;
  printers: FilamentApiPrinter[];
  error?: string | null;
}

export interface FilamentSyncPrinterResult {
  printer_id: number;
  printer_name: string;
  filament_api_printer_id: string;
  detected_filament?: string | null;
  matched_filament_id?: number | null;
  matched_filament_name?: string | null;
  changed: boolean;
  status: 'updated' | 'unchanged' | 'unloaded' | 'unmatched' | 'error';
  error?: string | null;
}

export interface FilamentSyncResponse {
  synced_count: number;
  changed_count: number;
  results: FilamentSyncPrinterResult[];
}
