import React, { useEffect, useState } from 'react';
import { Check, Loader2, Save } from 'lucide-react';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import type { SystemSettings } from '../../types/api';
import { translateApiError } from '../../utils/errors';

interface AdminSettingsTabProps {
  settings: SystemSettings | null;
  onReload: () => Promise<void>;
  onError: (msg: string) => void;
}

export function AdminSettingsTab({ settings, onReload, onError }: AdminSettingsTabProps) {
  const { t } = useI18n();
  const [form, setForm] = useState<SystemSettings | null>(settings);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedToast, setSavedToast] = useState(false);

  useEffect(() => {
    if (settings) {
      setForm(settings);
    }
  }, [settings]);

  if (!form) {
    return (
      <div className="studio-surface flex items-center gap-2 p-6 text-sm text-[#5B616E] dark:text-[#9399A6]">
        <Loader2 className="h-4 w-4 animate-spin text-[#00A7D9]" />
        {t.common.loading}
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSavedToast(false);
    try {
      const payload: Partial<SystemSettings> = {
        default_max_active_grams: Number(form.default_max_active_grams),
        enforce_duration_limit: form.enforce_duration_limit,
        default_max_print_minutes: Number(form.default_max_print_minutes),
        allow_multiple_jobs_within_budget: form.allow_multiple_jobs_within_budget,
        max_upload_mb: Number(form.max_upload_mb),
        fdm_monster_mode: form.fdm_monster_mode,
        fdm_monster_url: form.fdm_monster_url,
        slicer_mode: form.slicer_mode,
        orca_cli_path: form.orca_cli_path,
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

  return (
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
              step="10"
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
              value={form.slicer_mode}
              onChange={(e) =>
                setForm({ ...form, slicer_mode: e.target.value as 'mock' | 'orcaslicer' })
              }
              className="studio-input"
            >
              <option value="mock">{t.admin.settings.modeMock}</option>
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
              value={form.fdm_monster_mode}
              onChange={(e) =>
                setForm({
                  ...form,
                  fdm_monster_mode: e.target.value as 'mock' | 'live',
                })
              }
              className="studio-input"
            >
              <option value="mock">{t.admin.settings.modeMock}</option>
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
  );
}
