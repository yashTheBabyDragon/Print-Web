import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRightLeft,
  BookOpen,
  Check,
  Edit3,
  KeyRound,
  Plus,
  RotateCcw,
  Save,
  Search,
  Trash2,
  UserCheck,
  UserMinus,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import type {
  AdminTeacher,
  PendingAccountRequest,
  StudentAccount,
  TeacherClass,
} from '../../types/api';
import { translateApiError } from '../../utils/errors';
import {
  BulkAddStudentsModal,
  CreateClassModal,
  EditClassModal,
  RefreshBudgetModal,
  type RefreshBudgetTarget,
  TempPasswordModal,
} from './ClassModals';

interface AdminStudentsTabProps {
  classes: TeacherClass[];
  teachers: AdminTeacher[];
  students: StudentAccount[];
  accountRequests?: PendingAccountRequest[];
  isSuperAdmin: boolean;
  onReload: () => Promise<void>;
  onError: (msg: string) => void;
}

type WorkspaceView = 'class' | 'all' | 'requests';
type RosterFilter = 'all' | 'registered' | 'unclaimed';

export function AdminStudentsTab({
  classes,
  teachers,
  students,
  accountRequests = [],
  isSuperAdmin,
  onReload,
  onError,
}: AdminStudentsTabProps) {
  const { lang, t } = useI18n();

  // Master-detail navigation state
  const [teacherFilter, setTeacherFilter] = useState<string>('all');
  const [view, setView] = useState<WorkspaceView>('class');
  const [selectedClassId, setSelectedClassId] = useState<number | null>(null);
  const pendingSelectClassIdRef = useRef<number | null>(null);

  // Modals
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editingClass, setEditingClass] = useState<TeacherClass | null>(null);
  const [bulkAddClass, setBulkAddClass] = useState<TeacherClass | null>(null);
  const [refreshTarget, setRefreshTarget] = useState<RefreshBudgetTarget | null>(null);
  const [resetResult, setResetResult] = useState<{ da: string; temp_password: string } | null>(
    null
  );

  // Multi-select student IDs for group budget refresh
  const [selectedStudentIds, setSelectedStudentIds] = useState<number[]>([]);

  // Class deletion & notices
  const [confirmDeleteClassId, setConfirmDeleteClassId] = useState<number | null>(null);
  const [deletingClass, setDeletingClass] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Quick single-DA inline add
  const [quickDa, setQuickDa] = useState('');
  const [quickName, setQuickName] = useState('');
  const [addingQuickDa, setAddingQuickDa] = useState(false);

  // Roster search & filter
  const [rosterSearch, setRosterSearch] = useState('');
  const [rosterFilter, setRosterFilter] = useState<RosterFilter>('all');

  // Transfer inline selector (enrollment DA -> target class id)
  const [transferDa, setTransferDa] = useState<string | null>(null);
  const [transferTargetId, setTransferTargetId] = useState<string>('');
  const [transferring, setTransferring] = useState(false);

  // All Students view filter
  const [allStudentsSearch, setAllStudentsSearch] = useState('');
  const [allStudentsClassFilter, setAllStudentsClassFilter] = useState<string>('all');

  // Student inline budget/active drafts
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
  const [savingStudentId, setSavingStudentId] = useState<number | null>(null);

  // Pending account requests inline approval
  const [busyAccountId, setBusyAccountId] = useState<number | null>(null);
  const [requestClassSelections, setRequestClassSelections] = useState<Record<number, string>>({});

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
    if (selectedClassId === null || !filteredClasses.some((c) => c.id === selectedClassId)) {
      setSelectedClassId(filteredClasses[0].id);
    }
  }, [filteredClasses, selectedClassId]);

  useEffect(() => {
    setConfirmDeleteClassId(null);
    setTransferDa(null);
    setRosterSearch('');
    setRosterFilter('all');
    setSelectedStudentIds([]);
  }, [selectedClassId]);

  useEffect(() => {
    setSelectedStudentIds([]);
  }, [view]);

  const selectedClass = useMemo(
    () => filteredClasses.find((c) => c.id === selectedClassId) ?? null,
    [filteredClasses, selectedClassId]
  );

  // Lookup student accounts by user_id and DA for inline editing inside class roster
  const studentsById = useMemo(() => {
    const map = new Map<number, StudentAccount>();
    for (const s of students) map.set(s.id, s);
    return map;
  }, [students]);

  const studentsByDa = useMemo(() => {
    const map = new Map<string, StudentAccount>();
    for (const s of students) map.set(s.da, s);
    return map;
  }, [students]);

  const getDraft = (s: StudentAccount) =>
    studentDrafts[s.id] ?? {
      maxGrams:
        s.max_active_grams_override != null ? String(s.max_active_grams_override) : '',
      maxMinutes:
        s.max_print_minutes_override != null ? String(s.max_print_minutes_override) : '',
      isActive: s.is_active,
    };

  const isDraftDirty = (s: StudentAccount) => {
    const d = studentDrafts[s.id];
    if (!d) return false;
    const origGrams =
      s.max_active_grams_override != null ? String(s.max_active_grams_override) : '';
    const origMin =
      s.max_print_minutes_override != null ? String(s.max_print_minutes_override) : '';
    return d.maxGrams !== origGrams || d.maxMinutes !== origMin || d.isActive !== s.is_active;
  };

  // Filtered roster entries for selected class
  const filteredEnrollments = useMemo(() => {
    if (!selectedClass) return [];
    const q = rosterSearch.trim().toLowerCase();
    return selectedClass.enrollments.filter((entry) => {
      if (rosterFilter === 'registered' && !entry.is_registered) return false;
      if (rosterFilter === 'unclaimed' && entry.is_registered) return false;
      if (!q) return true;
      const name = (entry.registered_name || entry.suggested_name || '').toLowerCase();
      return entry.da.toLowerCase().includes(q) || name.includes(q);
    });
  }, [selectedClass, rosterSearch, rosterFilter]);

  // Transferable destination classes (same teacher, excluding current class)
  const transferableClasses = useMemo(() => {
    if (!selectedClass) return [];
    return classes.filter(
      (c) => c.id !== selectedClass.id && c.teacher_id === selectedClass.teacher_id
    );
  }, [classes, selectedClass]);

  const selectedIdSet = useMemo(() => new Set(selectedStudentIds), [selectedStudentIds]);

  const toggleSelectStudent = (userId: number) => {
    setSelectedStudentIds((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]
    );
  };

  const toggleSelectAll = (visibleIds: number[]) => {
    if (visibleIds.length === 0) return;
    const allSelected = visibleIds.every((id) => selectedIdSet.has(id));
    if (allSelected) {
      const removeSet = new Set(visibleIds);
      setSelectedStudentIds((prev) => prev.filter((id) => !removeSet.has(id)));
    } else {
      setSelectedStudentIds((prev) => Array.from(new Set([...prev, ...visibleIds])));
    }
  };

  const handleBudgetRefreshed = async (refreshedCount: number) => {
    setSelectedStudentIds([]);
    setNotice(t.admin.students.refreshSuccess.replace('{count}', String(refreshedCount)));
    await onReload();
  };

  // Filtered students for "All students" view
  const filteredAllStudents = useMemo(() => {
    const q = allStudentsSearch.trim().toLowerCase();
    return students.filter((s) => {
      if (allStudentsClassFilter !== 'all') {
        const targetId = Number(allStudentsClassFilter);
        if (!s.classes?.some((c) => c.class_id === targetId)) return false;
      }
      if (!q) return true;
      return s.da.toLowerCase().includes(q) || s.name.toLowerCase().includes(q);
    });
  }, [students, allStudentsSearch, allStudentsClassFilter]);

  const handleClassCreated = async (created: TeacherClass) => {
    pendingSelectClassIdRef.current = created.id;
    if (isSuperAdmin && teacherFilter !== 'all' && String(created.teacher_id) !== teacherFilter) {
      setTeacherFilter('all');
    }
    setView('class');
    await onReload();
    setSelectedClassId(created.id);
  };

  const handleDeleteClass = async (targetClass: TeacherClass) => {
    setDeletingClass(true);
    setNotice(null);
    try {
      const res = await api.adminDeleteClass(targetClass.id);
      setConfirmDeleteClassId(null);
      if (res.disabled_students_count > 0) {
        setNotice(
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

  const handleQuickAddDa = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedClass) return;
    if (!/^\d{7}$/.test(quickDa.trim())) {
      onError(t.errors.invalidDa);
      return;
    }
    setAddingQuickDa(true);
    setNotice(null);
    try {
      await api.adminAddClassStudent(selectedClass.id, {
        da: quickDa.trim(),
        suggested_name: quickName.trim() || null,
      });
      setQuickDa('');
      setQuickName('');
      await onReload();
    } catch (err) {
      onError(translateApiError(err, t));
    } finally {
      setAddingQuickDa(false);
    }
  };

  const handleRemoveFromClass = async (targetDa: string) => {
    if (!selectedClass) return;
    setNotice(null);
    try {
      const res = await api.adminRemoveClassStudent(selectedClass.id, targetDa);
      if (res.student_disabled) {
        setNotice(
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

  const handleTransferStudent = async (da: string) => {
    if (!selectedClass || !transferTargetId) return;
    const targetId = Number(transferTargetId);
    const dest = classes.find((c) => c.id === targetId);
    setTransferring(true);
    setNotice(null);
    try {
      await api.adminTransferClassStudent(selectedClass.id, {
        da,
        target_class_id: targetId,
        remove_from_source: true,
      });
      setTransferDa(null);
      setTransferTargetId('');
      if (dest) {
        setNotice(
          t.admin.students.transferSuccess
            .replace('{da}', da)
            .replace('{className}', dest.name)
        );
      }
      await onReload();
    } catch (err) {
      onError(translateApiError(err, t));
    } finally {
      setTransferring(false);
    }
  };

  const handleSaveStudent = async (s: StudentAccount) => {
    const d = getDraft(s);
    setSavingStudentId(s.id);
    try {
      await api.adminUpdateStudent(s.id, {
        is_active: d.isActive,
        max_active_grams_override: d.maxGrams.trim() === '' ? null : Number(d.maxGrams),
        max_print_minutes_override: d.maxMinutes.trim() === '' ? null : Number(d.maxMinutes),
      });
      setStudentDrafts((prev) => {
        const next = { ...prev };
        delete next[s.id];
        return next;
      });
      await onReload();
    } catch (err) {
      onError(translateApiError(err, t));
    } finally {
      setSavingStudentId(null);
    }
  };

  const handleResetPassword = async (userId: number) => {
    try {
      const res = await api.adminResetPassword(userId);
      setResetResult(res);
    } catch (err) {
      onError(translateApiError(err, t));
    }
  };

  const handleAccountDecision = async (
    req: PendingAccountRequest,
    decision: 'approve' | 'reject'
  ) => {
    setBusyAccountId(req.id);
    setNotice(null);
    try {
      const defaultClassId =
        selectedClass && !selectedClass.is_default_individual ? String(selectedClass.id) : '';
      const chosen = requestClassSelections[req.id] ?? defaultClassId;
      await api.adminDecideAccountRequest(req.id, {
        decision,
        class_id: chosen ? Number(chosen) : null,
      });
      await onReload();
    } catch (err) {
      onError(translateApiError(err, t));
    } finally {
      setBusyAccountId(null);
    }
  };

  const enrolledCount = selectedClass
    ? (selectedClass.enrolled_count ?? selectedClass.enrollments.length)
    : 0;
  const registeredCount = selectedClass
    ? (selectedClass.registered_count ??
      selectedClass.enrollments.filter((e) => e.is_registered).length)
    : 0;
  const unclaimedCount = selectedClass
    ? (selectedClass.unclaimed_count ?? Math.max(0, enrolledCount - registeredCount))
    : 0;

  return (
    <div className="space-y-4">
      {notice && (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-2.5 text-xs font-medium text-amber-800 dark:text-amber-200">
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label={t.common.close}
            className="rounded-lg p-1 hover:bg-black/5 dark:hover:bg-white/10"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Master-Detail Class Manager */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        {/* Left Sidebar: Class List + Views */}
        <aside className="space-y-3 lg:col-span-4 xl:col-span-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-[#5B616E] dark:text-[#9399A6]">
              {t.admin.students.classesTitle} ({filteredClasses.length})
            </h2>
            <button
              type="button"
              onClick={() => setCreateModalOpen(true)}
              className="btn-primary px-2.5 py-1.5 text-xs"
            >
              <Plus className="h-3.5 w-3.5" />
              {t.admin.students.newClassBtn}
            </button>
          </div>

          {isSuperAdmin && teachers.length > 0 && (
            <div>
              <select
                aria-label={t.admin.students.classTeacherLabel}
                value={teacherFilter}
                onChange={(e) => setTeacherFilter(e.target.value)}
                className="studio-input py-1.5 text-xs"
              >
                <option value="all">{t.admin.students.allTeachersFilter}</option>
                {teachers.map((tc) => (
                  <option key={tc.id} value={String(tc.id)}>
                    {tc.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Quick Views: All Students & Pending Requests */}
          <div className="space-y-1.5">
            <button
              type="button"
              onClick={() => setView('all')}
              className={`flex w-full items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-left text-xs font-medium transition-all ${
                view === 'all'
                  ? 'border-[#00A7D9] bg-white text-[#111318] shadow-sm ring-1 ring-[#00A7D9]/25 dark:bg-[#1D2027] dark:text-[#F4F5F7]'
                  : 'border-black/[0.07] bg-white text-[#5B616E] hover:border-black/20 hover:text-[#111318] dark:border-white/[0.08] dark:bg-[#15171C] dark:text-[#9399A6] dark:hover:border-white/20 dark:hover:text-[#F4F5F7]'
              }`}
            >
              <span className="flex items-center gap-2">
                <Users className="h-3.5 w-3.5 text-[#00A7D9]" />
                <span>{t.admin.students.allStudentsView}</span>
              </span>
              <span className="rounded-md bg-black/[0.05] px-1.5 py-0.5 font-mono text-[11px] tabular-nums dark:bg-white/[0.08]">
                {students.length}
              </span>
            </button>

            {accountRequests.length > 0 && (
              <button
                type="button"
                onClick={() => setView('requests')}
                className={`flex w-full items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-left text-xs font-medium transition-all ${
                  view === 'requests'
                    ? 'border-amber-500 bg-amber-500/10 text-amber-900 shadow-sm dark:text-amber-200'
                    : 'border-amber-500/30 bg-amber-500/5 text-amber-800 hover:bg-amber-500/10 dark:text-amber-300'
                }`}
              >
                <span className="flex items-center gap-2">
                  <UserCheck className="h-3.5 w-3.5" />
                  <span>{t.admin.students.accountRequestsBadge}</span>
                </span>
                <span className="rounded-full bg-amber-500 px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums text-slate-950">
                  {accountRequests.length}
                </span>
              </button>
            )}
          </div>

          {/* Class List */}
          {filteredClasses.length === 0 ? (
            <div className="studio-surface p-6 text-center text-xs text-[#5B616E] dark:text-[#9399A6]">
              {t.admin.students.noClasses}
            </div>
          ) : (
            <div className="space-y-1.5">
              {filteredClasses.map((cls) => {
                const isSelected = view === 'class' && cls.id === selectedClass?.id;
                const clsEnrolled = cls.enrolled_count ?? cls.student_count;
                const clsRegistered =
                  cls.registered_count ?? cls.enrollments.filter((e) => e.is_registered).length;
                return (
                  <button
                    key={cls.id}
                    type="button"
                    onClick={() => {
                      setSelectedClassId(cls.id);
                      setView('class');
                    }}
                    className={`w-full rounded-xl border p-3 text-left transition-all ${
                      isSelected
                        ? 'border-[#00A7D9] bg-white shadow-sm ring-1 ring-[#00A7D9]/25 dark:bg-[#1D2027]'
                        : 'border-black/[0.07] bg-white hover:border-black/20 dark:border-white/[0.08] dark:bg-[#15171C] dark:hover:border-white/20'
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
                              {t.admin.students.defaultIndividualBadge}
                            </span>
                          )}
                        </div>
                      </div>
                      <span
                        className="shrink-0 rounded-md bg-black/[0.05] px-1.5 py-0.5 font-mono text-[11px] font-medium tabular-nums text-[#5B616E] dark:bg-white/[0.08] dark:text-[#9399A6]"
                        title={`${clsRegistered} / ${clsEnrolled}`}
                      >
                        {clsRegistered}/{clsEnrolled}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </aside>

        {/* Right Detail Workspace */}
        <div className="min-w-0 space-y-4 lg:col-span-8 xl:col-span-9">
          {/* Pending Account Requests View */}
          {view === 'requests' && (
            <div className="studio-surface overflow-hidden">
              <div className="border-b border-black/[0.06] px-5 py-4 dark:border-white/[0.07]">
                <h3 className="text-base font-semibold text-[#111318] dark:text-[#F4F5F7]">
                  {t.admin.accountRequests.title} ({accountRequests.length})
                </h3>
                <p className="mt-0.5 text-xs text-[#5B616E] dark:text-[#9399A6]">
                  {t.admin.accountRequests.subtitle}
                </p>
              </div>
              {accountRequests.length === 0 ? (
                <div className="p-10 text-center text-sm text-[#5B616E] dark:text-[#9399A6]">
                  {t.admin.accountRequests.noRequests}
                </div>
              ) : (
                <div className="divide-y divide-black/[0.06] dark:divide-white/[0.07]">
                  {accountRequests.map((req) => {
                    const isBusy = busyAccountId === req.id;
                    const teacherClasses = (
                      req.requested_teacher_id != null
                        ? classes.filter((c) => c.teacher_id === req.requested_teacher_id)
                        : classes
                    ).filter((c) => !c.is_default_individual);
                    const defaultVal =
                      selectedClass && !selectedClass.is_default_individual
                        ? String(selectedClass.id)
                        : '';
                    const selectedVal = requestClassSelections[req.id] ?? defaultVal;

                    return (
                      <div
                        key={req.id}
                        className="flex flex-wrap items-center justify-between gap-4 px-5 py-4"
                      >
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-semibold text-[#111318] dark:text-[#F4F5F7]">
                              {req.name}
                            </span>
                            <span className="studio-subtle px-2 py-0.5 font-mono text-xs tabular-nums text-[#5B616E] dark:text-[#9399A6]">
                              {req.da}
                            </span>
                            {req.requested_teacher_name && (
                              <span className="rounded-full bg-[#00A7D9]/12 px-2 py-0.5 text-[11px] font-medium text-[#007BA3] dark:text-[#38C6F4]">
                                {req.requested_teacher_name}
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <select
                            aria-label={t.admin.accountRequests.targetClassLabel}
                            value={selectedVal}
                            disabled={isBusy}
                            onChange={(e) =>
                              setRequestClassSelections((prev) => ({
                                ...prev,
                                [req.id]: e.target.value,
                              }))
                            }
                            className="studio-input w-auto py-1.5 text-xs"
                          >
                            <option value="">{t.admin.accountRequests.defaultIndividualOption}</option>
                            {teacherClasses.map((cls) => (
                              <option key={cls.id} value={String(cls.id)}>
                                {cls.name}
                                {cls.code ? ` (${cls.code})` : ''}
                              </option>
                            ))}
                          </select>
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
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* All Students View */}
          {view === 'all' && (() => {
            const visibleAllIds = filteredAllStudents.map((s) => s.id);
            const allVisibleSelected =
              visibleAllIds.length > 0 && visibleAllIds.every((id) => selectedIdSet.has(id));
            return (
            <div className="studio-surface overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-black/[0.07] px-5 py-4 dark:border-white/[0.08]">
                <h3 className="text-base font-semibold text-[#111318] dark:text-[#F4F5F7]">
                  {t.admin.students.allStudentsView} ({filteredAllStudents.length})
                </h3>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8A909E]" />
                    <input
                      type="text"
                      value={allStudentsSearch}
                      onChange={(e) => setAllStudentsSearch(e.target.value)}
                      placeholder={t.admin.students.searchPlaceholder}
                      className="studio-input w-56 py-1.5 pl-8 text-xs"
                    />
                  </div>
                  {classes.length > 0 && (
                    <select
                      aria-label={t.admin.students.selectClassLabel}
                      value={allStudentsClassFilter}
                      onChange={(e) => setAllStudentsClassFilter(e.target.value)}
                      className="studio-input w-auto py-1.5 text-xs"
                    >
                      <option value="all">{t.admin.students.allClassesFilter}</option>
                      {classes.map((cls) => (
                        <option key={cls.id} value={String(cls.id)}>
                          {isSuperAdmin ? `${cls.name} (${cls.teacher_name})` : cls.name}
                        </option>
                      ))}
                    </select>
                  )}
                  {isSuperAdmin && (
                    <button
                      type="button"
                      onClick={() => setRefreshTarget({ scope: 'all' })}
                      className="btn-secondary py-1.5 text-xs"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      {t.admin.students.refreshAllBudgetBtn}
                    </button>
                  )}
                </div>
              </div>

              {selectedStudentIds.length > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#00A7D9]/20 bg-[#00A7D9]/[0.07] px-5 py-2.5 text-xs">
                  <span className="font-medium text-[#007BA3] dark:text-[#38C6F4]">
                    {t.admin.students.selectedCount.replace(
                      '{count}',
                      String(selectedStudentIds.length)
                    )}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        setRefreshTarget({ scope: 'users', userIds: [...selectedStudentIds] })
                      }
                      className="btn-primary py-1 text-xs"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      {t.admin.students.refreshSelectedBtn.replace(
                        '{count}',
                        String(selectedStudentIds.length)
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedStudentIds([])}
                      className="btn-ghost py-1 text-xs"
                    >
                      {t.admin.students.clearSelectionBtn}
                    </button>
                  </div>
                </div>
              )}

              {filteredAllStudents.length === 0 ? (
                <div className="p-10 text-center text-sm text-[#5B616E] dark:text-[#9399A6]">
                  {t.admin.students.noStudentsMatch}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-black/[0.06] bg-[#F6F7F9] text-[11px] font-medium text-[#5B616E] dark:border-white/[0.07] dark:bg-[#0D0E11] dark:text-[#9399A6]">
                      <tr>
                        <th className="w-10 py-2.5 pl-5 pr-2">
                          <input
                            type="checkbox"
                            aria-label="Select all visible students"
                            checked={allVisibleSelected}
                            onChange={() => toggleSelectAll(visibleAllIds)}
                            className="h-4 w-4 rounded"
                          />
                        </th>
                        <th className="px-3 py-2.5">{t.common.daLabel}</th>
                        <th className="px-3 py-2.5">{t.auth.nameLabel}</th>
                        <th className="px-3 py-2.5">{t.admin.students.classesTitle}</th>
                        <th className="px-3 py-2.5">{t.admin.students.activeGrams}</th>
                        <th className="px-3 py-2.5">{t.admin.students.maxGramsOverride}</th>
                        <th className="px-3 py-2.5">{t.admin.students.maxMinutesOverride}</th>
                        <th className="px-3 py-2.5">{t.admin.students.activeStatus}</th>
                        <th className="px-5 py-2.5 text-right">{t.admin.students.actionsCol}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-black/[0.06] dark:divide-white/[0.07]">
                      {filteredAllStudents.map((s) => {
                        const d = getDraft(s);
                        const dirty = isDraftDirty(s);
                        return (
                          <tr
                            key={s.id}
                            className="hover:bg-black/[0.015] dark:hover:bg-white/[0.02]"
                          >
                            <td className="py-3 pl-5 pr-2">
                              <input
                                type="checkbox"
                                aria-label={`Select ${s.da}`}
                                checked={selectedIdSet.has(s.id)}
                                onChange={() => toggleSelectStudent(s.id)}
                                className="h-4 w-4 rounded"
                              />
                            </td>
                            <td className="px-3 py-3 font-mono font-medium tabular-nums text-[#111318] dark:text-[#F4F5F7]">
                              {s.da}
                            </td>
                            <td className="px-3 py-3">
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
                              </div>
                            </td>
                            <td className="px-3 py-3">
                              <div className="flex max-w-[200px] flex-wrap gap-1">
                                {s.classes && s.classes.length > 0 ? (
                                  s.classes.map((badge) => (
                                    <span
                                      key={badge.class_id}
                                      className="studio-subtle inline-flex items-center px-2 py-0.5 text-[10px] font-medium text-[#111318] dark:text-[#F4F5F7]"
                                    >
                                      {badge.class_name}
                                    </span>
                                  ))
                                ) : (
                                  <span className="text-[#8A909E]">—</span>
                                )}
                              </div>
                            </td>
                            <td className="px-3 py-3 font-mono tabular-nums text-[#5B616E] dark:text-[#9399A6]">
                              {s.active_grams_used.toFixed(1)} /{' '}
                              {s.effective_max_active_grams.toFixed(0)} g
                            </td>
                            <td className="px-3 py-3">
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
                                className="studio-input w-24 py-1 font-mono text-xs tabular-nums"
                              />
                            </td>
                            <td className="px-3 py-3">
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
                                className="studio-input w-24 py-1 font-mono text-xs tabular-nums"
                              />
                            </td>
                            <td className="px-3 py-3">
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
                                  disabled={savingStudentId === s.id}
                                  onClick={() => handleSaveStudent(s)}
                                  className={`${
                                    dirty ? 'btn-primary' : 'btn-secondary'
                                  } px-2.5 py-1 text-[11px]`}
                                >
                                  <Save className="h-3 w-3" />
                                  {t.common.save}
                                </button>
                                <button
                                  type="button"
                                  title={t.admin.students.refreshBudgetBtn}
                                  aria-label={`${t.admin.students.refreshBudgetBtn} ${s.da}`}
                                  onClick={() =>
                                    setRefreshTarget({
                                      scope: 'users',
                                      userIds: [s.id],
                                      label: `${s.name} (${s.da})`,
                                    })
                                  }
                                  className="btn-ghost p-1.5"
                                >
                                  <RotateCcw className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  title={t.admin.students.resetPasswordBtn}
                                  aria-label={`${t.admin.students.resetPasswordBtn} ${s.da}`}
                                  onClick={() => handleResetPassword(s.id)}
                                  className="btn-ghost p-1.5"
                                >
                                  <KeyRound className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            );
          })()}

          {/* Selected Class Detail Workspace */}
          {view === 'class' && (
            <>
              {!selectedClass ? (
                <div className="studio-surface flex flex-col items-center justify-center gap-3 p-12 text-center">
                  <BookOpen className="h-6 w-6 text-[#8A909E]" />
                  <p className="text-sm text-[#5B616E] dark:text-[#9399A6]">
                    {t.admin.students.noClasses}
                  </p>
                  <button
                    type="button"
                    onClick={() => setCreateModalOpen(true)}
                    className="btn-primary py-1.5 text-xs"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {t.admin.students.newClassBtn}
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Pending requests compact banner */}
                  {accountRequests.length > 0 && (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/25 bg-amber-500/8 px-4 py-2.5 text-xs">
                      <div className="flex items-center gap-2 font-medium text-amber-800 dark:text-amber-200">
                        <UserCheck className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                        <span>
                          {t.admin.students.pendingRequestsBanner.replace(
                            '{count}',
                            String(accountRequests.length)
                          )}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setView('requests')}
                        className="font-semibold text-amber-800 underline hover:text-amber-950 dark:text-amber-300 dark:hover:text-amber-100"
                      >
                        {t.admin.accountRequests.approveBtn}
                      </button>
                    </div>
                  )}

                  {/* Class Header + Summary Stats */}
                  <div className="studio-surface space-y-4 p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-lg font-semibold tracking-tight text-[#111318] dark:text-[#F4F5F7]">
                            {selectedClass.name}
                          </h3>
                          {selectedClass.code && (
                            <span className="studio-subtle px-2 py-0.5 font-mono text-xs text-[#5B616E] dark:text-[#9399A6]">
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
                        {(selectedClass.default_max_active_grams != null ||
                          selectedClass.default_max_print_minutes != null) && (
                          <div className="flex flex-wrap items-center gap-3 text-xs text-[#5B616E] dark:text-[#9399A6]">
                            {selectedClass.default_max_active_grams != null && (
                              <span className="font-mono tabular-nums">
                                {t.admin.students.maxGramsOverride}:{' '}
                                <strong className="text-[#111318] dark:text-[#F4F5F7]">
                                  {selectedClass.default_max_active_grams} g
                                </strong>
                              </span>
                            )}
                            {selectedClass.default_max_print_minutes != null && (
                              <span className="font-mono tabular-nums">
                                {t.admin.students.maxMinutesOverride}:{' '}
                                <strong className="text-[#111318] dark:text-[#F4F5F7]">
                                  {selectedClass.default_max_print_minutes} min
                                </strong>
                              </span>
                            )}
                          </div>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setBulkAddClass(selectedClass)}
                          className="btn-primary py-1.5 text-xs"
                        >
                          <UserPlus className="h-3.5 w-3.5" />
                          {t.admin.students.bulkAddBtn}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setRefreshTarget({
                              scope: 'class',
                              classId: selectedClass.id,
                              className: selectedClass.name,
                            })
                          }
                          className="btn-secondary py-1.5 text-xs"
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          {t.admin.students.refreshClassBudgetBtn}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingClass(selectedClass)}
                          className="btn-secondary py-1.5 text-xs"
                        >
                          <Edit3 className="h-3.5 w-3.5" />
                          {t.admin.students.editClassBtn}
                        </button>
                        {!selectedClass.is_default_individual && (
                          <button
                            type="button"
                            disabled={deletingClass}
                            onClick={() =>
                              setConfirmDeleteClassId(
                                confirmDeleteClassId === selectedClass.id
                                  ? null
                                  : selectedClass.id
                              )
                            }
                            className="btn-ghost px-2.5 py-1.5 text-xs text-rose-600 hover:bg-rose-500/10 hover:text-rose-700 dark:text-rose-400 dark:hover:text-rose-300"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            {t.admin.students.deleteClassBtn}
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Inline Delete Confirmation */}
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
                            {t.admin.students.deleteClassConfirmBtn}
                          </button>
                        </div>
                      </div>
                    )}

                    {/* 3 Summary Stat Cards */}
                    <div className="grid grid-cols-3 gap-3">
                      <div className="studio-subtle px-3.5 py-2.5">
                        <div className="text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                          {t.admin.students.enrolledStat}
                        </div>
                        <div className="mt-0.5 font-mono text-lg font-semibold tabular-nums text-[#111318] dark:text-[#F4F5F7]">
                          {enrolledCount}
                        </div>
                      </div>
                      <div className="studio-subtle px-3.5 py-2.5">
                        <div className="text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                          {t.admin.students.registeredStat}
                        </div>
                        <div className="mt-0.5 font-mono text-lg font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
                          {registeredCount}
                        </div>
                      </div>
                      <div className="studio-subtle px-3.5 py-2.5">
                        <div className="text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                          {t.admin.students.unclaimedStat}
                        </div>
                        <div className="mt-0.5 font-mono text-lg font-semibold tabular-nums text-[#5B616E] dark:text-[#9399A6]">
                          {unclaimedCount}
                        </div>
                      </div>
                    </div>

                    {/* Quick Single-DA Add Bar */}
                    <form
                      onSubmit={handleQuickAddDa}
                      className="flex flex-wrap items-center gap-2 border-t border-black/[0.06] pt-3.5 dark:border-white/[0.07]"
                    >
                      <input
                        type="text"
                        maxLength={7}
                        value={quickDa}
                        onChange={(e) => setQuickDa(e.target.value.replace(/\D/g, '').slice(0, 7))}
                        placeholder={t.admin.students.da}
                        className="studio-input w-36 py-1.5 font-mono text-xs tabular-nums"
                        required
                      />
                      <input
                        type="text"
                        value={quickName}
                        onChange={(e) => setQuickName(e.target.value)}
                        placeholder={t.admin.students.suggestedName}
                        className="studio-input min-w-[180px] flex-1 py-1.5 text-xs"
                      />
                      <button
                        type="submit"
                        disabled={addingQuickDa || quickDa.trim().length !== 7}
                        className="btn-secondary py-1.5 text-xs"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        {t.admin.students.addToClassBtn}
                      </button>
                    </form>
                  </div>

                  {/* Roster Table Card */}
                  <div className="studio-surface overflow-hidden">
                    {/* Search & Segmented Filter Toolbar */}
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-black/[0.06] px-5 py-3.5 dark:border-white/[0.07]">
                      <div className="relative min-w-[220px] flex-1 sm:max-w-xs">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8A909E]" />
                        <input
                          type="text"
                          value={rosterSearch}
                          onChange={(e) => setRosterSearch(e.target.value)}
                          placeholder={t.admin.students.searchPlaceholder}
                          className="studio-input py-1.5 pl-8 text-xs"
                        />
                      </div>

                      <div className="inline-flex rounded-xl bg-black/[0.04] p-0.5 dark:bg-white/[0.06]">
                        {(['all', 'registered', 'unclaimed'] as const).map((mode) => {
                          const active = rosterFilter === mode;
                          const label =
                            mode === 'all'
                              ? t.admin.students.filterAll
                              : mode === 'registered'
                                ? t.admin.students.filterRegistered
                                : t.admin.students.filterUnclaimed;
                          return (
                            <button
                              key={mode}
                              type="button"
                              onClick={() => setRosterFilter(mode)}
                              className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                                active
                                  ? 'bg-white text-[#111318] shadow-sm dark:bg-[#1D2027] dark:text-[#F4F5F7]'
                                  : 'text-[#5B616E] hover:text-[#111318] dark:text-[#9399A6] dark:hover:text-[#F4F5F7]'
                              }`}
                            >
                              {label}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {selectedStudentIds.length > 0 && (
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#00A7D9]/20 bg-[#00A7D9]/[0.07] px-5 py-2.5 text-xs">
                        <span className="font-medium text-[#007BA3] dark:text-[#38C6F4]">
                          {t.admin.students.selectedCount.replace(
                            '{count}',
                            String(selectedStudentIds.length)
                          )}
                        </span>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              setRefreshTarget({
                                scope: 'users',
                                userIds: [...selectedStudentIds],
                              })
                            }
                            className="btn-primary py-1 text-xs"
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                            {t.admin.students.refreshSelectedBtn.replace(
                              '{count}',
                              String(selectedStudentIds.length)
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => setSelectedStudentIds([])}
                            className="btn-ghost py-1 text-xs"
                          >
                            {t.admin.students.clearSelectionBtn}
                          </button>
                        </div>
                      </div>
                    )}

                    {selectedClass.enrollments.length === 0 ? (
                      <div className="flex flex-col items-center justify-center gap-3 px-5 py-12 text-center">
                        <p className="text-sm text-[#5B616E] dark:text-[#9399A6]">
                          {t.admin.students.noStudentsInClass}
                        </p>
                        <button
                          type="button"
                          onClick={() => setBulkAddClass(selectedClass)}
                          className="btn-primary py-1.5 text-xs"
                        >
                          <UserPlus className="h-3.5 w-3.5" />
                          {t.admin.students.bulkAddBtn}
                        </button>
                      </div>
                    ) : filteredEnrollments.length === 0 ? (
                      <div className="px-5 py-10 text-center text-xs text-[#5B616E] dark:text-[#9399A6]">
                        {t.admin.students.noStudentsMatch}
                      </div>
                    ) : (() => {
                      const visibleRosterUserIds = filteredEnrollments
                        .map(
                          (entry) =>
                            ((entry.user_id != null
                              ? studentsById.get(entry.user_id)
                              : undefined) ?? studentsByDa.get(entry.da))?.id
                        )
                        .filter((id): id is number => id != null);
                      const allVisibleRosterSelected =
                        visibleRosterUserIds.length > 0 &&
                        visibleRosterUserIds.every((id) => selectedIdSet.has(id));
                      return (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs">
                          <thead className="border-b border-black/[0.06] bg-[#F6F7F9] text-[11px] font-medium text-[#5B616E] dark:border-white/[0.07] dark:bg-[#0D0E11] dark:text-[#9399A6]">
                            <tr>
                              <th className="w-10 py-2.5 pl-5 pr-2">
                                <input
                                  type="checkbox"
                                  aria-label="Select all visible students"
                                  disabled={visibleRosterUserIds.length === 0}
                                  checked={allVisibleRosterSelected}
                                  onChange={() => toggleSelectAll(visibleRosterUserIds)}
                                  className="h-4 w-4 rounded"
                                />
                              </th>
                              <th className="px-3 py-2.5">{t.common.daLabel}</th>
                              <th className="px-3 py-2.5">{t.auth.nameLabel}</th>
                              <th className="px-3 py-2.5">{t.admin.students.activeGrams}</th>
                              <th className="px-3 py-2.5">{t.admin.students.maxGramsOverride}</th>
                              <th className="px-3 py-2.5">{t.admin.students.maxMinutesOverride}</th>
                              <th className="px-5 py-2.5 text-right">
                                {t.admin.students.actionsCol}
                              </th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-black/[0.06] dark:divide-white/[0.07]">
                            {filteredEnrollments.map((entry) => {
                              const account =
                                (entry.user_id != null
                                  ? studentsById.get(entry.user_id)
                                  : undefined) ?? studentsByDa.get(entry.da);
                              const d = account ? getDraft(account) : null;
                              const dirty = account ? isDraftDirty(account) : false;
                              const displayName =
                                entry.registered_name ||
                                account?.name ||
                                entry.suggested_name ||
                                '—';
                              const isTransferringThis = transferDa === entry.da;

                              return (
                                <React.Fragment key={entry.id}>
                                  <tr className="hover:bg-black/[0.015] dark:hover:bg-white/[0.02]">
                                    <td className="py-3 pl-5 pr-2">
                                      {account ? (
                                        <input
                                          type="checkbox"
                                          aria-label={`Select ${entry.da}`}
                                          checked={selectedIdSet.has(account.id)}
                                          onChange={() => toggleSelectStudent(account.id)}
                                          className="h-4 w-4 rounded"
                                        />
                                      ) : (
                                        <span className="inline-block h-4 w-4" />
                                      )}
                                    </td>
                                    <td className="px-3 py-3 font-mono font-medium tabular-nums text-[#111318] dark:text-[#F4F5F7]">
                                      {entry.da}
                                    </td>
                                    <td className="px-3 py-3">
                                      <div className="flex flex-wrap items-center gap-1.5">
                                        <span className="font-medium text-[#111318] dark:text-[#F4F5F7]">
                                          {displayName}
                                        </span>
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
                                      </div>
                                    </td>
                                    <td className="px-3 py-3 font-mono tabular-nums text-[#5B616E] dark:text-[#9399A6]">
                                      {account ? (
                                        <>
                                          {account.active_grams_used.toFixed(1)} /{' '}
                                          {account.effective_max_active_grams.toFixed(0)} g
                                        </>
                                      ) : entry.effective_max_active_grams != null ? (
                                        <>
                                          {(entry.active_grams_used ?? 0).toFixed(1)} /{' '}
                                          {entry.effective_max_active_grams.toFixed(0)} g
                                        </>
                                      ) : (
                                        <span className="text-[#8A909E]">—</span>
                                      )}
                                    </td>
                                    <td className="px-3 py-3">
                                      {account && d ? (
                                        <input
                                          type="number"
                                          step="1"
                                          value={d.maxGrams}
                                          placeholder={t.admin.students.globalDefaultPlaceholder}
                                          onChange={(e) =>
                                            setStudentDrafts((prev) => ({
                                              ...prev,
                                              [account.id]: { ...d, maxGrams: e.target.value },
                                            }))
                                          }
                                          className="studio-input w-24 py-1 font-mono text-xs tabular-nums"
                                        />
                                      ) : (
                                        <span className="font-mono text-[#5B616E] dark:text-[#9399A6]">
                                          {entry.max_active_grams_override != null
                                            ? `${entry.max_active_grams_override} g`
                                            : t.admin.students.globalDefaultPlaceholder}
                                        </span>
                                      )}
                                    </td>
                                    <td className="px-3 py-3">
                                      {account && d ? (
                                        <input
                                          type="number"
                                          step="10"
                                          value={d.maxMinutes}
                                          placeholder={t.admin.students.globalDefaultPlaceholder}
                                          onChange={(e) =>
                                            setStudentDrafts((prev) => ({
                                              ...prev,
                                              [account.id]: { ...d, maxMinutes: e.target.value },
                                            }))
                                          }
                                          className="studio-input w-24 py-1 font-mono text-xs tabular-nums"
                                        />
                                      ) : (
                                        <span className="font-mono text-[#5B616E] dark:text-[#9399A6]">
                                          {entry.max_print_minutes_override != null
                                            ? `${entry.max_print_minutes_override} min`
                                            : t.admin.students.globalDefaultPlaceholder}
                                        </span>
                                      )}
                                    </td>
                                    <td className="px-5 py-3 text-right">
                                      <div className="inline-flex items-center gap-1">
                                        {account && (
                                          <button
                                            type="button"
                                            disabled={savingStudentId === account.id || !dirty}
                                            onClick={() => handleSaveStudent(account)}
                                            title={t.common.save}
                                            aria-label={`${t.common.save} ${entry.da}`}
                                            className={`${
                                              dirty ? 'btn-primary' : 'btn-ghost'
                                            } px-2 py-1 text-[11px]`}
                                          >
                                            <Save className="h-3.5 w-3.5" />
                                          </button>
                                        )}
                                        {account && (
                                          <button
                                            type="button"
                                            title={t.admin.students.refreshBudgetBtn}
                                            aria-label={`${t.admin.students.refreshBudgetBtn} ${entry.da}`}
                                            onClick={() =>
                                              setRefreshTarget({
                                                scope: 'users',
                                                userIds: [account.id],
                                                label: `${displayName} (${entry.da})`,
                                              })
                                            }
                                            className="btn-ghost p-1.5"
                                          >
                                            <RotateCcw className="h-3.5 w-3.5" />
                                          </button>
                                        )}
                                        {account && (
                                          <button
                                            type="button"
                                            title={t.admin.students.resetPasswordBtn}
                                            aria-label={`${t.admin.students.resetPasswordBtn} ${entry.da}`}
                                            onClick={() => handleResetPassword(account.id)}
                                            className="btn-ghost p-1.5"
                                          >
                                            <KeyRound className="h-3.5 w-3.5" />
                                          </button>
                                        )}
                                        {transferableClasses.length > 0 && (
                                          <button
                                            type="button"
                                            title={t.admin.students.transferTitle}
                                            aria-label={`${t.admin.students.transferBtn} ${entry.da}`}
                                            onClick={() => {
                                              if (isTransferringThis) {
                                                setTransferDa(null);
                                                setTransferTargetId('');
                                              } else {
                                                setTransferDa(entry.da);
                                                setTransferTargetId(
                                                  String(transferableClasses[0].id)
                                                );
                                              }
                                            }}
                                            className={`btn-ghost p-1.5 ${
                                              isTransferringThis
                                                ? 'bg-[#00A7D9]/12 text-[#007BA3] dark:text-[#38C6F4]'
                                                : ''
                                            }`}
                                          >
                                            <ArrowRightLeft className="h-3.5 w-3.5" />
                                          </button>
                                        )}
                                        <button
                                          type="button"
                                          title={t.admin.students.removeFromClassBtn}
                                          aria-label={`${t.admin.students.removeFromClassBtn} ${entry.da}`}
                                          onClick={() => handleRemoveFromClass(entry.da)}
                                          className="btn-ghost p-1.5 text-[#5B616E] hover:text-rose-600 dark:text-[#9399A6] dark:hover:text-rose-400"
                                        >
                                          <UserMinus className="h-3.5 w-3.5" />
                                        </button>
                                      </div>
                                    </td>
                                  </tr>

                                  {isTransferringThis && (
                                    <tr className="bg-[#00A7D9]/[0.05] dark:bg-[#00A7D9]/[0.08]">
                                      <td colSpan={7} className="px-5 py-2.5">
                                        <div className="flex flex-wrap items-center justify-end gap-2">
                                          <span className="text-xs font-medium text-[#111318] dark:text-[#F4F5F7]">
                                            {t.admin.students.transferToLabel}:
                                          </span>
                                          <select
                                            aria-label={t.admin.students.transferToLabel}
                                            value={transferTargetId}
                                            onChange={(e) => setTransferTargetId(e.target.value)}
                                            className="studio-input w-auto py-1 text-xs"
                                          >
                                            {transferableClasses.map((dest) => (
                                              <option key={dest.id} value={String(dest.id)}>
                                                {dest.name}
                                                {dest.code ? ` (${dest.code})` : ''}
                                              </option>
                                            ))}
                                          </select>
                                          <button
                                            type="button"
                                            disabled={transferring || !transferTargetId}
                                            onClick={() => handleTransferStudent(entry.da)}
                                            className="btn-primary py-1 text-xs"
                                          >
                                            <Check className="h-3.5 w-3.5" />
                                            {t.common.confirm}
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => {
                                              setTransferDa(null);
                                              setTransferTargetId('');
                                            }}
                                            className="btn-secondary py-1 text-xs"
                                          >
                                            {t.common.cancel}
                                          </button>
                                        </div>
                                      </td>
                                    </tr>
                                  )}
                                </React.Fragment>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      );
                    })()}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Modals */}
      <CreateClassModal
        open={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        canManageAllClasses={isSuperAdmin}
        teachers={teachers}
        onCreated={handleClassCreated}
        onError={onError}
      />

      <EditClassModal
        targetClass={editingClass}
        onClose={() => setEditingClass(null)}
        onUpdated={onReload}
        onError={onError}
      />

      <BulkAddStudentsModal
        targetClass={bulkAddClass}
        onClose={() => setBulkAddClass(null)}
        onImported={onReload}
        onError={onError}
      />

      <RefreshBudgetModal
        target={refreshTarget}
        onClose={() => setRefreshTarget(null)}
        onRefreshed={handleBudgetRefreshed}
        onError={onError}
      />

      <TempPasswordModal
        resetResult={resetResult}
        onClose={() => setResetResult(null)}
      />
    </div>
  );
}
