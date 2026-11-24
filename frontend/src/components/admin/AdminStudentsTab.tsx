import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Check,
  Copy,
  KeyRound,
  Plus,
  Save,
  Trash2,
  Upload,
  UserMinus,
  X,
} from 'lucide-react';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import type { AdminTeacher, StudentAccount, TeacherClass } from '../../types/api';
import { translateApiError } from '../../utils/errors';

interface AdminStudentsTabProps {
  classes: TeacherClass[];
  teachers: AdminTeacher[];
  students: StudentAccount[];
  isSuperAdmin: boolean;
  onReload: () => Promise<void>;
  onError: (msg: string) => void;
}

export function AdminStudentsTab({
  classes,
  teachers,
  students,
  isSuperAdmin,
  onReload,
  onError,
}: AdminStudentsTabProps) {
  const { lang, t } = useI18n();

  // Create class state
  const [className, setClassName] = useState('');
  const [classCode, setClassCode] = useState('');
  const [createTeacherId, setCreateTeacherId] = useState<string>('');
  const [creatingClass, setCreatingClass] = useState(false);

  // Active class selection & teacher filter (for super admin)
  const [teacherFilter, setTeacherFilter] = useState<string>('all');
  const [selectedClassId, setSelectedClassId] = useState<number | null>(null);
  const pendingSelectClassIdRef = useRef<number | null>(null);
  const [confirmDeleteClassId, setConfirmDeleteClassId] = useState<number | null>(null);
  const [deletingClass, setDeletingClass] = useState(false);
  const [classNotice, setClassNotice] = useState<string | null>(null);

  // Single DA enrollment state
  const [da, setDa] = useState('');
  const [suggestedName, setSuggestedName] = useState('');
  const [maxGrams, setMaxGrams] = useState('');
  const [maxMinutes, setMaxMinutes] = useState('');
  const [addingDa, setAddingDa] = useState(false);

  // CSV import state
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [csvResult, setCsvResult] = useState<string | null>(null);
  const [uploadingCsv, setUploadingCsv] = useState(false);

  // Students table filter & drafts
  const [studentClassFilter, setStudentClassFilter] = useState<string>('all');
  const [studentDrafts, setStudentDrafts] = useState<
    Record<
      number,
      {
        maxGrams: string;
        maxMinutes: string;
        isActive: boolean;
      }
    >
  >({});

  // Reset password modal
  const resetDialogRef = useRef<HTMLDialogElement | null>(null);
  const pressedOutsideRef = useRef(false);
  const [resetResult, setResetResult] = useState<{ da: string; temp_password: string } | null>(
    null
  );
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (isSuperAdmin && !createTeacherId && teachers.length > 0) {
      setCreateTeacherId(String(teachers[0].id));
    }
  }, [createTeacherId, isSuperAdmin, teachers]);

  const filteredClasses = useMemo(() => {
    if (!isSuperAdmin || teacherFilter === 'all') return classes;
    return classes.filter((c) => String(c.teacher_id) === teacherFilter);
  }, [classes, isSuperAdmin, teacherFilter]);

  useEffect(() => {
    if (filteredClasses.length === 0) {
      setSelectedClassId(null);
      return;
    }
    const pendingId = pendingSelectClassIdRef.current;
    if (pendingId !== null) {
      if (filteredClasses.some((c) => c.id === pendingId)) {
        pendingSelectClassIdRef.current = null;
        setSelectedClassId(pendingId);
      }
      return;
    }
    if (
      selectedClassId === null ||
      !filteredClasses.some((c) => c.id === selectedClassId)
    ) {
      setSelectedClassId(filteredClasses[0].id);
    }
  }, [filteredClasses, selectedClassId]);

  useEffect(() => {
    setCsvResult(null);
    setConfirmDeleteClassId(null);
  }, [selectedClassId]);

  const selectedClass = useMemo(
    () => filteredClasses.find((c) => c.id === selectedClassId) ?? null,
    [filteredClasses, selectedClassId]
  );

  const filteredStudents = useMemo(() => {
    if (studentClassFilter === 'all') return students;
    const targetId = Number(studentClassFilter);
    return students.filter((s) => s.classes?.some((c) => c.class_id === targetId));
  }, [studentClassFilter, students]);

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

  const handleCreateClass = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = className.trim();
    if (!trimmedName) return;

    setCreatingClass(true);
    setClassNotice(null);
    try {
      const created = await api.adminCreateClass({
        name: trimmedName,
        code: classCode.trim() || null,
        teacher_id: isSuperAdmin && createTeacherId ? Number(createTeacherId) : null,
      });
      setClassName('');
      setClassCode('');
      pendingSelectClassIdRef.current = created.id;
      if (isSuperAdmin && teacherFilter !== 'all' && String(created.teacher_id) !== teacherFilter) {
        setTeacherFilter('all');
      }
      await onReload();
      setSelectedClassId(created.id);
    } catch (err) {
      pendingSelectClassIdRef.current = null;
      onError(translateApiError(err, t));
    } finally {
      setCreatingClass(false);
    }
  };

  const handleDeleteClass = async (targetClass: TeacherClass) => {
    setDeletingClass(true);
    setClassNotice(null);
    try {
      const res = await api.adminDeleteClass(targetClass.id);
      setConfirmDeleteClassId(null);
      if (res.disabled_students_count > 0) {
        setClassNotice(
          lang === 'fr'
            ? `Classe supprimée : ${res.disabled_students_count} étudiant(s) sans autre classe ont été désactivé(s).`
            : `Class deleted: ${res.disabled_students_count} student(s) with no remaining classes were disabled.`
        );
      }
      await onReload();
    } catch (err) {
      onError(translateApiError(err, t));
    } finally {
      setDeletingClass(false);
    }
  };

  const handleAddStudentToClass = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedClass) return;
    if (!/^\d{7}$/.test(da.trim())) {
      onError(t.errors.invalidDa);
      return;
    }
    setAddingDa(true);
    setClassNotice(null);
    try {
      await api.adminAddClassStudent(selectedClass.id, {
        da: da.trim(),
        suggested_name: suggestedName.trim() || null,
        max_active_grams_override: maxGrams ? Number(maxGrams) : null,
        max_print_minutes_override: maxMinutes ? Number(maxMinutes) : null,
      });
      setDa('');
      setSuggestedName('');
      setMaxGrams('');
      setMaxMinutes('');
      await onReload();
    } catch (err) {
      onError(translateApiError(err, t));
    } finally {
      setAddingDa(false);
    }
  };

  const handleCsvUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedClass || !csvFile) return;
    setUploadingCsv(true);
    setCsvResult(null);
    setClassNotice(null);
    try {
      const res = await api.adminImportClassCsv(selectedClass.id, csvFile);
      setCsvResult(
        t.admin.students.csvImportClassResult
          .replace('{added}', String(res.added))
          .replace('{reactivated}', String(res.reactivated))
          .replace('{skipped}', String(res.skipped))
      );
      setCsvFile(null);
      await onReload();
    } catch (err) {
      onError(translateApiError(err, t));
    } finally {
      setUploadingCsv(false);
    }
  };

  const handleRemoveFromClass = async (targetDa: string) => {
    if (!selectedClass) return;
    setClassNotice(null);
    try {
      const res = await api.adminRemoveClassStudent(selectedClass.id, targetDa);
      if (res.student_disabled) {
        setClassNotice(
          lang === 'fr'
            ? `DA ${targetDa} retiré. Aucun autre cours actif : le compte étudiant a été désactivé.`
            : `DA ${targetDa} removed. No other classes remaining: student account disabled.`
        );
      }
      await onReload();
    } catch (err) {
      onError(translateApiError(err, t));
    }
  };

  const getDraft = (s: StudentAccount) =>
    studentDrafts[s.id] ?? {
      maxGrams:
        s.max_active_grams_override != null ? String(s.max_active_grams_override) : '',
      maxMinutes:
        s.max_print_minutes_override != null ? String(s.max_print_minutes_override) : '',
      isActive: s.is_active,
    };

  const handleSaveStudent = async (s: StudentAccount) => {
    const d = getDraft(s);
    try {
      await api.adminUpdateStudent(s.id, {
        is_active: d.isActive,
        max_active_grams_override: d.maxGrams.trim() === '' ? null : Number(d.maxGrams),
        max_print_minutes_override: d.maxMinutes.trim() === '' ? null : Number(d.maxMinutes),
      });
      await onReload();
    } catch (err) {
      onError(translateApiError(err, t));
    }
  };

  const handleResetPassword = async (userId: number) => {
    try {
      const res = await api.adminResetPassword(userId);
      setCopied(false);
      setResetResult(res);
    } catch (err) {
      onError(translateApiError(err, t));
    }
  };

  const handleCopyTempPassword = async () => {
    if (!resetResult) return;
    await navigator.clipboard.writeText(resetResult.temp_password);
    setCopied(true);
  };

  return (
    <div className="space-y-6">
      {/* Create Class Form */}
      <div className="studio-surface p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-[#111318] dark:text-[#F4F5F7]">
            {t.admin.students.createClassTitle}
          </h2>
          {isSuperAdmin && teachers.length > 0 && (
            <div className="flex items-center gap-2">
              <label
                htmlFor="teacher-class-filter"
                className="text-[11px] font-medium text-[#5B616E] dark:text-[#9399A6]"
              >
                {t.admin.students.classTeacherLabel}:
              </label>
              <select
                id="teacher-class-filter"
                value={teacherFilter}
                onChange={(e) => setTeacherFilter(e.target.value)}
                className="studio-input w-auto py-1 text-xs"
              >
                <option value="all">{t.admin.students.allClassesFilter}</option>
                {teachers.map((teacher) => (
                  <option key={teacher.id} value={String(teacher.id)}>
                    {teacher.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <form onSubmit={handleCreateClass} className="grid grid-cols-1 gap-2.5 sm:grid-cols-12">
          <input
            type="text"
            value={className}
            onChange={(e) => setClassName(e.target.value)}
            placeholder={t.admin.students.classNamePlaceholder}
            className={`studio-input py-1.5 text-xs ${
              isSuperAdmin ? 'sm:col-span-5' : 'sm:col-span-7'
            }`}
            required
          />
          <input
            type="text"
            value={classCode}
            onChange={(e) => setClassCode(e.target.value)}
            placeholder={t.admin.students.classCodePlaceholder}
            className="studio-input py-1.5 font-mono text-xs sm:col-span-3"
          />
          {isSuperAdmin && (
            <select
              aria-label={t.admin.students.classTeacherLabel}
              value={createTeacherId}
              onChange={(e) => setCreateTeacherId(e.target.value)}
              className="studio-input py-1.5 text-xs sm:col-span-2"
            >
              <option value="">{t.admin.students.classTeacherLabel}</option>
              {teachers.map((teacher) => (
                <option key={teacher.id} value={String(teacher.id)}>
                  {teacher.name}
                </option>
              ))}
            </select>
          )}
          <button
            type="submit"
            disabled={creatingClass}
            className="btn-primary py-1.5 text-xs sm:col-span-2"
          >
            <Plus className="h-3.5 w-3.5" />
            {t.admin.students.createClassBtn}
          </button>
        </form>

        {classNotice && (
          <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-3.5 py-2 text-xs font-medium text-amber-800 dark:text-amber-200">
            {classNotice}
          </div>
        )}
      </div>

      {/* Classes & Rosters Workspace */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Class Selector List */}
        <div className="space-y-2 lg:col-span-4">
          <div className="px-1 text-xs font-semibold uppercase tracking-wide text-[#5B616E] dark:text-[#9399A6]">
            {t.admin.students.classesTitle} ({filteredClasses.length})
          </div>

          {filteredClasses.length === 0 ? (
            <div className="studio-surface p-6 text-center text-xs text-[#5B616E] dark:text-[#9399A6]">
              {t.admin.students.noClasses}
            </div>
          ) : (
            <div className="space-y-2">
              {filteredClasses.map((cls) => {
                const isSelected = cls.id === selectedClass?.id;
                return (
                  <button
                    key={cls.id}
                    type="button"
                    onClick={() => setSelectedClassId(cls.id)}
                    className={`w-full rounded-2xl border p-3.5 text-left transition-all ${
                      isSelected
                        ? 'border-[#00A7D9] bg-white shadow-sm ring-1 ring-[#00A7D9]/25 dark:bg-[#1D2027]'
                        : 'border-black/[0.08] bg-white hover:border-black/20 dark:border-white/[0.09] dark:bg-[#15171C] dark:hover:border-white/20'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-[#111318] dark:text-[#F4F5F7]">
                          {cls.name}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          {cls.code && (
                            <span className="studio-subtle px-1.5 py-0.5 font-mono text-[10px] text-[#5B616E] dark:text-[#9399A6]">
                              {cls.code}
                            </span>
                          )}
                          {isSuperAdmin && (
                            <span className="rounded-md bg-[#00A7D9]/12 px-1.5 py-0.5 text-[10px] font-medium text-[#007BA3] dark:text-[#38C6F4]">
                              {cls.teacher_name}
                            </span>
                          )}
                          {cls.is_default_individual && (
                            <span className="rounded-md bg-black/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-[#5B616E] dark:bg-white/[0.08] dark:text-[#9399A6]">
                              {lang === 'fr'
                                ? 'Individuel / Hors-classe'
                                : 'Individual / Unlisted'}
                            </span>
                          )}
                        </div>
                      </div>
                      <span className="shrink-0 font-mono text-[11px] font-medium tabular-nums text-[#5B616E] dark:text-[#9399A6]">
                        {t.admin.students.studentsCount.replace(
                          '{count}',
                          String(cls.student_count)
                        )}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Selected Class Detail: CSV Import + Add DA + Roster */}
        <div className="lg:col-span-8">
          {!selectedClass ? (
            <div className="studio-surface flex flex-col items-center justify-center gap-2 p-12 text-center text-sm text-[#5B616E] dark:text-[#9399A6]">
              <BookOpen className="h-5 w-5 text-[#8A909E]" />
              <span>{t.admin.students.noClasses}</span>
            </div>
          ) : (
            <div className="studio-surface p-5 space-y-5">
              {/* Class Header + Delete */}
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-black/[0.06] pb-4 dark:border-white/[0.07]">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-semibold text-[#111318] dark:text-[#F4F5F7]">
                      {selectedClass.name}
                    </h3>
                    {selectedClass.code && (
                      <span className="studio-subtle px-2 py-0.5 font-mono text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                        {selectedClass.code}
                      </span>
                    )}
                    {isSuperAdmin && (
                      <span className="rounded-full bg-[#00A7D9]/12 px-2.5 py-0.5 text-[11px] font-medium text-[#007BA3] dark:text-[#38C6F4]">
                        {selectedClass.teacher_name}
                      </span>
                    )}
                    {selectedClass.is_default_individual && (
                      <span className="rounded-full bg-black/[0.06] px-2.5 py-0.5 text-[11px] font-medium text-[#5B616E] dark:bg-white/[0.08] dark:text-[#9399A6]">
                        {t.admin.students.defaultIndividualBadge}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-[#5B616E] dark:text-[#9399A6]">
                    {t.admin.students.studentsCount.replace(
                      '{count}',
                      String(selectedClass.student_count)
                    )}
                  </p>
                </div>

                {!selectedClass.is_default_individual && (
                  <button
                    type="button"
                    disabled={deletingClass}
                    onClick={() =>
                      setConfirmDeleteClassId(
                        confirmDeleteClassId === selectedClass.id ? null : selectedClass.id
                      )
                    }
                    className="btn-ghost px-2.5 py-1.5 text-xs text-rose-600 hover:bg-rose-500/10 hover:text-rose-700 dark:text-rose-400 dark:hover:text-rose-300"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {t.admin.students.deleteClassBtn}
                  </button>
                )}
              </div>

              {confirmDeleteClassId === selectedClass.id && (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-500/25 bg-rose-500/8 px-4 py-3 text-xs">
                  <div className="flex items-start gap-2.5 text-rose-800 dark:text-rose-200">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" />
                    <span className="font-medium">
                      {t.admin.students.deleteClassConfirm.replace(
                        '{name}',
                        selectedClass.name
                      )}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={deletingClass}
                      onClick={() => setConfirmDeleteClassId(null)}
                      className="btn-secondary px-3 py-1.5 text-xs"
                    >
                      {t.common.cancel}
                    </button>
                    <button
                      type="button"
                      disabled={deletingClass}
                      onClick={() => handleDeleteClass(selectedClass)}
                      className="btn-danger px-3 py-1.5 text-xs"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {t.common.confirm}
                    </button>
                  </div>
                </div>
              )}

              {/* Add single student DA */}
              <div className="space-y-2.5">
                <h4 className="text-xs font-semibold text-[#111318] dark:text-[#F4F5F7]">
                  {t.admin.students.addSingleDa}
                </h4>
                <form
                  onSubmit={handleAddStudentToClass}
                  className="grid grid-cols-1 gap-2.5 sm:grid-cols-12"
                >
                  <input
                    type="text"
                    maxLength={7}
                    value={da}
                    onChange={(e) => setDa(e.target.value.replace(/\D/g, '').slice(0, 7))}
                    placeholder={t.admin.students.da}
                    className="studio-input py-1.5 font-mono text-xs tabular-nums sm:col-span-3"
                    required
                  />
                  <input
                    type="text"
                    value={suggestedName}
                    onChange={(e) => setSuggestedName(e.target.value)}
                    placeholder={t.admin.students.suggestedName}
                    className="studio-input py-1.5 text-xs sm:col-span-3"
                  />
                  <input
                    type="number"
                    step="1"
                    value={maxGrams}
                    onChange={(e) => setMaxGrams(e.target.value)}
                    placeholder={t.admin.students.maxGramsOverride}
                    className="studio-input py-1.5 font-mono text-xs tabular-nums sm:col-span-2"
                  />
                  <input
                    type="number"
                    step="10"
                    value={maxMinutes}
                    onChange={(e) => setMaxMinutes(e.target.value)}
                    placeholder={t.admin.students.maxMinutesOverride}
                    className="studio-input py-1.5 font-mono text-xs tabular-nums sm:col-span-2"
                  />
                  <button
                    type="submit"
                    disabled={addingDa}
                    className="btn-primary py-1.5 text-xs sm:col-span-2"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {t.common.add}
                  </button>
                </form>
              </div>

              {/* CSV Import for selected class */}
              <div className="studio-subtle p-4 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-xs font-semibold text-[#111318] dark:text-[#F4F5F7]">
                    {t.admin.students.csvTitle}
                  </h4>
                  <span className="font-mono text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                    da, nom, max_grammes, max_minutes
                  </span>
                </div>
                <form onSubmit={handleCsvUpload} className="flex flex-wrap items-center gap-2">
                  <input
                    type="file"
                    accept=".csv"
                    onChange={(e) => setCsvFile(e.target.files?.[0] ?? null)}
                    className="flex-1 text-xs text-[#5B616E] file:mr-2 file:rounded-lg file:border-0 file:bg-[#00A7D9]/15 file:px-2.5 file:py-1 file:text-xs file:font-medium file:text-[#007BA3] dark:text-[#9399A6] dark:file:text-[#38C6F4]"
                  />
                  <button
                    type="submit"
                    disabled={!csvFile || uploadingCsv}
                    className="btn-secondary py-1.5 text-xs"
                  >
                    <Upload className="h-3.5 w-3.5" />
                    {t.admin.students.csvUploadBtn}
                  </button>
                </form>
                {csvResult && (
                  <div className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
                    {csvResult}
                  </div>
                )}
              </div>

              {/* Roster List */}
              <div className="overflow-hidden rounded-xl border border-black/[0.07] dark:border-white/[0.08]">
                <div className="bg-[#F6F7F9] px-4 py-2 text-[11px] font-semibold text-[#5B616E] dark:bg-[#0D0E11] dark:text-[#9399A6]">
                  {t.admin.students.selectClassLabel}: {selectedClass.name} (
                  {selectedClass.enrollments.length})
                </div>
                {selectedClass.enrollments.length === 0 ? (
                  <div className="px-4 py-6 text-center text-xs text-[#5B616E] dark:text-[#9399A6]">
                    {t.common.noData}
                  </div>
                ) : (
                  <div className="divide-y divide-black/[0.06] dark:divide-white/[0.07]">
                    {selectedClass.enrollments.map((entry) => (
                      <div
                        key={entry.id}
                        className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-xs"
                      >
                        <div className="flex flex-wrap items-center gap-2.5">
                          <span className="font-mono font-medium tabular-nums text-[#111318] dark:text-[#F4F5F7]">
                            {entry.da}
                          </span>
                          {entry.suggested_name && (
                            <span className="text-[#5B616E] dark:text-[#9399A6]">
                              {entry.suggested_name}
                            </span>
                          )}
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                              entry.is_registered
                                ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400'
                                : 'bg-black/[0.06] text-[#5B616E] dark:bg-white/[0.08] dark:text-[#9399A6]'
                            }`}
                          >
                            {entry.is_registered
                              ? t.admin.students.registeredBadge
                              : t.admin.students.notRegisteredBadge}
                          </span>
                          {entry.is_registered && entry.is_active === false && (
                            <span className="rounded-full bg-rose-500/12 px-2 py-0.5 text-[10px] font-medium text-rose-700 dark:text-rose-400">
                              {t.admin.students.suspendedStatus}
                            </span>
                          )}
                          {entry.max_active_grams_override != null && (
                            <span className="font-mono text-[11px] tabular-nums text-[#007BA3] dark:text-[#38C6F4]">
                              {entry.max_active_grams_override} g
                            </span>
                          )}
                          {entry.max_print_minutes_override != null && (
                            <span className="font-mono text-[11px] tabular-nums text-[#007BA3] dark:text-[#38C6F4]">
                              {entry.max_print_minutes_override} min
                            </span>
                          )}
                        </div>
                        <button
                          type="button"
                          title={t.admin.students.removeFromClassBtn}
                          aria-label={`${t.admin.students.removeFromClassBtn} ${entry.da}`}
                          onClick={() => handleRemoveFromClass(entry.da)}
                          className="btn-ghost p-1 text-[#5B616E] hover:text-rose-600 dark:text-[#9399A6] dark:hover:text-rose-400"
                        >
                          <UserMinus className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Registered Students Table */}
      <div className="studio-surface overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-black/[0.07] px-5 py-3.5 dark:border-white/[0.08]">
          <h2 className="text-sm font-semibold text-[#111318] dark:text-[#F4F5F7]">
            {t.admin.students.registeredTitle} ({filteredStudents.length})
          </h2>
          {classes.length > 0 && (
            <select
              aria-label={t.admin.students.selectClassLabel}
              value={studentClassFilter}
              onChange={(e) => setStudentClassFilter(e.target.value)}
              className="studio-input w-auto py-1 text-xs"
            >
              <option value="all">{t.admin.students.allClassesFilter}</option>
              {classes.map((cls) => (
                <option key={cls.id} value={String(cls.id)}>
                  {isSuperAdmin ? `${cls.name} (${cls.teacher_name})` : cls.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-black/[0.06] bg-[#F6F7F9] text-[11px] font-medium text-[#5B616E] dark:border-white/[0.07] dark:bg-[#0D0E11] dark:text-[#9399A6]">
              <tr>
                <th className="px-5 py-2.5">{t.common.daLabel}</th>
                <th className="px-4 py-2.5">{t.auth.nameLabel}</th>
                <th className="px-4 py-2.5">{t.admin.students.classesTitle}</th>
                <th className="px-4 py-2.5">{t.admin.students.activeGrams}</th>
                <th className="px-4 py-2.5">{t.admin.students.maxGramsOverride}</th>
                <th className="px-4 py-2.5">{t.admin.students.maxMinutesOverride}</th>
                <th className="px-4 py-2.5">{t.admin.students.activeStatus}</th>
                <th className="px-5 py-2.5 text-right">{t.common.save}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/[0.06] dark:divide-white/[0.07]">
              {filteredStudents.map((s) => {
                const d = getDraft(s);
                return (
                  <tr key={s.id} className="hover:bg-black/[0.015] dark:hover:bg-white/[0.02]">
                    <td className="px-5 py-3 font-mono font-medium tabular-nums text-[#111318] dark:text-[#F4F5F7]">
                      {s.da}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium text-[#111318] dark:text-[#F4F5F7]">
                          {s.name}
                        </span>
                        {s.role === 'admin' && (
                          <span className="text-[11px] font-medium text-[#007BA3] dark:text-[#38C6F4]">
                            {t.nav.roleAdmin}
                          </span>
                        )}
                        {s.role === 'teacher' && (
                          <span className="text-[11px] font-medium text-[#007BA3] dark:text-[#38C6F4]">
                            {t.nav.roleTeacher}
                          </span>
                        )}
                        {s.approval_status === 'pending' && (
                          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                            {t.admin.students.pendingApprovalBadge}
                          </span>
                        )}
                        {s.approval_status === 'rejected' && (
                          <span className="rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-medium text-rose-700 dark:text-rose-400">
                            {t.admin.students.rejectedBadge}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex max-w-[240px] flex-wrap gap-1">
                        {s.classes && s.classes.length > 0 ? (
                          s.classes.map((badge) => (
                            <span
                              key={badge.class_id}
                              className="studio-subtle inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium text-[#111318] dark:text-[#F4F5F7]"
                            >
                              <span>{badge.class_name}</span>
                              {isSuperAdmin && (
                                <span className="text-[#5B616E] dark:text-[#9399A6]">
                                  · {badge.teacher_name}
                                </span>
                              )}
                            </span>
                          ))
                        ) : (
                          <span className="text-[11px] text-[#8A909E] dark:text-[#6B717D]">
                            —
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono tabular-nums text-[#5B616E] dark:text-[#9399A6]">
                      {s.active_grams_used.toFixed(1)} / {s.effective_max_active_grams.toFixed(0)} g
                    </td>
                    <td className="px-4 py-3">
                      <input
                        type="number"
                        step="1"
                        value={d.maxGrams}
                        placeholder={t.admin.students.globalDefaultPlaceholder}
                        onChange={(e) =>
                          setStudentDrafts((prev) => ({
                            ...prev,
                            [s.id]: { ...d, maxGrams: e.target.value },
                          }))
                        }
                        className="studio-input w-32 py-1 font-mono text-xs tabular-nums"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <input
                        type="number"
                        step="10"
                        value={d.maxMinutes}
                        placeholder={t.admin.students.globalDefaultPlaceholder}
                        onChange={(e) =>
                          setStudentDrafts((prev) => ({
                            ...prev,
                            [s.id]: { ...d, maxMinutes: e.target.value },
                          }))
                        }
                        className="studio-input w-32 py-1 font-mono text-xs tabular-nums"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <label className="inline-flex cursor-pointer items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={d.isActive}
                          onChange={(e) =>
                            setStudentDrafts((prev) => ({
                              ...prev,
                              [s.id]: { ...d, isActive: e.target.checked },
                            }))
                          }
                          className="h-4 w-4 rounded"
                        />
                        <span>
                          {d.isActive
                            ? t.admin.students.activeStatus
                            : t.admin.students.suspendedStatus}
                        </span>
                      </label>
                    </td>
                    <td className="px-5 py-3 text-right">
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleSaveStudent(s)}
                          className="btn-primary px-2.5 py-1 text-[11px]"
                        >
                          <Save className="h-3 w-3" />
                          {t.common.save}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleResetPassword(s.id)}
                          className="btn-secondary px-2.5 py-1 text-[11px]"
                        >
                          <KeyRound className="h-3 w-3" />
                          {t.admin.students.resetPasswordBtn}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Native <dialog> Reset Password Result Modal */}
      <dialog
        ref={resetDialogRef}
        {...({ closedby: 'any' } as Record<string, string>)}
        aria-labelledby="reset-pw-dialog-title"
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
                id="reset-pw-dialog-title"
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
              {t.admin.students.tempPasswordDesc.replace('{da}', resetResult.da)}
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
