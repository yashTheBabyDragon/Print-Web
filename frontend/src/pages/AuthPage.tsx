import React, { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Clock, Moon, Sun } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useI18n } from '../i18n';
import { Logo } from '../components/Logo';
import type { CheckDaResponse, TeacherPublic } from '../types/api';
import { translateApiError } from '../utils/errors';

export function AuthPage() {
  const { authMode, login, register } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { lang, toggleLang, t } = useI18n();

  const [tab, setTab] = useState<'login' | 'register'>('login');
  const [identifier, setIdentifier] = useState('');
  const [da, setDa] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [selectedTeacherId, setSelectedTeacherId] = useState<string>('');

  const [teachers, setTeachers] = useState<TeacherPublic[]>([]);
  const [daCheck, setDaCheck] = useState<CheckDaResponse | null>(null);
  const [checkingDa, setCheckingDa] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingConfirmationTeacher, setPendingConfirmationTeacher] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api
      .getPublicTeachers()
      .then((list) => {
        if (active) setTeachers(list);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (tab !== 'register' || !/^\d{7}$/.test(da)) {
      setDaCheck(null);
      setCheckingDa(false);
      return;
    }

    let cancelled = false;
    setCheckingDa(true);
    const timer = window.setTimeout(async () => {
      try {
        const res = await api.checkDa(da);
        if (cancelled) return;
        setDaCheck(res);
        if (res.in_roster && !res.is_registered && res.suggested_name) {
          setName((prev) => (prev.trim() === '' ? res.suggested_name || '' : prev));
        }
      } catch {
        if (!cancelled) setDaCheck(null);
      } finally {
        if (!cancelled) setCheckingDa(false);
      }
    }, 150);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [tab, da]);

  const needsTeacherSelect =
    tab === 'register' && daCheck != null && !daCheck.in_roster && !daCheck.is_registered;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setPendingConfirmationTeacher(null);

    if (tab === 'login') {
      const cleanId = identifier.trim();
      if (!cleanId) {
        setError(t.errors.invalidIdentifier);
        return;
      }
      if (password.length < 1) {
        setError(t.errors.invalidPassword);
        return;
      }

      setSubmitting(true);
      try {
        await login(cleanId, password);
      } catch (err) {
        setError(translateApiError(err, t));
      } finally {
        setSubmitting(false);
      }
      return;
    }

    const cleanDa = da.trim();
    if (!/^\d{7}$/.test(cleanDa)) {
      setError(t.errors.invalidDa);
      return;
    }
    if (name.trim().length < 2) {
      setError(t.errors.invalidName);
      return;
    }
    if (password.length < 4) {
      setError(t.errors.invalidPassword);
      return;
    }

    const teacherIdNum = selectedTeacherId ? Number(selectedTeacherId) : null;
    if (needsTeacherSelect && !teacherIdNum) {
      setError(t.errors.TEACHER_REQUIRED);
      return;
    }

    setSubmitting(true);
    try {
      const res = await register(cleanDa, name.trim(), password, teacherIdNum);
      if (res.pending_approval) {
        const chosenTeacher =
          res.requested_teacher_name ||
          teachers.find((tc) => tc.id === teacherIdNum)?.name ||
          t.auth.yourTeacherFallback;
        setDa('');
        setName('');
        setPassword('');
        setSelectedTeacherId('');
        setDaCheck(null);
        setPendingConfirmationTeacher(chosenTeacher);
      }
    } catch (err) {
      setError(translateApiError(err, t));
    } finally {
      setSubmitting(false);
    }
  };

  const quickFillAdmin = () => {
    setTab('login');
    setIdentifier('admin');
    setPassword('admin123');
    setError(null);
    setPendingConfirmationTeacher(null);
  };

  const quickFillTeacher = () => {
    setTab('login');
    setIdentifier('m.tremblay@cgodin.qc.ca');
    setPassword('teacher123');
    setError(null);
    setPendingConfirmationTeacher(null);
  };

  const quickFillStudent = () => {
    setTab('login');
    setIdentifier('2345678');
    setPassword('student123');
    setError(null);
    setPendingConfirmationTeacher(null);
  };

  const quickFillRegister = () => {
    setTab('register');
    setDa('2333572');
    setName('');
    setPassword('secret123');
    setSelectedTeacherId('');
    setError(null);
    setPendingConfirmationTeacher(null);
  };

  return (
    <div className="flex min-h-screen min-h-[100dvh] flex-col bg-[#F6F7F9] text-[#111318] dark:bg-[#0D0E11] dark:text-[#F4F5F7]">
      {/* Minimal Top Utility Bar */}
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-3 sm:px-6 sm:py-5">
        <div className="flex items-center gap-2.5">
          <Logo size={26} />
          <span className="text-[15px] font-semibold tracking-tight">{t.common.appName}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={toggleLang}
            title={t.common.languageToggleTooltip}
            className="btn-ghost px-2.5 py-1 font-mono text-xs"
          >
            {lang.toUpperCase()}
          </button>
          <button
            type="button"
            onClick={toggleTheme}
            title={theme === 'dark' ? t.common.lightMode : t.common.darkMode}
            aria-label={theme === 'dark' ? t.common.lightMode : t.common.darkMode}
            className="btn-ghost p-1.5"
          >
            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {/* Main Split Studio Auth */}
      <div className="mx-auto flex w-full max-w-5xl flex-1 items-start px-4 pb-[max(2.5rem,env(safe-area-inset-bottom))] pt-2 sm:items-center sm:px-6 sm:pb-14 sm:pt-4">
        <div className="grid w-full grid-cols-1 items-center gap-6 sm:gap-8 lg:grid-cols-12 lg:gap-14">
          {/* Left Narrative */}
          <div className="space-y-4 sm:space-y-6 lg:col-span-6">
            <div className="space-y-2 sm:space-y-3">
              <p className="text-xs font-medium text-[#007BA3] dark:text-[#38C6F4] sm:text-sm">
                {t.common.institution}
              </p>
              <h1 className="text-2xl font-semibold tracking-tight text-[#111318] dark:text-[#F4F5F7] sm:text-3xl lg:text-4xl">
                {t.auth.title}
              </h1>
              <p className="max-w-md text-sm leading-relaxed text-[#5B616E] dark:text-[#9399A6] sm:text-[15px]">
                {t.auth.subtitle}
              </p>
            </div>

            {/* Quiet Dev Quick-Fill Strip when dev_mode is true */}
            {authMode?.dev_mode && (
              <div className="border-t border-black/[0.08] pt-4 sm:pt-5 dark:border-white/[0.08]">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
                    {t.auth.devSandboxTitle} · {t.auth.devSandboxDesc}
                  </span>
                  <span className="font-mono text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                    {authMode.slicer_mode} / {authMode.fdm_mode}
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={quickFillStudent}
                    className="btn-secondary px-3 py-1.5 font-mono text-xs"
                  >
                    {t.auth.devStudentBtn}
                  </button>
                  <button
                    type="button"
                    onClick={quickFillTeacher}
                    className="btn-secondary px-3 py-1.5 font-mono text-xs"
                  >
                    {t.auth.devTeacherBtn}
                  </button>
                  <button
                    type="button"
                    onClick={quickFillAdmin}
                    className="btn-secondary px-3 py-1.5 font-mono text-xs"
                  >
                    {t.auth.devAdminBtn}
                  </button>
                  <button
                    type="button"
                    onClick={quickFillRegister}
                    className="btn-secondary px-3 py-1.5 font-mono text-xs text-[#007BA3] dark:text-[#38C6F4]"
                  >
                    {t.auth.devUnclaimedBtn}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Right Form Surface */}
          <div className="lg:col-span-6">
            <div className="studio-surface mx-auto w-full max-w-md p-5 sm:p-8">
              {/* Segmented Control */}
              <div className="mb-5 grid grid-cols-2 rounded-full bg-[#EFEFF3] p-1 dark:bg-[#1D2027] sm:mb-6">
                <button
                  type="button"
                  onClick={() => {
                    setTab('login');
                    setError(null);
                    setPendingConfirmationTeacher(null);
                  }}
                  className={`min-h-[44px] rounded-full py-2 text-sm font-medium transition-colors sm:min-h-0 sm:py-1.5 ${
                    tab === 'login'
                      ? 'bg-white text-[#111318] shadow-sm dark:bg-[#2B2F3A] dark:text-white'
                      : 'text-[#5B616E] hover:text-[#111318] dark:text-[#9399A6] dark:hover:text-[#F4F5F7]'
                  }`}
                >
                  {t.auth.loginTab}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTab('register');
                    setError(null);
                    setPendingConfirmationTeacher(null);
                  }}
                  className={`min-h-[44px] rounded-full py-2 text-sm font-medium transition-colors sm:min-h-0 sm:py-1.5 ${
                    tab === 'register'
                      ? 'bg-white text-[#111318] shadow-sm dark:bg-[#2B2F3A] dark:text-white'
                      : 'text-[#5B616E] hover:text-[#111318] dark:text-[#9399A6] dark:hover:text-[#F4F5F7]'
                  }`}
                >
                  {t.auth.registerTab}
                </button>
              </div>

              {error && (
                <div className="mb-5 flex items-start gap-2.5 rounded-xl bg-rose-500/10 px-3.5 py-2.5 text-sm text-rose-700 dark:text-rose-300">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              {pendingConfirmationTeacher ? (
                <div className="space-y-4 rounded-xl bg-emerald-500/10 p-4 text-sm text-emerald-900 dark:text-emerald-200">
                  <div className="flex items-start gap-2.5">
                    <Clock className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    <div className="space-y-1">
                      <p className="font-semibold">{t.auth.pendingApprovalConfirmTitle}</p>
                      <p className="text-xs leading-relaxed text-emerald-800/90 dark:text-emerald-200/90">
                        {t.auth.pendingApprovalConfirmDesc.replace(
                          '{teacher}',
                          pendingConfirmationTeacher
                        )}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setPendingConfirmationTeacher(null);
                      setTab('login');
                    }}
                    className="btn-secondary w-full py-2 text-xs"
                  >
                    {t.auth.backToLoginBtn}
                  </button>
                </div>
              ) : (
                <form onSubmit={handleSubmit} className="space-y-4">
                  {tab === 'login' ? (
                    <div>
                      <label
                        htmlFor="auth-da"
                        className="mb-1.5 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]"
                      >
                        {t.auth.identifierLabel}
                      </label>
                      <input
                        id="auth-da"
                        type="text"
                        autoComplete="username"
                        value={identifier}
                        onChange={(e) => setIdentifier(e.target.value)}
                        placeholder={t.auth.identifierPlaceholder}
                        className="studio-input font-mono text-sm tracking-wide"
                        required
                      />
                    </div>
                  ) : (
                    <div>
                      <label
                        htmlFor="auth-da"
                        className="mb-1.5 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]"
                      >
                        {t.common.daLabel}
                      </label>
                      <input
                        id="auth-da"
                        type="text"
                        inputMode="numeric"
                        maxLength={7}
                        value={da}
                        onChange={(e) => {
                          setDa(e.target.value.replace(/\D/g, '').slice(0, 7));
                          setError(null);
                        }}
                        placeholder={t.auth.daPlaceholder}
                        className="studio-input font-mono tabular-nums tracking-wide"
                        required
                      />

                      {checkingDa && (
                        <p className="mt-1.5 text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                          {t.auth.checkingDa}
                        </p>
                      )}

                      {!checkingDa && daCheck && daCheck.is_registered && (
                        <div className="mt-2 flex items-center gap-1.5 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-xs font-medium text-amber-800 dark:text-amber-300">
                          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                          <span>{t.auth.daAlreadyRegisteredBadge}</span>
                        </div>
                      )}

                      {!checkingDa && daCheck && !daCheck.is_registered && daCheck.in_roster && (
                        <div className="mt-2 flex items-center gap-1.5 rounded-lg bg-emerald-500/10 px-2.5 py-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                          <span>{t.auth.daInRosterBadge}</span>
                        </div>
                      )}
                    </div>
                  )}

                  {tab === 'register' && (
                    <div>
                      <label
                        htmlFor="auth-name"
                        className="mb-1.5 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]"
                      >
                        {t.auth.nameLabel}
                      </label>
                      <input
                        id="auth-name"
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder={t.auth.namePlaceholder}
                        className="studio-input"
                        required
                      />
                    </div>
                  )}

                  {needsTeacherSelect && (
                    <div className="space-y-1.5 rounded-xl border border-black/[0.08] bg-[#F6F7F9] p-3 dark:border-white/[0.08] dark:bg-[#0D0E11]">
                      <label
                        htmlFor="auth-teacher"
                        className="block text-xs font-medium text-[#111318] dark:text-[#F4F5F7]"
                      >
                        {t.auth.selectTeacherLabel}
                      </label>
                      <p className="text-[11px] leading-relaxed text-[#5B616E] dark:text-[#9399A6]">
                        {t.auth.daNotInRosterNote}
                      </p>
                      <select
                        id="auth-teacher"
                        required
                        value={selectedTeacherId}
                        onChange={(e) => setSelectedTeacherId(e.target.value)}
                        className="studio-input mt-1"
                      >
                        <option value="">{t.auth.selectTeacherPlaceholder}</option>
                        {teachers.map((tc) => (
                          <option key={tc.id} value={tc.id}>
                            {tc.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div>
                    <label
                      htmlFor="auth-password"
                      className="mb-1.5 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]"
                    >
                      {t.auth.passwordLabel}
                    </label>
                    <input
                      id="auth-password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={t.auth.passwordPlaceholder}
                      className="studio-input"
                      required
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={submitting}
                    className="btn-primary mt-2 w-full py-2.5"
                  >
                    {submitting
                      ? t.common.loading
                      : tab === 'login'
                        ? t.auth.loginButton
                        : t.auth.registerButton}
                  </button>
                </form>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
