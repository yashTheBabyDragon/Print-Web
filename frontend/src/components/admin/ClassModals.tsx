import React, { useEffect, useRef, useState } from 'react';
import { Check, Copy, Loader2, Plus, RotateCcw, Save, Upload, Users, X } from 'lucide-react';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import type {
  AdminTeacher,
  BudgetRefreshRequest,
  ClassBulkAddResult,
  ClassCsvResult,
  TeacherClass,
} from '../../types/api';
import { translateApiError } from '../../utils/errors';

function useDialogSync(ref: React.RefObject<HTMLDialogElement | null>, open: boolean) {
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [ref, open]);
}

function makeBackdropHandlers(ref: React.RefObject<HTMLDialogElement | null>) {
  let pressedOutside = false;
  const isOutside = (ev: React.PointerEvent<HTMLDialogElement>) => {
    const dialog = ref.current;
    if (!dialog) return false;
    const r = dialog.getBoundingClientRect();
    return (
      ev.clientX < r.left ||
      ev.clientX > r.right ||
      ev.clientY < r.top ||
      ev.clientY > r.bottom
    );
  };
  return {
    onPointerDown: (ev: React.PointerEvent<HTMLDialogElement>) => {
      pressedOutside = isOutside(ev);
    },
    onPointerUp: (ev: React.PointerEvent<HTMLDialogElement>) => {
      if (pressedOutside && isOutside(ev) && !('closedBy' in HTMLDialogElement.prototype)) {
        ref.current?.close();
      }
      pressedOutside = false;
    },
  };
}

interface CreateClassModalProps {
  open: boolean;
  onClose: () => void;
  canManageAllClasses: boolean;
  teachers: AdminTeacher[];
  onCreated: (created: TeacherClass) => Promise<void>;
  onError: (msg: string) => void;
}

