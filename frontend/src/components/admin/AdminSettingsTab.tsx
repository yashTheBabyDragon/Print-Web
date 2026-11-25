import React, { useCallback, useEffect, useState } from 'react';
import {
  Check,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  Loader2,
  Plug,
  RefreshCw,
  Save,
  Terminal,
  XCircle,
} from 'lucide-react';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import type {
  FilamentApiHealth,
  SystemSettings,
  SystemUpdateStatus,
  UpdateJobStatus,
} from '../../types/api';
import { translateApiError } from '../../utils/errors';

const DEBIAN_UPDATE_CMD = 'sudo /opt/ggprint/deploy/update-from-release.sh';

interface AdminSettingsTabProps {
  settings: SystemSettings | null;
  canManageSettings?: boolean;
  canManageUpdates?: boolean;
  isDevMode?: boolean;
  onReload: () => Promise<void>;
  onError: (msg: string) => void;
}

export function AdminSettingsTab({
  settings,
  canManageSettings = true,
  canManageUpdates = true,
  isDevMode = false,
  onReload,
  onError,
}: AdminSettingsTabProps) {
  const { t } = useI18n();
  const [form, setForm] = useState<SystemSettings | null>(settings);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedToast, setSavedToast] = useState(false);
  const [testingFilamentApi, setTestingFilamentApi] = useState(false);
  const [filamentApiTest, setFilamentApiTest] = useState<FilamentApiHealth | null>(null);
  const [updateStatus, setUpdateStatus] = useState<SystemUpdateStatus | null>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [confirmingUpdate, setConfirmingUpdate] = useState(false);
  const [triggeringUpdate, setTriggeringUpdate] = useState(false);
  const [updateJob, setUpdateJob] = useState<UpdateJobStatus | null>(null);
  const [copiedCli, setCopiedCli] = useState(false);

  const fetchUpdateStatus = useCallback(
    async (force: boolean) => {
      if (!canManageUpdates) return;
      setCheckingUpdates(true);
      setUpdateError(null);
      try {
        const res = await api.adminGetUpdateStatus(force);
        setUpdateStatus(res);
        if (res.update_job) {
          setUpdateJob(res.update_job);
        }
      } catch (err) {
        setUpdateError(translateApiError(err, t));
      } finally {
        setCheckingUpdates(false);
      }
    },
    [canManageUpdates, t]
  );

  useEffect(() => {
    if (canManageUpdates) {
      void fetchUpdateStatus(false);
    }
  }, [canManageUpdates, fetchUpdateStatus]);

  useEffect(() => {
    if (!canManageUpdates) return;
    if (updateJob?.state !== 'queued' && updateJob?.state !== 'updating') return;
    const timer = window.setInterval(() => {
      void fetchUpdateStatus(false);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [canManageUpdates, updateJob?.state, fetchUpdateStatus]);

  useEffect(() => {
    if (settings) {
      setForm(settings);
    }
  }, [settings]);

  if (canManageSettings && !form) {
    return (
      <div className="studio-surface flex items-center gap-2 p-6 text-sm text-[#5B616E] dark:text-[#9399A6]">
        <Loader2 className="h-4 w-4 animate-spin text-[#00A7D9]" />
        {t.common.loading}
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setSaving(true);
    setSavedToast(false);
    try {
      const payload: Partial<SystemSettings> = {
        default_max_active_grams: Number(form.default_max_active_grams),
        enforce_duration_limit: form.enforce_duration_limit,
        default_max_print_minutes: Number(form.default_max_print_minutes),
        allow_multiple_jobs_within_budget: form.allow_multiple_jobs_within_budget,
        max_upload_mb: Number(form.max_upload_mb),
        fdm_monster_mode: isDevMode ? form.fdm_monster_mode : 'live',
        fdm_monster_url: form.fdm_monster_url,
        slicer_mode: isDevMode ? form.slicer_mode : 'orcaslicer',
        orca_cli_path: form.orca_cli_path,
        filament_api_enabled: form.filament_api_enabled,
        filament_api_url: form.filament_api_url,
      };
      if (apiKeyInput.trim()) {
        payload.fdm_monster_api_key = apiKeyInput.trim();
      }
      await api.adminUpdateSettings(payload);
      setApiKeyInput('');
      await onReload();
      setSavedToast(true);
      setTimeout(() => setSavedToast(false), 3000);
    } catch (err) {
      onError(translateApiError(err, t));
    } finally {
      setSaving(false);
    }
  };

  const handleTestFilamentApi = async () => {
    if (!form) return;
    setTestingFilamentApi(true);
    setFilamentApiTest(null);
    try {
      const res = await api.adminTestFilamentApi(form.filament_api_url);
      setFilamentApiTest(res);
    } catch (err) {
      setFilamentApiTest({
        ok: false,
        status: 'error',
        printers_configured: 0,
        printers: [],
        error: translateApiError(err, t),
      });
    } finally {
      setTestingFilamentApi(false);
    }
  };

  const handleTriggerUpdate = async () => {
    if (!updateStatus?.latest_version) return;
    setTriggeringUpdate(true);
    setUpdateError(null);
    try {
      const job = await api.adminTriggerUpdate(updateStatus.latest_version);
      setUpdateJob(job);
      setConfirmingUpdate(false);
    } catch (err) {
      setUpdateError(translateApiError(err, t));
    } finally {
      setTriggeringUpdate(false);
    }
  };

  const handleCopyCli = async () => {
    try {
      await navigator.clipboard.writeText(DEBIAN_UPDATE_CMD);
      setCopiedCli(true);
      setTimeout(() => setCopiedCli(false), 2000);
    } catch {
      // Clipboard unavailable in non-secure contexts
    }
  };

  const formattedLatest = updateStatus?.latest_version
    ? `v${updateStatus.latest_version.replace(/^v/i, '')}`
    : null;
  const activeUpdateBusy =
    triggeringUpdate || updateJob?.state === 'queued' || updateJob?.state === 'updating';

  return (
    <div className="space-y-6">
    {canManageSettings && form && (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="studio-surface p-5 space-y-4">
        <h2 className="text-base font-semibold text-[#111318] dark:text-[#F4F5F7]">
          {t.admin.settings.limitsTitle}
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
              {t.admin.settings.defaultMaxGrams}
            </label>
            <input
              type="number"
              step="1"
              min="1"
              value={form.default_max_active_grams}
              onChange={(e) =>
                setForm({ ...form, default_max_active_grams: Number(e.target.value) })
              }
              className="studio-input font-mono tabular-nums"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
              {t.admin.settings.defaultMaxMinutes}
            </label>
            <input
              type="number"
              step="1"
              min="1"
              value={form.default_max_print_minutes}
              onChange={(e) =>
                setForm({ ...form, default_max_print_minutes: Number(e.target.value) })
              }
              className="studio-input font-mono tabular-nums"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
              {t.admin.settings.maxUploadMb}
            </label>
            <input
              type="number"
              step="1"
              min="1"
              value={form.max_upload_mb}
              onChange={(e) => setForm({ ...form, max_upload_mb: Number(e.target.value) })}
              className="studio-input font-mono tabular-nums"
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-6 pt-1">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-[#111318] dark:text-[#F4F5F7]">
            <input
              type="checkbox"
              checked={form.enforce_duration_limit}
              onChange={(e) =>
                setForm({ ...form, enforce_duration_limit: e.target.checked })
              }
              className="h-4 w-4 rounded"
            />
            <span>{t.admin.settings.enforceDuration}</span>
          </label>

          <label className="flex cursor-pointer items-center gap-2 text-sm text-[#111318] dark:text-[#F4F5F7]">
            <input
              type="checkbox"
              checked={form.allow_multiple_jobs_within_budget}
              onChange={(e) =>
                setForm({ ...form, allow_multiple_jobs_within_budget: e.target.checked })
              }
              className="h-4 w-4 rounded"
            />
            <span>{t.admin.settings.allowMultipleJobs}</span>
          </label>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="studio-surface p-5 space-y-4">
          <h2 className="text-base font-semibold text-[#111318] dark:text-[#F4F5F7]">
            {t.admin.settings.slicerTitle}
          </h2>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
              {t.admin.settings.slicerMode}
            </label>
            <select
              value={isDevMode ? form.slicer_mode : 'orcaslicer'}
              onChange={(e) =>
                setForm({ ...form, slicer_mode: e.target.value as 'mock' | 'orcaslicer' })
              }
              disabled={!isDevMode}
              className="studio-input disabled:opacity-80"
            >
              {isDevMode && <option value="mock">{t.admin.settings.modeMock}</option>}
              <option value="orcaslicer">{t.admin.settings.modeOrca}</option>
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
              {t.admin.settings.orcaCliPath}
            </label>
            <input
              type="text"
              value={form.orca_cli_path}
              onChange={(e) => setForm({ ...form, orca_cli_path: e.target.value })}
              className="studio-input font-mono text-xs"
            />
          </div>
        </div>

        <div className="studio-surface p-5 space-y-4">
          <h2 className="text-base font-semibold text-[#111318] dark:text-[#F4F5F7]">
            {t.admin.settings.fdmTitle}
          </h2>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
              {t.admin.settings.fdmMode}
            </label>
            <select
              value={isDevMode ? form.fdm_monster_mode : 'live'}
              onChange={(e) =>
                setForm({
                  ...form,
                  fdm_monster_mode: e.target.value as 'mock' | 'live',
                })
              }
              disabled={!isDevMode}
              className="studio-input disabled:opacity-80"
            >
              {isDevMode && <option value="mock">{t.admin.settings.modeMock}</option>}
              <option value="live">{t.admin.settings.modeLive}</option>
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
              {t.admin.settings.fdmUrl}
            </label>
            <input
              type="text"
              value={form.fdm_monster_url}
              onChange={(e) => setForm({ ...form, fdm_monster_url: e.target.value })}
              className="studio-input font-mono text-xs"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
              {t.admin.settings.fdmApiKey}
            </label>
            <input
              type="password"
              value={apiKeyInput}
              placeholder={form.fdm_monster_api_key || '••••••••'}
              onChange={(e) => setApiKeyInput(e.target.value)}
              className="studio-input font-mono text-xs"
            />
          </div>
        </div>
      </div>

      <div className="studio-surface p-5 space-y-4">
        <div>
          <h2 className="text-base font-semibold text-[#111318] dark:text-[#F4F5F7]">
            {t.admin.settings.filamentApiTitle}
          </h2>
          <p className="mt-1 text-xs text-[#5B616E] dark:text-[#9399A6]">
            {t.admin.settings.filamentApiDesc}
          </p>
        </div>

        <label className="flex cursor-pointer items-center gap-2 text-sm text-[#111318] dark:text-[#F4F5F7]">
          <input
            type="checkbox"
            checked={form.filament_api_enabled}
            onChange={(e) =>
              setForm({ ...form, filament_api_enabled: e.target.checked })
            }
            className="h-4 w-4 rounded"
          />
          <span>{t.admin.settings.filamentApiEnabled}</span>
        </label>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <label className="mb-1.5 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
              {t.admin.settings.filamentApiUrl}
            </label>
            <input
              type="text"
              value={form.filament_api_url}
              placeholder="http://filament-api:8000"
              onChange={(e) => setForm({ ...form, filament_api_url: e.target.value })}
              className="studio-input font-mono text-xs"
            />
          </div>
          <button
            type="button"
            disabled={testingFilamentApi || !form.filament_api_url.trim()}
            onClick={handleTestFilamentApi}
            className="btn-secondary shrink-0 px-3.5 py-2 text-xs"
          >
            {testingFilamentApi ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plug className="h-3.5 w-3.5" />
            )}
            {testingFilamentApi
              ? t.admin.settings.filamentApiTesting
              : t.admin.settings.filamentApiTestBtn}
          </button>
        </div>

        {filamentApiTest && (
          <div
            className={`rounded-xl px-3.5 py-2.5 text-xs ${
              filamentApiTest.ok
                ? 'bg-emerald-500/12 text-emerald-800 dark:text-emerald-300'
                : 'bg-rose-500/12 text-rose-800 dark:text-rose-300'
            }`}
          >
            <div className="flex items-center gap-1.5 font-medium">
              {filamentApiTest.ok ? (
                <CheckCircle2 className="h-4 w-4 shrink-0" />
              ) : (
                <XCircle className="h-4 w-4 shrink-0" />
              )}
              <span>
                {filamentApiTest.ok
                  ? t.admin.settings.filamentApiTestOk.replace(
                      '{count}',
                      String(filamentApiTest.printers_configured)
                    )
                  : `${t.admin.settings.filamentApiTestFail}${filamentApiTest.error ? `: ${filamentApiTest.error}` : ''}`}
              </span>
            </div>
            {filamentApiTest.ok && filamentApiTest.printers.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {filamentApiTest.printers.map((p) => (
                  <span
                    key={p.id}
                    className="rounded-md bg-emerald-500/15 px-2 py-0.5 font-mono text-[11px]"
                  >
                    {p.id} ({p.type})
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-3">
        {savedToast && (
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-400">
            <Check className="h-4 w-4" />
            {t.common.saved}
          </span>
        )}
        <button type="submit" disabled={saving} className="btn-primary px-5 py-2.5">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {saving ? t.common.saving : t.admin.settings.saveSettings}
        </button>
      </div>
    </form>
    )}

    {/* Software Version & On-Demand Updates */}
    {canManageUpdates && (
    <div className="studio-surface space-y-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-[#111318] dark:text-[#F4F5F7]">
            {t.admin.settings.updateSectionTitle}
          </h2>
          <p className="mt-1 text-xs text-[#5B616E] dark:text-[#9399A6]">
            {t.admin.settings.updateSectionDesc}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={checkingUpdates}
            onClick={() => void fetchUpdateStatus(true)}
            className="btn-secondary shrink-0 px-3 py-1.5 text-xs"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${checkingUpdates ? 'animate-spin' : ''}`} />
            {checkingUpdates
              ? t.admin.settings.checkingUpdatesBtn
              : t.admin.settings.checkUpdatesBtn}
          </button>
          {updateStatus?.update_available &&
            formattedLatest &&
            updateStatus.updater_configured && (
              <button
                type="button"
                disabled={activeUpdateBusy}
                onClick={() => setConfirmingUpdate(true)}
                className="btn-primary shrink-0 px-3 py-1.5 text-xs"
              >
                {activeUpdateBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                {activeUpdateBusy
                  ? t.admin.settings.updatingNowBtn
                  : t.admin.settings.updateNowBtn.replace('{version}', formattedLatest)}
              </button>
            )}
        </div>
      </div>

      {/* Inline Update Confirmation */}
      {confirmingUpdate && formattedLatest && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#00A7D9]/30 bg-[#00A7D9]/10 px-4 py-3 text-xs">
          <span className="font-medium text-[#111318] dark:text-[#F4F5F7]">
            {t.admin.settings.updateConfirmPrompt.replace('{version}', formattedLatest)}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={triggeringUpdate}
              onClick={() => setConfirmingUpdate(false)}
              className="btn-secondary px-3 py-1.5 text-xs"
            >
              {t.common.cancel}
            </button>
            <button
              type="button"
              disabled={triggeringUpdate}
              onClick={() => void handleTriggerUpdate()}
              className="btn-primary px-3 py-1.5 text-xs"
            >
              {triggeringUpdate ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              {t.common.confirm}
            </button>
          </div>
        </div>
      )}

      {/* Live Update Job Status */}
      {updateJob && updateJob.state !== 'idle' && (
        <div
          className={`flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-xs font-medium ${
            updateJob.state === 'succeeded'
              ? 'bg-emerald-500/12 text-emerald-800 dark:text-emerald-300'
              : updateJob.state === 'failed'
                ? 'bg-rose-500/12 text-rose-800 dark:text-rose-300'
                : 'bg-[#00A7D9]/12 text-[#007BA3] dark:text-[#38C6F4]'
          }`}
        >
          {updateJob.state === 'succeeded' ? (
            <CheckCircle2 className="h-4 w-4 shrink-0" />
          ) : updateJob.state === 'failed' ? (
            <XCircle className="h-4 w-4 shrink-0" />
          ) : (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
          )}
          <span>
            {updateJob.state === 'queued'
              ? t.admin.settings.updateQueuedMsg.replace(
                  '{version}',
                  updateJob.target_version || formattedLatest || ''
                )
              : updateJob.state === 'updating'
                ? t.admin.settings.updateInProgressMsg.replace(
                    '{version}',
                    updateJob.target_version || formattedLatest || ''
                  )
                : updateJob.state === 'succeeded'
                  ? t.admin.settings.updateSucceededMsg.replace(
                      '{version}',
                      updateJob.target_version || formattedLatest || ''
                    )
                  : t.admin.settings.updateFailedMsg.replace(
                      '{message}',
                      updateJob.message || ''
                    )}
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="studio-subtle px-3.5 py-2.5">
          <div className="text-[11px] text-[#5B616E] dark:text-[#9399A6]">
            {t.admin.settings.currentVersionLabel}
          </div>
          <div className="mt-1 font-mono text-sm font-semibold tabular-nums text-[#111318] dark:text-[#F4F5F7]">
            {updateStatus?.current_version
              ? `v${updateStatus.current_version.replace(/^v/i, '')}`
              : '—'}
          </div>
        </div>

        <div className="studio-subtle px-3.5 py-2.5">
          <div className="text-[11px] text-[#5B616E] dark:text-[#9399A6]">
            {t.admin.settings.latestVersionLabel}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-semibold tabular-nums text-[#111318] dark:text-[#F4F5F7]">
              {formattedLatest || '—'}
            </span>
            {updateStatus?.update_available ? (
              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
                {t.admin.settings.updateAvailableBadge}
              </span>
            ) : updateStatus?.latest_version ? (
              <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
                {t.admin.settings.upToDateBadge}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {updateStatus?.release_url &&
        updateStatus.release_url.startsWith('https://github.com/') && (
        <div>
          <a
            href={updateStatus.release_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-[#007BA3] hover:underline dark:text-[#38C6F4]"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            <span>{t.admin.settings.viewReleaseLink}</span>
          </a>
        </div>
      )}

      {(updateError || updateStatus?.error) && (
        <div className="rounded-xl bg-amber-500/10 px-3.5 py-2 text-xs text-amber-800 dark:text-amber-300">
          {t.admin.settings.updateCheckError}: {updateError || updateStatus?.error}
        </div>
      )}

      <div className="space-y-1.5 border-t border-black/[0.06] pt-3.5 dark:border-white/[0.07]">
        {updateStatus?.update_available && !updateStatus.updater_configured && (
          <p className="text-xs font-medium text-amber-800 dark:text-amber-300">
            {t.admin.settings.updaterNotConfiguredHint}
          </p>
        )}
        <div className="flex items-center gap-1.5 text-xs text-[#5B616E] dark:text-[#9399A6]">
          <Terminal className="h-3.5 w-3.5 shrink-0" />
          <span>{t.admin.settings.updateCliHint}</span>
        </div>
        <div className="studio-subtle flex items-center justify-between gap-2 px-3 py-2">
          <code className="overflow-x-auto font-mono text-xs text-[#111318] dark:text-[#F4F5F7]">
            {DEBIAN_UPDATE_CMD}
          </code>
          <button
            type="button"
            onClick={() => void handleCopyCli()}
            aria-label={t.admin.students.copyPassword}
            className="btn-secondary shrink-0 px-2.5 py-1 text-xs"
          >
            {copiedCli ? (
              <Check className="h-3.5 w-3.5 text-emerald-500" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
            {copiedCli ? t.admin.students.copied : t.admin.students.copyPassword}
          </button>
        </div>
      </div>
    </div>
    )}
    </div>
  );
}
