import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  FileJson,
  Link2,
  Loader2,
  Printer as PrinterIcon,
  Search,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import type {
  AdminPrinter,
  FdmMonsterRemotePrinter,
  Filament,
  OrcaCatalogVendorDetail,
  OrcaCatalogVendorSummary,
  OrcaProfile,
  PrinterType,
} from '../../types/api';
import { translateApiError } from '../../utils/errors';

interface AddPrinterModalProps {
  open: boolean;
  targetPrinter: AdminPrinter | null;
  profiles: OrcaProfile[];
  filaments: Filament[];
  remoteFdmPrinters: FdmMonsterRemotePrinter[];
  onClose: () => void;
  onCompleted: () => Promise<void>;
  onError: (msg: string) => void;
}

const MATERIAL_FILTERS = ['ALL', 'PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'PA'] as const;

function parseMachineJsonMetadata(text: string): {
  name?: string;
  bedX?: number;
  bedY?: number;
  bedZ?: number;
  mmuSlots?: number;
  printerType?: PrinterType;
} {
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, '')) as Record<string, unknown>;
    const out: ReturnType<typeof parseMachineJsonMetadata> = {};
    if (typeof parsed.name === 'string' && parsed.name.trim()) {
      out.name = parsed.name.trim();
    }
    const rawArea = parsed.printable_area;
    const areaList = Array.isArray(rawArea)
      ? rawArea.map(String)
      : typeof rawArea === 'string'
        ? rawArea.split(',')
        : [];
    const xs: number[] = [];
    const ys: number[] = [];
    for (const item of areaList) {
      const m = item.trim().match(/^(-?\d+(?:\.\d+)?)x(-?\d+(?:\.\d+)?)$/i);
      if (m) {
        xs.push(Number(m[1]));
        ys.push(Number(m[2]));
      }
    }
    if (xs.length > 0 && ys.length > 0) {
      const sx = Math.round((Math.max(...xs) - Math.min(...xs)) * 100) / 100;
      const sy = Math.round((Math.max(...ys) - Math.min(...ys)) * 100) / 100;
      if (sx > 20) out.bedX = sx;
      if (sy > 20) out.bedY = sy;
    }
    const hRaw = Array.isArray(parsed.printable_height)
      ? parsed.printable_height[0]
      : parsed.printable_height;
    const hNum = Number(hRaw);
    if (Number.isFinite(hNum) && hNum > 20) {
      out.bedZ = Math.round(hNum * 100) / 100;
    }
    const cols = Array.isArray(parsed.extruder_colour) ? parsed.extruder_colour.length : 1;
    const noz = Array.isArray(parsed.nozzle_diameter) ? parsed.nozzle_diameter.length : 1;
    if (Math.max(cols, noz) > 1) {
      out.mmuSlots = Math.min(16, Math.max(cols, noz));
    } else if (String(parsed.single_extruder_multi_material || '') === '1') {
      out.mmuSlots = 5;
    }
    if (typeof parsed.gcode_flavor === 'string' && parsed.gcode_flavor.toLowerCase().includes('klipper')) {
      out.printerType = 'klipper';
    }
    return out;
  } catch {
    return {};
  }
}

