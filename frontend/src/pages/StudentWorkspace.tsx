import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
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

export interface DeletedDraftSignal {
  target: number | 'all';
  seq: number;
}

interface StudentWorkspaceProps {
  onNavigateMyPrints: () => void;
  isVisible?: boolean;
  draftToLoad?: JobDetail | null;
  onDraftLoaded?: () => void;
  deletedDraftSignal?: DeletedDraftSignal | null;
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

export function StudentWorkspace({
  onNavigateMyPrints,
  isVisible = true,
  draftToLoad = null,
  onDraftLoaded,
  deletedDraftSignal = null,
}: StudentWorkspaceProps) {
  const { user, refreshUser } = useAuth();
  const { lang, t } = useI18n();

  const [printers, setPrinters] = useState<Printer[]>([]);
  const [samples, setSamples] = useState<SampleModel[]>([]);
  const [selectedPrinterId, setSelectedPrinterId] = useState<number | null>(null);
  const [selectedSlotId, setSelectedSlotId] = useState<number | null>(null);
  const [selectedSampleId, setSelectedSampleId] = useState<string>('');

  const [job, setJob] = useState<JobDetail | null>(null);
  const jobRef = useRef<JobDetail | null>(null);
  jobRef.current = job;
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
  const sliceStaleRef = useRef(sliceStale);
  sliceStaleRef.current = sliceStale;
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
  const [mobilePrinterOpen, setMobilePrinterOpen] = useState(false);

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

  const prevVisibleRef = useRef(isVisible);
  useEffect(() => {
    if (isVisible && !prevVisibleRef.current) {
      api.getPrinters().then(setPrinters).catch(() => {});
    }
    prevVisibleRef.current = isVisible;
  }, [isVisible]);

  // Load a saved draft selected from My Prints into the active 3D workspace
  useEffect(() => {
    if (!draftToLoad) return;
    setError(null);
    setSuccessMsg(null);
    setJob(draftToLoad);
    if (draftToLoad.printer_id) {
      setSelectedPrinterId(draftToLoad.printer_id);
    }
    if (draftToLoad.slot_id) {
      setSelectedSlotId(draftToLoad.slot_id);
    }
    setSupportsEnabled(draftToLoad.supports_enabled !== false);
    setTransform({
      posX: draftToLoad.pos_x_mm ?? 0,
      posY: draftToLoad.pos_y_mm ?? 0,
      quatX: draftToLoad.quat_x ?? 0,
      quatY: draftToLoad.quat_y ?? 0,
      quatZ: draftToLoad.quat_z ?? 0,
      quatW: draftToLoad.quat_w ?? 1,
      scale: draftToLoad.scale ?? 1,
    });
    setSliceStale(draftToLoad.status !== 'SLICED');
    setMobilePrinterOpen(false);
    setMeshVersion((v) => v + 1);
    onDraftLoaded?.();
  }, [draftToLoad, onDraftLoaded]);

  // Poll queued/active slicing jobs every 600ms until SLICED or SLICE_FAILED
  useEffect(() => {
    const jobId = job?.id;
    const status = job?.status;
    if (!jobId || (status !== 'SLICING_QUEUED' && status !== 'SLICING')) {
      return;
    }

    let active = true;
    const poll = async () => {
      try {
        const latest = await api.getJob(jobId);
        if (!active || jobRef.current?.id !== latest.id) return;
        setJob(latest);
        if (latest.status === 'SLICED') {
          if (!sliceStaleRef.current) {
            setSliceVersion((v) => v + 1);
            setWorkspaceMode('preview');
          }
        } else if (latest.status === 'SLICE_FAILED') {
          setError(latest.slice_error || t.workspace.sliceFailedFallback);
        }
      } catch {
        // Ignore transient polling errors; next tick will retry
      }
    };

    const timer = window.setInterval(() => {
      void poll();
    }, 600);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [job?.id, job?.status, t]);

  // Reset active workspace if the currently open draft was deleted or cleared from My Prints
  useEffect(() => {
    if (!deletedDraftSignal) return;
    const currentJob = jobRef.current;
    if (!currentJob) return;
    const isCurrentDraft =
      currentJob.status === 'DRAFT' ||
      currentJob.status === 'SLICED' ||
      currentJob.status === 'SLICE_FAILED';
    const shouldReset =
      (deletedDraftSignal.target === 'all' && isCurrentDraft) ||
      (typeof deletedDraftSignal.target === 'number' &&
        currentJob.id === deletedDraftSignal.target);
    if (!shouldReset) return;
    setJob(null);
    setTransform(IDENTITY_TRANSFORM);
    setSupportsEnabled(true);
    setSliceStale(false);
    setError(null);
    setSuccessMsg(null);
    setBounds({
      widthMm: 0,
      depthMm: 0,
      heightMm: 0,
      outOfBounds: false,
    });
  }, [deletedDraftSignal]);

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
      setMobilePrinterOpen(false);
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
      setMobilePrinterOpen(false);
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
      if (sliced.status === 'SLICED') {
        setSliceStale(false);
        setSliceVersion((v) => v + 1);
        setWorkspaceMode('preview');
      } else if (sliced.status === 'SLICING_QUEUED' || sliced.status === 'SLICING') {
        setSliceStale(false);
      } else if (sliced.status === 'SLICE_FAILED') {
        setError(sliced.slice_error || t.workspace.sliceFailedFallback);
      }
    } catch (err) {
      setError(translateApiError(err, t));
    } finally {
      setSlicing(false);
    }
  };

