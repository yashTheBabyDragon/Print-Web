import { useMemo } from 'react';
import { Check } from 'lucide-react';
import { useI18n } from '../../i18n';
import type { PermissionCatalog } from '../../types/api';
import { PERMISSIONS } from '../../utils/permissions';

export const DEFAULT_TEACHER_PERMISSIONS: string[] = [
  PERMISSIONS.SLICER_USE,
  PERMISSIONS.CLASSES_MANAGE_OWN,
  PERMISSIONS.STUDENTS_MANAGE_OWN,
  PERMISSIONS.APPROVALS_MANAGE_OWN,
];

const ALL_PERMISSIONS: string[] = Object.values(PERMISSIONS);

export const FALLBACK_PERMISSION_CATALOG: PermissionCatalog = {
  permissions: [
    { key: PERMISSIONS.SLICER_USE, group: 'slicer' },
    { key: PERMISSIONS.CLASSES_MANAGE_OWN, group: 'classes' },
    { key: PERMISSIONS.CLASSES_MANAGE_ALL, group: 'classes' },
    { key: PERMISSIONS.STUDENTS_MANAGE_OWN, group: 'students' },
    { key: PERMISSIONS.STUDENTS_MANAGE_ALL, group: 'students' },
    { key: PERMISSIONS.APPROVALS_MANAGE_OWN, group: 'approvals' },
    { key: PERMISSIONS.APPROVALS_MANAGE_ALL, group: 'approvals' },
    { key: PERMISSIONS.PRINTERS_MANAGE, group: 'printers' },
    { key: PERMISSIONS.FILAMENTS_MANAGE, group: 'printers' },
    { key: PERMISSIONS.PROFILES_MANAGE, group: 'printers' },
    { key: PERMISSIONS.TEACHERS_MANAGE, group: 'admin' },
    { key: PERMISSIONS.SETTINGS_MANAGE, group: 'admin' },
    { key: PERMISSIONS.UPDATES_MANAGE, group: 'admin' },
  ],
  presets: [
    { id: 'teacher_default', permissions: DEFAULT_TEACHER_PERMISSIONS },
    {
      id: 'lab_tech',
      permissions: [
        PERMISSIONS.SLICER_USE,
        PERMISSIONS.PRINTERS_MANAGE,
        PERMISSIONS.FILAMENTS_MANAGE,
        PERMISSIONS.PROFILES_MANAGE,
        PERMISSIONS.APPROVALS_MANAGE_ALL,
      ],
    },
    {
      id: 'coordinator',
      permissions: [
        PERMISSIONS.SLICER_USE,
        PERMISSIONS.CLASSES_MANAGE_OWN,
        PERMISSIONS.CLASSES_MANAGE_ALL,
        PERMISSIONS.STUDENTS_MANAGE_OWN,
        PERMISSIONS.STUDENTS_MANAGE_ALL,
        PERMISSIONS.APPROVALS_MANAGE_OWN,
        PERMISSIONS.APPROVALS_MANAGE_ALL,
      ],
    },
    { id: 'slicer_only', permissions: [PERMISSIONS.SLICER_USE] },
    { id: 'full_admin', permissions: ALL_PERMISSIONS },
  ],
  role_defaults: {
    student: [PERMISSIONS.SLICER_USE],
    teacher: DEFAULT_TEACHER_PERMISSIONS,
    admin: ALL_PERMISSIONS,
  },
};

function samePermissionSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  return b.every((item) => setA.has(item));
}

interface TeacherPermissionsEditorProps {
  value: string[];
  onChange: (next: string[]) => void;
  catalog: PermissionCatalog;
  disabled?: boolean;
}

export function TeacherPermissionsEditor({
  value,
  onChange,
  catalog,
  disabled = false,
}: TeacherPermissionsEditorProps) {
  const { t } = useI18n();
  const permCopy = t.admin.permissions;

  const selectedSet = useMemo(() => new Set(value), [value]);

  const grouped = useMemo(() => {
    const groupsMap = new Map<string, string[]>();
    for (const item of catalog.permissions) {
      // Combine classes + students visually under 'classes' if separate, or preserve backend group
      const list = groupsMap.get(item.group) ?? [];
      list.push(item.key);
      groupsMap.set(item.group, list);
    }
    return Array.from(groupsMap.entries());
  }, [catalog.permissions]);

  const togglePermission = (key: string) => {
    if (disabled) return;
    if (selectedSet.has(key)) {
      onChange(value.filter((p) => p !== key));
    } else {
      onChange([...value, key]);
    }
  };

  const getGroupLabel = (group: string) => {
    const map = permCopy.groups as Record<string, string>;
    return map[group] ?? group;
  };

  const getItemLabel = (key: string) => {
    const map = permCopy.items as Record<string, string>;
    return map[key] ?? key;
  };

  const getPresetCopy = (id: string) => {
    const map = permCopy.presets as Record<string, { label: string; desc: string }>;
    return map[id] ?? { label: id, desc: '' };
  };

  return (
    <div className="space-y-4">
      {/* Quick Presets */}
      <div className="space-y-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-[#5B616E] dark:text-[#9399A6]">
          {permCopy.presetsLabel}
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
          {catalog.presets.map((preset) => {
            const active = samePermissionSet(value, preset.permissions);
            const copy = getPresetCopy(preset.id);
            return (
              <button
                key={preset.id}
                type="button"
                disabled={disabled}
                onClick={() => onChange([...preset.permissions])}
                title={copy.desc}
                className={`flex flex-col items-start rounded-xl border px-3 py-2 text-left transition-all disabled:opacity-50 ${
                  active
                    ? 'border-[#00A7D9] bg-[#00A7D9]/10 text-[#111318] ring-1 ring-[#00A7D9]/25 dark:text-[#F4F5F7]'
                    : 'border-black/[0.08] bg-white text-[#111318] hover:border-black/20 dark:border-white/[0.09] dark:bg-[#15171C] dark:text-[#F4F5F7] dark:hover:border-white/20'
                }`}
              >
                <div className="flex w-full items-center justify-between gap-1.5">
                  <span className="text-xs font-semibold">{copy.label}</span>
                  {active && <Check className="h-3.5 w-3.5 shrink-0 text-[#00A7D9]" />}
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

      {/* Manual Toggle Controls */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[#5B616E] dark:text-[#9399A6]">
            {permCopy.manualLabel}
          </span>
          <span className="font-mono text-[11px] tabular-nums text-[#5B616E] dark:text-[#9399A6]">
            {permCopy.activeCount
              .replace('{count}', String(value.length))
              .replace('{total}', String(catalog.permissions.length))}
          </span>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {grouped.map(([group, keys]) => (
            <div key={group} className="studio-subtle space-y-1.5 p-3">
              <div className="text-[11px] font-semibold text-[#111318] dark:text-[#F4F5F7]">
                {getGroupLabel(group)}
              </div>
              <div className="space-y-1">
                {keys.map((key) => {
                  const checked = selectedSet.has(key);
                  return (
                    <label
                      key={key}
                      className="flex cursor-pointer items-start gap-2 rounded-lg px-1.5 py-1 text-xs transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={() => togglePermission(key)}
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded"
                      />
                      <span className="min-w-0 leading-snug text-[#111318] dark:text-[#F4F5F7]">
                        {getItemLabel(key)}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
