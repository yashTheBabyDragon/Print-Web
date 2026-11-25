import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../../api/client';
import { I18nProvider } from '../../../i18n';
import type { SystemSettings } from '../../../types/api';
import { AdminSettingsTab } from '../AdminSettingsTab';

const BASE_SETTINGS: SystemSettings = {
  default_max_active_grams: 100,
  enforce_duration_limit: true,
  default_max_print_minutes: 360,
  allow_multiple_jobs_within_budget: true,
  max_upload_mb: 50,
  fdm_monster_mode: 'mock',
  fdm_monster_url: 'http://fdm-monster:4000',
  fdm_monster_api_key: '',
  slicer_mode: 'mock',
  orca_cli_path: 'orca-slicer',
  filament_api_enabled: false,
  filament_api_url: 'http://filament-api:8000',
};

describe('AdminSettingsTab', () => {
  beforeEach(() => {
    localStorage.setItem('ggprint_lang', 'en');
    vi.restoreAllMocks();
    vi.spyOn(api, 'adminGetUpdateStatus').mockResolvedValue({
      current_version: '1.0.0',
      latest_version: '1.0.0',
      update_available: false,
      release_url: 'https://github.com/yashTheBabyDragon/GGPrint-Web/releases/tag/v1.0.0',
      checked_at: '2026-01-01T00:00:00Z',
      repo: 'yashTheBabyDragon/GGPrint-Web',
      error: null,
    });
  });

  it('toggles FilamentAPI settings, updates URL, and saves', async () => {
    const user = userEvent.setup();
    const updateSpy = vi
      .spyOn(api, 'adminUpdateSettings')
      .mockResolvedValue({
        ...BASE_SETTINGS,
        filament_api_enabled: true,
        filament_api_url: 'http://192.168.4.50:8000',
      });
    const onReload = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();

    render(
      <I18nProvider>
        <AdminSettingsTab settings={BASE_SETTINGS} onReload={onReload} onError={onError} />
      </I18nProvider>
    );

    const toggle = screen.getByLabelText(/Enable automatic filament switching/i);
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    expect(toggle).toBeChecked();

    const urlInput = screen.getByPlaceholderText('http://filament-api:8000');
    await user.clear(urlInput);
    await user.type(urlInput, 'http://192.168.4.50:8000');

    await user.click(screen.getByRole('button', { name: /Save settings/i }));

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          filament_api_enabled: true,
          filament_api_url: 'http://192.168.4.50:8000',
        })
      );
    });
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('tests FilamentAPI connection and displays discovered printers or failure', async () => {
    const user = userEvent.setup();
    const testSpy = vi.spyOn(api, 'adminTestFilamentApi').mockResolvedValueOnce({
      ok: true,
      status: 'ok',
      printers_configured: 2,
      uptime_seconds: 12.3,
      printers: [
        { id: 'klip', type: 'klipper', host: 'http://pi-klipper2.local' },
        { id: 'prusa-plahf0-4', type: 'prusalink', host: 'http://192.168.4.232' },
      ],
    });

    render(
      <I18nProvider>
        <AdminSettingsTab
          settings={BASE_SETTINGS}
          onReload={vi.fn().mockResolvedValue(undefined)}
          onError={vi.fn()}
        />
      </I18nProvider>
    );

    await user.click(screen.getByRole('button', { name: /Test connection/i }));

    await waitFor(() => {
      expect(testSpy).toHaveBeenCalledWith('http://filament-api:8000');
    });
    expect(await screen.findByText(/Connected · 2 printer\(s\) configured/i)).toBeInTheDocument();
    expect(screen.getByText('klip (klipper)')).toBeInTheDocument();
    expect(screen.getByText('prusa-plahf0-4 (prusalink)')).toBeInTheDocument();

    testSpy.mockResolvedValueOnce({
      ok: false,
      status: 'error',
      printers_configured: 0,
      printers: [],
      error: 'Connection refused',
    });

    await user.click(screen.getByRole('button', { name: /Test connection/i }));
    expect(await screen.findByText(/Connection failed: Connection refused/i)).toBeInTheDocument();
  });

  it('displays software version status and forces an update check on button click', async () => {
    const user = userEvent.setup();
    const updateStatusSpy = vi
      .spyOn(api, 'adminGetUpdateStatus')
      .mockResolvedValueOnce({
        current_version: '1.0.0',
        latest_version: '1.0.0',
        update_available: false,
        release_url: 'https://github.com/yashTheBabyDragon/GGPrint-Web/releases/tag/v1.0.0',
        checked_at: '2026-01-01T00:00:00Z',
        repo: 'yashTheBabyDragon/GGPrint-Web',
        error: null,
      })
      .mockResolvedValueOnce({
        current_version: '1.0.0',
        latest_version: '1.2.0',
        update_available: true,
        release_url: 'https://github.com/yashTheBabyDragon/GGPrint-Web/releases/tag/v1.2.0',
        checked_at: '2026-01-01T00:05:00Z',
        repo: 'yashTheBabyDragon/GGPrint-Web',
        error: null,
      });

    render(
      <I18nProvider>
        <AdminSettingsTab
          settings={BASE_SETTINGS}
          onReload={vi.fn().mockResolvedValue(undefined)}
          onError={vi.fn()}
        />
      </I18nProvider>
    );

    expect(await screen.findByText('Up to date')).toBeInTheDocument();
    expect(
      screen.getByText('sudo /opt/ggprint/deploy/update-from-release.sh')
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Check for updates/i }));

    await waitFor(() => {
      expect(updateStatusSpy).toHaveBeenLastCalledWith(true);
    });
    expect(await screen.findByText('Update available')).toBeInTheDocument();
    expect(screen.getByText('v1.2.0')).toBeInTheDocument();
  });

  it('refuses to render unsafe or non-GitHub release_url links', async () => {
    vi.spyOn(api, 'adminGetUpdateStatus').mockResolvedValueOnce({
      current_version: '1.0.0',
      latest_version: '1.2.0',
      update_available: true,
      release_url: 'javascript:alert(1)',
      checked_at: '2026-01-01T00:00:00Z',
      repo: 'yashTheBabyDragon/GGPrint-Web',
      error: null,
    });

    render(
      <I18nProvider>
        <AdminSettingsTab
          settings={BASE_SETTINGS}
          onReload={vi.fn().mockResolvedValue(undefined)}
          onError={vi.fn()}
        />
      </I18nProvider>
    );

    expect(await screen.findByText('Update available')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /View release on GitHub/i })).not.toBeInTheDocument();
  });

  it('triggers on-demand update after confirmation and renders updates-only mode when canManageSettings=false', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'adminGetUpdateStatus').mockResolvedValue({
      current_version: '1.0.0',
      latest_version: '1.3.0',
      update_available: true,
      release_url: 'https://github.com/yashTheBabyDragon/GGPrint-Web/releases/tag/v1.3.0',
      checked_at: '2026-01-01T00:00:00Z',
      repo: 'yashTheBabyDragon/GGPrint-Web',
      error: null,
      updater_configured: true,
      update_job: null,
    });
    const triggerSpy = vi.spyOn(api, 'adminTriggerUpdate').mockResolvedValue({
      state: 'queued',
      target_version: '1.3.0',
      requested_by: 'admin',
    });

    render(
      <I18nProvider>
        <AdminSettingsTab
          settings={null}
          canManageSettings={false}
          canManageUpdates={true}
          onReload={vi.fn().mockResolvedValue(undefined)}
          onError={vi.fn()}
        />
      </I18nProvider>
    );

    // Updates-only mode: no system settings form, Update button visible
    expect(screen.queryByRole('button', { name: /Save settings/i })).not.toBeInTheDocument();
    const updateBtn = await screen.findByRole('button', { name: /Update to v1\.3\.0/i });
    await user.click(updateBtn);

    // Confirm inline prompt
    await user.click(screen.getByRole('button', { name: /^Confirm$/i }));

    await waitFor(() => {
      expect(triggerSpy).toHaveBeenCalledWith('1.3.0');
    });
    expect(await screen.findByText(/Update to 1\.3\.0 queued/i)).toBeInTheDocument();
  });

  it('hides mock mode options when not in dev mode', () => {
    render(
      <I18nProvider>
        <AdminSettingsTab
          settings={BASE_SETTINGS}
          isDevMode={false}
          onReload={vi.fn().mockResolvedValue(undefined)}
          onError={vi.fn()}
        />
      </I18nProvider>
    );

    expect(screen.queryByRole('option', { name: /Mock/i })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /OrcaSlicer/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Live/i })).toBeInTheDocument();
  });
});
