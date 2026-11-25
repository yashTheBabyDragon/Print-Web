import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  GraduationCap,
  Loader2,
  Monitor,
  Palette,
  Printer,
  Settings,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useI18n } from '../i18n';
import type {
  AdminPrinter,
  AdminTeacher,
  ApprovalsResponse,
  Filament,
  FilamentApiPrinter,
  OrcaProfile,
  PendingAccountRequest,
  StudentAccount,
  SystemSettings,
  TeacherClass,
} from '../types/api';
import { translateApiError } from '../utils/errors';
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
  const { user } = useAuth();
  const { t } = useI18n();
  const isSuperAdmin = user?.role === 'admin';

  const [tab, setTab] = useState<AdminTabId>('printers');
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

  const reloadAll = useCallback(async () => {
    setError(null);
    try {
      const [p, f, pr, cl, st, ap, ar, te, se, fap] = await Promise.all([
        api.adminGetPrinters(),
        api.adminGetFilaments(),
        api.adminGetProfiles(),
        api.adminGetClasses(),
        api.adminGetStudents(),
        api.adminGetApprovals(),
        api.adminGetAccountRequests(),
        isSuperAdmin ? api.adminGetTeachers() : Promise.resolve<AdminTeacher[]>([]),
        isSuperAdmin ? api.adminGetSettings() : Promise.resolve<SystemSettings | null>(null),
        api.adminGetFilamentApiPrinters().catch(() => [] as FilamentApiPrinter[]),
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
    } catch (err) {
      setError(translateApiError(err, t));
    } finally {
      setLoading(false);
    }
  }, [isSuperAdmin, t]);

  useEffect(() => {
    reloadAll();
  }, [reloadAll]);

  useEffect(() => {
    if (!isSuperAdmin && (tab === 'teachers' || tab === 'settings')) {
      setTab('printers');
    }
  }, [isSuperAdmin, tab]);

  const pendingApprovalsCount = approvals.pending.length + accountRequests.length;

  const tabs: Array<{ id: AdminTabId; label: string; icon: typeof Printer; badge?: number }> = [
    { id: 'printers', label: t.admin.tabs.printers, icon: Printer },
    { id: 'filaments', label: t.admin.tabs.filaments, icon: Palette },
    { id: 'students', label: t.admin.tabs.students, icon: Users },
    {
      id: 'approvals',
      label: t.admin.tabs.approvals,
      icon: ShieldCheck,
      badge: pendingApprovalsCount,
    },
    ...(isSuperAdmin
      ? [
          { id: 'teachers' as const, label: t.admin.tabs.teachers, icon: GraduationCap },
          { id: 'settings' as const, label: t.admin.tabs.settings, icon: Settings },
        ]
      : []),
  ];

  const effectiveTab: AdminTabId =
    !isSuperAdmin && (tab === 'teachers' || tab === 'settings') ? 'printers' : tab;

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

      {/* Tablet & Desktop (>=768px): Full Admin Dashboard */}
      <div className="mx-auto hidden max-w-[1440px] px-4 py-8 sm:px-6 md:block">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight text-[#111318] dark:text-[#F4F5F7]">
            {t.admin.title}
          </h1>
          <p className="mt-1 text-sm text-[#5B616E] dark:text-[#9399A6]">{t.admin.subtitle}</p>
        </div>

        <div className="flex flex-col gap-6 lg:flex-row">
          {/* Apple / Antigravity Left Rail (collapses to horizontal strip on tablet) */}
          <nav
            aria-label={t.admin.title}
            className="flex shrink-0 gap-1 overflow-x-auto pb-1 lg:w-56 lg:flex-col lg:pb-0"
          >
            {tabs.map((item) => {
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
                {effectiveTab === 'printers' && (
                  <AdminPrintersTab
                    printers={printers}
                    filaments={filaments}
                    profiles={profiles}
                    filamentApiEnabled={settings?.filament_api_enabled ?? filamentApiPrinters.length > 0}
                    filamentApiPrinters={filamentApiPrinters}
                    onReload={reloadAll}
                    onError={setError}
                  />
                )}
                {effectiveTab === 'filaments' && (
                  <AdminFilamentsProfilesTab
                    filaments={filaments}
                    profiles={profiles}
                    onReload={reloadAll}
                    onError={setError}
                  />
                )}
                {effectiveTab === 'students' && (
                  <AdminStudentsTab
                    classes={classes}
                    teachers={teachers}
                    students={students}
                    isSuperAdmin={isSuperAdmin}
                    onReload={reloadAll}
                    onError={setError}
                  />
                )}
                {effectiveTab === 'approvals' && (
                  <AdminApprovalsTab
                    approvals={approvals}
                    accountRequests={accountRequests}
                    classes={classes}
                    isSuperAdmin={isSuperAdmin}
                    onReload={reloadAll}
                    onError={setError}
                  />
                )}
                {effectiveTab === 'teachers' && isSuperAdmin && (
                  <AdminTeachersTab
                    teachers={teachers}
                    onReload={reloadAll}
                    onError={setError}
                  />
                )}
                {effectiveTab === 'settings' && isSuperAdmin && (
                  <AdminSettingsTab
                    settings={settings}
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