export function AddPrinterModal({
  open,
  targetPrinter,
  profiles,
  filaments,
  remoteFdmPrinters,
  onClose,
  onCompleted,
  onError,
}: AddPrinterModalProps) {
  const { lang } = useI18n();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const pressedOutsideRef = useRef(false);

  const [mode, setMode] = useState<'catalog' | 'manual'>('catalog');
  const [submitting, setSubmitting] = useState(false);

  // Orca Catalog state
  const [vendors, setVendors] = useState<OrcaCatalogVendorSummary[]>([]);
  const [loadingVendors, setLoadingVendors] = useState(false);
  const [vendorSearch, setVendorSearch] = useState('');
  const [selectedVendor, setSelectedVendor] = useState<string>('');
  const [vendorDetail, setVendorDetail] = useState<OrcaCatalogVendorDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const [modelSearch, setModelSearch] = useState('');
  const [selectedModelId, setSelectedModelId] = useState<string>('');
  const [selectedMachinePreset, setSelectedMachinePreset] = useState<string>('');
  const [selectedProcessPreset, setSelectedProcessPreset] = useState<string>('');
  const [filamentSearch, setFilamentSearch] = useState('');
  const [filamentMatFilter, setFilamentMatFilter] = useState<string>('ALL');
  const [selectedFilamentPresets, setSelectedFilamentPresets] = useState<string[]>([]);
  const [brokenCovers, setBrokenCovers] = useState<Record<string, boolean>>({});

  // Shared printer metadata
  const [displayName, setDisplayName] = useState('');
  const [fdmLinkSelect, setFdmLinkSelect] = useState<string>('');
  const [fdmLinkCustom, setFdmLinkCustom] = useState<string>('');

  // Manual / JSON mode state
  const [printerType, setPrinterType] = useState<PrinterType>('prusalink');
  const [bedX, setBedX] = useState('250');
  const [bedY, setBedY] = useState('210');
  const [bedZ, setBedZ] = useState('220');
  const [mmuEnabled, setMmuEnabled] = useState(false);
  const [mmuSlots, setMmuSlots] = useState('4');
  const [machineProfileId, setMachineProfileId] = useState<string>('');
  const [processProfileId, setProcessProfileId] = useState<string>('');
  const [slotFilamentIds, setSlotFilamentIds] = useState<Array<number | null>>([null]);
  const [uploadingKind, setUploadingKind] = useState<'machine' | 'process' | null>(null);

  const machineUploadRef = useRef<HTMLInputElement | null>(null);
  const processUploadRef = useRef<HTMLInputElement | null>(null);

  const machineProfiles = useMemo(() => profiles.filter((p) => p.kind === 'machine'), [profiles]);
  const processProfiles = useMemo(() => profiles.filter((p) => p.kind === 'process'), [profiles]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (typeof dialog.showModal === 'function') {
        if (!dialog.open) dialog.showModal();
      } else {
        dialog.setAttribute('open', '');
      }
    } else {
      if (typeof dialog.close === 'function') {
        if (dialog.open) dialog.close();
      } else {
        dialog.removeAttribute('open');
      }
    }
  }, [open]);

  // Reset form on open
  useEffect(() => {
    if (!open) return;
    setMode('catalog');
    if (targetPrinter) {
      setDisplayName(targetPrinter.display_name ?? targetPrinter.name);
      const linked = targetPrinter.is_fdm_linked ? targetPrinter.fdm_monster_id : '';
      setFdmLinkSelect(linked);
      setFdmLinkCustom('');
    } else {
      setDisplayName('');
      setFdmLinkSelect('');
      setFdmLinkCustom('');
      setPrinterType('prusalink');
      setBedX('250');
      setBedY('210');
      setBedZ('220');
      setMmuEnabled(false);
      setMmuSlots('4');
      setMachineProfileId(machineProfiles[0] ? String(machineProfiles[0].id) : '');
      setProcessProfileId(processProfiles[0] ? String(processProfiles[0].id) : '');
      setSlotFilamentIds([null]);
    }
    setSelectedModelId('');
    setSelectedMachinePreset('');
    setSelectedProcessPreset('');
    setSelectedFilamentPresets([]);
    setVendorSearch('');
    setModelSearch('');
    setFilamentSearch('');
    setFilamentMatFilter('ALL');
  }, [open, targetPrinter, machineProfiles, processProfiles]);

  // Load vendors on open
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoadingVendors(true);
    api
      .adminGetOrcaCatalogVendors()
      .then((list) => {
        if (!active) return;
        const printerVendors = list.filter((v) => !v.is_library && v.machine_count > 0);
        setVendors(printerVendors);
        if (!selectedVendor && printerVendors.length > 0) {
          const preferred =
            printerVendors.find((v) => v.id === 'Prusa') ??
            printerVendors.find((v) => v.id === 'BBL') ??
            printerVendors[0];
          setSelectedVendor(preferred.id);
        }
      })
      .catch((err) => {
        if (active) onError(err instanceof Error ? err.message : 'Unable to load OrcaSlicer catalog');
      })
      .finally(() => {
        if (active) setLoadingVendors(false);
      });
    return () => {
      active = false;
    };
  }, [open, onError, selectedVendor]);

  // Load vendor detail when selectedVendor changes
  useEffect(() => {
    if (!open || !selectedVendor) return;
    let active = true;
    setLoadingDetail(true);
    api
      .adminGetOrcaCatalogVendorDetail(selectedVendor)
      .then((detail) => {
        if (!active) return;
        setVendorDetail(detail);
        const firstModel = detail.models[0] ?? null;
        if (firstModel) {
          setSelectedModelId(firstModel.id);
          const mp = firstModel.machine_presets[0] || detail.machine_presets[0]?.name || '';
          setSelectedMachinePreset(mp);
          if (!targetPrinter) {
            setDisplayName(mp || firstModel.name);
          }
        } else {
          setSelectedModelId('');
          const mp = detail.machine_presets[0]?.name || '';
          setSelectedMachinePreset(mp);
          if (!targetPrinter) {
            setDisplayName(mp);
          }
        }
        const proc = detail.process_presets[0]?.name || '';
        setSelectedProcessPreset(proc);
        setSelectedFilamentPresets([]);
      })
      .catch((err) => {
        if (active) onError(err instanceof Error ? err.message : 'Unable to load vendor profiles');
      })
      .finally(() => {
        if (active) setLoadingDetail(false);
      });
    return () => {
      active = false;
    };
  }, [open, selectedVendor, targetPrinter, onError]);

  const filteredVendors = useMemo(() => {
    const q = vendorSearch.trim().toLowerCase();
    if (!q) return vendors;
    return vendors.filter(
      (v) => v.name.toLowerCase().includes(q) || v.id.toLowerCase().includes(q)
    );
  }, [vendors, vendorSearch]);

  const filteredModels = useMemo(() => {
    if (!vendorDetail) return [];
    const q = modelSearch.trim().toLowerCase();
    if (!q) return vendorDetail.models;
    return vendorDetail.models.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.family.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q)
    );
  }, [vendorDetail, modelSearch]);

  const activeModel = useMemo(
    () => vendorDetail?.models.find((m) => m.id === selectedModelId) ?? null,
    [vendorDetail, selectedModelId]
  );

  const visibleMachinePresets = useMemo(() => {
    if (!vendorDetail) return [];
    if (activeModel && activeModel.machine_presets.length > 0) {
      const set = new Set(activeModel.machine_presets);
      return vendorDetail.machine_presets.filter((mp) => set.has(mp.name));
    }
    return vendorDetail.machine_presets;
  }, [vendorDetail, activeModel]);

  const visibleProcessPresets = useMemo(() => {
    if (!vendorDetail) return [];
    if (!selectedMachinePreset) return vendorDetail.process_presets;
    const compat: typeof vendorDetail.process_presets = [];
    const generic: typeof vendorDetail.process_presets = [];
    for (const pp of vendorDetail.process_presets) {
      if (pp.compatible_printers.includes(selectedMachinePreset)) {
        compat.push(pp);
      } else {
        generic.push(pp);
      }
    }
    return compat.length > 0 ? [...compat, ...generic] : vendorDetail.process_presets;
  }, [vendorDetail, selectedMachinePreset]);

  // Auto-select compatible process preset when machine preset changes
  useEffect(() => {
    if (!vendorDetail || !selectedMachinePreset) return;
    const compat = vendorDetail.process_presets.filter((p) =>
      p.compatible_printers.includes(selectedMachinePreset)
    );
    if (compat.length > 0 && !compat.some((p) => p.name === selectedProcessPreset)) {
      const preferred =
        compat.find((p) => /0\.20mm.*standard/i.test(p.name)) ??
        compat.find((p) => /0\.20mm/i.test(p.name)) ??
        compat[0];
      setSelectedProcessPreset(preferred.name);
    }
  }, [vendorDetail, selectedMachinePreset, selectedProcessPreset]);

  const visibleFilaments = useMemo(() => {
    if (!vendorDetail) return [];
    const q = filamentSearch.trim().toLowerCase();
    return vendorDetail.filaments.filter((f) => {
      if (filamentMatFilter !== 'ALL' && !f.material.toUpperCase().includes(filamentMatFilter)) {
        return false;
      }
      if (q && !f.name.toLowerCase().includes(q) && !f.material.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [vendorDetail, filamentSearch, filamentMatFilter]);

  const toggleFilamentPreset = (presetName: string) => {
    setSelectedFilamentPresets((prev) =>
      prev.includes(presetName) ? prev.filter((p) => p !== presetName) : [...prev, presetName]
    );
  };

  const resolvedFdmMonsterId = (): string | null => {
    if (fdmLinkSelect === '__custom__') {
      return fdmLinkCustom.trim() || null;
    }
    return fdmLinkSelect.trim() || null;
  };

  const handleCatalogSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedVendor || !selectedMachinePreset) return;
    setSubmitting(true);
    try {
      await api.adminImportOrcaCatalogPrinter({
        vendor: selectedVendor,
        machine_preset_name: selectedMachinePreset,
        process_preset_name: selectedProcessPreset || null,
        filament_preset_names: selectedFilamentPresets,
        display_name: displayName.trim() || selectedMachinePreset,
        fdm_monster_id: targetPrinter ? undefined : resolvedFdmMonsterId(),
        target_printer_id: targetPrinter ? targetPrinter.id : null,
      });
      await onCompleted();
      onClose();
    } catch (err) {
      onError(translateApiError(err, { errors: {} } as never));
    } finally {
      setSubmitting(false);
    }
  };

  const handleManualProfileUpload = async (
    kind: 'machine' | 'process',
    file: File | null
  ) => {
    if (!file) return;
    setUploadingKind(kind);
    try {
      const text = await file.text();
      let name = file.name.replace(/\.json$/i, '');
      if (kind === 'machine') {
        const meta = parseMachineJsonMetadata(text);
        if (meta.name) name = meta.name;
        if (!displayName.trim() && meta.name) setDisplayName(meta.name);
        if (meta.bedX) setBedX(String(meta.bedX));
        if (meta.bedY) setBedY(String(meta.bedY));
        if (meta.bedZ) setBedZ(String(meta.bedZ));
        if (meta.printerType) setPrinterType(meta.printerType);
        if (meta.mmuSlots && meta.mmuSlots > 1) {
          setMmuEnabled(true);
          setMmuSlots(String(meta.mmuSlots));
          setSlotFilamentIds((prev) =>
            Array.from({ length: meta.mmuSlots! }, (_, i) => prev[i] ?? null)
          );
        }
      } else {
        try {
          const parsed = JSON.parse(text.replace(/^\uFEFF/, '')) as Record<string, unknown>;
          if (typeof parsed.name === 'string' && parsed.name.trim()) {
            name = parsed.name.trim();
          }
        } catch {
          // ignore
        }
      }
      const created = await api.adminUploadProfile(file, name, kind, 'Uploaded via Add Printer');
      if (kind === 'machine') {
        setMachineProfileId(String(created.id));
      } else {
        setProcessProfileId(String(created.id));
      }
      await onCompleted();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Profile upload failed');
    } finally {
      setUploadingKind(null);
    }
  };

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!displayName.trim()) return;
    const count = mmuEnabled ? Math.max(2, Math.min(16, Number(mmuSlots) || 4)) : 1;
    setSubmitting(true);
    try {
      await api.adminCreatePrinter({
        display_name: displayName.trim(),
        printer_type: printerType,
        bed_x_mm: Number(bedX) || 250,
        bed_y_mm: Number(bedY) || 210,
        bed_z_mm: Number(bedZ) || 220,
        mmu_slots_count: count,
        fdm_monster_id: resolvedFdmMonsterId(),
        machine_profile_id: machineProfileId ? Number(machineProfileId) : null,
        process_profile_id: processProfileId ? Number(processProfileId) : null,
        slot_filament_ids: slotFilamentIds.slice(0, count),
        is_enabled: true,
      });
      await onCompleted();
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to create printer');
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  const isFr = lang === 'fr';
  const effectiveSlotCount = mmuEnabled ? Math.max(2, Math.min(16, Number(mmuSlots) || 4)) : 1;

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onPointerDown={(e) => {
        const rect = dialogRef.current?.getBoundingClientRect();
        if (!rect) return;
        pressedOutsideRef.current =
          e.clientX < rect.left ||
          e.clientX > rect.right ||
          e.clientY < rect.top ||
          e.clientY > rect.bottom;
      }}
      onClick={() => {
        if (pressedOutsideRef.current) {
          pressedOutsideRef.current = false;
          onClose();
        }
      }}
      className="studio-surface m-auto max-h-[90dvh] w-[min(100%-1.5rem,980px)] overflow-hidden p-0 text-[#111318] backdrop:bg-black/55 dark:text-[#F4F5F7]"
    >
      <div className="flex max-h-[90dvh] flex-col">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-black/[0.07] px-5 py-4 dark:border-white/[0.08]">
          <div>
            <h2 className="text-base font-semibold tracking-tight">
              {targetPrinter
                ? isFr
                  ? `Catalogue OrcaSlicer — ${targetPrinter.display_name ?? targetPrinter.name}`
                  : `OrcaSlicer Catalog — ${targetPrinter.display_name ?? targetPrinter.name}`
                : isFr
                  ? 'Ajouter une imprimante'
                  : 'Add Printer'}
            </h2>
            <p className="mt-0.5 text-xs text-[#5B616E] dark:text-[#9399A6]">
              {isFr
                ? 'Choisissez un modèle et ses filaments dans OrcaSlicer, ou importez vos fichiers JSON.'
                : 'Select a printer model and filaments from OrcaSlicer, or upload JSON profiles manually.'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {!targetPrinter && (
              <div className="inline-flex rounded-xl border border-black/[0.08] bg-[#F6F7F9] p-0.5 dark:border-white/[0.09] dark:bg-[#0D0E11]">
                <button
                  type="button"
                  onClick={() => setMode('catalog')}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                    mode === 'catalog'
                      ? 'bg-white text-[#111318] shadow-sm dark:bg-[#1D2027] dark:text-[#F4F5F7]'
                      : 'text-[#5B616E] dark:text-[#9399A6]'
                  }`}
                >
                  <Sparkles className="h-3.5 w-3.5 text-[#00A7D9]" />
                  {isFr ? 'Catalogue OrcaSlicer' : 'OrcaSlicer Catalog'}
                </button>
                <button
                  type="button"
                  onClick={() => setMode('manual')}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                    mode === 'manual'
                      ? 'bg-white text-[#111318] shadow-sm dark:bg-[#1D2027] dark:text-[#F4F5F7]'
                      : 'text-[#5B616E] dark:text-[#9399A6]'
                  }`}
                >
                  <FileJson className="h-3.5 w-3.5 text-[#00A7D9]" />
                  {isFr ? 'Manuel / Fichiers JSON' : 'Manual / JSON Files'}
                </button>
              </div>
            )}
            <button type="button" onClick={onClose} className="btn-ghost p-1.5" aria-label="Close">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        {mode === 'catalog' ? (
          <form onSubmit={handleCatalogSubmit} className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="grid min-h-0 flex-1 grid-cols-1 divide-y divide-black/[0.07] overflow-y-auto dark:divide-white/[0.08] md:grid-cols-12 md:divide-x md:divide-y-0">
              {/* Column 1: Vendors */}
              <div className="flex flex-col p-4 md:col-span-3 md:overflow-y-auto">
                <div className="relative mb-2.5">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8A909E]" />
                  <input
                    type="text"
                    value={vendorSearch}
                    onChange={(e) => setVendorSearch(e.target.value)}
                    placeholder={isFr ? 'Fabricant…' : 'Search vendor…'}
                    className="studio-input py-1.5 pl-8 text-xs"
                  />
                </div>
                {loadingVendors ? (
                  <div className="flex items-center justify-center py-10 text-xs text-[#5B616E]">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin text-[#00A7D9]" />
                    {isFr ? 'Chargement…' : 'Loading…'}
                  </div>
                ) : (
                  <div className="max-h-56 space-y-1 overflow-y-auto md:max-h-[420px]">
                    {filteredVendors.map((v) => {
                      const active = selectedVendor === v.id;
                      return (
                        <button
                          key={v.id}
                          type="button"
                          onClick={() => setSelectedVendor(v.id)}
                          className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
                            active
                              ? 'bg-[#00A7D9]/15 font-semibold text-[#007BA3] dark:text-[#38C6F4]'
                              : 'text-[#111318] hover:bg-black/[0.04] dark:text-[#F4F5F7] dark:hover:bg-white/[0.05]'
                          }`}
                        >
                          <span className="truncate">{v.name}</span>
                          <span className="ml-2 shrink-0 rounded bg-black/[0.05] px-1.5 py-0.5 font-mono text-[10px] tabular-nums dark:bg-white/[0.08]">
                            {v.model_count}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Column 2: Models & Presets */}
              <div className="flex flex-col space-y-4 p-4 md:col-span-5 md:overflow-y-auto">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8A909E]" />
                  <input
                    type="text"
                    value={modelSearch}
                    onChange={(e) => setModelSearch(e.target.value)}
                    placeholder={isFr ? 'Modèle d’imprimante…' : 'Filter printer models…'}
                    className="studio-input py-1.5 pl-8 text-xs"
                  />
                </div>

                {loadingDetail ? (
                  <div className="flex items-center justify-center py-12 text-xs text-[#5B616E]">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin text-[#00A7D9]" />
                    {isFr ? 'Analyse des profils Orca…' : 'Loading Orca profiles…'}
                  </div>
                ) : (
                  <>
                    <div className="grid max-h-56 grid-cols-2 gap-2 overflow-y-auto pr-1">
                      {filteredModels.map((m) => {
                        const selected = m.id === selectedModelId;
                        const coverBroken = brokenCovers[m.cover_url || ''];
                        return (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() => {
                              setSelectedModelId(m.id);
                              const firstPreset =
                                m.machine_presets[0] || vendorDetail?.machine_presets[0]?.name || '';
                              setSelectedMachinePreset(firstPreset);
                              if (!targetPrinter) {
                                setDisplayName(firstPreset || m.name);
                              }
                            }}
                            className={`flex flex-col items-start rounded-xl border p-2.5 text-left transition-all ${
                              selected
                                ? 'border-[#00A7D9] bg-[#00A7D9]/10 ring-1 ring-[#00A7D9]/30'
                                : 'border-black/[0.08] bg-white/60 hover:border-black/20 dark:border-white/[0.08] dark:bg-[#15171C]'
                            }`}
                          >
                            <div className="mb-2 flex h-14 w-full items-center justify-center overflow-hidden rounded-lg bg-[#F6F7F9] dark:bg-[#0D0E11]">
                              {m.cover_url && !coverBroken ? (
                                <img
                                  src={m.cover_url}
                                  alt={m.name}
                                  loading="lazy"
                                  onError={() =>
                                    setBrokenCovers((prev) => ({ ...prev, [m.cover_url!]: true }))
                                  }
                                  className="h-full w-full object-contain p-1"
                                />
                              ) : (
                                <PrinterIcon className="h-6 w-6 text-[#8A909E]" />
                              )}
                            </div>
                            <div className="line-clamp-1 text-xs font-semibold">{m.name}</div>
                            <div className="mt-0.5 font-mono text-[10px] text-[#5B616E] dark:text-[#9399A6]">
                              {m.bed_x_mm}×{m.bed_y_mm}×{m.bed_z_mm} mm
                              {m.mmu_slots_count > 1 ? ` · ${m.mmu_slots_count}T` : ''}
                            </div>
                          </button>
                        );
                      })}
                    </div>

                    <div className="space-y-2.5">
                      <div>
                        <label className="mb-1 block text-[11px] font-medium text-[#5B616E] dark:text-[#9399A6]">
                          {isFr ? 'Profil machine / buse' : 'Machine & nozzle preset'}
                        </label>
                        <select
                          value={selectedMachinePreset}
                          onChange={(e) => {
                            setSelectedMachinePreset(e.target.value);
                            if (!targetPrinter) setDisplayName(e.target.value);
                          }}
                          className="studio-input py-1.5 text-xs"
                          required
                        >
                          {visibleMachinePresets.map((mp) => (
                            <option key={mp.name} value={mp.name}>
                              {mp.name} ({mp.bed_x_mm}×{mp.bed_y_mm}×{mp.bed_z_mm})
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="mb-1 block text-[11px] font-medium text-[#5B616E] dark:text-[#9399A6]">
                          {isFr ? 'Profil procédé par défaut' : 'Default process preset'}
                        </label>
                        <select
                          value={selectedProcessPreset}
                          onChange={(e) => setSelectedProcessPreset(e.target.value)}
                          className="studio-input py-1.5 text-xs"
                        >
                          <option value="">{isFr ? 'Aucun' : 'None'}</option>
                          {visibleProcessPresets.map((pp) => (
                            <option key={pp.name} value={pp.name}>
                              {pp.name}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="mb-1 block text-[11px] font-medium text-[#5B616E] dark:text-[#9399A6]">
                          {isFr ? 'Nom affiché dans GGPrint' : 'Display name'}
                        </label>
                        <input
                          type="text"
                          value={displayName}
                          onChange={(e) => setDisplayName(e.target.value)}
                          className="studio-input py-1.5 text-xs"
                          required
                        />
                      </div>

                      {!targetPrinter && (
                        <div>
                          <label className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-[#5B616E] dark:text-[#9399A6]">
                            <Link2 className="h-3 w-3" />
                            {isFr ? 'Lien FDM Monster (optionnel)' : 'FDM Monster link (optional)'}
                          </label>
                          <select
                            value={fdmLinkSelect}
                            onChange={(e) => setFdmLinkSelect(e.target.value)}
                            className="studio-input py-1.5 text-xs"
                          >
                            <option value="">
                              {isFr ? 'Autonome (sans FDM Monster)' : 'Standalone (no FDM Monster)'}
                            </option>
                            {remoteFdmPrinters.map((rp) => (
                              <option key={rp.fdm_monster_id} value={rp.fdm_monster_id}>
                                {rp.name} ({rp.fdm_monster_id})
                              </option>
                            ))}
                            <option value="__custom__">
                              {isFr ? 'Saisir un ID manuellement…' : 'Enter custom FDM ID…'}
                            </option>
                          </select>
                          {fdmLinkSelect === '__custom__' && (
                            <input
                              type="text"
                              value={fdmLinkCustom}
                              onChange={(e) => setFdmLinkCustom(e.target.value)}
                              placeholder="prusalink-mk4s-1"
                              className="studio-input mt-1.5 py-1.5 font-mono text-xs"
                            />
                          )}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>

              {/* Column 3: Filaments selector */}
              <div className="flex flex-col space-y-2.5 p-4 md:col-span-4 md:overflow-y-auto">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold">
                    {isFr ? 'Filaments à importer' : 'Filaments to import'}
                  </span>
                  <span className="rounded-full bg-[#00A7D9]/12 px-2 py-0.5 font-mono text-[10px] font-medium text-[#007BA3] dark:text-[#38C6F4]">
                    {selectedFilamentPresets.length}
                  </span>
                </div>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8A909E]" />
                  <input
                    type="text"
                    value={filamentSearch}
                    onChange={(e) => setFilamentSearch(e.target.value)}
                    placeholder={isFr ? 'Filtrer les filaments…' : 'Filter filaments…'}
                    className="studio-input py-1.5 pl-8 text-xs"
                  />
                </div>
                <div className="flex flex-wrap gap-1">
                  {MATERIAL_FILTERS.map((mat) => (
                    <button
                      key={mat}
                      type="button"
                      onClick={() => setFilamentMatFilter(mat)}
                      className={`rounded-md px-2 py-0.5 text-[10px] font-medium transition-colors ${
                        filamentMatFilter === mat
                          ? 'bg-[#00A7D9] text-white'
                          : 'bg-black/[0.05] text-[#5B616E] hover:text-[#111318] dark:bg-white/[0.08] dark:text-[#9399A6]'
                      }`}
                    >
                      {mat}
                    </button>
                  ))}
                </div>
                <div className="max-h-64 flex-1 space-y-1 overflow-y-auto pr-1 md:max-h-[340px]">
                  {visibleFilaments.slice(0, 120).map((fil) => {
                    const checked = selectedFilamentPresets.includes(fil.preset_name);
                    return (
                      <label
                        key={fil.preset_name}
                        className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
                          checked
                            ? 'border-[#00A7D9]/50 bg-[#00A7D9]/10'
                            : 'border-black/[0.06] bg-white/50 hover:bg-black/[0.03] dark:border-white/[0.07] dark:bg-[#15171C]/70'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleFilamentPreset(fil.preset_name)}
                          className="h-3.5 w-3.5 rounded accent-[#00A7D9]"
                        />
                        <span
                          className="h-3 w-3 shrink-0 rounded-full border border-black/15 dark:border-white/20"
                          style={{ backgroundColor: fil.color_hex }}
                        />
                        <span className="min-w-0 flex-1 truncate">{fil.name}</span>
                        <span className="shrink-0 font-mono text-[10px] text-[#5B616E] dark:text-[#9399A6]">
                          {fil.material}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-black/[0.07] px-5 py-3.5 dark:border-white/[0.08]">
              <button type="button" onClick={onClose} className="btn-secondary py-1.5 text-xs">
                {isFr ? 'Annuler' : 'Cancel'}
              </button>
              <button
                type="submit"
                disabled={submitting || !selectedMachinePreset}
                className="btn-primary py-1.5 text-xs"
              >
                {submitting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                {targetPrinter
                  ? isFr
                    ? 'Appliquer les profils'
                    : 'Apply Orca Profiles'
                  : isFr
                    ? 'Créer l’imprimante'
                    : 'Create Printer'}
              </button>
            </div>
          </form>
        ) : (
          /* Manual / JSON Files mode */
          <form onSubmit={handleManualSubmit} className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <input
              ref={machineUploadRef}
              type="file"
              accept=".json"
              onChange={(e) => {
                void handleManualProfileUpload('machine', e.target.files?.[0] ?? null);
                e.target.value = '';
              }}
              className="hidden"
            />
            <input
              ref={processUploadRef}
              type="file"
              accept=".json"
              onChange={(e) => {
                void handleManualProfileUpload('process', e.target.files?.[0] ?? null);
                e.target.value = '';
              }}
              className="hidden"
            />
            <div className="grid flex-1 grid-cols-1 gap-4 overflow-y-auto p-5 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className="mb-1 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
                  {isFr ? 'Nom de l’imprimante' : 'Printer display name'}
                </label>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Prusa MK4S Lab #1"
                  className="studio-input py-1.5 text-xs"
                  required
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
                  {isFr ? 'Type de micrologiciel' : 'Firmware type'}
                </label>
                <select
                  value={printerType}
                  onChange={(e) => setPrinterType(e.target.value as PrinterType)}
                  className="studio-input py-1.5 text-xs"
                >
                  <option value="prusalink">PrusaLink / Marlin</option>
                  <option value="klipper">Klipper</option>
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
                  {isFr ? 'Lien FDM Monster (optionnel)' : 'FDM Monster link (optional)'}
                </label>
                <select
                  value={fdmLinkSelect}
                  onChange={(e) => setFdmLinkSelect(e.target.value)}
                  className="studio-input py-1.5 text-xs"
                >
                  <option value="">
                    {isFr ? 'Autonome (sans FDM Monster)' : 'Standalone (no FDM Monster)'}
                  </option>
                  {remoteFdmPrinters.map((rp) => (
                    <option key={rp.fdm_monster_id} value={rp.fdm_monster_id}>
                      {rp.name} ({rp.fdm_monster_id})
                    </option>
                  ))}
                  <option value="__custom__">
                    {isFr ? 'Saisir un ID manuellement…' : 'Enter custom FDM ID…'}
                  </option>
                </select>
                {fdmLinkSelect === '__custom__' && (
                  <input
                    type="text"
                    value={fdmLinkCustom}
                    onChange={(e) => setFdmLinkCustom(e.target.value)}
                    placeholder="prusalink-mk4s-1"
                    className="studio-input mt-1.5 py-1.5 font-mono text-xs"
                  />
                )}
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
                  {isFr ? 'Plateau (X × Y × Z mm)' : 'Build volume (X × Y × Z mm)'}
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <input
                    type="number"
                    value={bedX}
                    onChange={(e) => setBedX(e.target.value)}
                    className="studio-input py-1.5 font-mono text-xs"
                    required
                  />
                  <input
                    type="number"
                    value={bedY}
                    onChange={(e) => setBedY(e.target.value)}
                    className="studio-input py-1.5 font-mono text-xs"
                    required
                  />
                  <input
                    type="number"
                    value={bedZ}
                    onChange={(e) => setBedZ(e.target.value)}
                    className="studio-input py-1.5 font-mono text-xs"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
                  MMU / Multi-filament
                </label>
                <div className="flex items-center gap-2">
                  <label className="flex cursor-pointer items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={mmuEnabled}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setMmuEnabled(checked);
                        const cnt = checked ? Math.max(2, Number(mmuSlots) || 4) : 1;
                        setSlotFilamentIds((prev) =>
                          Array.from({ length: cnt }, (_, i) => prev[i] ?? null)
                        );
                      }}
                      className="h-4 w-4 rounded"
                    />
                    <span>{isFr ? 'Activer MMU' : 'Enable MMU'}</span>
                  </label>
                  {mmuEnabled && (
                    <input
                      type="number"
                      min={2}
                      max={16}
                      value={mmuSlots}
                      onChange={(e) => {
                        const cnt = Math.max(2, Math.min(16, Number(e.target.value) || 2));
                        setMmuSlots(String(cnt));
                        setSlotFilamentIds((prev) =>
                          Array.from({ length: cnt }, (_, i) => prev[i] ?? null)
                        );
                      }}
                      className="studio-input w-20 py-1.5 font-mono text-xs"
                    />
                  )}
                </div>
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
                    {isFr ? 'Profil machine (Orca .json)' : 'Machine profile (.json)'}
                  </label>
                  <button
                    type="button"
                    disabled={uploadingKind === 'machine'}
                    onClick={() => machineUploadRef.current?.click()}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-[#007BA3] hover:underline dark:text-[#38C6F4]"
                  >
                    <Upload className="h-3 w-3" />
                    {isFr ? 'Importer .json' : 'Upload .json'}
                  </button>
                </div>
                <select
                  value={machineProfileId}
                  onChange={(e) => setMachineProfileId(e.target.value)}
                  className="studio-input py-1.5 text-xs"
                >
                  <option value="">{isFr ? 'Aucun' : 'None'}</option>
                  {machineProfiles.map((mp) => (
                    <option key={mp.id} value={mp.id}>
                      {mp.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
                    {isFr ? 'Profil procédé (Orca .json)' : 'Process profile (.json)'}
                  </label>
                  <button
                    type="button"
                    disabled={uploadingKind === 'process'}
                    onClick={() => processUploadRef.current?.click()}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-[#007BA3] hover:underline dark:text-[#38C6F4]"
                  >
                    <Upload className="h-3 w-3" />
                    {isFr ? 'Importer .json' : 'Upload .json'}
                  </button>
                </div>
                <select
                  value={processProfileId}
                  onChange={(e) => setProcessProfileId(e.target.value)}
                  className="studio-input py-1.5 text-xs"
                >
                  <option value="">{isFr ? 'Aucun' : 'None'}</option>
                  {processProfiles.map((pp) => (
                    <option key={pp.id} value={pp.id}>
                      {pp.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="sm:col-span-2 space-y-2 border-t border-black/[0.07] pt-3 dark:border-white/[0.08]">
                <div className="text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
                  {isFr ? 'Filaments chargés initiaux' : 'Initial slot filaments'}
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {Array.from({ length: effectiveSlotCount }, (_, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <span className="w-10 font-mono text-xs text-[#5B616E]">#{idx + 1}</span>
                      <select
                        value={slotFilamentIds[idx] ?? ''}
                        onChange={(e) => {
                          const nextVal = e.target.value ? Number(e.target.value) : null;
                          setSlotFilamentIds((prev) => {
                            const copy = [...prev];
                            copy[idx] = nextVal;
                            return copy;
                          });
                        }}
                        className="studio-input flex-1 py-1 text-xs"
                      >
                        <option value="">{isFr ? 'Emplacement vide' : 'Empty slot'}</option>
                        {filaments.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.name} ({f.material})
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-black/[0.07] px-5 py-3.5 dark:border-white/[0.08]">
              <button type="button" onClick={onClose} className="btn-secondary py-1.5 text-xs">
                {isFr ? 'Annuler' : 'Cancel'}
              </button>
              <button
                type="submit"
                disabled={submitting || !displayName.trim()}
                className="btn-primary py-1.5 text-xs"
              >
                {submitting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                {isFr ? 'Créer l’imprimante' : 'Create Printer'}
              </button>
            </div>
          </form>
        )}
      </div>
    </dialog>
  );
}
