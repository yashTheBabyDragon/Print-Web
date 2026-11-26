import type { Role, UserSummary } from '../types/api';

export const PERMISSIONS = {
  SLICER_USE: 'slicer:use',

  // Printers & Configurator
  PRINTERS_VIEW: 'printers:view',
  PRINTERS_MANAGE_SLOTS: 'printers:manage_slots',
  PRINTERS_EDIT: 'printers:edit',
  PRINTERS_CREATE_DELETE: 'printers:create_delete',

  // Filaments Editor
  FILAMENTS_VIEW: 'filaments:view',
  FILAMENTS_EDIT: 'filaments:edit',
  FILAMENTS_CREATE_DELETE: 'filaments:create_delete',

  // Slicer Profiles
  PROFILES_VIEW: 'profiles:view',
  PROFILES_MANAGE: 'profiles:manage',

  // Classes & Rosters
  CLASSES_MANAGE_OWN: 'classes:manage_own',
  CLASSES_MANAGE_ALL: 'classes:manage_all',

  // Students & Quotas
  STUDENTS_MANAGE_OWN: 'students:manage_own',
  STUDENTS_MANAGE_ALL: 'students:manage_all',
  STUDENTS_ADJUST_QUOTAS: 'students:adjust_quotas',
  STUDENTS_RESET_PASSWORD: 'students:reset_password',

  // Approvals
  APPROVALS_JOBS_OWN: 'approvals:jobs_own',
  APPROVALS_JOBS_ALL: 'approvals:jobs_all',
  APPROVALS_ACCOUNTS_OWN: 'approvals:accounts_own',
  APPROVALS_ACCOUNTS_ALL: 'approvals:accounts_all',

  // Staff Account Management
  ACCOUNTS_VIEW: 'accounts:view',
  ACCOUNTS_CREATE_TECH: 'accounts:create_tech',
  ACCOUNTS_CREATE_TEACHER: 'accounts:create_teacher',
  ACCOUNTS_EDIT_PERMISSIONS: 'accounts:edit_permissions',
  ACCOUNTS_MANAGE_STATUS: 'accounts:manage_status',
  ACCOUNTS_DELETE: 'accounts:delete',

  // System & API Configuration (Strictly Main Admin Only)
  SETTINGS_MANAGE: 'settings:manage',
  UPDATES_MANAGE: 'updates:manage',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ADMIN_ONLY_PERMISSIONS: readonly Permission[] = [
  PERMISSIONS.SETTINGS_MANAGE,
  PERMISSIONS.UPDATES_MANAGE,
];

const LEGACY_ALIASES: Record<string, readonly string[]> = {
  'printers:manage': [
    PERMISSIONS.PRINTERS_VIEW,
    PERMISSIONS.PRINTERS_MANAGE_SLOTS,
    PERMISSIONS.PRINTERS_EDIT,
    PERMISSIONS.PRINTERS_CREATE_DELETE,
  ],
  'filaments:manage': [
    PERMISSIONS.FILAMENTS_VIEW,
    PERMISSIONS.FILAMENTS_EDIT,
    PERMISSIONS.FILAMENTS_CREATE_DELETE,
  ],
  'approvals:manage_own': [PERMISSIONS.APPROVALS_JOBS_OWN, PERMISSIONS.APPROVALS_ACCOUNTS_OWN],
  'approvals:manage_all': [PERMISSIONS.APPROVALS_JOBS_ALL, PERMISSIONS.APPROVALS_ACCOUNTS_ALL],
  'teachers:manage': [
    PERMISSIONS.ACCOUNTS_VIEW,
    PERMISSIONS.ACCOUNTS_CREATE_TECH,
    PERMISSIONS.ACCOUNTS_CREATE_TEACHER,
    PERMISSIONS.ACCOUNTS_EDIT_PERMISSIONS,
    PERMISSIONS.ACCOUNTS_MANAGE_STATUS,
    PERMISSIONS.ACCOUNTS_DELETE,
  ],
};

const IMPLIED_BY: Record<string, readonly string[]> = {
  [PERMISSIONS.PRINTERS_VIEW]: [
    PERMISSIONS.PRINTERS_MANAGE_SLOTS,
    PERMISSIONS.PRINTERS_EDIT,
    PERMISSIONS.PRINTERS_CREATE_DELETE,
  ],
  [PERMISSIONS.FILAMENTS_VIEW]: [
    PERMISSIONS.FILAMENTS_EDIT,
    PERMISSIONS.FILAMENTS_CREATE_DELETE,
  ],
  [PERMISSIONS.PROFILES_VIEW]: [PERMISSIONS.PROFILES_MANAGE],
  [PERMISSIONS.CLASSES_MANAGE_OWN]: [PERMISSIONS.CLASSES_MANAGE_ALL],
  [PERMISSIONS.STUDENTS_MANAGE_OWN]: [PERMISSIONS.STUDENTS_MANAGE_ALL],
  [PERMISSIONS.APPROVALS_JOBS_OWN]: [PERMISSIONS.APPROVALS_JOBS_ALL],
  [PERMISSIONS.APPROVALS_ACCOUNTS_OWN]: [PERMISSIONS.APPROVALS_ACCOUNTS_ALL],
  [PERMISSIONS.ACCOUNTS_VIEW]: [
    PERMISSIONS.ACCOUNTS_CREATE_TECH,
    PERMISSIONS.ACCOUNTS_CREATE_TEACHER,
    PERMISSIONS.ACCOUNTS_EDIT_PERMISSIONS,
    PERMISSIONS.ACCOUNTS_MANAGE_STATUS,
    PERMISSIONS.ACCOUNTS_DELETE,
  ],
};

const FALLBACK_ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  student: [PERMISSIONS.SLICER_USE],
  teacher: [
    PERMISSIONS.SLICER_USE,
    PERMISSIONS.CLASSES_MANAGE_OWN,
    PERMISSIONS.STUDENTS_MANAGE_OWN,
    PERMISSIONS.STUDENTS_ADJUST_QUOTAS,
    PERMISSIONS.STUDENTS_RESET_PASSWORD,
    PERMISSIONS.APPROVALS_JOBS_OWN,
    PERMISSIONS.APPROVALS_ACCOUNTS_OWN,
  ],
  tech: [
    PERMISSIONS.SLICER_USE,
    PERMISSIONS.CLASSES_MANAGE_ALL,
    PERMISSIONS.STUDENTS_MANAGE_ALL,
    PERMISSIONS.STUDENTS_ADJUST_QUOTAS,
    PERMISSIONS.STUDENTS_RESET_PASSWORD,
    PERMISSIONS.APPROVALS_JOBS_ALL,
    PERMISSIONS.APPROVALS_ACCOUNTS_ALL,
    PERMISSIONS.PRINTERS_VIEW,
    PERMISSIONS.PRINTERS_MANAGE_SLOTS,
    PERMISSIONS.PRINTERS_EDIT,
    PERMISSIONS.PRINTERS_CREATE_DELETE,
    PERMISSIONS.FILAMENTS_VIEW,
    PERMISSIONS.FILAMENTS_EDIT,
    PERMISSIONS.FILAMENTS_CREATE_DELETE,
    PERMISSIONS.PROFILES_VIEW,
    PERMISSIONS.PROFILES_MANAGE,
  ],
  admin: Object.values(PERMISSIONS),
};

