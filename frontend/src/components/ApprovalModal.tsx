import React, { useEffect, useMemo, useRef, useState } from 'react';
import { UserCheck, X } from 'lucide-react';
import { api } from '../api/client';
import { useI18n } from '../i18n';
import type { StudentTeacher, TeacherPublic } from '../types/api';

interface ApprovalModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (note: string, teacherId: number | null) => Promise<void>;
  submitting: boolean;
  exceedsGramsBy: number;
  exceedsMinutesBy: number;
  teachers: StudentTeacher[];
}

export function ApprovalModal({
  open,
  onClose,
  onSubmit,
  submitting,
  exceedsGramsBy,
  exceedsMinutesBy,
  teachers,
}: ApprovalModalProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const pressedOutsideRef = useRef(false);
  const [note, setNote] = useState('');
  const [fallbackTeachers, setFallbackTeachers] = useState<TeacherPublic[]>([]);
  const [selectedTeacherId, setSelectedTeacherId] = useState<number | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    if (!open || teachers.length > 0) return;
    let active = true;
    api
      .getPublicTeachers()
      .then((list) => {
        if (active) setFallbackTeachers(list);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [open, teachers.length]);

  const teacherOptions = useMemo(() => {
    if (teachers.length > 0) {
      return teachers.map((tc) => ({
        id: tc.id,
        label: tc.classes.length > 0 ? `${tc.name} — ${tc.classes.join(', ')}` : tc.name,
        pill: tc.classes.length > 0 ? `${tc.name} (${tc.classes.join(', ')})` : tc.name,
      }));
    }
    return fallbackTeachers.map((ft) => ({
      id: ft.id,
      label: ft.name,
      pill: ft.name,
    }));
  }, [teachers, fallbackTeachers]);

  useEffect(() => {
    if (!open) return;
    if (teacherOptions.length > 0) {
      setSelectedTeacherId((prev) =>
        prev != null && teacherOptions.some((o) => o.id === prev) ? prev : teacherOptions[0].id
      );
    } else {
      setSelectedTeacherId(null);
    }
  }, [open, teacherOptions]);

  const isOutsideRect = (ev: React.PointerEvent<HTMLDialogElement>) => {
    const dialog = dialogRef.current;
    if (!dialog) return false;
    const r = dialog.getBoundingClientRect();
    return (
      ev.clientX < r.left ||
      ev.clientX > r.right ||
      ev.clientY < r.top ||
      ev.clientY > r.bottom
    );
  };

  const handlePointerDown = (ev: React.PointerEvent<HTMLDialogElement>) => {
    pressedOutsideRef.current = isOutsideRect(ev);
  };

  const handlePointerUp = (ev: React.PointerEvent<HTMLDialogElement>) => {
    if (pressedOutsideRef.current && isOutsideRect(ev) && !('closedBy' in HTMLDialogElement.prototype)) {
      dialogRef.current?.close();
    }
    pressedOutsideRef.current = false;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const resolvedTeacherId =
      teachers.length === 1 ? teachers[0].id : selectedTeacherId ?? teacherOptions[0]?.id ?? null;
    await onSubmit(note.trim(), resolvedTeacherId);
    setNote('');
  };

  const singleTeacherMode = teachers.length === 1;
  const requiresTeacherSelect = !singleTeacherMode && teacherOptions.length > 0;

  return (
    <dialog
      ref={dialogRef}
      {...({ closedby: 'any' } as Record<string, string>)}
      aria-labelledby="approval-dialog-title"
      onClose={onClose}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      className="pw-dialog w-full max-w-md"
    >
      <div className="p-6">
        <div className="flex items-start justify-between gap-3">
          <h1
            id="approval-dialog-title"
            className="text-base font-semibold tracking-tight text-[#111318] dark:text-[#F4F5F7]"
          >
            {t.workspace.approvalModalTitle}
          </h1>
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            aria-label={t.common.close}
            className="btn-ghost p-1"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mt-2 text-sm leading-relaxed text-[#5B616E] dark:text-[#9399A6]">
          {t.workspace.approvalModalDesc}
        </p>

        {(exceedsGramsBy > 0 || exceedsMinutesBy > 0) && (
          <div className="mt-4 space-y-1 rounded-xl bg-amber-500/10 px-3.5 py-2.5 text-xs font-medium text-amber-800 dark:text-amber-300">
            {exceedsGramsBy > 0 && (
              <div className="tabular-nums">
                {t.workspace.overGrams} +{exceedsGramsBy.toFixed(1)} {t.common.grams}
              </div>
            )}
            {exceedsMinutesBy > 0 && (
              <div className="tabular-nums">
                {t.workspace.overMinutes} +{Math.round(exceedsMinutesBy)} {t.common.minutes}
              </div>
            )}
          </div>
        )}

        {singleTeacherMode && teacherOptions[0] && (
          <div className="mt-4 flex items-center gap-2 rounded-xl bg-[#00A7D9]/10 px-3.5 py-2.5 text-xs font-medium text-[#007BA3] dark:text-[#38C6F4]">
            <UserCheck className="h-3.5 w-3.5 shrink-0" />
            <span>
              {t.workspace.approvalRoutedTo}:{' '}
              <strong className="font-semibold">{teacherOptions[0].pill}</strong>
            </span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          {requiresTeacherSelect && (
            <div>
              <label
                htmlFor="approval-teacher"
                className="mb-1.5 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]"
              >
                {t.workspace.approvalTeacherLabel}
              </label>
              <select
                id="approval-teacher"
                required
                value={selectedTeacherId ?? ''}
                onChange={(e) =>
                  setSelectedTeacherId(e.target.value ? Number(e.target.value) : null)
                }
                className="studio-input"
              >
                {teacherOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label
              htmlFor="approval-note"
              className="mb-1.5 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]"
            >
              {t.workspace.approvalNoteLabel}
            </label>
            <textarea
              id="approval-note"
              rows={3}
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t.workspace.approvalNotePlaceholder}
              className="studio-input resize-none"
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              className="btn-secondary"
            >
              {t.common.cancel}
            </button>
            <button
              type="submit"
              disabled={submitting || (requiresTeacherSelect && selectedTeacherId == null)}
              className="btn-primary"
            >
              {submitting ? t.workspace.submittingBtn : t.workspace.approvalSendBtn}
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
}
