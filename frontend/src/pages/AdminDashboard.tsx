import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  Loader2,
  Monitor,
  Palette,
  Printer,
  Settings,
  ShieldCheck,
  UserCog,
  Users,
} from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useI18n } from '../i18n';
import type {
  AdminPrinter,
  AdminTeacher,
  ApprovalsResponse,
  FdmMonsterRemotePrinter,
  Filament,
  FilamentApiPrinter,
  OrcaProfile,
  PendingAccountRequest,
  StudentAccount,
  SystemSettings,
  TeacherClass,
} from '../types/api';
import { translateApiError } from '../utils/errors';
import { hasAnyPermission, hasPermission, PERMISSIONS } from '../utils/permissions';
import { AdminApprovalsTab } from '../components/admin/AdminApprovalsTab';
import { AdminFilamentsProfilesTab } from '../components/admin/AdminFilamentsProfilesTab';
import { AdminPrintersTab } from '../components/admin/AdminPrintersTab';
import { AdminSettingsTab } from '../components/admin/AdminSettingsTab';
import { AdminStudentsTab } from '../components/admin/AdminStudentsTab';
import { AdminTeachersTab } from '../components/admin/AdminTeachersTab';

type AdminTabId =
  | 'printers'
  | 'filaments'
  | 'students'
  | 'approvals'
  | 'teachers'
  | 'settings';

interface AdminDashboardProps {
  onGoToPrint?: () => void;
}

