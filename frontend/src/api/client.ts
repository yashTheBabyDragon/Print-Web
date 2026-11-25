import type {
  AdminPrinter,
  AdminTeacher,
  ApprovalsResponse,
  AuthModeResponse,
  AuthResponse,
  BudgetRefreshRequest,
  BudgetRefreshResult,
  CheckDaResponse,
  ClassBulkAddResult,
  ClassCsvResult,
  ClassDeleteResult,
  ClassEnrollment,
  ClassStudentRemoveResult,
  ClassTransferResult,
  Filament,
  FilamentApiHealth,
  FilamentApiPrinter,
  FilamentSyncResponse,
  JobDetail,
  MyJobsResponse,
  NotificationSettings,
  OrcaFilamentImportResult,
  OrcaProfile,
  PendingAccountRequest,
  PermissionCatalog,
  Printer,
  ProfileKind,
  PrusaSlicerImportResult,
  PrusaSlicerPreviewResult,
  RegisterResponse,
  SampleModel,
  StudentAccount,
  SystemSettings,
  SystemUpdateStatus,
  TeacherClass,
  TeacherPublic,
  TestSliceResult,
  TransformPayload,
  UserSummary,
  WebhookTestResult,
  WhitelistEntry,
} from '../types/api';

const TOKEN_STORAGE_KEY = 'ggprint_token';

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setStoredToken(token: string | null): void {
  if (token) {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  }
}