export function CreateClassModal({
  open,
  onClose,
  canManageAllClasses,
  teachers,
  onCreated,
  onError,
}: CreateClassModalProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [defaultGrams, setDefaultGrams] = useState('');
  const [defaultMinutes, setDefaultMinutes] = useState('');
  const [teacherId, setTeacherId] = useState('');
  const [saving, setSaving] = useState(false);

  useDialogSync(dialogRef, open);

  useEffect(() => {
    if (open) {
      setName('');
      setCode('');
      setDefaultGrams('');
      setDefaultMinutes('');
      if (canManageAllClasses && teachers.length > 0) {
        setTeacherId((prev) => prev || String(teachers[0].id));
      }
    }
  }, [open, canManageAllClasses, teachers]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      const created = await api.adminCreateClass({
        name: name.trim(),
        code: code.trim() || null,
        default_max_active_grams: defaultGrams.trim() ? Number(defaultGrams) : null,
        default_max_print_minutes: defaultMinutes.trim() ? Number(defaultMinutes) : null,
        teacher_id: canManageAllClasses && teacherId ? Number(teacherId) : null,
      });
      await onCreated(created);
      onClose();
    } catch (err) {
      onError(translateApiError(err, t));
    } finally {
      setSaving(false);
    }
  };

  const backdrop = makeBackdropHandlers(dialogRef);

  return (
    <dialog
      ref={dialogRef}
      {...({ closedby: 'any' } as Record<string, string>)}
      aria-labelledby="create-class-modal-title"
      onClose={onClose}
      onPointerDown={backdrop.onPointerDown}
      onPointerUp={backdrop.onPointerUp}
      className="gg-dialog w-full max-w-md"
    >
      {open && (
        <form onSubmit={handleSubmit} className="space-y-4 p-6">
          <div className="flex items-center justify-between gap-2">
            <h2
              id="create-class-modal-title"
              className="text-base font-semibold text-[#111318] dark:text-[#F4F5F7]"
            >
              {t.admin.students.createClassTitle}
            </h2>
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              aria-label={t.common.close}
              className="btn-ghost p-1"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-3">
            <div>
              <label
                htmlFor="create-class-name"
                className="mb-1 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]"
              >
                {t.admin.students.classNameLabel}
              </label>
              <input
                id="create-class-name"
                type="text"
                autoFocus
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t.admin.students.classNamePlaceholder}
                className="studio-input text-sm"
              />
            </div>

            <div>
              <label
                htmlFor="create-class-code"
                className="mb-1 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]"
              >
                {t.admin.students.classCodeLabel}
              </label>
              <input
                id="create-class-code"
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={t.admin.students.classCodePlaceholder}
                className="studio-input font-mono text-sm"
              />
            </div>

            {canManageAllClasses && teachers.length > 0 && (
              <div>
                <label
                  htmlFor="create-class-teacher"
                  className="mb-1 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]"
                >
                  {t.admin.students.classTeacherLabel}
                </label>
                <select
                  id="create-class-teacher"
                  value={teacherId}
                  onChange={(e) => setTeacherId(e.target.value)}
                  className="studio-input text-sm"
                >
                  {teachers.map((tc) => (
                    <option key={tc.id} value={String(tc.id)}>
                      {tc.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="create-class-grams"
                  className="mb-1 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]"
                >
                  {t.admin.students.defaultMaxGramsLabel}
                </label>
                <input
                  id="create-class-grams"
                  type="number"
                  min={1}
                  step={1}
                  value={defaultGrams}
                  onChange={(e) => setDefaultGrams(e.target.value)}
                  placeholder={t.admin.students.globalDefaultPlaceholder}
                  className="studio-input font-mono text-sm tabular-nums"
                />
              </div>
              <div>
                <label
                  htmlFor="create-class-minutes"
                  className="mb-1 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]"
                >
                  {t.admin.students.defaultMaxMinutesLabel}
                </label>
                <input
                  id="create-class-minutes"
                  type="number"
                  min={1}
                  step={10}
                  value={defaultMinutes}
                  onChange={(e) => setDefaultMinutes(e.target.value)}
                  placeholder={t.admin.students.globalDefaultPlaceholder}
                  className="studio-input font-mono text-sm tabular-nums"
                />
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              className="btn-secondary"
            >
              {t.common.cancel}
            </button>
            <button type="submit" disabled={saving || !name.trim()} className="btn-primary">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              {t.admin.students.createClassBtn}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}

interface EditClassModalProps {
  targetClass: TeacherClass | null;
  onClose: () => void;
  onUpdated: () => Promise<void>;
  onError: (msg: string) => void;
}

export function EditClassModal({
  targetClass,
  onClose,
  onUpdated,
  onError,
}: EditClassModalProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [defaultGrams, setDefaultGrams] = useState('');
  const [defaultMinutes, setDefaultMinutes] = useState('');
  const [applyToStudents, setApplyToStudents] = useState(false);
  const [saving, setSaving] = useState(false);

  const open = targetClass !== null;
  useDialogSync(dialogRef, open);

  useEffect(() => {
    if (targetClass) {
      setName(targetClass.name);
      setCode(targetClass.code ?? '');
      setDefaultGrams(
        targetClass.default_max_active_grams != null
          ? String(targetClass.default_max_active_grams)
          : ''
      );
      setDefaultMinutes(
        targetClass.default_max_print_minutes != null
          ? String(targetClass.default_max_print_minutes)
          : ''
      );
      setApplyToStudents(false);
    }
  }, [targetClass]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetClass || !name.trim()) return;
    setSaving(true);
    try {
      await api.adminUpdateClass(targetClass.id, {
        name: name.trim(),
        code: code.trim() || null,
        default_max_active_grams: defaultGrams.trim() ? Number(defaultGrams) : null,
        default_max_print_minutes: defaultMinutes.trim() ? Number(defaultMinutes) : null,
        apply_budget_to_students: applyToStudents,
      });
      await onUpdated();
      onClose();
    } catch (err) {
      onError(translateApiError(err, t));
    } finally {
      setSaving(false);
    }
  };

  const backdrop = makeBackdropHandlers(dialogRef);

  return (
    <dialog
      ref={dialogRef}
      {...({ closedby: 'any' } as Record<string, string>)}
      aria-labelledby="edit-class-modal-title"
      onClose={onClose}
      onPointerDown={backdrop.onPointerDown}
      onPointerUp={backdrop.onPointerUp}
      className="gg-dialog w-full max-w-md"
    >
      {targetClass && (
        <form onSubmit={handleSubmit} className="space-y-4 p-6">
          <div className="flex items-center justify-between gap-2">
            <h2
              id="edit-class-modal-title"
              className="text-base font-semibold text-[#111318] dark:text-[#F4F5F7]"
            >
              {t.admin.students.editClassTitle}
            </h2>
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              aria-label={t.common.close}
              className="btn-ghost p-1"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-3">
            <div>
              <label
                htmlFor="edit-class-name"
                className="mb-1 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]"
              >
                {t.admin.students.classNameLabel}
              </label>
              <input
                id="edit-class-name"
                type="text"
                autoFocus
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="studio-input text-sm"
              />
            </div>

            <div>
              <label
                htmlFor="edit-class-code"
                className="mb-1 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]"
              >
                {t.admin.students.classCodeLabel}
              </label>
              <input
                id="edit-class-code"
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={t.admin.students.classCodePlaceholder}
                className="studio-input font-mono text-sm"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="edit-class-grams"
                  className="mb-1 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]"
                >
                  {t.admin.students.defaultMaxGramsLabel}
                </label>
                <input
                  id="edit-class-grams"
                  type="number"
                  min={1}
                  step={1}
                  value={defaultGrams}
                  onChange={(e) => setDefaultGrams(e.target.value)}
                  placeholder={t.admin.students.globalDefaultPlaceholder}
                  className="studio-input font-mono text-sm tabular-nums"
                />
              </div>
              <div>
                <label
                  htmlFor="edit-class-minutes"
                  className="mb-1 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]"
                >
                  {t.admin.students.defaultMaxMinutesLabel}
                </label>
                <input
                  id="edit-class-minutes"
                  type="number"
                  min={1}
                  step={10}
                  value={defaultMinutes}
                  onChange={(e) => setDefaultMinutes(e.target.value)}
                  placeholder={t.admin.students.globalDefaultPlaceholder}
                  className="studio-input font-mono text-sm tabular-nums"
                />
              </div>
            </div>

            <label className="flex cursor-pointer items-center gap-2 rounded-xl bg-black/[0.03] px-3 py-2.5 text-xs text-[#111318] dark:bg-white/[0.04] dark:text-[#F4F5F7]">
              <input
                type="checkbox"
                checked={applyToStudents}
                onChange={(e) => setApplyToStudents(e.target.checked)}
                className="h-4 w-4 rounded"
              />
              <span>{t.admin.students.applyBudgetToStudents}</span>
            </label>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              className="btn-secondary"
            >
              {t.common.cancel}
            </button>
            <button type="submit" disabled={saving || !name.trim()} className="btn-primary">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {t.common.save}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}

interface BulkAddStudentsModalProps {
  targetClass: TeacherClass | null;
  onClose: () => void;
  onImported: () => Promise<void>;
  onError: (msg: string) => void;
}

export function BulkAddStudentsModal({
  targetClass,
  onClose,
  onImported,
  onError,
}: BulkAddStudentsModalProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [rawText, setRawText] = useState('');
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<ClassBulkAddResult | null>(null);
  const [csvResult, setCsvResult] = useState<ClassCsvResult | null>(null);

  const open = targetClass !== null;
  useDialogSync(dialogRef, open);

  useEffect(() => {
    if (open) {
      setRawText('');
      setCsvFile(null);
      setBulkResult(null);
      setCsvResult(null);
    }
  }, [open, targetClass?.id]);

  const handleBulkSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetClass || !rawText.trim()) return;
    setBusy(true);
    setBulkResult(null);
    setCsvResult(null);
    try {
      const res = await api.adminBulkAddClassStudents(targetClass.id, { raw_text: rawText });
      setBulkResult(res);
      if (res.added > 0 || res.reactivated > 0) {
        setRawText('');
        await onImported();
      }
    } catch (err) {
      onError(translateApiError(err, t));
    } finally {
      setBusy(false);
    }
  };

  const handleCsvSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetClass || !csvFile) return;
    setBusy(true);
    setBulkResult(null);
    setCsvResult(null);
    try {
      const res = await api.adminImportClassCsv(targetClass.id, csvFile);
      setCsvResult(res);
      setCsvFile(null);
      await onImported();
    } catch (err) {
      onError(translateApiError(err, t));
    } finally {
      setBusy(false);
    }
  };

  const backdrop = makeBackdropHandlers(dialogRef);

  return (
    <dialog
      ref={dialogRef}
      {...({ closedby: 'any' } as Record<string, string>)}
      aria-labelledby="bulk-add-modal-title"
      onClose={onClose}
      onPointerDown={backdrop.onPointerDown}
      onPointerUp={backdrop.onPointerUp}
      className="gg-dialog w-full max-w-lg"
    >
      {targetClass && (
        <div className="space-y-4 p-6">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2
                id="bulk-add-modal-title"
                className="text-base font-semibold text-[#111318] dark:text-[#F4F5F7]"
              >
                {t.admin.students.bulkAddTitle}
              </h2>
              <p className="mt-0.5 text-xs text-[#5B616E] dark:text-[#9399A6]">
                {targetClass.name}
                {targetClass.code ? ` · ${targetClass.code}` : ''}
              </p>
            </div>
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              aria-label={t.common.close}
              className="btn-ghost p-1"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <form onSubmit={handleBulkSubmit} className="space-y-3">
            <div>
              <label
                htmlFor="bulk-add-textarea"
                className="mb-1 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]"
              >
                {t.admin.students.bulkAddHint}
              </label>
              <textarea
                id="bulk-add-textarea"
                rows={6}
                autoFocus
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                placeholder={t.admin.students.bulkAddPlaceholder}
                className="studio-input font-mono text-xs leading-relaxed"
              />
            </div>

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={busy || !rawText.trim()}
                className="btn-primary py-1.5 text-xs"
              >
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Users className="h-3.5 w-3.5" />
                )}
                {t.admin.students.bulkAddSubmit}
              </button>
            </div>
          </form>

          <div className="border-t border-black/[0.07] pt-4 dark:border-white/[0.08]">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-[#111318] dark:text-[#F4F5F7]">
                {t.admin.students.csvTitle}
              </span>
              <span className="font-mono text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                da, nom, max_grammes, max_minutes
              </span>
            </div>
            <form onSubmit={handleCsvSubmit} className="flex items-center gap-2">
              <input
                type="file"
                accept=".csv"
                onChange={(e) => setCsvFile(e.target.files?.[0] ?? null)}
                className="min-w-0 flex-1 text-xs text-[#5B616E] file:mr-2 file:rounded-lg file:border-0 file:bg-[#00A7D9]/15 file:px-2.5 file:py-1 file:text-xs file:font-medium file:text-[#007BA3] dark:text-[#9399A6] dark:file:text-[#38C6F4]"
              />
              <button
                type="submit"
                disabled={busy || !csvFile}
                className="btn-secondary py-1.5 text-xs"
              >
                <Upload className="h-3.5 w-3.5" />
                {t.admin.students.csvUploadBtn}
              </button>
            </form>
          </div>

          {bulkResult && (
            <div className="space-y-1.5 rounded-xl bg-emerald-500/10 px-3.5 py-2.5 text-xs text-emerald-800 dark:text-emerald-300">
              <div className="font-medium">
                {t.admin.students.bulkAddResult
                  .replace('{added}', String(bulkResult.added))
                  .replace('{reactivated}', String(bulkResult.reactivated))
                  .replace('{skipped}', String(bulkResult.skipped))
                  .replace('{invalid}', String(bulkResult.invalid))}
              </div>
              {bulkResult.invalid_lines.length > 0 && (
                <div className="font-mono text-[11px] text-rose-700 dark:text-rose-300">
                  {bulkResult.invalid_lines.slice(0, 5).join(' · ')}
                </div>
              )}
            </div>
          )}

          {csvResult && (
            <div className="rounded-xl bg-emerald-500/10 px-3.5 py-2.5 text-xs font-medium text-emerald-800 dark:text-emerald-300">
              {t.admin.students.csvImportClassResult
                .replace('{added}', String(csvResult.added))
                .replace('{reactivated}', String(csvResult.reactivated))
                .replace('{skipped}', String(csvResult.skipped))}
            </div>
          )}

          <div className="flex justify-end pt-1">
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              className="btn-secondary py-1.5 text-xs"
            >
              {t.common.close}
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}

interface TempPasswordModalProps {
  resetResult: { da: string; temp_password: string } | null;
  onClose: () => void;
}

export function TempPasswordModal({ resetResult, onClose }: TempPasswordModalProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [copied, setCopied] = useState(false);

  const open = resetResult !== null;
  useDialogSync(dialogRef, open);

  useEffect(() => {
    if (open) setCopied(false);
  }, [open, resetResult?.temp_password]);

  const handleCopy = async () => {
    if (!resetResult) return;
    await navigator.clipboard.writeText(resetResult.temp_password);
    setCopied(true);
  };

  const backdrop = makeBackdropHandlers(dialogRef);

  return (
    <dialog
      ref={dialogRef}
      {...({ closedby: 'any' } as Record<string, string>)}
      aria-labelledby="reset-pw-dialog-title"
      onClose={onClose}
      onPointerDown={backdrop.onPointerDown}
      onPointerUp={backdrop.onPointerUp}
      className="gg-dialog w-full max-w-sm"
    >
      {resetResult && (
        <div className="p-6">
          <div className="flex items-center justify-between">
            <h2
              id="reset-pw-dialog-title"
              className="text-base font-semibold text-[#111318] dark:text-[#F4F5F7]"
            >
              {t.admin.students.tempPasswordTitle}
            </h2>
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              aria-label={t.common.close}
              className="btn-ghost p-1"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-[#5B616E] dark:text-[#9399A6]">
            {t.admin.students.tempPasswordDesc.replace('{da}', resetResult.da)}
          </p>
          <div className="studio-subtle mt-4 flex items-center justify-between gap-2 px-3.5 py-2.5">
            <span className="font-mono text-base font-semibold tracking-wider text-[#007BA3] dark:text-[#38C6F4]">
              {resetResult.temp_password}
            </span>
            <button
              type="button"
              onClick={handleCopy}
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
              onClick={() => dialogRef.current?.close()}
              className="btn-primary py-1.5 text-xs"
            >
              {t.common.close}
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}

export type RefreshBudgetTarget =
  | { scope: 'users'; userIds: number[]; label?: string }
  | { scope: 'class'; classId: number; className: string }
  | { scope: 'all' };

interface RefreshBudgetModalProps {
  target: RefreshBudgetTarget | null;
  onClose: () => void;
  onRefreshed: (refreshedCount: number) => Promise<void>;
  onError: (msg: string) => void;
}

export function RefreshBudgetModal({
  target,
  onClose,
  onRefreshed,
  onError,
}: RefreshBudgetModalProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [resetUsage, setResetUsage] = useState(true);
  const [mode, setMode] = useState<'keep' | 'default' | 'custom'>('keep');
  const [customGrams, setCustomGrams] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const open = target !== null;
  useDialogSync(dialogRef, open);

  useEffect(() => {
    if (open) {
      setResetUsage(true);
      setMode('keep');
      setCustomGrams('');
    }
  }, [open, target]);

  const targetSummary = (() => {
    if (!target) return '';
    if (target.scope === 'all') return t.admin.students.refreshTargetAll;
    if (target.scope === 'class') {
      return t.admin.students.refreshTargetClass.replace('{name}', target.className);
    }
    if (target.userIds.length === 1 && target.label) {
      return t.admin.students.refreshTargetUser.replace('{name}', target.label);
    }
    return t.admin.students.refreshTargetGroup.replace('{count}', String(target.userIds.length));
  })();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!target) return;
    if (mode === 'custom' && (!customGrams.trim() || Number(customGrams) <= 0)) {
      return;
    }

    const body: BudgetRefreshRequest = {
      scope: target.scope,
      reset_usage: resetUsage,
      max_grams_mode: mode,
    };
    if (target.scope === 'users') {
      body.user_ids = target.userIds;
    } else if (target.scope === 'class') {
      body.class_id = target.classId;
    }
    if (mode === 'custom') {
      body.custom_max_grams = Number(customGrams);
    }

    setSubmitting(true);
    try {
      const res = await api.adminRefreshStudentBudgets(body);
      await onRefreshed(res.refreshed_count);
      onClose();
    } catch (err) {
      onError(translateApiError(err, t));
    } finally {
      setSubmitting(false);
    }
  };

  const backdrop = makeBackdropHandlers(dialogRef);

  return (
    <dialog
      ref={dialogRef}
      {...({ closedby: 'any' } as Record<string, string>)}
      aria-labelledby="refresh-budget-modal-title"
      onClose={onClose}
      onPointerDown={backdrop.onPointerDown}
      onPointerUp={backdrop.onPointerUp}
      className="gg-dialog w-full max-w-md"
    >
      {target && (
        <form onSubmit={handleSubmit} className="space-y-4 p-6">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2
                id="refresh-budget-modal-title"
                className="text-base font-semibold text-[#111318] dark:text-[#F4F5F7]"
              >
                {t.admin.students.refreshModalTitle}
              </h2>
              <p className="mt-1 inline-flex rounded-lg bg-[#00A7D9]/12 px-2 py-0.5 text-xs font-medium text-[#007BA3] dark:text-[#38C6F4]">
                {targetSummary}
              </p>
            </div>
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              aria-label={t.common.close}
              className="btn-ghost p-1"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-black/[0.07] bg-black/[0.02] p-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
            <input
              type="checkbox"
              checked={resetUsage}
              onChange={(e) => setResetUsage(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 rounded"
            />
            <span className="space-y-0.5">
              <span className="block text-xs font-semibold text-[#111318] dark:text-[#F4F5F7]">
                {t.admin.students.refreshResetUsageLabel}
              </span>
              <span className="block text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                {t.admin.students.refreshResetUsageHint}
              </span>
            </span>
          </label>

          <fieldset className="space-y-2">
            <legend className="text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
              {t.admin.students.refreshModeLabel}
            </legend>
            <div className="space-y-1.5">
              {(
                [
                  { id: 'keep', label: t.admin.students.refreshModeKeep },
                  { id: 'default', label: t.admin.students.refreshModeDefault },
                  { id: 'custom', label: t.admin.students.refreshModeCustom },
                ] as const
              ).map((opt) => (
                <label
                  key={opt.id}
                  className={`flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2 text-xs transition-colors ${
                    mode === opt.id
                      ? 'border-[#00A7D9] bg-[#00A7D9]/8 font-medium text-[#111318] dark:text-[#F4F5F7]'
                      : 'border-black/[0.07] text-[#5B616E] hover:border-black/20 dark:border-white/[0.08] dark:text-[#9399A6] dark:hover:border-white/20'
                  }`}
                >
                  <input
                    type="radio"
                    name="refresh-max-grams-mode"
                    value={opt.id}
                    checked={mode === opt.id}
                    onChange={() => setMode(opt.id)}
                    className="h-3.5 w-3.5"
                  />
                  <span>{opt.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          {mode === 'custom' && (
            <div>
              <label
                htmlFor="refresh-custom-grams"
                className="mb-1 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]"
              >
                {t.admin.students.refreshCustomGramsLabel}
              </label>
              <input
                id="refresh-custom-grams"
                type="number"
                min={1}
                step={1}
                required
                autoFocus
                value={customGrams}
                onChange={(e) => setCustomGrams(e.target.value)}
                placeholder="200"
                className="studio-input font-mono text-sm tabular-nums"
              />
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              className="btn-secondary"
            >
              {t.common.cancel}
            </button>
            <button
              type="submit"
              disabled={
                submitting ||
                (!resetUsage && mode === 'keep') ||
                (mode === 'custom' && (!customGrams.trim() || Number(customGrams) <= 0))
              }
              className="btn-primary"
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RotateCcw className="h-4 w-4" />
              )}
              {submitting ? t.admin.students.refreshingBtn : t.admin.students.refreshConfirmBtn}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
