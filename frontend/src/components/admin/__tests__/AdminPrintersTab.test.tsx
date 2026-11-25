import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../../api/client';
import { I18nProvider } from '../../../i18n';
import type { AdminPrinter, Filament, FilamentApiPrinter, OrcaProfile } from '../../../types/api';
import { AdminPrintersTab } from '../AdminPrintersTab';

const MOCK_PRINTERS: AdminPrinter[] = [
  {
    id: 1,
    name: 'Prusa MK3.5',
    display_name: 'Prusa MK3.5',
    fdm_monster_id: 'prusalink-mk35-1',
    printer_type: 'prusalink',
    status: 'idle',
    queue_count: 0,
    is_enabled: true,
    bed_x_mm: 250,
    bed_y_mm: 210,
    bed_z_mm: 210,
    mmu_slots_count: 1,
    has_mmu: false,
    machine_profile_id: null,
    process_profile_id: null,
    filament_api_printer_id: null,
    slots: [
      {
        id: 10,
        slot_index: 1,
        label: 'Extrudeur Simple',
        filament_id: 1,
        filament_name: 'PLA Bleu',
        material: 'PLA',
        color_hex: '#00A7D9',
        is_loaded: true,
      },
    ],
  },
];

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
  {
    id: 2,
    name: 'PETG Orange',
    material: 'PETG',
    color_hex: '#F97316',
    density_g_cm3: 1.27,
    filament_profile_id: null,
    process_override_profile_id: null,
  },
];

const MOCK_PROFILES: OrcaProfile[] = [];

const MOCK_FILAMENT_API_PRINTERS: FilamentApiPrinter[] = [
  { id: 'prusa-plahf0-4', type: 'prusalink', host: 'http://192.168.4.232' },
];

describe('AdminPrintersTab', () => {
  beforeEach(() => {
    localStorage.setItem('ggprint_lang', 'en');
    vi.restoreAllMocks();
  });

  it('saves mapped FilamentAPI printer ID and triggers manual filament sync', async () => {
    const user = userEvent.setup();
    const updatePrinterSpy = vi
      .spyOn(api, 'adminUpdatePrinter')
      .mockResolvedValue({ ...MOCK_PRINTERS[0], filament_api_printer_id: 'prusa-plahf0-4' });
    const syncFilamentsSpy = vi.spyOn(api, 'adminSyncPrinterFilaments').mockResolvedValue({
      synced_count: 1,
      changed_count: 1,
      results: [
        {
          printer_id: 1,
          printer_name: 'Prusa MK3.5',
          filament_api_printer_id: 'prusa-plahf0-4',
          detected_filament: 'PETG',
          matched_filament_id: 2,
          matched_filament_name: 'PETG Orange',
          changed: true,
          status: 'updated',
        },
      ],
    });
    const onReload = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();

    render(
      <I18nProvider>
        <AdminPrintersTab
          printers={MOCK_PRINTERS}
          filaments={MOCK_FILAMENTS}
          profiles={MOCK_PROFILES}
          filamentApiEnabled={true}
          filamentApiPrinters={MOCK_FILAMENT_API_PRINTERS}
          onReload={onReload}
          onError={onError}
        />
      </I18nProvider>
    );

    const apiIdInput = screen.getByPlaceholderText(/e\.g\. klip or prusa-plahf0-4/i);
    await user.type(apiIdInput, 'prusa-plahf0-4');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      expect(updatePrinterSpy).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ filament_api_printer_id: 'prusa-plahf0-4' })
      );
    });

    await user.click(screen.getByRole('button', { name: /Sync filaments/i }));

    await waitFor(() => {
      expect(syncFilamentsSpy).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByText(/1 printer\(s\) checked · 1 updated/i)).toBeInTheDocument();
    expect(onReload).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it('opens Add Printer modal in manual mode and switches to OrcaSlicer Profiles sub-tab', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'adminGetOrcaCatalogVendors').mockResolvedValue([]);
    vi.spyOn(api, 'adminCreatePrinter').mockResolvedValue({
      ...MOCK_PRINTERS[0],
      id: 2,
      name: 'Standalone Voron',
      display_name: 'Standalone Voron',
      fdm_monster_id: 'manual-standalone-voron',
      printer_type: 'klipper',
      is_manual: true,
      is_fdm_linked: false,
      bed_x_mm: 300,
      bed_y_mm: 300,
      bed_z_mm: 300,
    });
    const onReload = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();

    render(
      <I18nProvider>
        <AdminPrintersTab
          printers={MOCK_PRINTERS}
          filaments={MOCK_FILAMENTS}
          profiles={MOCK_PROFILES}
          filamentApiEnabled={false}
          filamentApiPrinters={[]}
          onReload={onReload}
          onError={onError}
        />
      </I18nProvider>
    );

    await user.click(screen.getByRole('tab', { name: /OrcaSlicer Profiles/i }));
    expect(screen.getByRole('button', { name: /Import profile/i })).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /Printers & MMU/i }));
    await user.click(screen.getByRole('button', { name: /Add printer/i }));

    await user.click(await screen.findByRole('button', { name: /Manual \/ JSON Files/i }));
    await user.type(screen.getByPlaceholderText(/Prusa MK4S Lab #1/i), 'Standalone Voron');
    await user.click(screen.getByRole('button', { name: /Create Printer/i }));

    await waitFor(() => {
      expect(api.adminCreatePrinter).toHaveBeenCalledWith(
        expect.objectContaining({
          display_name: 'Standalone Voron',
          fdm_monster_id: null,
        })
      );
    });
    expect(onReload).toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
