import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api, setStoredToken } from './api/client';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { I18nProvider, useI18n } from './i18n';
import { Header, type ActiveTab } from './components/Header';
import { usePrintNotifications } from './hooks/usePrintNotifications';
import { AuthPage } from './pages/AuthPage';
import { StudentWorkspace } from './pages/StudentWorkspace';
import { canAccessStaffPortal } from './utils/permissions';
import type { AuthResponse, JobDetail } from './types/api';

const MyPrintsPage = lazy(() =>
  import('./pages/MyPrintsPage').then((m) => ({ default: m.MyPrintsPage }))
);
const AdminDashboard = lazy(() =>
  import('./pages/AdminDashboard').then((m) => ({ default: m.AdminDashboard }))
);
const SetupWizardPage = lazy(() => import('./pages/SetupWizardPage'));

function getInitialSetupState(): { requested: boolean; token: string | null } {
  if (typeof window === 'undefined') {
    return { requested: false, token: null };
  }
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  const isSetupPath = window.location.pathname.startsWith('/setup');
  return {
    requested: isSetupPath || Boolean(token),
    token: token || null,
  };
}

function FullscreenLoader({ label }: { label: string }) {
  return (
    <div className="flex min-h-screen min-h-[100dvh] items-center justify-center bg-[#F6F7F9] dark:bg-[#0D0E11]">
      <div className="flex items-center gap-2.5 text-sm font-medium text-[#5B616E] dark:text-[#9399A6]">
        <Loader2 className="h-4 w-4 animate-spin text-[#00A7D9]" />
        <span>{label}</span>
      </div>
    </div>
  );
}

function PortalShell() {
  const { user, authMode, loading, setUser } = useAuth();
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<ActiveTab>('print');
  const [draftToLoad, setDraftToLoad] = useState<JobDetail | null>(null);
  const [deletedDraftSignal, setDeletedDraftSignal] = useState<{
    target: number | 'all';
    seq: number;
  } | null>(null);
  const [setupRoute, setSetupRoute] = useState(getInitialSetupState);
  const [setupDismissed, setSetupDismissed] = useState(false);

  usePrintNotifications(() => setActiveTab('my-prints'));

  // Reset navigation and draft handoff state whenever user logs out or switches
  useEffect(() => {
    setActiveTab('print');
    setDraftToLoad(null);
    setDeletedDraftSignal(null);
  }, [user?.id]);

  const handleLoadDraft = useCallback((job: JobDetail) => {
    setDraftToLoad(job);
    setActiveTab('print');
  }, []);

  const handleDraftLoaded = useCallback(() => {
    setDraftToLoad(null);
  }, []);

  const handleDraftDeleted = useCallback((target: number | 'all') => {
    setDeletedDraftSignal((prev) => ({ target, seq: (prev?.seq ?? 0) + 1 }));
  }, []);

  const clearSetupUrl = useCallback(() => {
    if (
      typeof window !== 'undefined' &&
      (window.location.pathname.startsWith('/setup') || window.location.search.includes('token='))
    ) {
      window.history.replaceState({}, '', '/');
    }
    setSetupRoute({ requested: false, token: null });
    setSetupDismissed(true);
  }, []);

  const handleSetupCompleted = useCallback(
    async (auth: AuthResponse) => {
      setStoredToken(auth.access_token);
      setUser(auth.user);
      await api.getAuthMode().catch(() => null);
      clearSetupUrl();
    },
    [setUser, clearSetupUrl]
  );

  if (loading) {
    return <FullscreenLoader label={t.common.loading} />;
  }

  const shouldShowSetup =
    !setupDismissed && (setupRoute.requested || authMode?.needs_setup === true);

  if (shouldShowSetup) {
    return (
      <Suspense fallback={<FullscreenLoader label={t.common.loading} />}>
        <SetupWizardPage
          setupToken={setupRoute.token}
          onCompleted={(auth) => void handleSetupCompleted(auth)}
          onExitSetup={clearSetupUrl}
        />
      </Suspense>
    );
  }

  if (!user) {
    return <AuthPage />;
  }

  const isStaff = canAccessStaffPortal(user);
  const effectiveTab: ActiveTab =
    activeTab === 'admin' && !isStaff ? 'print' : activeTab;

  return (
    <div className="flex min-h-screen min-h-[100dvh] flex-col bg-[#F6F7F9] text-[#111318] dark:bg-[#0D0E11] dark:text-[#F4F5F7]">
      <Header activeTab={effectiveTab} onSelectTab={setActiveTab} />
      <main className="flex-1 pb-[env(safe-area-inset-bottom)]">
        <div className={effectiveTab === 'print' ? 'block' : 'hidden'}>
          <StudentWorkspace
            key={user.id}
            isVisible={effectiveTab === 'print'}
            onNavigateMyPrints={() => setActiveTab('my-prints')}
            draftToLoad={draftToLoad}
            onDraftLoaded={handleDraftLoaded}
            deletedDraftSignal={deletedDraftSignal}
          />
        </div>
        <Suspense fallback={<FullscreenLoader label={t.common.loading} />}>
          {effectiveTab === 'my-prints' && (
            <MyPrintsPage
              onGoToPrint={() => setActiveTab('print')}
              onLoadDraft={handleLoadDraft}
              onDraftDeleted={handleDraftDeleted}
            />
          )}
          {effectiveTab === 'admin' && isStaff && (
            <AdminDashboard onGoToPrint={() => setActiveTab('print')} />
          )}
        </Suspense>
      </main>
    </div>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <I18nProvider>
        <AuthProvider>
          <PortalShell />
        </AuthProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}

export default App;
