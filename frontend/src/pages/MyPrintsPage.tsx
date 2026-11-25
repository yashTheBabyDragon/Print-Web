import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Plus,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { emitJobsUpdated } from '../hooks/usePrintNotifications';
import { formatMinutes, useI18n } from '../i18n';
import type { JobDetail, JobStatus } from '../types/api';
import { translateApiError } from '../utils/errors';
import { JobStatusBadge } from '../components/StatusBadge';

interface MyPrintsPageProps {
  onGoToPrint: () => void;
}

const CANCELLABLE_STATUSES: JobStatus[] = ['PENDING_APPROVAL', 'QUEUED', 'PRINTING'];
const DEV_COMPLETABLE_STATUSES: JobStatus[] = ['QUEUED', 'PRINTING'];

export function MyPrintsPage({ onGoToPrint }: MyPrintsPageProps) {
  const { user, authMode, setUser } = useAuth();
  const { lang, t } = useI18n();

  const [jobs, setJobs] = useState<JobDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyJobId, setBusyJobId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadMine = useCallback(async () => {
    setError(null);
    try {
      const res = await api.getMyJobs();
      setJobs(res.jobs);
      setUser(res.user);
      emitJobsUpdated(res.jobs);
    } catch (err) {
      setError(translateApiError(err, t));
    } finally {
      setLoading(false);
    }
  }, [setUser, t]);

  useEffect(() => {
    loadMine();
  }, [loadMine]);

  const handleCancel = async (jobId: number) => {
    setBusyJobId(jobId);
    setError(null);
    try {
      await api.cancelJob(jobId);
      await loadMine();
    } catch (err) {
      setError(translateApiError(err, t));
    } finally {
      setBusyJobId(null);
    }
  };

  const handleDevComplete = async (jobId: number) => {
    setBusyJobId(jobId);
    setError(null);
    try {
      await api.devCompleteJob(jobId);
      await loadMine();
    } catch (err) {
      setError(translateApiError(err, t));
    } finally {
      setBusyJobId(null);
    }
  };

  const used = user?.active_grams_used ?? 0;
  const max = user?.effective_max_active_grams ?? 100;
  const pct = max > 0 ? Math.min(100, (used / max) * 100) : 0;
  const canDevComplete = Boolean(authMode?.dev_mode || authMode?.fdm_mode === 'mock');

  return (
    <div className="mx-auto max-w-5xl space-y-5 px-4 py-5 sm:space-y-6 sm:px-6 sm:py-8">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-[#111318] dark:text-[#F4F5F7] sm:text-2xl">
            {t.myPrints.title}
          </h1>
          <p className="mt-1 text-sm text-[#5B616E] dark:text-[#9399A6]">
            {t.myPrints.subtitle}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
          <button type="button" onClick={loadMine} className="btn-secondary w-full sm:w-auto">
            <RefreshCw className="h-4 w-4 shrink-0" />
            <span>{t.common.refresh}</span>
          </button>
          <button type="button" onClick={onGoToPrint} className="btn-primary w-full sm:w-auto">
            <Plus className="h-4 w-4 shrink-0" />
            <span>{t.myPrints.goToPrint}</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-xl bg-rose-500/10 px-4 py-3 text-sm text-rose-700 dark:text-rose-300">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Unified Active Budget Strip */}
      {user && (
        <div className="studio-surface p-4 sm:p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-sm font-medium text-[#111318] dark:text-[#F4F5F7]">
              {t.myPrints.activeWeightTitle}
            </span>
            <span className="font-mono text-sm font-semibold tabular-nums text-[#111318] dark:text-[#F4F5F7]">
              {used.toFixed(1)} / {max.toFixed(0)} {t.common.grams}
            </span>
          </div>

          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-[#EFEFF3] dark:bg-[#1D2027]">
            <div
              className={`h-full rounded-full transition-[width] duration-200 ${
                pct >= 95 ? 'bg-rose-500' : pct >= 80 ? 'bg-amber-500' : 'bg-[#00A7D9]'
              }`}
              style={{ width: `${pct}%` }}
            />
          </div>

          <div className="mt-3 flex flex-col gap-1.5 text-xs text-[#5B616E] dark:text-[#9399A6] sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-2">
            <span>{t.myPrints.activeWeightHelp}</span>
            <span className="font-mono tabular-nums">
              {t.myPrints.durationPolicyTitle}:{' '}
              {user.enforce_duration_limit
                ? t.myPrints.durationPolicyEnabled
                    .replace('{minutes}', String(user.effective_max_print_minutes))
                    .replace('{hours}', formatMinutes(user.effective_max_print_minutes, lang))
                : t.myPrints.durationPolicyDisabled}
            </span>
          </div>
        </div>
      )}

      {/* Grouped Jobs List */}
      {loading ? (
        <div className="studio-surface flex items-center justify-center gap-2 py-14 text-sm text-[#5B616E] dark:text-[#9399A6]">
          <Loader2 className="h-4 w-4 animate-spin text-[#00A7D9]" />
          {t.common.loading}
        </div>
      ) : jobs.length === 0 ? (
        <div className="studio-surface p-8 text-center sm:p-12">
          <p className="text-sm text-[#5B616E] dark:text-[#9399A6]">{t.myPrints.emptyJobs}</p>
          <button type="button" onClick={onGoToPrint} className="btn-primary mt-4">
            {t.myPrints.goToPrint}
          </button>
        </div>
      ) : (
        <div className="studio-surface divide-y divide-black/[0.06] overflow-hidden dark:divide-white/[0.07]">
          {jobs.map((job) => {
            const isBusy = busyJobId === job.id;
            const canCancel = CANCELLABLE_STATUSES.includes(job.status);
            const canComplete = canDevComplete && DEV_COMPLETABLE_STATUSES.includes(job.status);

            return (
              <div
                key={job.id}
                className="flex flex-col justify-between gap-3.5 px-4 py-4 sm:flex-row sm:items-center sm:gap-4 sm:px-5"
              >
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    <span className="font-mono text-xs tabular-nums text-[#8A909E]">
                      #{job.id}
                    </span>
                    <span className="min-w-0 max-w-full truncate text-sm font-semibold text-[#111318] dark:text-[#F4F5F7]">
                      {job.original_filename || job.filename || `Job #${job.id}`}
                    </span>
                    <JobStatusBadge status={job.status} />
                  </div>

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums text-[#5B616E] dark:text-[#9399A6]">
                    <span className="font-medium text-[#111318] dark:text-[#E2E5EC]">
                      {job.printer_name || `#${job.printer_id}`}
                    </span>
                    {job.filament_name && (
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full border border-black/15 dark:border-white/20"
                          style={{ backgroundColor: job.filament_color_hex || '#00A7D9' }}
                        />
                        <span>{job.filament_name}</span>
                      </span>
                    )}
                    {job.estimated_grams != null && (
                      <span className="font-mono">
                        {job.estimated_grams.toFixed(1)} {t.common.grams}
                      </span>
                    )}
                    {job.estimated_minutes != null && (
                      <span className="font-mono">{formatMinutes(job.estimated_minutes, lang)}</span>
                    )}
                    {job.layer_count != null && (
                      <span className="font-mono">
                        {job.layer_count} {t.common.layers}
                      </span>
                    )}
                  </div>

                  {job.student_note && (
                    <p className="break-words text-xs text-[#5B616E] dark:text-[#9399A6]">
                      {t.myPrints.studentNoteLabel}: {job.student_note}
                    </p>
                  )}
                  {job.admin_note && (
                    <p className="break-words text-xs text-[#007BA3] dark:text-[#38C6F4]">
                      {t.myPrints.adminNoteLabel}: {job.admin_note}
                    </p>
                  )}
                </div>

                {(canCancel || canComplete) && (
                  <div className="flex flex-col gap-2 sm:shrink-0 sm:flex-row sm:flex-wrap sm:items-center">
                    {canComplete && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => handleDevComplete(job.id)}
                        className="btn-secondary w-full px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400 sm:w-auto sm:py-1.5"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                        <span>{isBusy ? t.myPrints.devCompleting : t.myPrints.devCompleteBtn}</span>
                      </button>
                    )}
                    {canCancel && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => handleCancel(job.id)}
                        className="btn-ghost w-full border border-rose-500/20 px-3 py-2 text-xs text-rose-600 hover:bg-rose-500/10 hover:text-rose-700 dark:text-rose-400 sm:w-auto sm:border-transparent sm:py-1.5"
                      >
                        <XCircle className="h-3.5 w-3.5 shrink-0" />
                        <span>{isBusy ? t.myPrints.cancelling : t.myPrints.cancelBtn}</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
