import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  KeyRound,
  Plus,
  Power,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import type { AdminTeacher } from '../../types/api';
import { translateApiError } from '../../utils/errors';

interface AdminTeachersTabProps {
  teachers: AdminTeacher[];
  onReload: () => Promise<void>;
  onError: (msg: string) => void;
}

export function AdminTeachersTab({
  teachers,
  onReload,
  onError,
}: AdminTeachersTabProps) {
  const { lang, t } = useI18n();

  const [identifier, setIdentifier] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [creating, setCreating] = useState(false);

  const [busyId, setBusyId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  const resetDialogRef = useRef<HTMLDialogElement | null>(null);
  const pressedOutsideRef = useRef(false);
  const [resetResult, setResetResult] = useState<{ da: string; temp_password: string } | null>(
    null
  );
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const dialog = resetDialogRef.current;
    if (!dialog) return;
    if (resetResult && !dialog.open) {
      dialog.showModal();
    } else if (!resetResult && dialog.open) {
      dialog.close();
    }
  }, [resetResult]);

  const isOutsideRect = (ev: React.PointerEvent<HTMLDialogElement>) => {
    const dialog = resetDialogRef.current;
    if (!dialog) return false;
    const r = dialog.getBoundingClientRect();
    return (
      ev.clientX < r.left ||
      ev.clientX > r.right ||
      ev.clientY < r.top ||
      ev.clientY > r.bottom
    );
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedId = identifier.trim();
    const trimmedName = name.trim();
    if (!trimmedId) {
      onError(t.errors.invalidIdentifier);
      return;
    }
    if (!trimmedName) {
      onError(t.errors.invalidName);
      return;
    }
    if (password.length < 4) {
      onError(t.errors.invalidPassword);
      return;
    }

    setCreating(true);
    try {
      await api.adminCreateTeacher({
        identifier: trimmedId,
        name: trimmedName,
        password,
      });
      setIdentifier('');
      setName('');
      setPassword('');
      await onReload();
    } catch (err) {
      onError(translateApiError(err, t));
    } finally {
      setCreating(false);
    }
  };

  const handleToggleActive = async (teacher: AdminTeacher) => {
    setBusyId(teacher.id);
    try {
      await api.adminUpdateTeacher(teacher.id, { is_active: !teacher.is_active });
      await onReload();
    } catch (err) {
      onError(translateApiError(err, t));
    } finally {
      setBusyId(null);
    }
  };

  const handleResetPassword = async (teacherId: number) => {
    setBusyId(teacherId);
    try {
      const res = await api.adminResetTeacherPassword(teacherId);
      setCopied(false);
      setResetResult(res);
    } catch (err) {
      onError(translateApiError(err, t));
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteTeacher = async (teacherId: number) => {
    setBusyId(teacherId);
    try {
      await api.adminDeleteTeacher(teacherId);
      setConfirmDeleteId(null);
      await onReload();
    } catch (err) {
      onError(translateApiError(err, t));
    } finally {
      setBusyId(null);
    }
  };

  const handleCopyTempPassword = async () => {
    if (!resetResult) return;
    await navigator.clipboard.writeText(resetResult.temp_password);
    setCopied(true);
  };

  return (
    <div className="space-y-6">
      {/* Header + Create Teacher Form */}
      <div className="studio-surface p-5 space-y-4">
        <div>
          <h2 className="text-base font-semibold text-[#111318] dark:text-[#F4F5F7]">
            {t.admin.teachers.title}
          </h2>
          <p className="mt-0.5 text-xs text-[#5B616E] dark:text-[#9399A6]">
            {t.admin.teachers.subtitle}
          </p>
        </div>

        <form
          onSubmit={handleCreate}
          className="grid grid-cols-1 gap-3 border-t border-black/[0.06] pt-4 dark:border-white/[0.07] sm:grid-cols-12 sm:items-end"
        >
          <div className="sm:col-span-4">
            <label className="mb-1 block text-[11px] font-medium text-[#5B616E] dark:text-[#9399A6]">
              {t.admin.teachers.identifierLabel}
            </label>
            <input
              type="text"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder={t.admin.teachers.identifierPlaceholder}
              className="studio-input py-1.5 text-xs"
              required
            />
          </div>

          <div className="sm:col-span-4">
            <label className="mb-1 block text-[11px] font-medium text-[#5B616E] dark:text-[#9399A6]">
              {t.admin.teachers.nameLabel}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t.admin.teachers.namePlaceholder}
              className="studio-input py-1.5 text-xs"
              required
            />
          </div>

          <div className="sm:col-span-2">
            <label className="mb-1 block text-[11px] font-medium text-[#5B616E] dark:text-[#9399A6]">
              {t.admin.teachers.passwordLabel}
            </label>
            <input
              type="password"
              minLength={4}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••"
              className="studio-input py-1.5 text-xs"
              required
            />
          </div>

          <div className="sm:col-span-2">
            <button
              type="submit"
              disabled={creating}
              className="btn-primary w-full py-1.5 text-xs"
            >
              <Plus className="h-3.5 w-3.5" />
              {t.admin.teachers.createBtn}
            </button>
          </div>
        </form>
      </div>

      {/* Teachers Cards */}
      {teachers.length === 0 ? (
        <div className="studio-surface p-10 text-center text-sm text-[#5B616E] dark:text-[#9399A6]">
          {t.admin.teachers.noTeachers}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {teachers.map((teacher) => {
            const isBusy = busyId === teacher.id;
            const isConfirmingDelete = confirmDeleteId === teacher.id;

            return (
              <div key={teacher.id} className="studio-surface p-5 space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold text-[#111318] dark:text-[#F4F5F7]">
                        {teacher.name}
                      </h3>
                      <span className="studio-subtle px-2 py-0.5 font-mono text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                        {teacher.da}
                      </span>
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                          teacher.is_active
                            ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400'
                            : 'bg-rose-500/12 text-rose-700 dark:text-rose-400'
                        }`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            teacher.is_active ? 'bg-emerald-500' : 'bg-rose-500'
                          }`}
                        />
                        {teacher.is_active
                          ? t.admin.teachers.activeStatus
                          : t.admin.teachers.disabledStatus}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => handleToggleActive(teacher)}
                      className="btn-secondary px-3 py-1.5 text-xs"
                    >
                      <Power className="h-3.5 w-3.5" />
                      {teacher.is_active
                        ? t.admin.students.suspendedStatus
                        : t.admin.teachers.activeStatus}
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => handleResetPassword(teacher.id)}
                      className="btn-secondary px-3 py-1.5 text-xs"
                    >
                      <KeyRound className="h-3.5 w-3.5" />
                      {t.admin.teachers.resetPasswordBtn}
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() =>
                        setConfirmDeleteId(isConfirmingDelete ? null : teacher.id)
                      }
                      className="btn-ghost px-2.5 py-1.5 text-xs text-rose-600 hover:bg-rose-500/10 hover:text-rose-700 dark:text-rose-400 dark:hover:text-rose-300"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {t.admin.teachers.deleteBtn}
                    </button>
                  </div>
                </div>

                {/* Stats Row */}
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                  <div className="studio-subtle px-3 py-2">
                    <div className="text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                      {t.admin.teachers.classesCount}
                    </div>
                    <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-[#111318] dark:text-[#F4F5F7]">
                      {teacher.class_count}
                    </div>
                  </div>
                  <div className="studio-subtle px-3 py-2">
                    <div className="text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                      {t.admin.teachers.studentsCount}
                    </div>
                    <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-[#111318] dark:text-[#F4F5F7]">
                      {teacher.student_count}
                    </div>
                  </div>
                  <div className="studio-subtle px-3 py-2">
                    <div className="text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                      {t.admin.teachers.pendingPrints}
                    </div>
                    <div
                      className={`mt-0.5 font-mono text-sm font-semibold tabular-nums ${
                        teacher.pending_print_approvals > 0
                          ? 'text-amber-600 dark:text-amber-400'
                          : 'text-[#111318] dark:text-[#F4F5F7]'
                      }`}
                    >
                      {teacher.pending_print_approvals}
                    </div>
                  </div>
                  <div className="studio-subtle px-3 py-2">
                    <div className="text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                      {t.admin.teachers.pendingAccounts}
                    </div>
                    <div
                      className={`mt-0.5 font-mono text-sm font-semibold tabular-nums ${
                        teacher.pending_account_requests > 0
                          ? 'text-amber-600 dark:text-amber-400'
                          : 'text-[#111318] dark:text-[#F4F5F7]'
                      }`}
                    >
                      {teacher.pending_account_requests}
                    </div>
                  </div>
                </div>

                {/* Inline Delete Confirmation */}
                {isConfirmingDelete && (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-500/25 bg-rose-500/8 px-4 py-3 text-xs">
                    <div className="flex items-start gap-2.5 text-rose-800 dark:text-rose-200">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" />
                      <div className="space-y-0.5">
                        <div className="font-semibold">
                          {t.admin.teachers.deleteConfirm.replace('{name}', teacher.name)}
                        </div>
                        <div className="text-[11px] text-rose-700/90 dark:text-rose-300/90">
                          {lang === 'fr'
                            ? 'La suppression retire toutes ses classes et désactive les étudiants qui n’ont aucune autre classe.'
                            : 'Deleting removes all their classes and disables any orphaned students with no remaining classes.'}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => setConfirmDeleteId(null)}
                        className="btn-secondary px-3 py-1.5 text-xs"
                      >
                        {t.common.cancel}
                      </button>
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => handleDeleteTeacher(teacher.id)}
                        className="btn-danger px-3 py-1.5 text-xs"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        {t.common.confirm}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Native <dialog> Reset Password Result Modal */}
      <dialog
        ref={resetDialogRef}
        {...({ closedby: 'any' } as Record<string, string>)}
        aria-labelledby="teacher-reset-pw-dialog-title"
        onClose={() => setResetResult(null)}
        onPointerDown={(ev) => {
          pressedOutsideRef.current = isOutsideRect(ev);
        }}
        onPointerUp={(ev) => {
          if (
            pressedOutsideRef.current &&
            isOutsideRect(ev) &&
            !('closedBy' in HTMLDialogElement.prototype)
          ) {
            resetDialogRef.current?.close();
          }
          pressedOutsideRef.current = false;
        }}
        className="gg-dialog w-full max-w-sm"
      >
        {resetResult && (
          <div className="p-6">
            <div className="flex items-center justify-between">
              <h1
                id="teacher-reset-pw-dialog-title"
                className="text-base font-semibold text-[#111318] dark:text-[#F4F5F7]"
              >
                {t.admin.students.tempPasswordTitle}
              </h1>
              <button
                type="button"
                onClick={() => resetDialogRef.current?.close()}
                aria-label={t.common.close}
                className="btn-ghost p-1"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-[#5B616E] dark:text-[#9399A6]">
              {t.admin.teachers.tempPasswordDesc.replace('{da}', resetResult.da)}
            </p>
            <div className="studio-subtle mt-4 flex items-center justify-between gap-2 px-3.5 py-2.5">
              <span className="font-mono text-base font-semibold tracking-wider text-[#007BA3] dark:text-[#38C6F4]">
                {resetResult.temp_password}
              </span>
              <button
                type="button"
                onClick={handleCopyTempPassword}
                className="btn-secondary px-2.5 py-1 text-xs"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-emerald-500" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                {copied ? t.admin.students.copied : t.admin.students.copyPassword}
              </button>
            </div>
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                autoFocus
                onClick={() => resetDialogRef.current?.close()}
                className="btn-primary py-1.5 text-xs"
              >
                {t.common.close}
              </button>
            </div>
          </div>
        )}
      </dialog>
    </div>
  );
}