  const [downloadingGcode, setDownloadingGcode] = useState(false);

  const handleDownloadGcode = async () => {
    if (!job) return;
    setError(null);
    setDownloadingGcode(true);
    try {
      const text = await api.fetchJobGcodeText(job.id);
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = job.gcode_filename || `print-${job.id}.gcode`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(translateApiError(err, t));
    } finally {
      setDownloadingGcode(false);
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

  const isSlicingActive =
    slicing || job?.status === 'SLICING_QUEUED' || job?.status === 'SLICING';

  const sliceButtonLabel = (() => {
    if (job?.status === 'SLICING_QUEUED') {
      return job.slice_queue_position != null && job.slice_queue_position > 0
        ? t.workspace.slicingQueuedPos.replace('{pos}', String(job.slice_queue_position))
        : t.workspace.slicingQueued;
    }
    if (job?.status === 'SLICING' || slicing) {
      return t.workspace.slicingInProgress;
    }
    if (job?.status === 'SLICE_FAILED') {
      return t.workspace.retrySliceBtn;
    }
    return t.workspace.sliceBtn;
  })();

  const isSlicedAndFresh =
    job != null && job.status === 'SLICED' && !sliceStale && !bounds.outOfBounds;
  const isPrinterBusy = activePrinter?.status === 'printing';

  const estimatedGrams = job?.estimated_grams ?? 0;
  const availableGrams = user?.available_grams ?? 0;
  const remainingAfter = availableGrams - estimatedGrams;

  return (
    <div className="flex min-h-[calc(100dvh-3.5rem)] flex-col md:h-[calc(100dvh-3.5rem)] md:flex-row md:overflow-hidden">
      {/* Left Matte Studio Inspector (stacks below 3D stage on mobile, side-by-side on md+) */}
      <aside className="order-2 flex w-full shrink-0 flex-col border-t border-black/[0.08] bg-white dark:border-white/[0.08] dark:bg-[#15171C] md:order-1 md:w-[290px] md:border-r md:border-t-0 lg:w-[340px]">
        <div className="flex-1 space-y-4 overflow-y-auto p-3.5 sm:p-4 md:space-y-5 lg:p-5">
          {/* Printer & Filament Section (collapsible on mobile, always expanded on md+) */}
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => setMobilePrinterOpen((prev) => !prev)}
                aria-expanded={mobilePrinterOpen}
                className="flex min-h-[44px] w-full items-center justify-between gap-2 rounded-xl px-1 text-left transition-colors active:bg-black/[0.04] dark:active:bg-white/[0.05] md:hidden"
              >
                <div className="min-w-0 flex-1">
                  <h2 className="text-xs font-semibold text-[#111318] dark:text-[#F4F5F7]">
                    {t.workspace.step1Title}
                  </h2>
                  {!mobilePrinterOpen && activePrinter && (
                    <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                      <span className="truncate font-medium text-[#111318] dark:text-[#F4F5F7]">
                        {activePrinter.name}
                      </span>
                      {activeSlot && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span
                            className="inline-block h-2.5 w-2.5 shrink-0 rounded-full border border-black/15 dark:border-white/20"
                            style={{ backgroundColor: activeSlot.color_hex || '#00A7D9' }}
                          />
                          <span className="truncate">
                            {activeSlot.filament_name || activeSlot.label}
                          </span>
                        </>
                      )}
                    </div>
                  )}
                </div>
                <ChevronDown
                  className={`h-4 w-4 shrink-0 text-[#5B616E] transition-transform dark:text-[#9399A6] ${
                    mobilePrinterOpen ? 'rotate-180' : ''
                  }`}
                />
              </button>
              <h2 className="hidden text-xs font-semibold text-[#111318] dark:text-[#F4F5F7] md:block">
                {t.workspace.step1Title}
              </h2>
            </div>

            <div className={`${mobilePrinterOpen ? 'block' : 'hidden'} space-y-3 md:block`}>
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
            </div>
          </section>

          <div className="h-px bg-black/[0.07] dark:bg-white/[0.08]" />

          {/* STL Model Upload + Samples */}
          <section className="space-y-3">
            <h2 className="text-xs font-semibold text-[#111318] dark:text-[#F4F5F7]">
              {t.workspace.step2Title}
            </h2>

            <div
              role="button"
              tabIndex={0}
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
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              className={`cursor-pointer rounded-xl border border-dashed px-4 py-4 text-center transition-colors focus:outline-none focus:ring-2 focus:ring-[#00A7D9]/40 ${
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
                    <span className="mt-1 inline-flex max-w-full items-center gap-1.5 rounded-md bg-[#00A7D9]/12 px-2 py-0.5 font-mono text-[11px] font-medium text-[#007BA3] dark:text-[#38C6F4]">
                      <FileUp className="h-3 w-3 shrink-0" />
                      <span className="truncate">{job.original_filename}</span>
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
                    className="studio-input min-h-[44px] min-w-0 flex-1 py-2 text-xs md:min-h-0 md:py-1.5"
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
                    className="btn-secondary min-h-[44px] shrink-0 px-3.5 py-2 text-xs md:min-h-0 md:px-3 md:py-1.5"
                  >
                    {t.workspace.loadSampleBtn}
                  </button>
                </div>
              </div>
            )}

            {job && (
              <p className="hidden text-[11px] leading-relaxed text-[#5B616E] dark:text-[#9399A6] md:block">
                {t.workspace.autoOrientHint}
              </p>
            )}
          </section>
        </div>

        {/* Pinned Bottom Slice Summary & Action Footer */}
        {(job || error || successMsg) && (
          <div className="border-t border-black/[0.08] bg-[#F6F7F9] p-3.5 pb-[max(0.875rem,env(safe-area-inset-bottom))] dark:border-white/[0.08] dark:bg-[#0D0E11] sm:p-4">
            {error && (
              <div className="mb-3 flex items-center gap-2 rounded-xl bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 break-words">{error}</span>
                <button
                  type="button"
                  onClick={() => setError(null)}
                  className="inline-flex min-h-[44px] shrink-0 items-center px-1.5 font-medium underline md:min-h-0 md:px-0"
                >
                  {t.common.close}
                </button>
              </div>
            )}

            {successMsg && (
              <div className="mb-3 space-y-1.5 rounded-xl bg-emerald-500/10 px-3 py-2.5 text-xs text-emerald-800 dark:text-emerald-300">
                <div className="flex items-center gap-2 font-medium">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  <span>{successMsg}</span>
                </div>
                <button
                  type="button"
                  onClick={onNavigateMyPrints}
                  className="inline-flex min-h-[44px] items-center text-xs font-semibold text-[#007BA3] underline dark:text-[#38C6F4] md:min-h-0"
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
                      <div className="min-w-0">
                        <div className="text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                          {t.workspace.estimateGrams}
                        </div>
                        <div className="font-mono text-sm font-semibold tabular-nums text-[#111318] dark:text-[#F4F5F7]">
                          {job.estimated_grams.toFixed(1)} {t.common.grams}
                        </div>
                      </div>
                      <div className="min-w-0">
                        <div className="text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                          {t.workspace.estimateTime}
                        </div>
                        <div className="font-mono text-sm font-semibold tabular-nums text-[#111318] dark:text-[#F4F5F7]">
                          {formatMinutes(job.estimated_minutes, lang)}
                        </div>
                      </div>
                      <div className="min-w-0">
                        <div className="text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                          {t.workspace.estimateLayers}
                        </div>
                        <div className="font-mono text-sm font-semibold tabular-nums text-[#111318] dark:text-[#F4F5F7]">
                          {job.layer_count ?? '—'}
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
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

                    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-xs tabular-nums">
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
                      className="flex min-h-[48px] w-full cursor-pointer items-center justify-between gap-3 rounded-xl border border-black/[0.07] bg-white px-3 py-2.5 text-left transition-colors hover:border-black/[0.12] focus:outline-none focus:ring-2 focus:ring-[#00A7D9]/40 dark:border-white/[0.08] dark:bg-[#15171C] dark:hover:border-white/[0.14]"
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-[#111318] dark:text-[#F4F5F7]">
                          {t.workspace.supportsTitle}
                        </div>
                        <div className="text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                          {t.workspace.supportsSubtitle}
                        </div>
                      </div>
                      <span
                        aria-hidden="true"
                        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
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
                      </span>
                    </button>

                    {workspaceMode === 'prepare' ? (
                      !isSlicedAndFresh || job.status !== 'SLICED' ? (
                      <button
                        type="button"
                        onClick={handleSlice}
                        disabled={isSlicingActive || bounds.outOfBounds || !selectedSlotId}
                        className="btn-primary min-h-[44px] w-full py-2.5"
                      >
                        {isSlicingActive && <Loader2 className="h-4 w-4 animate-spin" />}
                        {sliceButtonLabel}
                      </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => setWorkspaceMode('preview')}
                            className="btn-primary min-h-[44px] w-full py-2.5"
                          >
                            {t.workspace.tabs.viewPreview}
                          </button>
                          <button
                            type="button"
                            onClick={handleSlice}
                            disabled={isSlicingActive || bounds.outOfBounds || !selectedSlotId}
                            className="btn-secondary min-h-[44px] w-full py-2"
                          >
                            {isSlicingActive && <Loader2 className="h-4 w-4 animate-spin" />}
                            {isSlicingActive ? sliceButtonLabel : t.workspace.tabs.reSliceBtn}
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
                            disabled={isSlicingActive || bounds.outOfBounds || !selectedSlotId}
                            className="btn-primary min-h-[44px] w-full py-2.5"
                          >
                            {isSlicingActive && <Loader2 className="h-4 w-4 animate-spin" />}
                            {sliceButtonLabel}
                          </button>
                        ) : activePrinter && activePrinter.is_fdm_linked === false ? (
                          <div className="space-y-2">
                            <div className="rounded-xl bg-[#00A7D9]/10 px-3 py-2 text-[11px] font-medium text-[#007BA3] dark:text-[#38C6F4]">
                              {t.workspace.standalonePrinterNote}
                            </div>
                            <button
                              type="button"
                              disabled={downloadingGcode || previewState.loading || !previewState.ready}
                              onClick={() => void handleDownloadGcode()}
                              className="btn-primary min-h-[44px] w-full py-2.5"
                            >
                              {downloadingGcode && <Loader2 className="h-4 w-4 animate-spin" />}
                              {downloadingGcode ? t.workspace.downloadingGcode : t.workspace.downloadGcodeBtn}
                            </button>
                          </div>
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
                            className="btn-primary min-h-[44px] w-full py-2.5"
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
                            className="inline-flex min-h-[44px] w-full items-center justify-center rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-medium text-slate-950 transition-colors hover:bg-amber-400 disabled:opacity-45"
                          >
                            {t.workspace.requestApprovalBtn}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setWorkspaceMode('prepare')}
                          className="btn-secondary min-h-[44px] w-full py-2"
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

      {/* Full-Bleed Three.js Build Plate Stage (first on mobile for immediate 3D visibility) */}
      <div className="relative order-1 h-[46dvh] min-h-[290px] max-h-[420px] w-full shrink-0 sm:h-[50dvh] sm:max-h-[460px] md:order-2 md:h-auto md:max-h-none md:min-h-0 md:flex-1">
        <BuildPlate3D
          jobId={job?.id ?? null}
          meshVersion={meshVersion}
          isVisible={isVisible}
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
          slicing={isSlicingActive}
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
