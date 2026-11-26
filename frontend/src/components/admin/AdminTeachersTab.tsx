import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  KeyRound,
  Lock,
  Plus,
  Power,
  RotateCcw,
  Save,
  Search,
  Shield,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import type { AdminTeacher, PermissionCatalog, UserSummary } from '../../types/api';
import { translateApiError } from '../../utils/errors';
import {
  expandImpliedPermissions,
  getUserEffectiveRank,
  hasPermission,
  PERMISSIONS,
} from '../../utils/permissions';
import {
  AccountConfigurator,
  DEFAULT_TEACHER_PERMISSIONS,
  DEFAULT_TECH_PERMISSIONS,
  FALLBACK_PERMISSION_CATALOG,
} from './AccountConfigurator';

interface AdminTeachersTabProps {
  teachers: AdminTeacher[];
  currentUser?: UserSummary | null;
  onReload: () => Promise<void>;
  onError: (msg: string) => void;
}

type RoleFilter = 'all' | 'admin' | 'teacher' | 'tech';

function summarizeCapabilities(perms: readonly string[], isFr: boolean): string[] {
  const s = expandImpliedPermissions(perms);
  const badges: string[] = [];
  if (s.has(PERMISSIONS.PRINTERS_CREATE_DELETE)) badges.push(isFr ? 'Impr: Complet' : 'Printers: Full');
  else if (s.has(PERMISSIONS.PRINTERS_EDIT)) badges.push(isFr ? 'Impr: Éditer' : 'Printers: Edit');
  else if (s.has(PERMISSIONS.PRINTERS_MANAGE_SLOTS)) badges.push(isFr ? 'Impr: Emplacements' : 'Printers: Slots');
  else if (s.has(PERMISSIONS.PRINTERS_VIEW)) badges.push(isFr ? 'Impr: Lecture' : 'Printers: View');

  if (s.has(PERMISSIONS.FILAMENTS_CREATE_DELETE)) badges.push(isFr ? 'Filaments: Complet' : 'Filaments: Full');
  else if (s.has(PERMISSIONS.FILAMENTS_EDIT)) badges.push(isFr ? 'Filaments: Éditer' : 'Filaments: Edit');

  if (s.has(PERMISSIONS.APPROVALS_JOBS_ALL) || s.has(PERMISSIONS.APPROVALS_ACCOUNTS_ALL)) {
    badges.push(isFr ? 'Approbations: Tout' : 'Approvals: All');
  } else if (s.has(PERMISSIONS.APPROVALS_JOBS_OWN)) {
    badges.push(isFr ? 'Approbations: Propres' : 'Approvals: Own');
  }

  if (s.has(PERMISSIONS.CLASSES_MANAGE_ALL)) badges.push(isFr ? 'Classes: Toutes' : 'Classes: All');
  else if (s.has(PERMISSIONS.CLASSES_MANAGE_OWN)) badges.push(isFr ? 'Classes: Propres' : 'Classes: Own');

  if (s.has(PERMISSIONS.ACCOUNTS_CREATE_TEACHER)) badges.push(isFr ? 'Créer Enseignant' : 'Create Teacher');
  else if (s.has(PERMISSIONS.ACCOUNTS_CREATE_TECH)) badges.push(isFr ? 'Créer Tech' : 'Create Tech');
  else if (s.has(PERMISSIONS.ACCOUNTS_VIEW)) badges.push(isFr ? 'Annuaire' : 'Staff View');

  return badges.slice(0, 5);
}

