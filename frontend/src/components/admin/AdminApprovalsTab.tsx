import { useState } from 'react';
import { Check, ShieldCheck, UserCheck, X } from 'lucide-react';
import { api } from '../../api/client';
import { formatMinutes, useI18n } from '../../i18n';
import type {
  ApprovalsResponse,
  JobDetail,
  PendingAccountRequest,
  TeacherClass,
} from '../../types/api';
import { translateApiError } from '../../utils/errors';
import { JobStatusBadge } from '../StatusBadge';

interface AdminApprovalsTabProps {
  approvals: ApprovalsResponse;
  accountRequests: PendingAccountRequest[];
  classes: TeacherClass[];
  isSuperAdmin: boolean;
  canApproveJobs?: boolean;
  canApproveAccounts?: boolean;
  canAdjustQuotas?: boolean;
  onReload: () => Promise<void>;
  onError: (msg: string) => void;
}

export function AdminApprovalsTab({
  approvals,
  accountRequests,
  classes,
  isSuperAdmin,
  canApproveJobs = true,
  canApproveAccounts = true,
  canAdjustQuotas = true,
  onReload,
  onError,
}: AdminApprovalsTabProps) {
  const { lang, t } = useI18n();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [busyAccountId, setBusyAccountId] = useState<number | null>(null);
  const [classSelections, setClassSelections] = useState<Record<number, string>>({});
  const [drafts, setDrafts] = useState<
    Record<number, { grams: string; minutes: string; note: string }>
  >({});

  const pending = approvals.pending;
  const history = approvals.history;

  const getDraft = (job: JobDetail) =>
    drafts[job.id] ?? {
      grams: job.estimated_grams ? String(Math.ceil(job.estimated_grams / 50) * 50 + 50) : '250',
      minutes: job.estimated_minutes
        ? String(Math.ceil(job.estimated_minutes / 60) * 60 + 60)
        : '600',
      note: '',
    };

  const updateDraft = (
    jobId: number,
    job: JobDetail,
    patch: Partial<{ grams: string; minutes: string; note: string }>
  ) => {
    const current = getDraft(job);
    setDrafts((prev) => ({
      ...prev,
      [jobId]: { ...current, ...patch },
    }));
  };

  const handleAccountDecision = async (
    req: PendingAccountRequest,
    decision: 'approve' | 'reject'
  ) => {
    setBusyAccountId(req.id);
    try {
      const selectedClassValue = classSelections[req.id] ?? '';
      await api.adminDecideAccountRequest(req.id, {
        decision,
        class_id: selectedClassValue ? Number(selectedClassValue) : null,
      });
      await onReload();
    } catch (err) {
      onError(translateApiError(err, t));
    } finally {
      setBusyAccountId(null);
    }
  };

  const handleDecision = async (
    job: JobDetail,
    decision: 'approve_once' | 'approve_and_raise' | 'reject'
  ) => {
    const d = getDraft(job);
    setBusyId(job.id);
    try {
      await api.adminDecideApproval(job.id, {
        decision,
        new_max_active_grams:
          decision === 'approve_and_raise' && d.grams ? Number(d.grams) : undefined,
        new_max_print_minutes:
          decision === 'approve_and_raise' && d.minutes ? Number(d.minutes) : undefined,
        admin_note: d.note.trim() || undefined,
      });
      await onReload();
    } catch (err) {
      onError(translateApiError(err, t));
    } finally {
      setBusyId(null);
    }
  };

  const formatTimestamp = (iso: string) => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString(lang === 'fr' ? 'fr-CA' : 'en-CA', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  };

  return (
    <div className="space-y-8">
      {/* Pending Account Requests Section */}
      {canApproveAccounts && (
      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold text-[#111318] dark:text-[#F4F5F7]">
            {t.admin.accountRequests.title} ({accountRequests.length})
          </h2>
          <p className="mt-0.5 text-xs text-[#5B616E] dark:text-[#9399A6]">
            {t.admin.accountRequests.subtitle}
          </p>
        </div>

        {accountRequests.length === 0 ? (
          <div className="studio-surface p-8 text-center text-sm text-[#5B616E] dark:text-[#9399A6]">
            {t.admin.accountRequests.noRequests}
          </div>
        ) : (
          <div className="space-y-3">
            {accountRequests.map((req) => {
              const isBusy = busyAccountId === req.id;
              const teacherClasses = (
                req.requested_teacher_id != null
                  ? classes.filter((c) => c.teacher_id === req.requested_teacher_id)
                  : classes
              ).filter((c) => !c.is_default_individual);

              const selectedClassValue = classSelections[req.id] ?? '';

              return (
                <div
                  key={req.id}
                  className="studio-surface flex flex-col gap-4 p-5 lg:flex-row lg:items-center lg:justify-between"
                >
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <UserCheck className="h-4 w-4 text-[#00A7D9]" />
                      <span className="text-sm font-semibold text-[#111318] dark:text-[#F4F5F7]">
                        {req.name}
                      </span>
                      <span className="studio-subtle px-2 py-0.5 font-mono text-xs tabular-nums text-[#5B616E] dark:text-[#9399A6]">
                        {req.da}
                      </span>
                      {req.requested_teacher_name && (
                        <span className="rounded-full bg-[#00A7D9]/12 px-2.5 py-0.5 text-[11px] font-medium text-[#007BA3] dark:text-[#38C6F4]">
                          {t.admin.accountRequests.requestedTeacher}:{' '}
                          {req.requested_teacher_name}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-[#5B616E] dark:text-[#9399A6]">
                      {t.admin.accountRequests.requestedAt}: {formatTimestamp(req.created_at)}
                    </div>
                  </div>

                  <div className="flex flex-col gap-2.5 sm:flex-row sm:items-end">
                    <div className="min-w-[220px]">
                      <label className="mb-1 block text-[11px] font-medium text-[#5B616E] dark:text-[#9399A6]">
                        {t.admin.accountRequests.targetClassLabel}
                      </label>
                      <select
                        value={selectedClassValue}
                        disabled={isBusy}
                        onChange={(e) =>
                          setClassSelections((prev) => ({
                            ...prev,
                            [req.id]: e.target.value,
                          }))
                        }
                        className="studio-input py-1.5 text-xs"
                      >
                        <option value="">
                          {lang === 'fr'
                            ? 'Individuel / Hors-classe (auto)'
                            : 'Individual / Unlisted (auto)'}
                        </option>
                        {teacherClasses.map((cls) => (
                          <option key={cls.id} value={String(cls.id)}>
                            {cls.name}
                            {cls.code ? ` (${cls.code})` : ''}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => handleAccountDecision(req, 'reject')}
                        className="btn-danger py-1.5 text-xs"
                      >
                        <X className="h-3.5 w-3.5" />
                        {t.admin.accountRequests.rejectBtn}
                      </button>
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => handleAccountDecision(req, 'approve')}
                        className="btn-primary py-1.5 text-xs"
                      >
                        <Check className="h-3.5 w-3.5" />
                        {t.admin.accountRequests.approveBtn}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
      )}

      {/* Print Approval Requests Section */}
      {canApproveJobs && (
      <>
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-[#111318] dark:text-[#F4F5F7]">
            {t.admin.approvals.pendingTitle} ({pending.length})
          </h2>
          {!isSuperAdmin && (
            <span className="text-xs text-[#5B616E] dark:text-[#9399A6]">
              {t.admin.approvals.teacherScopeNote}
            </span>
          )}
        </div>

        {pending.length === 0 ? (
          <div className="studio-surface p-10 text-center text-sm text-[#5B616E] dark:text-[#9399A6]">
            {t.admin.approvals.noPending}
          </div>
        ) : (
          <div className="space-y-4">
            {pending.map((job) => {
              const d = getDraft(job);
              const isBusy = busyId === job.id;

              return (
                <div key={job.id} className="studio-surface p-5 space-y-4">
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <span className="font-mono text-xs tabular-nums text-[#8A909E]">
                        #{job.id}
                      </span>
                      <span className="text-sm font-semibold text-[#111318] dark:text-[#F4F5F7]">
                        {job.original_filename || job.filename || `Job #${job.id}`}
                      </span>
                      <JobStatusBadge status={job.status} />
                      <span className="rounded-full bg-[#00A7D9]/12 px-2.5 py-0.5 text-[11px] font-medium text-[#007BA3] dark:text-[#38C6F4]">
                        {t.admin.approvals.assignedTeacher}:{' '}
                        {job.teacher_name || t.admin.approvals.unassignedTeacher}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs tabular-nums text-[#5B616E] dark:text-[#9399A6]">
                      <span>
                        {t.admin.approvals.student}:{' '}
                        <strong className="font-medium text-[#111318] dark:text-[#F4F5F7]">
                          {job.user_name || ''} ({job.user_da || `#${job.user_id}`})
                        </strong>
                      </span>
                      <span>{job.printer_name || `#${job.printer_id}`}</span>
                      {job.filament_name && <span>{job.filament_name}</span>}
                      {job.estimated_grams != null && (
                        <span className="font-mono font-semibold text-amber-700 dark:text-amber-400">
                          {job.estimated_grams.toFixed(1)} g
                        </span>
                      )}
                      {job.estimated_minutes != null && (
                        <span className="font-mono font-semibold text-amber-700 dark:text-amber-400">
                          {formatMinutes(job.estimated_minutes, lang)}
                        </span>
                      )}
                    </div>
                    {job.student_note && (
                      <p className="studio-subtle px-3 py-2 text-xs text-[#111318] dark:text-[#F4F5F7]">
                        « {job.student_note} »
                      </p>
                    )}
                  </div>

                  <div className="grid grid-cols-1 gap-3 border-t border-black/[0.07] pt-4 dark:border-white/[0.08] md:grid-cols-12">
                    {canAdjustQuotas && (
                      <>
                        <div className="md:col-span-3">
                          <label className="mb-1 block text-[11px] font-medium text-[#5B616E] dark:text-[#9399A6]">
                            {t.admin.approvals.newGramsLabel}
                          </label>
                          <input
                            type="number"
                            value={d.grams}
                            onChange={(e) => updateDraft(job.id, job, { grams: e.target.value })}
                            className="studio-input py-1.5 font-mono text-xs tabular-nums"
                          />
                        </div>
                        <div className="md:col-span-3">
                          <label className="mb-1 block text-[11px] font-medium text-[#5B616E] dark:text-[#9399A6]">
                            {t.admin.approvals.newMinutesLabel}
                          </label>
                          <input
                            type="number"
                            value={d.minutes}
                            onChange={(e) => updateDraft(job.id, job, { minutes: e.target.value })}
                            className="studio-input py-1.5 font-mono text-xs tabular-nums"
                          />
                        </div>
                      </>
                    )}
                    <div className={canAdjustQuotas ? 'md:col-span-6' : 'md:col-span-12'}>
                      <label className="mb-1 block text-[11px] font-medium text-[#5B616E] dark:text-[#9399A6]">
                        {t.admin.approvals.adminNoteLabel}
                      </label>
                      <input
                        type="text"
                        value={d.note}
                        placeholder={t.admin.approvals.adminNotePlaceholder}
                        onChange={(e) => updateDraft(job.id, job, { note: e.target.value })}
                        className="studio-input py-1.5 text-xs"
                      />
                    </div>

                    <div className="flex flex-wrap justify-end gap-2 md:col-span-12">
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => handleDecision(job, 'reject')}
                        className="btn-danger py-1.5 text-xs"
                      >
                        <X className="h-3.5 w-3.5" />
                        {t.admin.approvals.reject}
                      </button>
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => handleDecision(job, 'approve_once')}
                        className="btn-secondary py-1.5 text-xs"
                      >
                        <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                        {t.admin.approvals.approveOnce}
                      </button>
                      {canAdjustQuotas && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => handleDecision(job, 'approve_and_raise')}
                          className="btn-primary py-1.5 text-xs"
                        >
                          <ShieldCheck className="h-3.5 w-3.5" />
                          {t.admin.approvals.approveAndRaise}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {history.length > 0 && (
        <section className="space-y-2.5">
          <h3 className="text-sm font-semibold text-[#5B616E] dark:text-[#9399A6]">
            {t.admin.approvals.historyTitle}
          </h3>
          <div className="studio-surface divide-y divide-black/[0.06] overflow-hidden dark:divide-white/[0.07]">
            {history.map((job) => (
              <div
                key={job.id}
                className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-xs"
              >
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="font-mono tabular-nums text-[#8A909E]">#{job.id}</span>
                  <span className="font-medium text-[#111318] dark:text-[#F4F5F7]">
                    {job.original_filename || job.filename}
                  </span>
                  <span className="font-mono tabular-nums text-[#5B616E] dark:text-[#9399A6]">
                    ({job.user_da || `#${job.user_id}`})
                  </span>
                  <JobStatusBadge status={job.status} />
                  {job.teacher_name && (
                    <span className="rounded-full bg-[#00A7D9]/12 px-2 py-0.5 text-[10px] font-medium text-[#007BA3] dark:text-[#38C6F4]">
                      {job.teacher_name}
                    </span>
                  )}
                </div>
                {job.admin_note && (
                  <span className="text-[#5B616E] dark:text-[#9399A6]">{job.admin_note}</span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
      </>
      )}
    </div>
  );
}
