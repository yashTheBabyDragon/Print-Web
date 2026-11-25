import { useEffect, useState } from 'react';
import { Bell, LogOut, Menu, Moon, Sun, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useI18n } from '../i18n';
import { Logo } from './Logo';
import { NotificationSettingsModal } from './NotificationSettingsModal';

export type ActiveTab = 'print' | 'my-prints' | 'admin';

interface HeaderProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
}

export function Header({ activeTab, onSelectTab }: HeaderProps) {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { lang, toggleLang, t } = useI18n();
  const [notifModalOpen, setNotifModalOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    if (!mobileMenuOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMobileMenuOpen(false);
      }
    };

    const mediaQuery = window.matchMedia('(min-width: 768px)');
    const handleMediaChange = (event: MediaQueryListEvent) => {
      if (event.matches) {
        setMobileMenuOpen(false);
      }
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);
    mediaQuery.addEventListener('change', handleMediaChange);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
      mediaQuery.removeEventListener('change', handleMediaChange);
    };
  }, [mobileMenuOpen]);

  if (!user) return null;

  const hasNotificationsEnabled = Boolean(user.notify_browser || user.notify_webhook_url);

  const isStaff = user.role === 'admin' || user.role === 'teacher';
  const used = Number(user.active_grams_used ?? 0);
  const max = Number(user.effective_max_active_grams ?? 100);
  const ratio = max > 0 ? Math.min(1, used / max) : 0;

  const barColor =
    ratio >= 1
      ? 'bg-rose-500'
      : ratio >= 0.8
        ? 'bg-amber-500'
        : 'bg-[#00A7D9]';

  const roleOrDaLabel =
    user.role === 'admin'
      ? t.nav.roleAdmin
      : user.role === 'teacher'
        ? t.nav.roleTeacher
        : user.da;

  const handleSelectTab = (tab: ActiveTab) => {
    onSelectTab(tab);
    setMobileMenuOpen(false);
  };

  const handleOpenNotifications = () => {
    setMobileMenuOpen(false);
    setNotifModalOpen(true);
  };

  const handleLogout = () => {
    setMobileMenuOpen(false);
    logout();
  };

  return (
    <>
      <header className="sticky top-0 z-40 h-14 border-b border-black/[0.07] bg-white/80 backdrop-blur-md dark:border-white/[0.08] dark:bg-[#0D0E11]/80">
        <div className="mx-auto flex h-full max-w-[1680px] items-center justify-between gap-2 px-3 sm:gap-3 sm:px-6">
          {/* Brand */}
          <button
            type="button"
            onClick={() => handleSelectTab('print')}
            className="flex min-h-[44px] shrink-0 items-center gap-2.5 text-left transition-opacity hover:opacity-80 md:min-h-0"
          >
            <Logo size={26} />
            <div className="flex items-baseline gap-2">
              <span className="text-[15px] font-semibold tracking-tight text-[#111318] dark:text-[#F4F5F7]">
                {t.common.appName}
              </span>
              <span className="hidden text-xs text-[#5B616E] dark:text-[#9399A6] xl:inline">
                {t.common.institution}
              </span>
            </div>
          </button>

          {/* Desktop & Tablet Segmented Primary Navigation */}
          <nav
            aria-label="Navigation"
            className="hidden items-center rounded-full bg-[#EFEFF3] p-0.5 dark:bg-[#1D2027] md:flex"
          >
            <button
              type="button"
              onClick={() => handleSelectTab('print')}
              className={`whitespace-nowrap rounded-full px-3.5 py-1 text-[13px] font-medium transition-colors ${
                activeTab === 'print'
                  ? 'bg-white text-[#111318] shadow-sm dark:bg-[#2B2F3A] dark:text-white'
                  : 'text-[#5B616E] hover:text-[#111318] dark:text-[#9399A6] dark:hover:text-[#F4F5F7]'
              }`}
            >
              {t.nav.print}
            </button>
            <button
              type="button"
              onClick={() => handleSelectTab('my-prints')}
              className={`whitespace-nowrap rounded-full px-3.5 py-1 text-[13px] font-medium transition-colors ${
                activeTab === 'my-prints'
                  ? 'bg-white text-[#111318] shadow-sm dark:bg-[#2B2F3A] dark:text-white'
                  : 'text-[#5B616E] hover:text-[#111318] dark:text-[#9399A6] dark:hover:text-[#F4F5F7]'
              }`}
            >
              {t.nav.myPrints}
            </button>
            {isStaff && (
              <button
                type="button"
                onClick={() => handleSelectTab('admin')}
                className={`whitespace-nowrap rounded-full px-3.5 py-1 text-[13px] font-medium transition-colors ${
                  activeTab === 'admin'
                    ? 'bg-white text-[#111318] shadow-sm dark:bg-[#2B2F3A] dark:text-white'
                    : 'text-[#5B616E] hover:text-[#111318] dark:text-[#9399A6] dark:hover:text-[#F4F5F7]'
                }`}
              >
                {t.nav.admin}
              </button>
            )}
          </nav>

          {/* Desktop & Tablet Right Utility Strip */}
          <div className="hidden items-center gap-1.5 md:flex lg:gap-2.5">
            {/* Active Weight Budget Readout */}
            <button
              type="button"
              onClick={() => handleSelectTab('my-prints')}
              title={t.nav.budgetTooltip}
              className="group hidden flex-col items-end rounded-lg px-2 py-1 transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05] lg:flex"
            >
              <div className="flex items-center gap-1.5 text-xs tabular-nums">
                <span className="text-[#5B616E] dark:text-[#9399A6]">{t.nav.activeBudget}</span>
                <span className="font-mono font-semibold text-[#111318] dark:text-[#F4F5F7]">
                  {used.toFixed(1)} / {max.toFixed(0)} {t.common.grams}
                </span>
              </div>
              <div className="mt-1 h-[3px] w-28 overflow-hidden rounded-full bg-black/[0.08] dark:bg-white/[0.1]">
                <div
                  className={`h-full rounded-full transition-[width] duration-200 ${barColor}`}
                  style={{ width: `${Math.round(ratio * 100)}%` }}
                />
              </div>
            </button>

            <div className="hidden h-4 w-px bg-black/[0.08] dark:bg-white/[0.1] lg:block" />

            {/* Notifications Settings (all users) */}
            <button
              type="button"
              onClick={handleOpenNotifications}
              title={t.notifications.buttonTooltip}
              aria-label={t.notifications.buttonTooltip}
              className="btn-ghost relative p-1.5"
            >
              <Bell className="h-4 w-4" />
              {hasNotificationsEnabled && (
                <span
                  aria-hidden="true"
                  className="absolute right-1 top-1 h-2 w-2 rounded-full bg-[#00A7D9] ring-2 ring-white dark:ring-[#0D0E11]"
                />
              )}
            </button>

            {/* FR / EN Toggle */}
            <button
              type="button"
              onClick={toggleLang}
              title={t.common.languageToggleTooltip}
              className="btn-ghost px-2 py-1 font-mono text-xs"
            >
              {lang.toUpperCase()}
            </button>

            {/* Light / Dark Toggle */}
            <button
              type="button"
              onClick={toggleTheme}
              title={theme === 'dark' ? t.common.lightMode : t.common.darkMode}
              aria-label={theme === 'dark' ? t.common.lightMode : t.common.darkMode}
              className="btn-ghost p-1.5"
            >
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>

            {/* User Identity + Logout */}
            <div className="flex items-center gap-2 pl-1">
              <div className="hidden text-right lg:block">
                <div className="text-xs font-medium leading-tight text-[#111318] dark:text-[#F4F5F7]">
                  {user.name}
                </div>
                <div className="font-mono text-[11px] tabular-nums text-[#5B616E] dark:text-[#9399A6]">
                  {roleOrDaLabel}
                </div>
              </div>
              <button
                type="button"
                onClick={handleLogout}
                title={t.common.logout}
                aria-label={t.common.logout}
                className="btn-ghost p-1.5 hover:text-rose-600 dark:hover:text-rose-400"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Mobile Labeled Menu Button */}
          <div className="flex items-center gap-1 md:hidden">
            <button
              type="button"
              onClick={() => setMobileMenuOpen((prev) => !prev)}
              aria-expanded={mobileMenuOpen}
              aria-controls="mobile-nav-drawer"
              aria-label={mobileMenuOpen ? t.nav.closeMenu : t.nav.openMenu}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-black/[0.09] bg-[#F6F7F9] px-3 py-2 text-sm font-medium text-[#111318] transition-colors active:bg-black/[0.06] dark:border-white/[0.1] dark:bg-[#1D2027] dark:text-[#F4F5F7] dark:active:bg-white/[0.08]"
            >
              {mobileMenuOpen ? (
                <X className="h-4 w-4 shrink-0" />
              ) : (
                <Menu className="h-4 w-4 shrink-0" />
              )}
              <span>{mobileMenuOpen ? t.common.close : t.nav.menu}</span>
            </button>
          </div>
        </div>
      </header>

      {/* Mobile Navigation Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 top-14 z-50 md:hidden" id="mobile-nav-drawer">
          <div
            aria-hidden="true"
            onClick={() => setMobileMenuOpen(false)}
            className="absolute inset-0 bg-black/45 backdrop-blur-[2px]"
          />
          <div
            role="region"
            aria-label={t.nav.menu}
            className="relative max-h-[calc(100dvh-3.5rem)] overflow-y-auto border-b border-black/[0.08] bg-white px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4 shadow-xl dark:border-white/[0.09] dark:bg-[#15171C]"
          >
            {/* User Identity & Active Budget Card */}
            <button
              type="button"
              onClick={() => handleSelectTab('my-prints')}
              className="mb-4 block w-full rounded-xl border border-black/[0.08] bg-[#F6F7F9] p-3.5 text-left transition-colors active:bg-black/[0.04] dark:border-white/[0.08] dark:bg-[#0D0E11]"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-[#111318] dark:text-[#F4F5F7]">
                    {user.name}
                  </div>
                  <div className="font-mono text-xs tabular-nums text-[#5B616E] dark:text-[#9399A6]">
                    {roleOrDaLabel}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                    {t.nav.activeBudget}
                  </div>
                  <div className="font-mono text-xs font-semibold tabular-nums text-[#111318] dark:text-[#F4F5F7]">
                    {used.toFixed(1)} / {max.toFixed(0)} {t.common.grams}
                  </div>
                </div>
              </div>
              <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-black/[0.08] dark:bg-white/[0.1]">
                <div
                  className={`h-full rounded-full transition-[width] duration-200 ${barColor}`}
                  style={{ width: `${Math.round(ratio * 100)}%` }}
                />
              </div>
            </button>

            {/* Primary Navigation Links */}
            <nav aria-label="Navigation" className="space-y-1.5">
              <button
                type="button"
                onClick={() => handleSelectTab('print')}
                className={`flex min-h-[44px] w-full items-center justify-between rounded-xl px-3.5 py-2.5 text-left text-sm font-medium transition-colors ${
                  activeTab === 'print'
                    ? 'bg-[#00A7D9]/[0.12] text-[#007BA3] dark:bg-[#00A7D9]/[0.18] dark:text-[#38C6F4]'
                    : 'text-[#111318] hover:bg-black/[0.04] dark:text-[#F4F5F7] dark:hover:bg-white/[0.06]'
                }`}
              >
                <span>{t.nav.print}</span>
              </button>
              <button
                type="button"
                onClick={() => handleSelectTab('my-prints')}
                className={`flex min-h-[44px] w-full items-center justify-between rounded-xl px-3.5 py-2.5 text-left text-sm font-medium transition-colors ${
                  activeTab === 'my-prints'
                    ? 'bg-[#00A7D9]/[0.12] text-[#007BA3] dark:bg-[#00A7D9]/[0.18] dark:text-[#38C6F4]'
                    : 'text-[#111318] hover:bg-black/[0.04] dark:text-[#F4F5F7] dark:hover:bg-white/[0.06]'
                }`}
              >
                <span>{t.nav.myPrints}</span>
              </button>
              {isStaff && (
                <button
                  type="button"
                  onClick={() => handleSelectTab('admin')}
                  className={`flex min-h-[44px] w-full items-center justify-between rounded-xl px-3.5 py-2.5 text-left text-sm font-medium transition-colors ${
                    activeTab === 'admin'
                      ? 'bg-[#00A7D9]/[0.12] text-[#007BA3] dark:bg-[#00A7D9]/[0.18] dark:text-[#38C6F4]'
                      : 'text-[#111318] hover:bg-black/[0.04] dark:text-[#F4F5F7] dark:hover:bg-white/[0.06]'
                  }`}
                >
                  <span>{t.nav.admin}</span>
                </button>
              )}
            </nav>

            <div className="my-3.5 h-px bg-black/[0.08] dark:bg-white/[0.09]" />

            {/* Preferences & Account Actions */}
            <div className="space-y-1.5">
              <button
                type="button"
                onClick={handleOpenNotifications}
                className="flex min-h-[44px] w-full items-center justify-between rounded-xl px-3.5 py-2.5 text-left text-sm font-medium text-[#111318] transition-colors hover:bg-black/[0.04] dark:text-[#F4F5F7] dark:hover:bg-white/[0.06]"
              >
                <span className="flex items-center gap-2.5">
                  <Bell className="h-4 w-4 text-[#5B616E] dark:text-[#9399A6]" />
                  <span>{t.notifications.buttonTooltip}</span>
                </span>
                {hasNotificationsEnabled && (
                  <span
                    aria-hidden="true"
                    className="h-2.5 w-2.5 shrink-0 rounded-full bg-[#00A7D9]"
                  />
                )}
              </button>

              <div className="grid grid-cols-2 gap-2 pt-1">
                <button
                  type="button"
                  onClick={toggleLang}
                  className="btn-secondary w-full justify-center px-3 py-2 text-xs font-mono"
                >
                  {lang.toUpperCase()} · {lang === 'fr' ? 'EN' : 'FR'}
                </button>
                <button
                  type="button"
                  onClick={toggleTheme}
                  className="btn-secondary w-full justify-center px-3 py-2 text-xs"
                >
                  {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                  <span>{theme === 'dark' ? t.common.lightMode : t.common.darkMode}</span>
                </button>
              </div>

              <button
                type="button"
                onClick={handleLogout}
                className="mt-1 flex min-h-[44px] w-full items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-left text-sm font-medium text-rose-600 transition-colors hover:bg-rose-500/10 dark:text-rose-400"
              >
                <LogOut className="h-4 w-4 shrink-0" />
                <span>{t.common.logout}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      <NotificationSettingsModal
        open={notifModalOpen}
        onClose={() => setNotifModalOpen(false)}
      />
    </>
  );
}
