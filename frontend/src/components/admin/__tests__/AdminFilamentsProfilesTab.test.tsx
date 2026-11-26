import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../../api/client';
import { I18nProvider } from '../../../i18n';
import type { Filament, OrcaProfile } from '../../../types/api';
import { AdminFilamentsProfilesTab } from '../AdminFilamentsProfilesTab';

const MOCK_FILAMENTS: Filament[] = [
  {
    id: 1,
    name: 'PLA Bleu',
    material: 'PLA',
    color_hex: '#00A7D9',
    density_g_cm3: 1.24,
    filament_profile_id: null,
    process_override_profile_id: null,
  },
];

const MOCK_PROFILES: OrcaProfile[] = [];

describe('AdminFilamentsProfilesTab (OrcaSlicer Filament Import)', () => {
  beforeEach(() => {
    localStorage.setItem('printweb_lang', 'en');
    vi.restoreAllMocks();
  });

  it('opens OrcaSlicer importer, uploads a filament JSON, renders summary, and reloads', async () => {
    const user = userEvent.setup();
    const importSpy = vi.spyOn(api, 'adminImportOrcaFilaments').mockResolvedValue({
      imported: [
        {
          filament: {
            id: 2,
            name: 'Bambu PETG Translucent',
            material: 'PETG',
            color_hex: '#22C55E',
            density_g_cm3: 1.27,
            filament_profile_id: 10,
            process_override_profile_id: null,
          },
          profile: {
            id: 10,
            name: 'Bambu PETG Translucent',
            kind: 'filament',
            filename: 'bambu_petg.json',
          },
          action: 'created',
          filename: 'bambu_petg.json',
        },
      ],
      skipped: [],
      created_count: 1,
      updated_count: 0,
      skipped_count: 0,
    });
    const onReload = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();

    render(
      <I18nProvider>
        <AdminFilamentsProfilesTab
          filaments={MOCK_FILAMENTS}
          profiles={MOCK_PROFILES}
          onReload={onReload}
          onError={onError}
        />
      </I18nProvider>
    );

    await user.click(screen.getByRole('button', { name: /Import OrcaSlicer Filament/i }));

    const fileInput = screen.getByLabelText(/Choose files/i);
    const file = new File(
      [
        JSON.stringify({
          type: 'filament',
          name: 'Bambu PETG Translucent',
          filament_type: ['PETG'],
          filament_density: ['1.27'],
          default_filament_colour: ['#22C55E'],
        }),
      ],
      'bambu_petg.json',
      { type: 'application/json' }
    );
    await user.upload(fileInput, file);

    expect(screen.getByText('bambu_petg.json')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Import filaments/i }));

    await waitFor(() => {
      expect(importSpy).toHaveBeenCalledWith([file], { update_existing: true });
    });
    expect(await screen.findByText(/1 created, 0 updated, 0 skipped/i)).toBeInTheDocument();
    expect(screen.getAllByText('Bambu PETG Translucent').length).toBeGreaterThan(0);
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('inspects a PrusaSlicer (.ini) bundle, lets user uncheck items, and imports only selected_keys', async () => {
    const user = userEvent.setup();
    const previewSpy = vi.spyOn(api, 'adminPreviewPrusaSlicer').mockResolvedValue({
      items: [
        {
          key: 'filament::Prusa QA PLA',
          kind: 'filament',
          name: 'Prusa QA PLA',
          filename: 'bundle.ini',
          already_exists: false,
          material: 'PLA',
          density_g_cm3: 1.24,
          color_hex: '#FF6B00',
        },
        {
          key: 'process::0.20mm QA SPEED',
          kind: 'process',
          name: '0.20mm QA SPEED',
          filename: 'bundle.ini',
          already_exists: false,
        },
        {
          key: 'machine::Prusa MK4 QA',
          kind: 'machine',
          name: 'Prusa MK4 QA',
          filename: 'bundle.ini',
          already_exists: true,
        },
      ],
      skipped: [],
      filament_count: 1,
      process_count: 1,
      machine_count: 1,
      skipped_count: 0,
    });
    const prusaSpy = vi.spyOn(api, 'adminImportPrusaSlicer').mockResolvedValue({
      filaments: [
        {
          filament: {
            id: 3,
            name: 'Prusa QA PLA',
            material: 'PLA',
            color_hex: '#FF6B00',
            density_g_cm3: 1.24,
            filament_profile_id: 21,
            process_override_profile_id: null,
          },
          profile: {
            id: 21,
            name: 'Prusa QA PLA',
            kind: 'filament',
            filename: 'prusa_qa_pla.json',
          },
          action: 'created',
          filename: 'bundle.ini',
        },
      ],
      profiles: [
        {
          profile: {
            id: 22,
            name: '0.20mm QA SPEED',
            kind: 'process',
            filename: '0_20mm_qa_speed.json',
          },
          action: 'created',
          filename: 'bundle.ini',
        },
      ],
      skipped: [],
      filaments_created: 1,
      filaments_updated: 0,
      profiles_created: 1,
      profiles_updated: 0,
      skipped_count: 0,
    });
    const onReload = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();

    render(
      <I18nProvider>
        <AdminFilamentsProfilesTab
          filaments={MOCK_FILAMENTS}
          profiles={MOCK_PROFILES}
          onReload={onReload}
          onError={onError}
        />
      </I18nProvider>
    );

    await user.click(screen.getByRole('button', { name: /Import PrusaSlicer/i }));

    const fileInput = screen.getByLabelText(/Choose files \(\.ini, \.zip\)/i);
    const iniFile = new File(
      [
        '[filament:Prusa QA PLA]\nfilament_type = PLA\n[print:0.20mm QA SPEED]\nlayer_height = 0.2\n[printer:Prusa MK4 QA]\nnozzle_diameter = 0.4\n',
      ],
      'bundle.ini',
      { type: 'text/plain' }
    );
    await user.upload(fileInput, iniFile);

    await waitFor(() => {
      expect(previewSpy).toHaveBeenCalledWith([iniFile]);
    });

    // Checklist renders all 3 items with Exists badge on Prusa MK4 QA
    expect(await screen.findByText('Choose which configs to import')).toBeInTheDocument();
    expect(screen.getByText('Exists')).toBeInTheDocument();

    // Uncheck Prusa MK4 QA
    const mk4Checkbox = screen.getByLabelText(/Prusa MK4 QA/i);
    expect(mk4Checkbox).toBeChecked();
    await user.click(mk4Checkbox);
    expect(mk4Checkbox).not.toBeChecked();

    // Submit imports only the 2 selected keys
    await user.click(screen.getByRole('button', { name: /Import 2 selected/i }));

    await waitFor(() => {
      expect(prusaSpy).toHaveBeenCalledWith([iniFile], {
        selected_keys: ['filament::Prusa QA PLA', 'process::0.20mm QA SPEED'],
        update_existing: true,
      });
    });
    expect(
      await screen.findByText(/Filaments: 1 created, 0 updated · Profiles: 1 created, 0 updated/i)
    ).toBeInTheDocument();
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });
});
