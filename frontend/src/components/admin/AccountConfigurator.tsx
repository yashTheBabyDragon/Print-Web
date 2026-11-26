import { useMemo } from 'react';
import { Check, Lock, ShieldAlert } from 'lucide-react';
import { useI18n } from '../../i18n';
import type { PermissionCatalog, UserSummary } from '../../types/api';
import {
  expandImpliedPermissions,
  getUserEffectiveRank,
  PERMISSIONS,
} from '../../utils/permissions';

export const DEFAULT_TEACHER_PERMISSIONS: string[] = [
  PERMISSIONS.SLICER_USE,
  PERMISSIONS.CLASSES_MANAGE_OWN,
  PERMISSIONS.STUDENTS_MANAGE_OWN,
  PERMISSIONS.STUDENTS_ADJUST_QUOTAS,
  PERMISSIONS.STUDENTS_RESET_PASSWORD,
  PERMISSIONS.APPROVALS_JOBS_OWN,
  PERMISSIONS.APPROVALS_ACCOUNTS_OWN,
];

export const DEFAULT_TECH_PERMISSIONS: string[] = [
  PERMISSIONS.SLICER_USE,
  PERMISSIONS.PRINTERS_VIEW,
  PERMISSIONS.PRINTERS_MANAGE_SLOTS,
  PERMISSIONS.PRINTERS_EDIT,
  PERMISSIONS.PRINTERS_CREATE_DELETE,
  PERMISSIONS.FILAMENTS_VIEW,
  PERMISSIONS.FILAMENTS_EDIT,
  PERMISSIONS.FILAMENTS_CREATE_DELETE,
  PERMISSIONS.PROFILES_VIEW,
  PERMISSIONS.PROFILES_MANAGE,
  PERMISSIONS.CLASSES_MANAGE_ALL,
  PERMISSIONS.STUDENTS_MANAGE_ALL,
  PERMISSIONS.STUDENTS_ADJUST_QUOTAS,
  PERMISSIONS.STUDENTS_RESET_PASSWORD,
  PERMISSIONS.APPROVALS_JOBS_ALL,
  PERMISSIONS.APPROVALS_ACCOUNTS_ALL,
];

const ALL_DELEGATABLE_PERMISSIONS: string[] = [
  PERMISSIONS.SLICER_USE,
  PERMISSIONS.PRINTERS_VIEW,
  PERMISSIONS.PRINTERS_MANAGE_SLOTS,
  PERMISSIONS.PRINTERS_EDIT,
  PERMISSIONS.PRINTERS_CREATE_DELETE,
  PERMISSIONS.FILAMENTS_VIEW,
  PERMISSIONS.FILAMENTS_EDIT,
  PERMISSIONS.FILAMENTS_CREATE_DELETE,
  PERMISSIONS.PROFILES_VIEW,
  PERMISSIONS.PROFILES_MANAGE,
  PERMISSIONS.CLASSES_MANAGE_OWN,
  PERMISSIONS.CLASSES_MANAGE_ALL,
  PERMISSIONS.STUDENTS_MANAGE_OWN,
  PERMISSIONS.STUDENTS_MANAGE_ALL,
  PERMISSIONS.STUDENTS_ADJUST_QUOTAS,
  PERMISSIONS.STUDENTS_RESET_PASSWORD,
  PERMISSIONS.APPROVALS_JOBS_OWN,
  PERMISSIONS.APPROVALS_JOBS_ALL,
  PERMISSIONS.APPROVALS_ACCOUNTS_OWN,
  PERMISSIONS.APPROVALS_ACCOUNTS_ALL,
  PERMISSIONS.ACCOUNTS_VIEW,
  PERMISSIONS.ACCOUNTS_CREATE_TECH,
  PERMISSIONS.ACCOUNTS_CREATE_TEACHER,
  PERMISSIONS.ACCOUNTS_EDIT_PERMISSIONS,
  PERMISSIONS.ACCOUNTS_MANAGE_STATUS,
  PERMISSIONS.ACCOUNTS_DELETE,
];

