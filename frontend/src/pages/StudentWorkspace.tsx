import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  FileUp,
  Loader2,
  Upload,
} from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { formatMinutes, useI18n } from '../i18n';
import type { JobDetail, Printer, SampleModel } from '../types/api';
import { translateApiError } from '../utils/errors';
import { ApprovalModal } from '../components/ApprovalModal';
import {
  BuildPlate3D,
  type BoundingDimensions,
  type MeshTransformState,
  type PreviewStatusState,
  type WorkspaceMode,
} from '../components/BuildPlate3D';
import { PrinterSelector } from '../components/PrinterSelector';

interface StudentWorkspaceProps {
  onNavigateMyPrints: () => void;
}

const IDENTITY_TRANSFORM: MeshTransformState = {
  posX: 0,
  posY: 0,
  quatX: 0,
  quatY: 0,
  quatZ: 0,
  quatW: 1,
  scale: 1,
};

export function StudentWorkspace({ onNavigateMyPrints }: StudentWorkspaceProps) {
  const { user, refreshUser } = useAuth();
  const { lang, t } = useI18n();

  const [printers, setPrinters] = useState<Printer[]>([]);
  const [samples, setSamples] = useState<SampleModel[]>([]);
  const [selectedPrinterId, setSelectedPrinterId] = useState<number | null>(null);
  const [selectedSlotId, setSelectedSlotId] = useState<number | null>(null);
  const [selectedSampleId, setSelectedSampleId] = useState<string>('');

  const [job, setJob] = useState<JobDetail | null>(null);
  const [meshVersion, setMeshVersion] = useState(0);
  const [transform, setTransform] = useState<MeshTransformState>(IDENTITY_TRANSFORM);
  const [supportsEnabled, setSupportsEnabled] = useState(true);
  const [bounds, setBounds] = useState<BoundingDimensions>({
    widthMm: 0,
    depthMm: 0,
    heightMm: 0,
    outOfBounds: false,
  });
  const [sliceStale, setSliceStale] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('prepare');
  const [sliceVersion, setSliceVersion] = useState(0);
  const [previewState, setPreviewState] = useState<PreviewStatusState>({
    loading: false,
    ready: false,
    error: null,
    layerCount: 0,
  });

  const [loadingInit, setLoadingInit] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [reorienting, setReorienting] = useState(false);
  const [slicing, setSlicing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [approvalModalOpen, setApprovalModalOpen] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadPrintersAndSamples = useCallback(async () => {
    try {
      const [printerList, sampleList] = await Promise.all([
        api.getPrinters(),
        api.getSamples().catch(() => [] as SampleModel[]),
      ]);
      setPrinters(printerList);
      setSamples(sampleList);
      if (sampleList.length > 0 && !selectedSampleId) {
        setSelectedSampleId(sampleList[0].id);
      }

      if (printerList.length > 0) {
        const firstPrinter =
          printerList.find((p) => p.id === selectedPrinterId) ?? printerList[0];
        setSelectedPrinterId(firstPrinter.id);
        const validSlot =
          firstPrinter.slots.find((s) => s.id === selectedSlotId && s.is_loaded && s.filament_id) ??
          firstPrinter.slots.find((s) => s.is_loaded && s.filament_id) ??
          firstPrinter.slots[0];
        setSelectedSlotId(validSlot ? validSlot.id : null);
      }
    } catch (err) {
      setError(translateApiError(err, t));
    } finally {
      setLoadingInit(false);
    }
  }, [selectedPrinterId, selectedSampleId, selectedSlotId, t]);

  useEffect(() => {
    loadPrintersAndSamples();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activePrinter = useMemo(
    () => printers.find((p) => p.id === selectedPrinterId) ?? printers[0] ?? null,
    [printers, selectedPrinterId]
  );

  const activeSlot = useMemo(
    () => activePrinter?.slots.find((s) => s.id === selectedSlotId) ?? null,
    [activePrinter, selectedSlotId]
  );

  const handleSelectPrinter = (printer: Printer) => {
    setSelectedPrinterId(printer.id);
    const loadedSlot =
      printer.slots.find((s) => s.is_loaded && s.filament_id != null) ?? printer.slots[0];
    setSelectedSlotId(loadedSlot ? loadedSlot.id : null);
    if (job) setSliceStale(true);
    setSuccessMsg(null);
  };

  const handleSelectSlot = (slotId: number) => {
    setSelectedSlotId(slotId);
    if (job) setSliceStale(true);
    setSuccessMsg(null);
  };

  const handleUploadFile = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.stl')) {
      setError(t.errors.uploadStlOnly);
      return;
    }
    if (!activePrinter || !selectedSlotId) {
      setError(t.workspace.noLoadedSlot);
      return;
    }

    setError(null);
    setSuccessMsg(null);
    setUploading(true);
    try {
      const created = await api.uploadJob(file, activePrinter.id, selectedSlotId);
      setJob(created);
      setSupportsEnabled(true);
      setTransform({
        posX: created.pos_x_mm ?? 0,
        posY: created.pos_y_mm ?? 0,
        quatX: created.quat_x ?? 0,
        quatY: created.quat_y ?? 0,
        quatZ: created.quat_z ?? 0,
        quatW: created.quat_w ?? 1,
        scale: created.scale ?? 1,
      });
      setMeshVersion((v) => v + 1);
      setSliceStale(true);
      setWorkspaceMode('prepare');
      setSliceVersion(0);
      setPreviewState({ loading: false, ready: false, error: null, layerCount: 0 });
    } catch (err) {
      setError(translateApiError(err, t));
    } finally {
      setUploading(false);
    }
  };

  const handleLoadSample = async () => {
    if (!selectedSampleId) return;
    setError(null);
    setSuccessMsg(null);
    setUploading(true);
    try {
      const file = await api.downloadSampleStl(selectedSampleId);
      await handleUploadFile(file);
    } catch (err) {
      setError(translateApiError(err, t));
      setUploading(false);
    }
  };

  const handleReorient = async () => {
    if (!job) return;
    setError(null);
    setReorienting(true);
    try {
      const updated = await api.reorientJob(job.id);
      setJob(updated);
      setTransform(IDENTITY_TRANSFORM);
      setMeshVersion((v) => v + 1);
      setSliceStale(true);
      setWorkspaceMode('prepare');
      setSliceVersion(0);
      setPreviewState({ loading: false, ready: false, error: null, layerCount: 0 });
    } catch (err) {
      setError(translateApiError(err, t));
    } finally {
      setReorienting(false);
    }
  };

  const handleTransformChange = useCallback((next: MeshTransformState) => {
    setTransform(next);
    setSliceStale(true);
    setSuccessMsg(null);
  }, []);

  const handleSlice = async () => {
    if (!job || !activePrinter || !selectedSlotId) return;
    setError(null);
    setSuccessMsg(null);
    setSlicing(true);
    try {
      const sliced = await api.sliceJob(job.id, {
        printer_id: activePrinter.id,
        slot_id: selectedSlotId,
        pos_x_mm: transform.posX,
        pos_y_mm: transform.posY,
        quat_x: transform.quatX,
        quat_y: transform.quatY,
        quat_z: transform.quatZ,
        quat_w: transform.quatW,
        scale: transform.scale,
        supports_enabled: supportsEnabled,
      });
      setJob(sliced);
      setSliceStale(false);
      setSliceVersion((v) => v + 1);
      setWorkspaceMode('preview');
    } catch (err) {
      setError(translateApiError(err, t));
    } finally {
      setSlicing(false);
    }
  };

  const handleSubmit = async () => {
    if (!job) return;
    setError(null);
    setSubmitting(true);
    try {
      const submitted = await api.submitJob(job.id);
      setJob(submitted);
      setSuccessMsg(t.workspace.submitSuccess);
      await refreshUser();
      await loadPrintersAndSamples();
    } catch (err) {
      setError(translateApiError(err, t));
    } finally {
      setSubmitting(false);
    }
  };

  const handleRequestApproval = async (note: string, teacherId: number | null) => {
    if (!job) return;
    setError(null);
    setSubmitting(true);
    try {
      const updated = await api.requestApproval(job.id, note, teacherId);
      setJob(updated);
      setApprovalModalOpen(false);
      setSuccessMsg(t.workspace.approvalSuccess);
      await refreshUser();
    } catch (err) {
      setError(translateApiError(err, t));
    } finally {
      setSubmitting(false);
    }
  };

  const isAlreadySubmitted =
    job != null &&
    ['PENDING_APPROVAL', 'QUEUED', 'PRINTING', 'COMPLETED'].includes(job.status);

  const isSlicedAndFresh =
    job != null && job.status === 'SLICED' && !sliceStale && !bounds.outOfBounds;
  const isPrinterBusy = activePrinter?.status === 'printing';

  const estimatedGrams = job?.estimated_grams ?? 0;
  const availableGrams = user?.available_grams ?? 0;
  const remainingAfter = availableGrams - estimatedGrams;

  return (
    <div className="flex min-h-[calc(100vh-3.5rem)] flex-col lg:h-[calc(100vh-3.5rem)] lg:flex-row lg:overflow-hidden">
      {/* Left Matte Studio Inspector */}
      <aside className="flex w-full shrink-0 flex-col border-b border-black/[0.08] bg-white dark:border-white/[0.08] dark:bg-[#15171C] lg:w-[340px] lg:border-b-0 lg:border-r">
        <div className="flex-1 space-y-5 overflow-y-auto p-4 sm:p-5">
          {/* Printer & Filament Section */}
          <section className="space-y-3">
            <h2 className="text-xs font-semibold text-[#111318] dark:text-[#F4F5F7]">
              {t.workspace.step1Title}
            </h2>
            {loadingInit ? (
              <div className="flex items-center gap-2 py-4 text-xs text-[#5B616E] dark:text-[#9399A6]">
                <Loader2 className="h-4 w-4 animate-spin text-[#00A7D9]" />
                {t.common.loading}
              </div>
            ) : (
              <PrinterSelector
                printers={printers}
                selectedPrinterId={selectedPrinterId}
                selectedSlotId={selectedSlotId}
                onSelectPrinter={handleSelectPrinter}
                onSelectSlot={handleSelectSlot}
              />
            )}
            {isPrinterBusy && (
              <div className="flex items-start gap-2 rounded-xl bg-amber-500/12 px-3 py-2 text-xs font-medium text-amber-800 dark:text-amber-300">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{t.workspace.printerBusyNotice}</span>
              </div>
            )}
          </section>

          <div className="h-px bg-black/[0.07] dark:bg-white/[0.08]" />

          {/* STL Model Upload + Samples */}
          <section className="space-y-3">
            <h2 className="text-xs font-semibold text-[#111318] dark:text-[#F4F5F7]">
              {t.workspace.step2Title}
            </h2>

            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                const dropped = e.dataTransfer.files?.[0];
                if (dropped) handleUploadFile(dropped);
              }}
              onClick={() => fileInputRef.current?.click()}
              className={`cursor-pointer rounded-xl border border-dashed px-4 py-4 text-center transition-colors ${
                dragOver
                  ? 'border-[#00A7D9] bg-[#00A7D9]/[0.07]'
                  : 'border-black/[0.15] bg-[#F6F7F9] hover:border-[#00A7D9]/70 dark:border-white/[0.14] dark:bg-[#0D0E11]'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".stl"
                className="hidden"
                onChange={(e) => {
                  const chosen = e.target.files?.[0];
                  if (chosen) handleUploadFile(chosen);
                  e.target.value = '';
                }}
              />
              {uploading ? (
                <div className="flex items-center justify-center gap-2 py-1 text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
                  <Loader2 className="h-4 w-4 animate-spin text-[#00A7D9]" />
                  <span>{t.workspace.uploadingMesh}</span>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-1">
                  <Upload className="h-4 w-4 text-[#5B616E] dark:text-[#9399A6]" />
                  <p className="text-xs font-medium text-[#111318] dark:text-[#F4F5F7]">
                    {t.workspace.dropzoneTitle}
                  </p>
                  <p className="text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                    {t.workspace.dropzoneSubtitle}
                  </p>
                  {job?.original_filename && (
                    <span className="mt-1 inline-flex items-center gap-1.5 rounded-md bg-[#00A7D9]/12 px-2 py-0.5 font-mono text-[11px] font-medium text-[#007BA3] dark:text-[#38C6F4]">
                      <FileUp className="h-3 w-3" />
                      {job.original_filename}
                    </span>
                  )}
                </div>
              )}
            </div>

            {samples.length > 0 && (
              <div className="space-y-1.5">
                <label
                  htmlFor="sample-model-select"
                  className="block text-[11px] font-medium text-[#5B616E] dark:text-[#9399A6]"
                >
                  {t.workspace.orLoadSample}
                </label>
                <div className="flex gap-2">
                  <select
                    id="sample-model-select"
                    value={selectedSampleId}
                    onChange={(e) => setSelectedSampleId(e.target.value)}
                    className="studio-input flex-1 py-1.5 text-xs"
                  >
                    {samples.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={uploading || !selectedSampleId || !selectedSlotId}
                    onClick={handleLoadSample}
                    className="btn-secondary shrink-0 px-3 py-1.5 text-xs"
                  >
                    {t.workspace.loadSampleBtn}
                  </button>
                </div>
              </div>
            )}

            {job && (
              <p className="text-[11px] leading-relaxed text-[#5B616E] dark:text-[#9399A6]">
                {t.workspace.autoOrientHint}
              </p>
            )}
          </section>
        </div>

        {/* Pinned Bottom Slice Summary & Action Footer */}
        {(job || error || successMsg) && (
          <div className="border-t border-black/[0.08] bg-[#F6F7F9] p-4 dark:border-white/[0.08] dark:bg-[#0D0E11]">
            {error && (
              <div className="mb-3 flex items-start gap-2 rounded-xl bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="flex-1">{error}</span>
                <button
                  type="button"
                  onClick={() => setError(null)}
                  className="font-medium underline"
                >
                  {t.common.close}
                </button>
              </div>
            )}

            {successMsg && (
              <div className="mb-3 space-y-2 rounded-xl bg-emerald-500/10 px-3 py-2.5 text-xs text-emerald-800 dark:text-emerald-300">
                <div className="flex items-center gap-2 font-medium">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  <span>{successMsg}</span>
                </div>
                <button
                  type="button"
                  onClick={onNavigateMyPrints}
                  className="text-xs font-semibold text-[#007BA3] underline dark:text-[#38C6F4]"
                >
                  {t.workspace.viewInMyPrints}
                </button>
              </div>
            )}

            {job && (
              <div className="space-y-3">
                {sliceStale && !isAlreadySubmitted && job.estimated_grams != null && (
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    {t.workspace.reSliceNotice}
                  </p>
                )}

                {job.status === 'SLICED' && job.estimated_grams != null && (
                  <div className="space-y-2.5">
                    <div className="grid grid-cols-3 gap-2 border-b border-black/[0.07] pb-2.5 dark:border-white/[0.08]">
                      <div>
                        <div className="text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                          {t.workspace.estimateGrams}
                        </div>
                        <div className="font-mono text-sm font-semibold tabular-nums text-[#111318] dark:text-[#F4F5F7]">
                          {job.estimated_grams.toFixed(1)} {t.common.grams}
                        </div>
                      </div>
                      <div>
                        <div className="text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                          {t.workspace.estimateTime}
                        </div>
                        <div className="font-mono text-sm font-semibold tabular-nums text-[#111318] dark:text-[#F4F5F7]">
                          {formatMinutes(job.estimated_minutes, lang)}
                        </div>
                      </div>
                      <div>
                        <div className="text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                          {t.workspace.estimateLayers}
                        </div>
                        <div className="font-mono text-sm font-semibold tabular-nums text-[#111318] dark:text-[#F4F5F7]">
                          {job.layer_count ?? '—'}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center justify-between text-xs">
                      <span className="text-[#5B616E] dark:text-[#9399A6]">
                        {t.workspace.supportsTitle}
                      </span>
                      <span
                        className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${
                          job.supports_enabled !== false
                            ? 'bg-[#00A7D9]/12 text-[#007BA3] dark:text-[#38C6F4]'
                            : 'bg-black/[0.06] text-[#5B616E] dark:bg-white/[0.08] dark:text-[#9399A6]'
                        }`}
                      >
                        {job.supports_enabled !== false
                          ? t.workspace.supportsActiveBadge
                          : t.workspace.supportsOffBadge}
                      </span>
                    </div>

                    <div className="flex items-center justify-between text-xs tabular-nums">
                      <span className="text-[#5B616E] dark:text-[#9399A6]">
                        {t.workspace.budgetImpact}
                      </span>
                      <span className="font-mono font-medium text-[#111318] dark:text-[#F4F5F7]">
                        {remainingAfter.toFixed(1)} {t.common.grams} {t.workspace.remainingAfter}
                      </span>
                    </div>

                    {job.budget_check?.can_auto_submit ? (
                      <div className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
                        {t.workspace.withinLimits}
                      </div>
                    ) : (
                      <div className="space-y-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                        {(job.budget_check?.exceeds_grams_by ?? 0) > 0 && (
                          <div className="tabular-nums">
                            {t.workspace.overGrams} +{job.budget_check!.exceeds_grams_by.toFixed(1)}{' '}
                            {t.common.grams}
                          </div>
                        )}
                        {(job.budget_check?.exceeds_minutes_by ?? 0) > 0 && (
                          <div className="tabular-nums">
                            {t.workspace.overMinutes} +{Math.round(job.budget_check!.exceeds_minutes_by)}{' '}
                            {t.common.minutes}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Primary CTA + Organic Tree Supports Toggle */}
                {!isAlreadySubmitted && (
                  <div className="flex flex-col gap-2.5">
                    <div className="flex items-center justify-between gap-3 rounded-xl border border-black/[0.07] bg-white px-3 py-2.5 dark:border-white/[0.08] dark:bg-[#15171C]">
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-[#111318] dark:text-[#F4F5F7]">
                          {t.workspace.supportsTitle}
                        </div>
                        <div className="text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                          {t.workspace.supportsSubtitle}
                        </div>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={supportsEnabled}
                        aria-label={t.workspace.supportsTitle}
                        onClick={() => {
                          setSupportsEnabled((prev) => !prev);
                          setSliceStale(true);
                          setSuccessMsg(null);
                        }}
                        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[#00A7D9]/40 ${
                          supportsEnabled
                            ? 'bg-[#00A7D9]'
                            : 'bg-black/[0.14] dark:bg-white/[0.16]'
                        }`}
                      >
                        <span
                          className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform ${
                            supportsEnabled ? 'translate-x-[22px]' : 'translate-x-[2px]'
                          }`}
                        />
                      </button>
                    </div>

                    {workspaceMode === 'prepare' ? (
                      !isSlicedAndFresh || job.status !== 'SLICED' ? (
                        <button
                          type="button"
                          onClick={handleSlice}
                          disabled={slicing || bounds.outOfBounds || !selectedSlotId}
                          className="btn-primary w-full py-2.5"
                        >
                          {slicing && <Loader2 className="h-4 w-4 animate-spin" />}
                          {slicing ? t.workspace.slicingBtn : t.workspace.sliceBtn}
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => setWorkspaceMode('preview')}
                            className="btn-primary w-full py-2.5"
                          >
                            {t.workspace.tabs.viewPreview}
                          </button>
                          <button
                            type="button"
                            onClick={handleSlice}
                            disabled={slicing || bounds.outOfBounds || !selectedSlotId}
                            className="btn-secondary w-full py-2"
                          >
                            {slicing && <Loader2 className="h-4 w-4 animate-spin" />}
                            {slicing ? t.workspace.slicingBtn : t.workspace.tabs.reSliceBtn}
                          </button>
                        </>
                      )
                    ) : (
                      <>
                        {isPrinterBusy && (
                          <div className="flex items-start gap-2 rounded-xl bg-amber-500/12 px-3 py-2 text-xs font-medium text-amber-800 dark:text-amber-300">
                            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            <span>{t.workspace.printerBusyNotice}</span>
                          </div>
                        )}

                        {!isSlicedAndFresh || job.status !== 'SLICED' ? (
                          <button
                            type="button"
                            onClick={handleSlice}
                            disabled={slicing || bounds.outOfBounds || !selectedSlotId}
                            className="btn-primary w-full py-2.5"
                          >
                            {slicing && <Loader2 className="h-4 w-4 animate-spin" />}
                            {slicing ? t.workspace.slicingBtn : t.workspace.sliceBtn}
                          </button>
                        ) : job.budget_check?.can_auto_submit ? (
                          <button
                            type="button"
                            disabled={
                              submitting ||
                              isPrinterBusy ||
                              previewState.loading ||
                              !previewState.ready
                            }
                            onClick={handleSubmit}
                            className="btn-primary w-full py-2.5"
                          >
                            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                            {submitting ? t.workspace.submittingBtn : t.workspace.submitBtn}
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={
                              submitting ||
                              isPrinterBusy ||
                              previewState.loading ||
                              !previewState.ready
                            }
                            onClick={() => setApprovalModalOpen(true)}
                            className="inline-flex w-full items-center justify-center rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-medium text-slate-950 transition-colors hover:bg-amber-400 disabled:opacity-45"
                          >
                            {t.workspace.requestApprovalBtn}
                          </button>
                        )}

                        <button
                          type="button"
                          onClick={() => setWorkspaceMode('prepare')}
                          className="btn-secondary w-full py-2"
                        >
                          {t.workspace.tabs.backToPrepare}
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </aside>

      {/* Full-Bleed Three.js Build Plate Stage */}
      <div className="relative flex-1 min-h-[520px] lg:min-h-0">
        <BuildPlate3D
          jobId={job?.id ?? null}
          meshVersion={meshVersion}
          bedX={activePrinter?.bed_x_mm ?? 250}
          bedY={activePrinter?.bed_y_mm ?? 220}
          bedZ={activePrinter?.bed_z_mm ?? 220}
          filamentColor={activeSlot?.color_hex ?? '#00A7D9'}
          transform={transform}
          onTransformChange={handleTransformChange}
          onReorient={handleReorient}
          reorienting={reorienting}
          onBoundsChange={setBounds}
          onDropFile={handleUploadFile}
          workspaceMode={workspaceMode}
          onWorkspaceModeChange={setWorkspaceMode}
          canPreview={Boolean(job?.gcode_filename && sliceVersion > 0)}
          sliceVersion={sliceVersion}
          sliceStale={sliceStale}
          onReSlice={handleSlice}
          slicing={slicing}
          onPreviewStateChange={setPreviewState}
        />
      </div>

      <ApprovalModal
        open={approvalModalOpen}
        onClose={() => setApprovalModalOpen(false)}
        onSubmit={handleRequestApproval}
        submitting={submitting}
        exceedsGramsBy={job?.budget_check?.exceeds_grams_by ?? 0}
        exceedsMinutesBy={job?.budget_check?.exceeds_minutes_by ?? 0}
        teachers={user?.teachers ?? []}
      />
    </div>
  );
}
