import { useRef, useState } from 'react';
import {
  CheckCircle2,
  FileCode2,
  FlaskConical,
  Link2,
  Loader2,
  Plus,
  Printer as PrinterIcon,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';
import { api } from '../../api/client';
import { formatMinutes, useI18n } from '../../i18n';
import type {
  AdminPrinter,
  FdmMonsterRemotePrinter,
  Filament,
  FilamentApiPrinter,
  OrcaProfile,
  ProfileKind,
  TestSliceResult,
} from '../../types/api';
import { translateApiError } from '../../utils/errors';
import { PrinterStatusBadge } from '../StatusBadge';
import { AddPrinterModal } from './AddPrinterModal';

interface AdminPrintersTabProps {
  printers: AdminPrinter[];
  filaments: Filament[];
  profiles: OrcaProfile[];
  canManagePrinters?: boolean;
  canManageSlots?: boolean;
  canEditPrinters?: boolean;
  canCreateDeletePrinters?: boolean;
  canManageProfiles?: boolean;
  filamentApiEnabled: boolean;
  filamentApiPrinters: FilamentApiPrinter[];
  remoteFdmPrinters?: FdmMonsterRemotePrinter[];
  onReload: () => Promise<void>;
  onError: (msg: string) => void;
}

export function AdminPrintersTab({
  printers,
  filaments,
  profiles,
  canManagePrinters = true,
  canManageSlots = true,
  canEditPrinters = true,
  canCreateDeletePrinters = true,
  canManageProfiles = true,
  filamentApiEnabled,
  filamentApiPrinters,
  remoteFdmPrinters = [],
  onReload,
  onError,
}: AdminPrintersTabProps) {
  const { lang, t } = useI18n();
  const [subTab, setSubTab] = useState<'machines' | 'profiles'>(() =>
    canManagePrinters ? 'machines' : 'profiles'
  );
  const [syncing, setSyncing] = useState(false);
  const [syncingFilaments, setSyncingFilaments] = useState(false);
  const [filamentSyncNote, setFilamentSyncNote] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [uploadingKey, setUploadingKey] = useState<string | null>(null);
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestSliceResult>>({});
  const [drafts, setDrafts] = useState<Record<number, Partial<AdminPrinter>>>({});

  // Add / Catalog modal state
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [catalogTargetPrinter, setCatalogTargetPrinter] = useState<AdminPrinter | null>(null);

  // Unified OrcaSlicer JSON Profiles sub-tab state
  const [pName, setPName] = useState('');
  const [pKind, setPKind] = useState<ProfileKind>('machine');
  const [pNotes, setPNotes] = useState('');
  const [pFile, setPFile] = useState<File | null>(null);
  const [uploadingStandaloneProfile, setUploadingStandaloneProfile] = useState(false);
  const standaloneProfileInputRef = useRef<HTMLInputElement | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingUploadRef = useRef<{ printerId: number; kind: 'machine' | 'process' } | null>(null);

  const machineProfiles = profiles.filter((p) => p.kind === 'machine');
  const processProfiles = profiles.filter((p) => p.kind === 'process');

  const effectiveSubTab =
    !canManagePrinters && canManageProfiles
      ? 'profiles'
      : subTab === 'profiles' && !canManageProfiles
        ? 'machines'
        : subTab;

  const getDraft = (p: AdminPrinter): AdminPrinter => ({
    ...p,
    ...(drafts[p.id] || {}),
  });

  const updateDraft = (id: number, patch: Partial<AdminPrinter>) => {
    setDrafts((prev) => ({
      ...prev,
      [id]: { ...(prev[id] || {}), ...patch },
    }));
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      await api.adminSyncPrinters();
      await onReload();
    } catch (err) {
      onError(translateApiError(err, t));
    } finally {
      setSyncing(false);
    }
  };

  const handleSyncFilaments = async () => {
    setSyncingFilaments(true);
    setFilamentSyncNote(null);
    try {
      const res = await api.adminSyncPrinterFilaments();
      if (res.synced_count === 0) {
        setFilamentSyncNote(t.admin.printers.syncFilamentsNone);
      } else {
        setFilamentSyncNote(
          t.admin.printers.syncFilamentsSummary
            .replace('{synced}', String(res.synced_count))
            .replace('{changed}', String(res.changed_count))
        );
      }
      await onReload();
    } catch (err) {
      onError(translateApiError(err, t));
    } finally {
      setSyncingFilaments(false);
    }
  };

  const handleSavePrinter = async (printer: AdminPrinter) => {
    const d = getDraft(printer);
    setSavingId(printer.id);
    try {
      const payload: Parameters<typeof api.adminUpdatePrinter>[1] = {
        is_enabled: d.is_enabled,
        display_name: d.display_name ?? d.name,
        printer_type: d.printer_type,
        bed_x_mm: Number(d.bed_x_mm),
        bed_y_mm: Number(d.bed_y_mm),
        bed_z_mm: Number(d.bed_z_mm),
        mmu_slots_count: Number(d.mmu_slots_count),
        machine_profile_id: d.machine_profile_id ?? null,
        process_profile_id: d.process_profile_id ?? null,
        filament_api_printer_id: d.filament_api_printer_id?.trim() || null,
      };
      if (drafts[printer.id]?.fdm_monster_id !== undefined) {
        payload.fdm_monster_id = d.fdm_monster_id?.trim() ?? '';
      }
      await api.adminUpdatePrinter(printer.id, payload);
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[printer.id];
        return next;
      });
      await onReload();
    } catch (err) {
      onError(translateApiError(err, t));
    } finally {
      setSavingId(null);
    }
  };

  const handleDeletePrinter = async (printerId: number) => {
    setDeletingId(printerId);
    try {
      await api.adminDeletePrinter(printerId);
      setConfirmDeleteId(null);
      await onReload();
    } catch (err) {
      onError(translateApiError(err, t));
    } finally {
      setDeletingId(null);
    }
  };

  const triggerProfileUpload = (printerId: number, kind: 'machine' | 'process') => {
    pendingUploadRef.current = { printerId, kind };
    fileInputRef.current?.click();
  };

  const handleProfileFileChange = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0] ?? null;
    ev.target.value = '';
    const target = pendingUploadRef.current;
    pendingUploadRef.current = null;
    if (!file || !target) return;

    const key = `${target.printerId}-${target.kind}`;
    setUploadingKey(key);
    try {
      let profileName = file.name.replace(/\.json$/i, '');
      try {
        const text = await file.text();
        const parsed = JSON.parse(text.replace(/^\uFEFF/, '')) as Record<string, unknown>;
        if (typeof parsed.name === 'string' && parsed.name.trim()) {
          profileName = parsed.name.trim();
        }
      } catch {
        // Let backend validate JSON error if malformed
      }

      const uploaded = await api.adminUploadProfile(file, profileName, target.kind, '');
      await api.adminUpdatePrinter(
        target.printerId,
        target.kind === 'machine'
          ? { machine_profile_id: uploaded.id }
          : { process_profile_id: uploaded.id }
      );
      updateDraft(
        target.printerId,
        target.kind === 'machine'
          ? { machine_profile_id: uploaded.id }
          : { process_profile_id: uploaded.id }
      );
      await onReload();
    } catch (err) {
      onError(translateApiError(err, t));
    } finally {
      setUploadingKey(null);
    }
  };

  const handleUpdateSlot = async (
    printerId: number,
    slotIndex: number,
    filamentId: number | null,
    label: string,
    isLoaded: boolean
  ) => {
    try {
      await api.adminUpdatePrinterSlot(printerId, slotIndex, {
        filament_id: filamentId,
        label,
        is_loaded: isLoaded,
      });
      await onReload();
    } catch (err) {
      onError(translateApiError(err, t));
    }
  };

  const handleTestSlice = async (printerId: number, slotId: number) => {
    const key = `${printerId}-${slotId}`;
    setTestingKey(key);
    try {
      const res = await api.adminTestSlice(printerId, slotId);
      setTestResults((prev) => ({ ...prev, [key]: res }));
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [key]: {
          ok: false,
          estimated_grams: 0,
          estimated_minutes: 0,
          command_preview: '',
          error: translateApiError(err, t),
        },
      }));
    } finally {
      setTestingKey(null);
    }
  };

  const handleStandaloneProfileFileSelect = async (file: File | null) => {
    setPFile(file);
    if (!file) return;
    const fallbackName = file.name.replace(/\.json$/i, '');
    try {
      const text = await file.text();
      const parsed = JSON.parse(text.replace(/^\uFEFF/, '')) as Record<string, unknown>;
      const detectedName =
        typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : fallbackName;
      if (!pName.trim()) {
        setPName(detectedName);
      }
      const rawType = typeof parsed.type === 'string' ? parsed.type.toLowerCase() : '';
      if (rawType === 'machine' || rawType === 'printer') {
        setPKind('machine');
      } else if (rawType === 'process' || rawType === 'print') {
        setPKind('process');
      } else if (rawType === 'filament') {
        setPKind('filament');
      }
    } catch {
      if (!pName.trim()) {
        setPName(fallbackName);
      }
    }
  };

  const handleUploadStandaloneProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pFile || !pName.trim()) return;
    setUploadingStandaloneProfile(true);
    try {
      await api.adminUploadProfile(pFile, pName.trim(), pKind, pNotes.trim());
      setPName('');
      setPNotes('');
      setPFile(null);
      if (standaloneProfileInputRef.current) {
        standaloneProfileInputRef.current.value = '';
      }
      await onReload();
    } catch (err) {
      onError(translateApiError(err, t));
    } finally {
      setUploadingStandaloneProfile(false);
    }
  };

  const handleDeleteProfile = async (id: number) => {
    try {
      await api.adminDeleteProfile(id);
      await onReload();
    } catch (err) {
      onError(translateApiError(err, t));
    }
  };

  return (
    <div className="space-y-4">
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        onChange={handleProfileFileChange}
        className="hidden"
      />

      {/* Sub-tabs bar */}
      {canManagePrinters && canManageProfiles && (
        <div
          role="tablist"
          aria-label={t.admin.tabs.printers}
          className="inline-flex flex-wrap gap-1 rounded-xl border border-black/[0.08] bg-[#F6F7F9] p-1 dark:border-white/[0.09] dark:bg-[#0D0E11]"
        >
          <button
            type="button"
            role="tab"
            aria-selected={effectiveSubTab === 'machines'}
            onClick={() => setSubTab('machines')}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              effectiveSubTab === 'machines'
                ? 'bg-white text-[#111318] shadow-sm dark:bg-[#1D2027] dark:text-[#F4F5F7]'
                : 'text-[#5B616E] hover:text-[#111318] dark:text-[#9399A6] dark:hover:text-[#F4F5F7]'
            }`}
          >
            {t.admin.printers.subTabs.machines} ({printers.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={effectiveSubTab === 'profiles'}
            onClick={() => setSubTab('profiles')}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              effectiveSubTab === 'profiles'
                ? 'bg-white text-[#111318] shadow-sm dark:bg-[#1D2027] dark:text-[#F4F5F7]'
                : 'text-[#5B616E] hover:text-[#111318] dark:text-[#9399A6] dark:hover:text-[#F4F5F7]'
            }`}
          >
            {t.admin.printers.subTabs.profiles} ({profiles.length})
          </button>
        </div>
      )}

      {effectiveSubTab === 'machines' && canManagePrinters && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-[#111318] dark:text-[#F4F5F7]">
              {t.admin.printers.subTabs.machines}
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              {canCreateDeletePrinters && (
                <button
                  type="button"
                  onClick={() => {
                    setCatalogTargetPrinter(null);
                    setAddModalOpen(true);
                  }}
                  className="btn-primary py-1.5 text-xs"
                >
                  <Plus className="h-4 w-4" />
                  {t.admin.printers.addPrinterBtn}
                </button>
              )}
              {canManageSlots &&
                (filamentApiEnabled || printers.some((p) => p.filament_api_printer_id)) && (
                  <button
                    type="button"
                    onClick={handleSyncFilaments}
                    disabled={syncingFilaments}
                    className="btn-secondary"
                  >
                    <RefreshCw className={`h-4 w-4 ${syncingFilaments ? 'animate-spin' : ''}`} />
                    {syncingFilaments
                      ? t.admin.printers.syncingFilaments
                      : t.admin.printers.syncFilamentsBtn}
                  </button>
                )}
              {canCreateDeletePrinters && (
                <button
                  type="button"
                  onClick={handleSync}
                  disabled={syncing}
                  className="btn-secondary"
                >
                  <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
                  {syncing ? t.admin.printers.syncing : t.admin.printers.syncBtn}
                </button>
              )}
            </div>
          </div>

          {filamentSyncNote && (
            <div className="rounded-xl bg-[#00A7D9]/10 px-3.5 py-2 text-xs font-medium text-[#007BA3] dark:text-[#38C6F4]">
              {filamentSyncNote}
            </div>
          )}

          <datalist id="filament-api-printers-list">
            {filamentApiPrinters.map((fp) => (
              <option key={fp.id} value={fp.id}>
                {fp.id} ({fp.type})
              </option>
            ))}
          </datalist>

          <datalist id="fdm-monster-printers-list">
            {remoteFdmPrinters.map((rp) => (
              <option key={rp.fdm_monster_id} value={rp.fdm_monster_id}>
                {rp.name} ({rp.printer_type})
              </option>
            ))}
          </datalist>

          {printers.length === 0 ? (
            <div className="studio-surface flex flex-col items-center justify-center gap-3 p-12 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#00A7D9]/12 text-[#007BA3] dark:text-[#38C6F4]">
                <PrinterIcon className="h-6 w-6" />
              </div>
              <h3 className="text-sm font-semibold">{t.admin.printers.emptyTitle}</h3>
              <p className="max-w-md text-xs text-[#5B616E] dark:text-[#9399A6]">
                {t.admin.printers.emptyDesc}
              </p>
              <div className="mt-1 flex flex-wrap justify-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setCatalogTargetPrinter(null);
                    setAddModalOpen(true);
                  }}
                  className="btn-primary py-1.5 text-xs"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  {t.admin.printers.addPrinterBtn}
                </button>
                <button
                  type="button"
                  onClick={handleSync}
                  disabled={syncing}
                  className="btn-secondary py-1.5 text-xs"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} />
                  {t.admin.printers.syncBtn}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {printers.map((printer) => {
                const d = getDraft(printer);
                const isSaving = savingId === printer.id;
                const isLinked =
                  printer.is_fdm_linked !== undefined
                    ? printer.is_fdm_linked
                    : Boolean(printer.fdm_monster_id) &&
                      !printer.fdm_monster_id.startsWith('manual-');
                const fdmDraftVal =
                  drafts[printer.id]?.fdm_monster_id !== undefined
                    ? drafts[printer.id].fdm_monster_id ?? ''
                    : isLinked
                      ? printer.fdm_monster_id
                      : '';

                return (
                  <div key={printer.id} className="studio-surface p-5 space-y-5">
                    {/* Header */}
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-black/[0.07] pb-4 dark:border-white/[0.08]">
                      <div className="flex flex-wrap items-center gap-2.5">
                        <input
                          type="text"
                          disabled={!canEditPrinters}
                          value={d.display_name ?? d.name}
                          onChange={(e) => updateDraft(printer.id, { display_name: e.target.value })}
                          className="studio-input w-64 py-1.5 font-medium disabled:opacity-65"
                        />
                        <select
                          aria-label={t.admin.printers.printerTypeLabel}
                          disabled={!canEditPrinters}
                          value={d.printer_type}
                          onChange={(e) =>
                            updateDraft(printer.id, {
                              printer_type: e.target.value as 'prusalink' | 'klipper',
                            })
                          }
                          className="studio-input w-auto py-1 text-xs disabled:opacity-65"
                        >
                          <option value="prusalink">PrusaLink</option>
                          <option value="klipper">Klipper</option>
                        </select>
                        <PrinterStatusBadge status={printer.status} />
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                            isLinked
                              ? 'bg-[#00A7D9]/12 text-[#007BA3] dark:text-[#38C6F4]'
                              : 'bg-black/[0.06] text-[#5B616E] dark:bg-white/[0.08] dark:text-[#9399A6]'
                          }`}
                        >
                          <Link2 className="h-3 w-3" />
                          {isLinked
                            ? t.admin.printers.fdmLinkedBadge
                            : t.admin.printers.standaloneBadge}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-2.5">
                        {canEditPrinters && (
                          <button
                            type="button"
                            onClick={() => {
                              setCatalogTargetPrinter(printer);
                              setAddModalOpen(true);
                            }}
                            className="btn-secondary py-1.5 text-xs"
                          >
                            <Sparkles className="h-3.5 w-3.5 text-[#00A7D9]" />
                            {t.admin.printers.assignCatalogBtn}
                          </button>
                        )}
                        <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-[#111318] dark:text-[#F4F5F7]">
                          <input
                            type="checkbox"
                            disabled={!canEditPrinters}
                            checked={d.is_enabled}
                            onChange={(e) =>
                              updateDraft(printer.id, { is_enabled: e.target.checked })
                            }
                            className="h-4 w-4 rounded disabled:opacity-50"
                          />
                          <span>
                            {d.is_enabled ? t.admin.printers.enabled : t.admin.printers.disabled}
                          </span>
                        </label>
                        {canEditPrinters && (
                          <button
                            type="button"
                            disabled={isSaving}
                            onClick={() => handleSavePrinter(printer)}
                            className="btn-primary py-1.5 text-xs"
                          >
                            {isSaving ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Save className="h-3.5 w-3.5" />
                            )}
                            {t.admin.printers.savePrinter}
                          </button>
                        )}
                        {canCreateDeletePrinters && (confirmDeleteId === printer.id ? (
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={deletingId === printer.id}
                              onClick={() => handleDeletePrinter(printer.id)}
                              className="btn-danger py-1.5 text-xs"
                            >
                              {deletingId === printer.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Trash2 className="h-3.5 w-3.5" />
                              )}
                              {t.admin.printers.confirmDeletePrinter}
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(null)}
                              className="btn-secondary py-1.5 text-xs"
                            >
                              {t.common.cancel}
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(printer.id)}
                            title={t.admin.printers.deletePrinter}
                            className="btn-ghost px-2 py-1.5 text-xs text-rose-600 hover:bg-rose-500/10 dark:text-rose-400"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            <span className="hidden sm:inline">
                              {t.admin.printers.deletePrinter}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Dimensions, MMU Count, Orca Profile Bindings, FDM & FilamentAPI Mapping */}
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
                      <div>
                        <label className="mb-1 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
                          {t.admin.printers.bedSize}
                        </label>
                        <div className="grid grid-cols-3 gap-1.5">
                          <input
                            type="number"
                            disabled={!canEditPrinters}
                            value={d.bed_x_mm}
                            onChange={(e) =>
                              updateDraft(printer.id, { bed_x_mm: Number(e.target.value) })
                            }
                            className="studio-input px-1.5 py-1.5 font-mono text-xs tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none disabled:opacity-65"
                          />
                          <input
                            type="number"
                            disabled={!canEditPrinters}
                            value={d.bed_y_mm}
                            onChange={(e) =>
                              updateDraft(printer.id, { bed_y_mm: Number(e.target.value) })
                            }
                            className="studio-input px-1.5 py-1.5 font-mono text-xs tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none disabled:opacity-65"
                          />
                          <input
                            type="number"
                            disabled={!canEditPrinters}
                            value={d.bed_z_mm}
                            onChange={(e) =>
                              updateDraft(printer.id, { bed_z_mm: Number(e.target.value) })
                            }
                            className="studio-input px-1.5 py-1.5 font-mono text-xs tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none disabled:opacity-65"
                          />
                        </div>
                      </div>

                      <div>
                        <label className="mb-1 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
                          {t.admin.printers.mmuSlots}
                        </label>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            role="switch"
                            disabled={!canEditPrinters}
                            aria-checked={d.mmu_slots_count > 1}
                            onClick={() =>
                              updateDraft(printer.id, {
                                mmu_slots_count:
                                  d.mmu_slots_count > 1
                                    ? 1
                                    : Math.max(
                                        2,
                                        printer.mmu_slots_count > 1 ? printer.mmu_slots_count : 4
                                      ),
                              })
                            }
                            className={`inline-flex items-center gap-2 rounded-xl border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-65 ${
                              d.mmu_slots_count > 1
                                ? 'border-[#00A7D9]/40 bg-[#00A7D9]/12 text-[#007BA3] dark:text-[#38C6F4]'
                                : 'border-black/[0.08] bg-[#F6F7F9] text-[#5B616E] dark:border-white/[0.1] dark:bg-[#0D0E11] dark:text-[#9399A6]'
                            }`}
                          >
                            <span
                              className={`h-2 w-2 rounded-full ${
                                d.mmu_slots_count > 1 ? 'bg-[#00A7D9]' : 'bg-[#9CA3AF]'
                              }`}
                            />
                            <span>
                              {d.mmu_slots_count > 1
                                ? t.admin.printers.mmuOn
                                : t.admin.printers.mmuOff}
                            </span>
                          </button>
                          {d.mmu_slots_count > 1 && (
                            <input
                              type="number"
                              disabled={!canEditPrinters}
                              min={2}
                              max={16}
                              aria-label={t.admin.printers.mmuSlotsCountLabel}
                              value={d.mmu_slots_count}
                              onChange={(e) =>
                                updateDraft(printer.id, {
                                  mmu_slots_count: Math.max(
                                    2,
                                    Math.min(16, Number(e.target.value) || 2)
                                  ),
                                })
                              }
                              className="studio-input w-16 py-1.5 font-mono text-xs tabular-nums disabled:opacity-65"
                            />
                          )}
                        </div>
                      </div>

                      <div>
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <label className="text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
                            {t.admin.printers.machineProfile}
                          </label>
                          {canEditPrinters && (
                            <button
                              type="button"
                              disabled={uploadingKey === `${printer.id}-machine`}
                              onClick={() => triggerProfileUpload(printer.id, 'machine')}
                              className="inline-flex items-center gap-1 text-[11px] font-medium text-[#007BA3] hover:underline disabled:opacity-50 dark:text-[#38C6F4]"
                            >
                              {uploadingKey === `${printer.id}-machine` ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <Upload className="h-3 w-3" />
                              )}
                              {uploadingKey === `${printer.id}-machine`
                                ? t.admin.printers.uploadingProfile
                                : t.admin.printers.uploadProfileBtn}
                            </button>
                          )}
                        </div>
                        <select
                          disabled={!canEditPrinters}
                          value={d.machine_profile_id ?? ''}
                          onChange={(e) =>
                            updateDraft(printer.id, {
                              machine_profile_id: e.target.value ? Number(e.target.value) : null,
                            })
                          }
                          className="studio-input py-1.5 text-xs disabled:opacity-65"
                        >
                          <option value="">{t.common.none}</option>
                          {machineProfiles.map((mp) => (
                            <option key={mp.id} value={mp.id}>
                              {mp.name}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <label className="text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
                            {t.admin.printers.processProfile}
                          </label>
                          {canEditPrinters && (
                            <button
                              type="button"
                              disabled={uploadingKey === `${printer.id}-process`}
                              onClick={() => triggerProfileUpload(printer.id, 'process')}
                              className="inline-flex items-center gap-1 text-[11px] font-medium text-[#007BA3] hover:underline disabled:opacity-50 dark:text-[#38C6F4]"
                            >
                              {uploadingKey === `${printer.id}-process` ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <Upload className="h-3 w-3" />
                              )}
                              {uploadingKey === `${printer.id}-process`
                                ? t.admin.printers.uploadingProfile
                                : t.admin.printers.uploadProfileBtn}
                            </button>
                          )}
                        </div>
                        <select
                          disabled={!canEditPrinters}
                          value={d.process_profile_id ?? ''}
                          onChange={(e) =>
                            updateDraft(printer.id, {
                              process_profile_id: e.target.value ? Number(e.target.value) : null,
                            })
                          }
                          className="studio-input py-1.5 text-xs disabled:opacity-65"
                        >
                          <option value="">{t.common.none}</option>
                          {processProfiles.map((pp) => (
                            <option key={pp.id} value={pp.id}>
                              {pp.name}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="mb-1 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
                          {t.admin.printers.fdmLinkLabel}
                        </label>
                        <input
                          type="text"
                          disabled={!canEditPrinters}
                          list="fdm-monster-printers-list"
                          value={fdmDraftVal}
                          placeholder={t.admin.printers.fdmLinkNone}
                          onChange={(e) =>
                            updateDraft(printer.id, {
                              fdm_monster_id: e.target.value,
                            })
                          }
                          className="studio-input py-1.5 font-mono text-xs disabled:opacity-65"
                        />
                      </div>

                      <div>
                        <label className="mb-1 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
                          {t.admin.printers.filamentApiId}
                        </label>
                        <input
                          type="text"
                          disabled={!canEditPrinters}
                          list="filament-api-printers-list"
                          value={d.filament_api_printer_id ?? ''}
                          placeholder={t.admin.printers.filamentApiIdPlaceholder}
                          onChange={(e) =>
                            updateDraft(printer.id, {
                              filament_api_printer_id: e.target.value,
                            })
                          }
                          className="studio-input py-1.5 font-mono text-xs disabled:opacity-65"
                        />
                      </div>
                    </div>

                    {/* Loaded Filaments per Slot */}
                    <div className="space-y-2.5 border-t border-black/[0.07] pt-4 dark:border-white/[0.08]">
                      <div className="text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
                        {t.admin.printers.slotsTitle}
                      </div>
                      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                        {printer.slots.map((slot) => {
                          const testKey = `${printer.id}-${slot.id}`;
                          const testRes = testResults[testKey];
                          const isTesting = testingKey === testKey;

                          return (
                            <div key={slot.id} className="studio-subtle flex flex-col gap-2 p-2.5">
                              <div className="flex flex-wrap items-center gap-2">
                                <span
                                  className="h-3.5 w-3.5 shrink-0 rounded-full border border-black/15 dark:border-white/20"
                                  style={{ backgroundColor: slot.color_hex || '#64748B' }}
                                />
                                <span className="font-mono text-xs font-semibold tabular-nums text-[#5B616E] dark:text-[#9399A6]">
                                  #{slot.slot_index}
                                </span>
                                <select
                                  value={slot.filament_id ?? ''}
                                  disabled={!canManageSlots}
                                  onChange={(e) => {
                                    const nextFilId = e.target.value
                                      ? Number(e.target.value)
                                      : null;
                                    handleUpdateSlot(
                                      printer.id,
                                      slot.slot_index,
                                      nextFilId,
                                      slot.label || `Slot ${slot.slot_index}`,
                                      nextFilId != null
                                    );
                                  }}
                                  className="studio-input flex-1 py-1 text-xs disabled:opacity-60"
                                >
                                  <option value="">{t.workspace.emptySlot}</option>
                                  {filaments.map((f) => (
                                    <option key={f.id} value={f.id}>
                                      {f.name} ({f.material})
                                    </option>
                                  ))}
                                </select>

                                {(canEditPrinters || canManageProfiles) && (
                                  <button
                                    type="button"
                                    disabled={!slot.is_loaded || !slot.filament_id || isTesting}
                                    onClick={() => handleTestSlice(printer.id, slot.id)}
                                    className="btn-secondary px-2.5 py-1 text-[11px]"
                                  >
                                    {isTesting ? (
                                      <Loader2 className="h-3 w-3 animate-spin" />
                                    ) : (
                                      <FlaskConical className="h-3 w-3 text-[#5B616E] dark:text-[#9399A6]" />
                                    )}
                                    {isTesting
                                      ? t.admin.printers.testSlicing
                                      : t.admin.printers.testSliceBtn}
                                  </button>
                                )}
                              </div>

                              {testRes && (
                                <div
                                  className={`rounded-lg px-2.5 py-1.5 text-[11px] ${
                                    testRes.ok
                                      ? 'bg-emerald-500/12 text-emerald-800 dark:text-emerald-300'
                                      : 'bg-rose-500/12 text-rose-800 dark:text-rose-300'
                                  }`}
                                >
                                  <div className="flex items-center gap-1.5 font-medium">
                                    {testRes.ok ? (
                                      <CheckCircle2 className="h-3.5 w-3.5" />
                                    ) : (
                                      <XCircle className="h-3.5 w-3.5" />
                                    )}
                                    <span className="tabular-nums">
                                      {testRes.ok
                                        ? `${t.admin.printers.testSliceOk}: ${testRes.estimated_grams.toFixed(1)} g · ${formatMinutes(testRes.estimated_minutes, lang)}`
                                        : `${t.admin.printers.testSliceFail}: ${testRes.error || ''}`}
                                    </span>
                                  </div>
                                  {testRes.command_preview && (
                                    <div className="mt-1 truncate font-mono text-[10px] opacity-75">
                                      {testRes.command_preview}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {effectiveSubTab === 'profiles' && canManageProfiles && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          <div className="studio-surface p-5 space-y-4 lg:col-span-5">
            <div>
              <h2 className="text-base font-semibold text-[#111318] dark:text-[#F4F5F7]">
                {t.admin.filaments.profilesTitle}
              </h2>
              <p className="mt-1 text-xs text-[#5B616E] dark:text-[#9399A6]">
                {t.admin.printers.profilesSubtabDesc}
              </p>
            </div>
            <form onSubmit={handleUploadStandaloneProfile} className="studio-subtle space-y-3 p-3.5">
              <div>
                <label className="mb-1 block text-[11px] font-medium text-[#5B616E] dark:text-[#9399A6]">
                  {t.admin.filaments.profileName}
                </label>
                <input
                  type="text"
                  value={pName}
                  onChange={(e) => setPName(e.target.value)}
                  placeholder="Voron 2.4 0.20mm Standard"
                  className="studio-input py-1.5 text-xs"
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-[#5B616E] dark:text-[#9399A6]">
                    {t.admin.filaments.profileKind}
                  </label>
                  <select
                    value={pKind}
                    onChange={(e) => setPKind(e.target.value as ProfileKind)}
                    className="studio-input py-1.5 text-xs"
                  >
                    <option value="machine">{t.admin.filaments.kindMachine}</option>
                    <option value="process">{t.admin.filaments.kindProcess}</option>
                    <option value="filament">{t.admin.filaments.kindFilament}</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-[#5B616E] dark:text-[#9399A6]">
                    {t.admin.filaments.profileNotes}
                  </label>
                  <input
                    type="text"
                    value={pNotes}
                    onChange={(e) => setPNotes(e.target.value)}
                    className="studio-input py-1.5 text-xs"
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-[#5B616E] dark:text-[#9399A6]">
                  {t.admin.filaments.selectJsonFile}
                </label>
                <input
                  ref={standaloneProfileInputRef}
                  type="file"
                  accept=".json"
                  onChange={(e) => void handleStandaloneProfileFileSelect(e.target.files?.[0] ?? null)}
                  className="block w-full text-xs text-[#5B616E] file:mr-3 file:rounded-lg file:border-0 file:bg-[#00A7D9]/15 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-[#007BA3] dark:text-[#9399A6] dark:file:text-[#38C6F4]"
                  required
                />
              </div>
              <button
                type="submit"
                disabled={uploadingStandaloneProfile || !pFile}
                className="btn-primary w-full py-1.5 text-xs"
              >
                <Upload className="h-3.5 w-3.5" />
                {t.admin.filaments.uploadProfile}
              </button>
            </form>
          </div>

          <div className="studio-surface p-5 space-y-3 lg:col-span-7">
            <h3 className="text-sm font-semibold text-[#111318] dark:text-[#F4F5F7]">
              {t.admin.printers.subTabs.profiles} ({profiles.length})
            </h3>
            <div className="divide-y divide-black/[0.06] dark:divide-white/[0.07]">
              {profiles.map((prof) => (
                <div key={prof.id} className="flex items-center justify-between gap-2 py-2.5">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <FileCode2 className="h-4 w-4 shrink-0 text-[#5B616E] dark:text-[#9399A6]" />
                    <div className="min-w-0">
                      <div className="truncate text-xs font-medium text-[#111318] dark:text-[#F4F5F7]">
                        {prof.name}
                      </div>
                      <div className="text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                        {prof.kind}
                        {prof.notes ? ` · ${prof.notes}` : ''}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDeleteProfile(prof.id)}
                    className="btn-ghost p-1.5 hover:text-rose-600 dark:hover:text-rose-400"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <AddPrinterModal
        open={addModalOpen}
        targetPrinter={catalogTargetPrinter}
        profiles={profiles}
        filaments={filaments}
        remoteFdmPrinters={remoteFdmPrinters}
        onClose={() => {
          setAddModalOpen(false);
          setCatalogTargetPrinter(null);
        }}
        onCompleted={onReload}
        onError={onError}
      />
    </div>
  );
}
