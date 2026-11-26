import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Cpu,
  Loader2,
  Moon,
  Plug,
  Rocket,
  ShieldCheck,
  Sun,
  Wrench,
  XCircle,
} from 'lucide-react';
import { api } from '../api/client';
import { useTheme } from '../context/ThemeContext';
import { useI18n } from '../i18n';
import { Logo } from '../components/Logo';
import type {
  AuthResponse,
  SetupStatusResponse,
  SetupTestFdmResponse,
  SetupTestOrcaResponse,
} from '../types/api';
import { translateApiError } from '../utils/errors';

interface SetupWizardPageProps {
  setupToken?: string | null;
  onCompleted: (auth: AuthResponse) => void;
  onExitSetup: () => void;
}

export function SetupWizardPage({
  setupToken = null,
  onCompleted,
  onExitSetup,
}: SetupWizardPageProps) {
  const { theme, toggleTheme } = useTheme();
  const { lang, toggleLang, t } = useI18n();

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [setupStatus, setSetupStatus] = useState<SetupStatusResponse | null>(null);

  // Step 1 checks
  const [orcaPath, setOrcaPath] = useState('orca-slicer');
  const [testingOrca, setTestingOrca] = useState(false);
  const [orcaResult, setOrcaResult] = useState<SetupTestOrcaResponse | null>(null);

  const [fdmUrl, setFdmUrl] = useState('http://fdm-monster:4000');
  const [fdmApiKey, setFdmApiKey] = useState('');
  const [testingFdm, setTestingFdm] = useState(false);
  const [fdmResult, setFdmResult] = useState<SetupTestFdmResponse | null>(null);

  // Step 2 admin
  const [updateAdmin, setUpdateAdmin] = useState(false);
  const [adminUsername, setAdminUsername] = useState('admin');
  const [adminName, setAdminName] = useState('Administrateur');
  const [adminPassword, setAdminPassword] = useState('');
  const [adminPasswordConfirm, setAdminPasswordConfirm] = useState('');

  // Step 3 lab config
  const [institution, setInstitution] = useState('3D Print Lab');
  const [slicerMode, setSlicerMode] = useState<'mock' | 'orcaslicer'>('orcaslicer');
  const [maxConcurrentSlices, setMaxConcurrentSlices] = useState<number>(2);
  const [fdmMode, setFdmMode] = useState<'mock' | 'live'>('live');
  const [defaultMaxGrams, setDefaultMaxGrams] = useState<number>(100);
  const [defaultMaxMinutes, setDefaultMaxMinutes] = useState<number>(360);

  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const runOrcaTest = useCallback(
    async (pathToTest: string, token: string | null) => {
      setTestingOrca(true);
      try {
        const res = await api.testSetupOrcaSlicer(pathToTest, token);
        setOrcaResult(res);
      } catch (err) {
        setOrcaResult({
          ok: false,
          path: pathToTest,
          version: null,
          detail: translateApiError(err, t),
        });
      } finally {
        setTestingOrca(false);
      }
    },
    [t]
  );

  useEffect(() => {
    let active = true;
    (async () => {
      setLoadingStatus(true);
      setStatusError(null);
      try {
        const res = await api.getSetupStatus(setupToken);
        if (!active) return;
        setSetupStatus(res);
        setInstitution(res.institution || '3D Print Lab');
        const initialOrcaPath =
          res.current_settings?.orca_cli_path || res.suggested_orca_path || 'orca-slicer';
        setOrcaPath(initialOrcaPath);
        setSlicerMode(
          res.dev_mode
            ? (res.current_settings?.slicer_mode ?? 'orcaslicer')
            : 'orcaslicer'
        );
        setMaxConcurrentSlices(
          Math.max(1, Math.min(4, Number(res.current_settings?.max_concurrent_slices ?? 2)))
        );
        setFdmMode(
          res.dev_mode ? (res.current_settings?.fdm_monster_mode ?? 'live') : 'live'
        );
        setFdmUrl(res.current_settings?.fdm_monster_url || 'http://fdm-monster:4000');
        setDefaultMaxGrams(Number(res.current_settings?.default_max_active_grams ?? 100));
        setDefaultMaxMinutes(Number(res.current_settings?.default_max_print_minutes ?? 360));
        setUpdateAdmin(!res.has_admin);

        if (res.needs_setup) {
          void runOrcaTest(initialOrcaPath, setupToken);
        }
      } catch (err) {
        if (active) setStatusError(translateApiError(err, t));
      } finally {
        if (active) setLoadingStatus(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [setupToken, runOrcaTest, t]);

  const handleTestFdm = async () => {
    setTestingFdm(true);
    setFdmResult(null);
    try {
      const res = await api.testSetupFdmMonster(fdmUrl, fdmApiKey, setupToken);
      setFdmResult(res);
    } catch (err) {
      setFdmResult({
        ok: false,
        printer_count: 0,
        printers: [],
        detail: translateApiError(err, t),
      });
    } finally {
      setTestingFdm(false);
    }
  };

  const handleStep2Next = () => {
    setFormError(null);
    const mustConfigureAdmin = !setupStatus?.has_admin || updateAdmin;
    if (mustConfigureAdmin) {
      if (!adminUsername.trim() || adminUsername.trim().length < 2) {
        setFormError(t.setup.usernameRequired);
        return;
      }
      if (adminName.trim().length < 2) {
        setFormError(t.errors.invalidName);
        return;
      }
      if (adminPassword.length < 4) {
        setFormError(t.errors.invalidPassword);
        return;
      }
      if (adminPassword !== adminPasswordConfirm) {
        setFormError(t.setup.passwordMismatch);
        return;
      }
    }
    setStep(3);
  };

  const handleComplete = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const includeAdmin = !setupStatus?.has_admin || updateAdmin;
      const auth = await api.completeSetup({
        token: setupToken || null,
        admin_username: includeAdmin ? adminUsername.trim() : null,
        admin_name: includeAdmin ? adminName.trim() : null,
        admin_password: includeAdmin ? adminPassword : null,
        institution: institution.trim() || '3D Print Lab',
        slicer_mode: setupStatus?.dev_mode ? slicerMode : 'orcaslicer',
        orca_cli_path: orcaPath.trim() || 'orca-slicer',
        max_concurrent_slices: Math.max(1, Math.min(4, Number(maxConcurrentSlices) || 2)),
        fdm_monster_mode: setupStatus?.dev_mode ? fdmMode : 'live',
        fdm_monster_url: fdmUrl.trim() || 'http://fdm-monster:4000',
        fdm_monster_api_key: fdmApiKey.trim() ? fdmApiKey.trim() : null,
        default_max_active_grams: Math.max(1, Number(defaultMaxGrams) || 100),
        default_max_print_minutes: Math.max(1, Number(defaultMaxMinutes) || 360),
      });
      onCompleted(auth);
    } catch (err) {
      setFormError(translateApiError(err, t));
    } finally {
      setSubmitting(false);
    }
  };

  const steps = [
    { id: 1 as const, label: t.setup.step1Label, icon: Wrench },
    { id: 2 as const, label: t.setup.step2Label, icon: ShieldCheck },
    { id: 3 as const, label: t.setup.step3Label, icon: Cpu },
  ];

  return (
    <div className="flex min-h-screen min-h-[100dvh] flex-col bg-[#F6F7F9] text-[#111318] dark:bg-[#0D0E11] dark:text-[#F4F5F7]">
      <header className="flex items-center justify-between border-b border-black/[0.06] bg-white/80 px-4 py-3 backdrop-blur-md dark:border-white/[0.08] dark:bg-[#15171C]/80 sm:px-6">
        <div className="flex items-center gap-3">
          <Logo size={32} />
          <div>
            <div className="flex items-center gap-2">
              <span className="text-base font-semibold tracking-tight">{t.common.appName}</span>
              <span className="rounded-full bg-[#00A7D9]/12 px-2 py-0.5 text-[11px] font-medium text-[#007BA3] dark:text-[#38C6F4]">
                {t.setup.badge}
              </span>
            </div>
            <p className="text-xs text-[#5B616E] dark:text-[#9399A6]">
              {setupStatus?.institution || t.common.institution}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleLang}
            title={t.common.languageToggleTooltip}
            className="btn-secondary min-h-[36px] px-2.5 py-1.5 text-xs font-semibold"
          >
            {lang === 'fr' ? 'EN' : 'FR'}
          </button>
          <button
            type="button"
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? t.common.lightMode : t.common.darkMode}
            title={theme === 'dark' ? t.common.lightMode : t.common.darkMode}
            className="btn-secondary min-h-[36px] px-2.5 py-1.5"
          >
            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center px-4 py-8 sm:px-6">
        {loadingStatus ? (
          <div className="studio-surface flex items-center justify-center gap-2.5 p-10 text-sm text-[#5B616E] dark:text-[#9399A6]">
            <Loader2 className="h-4 w-4 animate-spin text-[#00A7D9]" />
            <span>{t.common.loading}</span>
          </div>
        ) : statusError ? (
          <div className="studio-surface space-y-4 p-6 text-center">
            <AlertCircle className="mx-auto h-8 w-8 text-rose-500" />
            <p className="text-sm font-medium text-rose-700 dark:text-rose-300">{statusError}</p>
            <button type="button" onClick={onExitSetup} className="btn-secondary px-4 py-2 text-xs">
              {t.setup.returnToPortalBtn}
            </button>
          </div>
        ) : setupStatus && !setupStatus.needs_setup ? (
          <div className="studio-surface space-y-4 p-8 text-center">
            <ShieldCheck className="mx-auto h-10 w-10 text-[#00A7D9]" />
            <h1 className="text-lg font-semibold">{t.setup.lockedTitle}</h1>
            <p className="text-sm text-[#5B616E] dark:text-[#9399A6]">{t.setup.lockedDesc}</p>
            <div className="pt-2">
              <button type="button" onClick={onExitSetup} className="btn-primary px-5 py-2.5">
                {t.setup.returnToPortalBtn}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="text-center">
              <h1 className="text-2xl font-semibold tracking-tight">{t.setup.title}</h1>
              <p className="mt-1.5 text-sm text-[#5B616E] dark:text-[#9399A6]">
                {t.setup.subtitle}
              </p>
            </div>

            {/* Stepper */}
            <nav aria-label={t.setup.badge} className="grid grid-cols-3 gap-2">
              {steps.map((item) => {
                const Icon = item.icon;
                const active = step === item.id;
                const done = step > item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    disabled={item.id > step}
                    onClick={() => {
                      if (item.id < step) {
                        setFormError(null);
                        setStep(item.id);
                      }
                    }}
                    className={`flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-xs font-medium transition-colors ${
                      active
                        ? 'border-[#00A7D9] bg-[#00A7D9]/10 text-[#007BA3] dark:text-[#38C6F4]'
                        : done
                          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                          : 'border-black/[0.08] bg-white/70 text-[#5B616E] dark:border-white/[0.08] dark:bg-[#15171C]/70 dark:text-[#9399A6]'
                    }`}
                  >
                    {done ? (
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                    ) : (
                      <Icon className="h-3.5 w-3.5 shrink-0" />
                    )}
                    <span className="truncate">
                      {item.id}. {item.label}
                    </span>
                  </button>
                );
              })}
            </nav>

            {formError && (
              <div className="flex items-center gap-2 rounded-xl bg-rose-500/10 px-4 py-3 text-xs font-medium text-rose-700 dark:text-rose-300">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{formError}</span>
              </div>
            )}

            {/* Step 1: Checks */}
            {step === 1 && setupStatus && (
              <div className="studio-surface space-y-5 p-6">
                <div>
                  <h2 className="text-base font-semibold">{t.setup.checksTitle}</h2>
                  <p className="mt-1 text-xs text-[#5B616E] dark:text-[#9399A6]">
                    {t.setup.checksDesc}
                  </p>
                </div>

                {/* Server status pills */}
                <div className="studio-subtle flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                  <span className="text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
                    {t.setup.statusDbLabel}
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1 rounded-full bg-[#00A7D9]/12 px-2.5 py-0.5 text-xs font-medium text-[#007BA3] dark:text-[#38C6F4]">
                      <CheckCircle2 className="h-3 w-3" />
                      {t.setup.statusReady}
                    </span>
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        setupStatus.has_admin
                          ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300'
                          : 'bg-amber-500/12 text-amber-700 dark:text-amber-300'
                      }`}
                    >
                      {setupStatus.has_admin ? t.setup.statusHasAdmin : t.setup.statusNoAdmin}
                    </span>
                    {setupToken && (
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                          setupStatus.token_valid
                            ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300'
                            : 'bg-rose-500/12 text-rose-700 dark:text-rose-300'
                        }`}
                      >
                        {setupStatus.token_valid
                          ? t.setup.statusTokenValid
                          : t.setup.statusTokenInvalid}
                      </span>
                    )}
                  </div>
                </div>

                {/* OrcaSlicer Check */}
                <div className="space-y-3 rounded-xl border border-black/[0.08] p-4 dark:border-white/[0.08]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{t.setup.orcaCheckTitle}</span>
                    {testingOrca ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-black/[0.05] px-2.5 py-0.5 text-xs text-[#5B616E] dark:bg-white/[0.08] dark:text-[#9399A6]">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        {t.setup.testingOrca}
                      </span>
                    ) : orcaResult ? (
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                          orcaResult.ok
                            ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300'
                            : 'bg-amber-500/12 text-amber-700 dark:text-amber-300'
                        }`}
                      >
                        {orcaResult.ok ? (
                          <CheckCircle2 className="h-3.5 w-3.5" />
                        ) : (
                          <XCircle className="h-3.5 w-3.5" />
                        )}
                        {orcaResult.ok ? t.setup.orcaOk : t.setup.orcaFail}
                        {orcaResult.version ? ` · ${orcaResult.version}` : ''}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                    <div className="flex-1">
                      <label className="mb-1 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
                        {t.setup.orcaPathLabel}
                      </label>
                      <input
                        type="text"
                        value={orcaPath}
                        onChange={(e) => setOrcaPath(e.target.value)}
                        className="studio-input font-mono text-xs"
                      />
                    </div>
                    <button
                      type="button"
                      disabled={testingOrca || !orcaPath.trim()}
                      onClick={() => void runOrcaTest(orcaPath.trim(), setupToken)}
                      className="btn-secondary shrink-0 px-3.5 py-2 text-xs"
                    >
                      {testingOrca ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Plug className="h-3.5 w-3.5" />
                      )}
                      {t.setup.testOrcaBtn}
                    </button>
                  </div>
                  {orcaResult?.detail && (
                    <p className="font-mono text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                      {orcaResult.detail}
                    </p>
                  )}
                </div>

                {/* FDM Monster Check */}
                <div className="space-y-3 rounded-xl border border-black/[0.08] p-4 dark:border-white/[0.08]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{t.setup.fdmCheckTitle}</span>
                    {fdmResult && (
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                          fdmResult.ok
                            ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300'
                            : 'bg-rose-500/12 text-rose-700 dark:text-rose-300'
                        }`}
                      >
                        {fdmResult.ok ? (
                          <CheckCircle2 className="h-3.5 w-3.5" />
                        ) : (
                          <XCircle className="h-3.5 w-3.5" />
                        )}
                        {fdmResult.ok
                          ? `${t.setup.fdmOk} · ${t.setup.fdmPrintersFound.replace(
                              '{count}',
                              String(fdmResult.printer_count)
                            )}`
                          : t.setup.fdmFail}
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
                        {t.setup.fdmUrlLabel}
                      </label>
                      <input
                        type="text"
                        value={fdmUrl}
                        onChange={(e) => setFdmUrl(e.target.value)}
                        className="studio-input font-mono text-xs"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
                        {t.setup.fdmKeyLabel}
                      </label>
                      <input
                        type="password"
                        value={fdmApiKey}
                        placeholder={
                          setupStatus.current_settings?.has_fdm_monster_api_key
                            ? '••••••••'
                            : ''
                        }
                        onChange={(e) => setFdmApiKey(e.target.value)}
                        className="studio-input font-mono text-xs"
                      />
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                      {fdmResult?.detail || ''}
                    </span>
                    <button
                      type="button"
                      disabled={testingFdm || !fdmUrl.trim()}
                      onClick={() => void handleTestFdm()}
                      className="btn-secondary shrink-0 px-3.5 py-2 text-xs"
                    >
                      {testingFdm ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Plug className="h-3.5 w-3.5" />
                      )}
                      {testingFdm ? t.setup.testingFdm : t.setup.testFdmBtn}
                    </button>
                  </div>
                </div>

                <div className="flex justify-end pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setFormError(null);
                      setStep(2);
                    }}
                    className="btn-primary px-5 py-2.5"
                  >
                    <span>{t.setup.nextBtn}</span>
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            )}

            {/* Step 2: Main Admin */}
            {step === 2 && setupStatus && (
              <div className="studio-surface space-y-5 p-6">
                <div>
                  <h2 className="text-base font-semibold">{t.setup.adminTitle}</h2>
                  <p className="mt-1 text-xs text-[#5B616E] dark:text-[#9399A6]">
                    {t.setup.adminDesc}
                  </p>
                </div>

                {setupStatus.has_admin && (
                  <div className="space-y-3 rounded-xl border border-[#00A7D9]/30 bg-[#00A7D9]/8 p-4">
                    <p className="text-xs text-[#111318] dark:text-[#F4F5F7]">
                      {t.setup.adminExistingNote}
                    </p>
                    <label className="flex cursor-pointer items-center gap-2 text-xs font-medium">
                      <input
                        type="checkbox"
                        checked={updateAdmin}
                        onChange={(e) => setUpdateAdmin(e.target.checked)}
                        className="h-4 w-4 rounded"
                      />
                      <span>{t.setup.adminCreateOrResetToggle}</span>
                    </label>
                  </div>
                )}

                {(!setupStatus.has_admin || updateAdmin) && (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
                        {t.setup.usernameLabel}
                      </label>
                      <input
                        type="text"
                        value={adminUsername}
                        placeholder={t.setup.usernamePlaceholder}
                        onChange={(e) => setAdminUsername(e.target.value)}
                        className="studio-input"
                      />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
                        {t.setup.fullNameLabel}
                      </label>
                      <input
                        type="text"
                        value={adminName}
                        placeholder={t.setup.fullNamePlaceholder}
                        onChange={(e) => setAdminName(e.target.value)}
                        className="studio-input"
                      />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
                        {t.setup.passwordLabel}
                      </label>
                      <input
                        type="password"
                        value={adminPassword}
                        onChange={(e) => setAdminPassword(e.target.value)}
                        className="studio-input"
                      />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
                        {t.setup.confirmPasswordLabel}
                      </label>
                      <input
                        type="password"
                        value={adminPasswordConfirm}
                        onChange={(e) => setAdminPasswordConfirm(e.target.value)}
                        className="studio-input"
                      />
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setFormError(null);
                      setStep(1);
                    }}
                    className="btn-secondary px-4 py-2"
                  >
                    <ChevronLeft className="h-4 w-4" />
                    <span>{t.setup.backBtn}</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleStep2Next}
                    className="btn-primary px-5 py-2.5"
                  >
                    <span>
                      {setupStatus.has_admin && !updateAdmin
                        ? t.setup.skipStep2Btn
                        : t.setup.nextBtn}
                    </span>
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            )}

            {/* Step 3: Lab Config */}
            {step === 3 && setupStatus && (
              <form onSubmit={handleComplete} className="studio-surface space-y-5 p-6">
                <div>
                  <h2 className="text-base font-semibold">{t.setup.labTitle}</h2>
                  <p className="mt-1 text-xs text-[#5B616E] dark:text-[#9399A6]">
                    {t.setup.labDesc}
                  </p>
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <label className="mb-1.5 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
                      {t.setup.institutionLabel}
                    </label>
                    <input
                      type="text"
                      value={institution}
                      onChange={(e) => setInstitution(e.target.value)}
                      className="studio-input"
                    />
                  </div>

                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
                      {t.setup.slicerModeLabel}
                    </label>
                    <select
                      value={setupStatus.dev_mode ? slicerMode : 'orcaslicer'}
                      disabled={!setupStatus.dev_mode}
                      onChange={(e) =>
                        setSlicerMode(e.target.value as 'mock' | 'orcaslicer')
                      }
                      className="studio-input disabled:opacity-80"
                    >
                      {setupStatus.dev_mode && (
                        <option value="mock">{t.admin.settings.modeMock}</option>
                      )}
                      <option value="orcaslicer">{t.admin.settings.modeOrca}</option>
                    </select>
                  </div>

                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
                      {t.setup.maxConcurrentSlicesLabel}
                    </label>
                    <select
                      value={maxConcurrentSlices}
                      onChange={(e) => setMaxConcurrentSlices(Number(e.target.value))}
                      className="studio-input font-mono tabular-nums"
                    >
                      {[1, 2, 3, 4].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="sm:col-span-2">
                    <label className="mb-1.5 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
                      {t.setup.orcaCliPathLabel}
                    </label>
                    <input
                      type="text"
                      value={orcaPath}
                      onChange={(e) => setOrcaPath(e.target.value)}
                      className="studio-input font-mono text-xs"
                    />
                  </div>

                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
                      {t.setup.fdmModeLabel}
                    </label>
                    <select
                      value={setupStatus.dev_mode ? fdmMode : 'live'}
                      disabled={!setupStatus.dev_mode}
                      onChange={(e) => setFdmMode(e.target.value as 'mock' | 'live')}
                      className="studio-input disabled:opacity-80"
                    >
                      {setupStatus.dev_mode && (
                        <option value="mock">{t.admin.settings.modeMock}</option>
                      )}
                      <option value="live">{t.admin.settings.modeLive}</option>
                    </select>
                  </div>

                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
                      {t.setup.fdmModeUrlLabel}
                    </label>
                    <input
                      type="text"
                      value={fdmUrl}
                      onChange={(e) => setFdmUrl(e.target.value)}
                      className="studio-input font-mono text-xs"
                    />
                  </div>

                  <div className="sm:col-span-2">
                    <label className="mb-1.5 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
                      {t.setup.fdmKeyLabel}
                    </label>
                    <input
                      type="password"
                      value={fdmApiKey}
                      placeholder={t.setup.fdmApiKeyPlaceholder}
                      onChange={(e) => setFdmApiKey(e.target.value)}
                      className="studio-input font-mono text-xs"
                    />
                  </div>

                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
                      {t.setup.defaultMaxGramsLabel}
                    </label>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={defaultMaxGrams}
                      onChange={(e) => setDefaultMaxGrams(Number(e.target.value))}
                      className="studio-input font-mono tabular-nums"
                    />
                  </div>

                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
                      {t.setup.defaultMaxMinutesLabel}
                    </label>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={defaultMaxMinutes}
                      onChange={(e) => setDefaultMaxMinutes(Number(e.target.value))}
                      className="studio-input font-mono tabular-nums"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between pt-2">
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => {
                      setFormError(null);
                      setStep(2);
                    }}
                    className="btn-secondary px-4 py-2"
                  >
                    <ChevronLeft className="h-4 w-4" />
                    <span>{t.setup.backBtn}</span>
                  </button>
                  <button type="submit" disabled={submitting} className="btn-primary px-5 py-2.5">
                    {submitting ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Rocket className="h-4 w-4" />
                    )}
                    <span>{submitting ? t.setup.completingBtn : t.setup.completeBtn}</span>
                  </button>
                </div>
              </form>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

export default SetupWizardPage;
