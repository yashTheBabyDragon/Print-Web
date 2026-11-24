import { LogOut, Moon, Sun } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useI18n } from '../i18n';
import { Logo } from './Logo';

export type ActiveTab = 'print' | 'my-prints' | 'admin';

interface HeaderProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
}

export function Header({ activeTab, onSelectTab }: HeaderProps) {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { lang, toggleLang, t } = useI18n();

  if (!user) return null;

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

  return (
    <header className="sticky top-0 z-40 h-14 border-b border-black/[0.07] bg-white/80 backdrop-blur-md dark:border-white/[0.08] dark:bg-[#0D0E11]/80">
      <div className="mx-auto flex h-full max-w-[1680px] items-center justify-between gap-3 px-4 sm:px-6">
        {/* Brand */}
        <button
          type="button"
          onClick={() => onSelectTab('print')}
          className="flex items-center gap-2.5 text-left transition-opacity hover:opacity-80"
        >
          <Logo size={26} />
          <div className="flex items-baseline gap-2">
            <span className="text-[15px] font-semibold tracking-tight text-[#111318] dark:text-[#F4F5F7]">
              {t.common.appName}
            </span>
            <span className="hidden text-xs text-[#5B616E] dark:text-[#9399A6] sm:inline">
              {t.common.institution}
            </span>
          </div>
        </button>

        {/* Segmented Primary Navigation */}
        <nav
          aria-label="Navigation"
          className="flex items-center rounded-full bg-[#EFEFF3] p-0.5 dark:bg-[#1D2027]"
        >
          <button
            type="button"
            onClick={() => onSelectTab('print')}
            className={`rounded-full px-3.5 py-1 text-[13px] font-medium transition-colors ${
              activeTab === 'print'
                ? 'bg-white text-[#111318] shadow-sm dark:bg-[#2B2F3A] dark:text-white'
                : 'text-[#5B616E] hover:text-[#111318] dark:text-[#9399A6] dark:hover:text-[#F4F5F7]'
            }`}
          >
            {t.nav.print}
          </button>
          <button
            type="button"
            onClick={() => onSelectTab('my-prints')}
            className={`rounded-full px-3.5 py-1 text-[13px] font-medium transition-colors ${
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
              onClick={() => onSelectTab('admin')}
              className={`rounded-full px-3.5 py-1 text-[13px] font-medium transition-colors ${
                activeTab === 'admin'
                  ? 'bg-white text-[#111318] shadow-sm dark:bg-[#2B2F3A] dark:text-white'
                  : 'text-[#5B616E] hover:text-[#111318] dark:text-[#9399A6] dark:hover:text-[#F4F5F7]'
              }`}
            >
              {t.nav.admin}
            </button>
          )}
        </nav>

        {/* Right Utility Strip */}
        <div className="flex items-center gap-1.5 sm:gap-2.5">
          {/* Active Weight Budget Readout */}
          <button
            type="button"
            onClick={() => onSelectTab('my-prints')}
            title={t.nav.budgetTooltip}
            className="group hidden flex-col items-end rounded-lg px-2 py-1 transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05] sm:flex"
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

          <div className="hidden h-4 w-px bg-black/[0.08] dark:bg-white/[0.1] sm:block" />

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
            <div className="hidden text-right md:block">
              <div className="text-xs font-medium leading-tight text-[#111318] dark:text-[#F4F5F7]">
                {user.name}
              </div>
              <div className="font-mono text-[11px] tabular-nums text-[#5B616E] dark:text-[#9399A6]">
                {user.role === 'admin'
                  ? t.nav.roleAdmin
                  : user.role === 'teacher'
                    ? t.nav.roleTeacher
                    : user.da}
              </div>
            </div>
            <button
              type="button"
              onClick={logout}
              title={t.common.logout}
              aria-label={t.common.logout}
              className="btn-ghost p-1.5 hover:text-rose-600 dark:hover:text-rose-400"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