async function parseErrorResponse(res: Response): Promise<ApiError> {
  let detail = `HTTP ${res.status}`;
  let code: string | undefined;
  try {
    const data = await res.json();
    if (typeof data?.detail === 'string') {
      detail = data.detail;
    } else if (data?.detail && typeof data.detail === 'object') {
      detail = data.detail.message || data.detail.detail || JSON.stringify(data.detail);
      code = data.detail.code;
    } else if (Array.isArray(data?.detail) && data.detail.length > 0) {
      detail = data.detail.map((d: { msg?: string }) => d.msg || '').filter(Boolean).join(', ') || detail;
    }
    if (!code && typeof data?.code === 'string') {
      code = data.code;
    }
  } catch {
    // fallback to status text
    detail = res.statusText || detail;
  }
  return new ApiError(detail, res.status, code);
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getStoredToken();
  const headers = new Headers(options.headers || {});
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (!(options.body instanceof FormData) && options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(path, { ...options, headers });
  if (!res.ok) {
    throw await parseErrorResponse(res);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

async function requestBuffer(path: string): Promise<ArrayBuffer> {
  const token = getStoredToken();
  const headers = new Headers();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  const res = await fetch(path, { headers });
  if (!res.ok) {
    throw await parseErrorResponse(res);
  }
  return res.arrayBuffer();
}

async function requestText(path: string, options: RequestInit = {}): Promise<string> {
  const token = getStoredToken();
  const headers = new Headers(options.headers || {});
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  const res = await fetch(path, { cache: 'no-store', ...options, headers });
  if (!res.ok) {
    throw await parseErrorResponse(res);
  }
  return res.text();
}

export const api = {
  // Auth
  getAuthMode: () => request<AuthModeResponse>('/api/auth/mode'),
  getPublicTeachers: () => request<TeacherPublic[]>('/api/auth/teachers'),
  checkDa: (da: string) =>
    request<CheckDaResponse>(`/api/auth/check-da/${encodeURIComponent(da)}`),
  login: (identifier: string, password: string) =>
    request<AuthResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier, password }),
    }),
  register: (da: string, name: string, password: string, teacherId?: number | null) =>
    request<RegisterResponse>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ da, name, password, teacher_id: teacherId ?? null }),
    }),
  getMe: () => request<UserSummary>('/api/auth/me'),
  logoutUser: () =>
    request<{ deleted_drafts?: number } | void>('/api/auth/logout', { method: 'POST' }),
  getNotifications: () => request<NotificationSettings>('/api/auth/notifications'),
  updateNotifications: (data: {
    notify_browser?: boolean;
    notify_webhook_url?: string | null;
  }) =>
    request<UserSummary>('/api/auth/notifications', {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  testWebhook: (webhookUrl?: string | null) =>
    request<WebhookTestResult>('/api/auth/notifications/test-webhook', {
      method: 'POST',
      body: JSON.stringify(webhookUrl !== undefined ? { webhook_url: webhookUrl } : {}),
    }),

  // Printers & Samples
  getPrinters: () => request<Printer[]>('/api/printers'),
  getSamples: () => request<SampleModel[]>('/api/samples'),
  downloadSampleStl: async (sampleId: string): Promise<File> => {
    const buf = await requestBuffer(`/api/samples/${encodeURIComponent(sampleId)}`);
    return new File([buf], sampleId, { type: 'application/octet-stream' });
  },

  // Jobs
  uploadJob: (file: File, printerId: number, slotId: number) => {
    const form = new FormData();
    form.append('file', file);
    form.append('printer_id', String(printerId));
    form.append('slot_id', String(slotId));
    return request<JobDetail>('/api/jobs/upload', {
      method: 'POST',
      body: form,
    });
  },
  reorientJob: (jobId: number) =>
    request<JobDetail>(`/api/jobs/${jobId}/reorient`, { method: 'POST' }),
  fetchJobMeshBuffer: (jobId: number) => requestBuffer(`/api/jobs/${jobId}/mesh`),
  fetchJobStlBuffer: (jobId: number) => requestBuffer(`/api/jobs/${jobId}/stl`),
  fetchJobStl: async (jobId: number, filename?: string): Promise<File> => {
    const buf = await requestBuffer(`/api/jobs/${jobId}/stl`);
    return new File([buf], filename || `draft-${jobId}.stl`, { type: 'application/octet-stream' });
  },
  fetchJobGcodeText: (jobId: number) => requestText(`/api/jobs/${jobId}/gcode`),
  deleteJobDraft: (jobId: number) =>
    request<{ deleted?: boolean; job_id?: number } | void>(`/api/jobs/${jobId}`, {
      method: 'DELETE',
    }),
  clearDrafts: () =>
    request<{ deleted_count?: number } | void>('/api/jobs/drafts', {
      method: 'DELETE',
    }),
  sliceJob: (jobId: number, payload: TransformPayload) =>
    request<JobDetail>(`/api/jobs/${jobId}/slice`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  submitJob: (jobId: number) =>
    request<JobDetail>(`/api/jobs/${jobId}/submit`, { method: 'POST' }),
  requestApproval: (jobId: number, note: string, teacherId?: number | null) =>
    request<JobDetail>(`/api/jobs/${jobId}/request-approval`, {
      method: 'POST',
      body: JSON.stringify({ note, teacher_id: teacherId ?? null }),
    }),
  getMyJobs: () => request<MyJobsResponse>('/api/jobs/mine'),
  cancelJob: (jobId: number) =>
    request<JobDetail>(`/api/jobs/${jobId}/cancel`, { method: 'POST' }),
  devCompleteJob: (jobId: number) =>
    request<JobDetail>(`/api/jobs/${jobId}/dev-complete`, { method: 'POST' }),

  // Admin: Printers & Slots
  adminGetPrinters: () => request<AdminPrinter[]>('/api/admin/printers'),
  adminSyncPrinters: () =>
    request<AdminPrinter[]>('/api/admin/printers/sync', { method: 'POST' }),
  adminUpdatePrinter: (
    printerId: number,
    data: Partial<{
      is_enabled: boolean;
      display_name: string;
      bed_x_mm: number;
      bed_y_mm: number;
      bed_z_mm: number;
      mmu_slots_count: number;
      machine_profile_id: number | null;
      process_profile_id: number | null;
      filament_api_printer_id: string | null;
    }>
  ) =>
    request<AdminPrinter>(`/api/admin/printers/${printerId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  adminUpdatePrinterSlot: (
    printerId: number,
    slotIndex: number,
    data: { filament_id: number | null; label: string; is_loaded: boolean }
  ) =>
    request<AdminPrinter>(`/api/admin/printers/${printerId}/slots/${slotIndex}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  adminDeletePrinter: (printerId: number) =>
    request<void>(`/api/admin/printers/${printerId}`, { method: 'DELETE' }),

  // Admin: Filaments & Profiles
  adminGetFilaments: () => request<Filament[]>('/api/admin/filaments'),
  adminCreateFilament: (data: Omit<Filament, 'id'>) =>
    request<Filament>('/api/admin/filaments', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  adminUpdateFilament: (id: number, data: Partial<Omit<Filament, 'id'>>) =>
    request<Filament>(`/api/admin/filaments/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  adminDeleteFilament: (id: number) =>
    request<void>(`/api/admin/filaments/${id}`, { method: 'DELETE' }),
  adminImportOrcaFilaments: (
    files: File[],
    options?: { update_existing?: boolean; default_color_hex?: string }
  ) => {
    const form = new FormData();
    for (const file of files) {
      form.append('files', file);
    }
    if (options?.update_existing !== undefined) {
      form.append('update_existing', String(options.update_existing));
    }
    if (options?.default_color_hex) {
      form.append('default_color_hex', options.default_color_hex);
    }
    return request<OrcaFilamentImportResult>('/api/admin/filaments/import-orca', {
      method: 'POST',
      body: form,
    });
  },

  adminGetProfiles: () => request<OrcaProfile[]>('/api/admin/profiles'),
  adminUploadProfile: (file: File, name: string, kind: ProfileKind, notes: string) => {
    const form = new FormData();
    form.append('file', file);
    form.append('name', name);
    form.append('kind', kind);
    form.append('notes', notes);
    return request<OrcaProfile>('/api/admin/profiles', {
      method: 'POST',
      body: form,
    });
  },
  adminDeleteProfile: (id: number) =>
    request<void>(`/api/admin/profiles/${id}`, { method: 'DELETE' }),
  adminPreviewPrusaSlicer: (files: File[]) => {
    const form = new FormData();
    for (const file of files) {
      form.append('files', file);
    }
    return request<PrusaSlicerPreviewResult>('/api/admin/profiles/preview-prusaslicer', {
      method: 'POST',
      body: form,
    });
  },
  adminImportPrusaSlicer: (
    files: File[],
    options?: {
      import_filaments?: boolean;
      import_processes?: boolean;
      import_machines?: boolean;
      update_existing?: boolean;
      selected_keys?: string[];
    }
  ) => {
    const form = new FormData();
    for (const file of files) {
      form.append('files', file);
    }
    if (options?.import_filaments !== undefined) {
      form.append('import_filaments', String(options.import_filaments));
    }
    if (options?.import_processes !== undefined) {
      form.append('import_processes', String(options.import_processes));
    }
    if (options?.import_machines !== undefined) {
      form.append('import_machines', String(options.import_machines));
    }
    if (options?.update_existing !== undefined) {
      form.append('update_existing', String(options.update_existing));
    }
    if (options?.selected_keys !== undefined) {
      form.append('selected_keys', JSON.stringify(options.selected_keys));
    }
    return request<PrusaSlicerImportResult>('/api/admin/profiles/import-prusaslicer', {
      method: 'POST',
      body: form,
    });
  },
  adminTestSlice: (printerId: number, slotId: number) =>
    request<TestSliceResult>('/api/admin/profiles/test-slice', {
      method: 'POST',
      body: JSON.stringify({ printer_id: printerId, slot_id: slotId }),
    }),

  // Admin: Whitelist & Students
  adminGetWhitelist: () => request<WhitelistEntry[]>('/api/admin/whitelist'),
  adminAddWhitelist: (data: {
    da: string;
    suggested_name?: string | null;
    max_active_grams_override?: number | null;
    max_print_minutes_override?: number | null;
  }) =>
    request<WhitelistEntry>('/api/admin/whitelist', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  adminUploadWhitelistCsv: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<{ added: number; skipped: number }>('/api/admin/whitelist/csv', {
      method: 'POST',
      body: form,
    });
  },
  adminDeleteWhitelist: (da: string) =>
    request<void>(`/api/admin/whitelist/${encodeURIComponent(da)}`, { method: 'DELETE' }),
  adminGetStudents: () => request<StudentAccount[]>('/api/admin/students'),
  adminUpdateStudent: (
    userId: number,
    data: {
      is_active?: boolean;
      max_active_grams_override?: number | null;
      max_print_minutes_override?: number | null;
    }
  ) =>
    request<StudentAccount>(`/api/admin/students/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  adminRefreshStudentBudgets: (body: BudgetRefreshRequest) =>
    request<BudgetRefreshResult>('/api/admin/students/refresh-budget', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  adminResetPassword: (userId: number, newPassword?: string) =>
    request<{ da: string; temp_password: string }>(
      `/api/admin/students/${userId}/reset-password`,
      {
        method: 'POST',
        body: JSON.stringify(newPassword ? { new_password: newPassword } : {}),
      }
    ),

  // Admin: Approvals
  adminGetApprovals: () => request<ApprovalsResponse>('/api/admin/approvals'),
  adminDecideApproval: (
    jobId: number,
    data: {
      decision: 'approve_once' | 'approve_and_raise' | 'reject';
      new_max_active_grams?: number;
      new_max_print_minutes?: number;
      admin_note?: string;
    }
  ) =>
    request<JobDetail>(`/api/admin/approvals/${jobId}/decision`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Admin: Settings & System Updates
  adminGetSettings: () => request<SystemSettings>('/api/admin/settings'),
  adminUpdateSettings: (data: Partial<SystemSettings>) =>
    request<SystemSettings>('/api/admin/settings', {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  adminGetUpdateStatus: (force = false) =>
    request<SystemUpdateStatus>(
      `/api/admin/system/update-status?force=${force ? 'true' : 'false'}`
    ),

  // Admin: FilamentAPI
  adminTestFilamentApi: (url?: string) =>
    request<FilamentApiHealth>('/api/admin/filament-api/test', {
      method: 'POST',
      body: JSON.stringify(url ? { url } : {}),
    }),
  adminGetFilamentApiPrinters: () =>
    request<FilamentApiPrinter[]>('/api/admin/filament-api/printers'),
  adminSyncPrinterFilaments: () =>
    request<FilamentSyncResponse>('/api/admin/printers/sync-filaments', {
      method: 'POST',
    }),

  // Admin: Permissions & Teachers (Super Admin)
  adminGetPermissionCatalog: () => request<PermissionCatalog>('/api/admin/permissions/catalog'),
  adminGetTeachers: () => request<AdminTeacher[]>('/api/admin/teachers'),
  adminCreateTeacher: (data: {
    identifier: string;
    name: string;
    password: string;
    permissions?: string[];
    preset?: string;
  }) =>
    request<AdminTeacher>('/api/admin/teachers', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  adminUpdateTeacher: (
    teacherId: number,
    data: {
      name?: string;
      is_active?: boolean;
      permissions?: string[];
      preset?: string;
      reset_permissions?: boolean;
    }
  ) =>
    request<AdminTeacher>(`/api/admin/teachers/${teacherId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  adminResetTeacherPassword: (teacherId: number, newPassword?: string) =>
    request<{ da: string; temp_password: string }>(
      `/api/admin/teachers/${teacherId}/reset-password`,
      {
        method: 'POST',
        body: JSON.stringify(newPassword ? { new_password: newPassword } : {}),
      }
    ),
  adminDeleteTeacher: (teacherId: number) =>
    request<void>(`/api/admin/teachers/${teacherId}`, { method: 'DELETE' }),

  // Admin: Classes & Enrollments
  adminGetClasses: () => request<TeacherClass[]>('/api/admin/classes'),
  adminCreateClass: (data: {
    name: string;
    code?: string | null;
    description?: string | null;
    default_max_active_grams?: number | null;
    default_max_print_minutes?: number | null;
    teacher_id?: number | null;
  }) =>
    request<TeacherClass>('/api/admin/classes', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  adminUpdateClass: (
    classId: number,
    data: {
      name?: string;
      code?: string | null;
      description?: string | null;
      default_max_active_grams?: number | null;
      default_max_print_minutes?: number | null;
      apply_budget_to_students?: boolean;
    }
  ) =>
    request<TeacherClass>(`/api/admin/classes/${classId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  adminDeleteClass: (classId: number) =>
    request<ClassDeleteResult>(`/api/admin/classes/${classId}`, { method: 'DELETE' }),
  adminAddClassStudent: (
    classId: number,
    data: {
      da: string;
      suggested_name?: string | null;
      max_active_grams_override?: number | null;
      max_print_minutes_override?: number | null;
    }
  ) =>
    request<ClassEnrollment>(`/api/admin/classes/${classId}/students`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  adminBulkAddClassStudents: (
    classId: number,
    data: {
      raw_text?: string;
      entries?: Array<{
        da: string;
        suggested_name?: string | null;
        max_active_grams_override?: number | null;
        max_print_minutes_override?: number | null;
      }>;
    }
  ) =>
    request<ClassBulkAddResult>(`/api/admin/classes/${classId}/students/bulk`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  adminTransferClassStudent: (
    classId: number,
    data: { da: string; target_class_id: number; remove_from_source?: boolean }
  ) =>
    request<ClassTransferResult>(`/api/admin/classes/${classId}/transfer`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  adminImportClassCsv: (classId: number, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<ClassCsvResult>(`/api/admin/classes/${classId}/import-csv`, {
      method: 'POST',
      body: form,
    });
  },
  adminRemoveClassStudent: (classId: number, da: string) =>
    request<ClassStudentRemoveResult>(
      `/api/admin/classes/${classId}/students/${encodeURIComponent(da)}`,
      { method: 'DELETE' }
    ),

  // Admin: Student Account Requests
  adminGetAccountRequests: () => request<PendingAccountRequest[]>('/api/admin/account-requests'),
  adminDecideAccountRequest: (
    userId: number,
    data: { decision: 'approve' | 'reject'; class_id?: number | null }
  ) =>
    request<PendingAccountRequest>(`/api/admin/account-requests/${userId}/decision`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};
