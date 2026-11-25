import type { Role, UserSummary } from '../types/api';

export const PERMISSIONS = {
  SLICER_USE: 'slicer:use',
  PRINTERS_MANAGE: 'printers:manage',
  FILAMENTS_MANAGE: 'filaments:manage',
  PROFILES_MANAGE: 'profiles:manage',
  SETTINGS_MANAGE: 'settings:manage',
  UPDATES_MANAGE: 'updates:manage',
  TEACHERS_MANAGE: 'teachers:manage',
  CLASSES_MANAGE_OWN: 'classes:manage_own',
  CLASSES_MANAGE_ALL: 'classes:manage_all',
  STUDENTS_MANAGE_OWN: 'students:manage_own',
  STUDENTS_MANAGE_ALL: 'students:manage_all',
  APPROVALS_MANAGE_OWN: 'approvals:manage_own',
  APPROVALS_MANAGE_ALL: 'approvals:manage_all',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const FALLBACK_ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  student: [PERMISSIONS.SLICER_USE],
  teacher: [
    PERMISSIONS.SLICER_USE,
    PERMISSIONS.CLASSES_MANAGE_OWN,
    PERMISSIONS.STUDENTS_MANAGE_OWN,
    PERMISSIONS.APPROVALS_MANAGE_OWN,
  ],
  admin: Object.values(PERMISSIONS),
};

export function getUserPermissions(user: UserSummary | null | undefined): readonly string[] {
  if (!user) return [];
  if (Array.isArray(user.permissions)) {
    return user.permissions;
  }
  return FALLBACK_ROLE_PERMISSIONS[user.role] ?? [];
}

export function hasPermission(
  user: UserSummary | null | undefined,
  permission: Permission | string
): boolean {
  if (!user) return false;
  return getUserPermissions(user).includes(permission);
}

export function hasAnyPermission(
  user: UserSummary | null | undefined,
  permissions: readonly (Permission | string)[]
): boolean {
  if (!user) return false;
  const granted = getUserPermissions(user);
  return permissions.some((p) => granted.includes(p));
}

export function canAccessStaffPortal(user: UserSummary | null | undefined): boolean {
  return hasAnyPermission(user, [
    PERMISSIONS.CLASSES_MANAGE_OWN,
    PERMISSIONS.CLASSES_MANAGE_ALL,
    PERMISSIONS.APPROVALS_MANAGE_OWN,
    PERMISSIONS.APPROVALS_MANAGE_ALL,
    PERMISSIONS.PRINTERS_MANAGE,
    PERMISSIONS.FILAMENTS_MANAGE,
    PERMISSIONS.PROFILES_MANAGE,
    PERMISSIONS.TEACHERS_MANAGE,
    PERMISSIONS.SETTINGS_MANAGE,
    PERMISSIONS.UPDATES_MANAGE,
  ]);
}
