import React, { useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Edit3,
  FileCode2,
  Loader2,
  Plus,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import type {
  Filament,
  OrcaFilamentImportResult,
  OrcaProfile,
  ProfileKind,
  PrusaSlicerImportResult,
  PrusaSlicerPreviewItem,
  PrusaSlicerPreviewResult,
} from '../../types/api';
import { translateApiError } from '../../utils/errors';

interface AdminFilamentsProfilesTabProps {
  filaments: Filament[];
  profiles: OrcaProfile[];
  onReload: () => Promise<void>;
  onError: (msg: string) => void;
}

export function AdminFilamentsProfilesTab({
  filaments,
  profiles,
  onReload,
  onError,
}: AdminFilamentsProfilesTabProps) {
  const { t } = useI18n();

  const [fName, setFName] = useState('');
  const [fMaterial, setFMaterial] = useState('PLA');
  const [fColor, setFColor] = useState('#00A7D9');
  const [fDensity, setFDensity] = useState('1.24');
  const [fProfileId, setFProfileId] = useState<string>('');
  const [fProcessOverrideId, setFProcessOverrideId] = useState<string>('');
  const [savingFilament, setSavingFilament] = useState(false);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<{
    name: string;
    material: string;
    color_hex: string;
    density_g_cm3: string;
    filament_profile_id: string;
    process_override_profile_id: string;
  } | null>(null);

  const [pName, setPName] = useState('');
  const [pKind, setPKind] = useState<ProfileKind>('machine');
  const [pNotes, setPNotes] = useState('');
  const [pFile, setPFile] = useState<File | null>(null);
  const [uploadingProfile, setUploadingProfile] = useState(false);
  const profileFileInputRef = useRef<HTMLInputElement | null>(null);

  // OrcaSlicer filament import state
  const [importPanelOpen, setImportPanelOpen] = useState(false);
  const [orcaFiles, setOrcaFiles] = useState<File[]>([]);
  const [orcaUpdateExisting, setOrcaUpdateExisting] = useState(true);
  const [orcaDragging, setOrcaDragging] = useState(false);
  const [importingOrca, setImportingOrca] = useState(false);
  const [orcaResult, setOrcaResult] = useState<OrcaFilamentImportResult | null>(null);
  const orcaFileInputRef = useRef<HTMLInputElement | null>(null);

  // PrusaSlicer (.ini / .zip) 2-step Inspect -> Select -> Import state
  const [prusaPanelOpen, setPrusaPanelOpen] = useState(false);
  const [prusaFiles, setPrusaFiles] = useState<File[]>([]);
  const [prusaInspecting, setPrusaInspecting] = useState(false);
  const [prusaPreview, setPrusaPreview] = useState<PrusaSlicerPreviewResult | null>(null);
  const [prusaSelectedKeys, setPrusaSelectedKeys] = useState<string[]>([]);
  const [prusaSearch, setPrusaSearch] = useState('');
  const [prusaUpdateExisting, setPrusaUpdateExisting] = useState(true);
  const [prusaDragging, setPrusaDragging] = useState(false);
  const [importingPrusa, setImportingPrusa] = useState(false);
  const [prusaResult, setPrusaResult] = useState<PrusaSlicerImportResult | null>(null);
  const prusaFileInputRef = useRef<HTMLInputElement | null>(null);

  const filamentProfiles = profiles.filter((p) => p.kind === 'filament');
  const processProfiles = profiles.filter((p) => p.kind === 'process');
  const profileById = useMemo(() => {
    const map = new Map<number, OrcaProfile>();
    for (const p of profiles) map.set(p.id, p);
    return map;
  }, [profiles]);

  const appendOrcaFiles = (incoming: FileList | File[] | null) => {
    if (!incoming || incoming.length === 0) return;
    const list = Array.from(incoming);
    setOrcaFiles((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}:${f.size}:${f.lastModified}`));
      const next = [...prev];
      for (const file of list) {
        const sig = `${file.name}:${file.size}:${file.lastModified}`;
        if (!seen.has(sig)) {
          seen.add(sig);
          next.push(file);
        }
      }
      return next;
    });
  };

  const handleImportOrcaFilaments = async (e: React.FormEvent) => {
    e.preventDefault();
    if (orcaFiles.length === 0) return;
    setImportingOrca(true);
    setOrcaResult(null);
    try {
      const res = await api.adminImportOrcaFilaments(orcaFiles, {
        update_existing: orcaUpdateExisting,
      });
      setOrcaResult(res);
      setOrcaFiles([]);
      if (orcaFileInputRef.current) {
        orcaFileInputRef.current.value = '';
      }
      if (res.created_count > 0 || res.updated_count > 0) {
        await onReload();
      }
    } catch (err) {
      onError(translateApiError(err, t));
    } finally {
      setImportingOrca(false);
    }
  };

  const prusaSelectedSet = useMemo(() => new Set(prusaSelectedKeys), [prusaSelectedKeys]);

  const inspectPrusaFiles = async (filesToInspect: File[]) => {
    if (filesToInspect.length === 0) {
      setPrusaPreview(null);
      setPrusaSelectedKeys([]);
      return;
    }
    setPrusaInspecting(true);
    setPrusaResult(null);
    try {
      const preview = await api.adminPreviewPrusaSlicer(filesToInspect);
      setPrusaPreview(preview);
      setPrusaSelectedKeys(preview.items.map((item) => item.key));
      setPrusaSearch('');
    } catch (err) {
      onError(translateApiError(err, t));
      setPrusaPreview(null);
      setPrusaSelectedKeys([]);
    } finally {
      setPrusaInspecting(false);
    }
  };

  const appendPrusaFiles = (incoming: FileList | File[] | null) => {
    if (!incoming || incoming.length === 0) return;
    const list = Array.from(incoming);
    const seen = new Set(prusaFiles.map((f) => `${f.name}:${f.size}:${f.lastModified}`));
    const next = [...prusaFiles];
    for (const file of list) {
      const sig = `${file.name}:${file.size}:${file.lastModified}`;
      if (!seen.has(sig)) {
        seen.add(sig);
        next.push(file);
      }
    }
    setPrusaFiles(next);
    void inspectPrusaFiles(next);
  };

  const resetPrusaSelection = () => {
    setPrusaFiles([]);
    setPrusaPreview(null);
    setPrusaSelectedKeys([]);
    setPrusaSearch('');
    if (prusaFileInputRef.current) {
      prusaFileInputRef.current.value = '';
    }
  };

  const togglePrusaKey = (key: string) => {
    setPrusaSelectedKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  };

  const selectPrusaKeys = (keys: string[], checked: boolean) => {
    if (checked) {
      setPrusaSelectedKeys((prev) => Array.from(new Set([...prev, ...keys])));
    } else {
      const removeSet = new Set(keys);
      setPrusaSelectedKeys((prev) => prev.filter((k) => !removeSet.has(k)));
    }
  };

  const handleImportPrusaSlicer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (prusaFiles.length === 0 || prusaSelectedKeys.length === 0) {
      return;
    }
    setImportingPrusa(true);
    setPrusaResult(null);
    try {
      const res = await api.adminImportPrusaSlicer(prusaFiles, {
        selected_keys: prusaSelectedKeys,
        update_existing: prusaUpdateExisting,
      });
      setPrusaResult(res);
      resetPrusaSelection();
      if (
        res.filaments_created > 0 ||
        res.filaments_updated > 0 ||
        res.profiles_created > 0 ||
        res.profiles_updated > 0
      ) {
        await onReload();
      }
    } catch (err) {
      onError(translateApiError(err, t));
    } finally {
      setImportingPrusa(false);
    }
  };

  const handleProfileFileSelect = async (file: File | null) => {
    setPFile(file);
    if (!file) return;
    const fallbackName = file.name.replace(/\.json$/i, '');
    try {
      const text = await file.text();
      const parsed = JSON.parse(text.replace(/^\uFEFF/, '')) as Record<string, unknown>;
      const detectedName = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : fallbackName;
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

  const handleAddFilament = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fName.trim()) return;
    setSavingFilament(true);
    try {
      await api.adminCreateFilament({
        name: fName.trim(),
        material: fMaterial.trim() || 'PLA',
        color_hex: fColor,
        density_g_cm3: Number(fDensity) || 1.24,
        filament_profile_id: fProfileId ? Number(fProfileId) : null,
        process_override_profile_id: fProcessOverrideId ? Number(fProcessOverrideId) : null,
      });
      setFName('');
      await onReload();
    } catch (err) {
      onError(translateApiError(err, t));
    } finally {
      setSavingFilament(false);
    }
  };

  const startEdit = (fil: Filament) => {
    setEditingId(fil.id);
    setEditDraft({
      name: fil.name,
      material: fil.material,
      color_hex: fil.color_hex,
      density_g_cm3: String(fil.density_g_cm3),
      filament_profile_id: fil.filament_profile_id ? String(fil.filament_profile_id) : '',
      process_override_profile_id: fil.process_override_profile_id
        ? String(fil.process_override_profile_id)
        : '',
    });
  };

  const handleSaveEdit = async (id: number) => {
    if (!editDraft) return;
    try {
      await api.adminUpdateFilament(id, {
        name: editDraft.name.trim(),
        material: editDraft.material.trim(),
        color_hex: editDraft.color_hex,
        density_g_cm3: Number(editDraft.density_g_cm3) || 1.24,
        filament_profile_id: editDraft.filament_profile_id
          ? Number(editDraft.filament_profile_id)
          : null,
        process_override_profile_id: editDraft.process_override_profile_id
          ? Number(editDraft.process_override_profile_id)
          : null,
      });
      setEditingId(null);
      setEditDraft(null);
      await onReload();
    } catch (err) {
      onError(translateApiError(err, t));
    }
  };

  const handleDeleteFilament = async (id: number) => {
    try {
      await api.adminDeleteFilament(id);
      await onReload();
    } catch (err) {
      onError(translateApiError(err, t));
    }
  };

  const handleUploadProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pFile || !pName.trim()) return;
    setUploadingProfile(true);
    try {
      await api.adminUploadProfile(pFile, pName.trim(), pKind, pNotes.trim());
      setPName('');
      setPNotes('');
      setPFile(null);
      if (profileFileInputRef.current) {
        profileFileInputRef.current.value = '';
      }
      await onReload();
    } catch (err) {
      onError(translateApiError(err, t));
    } finally {
      setUploadingProfile(false);
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
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      {/* Left: Filaments CRUD */}
      <div className="studio-surface p-5 space-y-5 lg:col-span-7">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-[#111318] dark:text-[#F4F5F7]">
            {t.admin.filaments.filamentsTitle}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setImportPanelOpen((prev) => !prev);
                setPrusaPanelOpen(false);
              }}
              className={`${importPanelOpen ? 'btn-primary' : 'btn-secondary'} py-1.5 text-xs`}
            >
              <Upload className="h-3.5 w-3.5" />
              {t.admin.filaments.importOrcaBtn}
            </button>
            <button
              type="button"
              onClick={() => {
                setPrusaPanelOpen((prev) => !prev);
                setImportPanelOpen(false);
              }}
              className={`${prusaPanelOpen ? 'btn-primary' : 'btn-secondary'} py-1.5 text-xs`}
            >
              <Upload className="h-3.5 w-3.5" />
              {t.admin.filaments.importPrusaBtn}
            </button>
          </div>
        </div>

        {/* OrcaSlicer Filament Importer Panel */}
        {importPanelOpen && (
          <form
            onSubmit={handleImportOrcaFilaments}
            className="space-y-3 rounded-xl border border-[#00A7D9]/30 bg-[#00A7D9]/[0.04] p-4 dark:bg-[#00A7D9]/[0.07]"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="text-xs font-semibold text-[#111318] dark:text-[#F4F5F7]">
                  {t.admin.filaments.importOrcaTitle}
                </h3>
                <p className="mt-0.5 text-[11px] leading-relaxed text-[#5B616E] dark:text-[#9399A6]">
                  {t.admin.filaments.importOrcaHint}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setImportPanelOpen(false)}
                aria-label={t.common.close}
                className="btn-ghost p-1"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            <div
              onDragOver={(e) => {
                e.preventDefault();
                setOrcaDragging(true);
              }}
              onDragLeave={() => setOrcaDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setOrcaDragging(false);
                appendOrcaFiles(e.dataTransfer.files);
              }}
              className={`rounded-xl border border-dashed p-3.5 text-center transition-colors ${
                orcaDragging
                  ? 'border-[#00A7D9] bg-[#00A7D9]/10'
                  : 'border-black/15 bg-white/80 dark:border-white/15 dark:bg-[#15171C]/80'
              }`}
            >
              <label
                htmlFor="orca-filament-file-input"
                className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-[#007BA3] hover:underline dark:text-[#38C6F4]"
              >
                <Upload className="h-3.5 w-3.5" />
                <span>{t.admin.filaments.importOrcaChooseFiles}</span>
              </label>
              <input
                id="orca-filament-file-input"
                ref={orcaFileInputRef}
                type="file"
                accept=".json,.orca_filament,.zip"
                multiple
                onChange={(e) => appendOrcaFiles(e.target.files)}
                className="sr-only"
              />

              {orcaFiles.length > 0 && (
                <div className="mt-3 flex flex-wrap justify-center gap-1.5">
                  {orcaFiles.map((file, idx) => (
                    <span
                      key={`${file.name}-${idx}`}
                      className="studio-subtle inline-flex items-center gap-1.5 px-2.5 py-1 font-mono text-[11px] text-[#111318] dark:text-[#F4F5F7]"
                    >
                      <span className="max-w-[200px] truncate">{file.name}</span>
                      <button
                        type="button"
                        aria-label={`Remove ${file.name}`}
                        onClick={() =>
                          setOrcaFiles((prev) => prev.filter((_, i) => i !== idx))
                        }
                        className="rounded p-0.5 text-[#5B616E] hover:text-rose-600 dark:text-[#9399A6] dark:hover:text-rose-400"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="flex cursor-pointer items-center gap-2 text-xs text-[#111318] dark:text-[#F4F5F7]">
                <input
                  type="checkbox"
                  checked={orcaUpdateExisting}
                  onChange={(e) => setOrcaUpdateExisting(e.target.checked)}
                  className="h-4 w-4 rounded"
                />
                <span>{t.admin.filaments.importOrcaUpdateExisting}</span>
              </label>

              <button
                type="submit"
                disabled={importingOrca || orcaFiles.length === 0}
                className="btn-primary py-1.5 text-xs"
              >
                {importingOrca ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5" />
                )}
                {importingOrca
                  ? t.admin.filaments.importingOrca
                  : t.admin.filaments.importOrcaSubmit}
              </button>
            </div>

            {orcaResult && (
              <div className="space-y-2.5 rounded-xl border border-black/[0.07] bg-white p-3 text-xs dark:border-white/[0.08] dark:bg-[#15171C]">
                <div className="flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-400">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  <span>
                    {t.admin.filaments.importOrcaSummary
                      .replace('{created}', String(orcaResult.created_count))
                      .replace('{updated}', String(orcaResult.updated_count))
                      .replace('{skipped}', String(orcaResult.skipped_count))}
                  </span>
                </div>

                {orcaResult.imported.length > 0 && (
                  <div className="space-y-1.5">
                    {orcaResult.imported.map((item) => (
                      <div
                        key={`${item.filament.id}-${item.filename}`}
                        className="studio-subtle flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className="h-3.5 w-3.5 shrink-0 rounded-full border border-black/15 dark:border-white/20"
                            style={{ backgroundColor: item.filament.color_hex }}
                          />
                          <span className="truncate font-medium text-[#111318] dark:text-[#F4F5F7]">
                            {item.filament.name}
                          </span>
                          <span className="font-mono text-[11px] tabular-nums text-[#5B616E] dark:text-[#9399A6]">
                            {item.filament.material} · {item.filament.density_g_cm3} g/cm³
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="rounded-md bg-[#00A7D9]/12 px-1.5 py-0.5 text-[10px] font-medium text-[#007BA3] dark:text-[#38C6F4]">
                            {item.profile.name}
                          </span>
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                              item.action === 'created'
                                ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                                : 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
                            }`}
                          >
                            {item.action === 'created'
                              ? t.admin.filaments.importOrcaCreatedBadge
                              : t.admin.filaments.importOrcaUpdatedBadge}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {orcaResult.skipped.length > 0 && (
                  <div className="space-y-1 rounded-lg bg-rose-500/10 p-2.5 text-rose-800 dark:text-rose-300">
                    <div className="flex items-center gap-1.5 font-medium">
                      <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                      <span>{t.admin.filaments.importOrcaSkippedHeading}</span>
                    </div>
                    {orcaResult.skipped.map((sk, i) => (
                      <div key={`${sk.filename}-${i}`} className="text-[11px]">
                        <span className="font-mono">{sk.filename}</span>: {sk.reason}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </form>
        )}

        {/* PrusaSlicer (.ini / .zip) 2-Step Inspect -> Choose -> Import Panel */}
        {prusaPanelOpen && (() => {
          const q = prusaSearch.trim().toLowerCase();
          const allPreviewItems = prusaPreview?.items ?? [];
          const filteredItems = allPreviewItems.filter((item) => {
            if (!q) return true;
            return (
              item.name.toLowerCase().includes(q) ||
              (item.material?.toLowerCase().includes(q) ?? false)
            );
          });
          const prusaGroups: Array<{
            kind: ProfileKind;
            label: string;
            items: PrusaSlicerPreviewItem[];
          }> = (
            [
              {
                kind: 'filament' as const,
                label: t.admin.filaments.importPrusaFilamentsOpt,
                items: filteredItems.filter((i) => i.kind === 'filament'),
              },
              {
                kind: 'process' as const,
                label: t.admin.filaments.importPrusaProcessesOpt,
                items: filteredItems.filter((i) => i.kind === 'process'),
              },
              {
                kind: 'machine' as const,
                label: t.admin.filaments.importPrusaMachinesOpt,
                items: filteredItems.filter((i) => i.kind === 'machine'),
              },
            ] satisfies Array<{
              kind: ProfileKind;
              label: string;
              items: PrusaSlicerPreviewItem[];
            }>
          ).filter((g) => g.items.length > 0);

          return (
          <form
            onSubmit={handleImportPrusaSlicer}
            className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.04] p-4 dark:bg-amber-500/[0.07]"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="text-xs font-semibold text-[#111318] dark:text-[#F4F5F7]">
                  {t.admin.filaments.importPrusaTitle}
                </h3>
                <p className="mt-0.5 text-[11px] leading-relaxed text-[#5B616E] dark:text-[#9399A6]">
                  {t.admin.filaments.importPrusaHint}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPrusaPanelOpen(false)}
                aria-label={t.common.close}
                className="btn-ghost p-1"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* Step 1: Dropzone / File Picker (shown when no preview yet) */}
            {!prusaPreview && !prusaInspecting && (
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setPrusaDragging(true);
                }}
                onDragLeave={() => setPrusaDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setPrusaDragging(false);
                  appendPrusaFiles(e.dataTransfer.files);
                }}
                className={`rounded-xl border border-dashed p-3.5 text-center transition-colors ${
                  prusaDragging
                    ? 'border-amber-500 bg-amber-500/10'
                    : 'border-black/15 bg-white/80 dark:border-white/15 dark:bg-[#15171C]/80'
                }`}
              >
                <label
                  htmlFor="prusa-ini-file-input"
                  className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-[#007BA3] hover:underline dark:text-[#38C6F4]"
                >
                  <Upload className="h-3.5 w-3.5" />
                  <span>{t.admin.filaments.importPrusaChooseFiles}</span>
                </label>
                <input
                  id="prusa-ini-file-input"
                  ref={prusaFileInputRef}
                  type="file"
                  accept=".ini,.zip"
                  multiple
                  onChange={(e) => appendPrusaFiles(e.target.files)}
                  className="sr-only"
                />
              </div>
            )}

            {/* Inspecting loading state */}
            {prusaInspecting && (
              <div className="flex items-center justify-center gap-2 rounded-xl border border-black/[0.07] bg-white/80 py-6 text-xs text-[#5B616E] dark:border-white/[0.08] dark:bg-[#15171C]/80 dark:text-[#9399A6]">
                <Loader2 className="h-4 w-4 animate-spin text-[#00A7D9]" />
                <span>{t.admin.filaments.importPrusaInspecting}</span>
              </div>
            )}

            {/* Step 2: Interactive Checklist of Discovered Configs */}
            {prusaPreview && !prusaInspecting && (
              <div className="space-y-3 rounded-xl border border-black/[0.08] bg-white p-3.5 dark:border-white/[0.09] dark:bg-[#15171C]">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-xs font-semibold text-[#111318] dark:text-[#F4F5F7]">
                      {t.admin.filaments.importPrusaSelectHeading}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                      {prusaFiles.map((file, idx) => (
                        <span
                          key={`${file.name}-${idx}`}
                          className="studio-subtle px-2 py-0.5 font-mono text-[10px] text-[#5B616E] dark:text-[#9399A6]"
                        >
                          {file.name}
                        </span>
                      ))}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={resetPrusaSelection}
                    className="btn-ghost px-2 py-1 text-[11px]"
                  >
                    {t.admin.filaments.importPrusaChangeFilesBtn}
                  </button>
                </div>

                {/* Search + Global Select All / Clear All */}
                {allPreviewItems.length > 0 && (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="relative min-w-[200px] flex-1">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8A909E]" />
                        <input
                          type="text"
                          value={prusaSearch}
                          onChange={(e) => setPrusaSearch(e.target.value)}
                          placeholder={t.admin.filaments.importPrusaSearchPlaceholder}
                          className="studio-input py-1.5 pl-8 text-xs"
                        />
                      </div>
                      <div className="flex items-center gap-2 text-[11px]">
                        <span className="font-mono tabular-nums text-[#5B616E] dark:text-[#9399A6]">
                          {t.admin.filaments.importPrusaSelectedCount
                            .replace('{selected}', String(prusaSelectedKeys.length))
                            .replace('{total}', String(allPreviewItems.length))}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            selectPrusaKeys(
                              allPreviewItems.map((i) => i.key),
                              true
                            )
                          }
                          className="font-medium text-[#007BA3] hover:underline dark:text-[#38C6F4]"
                        >
                          {t.admin.filaments.importPrusaSelectAll}
                        </button>
                        <span className="text-[#8A909E]">·</span>
                        <button
                          type="button"
                          onClick={() => setPrusaSelectedKeys([])}
                          className="font-medium text-[#5B616E] hover:underline dark:text-[#9399A6]"
                        >
                          {t.admin.filaments.importPrusaSelectNone}
                        </button>
                      </div>
                    </div>

                    {/* Grouped Scrollable Checklists */}
                    {prusaGroups.length === 0 ? (
                      <div className="py-6 text-center text-xs text-[#5B616E] dark:text-[#9399A6]">
                        {t.admin.filaments.importPrusaNoMatches}
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {prusaGroups.map((group) => {
                          const groupKeys = group.items.map((i) => i.key);
                          const groupSelectedCount = groupKeys.filter((k) =>
                            prusaSelectedSet.has(k)
                          ).length;
                          return (
                            <div
                              key={group.kind}
                              className="overflow-hidden rounded-xl border border-black/[0.07] dark:border-white/[0.08]"
                            >
                              <div className="flex items-center justify-between gap-2 bg-[#F6F7F9] px-3 py-1.5 text-[11px] dark:bg-[#0D0E11]">
                                <div className="flex items-center gap-2 font-semibold text-[#111318] dark:text-[#F4F5F7]">
                                  <span>{group.label}</span>
                                  <span className="rounded-md bg-black/[0.06] px-1.5 py-0.5 font-mono text-[10px] font-medium tabular-nums text-[#5B616E] dark:bg-white/[0.08] dark:text-[#9399A6]">
                                    {groupSelectedCount}/{group.items.length}
                                  </span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() => selectPrusaKeys(groupKeys, true)}
                                    className="font-medium text-[#007BA3] hover:underline dark:text-[#38C6F4]"
                                  >
                                    {t.admin.filaments.importPrusaSelectAll}
                                  </button>
                                  <span className="text-[#8A909E]">·</span>
                                  <button
                                    type="button"
                                    onClick={() => selectPrusaKeys(groupKeys, false)}
                                    className="font-medium text-[#5B616E] hover:underline dark:text-[#9399A6]"
                                  >
                                    {t.admin.filaments.importPrusaSelectNone}
                                  </button>
                                </div>
                              </div>

                              <div className="max-h-56 divide-y divide-black/[0.05] overflow-y-auto dark:divide-white/[0.06]">
                                {group.items.map((item) => {
                                  const checked = prusaSelectedSet.has(item.key);
                                  return (
                                    <label
                                      key={item.key}
                                      className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-xs transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
                                    >
                                      <div className="flex min-w-0 items-center gap-2.5">
                                        <input
                                          type="checkbox"
                                          checked={checked}
                                          onChange={() => togglePrusaKey(item.key)}
                                          className="h-4 w-4 shrink-0 rounded"
                                        />
                                        {item.kind === 'filament' && (
                                          <span
                                            className="h-3.5 w-3.5 shrink-0 rounded-full border border-black/15 dark:border-white/20"
                                            style={{
                                              backgroundColor: item.color_hex || '#6B7280',
                                            }}
                                          />
                                        )}
                                        <span className="truncate font-medium text-[#111318] dark:text-[#F4F5F7]">
                                          {item.name}
                                        </span>
                                        {item.kind === 'filament' &&
                                          (item.material || item.density_g_cm3 != null) && (
                                            <span className="shrink-0 font-mono text-[11px] tabular-nums text-[#5B616E] dark:text-[#9399A6]">
                                              {[
                                                item.material,
                                                item.density_g_cm3 != null
                                                  ? `${item.density_g_cm3} g/cm³`
                                                  : null,
                                              ]
                                                .filter(Boolean)
                                                .join(' · ')}
                                            </span>
                                          )}
                                      </div>

                                      {item.already_exists && (
                                        <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                                          {t.admin.filaments.importPrusaExistsBadge}
                                        </span>
                                      )}
                                    </label>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}

                {/* Preview Skipped Files */}
                {prusaPreview.skipped.length > 0 && (
                  <div className="space-y-1 rounded-lg bg-rose-500/10 p-2.5 text-xs text-rose-800 dark:text-rose-300">
                    <div className="flex items-center gap-1.5 font-medium">
                      <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                      <span>{t.admin.filaments.importOrcaSkippedHeading}</span>
                    </div>
                    {prusaPreview.skipped.map((sk, i) => (
                      <div key={`prusa-prev-skip-${sk.filename}-${i}`} className="text-[11px]">
                        <span className="font-mono">{sk.filename}</span>: {sk.reason}
                      </div>
                    ))}
                  </div>
                )}

                {/* Update existing + Import Selected CTA */}
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-black/[0.06] pt-3 dark:border-white/[0.07]">
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-[#111318] dark:text-[#F4F5F7]">
                    <input
                      type="checkbox"
                      checked={prusaUpdateExisting}
                      onChange={(e) => setPrusaUpdateExisting(e.target.checked)}
                      className="h-4 w-4 rounded"
                    />
                    <span>{t.admin.filaments.importPrusaUpdateExisting}</span>
                  </label>

                  <button
                    type="submit"
                    disabled={importingPrusa || prusaSelectedKeys.length === 0}
                    className="btn-primary py-1.5 text-xs"
                  >
                    {importingPrusa ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Upload className="h-3.5 w-3.5" />
                    )}
                    {importingPrusa
                      ? t.admin.filaments.importingPrusa
                      : t.admin.filaments.importPrusaImportSelectedBtn.replace(
                          '{count}',
                          String(prusaSelectedKeys.length)
                        )}
                  </button>
                </div>
              </div>
            )}

            {prusaResult && (
              <div className="space-y-2.5 rounded-xl border border-black/[0.07] bg-white p-3 text-xs dark:border-white/[0.08] dark:bg-[#15171C]">
                <div className="flex items-start gap-1.5 font-medium text-emerald-700 dark:text-emerald-400">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    {t.admin.filaments.importPrusaSummary
                      .replace('{filamentsCreated}', String(prusaResult.filaments_created))
                      .replace('{filamentsUpdated}', String(prusaResult.filaments_updated))
                      .replace('{profilesCreated}', String(prusaResult.profiles_created))
                      .replace('{profilesUpdated}', String(prusaResult.profiles_updated))
                      .replace('{skipped}', String(prusaResult.skipped_count))}
                  </span>
                </div>

                {prusaResult.filaments.length > 0 && (
                  <div className="space-y-1.5">
                    {prusaResult.filaments.map((item) => (
                      <div
                        key={`prusa-fil-${item.filament.id}-${item.filename}`}
                        className="studio-subtle flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className="h-3.5 w-3.5 shrink-0 rounded-full border border-black/15 dark:border-white/20"
                            style={{ backgroundColor: item.filament.color_hex }}
                          />
                          <span className="truncate font-medium text-[#111318] dark:text-[#F4F5F7]">
                            {item.filament.name}
                          </span>
                          <span className="font-mono text-[11px] tabular-nums text-[#5B616E] dark:text-[#9399A6]">
                            {item.filament.material} · {item.filament.density_g_cm3} g/cm³
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="rounded-md bg-[#00A7D9]/12 px-1.5 py-0.5 text-[10px] font-medium text-[#007BA3] dark:text-[#38C6F4]">
                            {item.profile.name}
                          </span>
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                              item.action === 'created'
                                ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                                : 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
                            }`}
                          >
                            {item.action === 'created'
                              ? t.admin.filaments.importOrcaCreatedBadge
                              : t.admin.filaments.importOrcaUpdatedBadge}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {prusaResult.profiles.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-[11px] font-semibold text-[#5B616E] dark:text-[#9399A6]">
                      {t.admin.filaments.importPrusaProfilesHeading}
                    </div>
                    {prusaResult.profiles.map((item) => (
                      <div
                        key={`prusa-prof-${item.profile.id}-${item.filename}`}
                        className="studio-subtle flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="rounded-md bg-black/[0.06] px-1.5 py-0.5 font-mono text-[10px] uppercase text-[#5B616E] dark:bg-white/[0.08] dark:text-[#9399A6]">
                            {item.profile.kind}
                          </span>
                          <span className="truncate font-medium text-[#111318] dark:text-[#F4F5F7]">
                            {item.profile.name}
                          </span>
                        </div>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                            item.action === 'created'
                              ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                              : 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
                          }`}
                        >
                          {item.action === 'created'
                            ? t.admin.filaments.importOrcaCreatedBadge
                            : t.admin.filaments.importOrcaUpdatedBadge}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {prusaResult.skipped.length > 0 && (
                  <div className="space-y-1 rounded-lg bg-rose-500/10 p-2.5 text-rose-800 dark:text-rose-300">
                    <div className="flex items-center gap-1.5 font-medium">
                      <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                      <span>{t.admin.filaments.importOrcaSkippedHeading}</span>
                    </div>
                    {prusaResult.skipped.map((sk, i) => (
                      <div key={`prusa-skip-${sk.filename}-${i}`} className="text-[11px]">
                        <span className="font-mono">{sk.filename}</span>: {sk.reason}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </form>
          );
        })()}

        <form onSubmit={handleAddFilament} className="studio-subtle grid grid-cols-1 gap-2.5 p-3.5 sm:grid-cols-6">
          <div className="sm:col-span-3">
            <label className="mb-1 block text-[11px] font-medium text-[#5B616E] dark:text-[#9399A6]">
              {t.admin.filaments.name}
            </label>
            <input
              type="text"
              value={fName}
              onChange={(e) => setFName(e.target.value)}
              placeholder="PLA Bleu GG"
              className="studio-input py-1.5 text-xs"
              required
            />
          </div>
          <div className="sm:col-span-2">
            <label className="mb-1 block text-[11px] font-medium text-[#5B616E] dark:text-[#9399A6]">
              {t.admin.filaments.material}
            </label>
            <input
              type="text"
              value={fMaterial}
              onChange={(e) => setFMaterial(e.target.value)}
              className="studio-input py-1.5 text-xs"
              required
            />
          </div>
          <div className="sm:col-span-1">
            <label className="mb-1 block text-[11px] font-medium text-[#5B616E] dark:text-[#9399A6]">
              {t.admin.filaments.color}
            </label>
            <input
              type="color"
              value={fColor}
              onChange={(e) => setFColor(e.target.value)}
              className="h-8 w-full cursor-pointer rounded-lg border border-black/[0.1] bg-transparent dark:border-white/[0.1]"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="mb-1 block text-[11px] font-medium text-[#5B616E] dark:text-[#9399A6]">
              {t.admin.filaments.density}
            </label>
            <input
              type="number"
              step="0.01"
              value={fDensity}
              onChange={(e) => setFDensity(e.target.value)}
              className="studio-input py-1.5 font-mono text-xs tabular-nums"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="mb-1 block text-[11px] font-medium text-[#5B616E] dark:text-[#9399A6]">
              {t.admin.filaments.filamentProfile}
            </label>
            <select
              value={fProfileId}
              onChange={(e) => setFProfileId(e.target.value)}
              className="studio-input py-1.5 text-xs"
            >
              <option value="">{t.common.none}</option>
              {filamentProfiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2">
            <label className="mb-1 block text-[11px] font-medium text-[#5B616E] dark:text-[#9399A6]">
              {t.admin.filaments.processOverride}
            </label>
            <select
              value={fProcessOverrideId}
              onChange={(e) => setFProcessOverrideId(e.target.value)}
              className="studio-input py-1.5 text-xs"
            >
              <option value="">{t.common.none}</option>
              {processProfiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-6 flex justify-end pt-1">
            <button type="submit" disabled={savingFilament} className="btn-primary py-1.5 text-xs">
              <Plus className="h-3.5 w-3.5" />
              {t.admin.filaments.addFilament}
            </button>
          </div>
        </form>

        <div className="divide-y divide-black/[0.06] dark:divide-white/[0.07]">
          {filaments.map((fil) => {
            const isEditing = editingId === fil.id && editDraft != null;
            if (isEditing && editDraft) {
              return (
                <div key={fil.id} className="grid grid-cols-1 gap-2 py-3 sm:grid-cols-6">
                  <input
                    type="text"
                    value={editDraft.name}
                    onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })}
                    className="studio-input py-1 text-xs sm:col-span-2"
                  />
                  <input
                    type="text"
                    value={editDraft.material}
                    onChange={(e) => setEditDraft({ ...editDraft, material: e.target.value })}
                    className="studio-input py-1 text-xs"
                  />
                  <input
                    type="color"
                    value={editDraft.color_hex}
                    onChange={(e) => setEditDraft({ ...editDraft, color_hex: e.target.value })}
                    className="h-7 w-full cursor-pointer rounded border border-black/[0.1] bg-transparent dark:border-white/[0.1]"
                  />
                  <input
                    type="number"
                    step="0.01"
                    value={editDraft.density_g_cm3}
                    onChange={(e) =>
                      setEditDraft({ ...editDraft, density_g_cm3: e.target.value })
                    }
                    className="studio-input py-1 font-mono text-xs tabular-nums"
                  />
                  <div className="flex items-center justify-end gap-1">
                    <button
                      type="button"
                      onClick={() => handleSaveEdit(fil.id)}
                      className="rounded-lg bg-[#00A7D9] p-1.5 text-white hover:bg-[#0090BD]"
                      title={t.common.save}
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(null);
                        setEditDraft(null);
                      }}
                      className="btn-ghost p-1.5"
                      title={t.common.cancel}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <select
                    value={editDraft.filament_profile_id}
                    onChange={(e) =>
                      setEditDraft({ ...editDraft, filament_profile_id: e.target.value })
                    }
                    className="studio-input py-1 text-xs sm:col-span-3"
                  >
                    <option value="">
                      {t.admin.filaments.filamentProfile}: {t.common.none}
                    </option>
                    {filamentProfiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <select
                    value={editDraft.process_override_profile_id}
                    onChange={(e) =>
                      setEditDraft({
                        ...editDraft,
                        process_override_profile_id: e.target.value,
                      })
                    }
                    className="studio-input py-1 text-xs sm:col-span-3"
                  >
                    <option value="">
                      {t.admin.filaments.processOverride}: {t.common.none}
                    </option>
                    {processProfiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
              );
            }

            return (
              <div key={fil.id} className="flex items-center justify-between gap-3 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span
                    className="h-5 w-5 shrink-0 rounded-full border border-black/15 dark:border-white/20"
                    style={{ backgroundColor: fil.color_hex }}
                  />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-sm font-medium text-[#111318] dark:text-[#F4F5F7]">
                        {fil.name}
                      </span>
                      {fil.filament_profile_id != null &&
                        profileById.get(fil.filament_profile_id) && (
                          <span className="rounded-md bg-[#00A7D9]/12 px-1.5 py-0.5 text-[10px] font-medium text-[#007BA3] dark:text-[#38C6F4]">
                            {profileById.get(fil.filament_profile_id)?.name}
                          </span>
                        )}
                    </div>
                    <div className="font-mono text-[11px] tabular-nums text-[#5B616E] dark:text-[#9399A6]">
                      {fil.material} · {fil.density_g_cm3} g/cm³ · {fil.color_hex}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => startEdit(fil)}
                    className="btn-ghost p-1.5"
                    title={t.common.edit}
                  >
                    <Edit3 className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteFilament(fil.id)}
                    className="btn-ghost p-1.5 hover:text-rose-600 dark:hover:text-rose-400"
                    title={t.common.delete}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Right: OrcaSlicer JSON Profiles */}
      <div className="studio-surface p-5 space-y-5 lg:col-span-5">
        <h2 className="text-base font-semibold text-[#111318] dark:text-[#F4F5F7]">
          {t.admin.filaments.profilesTitle}
        </h2>

        <form onSubmit={handleUploadProfile} className="studio-subtle space-y-3 p-3.5">
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
              ref={profileFileInputRef}
              type="file"
              accept=".json"
              onChange={(e) => handleProfileFileSelect(e.target.files?.[0] ?? null)}
              className="block w-full text-xs text-[#5B616E] file:mr-3 file:rounded-lg file:border-0 file:bg-[#00A7D9]/15 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-[#007BA3] dark:text-[#9399A6] dark:file:text-[#38C6F4]"
              required
            />
          </div>
          <button
            type="submit"
            disabled={uploadingProfile || !pFile}
            className="btn-primary w-full py-1.5 text-xs"
          >
            <Upload className="h-3.5 w-3.5" />
            {t.admin.filaments.uploadProfile}
          </button>
        </form>

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
  );
}
