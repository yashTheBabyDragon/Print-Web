import React, { useRef, useState } from 'react';
import { Check, Edit3, FileCode2, Plus, Trash2, Upload, X } from 'lucide-react';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import type { Filament, OrcaProfile, ProfileKind } from '../../types/api';
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

  const filamentProfiles = profiles.filter((p) => p.kind === 'filament');
  const processProfiles = profiles.filter((p) => p.kind === 'process');

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
        <h2 className="text-base font-semibold text-[#111318] dark:text-[#F4F5F7]">
          {t.admin.filaments.filamentsTitle}
        </h2>

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
                    <div className="truncate text-sm font-medium text-[#111318] dark:text-[#F4F5F7]">
                      {fil.name}
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
