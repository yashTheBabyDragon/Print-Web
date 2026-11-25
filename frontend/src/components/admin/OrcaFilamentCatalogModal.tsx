import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Loader2, Search, Sparkles, X } from 'lucide-react';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import type {
  OrcaCatalogVendorDetail,
  OrcaCatalogVendorSummary,
} from '../../types/api';
import { translateApiError } from '../../utils/errors';

interface OrcaFilamentCatalogModalProps {
  open: boolean;
  onClose: () => void;
  onCompleted: () => Promise<void>;
  onError: (msg: string) => void;
}

const MAT_TABS = ['ALL', 'PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'PA', 'PC'] as const;

export function OrcaFilamentCatalogModal({
  open,
  onClose,
  onCompleted,
  onError,
}: OrcaFilamentCatalogModalProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const pressedOutsideRef = useRef(false);

  const [vendors, setVendors] = useState<OrcaCatalogVendorSummary[]>([]);
  const [selectedVendor, setSelectedVendor] = useState('OrcaFilamentLibrary');
  const [detail, setDetail] = useState<OrcaCatalogVendorDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [search, setSearch] = useState('');
  const [material, setMaterial] = useState<string>('ALL');
  const [selectedPresets, setSelectedPresets] = useState<string[]>([]);

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

  useEffect(() => {
    if (!open) return;
    let active = true;
    api
      .adminGetOrcaCatalogVendors()
      .then((list) => {
        if (!active) return;
        const withFils = list.filter((v) => v.filament_count > 0);
        setVendors(withFils);
        if (!withFils.some((v) => v.id === selectedVendor) && withFils.length > 0) {
          setSelectedVendor(withFils[0].id);
        }
      })
      .catch((err) => {
        if (active) onError(translateApiError(err, t));
      });
    return () => {
      active = false;
    };
  }, [open, onError, selectedVendor, t]);

  useEffect(() => {
    if (!open || !selectedVendor) return;
    let active = true;
    setLoading(true);
    setSelectedPresets([]);
    api
      .adminGetOrcaCatalogVendorDetail(selectedVendor)
      .then((d) => {
        if (active) setDetail(d);
      })
      .catch((err) => {
        if (active) onError(translateApiError(err, t));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, selectedVendor, onError, t]);

  const filteredFilaments = useMemo(() => {
    if (!detail) return [];
    const q = search.trim().toLowerCase();
    return detail.filaments.filter((f) => {
      if (material !== 'ALL' && !f.material.toUpperCase().includes(material)) return false;
      if (q && !f.name.toLowerCase().includes(q) && !f.material.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [detail, search, material]);

  const togglePreset = (name: string) => {
    setSelectedPresets((prev) =>
      prev.includes(name) ? prev.filter((p) => p !== name) : [...prev, name]
    );
  };

  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedPresets.length === 0 || !selectedVendor) return;
    setImporting(true);
    try {
      await api.adminImportOrcaCatalogFilaments({
        vendor: selectedVendor,
        preset_names: selectedPresets,
        update_existing: true,
      });
      await onCompleted();
      onClose();
    } catch (err) {
      onError(translateApiError(err, t));
    } finally {
      setImporting(false);
    }
  };

  if (!open) return null;

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
      className="studio-surface m-auto max-h-[88dvh] w-[min(100%-1.5rem,720px)] overflow-hidden p-0 text-[#111318] backdrop:bg-black/55 dark:text-[#F4F5F7]"
    >
      <form onSubmit={handleImport} className="flex max-h-[88dvh] flex-col">
        <div className="flex items-start justify-between gap-3 border-b border-black/[0.07] px-5 py-4 dark:border-white/[0.08]">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <Sparkles className="h-4 w-4 text-[#00A7D9]" />
              {t.admin.filaments.catalogTitle}
            </h2>
            <p className="mt-0.5 text-xs text-[#5B616E] dark:text-[#9399A6]">
              {t.admin.filaments.catalogDesc}
            </p>
          </div>
          <button type="button" onClick={onClose} className="btn-ghost p-1.5" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 border-b border-black/[0.07] px-5 py-3 dark:border-white/[0.08]">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-[11px] font-medium text-[#5B616E] dark:text-[#9399A6]">
                {t.admin.filaments.catalogVendorLabel}
              </label>
              <select
                value={selectedVendor}
                onChange={(e) => setSelectedVendor(e.target.value)}
                className="studio-input py-1.5 text-xs"
              >
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} ({v.filament_count})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-medium text-[#5B616E] dark:text-[#9399A6]">
                {t.admin.filaments.catalogSearchPlaceholder}
              </label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8A909E]" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t.admin.filaments.catalogSearchPlaceholder}
                  className="studio-input py-1.5 pl-8 text-xs"
                />
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1">
              {MAT_TABS.map((mat) => (
                <button
                  key={mat}
                  type="button"
                  onClick={() => setMaterial(mat)}
                  className={`rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors ${
                    material === mat
                      ? 'bg-[#00A7D9] text-white'
                      : 'bg-black/[0.05] text-[#5B616E] dark:bg-white/[0.08] dark:text-[#9399A6]'
                  }`}
                >
                  {mat === 'ALL' ? t.admin.filaments.catalogMaterialAll : mat}
                </button>
              ))}
            </div>
            <span className="font-mono text-xs text-[#5B616E] dark:text-[#9399A6]">
              {t.admin.filaments.catalogSelectCount.replace('{count}', String(selectedPresets.length))}
            </span>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-xs text-[#5B616E]">
              <Loader2 className="mr-2 h-4 w-4 animate-spin text-[#00A7D9]" />
              {t.common.loading}
            </div>
          ) : filteredFilaments.length === 0 ? (
            <div className="py-10 text-center text-xs text-[#5B616E] dark:text-[#9399A6]">
              {t.admin.filaments.catalogEmpty}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {filteredFilaments.slice(0, 200).map((f) => {
                const checked = selectedPresets.includes(f.preset_name);
                return (
                  <label
                    key={f.preset_name}
                    className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors ${
                      checked
                        ? 'border-[#00A7D9]/50 bg-[#00A7D9]/10'
                        : 'border-black/[0.07] bg-white/60 hover:bg-black/[0.03] dark:border-white/[0.08] dark:bg-[#15171C]'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => togglePreset(f.preset_name)}
                      className="h-3.5 w-3.5 rounded accent-[#00A7D9]"
                    />
                    <span
                      className="h-3.5 w-3.5 shrink-0 rounded-full border border-black/15 dark:border-white/20"
                      style={{ backgroundColor: f.color_hex }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{f.name}</div>
                      <div className="font-mono text-[10px] text-[#5B616E] dark:text-[#9399A6]">
                        {f.material} · {f.density_g_cm3} g/cm³
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-black/[0.07] px-5 py-3.5 dark:border-white/[0.08]">
          <button type="button" onClick={onClose} className="btn-secondary py-1.5 text-xs">
            {t.common.cancel}
          </button>
          <button
            type="submit"
            disabled={importing || selectedPresets.length === 0}
            className="btn-primary py-1.5 text-xs"
          >
            {importing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            {importing
              ? t.admin.filaments.catalogImporting
              : t.admin.filaments.catalogImportBtn.replace('{count}', String(selectedPresets.length))}
          </button>
        </div>
      </form>
    </dialog>
  );
}
