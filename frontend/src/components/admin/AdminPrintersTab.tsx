import { useRef, useState } from 'react';
import {
  CheckCircle2,
  FlaskConical,
  Loader2,
  RefreshCw,
  Save,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';
import { api } from '../../api/client';
import { formatMinutes, useI18n } from '../../i18n';
import type {
  AdminPrinter,
  Filament,
  OrcaProfile,
  TestSliceResult,
} from '../../types/api';
import { translateApiError } from '../../utils/errors';
import { PrinterStatusBadge } from '../StatusBadge';

interface AdminPrintersTabProps {
  printers: AdminPrinter[];
  filaments: Filament[];
  profiles: OrcaProfile[];
  onReload: () => Promise<void>;
  onError: (msg: string) => void;
}

export function AdminPrintersTab({
  printers,
  filaments,
  profiles,
  onReload,
  onError,
}: AdminPrintersTabProps) {
  const { lang, t } = useI18n();
  const [syncing, setSyncing] = useState(false);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [uploadingKey, setUploadingKey] = useState<string | null>(null);
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestSliceResult>>({});
  const [drafts, setDrafts] = useState<Record<number, Partial<AdminPrinter>>>({});

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingUploadRef = useRef<{ printerId: number; kind: 'machine' | 'process' } | null>(null);

  const machineProfiles = profiles.filter((p) => p.kind === 'machine');
  const processProfiles = profiles.filter((p) => p.kind === 'process');

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

  const handleSavePrinter = async (printer: AdminPrinter) => {
    const d = getDraft(printer);
    setSavingId(printer.id);
    try {
      await api.adminUpdatePrinter(printer.id, {
        is_enabled: d.is_enabled,
        display_name: d.display_name ?? d.name,
        bed_x_mm: Number(d.bed_x_mm),
        bed_y_mm: Number(d.bed_y_mm),
        bed_z_mm: Number(d.bed_z_mm),
        mmu_slots_count: Number(d.mmu_slots_count),
        machine_profile_id: d.machine_profile_id ?? null,
        process_profile_id: d.process_profile_id ?? null,
      });
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

  return (
    <div className="space-y-4">
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        onChange={handleProfileFileChange}
        className="hidden"
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-[#111318] dark:text-[#F4F5F7]">
          {t.admin.tabs.printers}
        </h2>
        <button
          type="button"
          onClick={handleSync}
          disabled={syncing}
          className="btn-secondary"
        >
          <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
          {syncing ? t.admin.printers.syncing : t.admin.printers.syncBtn}
        </button>
      </div>

      <div className="space-y-4">
        {printers.map((printer) => {
          const d = getDraft(printer);
          const isSaving = savingId === printer.id;

          return (
            <div key={printer.id} className="studio-surface p-5 space-y-5">
              {/* Header */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-black/[0.07] pb-4 dark:border-white/[0.08]">
                <div className="flex flex-wrap items-center gap-3">
                  <input
                    type="text"
                    value={d.display_name ?? d.name}
                    onChange={(e) => updateDraft(printer.id, { display_name: e.target.value })}
                    className="studio-input w-64 py-1.5 font-medium"
                  />
                  <span className="text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
                    {printer.printer_type === 'klipper' ? 'Klipper' : 'PrusaLink'}
                  </span>
                  <PrinterStatusBadge status={printer.status} />
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-[#111318] dark:text-[#F4F5F7]">
                    <input
                      type="checkbox"
                      checked={d.is_enabled}
                      onChange={(e) => updateDraft(printer.id, { is_enabled: e.target.checked })}
                      className="h-4 w-4 rounded"
                    />
                    <span>{d.is_enabled ? t.admin.printers.enabled : t.admin.printers.disabled}</span>
                  </label>
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
                  {confirmDeleteId === printer.id ? (
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
                      <span className="hidden sm:inline">{t.admin.printers.deletePrinter}</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Dimensions, MMU Count, Orca Profile Bindings */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <label className="mb-1 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
                    {t.admin.printers.bedSize}
                  </label>
                  <div className="grid grid-cols-3 gap-1.5">
                    <input
                      type="number"
                      value={d.bed_x_mm}
                      onChange={(e) =>
                        updateDraft(printer.id, { bed_x_mm: Number(e.target.value) })
                      }
                      className="studio-input py-1.5 font-mono text-xs tabular-nums"
                    />
                    <input
                      type="number"
                      value={d.bed_y_mm}
                      onChange={(e) =>
                        updateDraft(printer.id, { bed_y_mm: Number(e.target.value) })
                      }
                      className="studio-input py-1.5 font-mono text-xs tabular-nums"
                    />
                    <input
                      type="number"
                      value={d.bed_z_mm}
                      onChange={(e) =>
                        updateDraft(printer.id, { bed_z_mm: Number(e.target.value) })
                      }
                      className="studio-input py-1.5 font-mono text-xs tabular-nums"
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
                      aria-checked={d.mmu_slots_count > 1}
                      onClick={() =>
                        updateDraft(printer.id, {
                          mmu_slots_count:
                            d.mmu_slots_count > 1
                              ? 1
                              : Math.max(2, printer.mmu_slots_count > 1 ? printer.mmu_slots_count : 4),
                        })
                      }
                      className={`inline-flex items-center gap-2 rounded-xl border px-2.5 py-1.5 text-xs font-medium transition-colors ${
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
                        {d.mmu_slots_count > 1 ? t.admin.printers.mmuOn : t.admin.printers.mmuOff}
                      </span>
                    </button>
                    {d.mmu_slots_count > 1 && (
                      <input
                        type="number"
                        min={2}
                        max={16}
                        aria-label={t.admin.printers.mmuSlotsCountLabel}
                        value={d.mmu_slots_count}
                        onChange={(e) =>
                          updateDraft(printer.id, {
                            mmu_slots_count: Math.max(2, Math.min(16, Number(e.target.value) || 2)),
                          })
                        }
                        className="studio-input w-16 py-1.5 font-mono text-xs tabular-nums"
                      />
                    )}
                  </div>
                </div>

                <div>
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <label className="text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
                      {t.admin.printers.machineProfile}
                    </label>
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
                  </div>
                  <select
                    value={d.machine_profile_id ?? ''}
                    onChange={(e) =>
                      updateDraft(printer.id, {
                        machine_profile_id: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                    className="studio-input py-1.5 text-xs"
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
                  </div>
                  <select
                    value={d.process_profile_id ?? ''}
                    onChange={(e) =>
                      updateDraft(printer.id, {
                        process_profile_id: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                    className="studio-input py-1.5 text-xs"
                  >
                    <option value="">{t.common.none}</option>
                    {processProfiles.map((pp) => (
                      <option key={pp.id} value={pp.id}>
                        {pp.name}
                      </option>
                    ))}
                  </select>
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
                      <div
                        key={slot.id}
                        className="studio-subtle flex flex-col gap-2 p-2.5"
                      >
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
                            onChange={(e) => {
                              const nextFilId = e.target.value ? Number(e.target.value) : null;
                              handleUpdateSlot(
                                printer.id,
                                slot.slot_index,
                                nextFilId,
                                slot.label || `Slot ${slot.slot_index}`,
                                nextFilId != null
                              );
                            }}
                            className="studio-input flex-1 py-1 text-xs"
                          >
                            <option value="">{t.workspace.emptySlot}</option>
                            {filaments.map((f) => (
                              <option key={f.id} value={f.id}>
                                {f.name} ({f.material})
                              </option>
                            ))}
                          </select>

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
                            {isTesting ? t.admin.printers.testSlicing : t.admin.printers.testSliceBtn}
                          </button>
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
    </div>
  );
}
