import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { I18nProvider, useI18n } from './i18n';
import { Header, type ActiveTab } from './components/Header';
import { usePrintNotifications } from './hooks/usePrintNotifications';
import { AuthPage } from './pages/AuthPage';
import { StudentWorkspace } from './pages/StudentWorkspace';
import { MyPrintsPage } from './pages/MyPrintsPage';
import { AdminDashboard } from './pages/AdminDashboard';
import type { JobDetail } from './types/api';

function PortalShell() {
  const { user, loading } = useAuth();
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<ActiveTab>('print');
  const [draftToLoad, setDraftToLoad] = useState<JobDetail | null>(null);
  const [deletedDraftSignal, setDeletedDraftSignal] = useState<{
    target: number | 'all';
    seq: number;
  } | null>(null);

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

  if (loading) {
    return (
      <div className="flex min-h-screen min-h-[100dvh] items-center justify-center bg-[#F6F7F9] dark:bg-[#0D0E11]">
        <div className="flex items-center gap-2.5 text-sm font-medium text-[#5B616E] dark:text-[#9399A6]">
          <Loader2 className="h-4 w-4 animate-spin text-[#00A7D9]" />
          <span>{t.common.loading}</span>
        </div>
      </div>
    );
  }

  if (!user) {
    return <AuthPage />;
  }

  const isStaff = user.role === 'admin' || user.role === 'teacher';
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