export function normalizePermissionList(raw: readonly string[], dropAdminOnly = false): string[] {
  const out = new Set<string>();
  for (const k of raw) {
    const alias = LEGACY_ALIASES[k];
    if (alias) {
      for (const a of alias) out.add(a);
    } else {
      out.add(k);
    }
  }
  if (dropAdminOnly) {
    for (const ao of ADMIN_ONLY_PERMISSIONS) {
      out.delete(ao);
    }
  }
  return Array.from(out).sort();
}

export function expandImpliedPermissions(raw: readonly string[]): Set<string> {
  const effective = new Set<string>(normalizePermissionList(raw));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [narrower, broaders] of Object.entries(IMPLIED_BY)) {
      if (effective.has(narrower)) continue;
      if (broaders.some((b) => effective.has(b))) {
        effective.add(narrower);
        changed = true;
      }
    }
  }
  return effective;
}

export function getUserEffectiveRank(user: UserSummary | null | undefined): number {
  if (!user) return 0;
  if (user.role === 'admin') return 100;
  if (user.role === 'student') return 0;
  if (typeof user.hierarchy_rank === 'number') {
    return Math.max(1, Math.min(99, user.hierarchy_rank));
  }
  return 50;
}

export function getUserPermissions(user: UserSummary | null | undefined): readonly string[] {
  if (!user) return [];
  if (user.role === 'admin') {
    return Object.values(PERMISSIONS);
  }
  if (Array.isArray(user.permissions)) {
    return normalizePermissionList(user.permissions, true);
  }
  return FALLBACK_ROLE_PERMISSIONS[user.role] ?? [];
}

export function hasPermission(
  user: UserSummary | null | undefined,
  permission: Permission | string
): boolean {
  if (!user) return false;
  if (
    permission === PERMISSIONS.SETTINGS_MANAGE ||
    permission === PERMISSIONS.UPDATES_MANAGE
  ) {
    return user.role === 'admin';
  }
  const effective = expandImpliedPermissions(getUserPermissions(user));
  return effective.has(permission);
}

export function hasAnyPermission(
  user: UserSummary | null | undefined,
  permissions: readonly (Permission | string)[]
): boolean {
  if (!user) return false;
  return permissions.some((p) => hasPermission(user, p));
}

export function canAccessStaffPortal(user: UserSummary | null | undefined): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return hasAnyPermission(user, [
    PERMISSIONS.PRINTERS_VIEW,
    PERMISSIONS.FILAMENTS_VIEW,
    PERMISSIONS.PROFILES_VIEW,
    PERMISSIONS.CLASSES_MANAGE_OWN,
    PERMISSIONS.STUDENTS_MANAGE_OWN,
    PERMISSIONS.APPROVALS_JOBS_OWN,
    PERMISSIONS.APPROVALS_ACCOUNTS_OWN,
    PERMISSIONS.ACCOUNTS_VIEW,
  ]);
}