export const FALLBACK_PERMISSION_CATALOG: PermissionCatalog = {
  permissions: [
    { key: PERMISSIONS.SLICER_USE, group: 'slicer', resource: 'slicer', admin_only: false },
    { key: PERMISSIONS.PRINTERS_VIEW, group: 'lab', resource: 'printers', admin_only: false },
    { key: PERMISSIONS.PRINTERS_MANAGE_SLOTS, group: 'lab', resource: 'printers', admin_only: false },
    { key: PERMISSIONS.PRINTERS_EDIT, group: 'lab', resource: 'printers', admin_only: false },
    { key: PERMISSIONS.PRINTERS_CREATE_DELETE, group: 'lab', resource: 'printers', admin_only: false },
    { key: PERMISSIONS.FILAMENTS_VIEW, group: 'lab', resource: 'filaments', admin_only: false },
    { key: PERMISSIONS.FILAMENTS_EDIT, group: 'lab', resource: 'filaments', admin_only: false },
    { key: PERMISSIONS.FILAMENTS_CREATE_DELETE, group: 'lab', resource: 'filaments', admin_only: false },
    { key: PERMISSIONS.PROFILES_VIEW, group: 'lab', resource: 'profiles', admin_only: false },
    { key: PERMISSIONS.PROFILES_MANAGE, group: 'lab', resource: 'profiles', admin_only: false },
    { key: PERMISSIONS.CLASSES_MANAGE_OWN, group: 'classes', resource: 'classes', admin_only: false },
    { key: PERMISSIONS.CLASSES_MANAGE_ALL, group: 'classes', resource: 'classes', admin_only: false },
    { key: PERMISSIONS.STUDENTS_MANAGE_OWN, group: 'students', resource: 'students', admin_only: false },
    { key: PERMISSIONS.STUDENTS_MANAGE_ALL, group: 'students', resource: 'students', admin_only: false },
    { key: PERMISSIONS.STUDENTS_ADJUST_QUOTAS, group: 'students', resource: 'students', admin_only: false },
    { key: PERMISSIONS.STUDENTS_RESET_PASSWORD, group: 'students', resource: 'students', admin_only: false },
    { key: PERMISSIONS.APPROVALS_JOBS_OWN, group: 'approvals', resource: 'approvals', admin_only: false },
    { key: PERMISSIONS.APPROVALS_JOBS_ALL, group: 'approvals', resource: 'approvals', admin_only: false },
    { key: PERMISSIONS.APPROVALS_ACCOUNTS_OWN, group: 'approvals', resource: 'approvals', admin_only: false },
    { key: PERMISSIONS.APPROVALS_ACCOUNTS_ALL, group: 'approvals', resource: 'approvals', admin_only: false },
    { key: PERMISSIONS.ACCOUNTS_VIEW, group: 'accounts', resource: 'accounts', admin_only: false },
    { key: PERMISSIONS.ACCOUNTS_CREATE_TECH, group: 'accounts', resource: 'accounts', admin_only: false },
    { key: PERMISSIONS.ACCOUNTS_CREATE_TEACHER, group: 'accounts', resource: 'accounts', admin_only: false },
    { key: PERMISSIONS.ACCOUNTS_EDIT_PERMISSIONS, group: 'accounts', resource: 'accounts', admin_only: false },
    { key: PERMISSIONS.ACCOUNTS_MANAGE_STATUS, group: 'accounts', resource: 'accounts', admin_only: false },
    { key: PERMISSIONS.ACCOUNTS_DELETE, group: 'accounts', resource: 'accounts', admin_only: false },
    { key: PERMISSIONS.SETTINGS_MANAGE, group: 'administration', resource: 'settings', admin_only: true },
    { key: PERMISSIONS.UPDATES_MANAGE, group: 'administration', resource: 'updates', admin_only: true },
  ],
  presets: [
    { id: 'teacher_default', role: 'teacher', default_rank: 50, permissions: DEFAULT_TEACHER_PERMISSIONS },
    { id: 'lab_tech', role: 'tech', default_rank: 50, permissions: DEFAULT_TECH_PERMISSIONS },
    {
      id: 'printer_operator',
      role: 'tech',
      default_rank: 40,
      permissions: [
        PERMISSIONS.SLICER_USE,
        PERMISSIONS.PRINTERS_VIEW,
        PERMISSIONS.PRINTERS_MANAGE_SLOTS,
        PERMISSIONS.FILAMENTS_VIEW,
        PERMISSIONS.FILAMENTS_EDIT,
        PERMISSIONS.APPROVALS_JOBS_ALL,
      ],
    },
    {
      id: 'coordinator',
      role: 'teacher',
      default_rank: 70,
      permissions: [
        PERMISSIONS.SLICER_USE,
        PERMISSIONS.CLASSES_MANAGE_ALL,
        PERMISSIONS.STUDENTS_MANAGE_ALL,
        PERMISSIONS.STUDENTS_ADJUST_QUOTAS,
        PERMISSIONS.STUDENTS_RESET_PASSWORD,
        PERMISSIONS.APPROVALS_JOBS_ALL,
        PERMISSIONS.APPROVALS_ACCOUNTS_ALL,
        PERMISSIONS.ACCOUNTS_VIEW,
        PERMISSIONS.ACCOUNTS_CREATE_TECH,
        PERMISSIONS.ACCOUNTS_EDIT_PERMISSIONS,
        PERMISSIONS.ACCOUNTS_MANAGE_STATUS,
      ],
    },
    { id: 'slicer_only', role: 'teacher', default_rank: 10, permissions: [PERMISSIONS.SLICER_USE] },
  ],
  role_defaults: {
    student: [PERMISSIONS.SLICER_USE],
    teacher: DEFAULT_TEACHER_PERMISSIONS,
    tech: DEFAULT_TECH_PERMISSIONS,
    admin: ALL_DELEGATABLE_PERMISSIONS,
  },
  admin_only_permissions: [PERMISSIONS.SETTINGS_MANAGE, PERMISSIONS.UPDATES_MANAGE],
};

function samePermissionSet(a: readonly string[], b: readonly string[]): boolean {
  const effA = expandImpliedPermissions(a);
  const effB = expandImpliedPermissions(b);
  if (effA.size !== effB.size) return false;
  for (const item of effB) {
    if (!effA.has(item)) return false;
  }
  return true;
}

export interface AccountConfiguratorProps {
  role: 'teacher' | 'tech';
  onRoleChange?: (role: 'teacher' | 'tech') => void;
  hierarchyRank: number;
  onHierarchyRankChange: (rank: number) => void;
  permissions: string[];
  onPermissionsChange: (next: string[]) => void;
  catalog: PermissionCatalog;
  callerUser: UserSummary | null;
  canCreateTeacher?: boolean;
  canCreateTech?: boolean;
  allowRoleChange?: boolean;
  disabled?: boolean;
}