export function AdminTeachersTab({
  teachers,
  currentUser = null,
  onReload,
  onError,
}: AdminTeachersTabProps) {
  const { lang, t } = useI18n();
  const isFr = lang === 'fr';
  const permCopy = t.admin.permissions;

  const isMainAdmin = !currentUser || currentUser.role === 'admin';
  const callerRank = isMainAdmin ? 100 : getUserEffectiveRank(currentUser);
  const canCreateTeacher = isMainAdmin || hasPermission(currentUser, PERMISSIONS.ACCOUNTS_CREATE_TEACHER);
  const canCreateTech = isMainAdmin || hasPermission(currentUser, PERMISSIONS.ACCOUNTS_CREATE_TECH);
  const canCreateAny = canCreateTeacher || canCreateTech;
  const canEditPerms = isMainAdmin || hasPermission(currentUser, PERMISSIONS.ACCOUNTS_EDIT_PERMISSIONS);
  const canManageStatus = isMainAdmin || hasPermission(currentUser, PERMISSIONS.ACCOUNTS_MANAGE_STATUS);
  const canDeleteAccount = isMainAdmin || hasPermission(currentUser, PERMISSIONS.ACCOUNTS_DELETE);

  const [catalog, setCatalog] = useState<PermissionCatalog>(FALLBACK_PERMISSION_CATALOG);

  // Filter & Search
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all');
  const [search, setSearch] = useState('');

  // Create staff account state
  const initialRole: 'teacher' | 'tech' = canCreateTeacher ? 'teacher' : 'tech';
  const [identifier, setIdentifier] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [createRole, setCreateRole] = useState<'teacher' | 'tech'>(initialRole);
  const [createRank, setCreateRank] = useState<number>(() => Math.min(50, callerRank));
  const [createPermsOpen, setCreatePermsOpen] = useState(false);
  const [createPerms, setCreatePerms] = useState<string[]>(() =>
    initialRole === 'tech' ? DEFAULT_TECH_PERMISSIONS : DEFAULT_TEACHER_PERMISSIONS
  );
  const [creating, setCreating] = useState(false);

  // Per-account actions & inline configurator
  const [busyId, setBusyId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editRoleDraft, setEditRoleDraft] = useState<'teacher' | 'tech'>('teacher');
  const [editRankDraft, setEditRankDraft] = useState<number>(50);
  const [editPermsDraft, setEditPermsDraft] = useState<string[]>([]);
  const [savedNoticeId, setSavedNoticeId] = useState<number | null>(null);

  const resetDialogRef = useRef<HTMLDialogElement | null>(null);
  const pressedOutsideRef = useRef(false);
  const [resetResult, setResetResult] = useState<{ da: string; temp_password: string } | null>(
    null
  );
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    api
      .adminGetPermissionCatalog()
      .then((res) => {
        if (active && res && Array.isArray(res.permissions) && res.permissions.length > 0) {
          setCatalog(res);
          const defList =
            initialRole === 'tech'
              ? res.role_defaults?.tech ?? DEFAULT_TECH_PERMISSIONS
              : res.role_defaults?.teacher ?? DEFAULT_TEACHER_PERMISSIONS;
          if (currentUser && currentUser.role !== 'admin') {
            const held = expandImpliedPermissions(currentUser.permissions ?? []);
            setCreatePerms(defList.filter((p) => held.has(p)));
          } else {
            setCreatePerms(defList);
          }
        }
      })
      .catch(() => {
        // Keep FALLBACK_PERMISSION_CATALOG
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const dialog = resetDialogRef.current;
    if (!dialog) return;
    if (resetResult && !dialog.open) {
      dialog.showModal();
    } else if (!resetResult && dialog.open) {
      dialog.close();
    }
  }, [resetResult]);

  const isOutsideRect = (ev: React.PointerEvent<HTMLDialogElement>) => {
    const dialog = resetDialogRef.current;
    if (!dialog) return false;
    const r = dialog.getBoundingClientRect();
    return (
      ev.clientX < r.left ||
      ev.clientX > r.right ||
      ev.clientY < r.top ||
      ev.clientY > r.bottom
    );
  };

  const getRoleDefaults = (role: 'teacher' | 'tech') =>
    role === 'tech'
      ? catalog.role_defaults?.tech ?? DEFAULT_TECH_PERMISSIONS
      : catalog.role_defaults?.teacher ?? DEFAULT_TEACHER_PERMISSIONS;

  const handleCreateRoleSwitch = (nextRole: 'teacher' | 'tech') => {
    setCreateRole(nextRole);
    const defs = getRoleDefaults(nextRole);
    if (currentUser && currentUser.role !== 'admin') {
      const held = expandImpliedPermissions(currentUser.permissions ?? []);
      setCreatePerms(defs.filter((p) => held.has(p)));
    } else {
      setCreatePerms(defs);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedId = identifier.trim();
    const trimmedName = name.trim();
    if (!trimmedId) {
      onError(t.errors.invalidIdentifier);
      return;
    }
    if (!trimmedName) {
      onError(t.errors.invalidName);
      return;
    }
    if (password.length < 4) {
      onError(t.errors.invalidPassword);
      return;
    }

    setCreating(true);
    try {
      await api.adminCreateTeacher({
        identifier: trimmedId,
        name: trimmedName,
        password,
        role: createRole,
        hierarchy_rank: Math.min(callerRank, Math.max(1, createRank)),
        permissions: createPerms,
      });
      setIdentifier('');
      setName('');
      setPassword('');
      handleCreateRoleSwitch(canCreateTeacher ? 'teacher' : 'tech');
      setCreateRank(Math.min(50, callerRank));
      setCreatePermsOpen(false);
      await onReload();
    } catch (err) {
      onError(translateApiError(err, t));
    } finally {
      setCreating(false);
    }
  };

  const handleToggleActive = async (account: AdminTeacher) => {
    setBusyId(account.id);
    try {
      await api.adminUpdateTeacher(account.id, { is_active: !account.is_active });
      await onReload();
    } catch (err) {
      onError(translateApiError(err, t));
    } finally {
      setBusyId(null);
    }
  };

  const openConfigurator = (account: AdminTeacher) => {
    if (editingId === account.id) {
      setEditingId(null);
      return;
    }
    const roleVal: 'teacher' | 'tech' = account.role === 'tech' ? 'tech' : 'teacher';
    setEditingId(account.id);
    setEditRoleDraft(roleVal);
    setEditRankDraft(account.hierarchy_rank ?? 50);
    setEditPermsDraft(
      Array.isArray(account.permissions) ? [...account.permissions] : [...getRoleDefaults(roleVal)]
    );
  };

  const handleSaveConfig = async (accountId: number) => {
    setBusyId(accountId);
    try {
      await api.adminUpdateTeacher(accountId, {
        role: editRoleDraft,
        hierarchy_rank: editRankDraft,
        permissions: editPermsDraft,
      });
      await onReload();
      setEditingId(null);
      setSavedNoticeId(accountId);
      setTimeout(() => setSavedNoticeId((prev) => (prev === accountId ? null : prev)), 2500);
    } catch (err) {
      onError(translateApiError(err, t));
    } finally {
      setBusyId(null);
    }
  };

  const handleResetPermissions = async (account: AdminTeacher) => {
    setBusyId(account.id);
    try {
      await api.adminUpdateTeacher(account.id, { reset_permissions: true });
      await onReload();
      const roleVal: 'teacher' | 'tech' = account.role === 'tech' ? 'tech' : 'teacher';
      setEditPermsDraft([...getRoleDefaults(roleVal)]);
      setEditingId(null);
      setSavedNoticeId(account.id);
      setTimeout(() => setSavedNoticeId((prev) => (prev === account.id ? null : prev)), 2500);
    } catch (err) {
      onError(translateApiError(err, t));
    } finally {
      setBusyId(null);
    }
  };

  const handleResetPassword = async (accountId: number) => {
    setBusyId(accountId);
    try {
      const res = await api.adminResetTeacherPassword(accountId);
      setCopied(false);
      setResetResult(res);
    } catch (err) {
      onError(translateApiError(err, t));
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteAccount = async (accountId: number) => {
    setBusyId(accountId);
    try {
      await api.adminDeleteTeacher(accountId);
      setConfirmDeleteId(null);
      await onReload();
    } catch (err) {
      onError(translateApiError(err, t));
    } finally {
      setBusyId(null);
    }
  };

  const handleCopyTempPassword = async () => {
    if (!resetResult) return;
    await navigator.clipboard.writeText(resetResult.temp_password);
    setCopied(true);
  };

  const filteredAccounts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return teachers.filter((acc) => {
      const accRole = acc.role ?? 'teacher';
      if (roleFilter !== 'all' && accRole !== roleFilter) return false;
      if (!q) return true;
      return acc.name.toLowerCase().includes(q) || acc.da.toLowerCase().includes(q);
    });
  }, [teachers, roleFilter, search]);

  return (
    <div className="space-y-6">
      {/* Header + Optional Create Staff Form */}
      <div className="studio-surface space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-[#111318] dark:text-[#F4F5F7]">
              {t.admin.teachers.title}
            </h2>
            <p className="mt-0.5 text-xs text-[#5B616E] dark:text-[#9399A6]">
              {t.admin.teachers.subtitle}
            </p>
          </div>
          {!isMainAdmin && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#00A7D9]/12 px-3 py-1 font-mono text-[11px] font-semibold text-[#007BA3] dark:text-[#38C6F4]">
              <Shield className="h-3.5 w-3.5" />
              {t.admin.teachers.rankLabel}: #{callerRank}
            </span>
          )}
        </div>

        {canCreateAny && (
          <form
            onSubmit={handleCreate}
            className="space-y-3 border-t border-black/[0.06] pt-4 dark:border-white/[0.07]"
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-12 sm:items-end">
              <div className="sm:col-span-4">
                <label className="mb-1 block text-[11px] font-medium text-[#5B616E] dark:text-[#9399A6]">
                  {t.admin.teachers.identifierLabel}
                </label>
                <input
                  type="text"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  placeholder={t.admin.teachers.identifierPlaceholder}
                  className="studio-input py-1.5 text-xs"
                  required
                />
              </div>

              <div className="sm:col-span-4">
                <label className="mb-1 block text-[11px] font-medium text-[#5B616E] dark:text-[#9399A6]">
                  {t.admin.teachers.nameLabel}
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t.admin.teachers.namePlaceholder}
                  className="studio-input py-1.5 text-xs"
                  required
                />
              </div>

              <div className="sm:col-span-2">
                <label className="mb-1 block text-[11px] font-medium text-[#5B616E] dark:text-[#9399A6]">
                  {t.admin.teachers.passwordLabel}
                </label>
                <input
                  type="password"
                  minLength={4}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••"
                  className="studio-input py-1.5 text-xs"
                  required
                />
              </div>

              <div className="sm:col-span-2">
                <button
                  type="submit"
                  disabled={creating}
                  className="btn-primary w-full py-1.5 text-xs"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t.admin.teachers.createBtn}
                </button>
              </div>
            </div>

            {/* Expandable GitHub-Style Account Configurator */}
            <div>
              <button
                type="button"
                onClick={() => setCreatePermsOpen((prev) => !prev)}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-[#007BA3] hover:underline dark:text-[#38C6F4]"
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                <span>
                  {permCopy.title} ·{' '}
                  {createRole === 'tech' ? t.admin.teachers.roleTech : t.admin.teachers.roleTeacher}{' '}
                  #{createRank} ({createPerms.length})
                </span>
                {createPermsOpen ? (
                  <ChevronUp className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
              </button>

              {createPermsOpen && (
                <div className="mt-3 rounded-xl border border-black/[0.07] bg-black/[0.015] p-4 dark:border-white/[0.08] dark:bg-white/[0.02]">
                  <AccountConfigurator
                    role={createRole}
                    onRoleChange={handleCreateRoleSwitch}
                    hierarchyRank={createRank}
                    onHierarchyRankChange={setCreateRank}
                    permissions={createPerms}
                    onPermissionsChange={setCreatePerms}
                    catalog={catalog}
                    callerUser={currentUser}
                    canCreateTeacher={canCreateTeacher}
                    canCreateTech={canCreateTech}
                    disabled={creating}
                  />
                </div>
              )}
            </div>
          </form>
        )}
      </div>

      {/* Filter & Search Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex flex-wrap gap-1 rounded-xl border border-black/[0.08] bg-[#F6F7F9] p-1 dark:border-white/[0.09] dark:bg-[#0D0E11]">
          {(
            [
              { id: 'all', label: t.admin.teachers.filterAll },
              { id: 'admin', label: t.admin.teachers.filterAdmins },
              { id: 'teacher', label: t.admin.teachers.filterTeachers },
              { id: 'tech', label: t.admin.teachers.filterTechs },
            ] as const
          ).map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setRoleFilter(f.id)}
              className={`rounded-lg px-3 py-1 text-xs font-medium transition-colors ${
                roleFilter === f.id
                  ? 'bg-white text-[#111318] shadow-sm dark:bg-[#1D2027] dark:text-[#F4F5F7]'
                  : 'text-[#5B616E] hover:text-[#111318] dark:text-[#9399A6] dark:hover:text-[#F4F5F7]'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="relative min-w-[220px] sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8A909E]" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t.admin.teachers.searchPlaceholder}
            className="studio-input py-1.5 pl-8 text-xs"
          />
        </div>
      </div>

      {/* Staff Accounts Cards */}
      {filteredAccounts.length === 0 ? (
        <div className="studio-surface p-10 text-center text-sm text-[#5B616E] dark:text-[#9399A6]">
          {t.admin.teachers.noTeachers}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {filteredAccounts.map((account) => {
            const accRole = account.role ?? 'teacher';
            const accRank = account.hierarchy_rank ?? (accRole === 'admin' ? 100 : 50);
            const isSuperAdminAcc = accRole === 'admin';
            const canManageAcc =
              !isSuperAdminAcc &&
              (account.can_manage ??
                (isMainAdmin ||
                  (currentUser?.id !== account.id && accRank <= callerRank)));
            const isBusy = busyId === account.id;
            const isConfirmingDelete = confirmDeleteId === account.id;
            const isEditing = editingId === account.id;
            const activePerms = account.permissions ?? getRoleDefaults(accRole === 'tech' ? 'tech' : 'teacher');
            const isCustom = Boolean(account.has_custom_permissions);
            const summaryChips = isSuperAdminAcc
              ? [isFr ? 'Système & API (Verrou Admin)' : 'System & APIs (Admin Lock)']
              : summarizeCapabilities(activePerms, isFr);

            return (
              <div key={account.id} className="studio-surface space-y-4 p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold text-[#111318] dark:text-[#F4F5F7]">
                        {account.name}
                      </h3>
                      <span className="studio-subtle px-2 py-0.5 font-mono text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                        {account.da}
                      </span>
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px] font-semibold ${
                          isSuperAdminAcc
                            ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                            : accRole === 'tech'
                              ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300'
                              : 'bg-[#00A7D9]/15 text-[#007BA3] dark:text-[#38C6F4]'
                        }`}
                      >
                        {isSuperAdminAcc
                          ? t.admin.teachers.roleAdmin
                          : accRole === 'tech'
                            ? t.admin.teachers.roleTech
                            : t.admin.teachers.roleTeacher}{' '}
                        · #{accRank}
                      </span>
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                          account.is_active
                            ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400'
                            : 'bg-rose-500/12 text-rose-700 dark:text-rose-400'
                        }`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            account.is_active ? 'bg-emerald-500' : 'bg-rose-500'
                          }`}
                        />
                        {account.is_active
                          ? t.admin.teachers.activeStatus
                          : t.admin.teachers.disabledStatus}
                      </span>
                      {!isSuperAdminAcc && (
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                            isCustom
                              ? 'bg-black/[0.07] text-[#111318] dark:bg-white/[0.12] dark:text-white'
                              : 'bg-black/[0.04] text-[#5B616E] dark:bg-white/[0.06] dark:text-[#9399A6]'
                          }`}
                        >
                          {isCustom ? permCopy.customBadge : permCopy.defaultBadge}
                        </span>
                      )}
                      {savedNoticeId === account.id && (
                        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
                          <Check className="h-3.5 w-3.5" />
                          {permCopy.savedNotice}
                        </span>
                      )}
                    </div>

                    {summaryChips.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {summaryChips.map((chip) => (
                          <span
                            key={chip}
                            className="rounded-md border border-black/[0.07] bg-black/[0.025] px-2 py-0.5 text-[10px] font-medium text-[#5B616E] dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-[#9399A6]"
                          >
                            {chip}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {!canManageAcc ? (
                      <span className="inline-flex items-center gap-1 rounded-lg border border-black/[0.08] bg-black/[0.03] px-2.5 py-1.5 text-xs font-medium text-[#5B616E] dark:border-white/[0.09] dark:bg-white/[0.04] dark:text-[#9399A6]">
                        <Lock className="h-3.5 w-3.5" />
                        {t.admin.teachers.protectedBadge}
                      </span>
                    ) : (
                      <>
                        {canEditPerms && (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => openConfigurator(account)}
                            className={`${
                              isEditing ? 'btn-primary' : 'btn-secondary'
                            } px-3 py-1.5 text-xs`}
                          >
                            <SlidersHorizontal className="h-3.5 w-3.5" />
                            {permCopy.editBtn}
                          </button>
                        )}
                        {canManageStatus && (
                          <>
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => handleToggleActive(account)}
                              className="btn-secondary px-3 py-1.5 text-xs"
                            >
                              <Power className="h-3.5 w-3.5" />
                              {account.is_active
                                ? t.admin.students.suspendedStatus
                                : t.admin.teachers.activeStatus}
                            </button>
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => handleResetPassword(account.id)}
                              className="btn-secondary px-3 py-1.5 text-xs"
                            >
                              <KeyRound className="h-3.5 w-3.5" />
                              {t.admin.teachers.resetPasswordBtn}
                            </button>
                          </>
                        )}
                        {canDeleteAccount && (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() =>
                              setConfirmDeleteId(isConfirmingDelete ? null : account.id)
                            }
                            className="btn-ghost px-2.5 py-1.5 text-xs text-rose-600 hover:bg-rose-500/10 hover:text-rose-700 dark:text-rose-400 dark:hover:text-rose-300"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            {t.admin.teachers.deleteBtn}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>

                {/* Stats Row */}
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                  <div className="studio-subtle px-3 py-2">
                    <div className="text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                      {t.admin.teachers.classesCount}
                    </div>
                    <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-[#111318] dark:text-[#F4F5F7]">
                      {account.class_count}
                    </div>
                  </div>
                  <div className="studio-subtle px-3 py-2">
                    <div className="text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                      {t.admin.teachers.studentsCount}
                    </div>
                    <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-[#111318] dark:text-[#F4F5F7]">
                      {account.student_count}
                    </div>
                  </div>
                  <div className="studio-subtle px-3 py-2">
                    <div className="text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                      {t.admin.teachers.pendingPrints}
                    </div>
                    <div
                      className={`mt-0.5 font-mono text-sm font-semibold tabular-nums ${
                        account.pending_print_approvals > 0
                          ? 'text-amber-600 dark:text-amber-400'
                          : 'text-[#111318] dark:text-[#F4F5F7]'
                      }`}
                    >
                      {account.pending_print_approvals}
                    </div>
                  </div>
                  <div className="studio-subtle px-3 py-2">
                    <div className="text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                      {t.admin.teachers.pendingAccounts}
                    </div>
                    <div
                      className={`mt-0.5 font-mono text-sm font-semibold tabular-nums ${
                        account.pending_account_requests > 0
                          ? 'text-amber-600 dark:text-amber-400'
                          : 'text-[#111318] dark:text-[#F4F5F7]'
                      }`}
                    >
                      {account.pending_account_requests}
                    </div>
                  </div>
                </div>

                {/* Inline GitHub-Style Account Configurator */}
                {isEditing && canManageAcc && (
                  <div className="space-y-4 rounded-xl border border-[#00A7D9]/30 bg-[#00A7D9]/[0.03] p-4 dark:bg-[#00A7D9]/[0.05]">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h4 className="text-xs font-semibold text-[#111318] dark:text-[#F4F5F7]">
                          {permCopy.title} · {account.name}
                        </h4>
                        <p className="text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                          {permCopy.subtitle}
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => handleResetPermissions(account)}
                        className="btn-ghost px-2.5 py-1 text-xs"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        {permCopy.resetDefaultBtn}
                      </button>
                    </div>

                    <AccountConfigurator
                      role={editRoleDraft}
                      onRoleChange={setEditRoleDraft}
                      hierarchyRank={editRankDraft}
                      onHierarchyRankChange={setEditRankDraft}
                      permissions={editPermsDraft}
                      onPermissionsChange={setEditPermsDraft}
                      catalog={catalog}
                      callerUser={currentUser}
                      canCreateTeacher={canCreateTeacher}
                      canCreateTech={canCreateTech}
                      allowRoleChange={isMainAdmin || (canCreateTeacher && canCreateTech)}
                      disabled={isBusy}
                    />

                    <div className="flex justify-end gap-2 border-t border-black/[0.06] pt-3 dark:border-white/[0.07]">
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => setEditingId(null)}
                        className="btn-secondary py-1.5 text-xs"
                      >
                        {t.common.cancel}
                      </button>
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => handleSaveConfig(account.id)}
                        className="btn-primary py-1.5 text-xs"
                      >
                        <Save className="h-3.5 w-3.5" />
                        {t.common.save}
                      </button>
                    </div>
                  </div>
                )}

                {/* Inline Delete Confirmation */}
                {isConfirmingDelete && (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-500/25 bg-rose-500/8 px-4 py-3 text-xs">
                    <div className="flex items-start gap-2.5 text-rose-800 dark:text-rose-200">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" />
                      <div className="space-y-0.5">
                        <div className="font-semibold">
                          {t.admin.teachers.deleteConfirm.replace('{name}', account.name)}
                        </div>
                        <div className="text-[11px] text-rose-700/90 dark:text-rose-300/90">
                          {lang === 'fr'
                            ? 'La suppression retire toutes ses classes et désactive les étudiants qui n’ont aucune autre classe.'
                            : 'Deleting removes all their classes and disables any orphaned students with no remaining classes.'}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => setConfirmDeleteId(null)}
                        className="btn-secondary px-3 py-1.5 text-xs"
                      >
                        {t.common.cancel}
                      </button>
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => handleDeleteAccount(account.id)}
                        className="btn-danger px-3 py-1.5 text-xs"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        {t.common.confirm}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Native <dialog> Reset Password Result Modal */}
      <dialog
        ref={resetDialogRef}
        {...({ closedby: 'any' } as Record<string, string>)}
        aria-labelledby="teacher-reset-pw-dialog-title"
        onClose={() => setResetResult(null)}
        onPointerDown={(ev) => {
          pressedOutsideRef.current = isOutsideRect(ev);
        }}
        onPointerUp={(ev) => {
          if (
            pressedOutsideRef.current &&
            isOutsideRect(ev) &&
            !('closedBy' in HTMLDialogElement.prototype)
          ) {
            resetDialogRef.current?.close();
          }
          pressedOutsideRef.current = false;
        }}
        className="pw-dialog w-full max-w-sm"
      >
        {resetResult && (
          <div className="p-6">
            <div className="flex items-center justify-between">
              <h1
                id="teacher-reset-pw-dialog-title"
                className="text-base font-semibold text-[#111318] dark:text-[#F4F5F7]"
              >
                {t.admin.students.tempPasswordTitle}
              </h1>
              <button
                type="button"
                onClick={() => resetDialogRef.current?.close()}
                aria-label={t.common.close}
                className="btn-ghost p-1"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-[#5B616E] dark:text-[#9399A6]">
              {t.admin.teachers.tempPasswordDesc.replace('{da}', resetResult.da)}
            </p>
            <div className="studio-subtle mt-4 flex items-center justify-between gap-2 px-3.5 py-2.5">
              <span className="font-mono text-base font-semibold tracking-wider text-[#007BA3] dark:text-[#38C6F4]">
                {resetResult.temp_password}
              </span>
              <button
                type="button"
                onClick={handleCopyTempPassword}
                className="btn-secondary px-2.5 py-1 text-xs"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-emerald-500" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                {copied ? t.admin.students.copied : t.admin.students.copyPassword}
              </button>
            </div>
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                autoFocus
                onClick={() => resetDialogRef.current?.close()}
                className="btn-primary py-1.5 text-xs"
              >
                {t.common.close}
              </button>
            </div>
          </div>
        )}
      </dialog>
    </div>
  );
}