export function AdminDashboard({ onGoToPrint }: AdminDashboardProps = {}) {
  const { user, authMode } = useAuth();
  const { t } = useI18n();

  const isMainAdmin = user?.role === 'admin';
  const canViewPrinters = hasPermission(user, PERMISSIONS.PRINTERS_VIEW);
  const canManagePrinterSlots = hasPermission(user, PERMISSIONS.PRINTERS_MANAGE_SLOTS);
  const canEditPrinters = hasPermission(user, PERMISSIONS.PRINTERS_EDIT);
  const canCreateDeletePrinters = hasPermission(user, PERMISSIONS.PRINTERS_CREATE_DELETE);
  const canViewFilaments = hasPermission(user, PERMISSIONS.FILAMENTS_VIEW);
  const canEditFilaments = hasPermission(user, PERMISSIONS.FILAMENTS_EDIT);
  const canCreateDeleteFilaments = hasPermission(user, PERMISSIONS.FILAMENTS_CREATE_DELETE);
  const canViewProfiles = hasPermission(user, PERMISSIONS.PROFILES_VIEW);
  const canManageProfiles = hasPermission(user, PERMISSIONS.PROFILES_MANAGE);
  const canManageClasses = hasAnyPermission(user, [
    PERMISSIONS.CLASSES_MANAGE_OWN,
    PERMISSIONS.CLASSES_MANAGE_ALL,
  ]);
  const canManageStudents = hasAnyPermission(user, [
    PERMISSIONS.STUDENTS_MANAGE_OWN,
    PERMISSIONS.STUDENTS_MANAGE_ALL,
  ]);
  const canAdjustQuotas = hasPermission(user, PERMISSIONS.STUDENTS_ADJUST_QUOTAS);
  const canResetStudentPasswords = hasPermission(user, PERMISSIONS.STUDENTS_RESET_PASSWORD);
  const canApproveJobs = hasAnyPermission(user, [
    PERMISSIONS.APPROVALS_JOBS_OWN,
    PERMISSIONS.APPROVALS_JOBS_ALL,
  ]);
  const canApproveAccounts = hasAnyPermission(user, [
    PERMISSIONS.APPROVALS_ACCOUNTS_OWN,
    PERMISSIONS.APPROVALS_ACCOUNTS_ALL,
  ]);
  const canManageApprovals = canApproveJobs || canApproveAccounts;
  const canViewAccounts = hasPermission(user, PERMISSIONS.ACCOUNTS_VIEW);
  const canManageSettings = isMainAdmin;
  const canManageUpdates = isMainAdmin;
  const canManageAllClasses = hasPermission(user, PERMISSIONS.CLASSES_MANAGE_ALL);
  const canManageAllApprovals = hasPermission(user, PERMISSIONS.APPROVALS_JOBS_ALL);
  const canManageAllAccountReqs = hasPermission(user, PERMISSIONS.APPROVALS_ACCOUNTS_ALL);

  const isTeacherPortal = !isMainAdmin;

  const [tab, setTab] = useState<AdminTabId>(() =>
    canViewPrinters || canViewProfiles ? 'printers' : 'students'
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [printers, setPrinters] = useState<AdminPrinter[]>([]);
  const [filaments, setFilaments] = useState<Filament[]>([]);
  const [profiles, setProfiles] = useState<OrcaProfile[]>([]);
  const [classes, setClasses] = useState<TeacherClass[]>([]);
  const [teachers, setTeachers] = useState<AdminTeacher[]>([]);
  const [students, setStudents] = useState<StudentAccount[]>([]);
  const [accountRequests, setAccountRequests] = useState<PendingAccountRequest[]>([]);
  const [approvals, setApprovals] = useState<ApprovalsResponse>({
    pending: [],
    history: [],
  });
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [filamentApiPrinters, setFilamentApiPrinters] = useState<FilamentApiPrinter[]>([]);
  const [remoteFdmPrinters, setRemoteFdmPrinters] = useState<FdmMonsterRemotePrinter[]>([]);

  const reloadAll = useCallback(async () => {
    setError(null);
    try {
      const [p, f, pr, cl, st, ap, ar, te, se, fap, rfp] = await Promise.all([
        canViewPrinters ? api.adminGetPrinters() : Promise.resolve<AdminPrinter[]>([]),
        canViewFilaments || canViewPrinters
          ? api.adminGetFilaments()
          : Promise.resolve<Filament[]>([]),
        canViewProfiles || canEditPrinters || canEditFilaments
          ? api.adminGetProfiles()
          : Promise.resolve<OrcaProfile[]>([]),
        canManageClasses ? api.adminGetClasses() : Promise.resolve<TeacherClass[]>([]),
        canManageStudents ? api.adminGetStudents() : Promise.resolve<StudentAccount[]>([]),
        canApproveJobs
          ? api.adminGetApprovals()
          : Promise.resolve<ApprovalsResponse>({ pending: [], history: [] }),
        canApproveAccounts
          ? api.adminGetAccountRequests()
          : Promise.resolve<PendingAccountRequest[]>([]),
        canViewAccounts ? api.adminGetTeachers() : Promise.resolve<AdminTeacher[]>([]),
        canManageSettings ? api.adminGetSettings() : Promise.resolve<SystemSettings | null>(null),
        canViewPrinters
          ? api.adminGetFilamentApiPrinters().catch(() => [] as FilamentApiPrinter[])
          : Promise.resolve<FilamentApiPrinter[]>([]),
        canCreateDeletePrinters || canEditPrinters
          ? api.adminGetFdmMonsterPrinters().catch(() => [] as FdmMonsterRemotePrinter[])
          : Promise.resolve<FdmMonsterRemotePrinter[]>([]),
      ]);
      setPrinters(p);
      setFilaments(f);
      setProfiles(pr);
      setClasses(cl);
      setStudents(st);
      setApprovals(ap);
      setAccountRequests(ar);
      setTeachers(te);
      setSettings(se);
      setFilamentApiPrinters(fap);
      setRemoteFdmPrinters(rfp);
    } catch (err) {
      setError(translateApiError(err, t));
    } finally {
      setLoading(false);
    }
  }, [
    canViewPrinters,
    canViewFilaments,
    canEditFilaments,
    canEditPrinters,
    canCreateDeletePrinters,
    canViewProfiles,
    canManageClasses,
    canManageStudents,
    canApproveJobs,
    canApproveAccounts,
    canViewAccounts,
    canManageSettings,
    t,
  ]);

  useEffect(() => {
    reloadAll();
  }, [reloadAll]);

  const pendingApprovalsCount = approvals.pending.length + accountRequests.length;

  const navGroups = useMemo(() => {
    type NavItem = { id: AdminTabId; label: string; icon: typeof Printer; badge?: number };
    const labItems: NavItem[] = [];
    if (canViewPrinters || canViewProfiles) {
      labItems.push({ id: 'printers', label: t.admin.tabs.printers, icon: Printer });
    }
    if (canViewFilaments) {
      labItems.push({ id: 'filaments', label: t.admin.tabs.filaments, icon: Palette });
    }

    const peopleItems: NavItem[] = [];
    if (canManageApprovals) {
      peopleItems.push({
        id: 'approvals',
        label: t.admin.tabs.approvals,
        icon: ShieldCheck,
        badge: pendingApprovalsCount,
      });
    }
    if (canManageClasses || canManageStudents) {
      peopleItems.push({ id: 'students', label: t.admin.tabs.students, icon: Users });
    }
    if (canViewAccounts) {
      peopleItems.push({ id: 'teachers', label: t.admin.tabs.teachers, icon: UserCog });
    }

    const systemItems: NavItem[] = [];
    if (canManageSettings || canManageUpdates) {
      systemItems.push({
        id: 'settings',
        label: t.admin.tabs.settings,
        icon: Settings,
      });
    }

    return [
      { id: 'lab', label: t.admin.groups.lab, items: labItems },
      { id: 'people', label: t.admin.groups.people, items: peopleItems },
      { id: 'system', label: t.admin.groups.system, items: systemItems },
    ].filter((g) => g.items.length > 0);
  }, [
    canViewPrinters,
    canViewFilaments,
    canViewProfiles,
    canManageClasses,
    canManageStudents,
    canManageApprovals,
    canViewAccounts,
    canManageSettings,
    canManageUpdates,
    pendingApprovalsCount,
    t,
  ]);

  const tabs = useMemo(() => navGroups.flatMap((g) => g.items), [navGroups]);

  const effectiveTab: AdminTabId = tabs.some((item) => item.id === tab)
    ? tab
    : (tabs[0]?.id ?? 'students');

  useEffect(() => {
    if (effectiveTab !== tab) {
      setTab(effectiveTab);
    }
  }, [effectiveTab, tab]);

  const headerTitle = isTeacherPortal ? t.admin.teacherPortalTitle : t.admin.title;
  const headerSubtitle = isTeacherPortal ? t.admin.teacherPortalSubtitle : t.admin.subtitle;

  return (
    <>
      {/* Mobile (<768px): Desktop-only warning */}
      <div className="mx-auto flex min-h-[calc(100dvh-4rem)] max-w-md items-center justify-center px-4 py-10 md:hidden">
        <div className="studio-surface w-full p-6 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-[#00A7D9]/12 text-[#007BA3] dark:text-[#38C6F4]">
            <Monitor className="h-6 w-6" aria-hidden="true" />
          </div>
          <h1 className="mt-4 text-lg font-semibold tracking-tight text-[#111318] dark:text-[#F4F5F7]">
            {t.admin.mobileWarningTitle}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-[#5B616E] dark:text-[#9399A6]">
            {t.admin.mobileWarningDesc}
          </p>
          {onGoToPrint && (
            <button
              type="button"
              onClick={onGoToPrint}
              className="btn-primary mt-6 min-h-[44px] w-full"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              {t.admin.backToStudentView}
            </button>
          )}
        </div>
      </div>

      {/* Tablet & Desktop (>=768px): Full Admin / Teacher Dashboard */}
      <div className="mx-auto hidden max-w-[1440px] px-4 py-8 sm:px-6 md:block">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight text-[#111318] dark:text-[#F4F5F7]">
            {headerTitle}
          </h1>
          <p className="mt-1 text-sm text-[#5B616E] dark:text-[#9399A6]">{headerSubtitle}</p>
        </div>

        <div className="flex flex-col gap-6 lg:flex-row">
          {/* Left Rail (collapses to horizontal strip on tablet) */}
          <nav
            aria-label={headerTitle}
            className="flex shrink-0 gap-3 overflow-x-auto pb-1 lg:w-60 lg:flex-col lg:gap-4 lg:pb-0"
          >
            {navGroups.map((group) => (
              <div key={group.id} className="flex shrink-0 items-center gap-1 lg:flex-col lg:items-stretch">
                <div className="hidden px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[#8A909E] dark:text-[#6B717D] lg:block">
                  {group.label}
                </div>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active = effectiveTab === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setTab(item.id)}
                      className={`flex shrink-0 items-center justify-between gap-2.5 rounded-xl px-3 py-2 text-[13px] font-medium transition-colors ${
                        active
                          ? 'bg-white text-[#111318] shadow-sm ring-1 ring-black/[0.06] dark:bg-[#1D2027] dark:text-white dark:ring-white/[0.08]'
                          : 'text-[#5B616E] hover:bg-black/[0.04] hover:text-[#111318] dark:text-[#9399A6] dark:hover:bg-white/[0.05] dark:hover:text-[#F4F5F7]'
                      }`}
                    >
                      <span className="flex items-center gap-2.5">
                        <Icon
                          className={`h-4 w-4 ${
                            active ? 'text-[#00A7D9]' : 'text-[#8A909E] dark:text-[#6B717D]'
                          }`}
                        />
                        <span>{item.label}</span>
                      </span>
                      {item.badge != null && item.badge > 0 && (
                        <span className="rounded-full bg-amber-500 px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums text-slate-950">
                          {item.badge}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>

          {/* Main Panel */}
          <div className="min-w-0 flex-1 space-y-5">
            {error && (
              <div className="flex items-start justify-between gap-2 rounded-xl bg-rose-500/10 px-4 py-3 text-sm text-rose-700 dark:text-rose-300">
                <div className="flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setError(null)}
                  className="text-xs font-medium underline"
                >
                  {t.common.close}
                </button>
              </div>
            )}

            {loading ? (
              <div className="studio-surface flex items-center justify-center gap-2 py-16 text-sm text-[#5B616E] dark:text-[#9399A6]">
                <Loader2 className="h-4 w-4 animate-spin text-[#00A7D9]" />
                {t.common.loading}
              </div>
            ) : (
              <>
                {effectiveTab === 'printers' && (canViewPrinters || canViewProfiles) && (
                  <AdminPrintersTab
                    printers={printers}
                    filaments={filaments}
                    profiles={profiles}
                    canManagePrinters={canViewPrinters}
                    canManageSlots={canManagePrinterSlots}
                    canEditPrinters={canEditPrinters}
                    canCreateDeletePrinters={canCreateDeletePrinters}
                    canManageProfiles={canManageProfiles}
                    filamentApiEnabled={settings?.filament_api_enabled ?? filamentApiPrinters.length > 0}
                    filamentApiPrinters={filamentApiPrinters}
                    remoteFdmPrinters={remoteFdmPrinters}
                    onReload={reloadAll}
                    onError={setError}
                  />
                )}
                {effectiveTab === 'filaments' && canViewFilaments && (
                  <AdminFilamentsProfilesTab
                    filaments={filaments}
                    profiles={profiles}
                    canEditFilaments={canEditFilaments}
                    canCreateDeleteFilaments={canCreateDeleteFilaments}
                    onReload={reloadAll}
                    onError={setError}
                  />
                )}
                {effectiveTab === 'students' && (canManageClasses || canManageStudents) && (
                  <AdminStudentsTab
                    classes={classes}
                    teachers={teachers}
                    students={students}
                    accountRequests={accountRequests}
                    isSuperAdmin={canManageAllClasses}
                    canAdjustQuotas={canAdjustQuotas}
                    canResetPasswords={canResetStudentPasswords}
                    onOpenApprovals={canManageApprovals ? () => setTab('approvals') : undefined}
                    onReload={reloadAll}
                    onError={setError}
                  />
                )}
                {effectiveTab === 'approvals' && canManageApprovals && (
                  <AdminApprovalsTab
                    approvals={approvals}
                    accountRequests={accountRequests}
                    classes={classes}
                    isSuperAdmin={canManageAllApprovals || canManageAllAccountReqs}
                    canApproveJobs={canApproveJobs}
                    canApproveAccounts={canApproveAccounts}
                    canAdjustQuotas={canAdjustQuotas}
                    onReload={reloadAll}
                    onError={setError}
                  />
                )}
                {effectiveTab === 'teachers' && canViewAccounts && (
                  <AdminTeachersTab
                    teachers={teachers}
                    currentUser={user}
                    onReload={reloadAll}
                    onError={setError}
                  />
                )}
                {effectiveTab === 'settings' && (canManageSettings || canManageUpdates) && (
                  <AdminSettingsTab
                    settings={settings}
                    canManageSettings={canManageSettings}
                    canManageUpdates={canManageUpdates}
                    isDevMode={Boolean(authMode?.dev_mode)}
                    onReload={reloadAll}
                    onError={setError}
                  />
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