export function AccountConfigurator({
  role,
  onRoleChange,
  hierarchyRank,
  onHierarchyRankChange,
  permissions,
  onPermissionsChange,
  catalog,
  callerUser,
  canCreateTeacher = true,
  canCreateTech = true,
  allowRoleChange = true,
  disabled = false,
}: AccountConfiguratorProps) {
  const { lang, t } = useI18n();
  const isFr = lang === 'fr';
  const permCopy = t.admin.permissions;

  const isMainAdmin = !callerUser || callerUser.role === 'admin';
  const maxAssignableRank = isMainAdmin ? 99 : Math.max(1, getUserEffectiveRank(callerUser));
  const callerEffective = useMemo(
    () => (isMainAdmin ? new Set(ALL_DELEGATABLE_PERMISSIONS) : expandImpliedPermissions(callerUser?.permissions ?? [])),
    [callerUser, isMainAdmin]
  );

  const canDelegate = (perm: string) => isMainAdmin || callerEffective.has(perm);
  const canDelegateAll = (perms: readonly string[]) => perms.every(canDelegate);

  const selected = useMemo(() => expandImpliedPermissions(permissions), [permissions]);

  const setGroupPermissions = (removeKeys: readonly string[], addKeys: readonly string[]) => {
    if (disabled) return;
    const removeSet = new Set(removeKeys);
    const next = new Set(permissions.filter((p) => !removeSet.has(p)));
    for (const k of addKeys) {
      if (canDelegate(k)) next.add(k);
    }
    onPermissionsChange(Array.from(next).sort());
  };

  const toggleSingle = (permKey: string, ensureViewKey?: string) => {
    if (disabled || !canDelegate(permKey)) return;
    const next = new Set(permissions);
    if (next.has(permKey)) {
      next.delete(permKey);
    } else {
      next.add(permKey);
      if (ensureViewKey && canDelegate(ensureViewKey)) {
        next.add(ensureViewKey);
      }
    }
    onPermissionsChange(Array.from(next).sort());
  };

  const applyPreset = (preset: { id: string; role?: string; default_rank?: number; permissions: string[] }) => {
    if (disabled) return;
    const presetRole = preset.role === 'tech' ? 'tech' : 'teacher';
    const roleAllowed = presetRole === 'tech' ? canCreateTech : canCreateTeacher;
    if (allowRoleChange && onRoleChange && roleAllowed) {
      onRoleChange(presetRole);
    }
    const clampedRank = Math.min(maxAssignableRank, Math.max(1, preset.default_rank ?? 50));
    onHierarchyRankChange(clampedRank);
    const filteredPerms = preset.permissions.filter(canDelegate);
    onPermissionsChange(Array.from(new Set(filteredPerms)).sort());
  };

  // Derive GitHub-style level values for each resource row
  const slicerLevel = selected.has(PERMISSIONS.SLICER_USE) ? 'use' : 'none';

  const printerLevel = selected.has(PERMISSIONS.PRINTERS_CREATE_DELETE)
    ? 'full'
    : selected.has(PERMISSIONS.PRINTERS_EDIT)
      ? 'edit'
      : selected.has(PERMISSIONS.PRINTERS_VIEW) || selected.has(PERMISSIONS.PRINTERS_MANAGE_SLOTS)
        ? 'view'
        : 'none';

  const filamentLevel = selected.has(PERMISSIONS.FILAMENTS_CREATE_DELETE)
    ? 'full'
    : selected.has(PERMISSIONS.FILAMENTS_EDIT)
      ? 'edit'
      : selected.has(PERMISSIONS.FILAMENTS_VIEW)
        ? 'view'
        : 'none';

  const profileLevel = selected.has(PERMISSIONS.PROFILES_MANAGE)
    ? 'manage'
    : selected.has(PERMISSIONS.PROFILES_VIEW)
      ? 'view'
      : 'none';

  const classLevel = selected.has(PERMISSIONS.CLASSES_MANAGE_ALL)
    ? 'all'
    : selected.has(PERMISSIONS.CLASSES_MANAGE_OWN)
      ? 'own'
      : 'none';

  const studentLevel = selected.has(PERMISSIONS.STUDENTS_MANAGE_ALL)
    ? 'all'
    : selected.has(PERMISSIONS.STUDENTS_MANAGE_OWN)
      ? 'own'
      : 'none';

  const approvalScope =
    selected.has(PERMISSIONS.APPROVALS_JOBS_ALL) || selected.has(PERMISSIONS.APPROVALS_ACCOUNTS_ALL)
      ? 'all'
      : selected.has(PERMISSIONS.APPROVALS_JOBS_OWN) || selected.has(PERMISSIONS.APPROVALS_ACCOUNTS_OWN)
        ? 'own'
        : 'none';

  const jobsEnabled =
    selected.has(PERMISSIONS.APPROVALS_JOBS_OWN) || selected.has(PERMISSIONS.APPROVALS_JOBS_ALL);
  const accountsReqEnabled =
    selected.has(PERMISSIONS.APPROVALS_ACCOUNTS_OWN) ||
    selected.has(PERMISSIONS.APPROVALS_ACCOUNTS_ALL);

  const staffAccountLevel =
    selected.has(PERMISSIONS.ACCOUNTS_CREATE_TECH) ||
    selected.has(PERMISSIONS.ACCOUNTS_CREATE_TEACHER) ||
    selected.has(PERMISSIONS.ACCOUNTS_EDIT_PERMISSIONS) ||
    selected.has(PERMISSIONS.ACCOUNTS_MANAGE_STATUS) ||
    selected.has(PERMISSIONS.ACCOUNTS_DELETE)
      ? 'delegate'
      : selected.has(PERMISSIONS.ACCOUNTS_VIEW)
        ? 'view'
        : 'none';

  const activeCount = useMemo(
    () => permissions.filter((p) => ALL_DELEGATABLE_PERMISSIONS.includes(p)).length,
    [permissions]
  );

  return (
    <div className="space-y-4">
      {/* Row 1: Role Templates Strip */}
      <div className="space-y-1.5">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-[#5B616E] dark:text-[#9399A6]">
          {permCopy.presetsLabel}
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
          {catalog.presets.map((preset) => {
            const presetRole = preset.role === 'tech' ? 'tech' : 'teacher';
            const roleOk = allowRoleChange
              ? presetRole === 'tech'
                ? canCreateTech
                : canCreateTeacher
              : true;
            const rankOk = isMainAdmin || (preset.default_rank ?? 50) <= maxAssignableRank;
            const permsOk = canDelegateAll(preset.permissions);
            const allowed = roleOk && permsOk && rankOk;
            const active = samePermissionSet(permissions, preset.permissions) && role === presetRole;
            const presetMap = permCopy.presets as Record<string, { label: string; desc: string }>;
            const copy = presetMap[preset.id] ?? { label: preset.id, desc: '' };
            return (
              <button
                key={preset.id}
                type="button"
                disabled={disabled || !allowed}
                onClick={() => applyPreset(preset)}
                title={copy.desc}
                className={`flex flex-col items-start rounded-xl border px-3 py-2 text-left transition-all disabled:cursor-not-allowed disabled:opacity-45 ${
                  active
                    ? 'border-[#00A7D9] bg-[#00A7D9]/10 text-[#111318] ring-1 ring-[#00A7D9]/25 dark:text-[#F4F5F7]'
                    : 'border-black/[0.08] bg-white text-[#111318] hover:border-black/20 dark:border-white/[0.09] dark:bg-[#15171C] dark:text-[#F4F5F7] dark:hover:border-white/20'
                }`}
              >
                <div className="flex w-full items-center justify-between gap-1.5">
                  <span className="text-xs font-semibold">{copy.label}</span>
                  {!allowed ? (
                    <Lock className="h-3 w-3 shrink-0 text-[#8A909E]" />
                  ) : active ? (
                    <Check className="h-3.5 w-3.5 shrink-0 text-[#00A7D9]" />
                  ) : null}
                </div>
                {copy.desc && (
                  <span className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-[#5B616E] dark:text-[#9399A6]">
                    {copy.desc}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Row 2: Discord Hierarchy Rank & Account Type */}
      <div className="grid grid-cols-1 gap-3 rounded-xl border border-black/[0.07] bg-white p-3.5 dark:border-white/[0.08] dark:bg-[#15171C] md:grid-cols-12 md:items-center">
        <div className="space-y-1 md:col-span-5">
          <div className="text-[11px] font-medium text-[#5B616E] dark:text-[#9399A6]">
            {t.admin.teachers.roleLabel}
          </div>
          <div className="inline-flex rounded-xl border border-black/[0.08] bg-[#F6F7F9] p-0.5 dark:border-white/[0.09] dark:bg-[#0D0E11]">
            <button
              type="button"
              disabled={disabled || !allowRoleChange || !canCreateTeacher}
              onClick={() => onRoleChange?.('teacher')}
              className={`rounded-lg px-3 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                role === 'teacher'
                  ? 'bg-white text-[#111318] shadow-sm dark:bg-[#1D2027] dark:text-white'
                  : 'text-[#5B616E] dark:text-[#9399A6]'
              }`}
            >
              {t.admin.teachers.roleTeacher}
            </button>
            <button
              type="button"
              disabled={disabled || !allowRoleChange || !canCreateTech}
              onClick={() => onRoleChange?.('tech')}
              className={`rounded-lg px-3 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                role === 'tech'
                  ? 'bg-white text-[#111318] shadow-sm dark:bg-[#1D2027] dark:text-white'
                  : 'text-[#5B616E] dark:text-[#9399A6]'
              }`}
            >
              {t.admin.teachers.roleTech}
            </button>
          </div>
        </div>

        <div className="space-y-1 md:col-span-7">
          <div className="flex items-center justify-between text-[11px]">
            <span className="font-medium text-[#5B616E] dark:text-[#9399A6]">
              {t.admin.teachers.rankLabel}
            </span>
            <span className="rounded-full bg-[#00A7D9]/12 px-2 py-0.5 font-mono text-[11px] font-semibold tabular-nums text-[#007BA3] dark:text-[#38C6F4]">
              #{hierarchyRank} / {maxAssignableRank}
            </span>
          </div>
          <input
            type="range"
            min={1}
            max={maxAssignableRank}
            value={Math.min(hierarchyRank, maxAssignableRank)}
            disabled={disabled}
            onChange={(e) => onHierarchyRankChange(Number(e.target.value))}
            aria-label={t.admin.teachers.rankLabel}
            className="h-1.5 w-full cursor-pointer accent-[#00A7D9]"
          />
          <p className="text-[10px] text-[#5B616E] dark:text-[#9399A6]">
            {t.admin.teachers.rankHint.replace('{rank}', String(hierarchyRank))}
          </p>
        </div>
      </div>

      {/* Row 3: GitHub Fine-Grained Token Style Resource Matrix */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[#5B616E] dark:text-[#9399A6]">
            {permCopy.manualLabel}
          </span>
          <span className="font-mono text-[11px] tabular-nums text-[#5B616E] dark:text-[#9399A6]">
            {permCopy.activeCount
              .replace('{count}', String(activeCount))
              .replace('{total}', String(ALL_DELEGATABLE_PERMISSIONS.length))}
          </span>
        </div>

        <div className="divide-y divide-black/[0.06] overflow-hidden rounded-xl border border-black/[0.07] bg-white dark:divide-white/[0.07] dark:border-white/[0.08] dark:bg-[#15171C]">
          {/* 1. 3D Slicer */}
          <div className="flex flex-col gap-2 px-3.5 py-2.5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-xs font-medium text-[#111318] dark:text-[#F4F5F7]">
                {isFr ? 'Studio 3D & Trancheur' : '3D Print Studio & Slicer'}
              </div>
              <div className="text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                {permCopy.items['slicer:use']}
              </div>
            </div>
            <select
              aria-label={isFr ? 'Studio 3D & Trancheur' : '3D Print Studio & Slicer'}
              value={slicerLevel}
              disabled={disabled}
              onChange={(e) =>
                setGroupPermissions(
                  [PERMISSIONS.SLICER_USE],
                  e.target.value === 'use' ? [PERMISSIONS.SLICER_USE] : []
                )
              }
              className="studio-input w-full py-1 text-xs sm:w-52"
            >
              <option value="none">{isFr ? 'Aucun accès' : 'No access'}</option>
              <option value="use" disabled={!canDelegate(PERMISSIONS.SLICER_USE)}>
                {isFr ? 'Trancher & soumettre' : 'Slice & submit'}
              </option>
            </select>
          </div>

          {/* 2. Printers & Configurator */}
          <div className="space-y-2 px-3.5 py-2.5">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-xs font-medium text-[#111318] dark:text-[#F4F5F7]">
                  {isFr ? 'Imprimantes & Configurateur' : 'Printers & Configurator'}
                </div>
                <div className="text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                  {isFr
                    ? 'Lecture, emplacements MMU, modification/test et ajout/suppression/sync'
                    : 'View list, edit bed/profiles/test slice, or add/delete/sync machines'}
                </div>
              </div>
              <select
                aria-label={isFr ? 'Imprimantes & Configurateur' : 'Printers & Configurator'}
                value={printerLevel}
                disabled={disabled}
                onChange={(e) => {
                  const val = e.target.value;
                  const keepSlots = selected.has(PERMISSIONS.PRINTERS_MANAGE_SLOTS)
                    ? [PERMISSIONS.PRINTERS_MANAGE_SLOTS]
                    : [];
                  const allPrinterKeys = [
                    PERMISSIONS.PRINTERS_VIEW,
                    PERMISSIONS.PRINTERS_EDIT,
                    PERMISSIONS.PRINTERS_CREATE_DELETE,
                  ];
                  if (val === 'none') {
                    setGroupPermissions(
                      [...allPrinterKeys, PERMISSIONS.PRINTERS_MANAGE_SLOTS],
                      []
                    );
                  } else if (val === 'view') {
                    setGroupPermissions(allPrinterKeys, [PERMISSIONS.PRINTERS_VIEW, ...keepSlots]);
                  } else if (val === 'edit') {
                    setGroupPermissions(allPrinterKeys, [
                      PERMISSIONS.PRINTERS_VIEW,
                      PERMISSIONS.PRINTERS_EDIT,
                      ...keepSlots,
                    ]);
                  } else {
                    setGroupPermissions(allPrinterKeys, [
                      PERMISSIONS.PRINTERS_VIEW,
                      PERMISSIONS.PRINTERS_MANAGE_SLOTS,
                      PERMISSIONS.PRINTERS_EDIT,
                      PERMISSIONS.PRINTERS_CREATE_DELETE,
                    ]);
                  }
                }}
                className="studio-input w-full py-1 text-xs sm:w-52"
              >
                <option value="none">{isFr ? 'Aucun accès' : 'No access'}</option>
                <option value="view" disabled={!canDelegate(PERMISSIONS.PRINTERS_VIEW)}>
                  {isFr ? 'Lecture seule' : 'View only'}
                </option>
                <option value="edit" disabled={!canDelegate(PERMISSIONS.PRINTERS_EDIT)}>
                  {isFr ? 'Éditeur & Test Slice' : 'Edit & Test Slice'}
                </option>
                <option value="full" disabled={!canDelegate(PERMISSIONS.PRINTERS_CREATE_DELETE)}>
                  {isFr ? 'Complet (Ajout, Suppr., Sync)' : 'Full (Add, Delete & Sync)'}
                </option>
              </select>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                disabled={disabled || !canDelegate(PERMISSIONS.PRINTERS_MANAGE_SLOTS)}
                onClick={() =>
                  toggleSingle(PERMISSIONS.PRINTERS_MANAGE_SLOTS, PERMISSIONS.PRINTERS_VIEW)
                }
                className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-45 ${
                  selected.has(PERMISSIONS.PRINTERS_MANAGE_SLOTS)
                    ? 'border-[#00A7D9] bg-[#00A7D9]/12 text-[#007BA3] dark:text-[#38C6F4]'
                    : 'border-black/[0.08] text-[#5B616E] dark:border-white/[0.09] dark:text-[#9399A6]'
                }`}
              >
                {!canDelegate(PERMISSIONS.PRINTERS_MANAGE_SLOTS) && <Lock className="h-2.5 w-2.5" />}
                {permCopy.items['printers:manage_slots']}
              </button>
            </div>
          </div>

          {/* 3. Filaments Editor */}
          <div className="flex flex-col gap-2 px-3.5 py-2.5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-xs font-medium text-[#111318] dark:text-[#F4F5F7]">
                {isFr ? 'Éditeur de filaments' : 'Filaments Editor'}
              </div>
              <div className="text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                {isFr
                  ? 'Contrôle granulaire sur la lecture, l’édition et l’import/suppression'
                  : 'Granular view, edit properties, or create/catalog-import/delete'}
              </div>
            </div>
            <select
              aria-label={isFr ? 'Éditeur de filaments' : 'Filaments Editor'}
              value={filamentLevel}
              disabled={disabled}
              onChange={(e) => {
                const val = e.target.value;
                const allFilKeys = [
                  PERMISSIONS.FILAMENTS_VIEW,
                  PERMISSIONS.FILAMENTS_EDIT,
                  PERMISSIONS.FILAMENTS_CREATE_DELETE,
                ];
                if (val === 'none') {
                  setGroupPermissions(allFilKeys, []);
                } else if (val === 'view') {
                  setGroupPermissions(allFilKeys, [PERMISSIONS.FILAMENTS_VIEW]);
                } else if (val === 'edit') {
                  setGroupPermissions(allFilKeys, [
                    PERMISSIONS.FILAMENTS_VIEW,
                    PERMISSIONS.FILAMENTS_EDIT,
                  ]);
                } else {
                  setGroupPermissions(allFilKeys, allFilKeys);
                }
              }}
              className="studio-input w-full py-1 text-xs sm:w-52"
            >
              <option value="none">{isFr ? 'Aucun accès' : 'No access'}</option>
              <option value="view" disabled={!canDelegate(PERMISSIONS.FILAMENTS_VIEW)}>
                {isFr ? 'Lecture seule' : 'View only'}
              </option>
              <option value="edit" disabled={!canDelegate(PERMISSIONS.FILAMENTS_EDIT)}>
                {isFr ? 'Modifier existants' : 'Edit properties'}
              </option>
              <option value="full" disabled={!canDelegate(PERMISSIONS.FILAMENTS_CREATE_DELETE)}>
                {isFr ? 'Complet (Créer, Catalogue, Suppr.)' : 'Full (Create, Catalog & Delete)'}
              </option>
            </select>
          </div>

          {/* 4. Slicer Profiles */}
          <div className="flex flex-col gap-2 px-3.5 py-2.5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-xs font-medium text-[#111318] dark:text-[#F4F5F7]">
                {isFr ? 'Profils OrcaSlicer (.json / .ini)' : 'OrcaSlicer Profiles (.json / .ini)'}
              </div>
              <div className="text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                {permCopy.items['profiles:manage']}
              </div>
            </div>
            <select
              aria-label={isFr ? 'Profils OrcaSlicer (.json / .ini)' : 'OrcaSlicer Profiles (.json / .ini)'}
              value={profileLevel}
              disabled={disabled}
              onChange={(e) => {
                const val = e.target.value;
                const keys = [PERMISSIONS.PROFILES_VIEW, PERMISSIONS.PROFILES_MANAGE];
                if (val === 'none') setGroupPermissions(keys, []);
                else if (val === 'view') setGroupPermissions(keys, [PERMISSIONS.PROFILES_VIEW]);
                else setGroupPermissions(keys, keys);
              }}
              className="studio-input w-full py-1 text-xs sm:w-52"
            >
              <option value="none">{isFr ? 'Aucun accès' : 'No access'}</option>
              <option value="view" disabled={!canDelegate(PERMISSIONS.PROFILES_VIEW)}>
                {isFr ? 'Lecture seule' : 'View only'}
              </option>
              <option value="manage" disabled={!canDelegate(PERMISSIONS.PROFILES_MANAGE)}>
                {isFr ? 'Complet (Importer & Suppr.)' : 'Full (Upload & Delete)'}
              </option>
            </select>
          </div>

          {/* 5. Classes & Rosters */}
          <div className="flex flex-col gap-2 px-3.5 py-2.5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-xs font-medium text-[#111318] dark:text-[#F4F5F7]">
                {permCopy.groups.classes}
              </div>
              <div className="text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                {isFr
                  ? 'Créer des classes, importer des listes CSV/DA et transférer des étudiants'
                  : 'Create classes, bulk/CSV rosters, and transfer enrollments'}
              </div>
            </div>
            <select
              aria-label={permCopy.groups.classes}
              value={classLevel}
              disabled={disabled}
              onChange={(e) => {
                const val = e.target.value;
                const keys = [PERMISSIONS.CLASSES_MANAGE_OWN, PERMISSIONS.CLASSES_MANAGE_ALL];
                if (val === 'none') setGroupPermissions(keys, []);
                else if (val === 'own') setGroupPermissions(keys, [PERMISSIONS.CLASSES_MANAGE_OWN]);
                else setGroupPermissions(keys, [PERMISSIONS.CLASSES_MANAGE_ALL]);
              }}
              className="studio-input w-full py-1 text-xs sm:w-52"
            >
              <option value="none">{isFr ? 'Aucun accès' : 'No access'}</option>
              <option value="own" disabled={!canDelegate(PERMISSIONS.CLASSES_MANAGE_OWN)}>
                {isFr ? 'Ses propres classes' : 'Own classes'}
              </option>
              <option value="all" disabled={!canDelegate(PERMISSIONS.CLASSES_MANAGE_ALL)}>
                {isFr ? 'Toutes les classes' : 'All classes'}
              </option>
            </select>
          </div>

          {/* 6. Students & Quotas */}
          <div className="space-y-2 px-3.5 py-2.5">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-xs font-medium text-[#111318] dark:text-[#F4F5F7]">
                  {permCopy.groups.students}
                </div>
                <div className="text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                  {isFr
                    ? 'Portée de visibilité des étudiants + quotas et réinitialisation MDP'
                    : 'Student visibility scope plus quota adjustment & password reset actions'}
                </div>
              </div>
              <select
                aria-label={permCopy.groups.students}
                value={studentLevel}
                disabled={disabled}
                onChange={(e) => {
                  const val = e.target.value;
                  const scopeKeys = [
                    PERMISSIONS.STUDENTS_MANAGE_OWN,
                    PERMISSIONS.STUDENTS_MANAGE_ALL,
                  ];
                  if (val === 'none') {
                    setGroupPermissions(
                      [
                        ...scopeKeys,
                        PERMISSIONS.STUDENTS_ADJUST_QUOTAS,
                        PERMISSIONS.STUDENTS_RESET_PASSWORD,
                      ],
                      []
                    );
                  } else if (val === 'own') {
                    setGroupPermissions(scopeKeys, [PERMISSIONS.STUDENTS_MANAGE_OWN]);
                  } else {
                    setGroupPermissions(scopeKeys, [PERMISSIONS.STUDENTS_MANAGE_ALL]);
                  }
                }}
                className="studio-input w-full py-1 text-xs sm:w-52"
              >
                <option value="none">{isFr ? 'Aucun accès' : 'No access'}</option>
                <option value="own" disabled={!canDelegate(PERMISSIONS.STUDENTS_MANAGE_OWN)}>
                  {isFr ? 'Ses étudiants' : 'Own students'}
                </option>
                <option value="all" disabled={!canDelegate(PERMISSIONS.STUDENTS_MANAGE_ALL)}>
                  {isFr ? 'Tous les étudiants' : 'All students'}
                </option>
              </select>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  PERMISSIONS.STUDENTS_ADJUST_QUOTAS,
                  PERMISSIONS.STUDENTS_RESET_PASSWORD,
                ] as const
              ).map((k) => (
                <button
                  key={k}
                  type="button"
                  disabled={disabled || !canDelegate(k)}
                  onClick={() => toggleSingle(k, PERMISSIONS.STUDENTS_MANAGE_OWN)}
                  className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-45 ${
                    selected.has(k)
                      ? 'border-[#00A7D9] bg-[#00A7D9]/12 text-[#007BA3] dark:text-[#38C6F4]'
                      : 'border-black/[0.08] text-[#5B616E] dark:border-white/[0.09] dark:text-[#9399A6]'
                  }`}
                >
                  {!canDelegate(k) && <Lock className="h-2.5 w-2.5" />}
                  {(permCopy.items as Record<string, string>)[k]}
                </button>
              ))}
            </div>
          </div>

          {/* 7. Approvals */}
          <div className="space-y-2 px-3.5 py-2.5">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-xs font-medium text-[#111318] dark:text-[#F4F5F7]">
                  {permCopy.groups.approvals}
                </div>
                <div className="text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                  {isFr
                    ? 'Approuver ses files ou tout le labo (impressions / demandes de comptes)'
                    : 'Approve assigned queue or entire lab (print jobs / account requests)'}
                </div>
              </div>
              <select
                aria-label={permCopy.groups.approvals}
                value={approvalScope}
                disabled={disabled}
                onChange={(e) => {
                  const val = e.target.value;
                  const allAppKeys = [
                    PERMISSIONS.APPROVALS_JOBS_OWN,
                    PERMISSIONS.APPROVALS_JOBS_ALL,
                    PERMISSIONS.APPROVALS_ACCOUNTS_OWN,
                    PERMISSIONS.APPROVALS_ACCOUNTS_ALL,
                  ];
                  if (val === 'none') {
                    setGroupPermissions(allAppKeys, []);
                  } else {
                    const useJobs = jobsEnabled || !accountsReqEnabled;
                    const nextAdd: string[] = [];
                    if (useJobs) {
                      nextAdd.push(
                        val === 'all'
                          ? PERMISSIONS.APPROVALS_JOBS_ALL
                          : PERMISSIONS.APPROVALS_JOBS_OWN
                      );
                    }
                    if (accountsReqEnabled) {
                      nextAdd.push(
                        val === 'all'
                          ? PERMISSIONS.APPROVALS_ACCOUNTS_ALL
                          : PERMISSIONS.APPROVALS_ACCOUNTS_OWN
                      );
                    }
                    setGroupPermissions(allAppKeys, nextAdd);
                  }
                }}
                className="studio-input w-full py-1 text-xs sm:w-52"
              >
                <option value="none">{isFr ? 'Aucun accès' : 'No access'}</option>
                <option
                  value="own"
                  disabled={
                    !canDelegate(PERMISSIONS.APPROVALS_JOBS_OWN) &&
                    !canDelegate(PERMISSIONS.APPROVALS_ACCOUNTS_OWN)
                  }
                >
                  {isFr ? 'Portée personnelle' : 'Own scope'}
                </option>
                <option
                  value="all"
                  disabled={
                    !canDelegate(PERMISSIONS.APPROVALS_JOBS_ALL) &&
                    !canDelegate(PERMISSIONS.APPROVALS_ACCOUNTS_ALL)
                  }
                >
                  {isFr ? 'Tout le labo' : 'All lab'}
                </option>
              </select>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(() => {
                const jobKey =
                  approvalScope === 'all'
                    ? PERMISSIONS.APPROVALS_JOBS_ALL
                    : PERMISSIONS.APPROVALS_JOBS_OWN;
                const accKey =
                  approvalScope === 'all'
                    ? PERMISSIONS.APPROVALS_ACCOUNTS_ALL
                    : PERMISSIONS.APPROVALS_ACCOUNTS_OWN;
                return (
                  <>
                    <button
                      type="button"
                      disabled={disabled || !canDelegate(jobKey)}
                      onClick={() =>
                        setGroupPermissions(
                          [PERMISSIONS.APPROVALS_JOBS_OWN, PERMISSIONS.APPROVALS_JOBS_ALL],
                          jobsEnabled ? [] : [jobKey]
                        )
                      }
                      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-45 ${
                        jobsEnabled
                          ? 'border-[#00A7D9] bg-[#00A7D9]/12 text-[#007BA3] dark:text-[#38C6F4]'
                          : 'border-black/[0.08] text-[#5B616E] dark:border-white/[0.09] dark:text-[#9399A6]'
                      }`}
                    >
                      {!canDelegate(jobKey) && <Lock className="h-2.5 w-2.5" />}
                      {isFr ? 'Impressions en attente' : 'Print job queue'}
                    </button>
                    <button
                      type="button"
                      disabled={disabled || !canDelegate(accKey)}
                      onClick={() =>
                        setGroupPermissions(
                          [PERMISSIONS.APPROVALS_ACCOUNTS_OWN, PERMISSIONS.APPROVALS_ACCOUNTS_ALL],
                          accountsReqEnabled ? [] : [accKey]
                        )
                      }
                      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-45 ${
                        accountsReqEnabled
                          ? 'border-[#00A7D9] bg-[#00A7D9]/12 text-[#007BA3] dark:text-[#38C6F4]'
                          : 'border-black/[0.08] text-[#5B616E] dark:border-white/[0.09] dark:text-[#9399A6]'
                      }`}
                    >
                      {!canDelegate(accKey) && <Lock className="h-2.5 w-2.5" />}
                      {isFr ? 'Demandes de comptes étudiants' : 'Student account requests'}
                    </button>
                  </>
                );
              })()}
            </div>
          </div>

          {/* 8. Staff Account Management (Discord Delegation) */}
          <div className="space-y-2 px-3.5 py-2.5">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-xs font-medium text-[#111318] dark:text-[#F4F5F7]">
                  {permCopy.groups.accounts}
                </div>
                <div className="text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                  {isFr
                    ? 'Déléguez la création de Techs ou Enseignants (plafonnée au rang et droits du créateur)'
                    : 'Delegate Lab Tech / Teacher creation (capped at creator rank & subset)'}
                </div>
              </div>
              <select
                aria-label={permCopy.groups.accounts}
                value={staffAccountLevel}
                disabled={disabled}
                onChange={(e) => {
                  const val = e.target.value;
                  const allAccKeys = [
                    PERMISSIONS.ACCOUNTS_VIEW,
                    PERMISSIONS.ACCOUNTS_CREATE_TECH,
                    PERMISSIONS.ACCOUNTS_CREATE_TEACHER,
                    PERMISSIONS.ACCOUNTS_EDIT_PERMISSIONS,
                    PERMISSIONS.ACCOUNTS_MANAGE_STATUS,
                    PERMISSIONS.ACCOUNTS_DELETE,
                  ];
                  if (val === 'none') {
                    setGroupPermissions(allAccKeys, []);
                  } else if (val === 'view') {
                    setGroupPermissions(allAccKeys, [PERMISSIONS.ACCOUNTS_VIEW]);
                  } else {
                    setGroupPermissions(allAccKeys, [
                      PERMISSIONS.ACCOUNTS_VIEW,
                      PERMISSIONS.ACCOUNTS_CREATE_TECH,
                      PERMISSIONS.ACCOUNTS_EDIT_PERMISSIONS,
                      PERMISSIONS.ACCOUNTS_MANAGE_STATUS,
                    ]);
                  }
                }}
                className="studio-input w-full py-1 text-xs sm:w-52"
              >
                <option value="none">{isFr ? 'Aucun accès' : 'No access'}</option>
                <option value="view" disabled={!canDelegate(PERMISSIONS.ACCOUNTS_VIEW)}>
                  {isFr ? 'Lecture annuaire' : 'View directory'}
                </option>
                <option
                  value="delegate"
                  disabled={
                    !canDelegate(PERMISSIONS.ACCOUNTS_CREATE_TECH) &&
                    !canDelegate(PERMISSIONS.ACCOUNTS_CREATE_TEACHER) &&
                    !canDelegate(PERMISSIONS.ACCOUNTS_EDIT_PERMISSIONS)
                  }
                >
                  {isFr ? 'Gestion déléguée' : 'Delegated manager'}
                </option>
              </select>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  PERMISSIONS.ACCOUNTS_CREATE_TECH,
                  PERMISSIONS.ACCOUNTS_CREATE_TEACHER,
                  PERMISSIONS.ACCOUNTS_EDIT_PERMISSIONS,
                  PERMISSIONS.ACCOUNTS_MANAGE_STATUS,
                  PERMISSIONS.ACCOUNTS_DELETE,
                ] as const
              ).map((k) => (
                <button
                  key={k}
                  type="button"
                  disabled={disabled || !canDelegate(k)}
                  onClick={() => toggleSingle(k, PERMISSIONS.ACCOUNTS_VIEW)}
                  className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-45 ${
                    selected.has(k)
                      ? 'border-[#00A7D9] bg-[#00A7D9]/12 text-[#007BA3] dark:text-[#38C6F4]'
                      : 'border-black/[0.08] text-[#5B616E] dark:border-white/[0.09] dark:text-[#9399A6]'
                  }`}
                >
                  {!canDelegate(k) && <Lock className="h-2.5 w-2.5" />}
                  {(permCopy.items as Record<string, string>)[k]}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Row 4: Strict Admin-Only Notice */}
      <div className="flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-[11px] text-amber-800 dark:text-amber-300">
        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>{permCopy.adminOnlyNotice}</span>
      </div>
    </div>
  );
}
