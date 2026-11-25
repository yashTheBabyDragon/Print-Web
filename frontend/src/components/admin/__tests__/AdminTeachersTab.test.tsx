import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../../api/client';
import { I18nProvider } from '../../../i18n';
import type { AdminTeacher, UserSummary } from '../../../types/api';
import { AdminTeachersTab } from '../AdminTeachersTab';
import { FALLBACK_PERMISSION_CATALOG } from '../AccountConfigurator';

const MOCK_ACCOUNTS: AdminTeacher[] = [
  {
    id: 1,
    da: 'admin',
    name: 'Admin FabLab',
    role: 'admin',
    hierarchy_rank: 100,
    can_manage: false,
    is_active: true,
    permissions: ['settings:manage', 'updates:manage'],
    has_custom_permissions: false,
    class_count: 0,
    student_count: 0,
    pending_print_approvals: 0,
    pending_account_requests: 0,
    created_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 2,
    da: 'm.tremblay@cgodin.qc.ca',
    name: 'Marc Tremblay',
    role: 'teacher',
    hierarchy_rank: 50,
    can_manage: true,
    is_active: true,
    permissions: [
      'slicer:use',
      'classes:manage_own',
      'students:manage_own',
      'students:adjust_quotas',
      'students:reset_password',
      'approvals:jobs_own',
      'approvals:accounts_own',
    ],
    has_custom_permissions: false,
    class_count: 2,
    student_count: 14,
    pending_print_approvals: 1,
    pending_account_requests: 0,
    created_at: '2026-01-01T00:00:00Z',
  },
];

const LEAD_TEACHER_USER: UserSummary = {
  id: 10,
  da: 'lead@cgodin.qc.ca',
  name: 'Lead Teacher',
  role: 'teacher',
  hierarchy_rank: 70,
  is_active: true,
  effective_max_active_grams: 100,
  active_grams_used: 0,
  available_grams: 100,
  enforce_duration_limit: true,
  effective_max_print_minutes: 360,
  permissions: [
    'slicer:use',
    'printers:view',
    'printers:manage_slots',
    'accounts:view',
    'accounts:create_tech',
    'accounts:edit_permissions',
  ],
};

describe('AdminTeachersTab (Account Management & Discord Hierarchy)', () => {
  beforeEach(() => {
    localStorage.setItem('ggprint_lang', 'en');
    vi.restoreAllMocks();
    vi.spyOn(api, 'adminGetPermissionCatalog').mockResolvedValue(FALLBACK_PERMISSION_CATALOG);
  });

  it('configures an account using a template and granular scopes, saves, and resets', async () => {
    const user = userEvent.setup();
    const updateSpy = vi
      .spyOn(api, 'adminUpdateTeacher')
      .mockResolvedValue({ ...MOCK_ACCOUNTS[1], role: 'tech', has_custom_permissions: true });
    const onReload = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();

    render(
      <I18nProvider>
        <AdminTeachersTab teachers={MOCK_ACCOUNTS} onReload={onReload} onError={onError} />
      </I18nProvider>
    );

    // Super Admin shows Protected badge
    expect(screen.getByText('Protected')).toBeInTheDocument();

    // Open inline Account Configurator on Marc Tremblay
    await user.click(screen.getByRole('button', { name: /^Configure$/i }));

    // Apply Lab Technician preset
    await user.click(screen.getByRole('button', { name: /Lab Technician/i }));

    // Narrow Printers & Configurator to View only via GitHub-style dropdown
    const printerSelect = screen.getByLabelText(/Printers & Configurator/i);
    await user.selectOptions(printerSelect, 'view');

    // Save config
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(
        2,
        expect.objectContaining({
          role: 'tech',
          hierarchy_rank: 50,
          permissions: expect.arrayContaining([
            'slicer:use',
            'printers:view',
            'filaments:create_delete',
            'approvals:jobs_all',
          ]),
        })
      );
    });

    // Re-open and reset to role default
    await user.click(screen.getByRole('button', { name: /^Configure$/i }));
    await user.click(screen.getByRole('button', { name: /Reset to role default/i }));

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(2, { reset_permissions: true });
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it('enforces Discord delegation boundaries for a Lead Teacher without Teacher creation rights', async () => {
    const user = userEvent.setup();
    const onReload = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();

    render(
      <I18nProvider>
        <AdminTeachersTab
          teachers={MOCK_ACCOUNTS}
          currentUser={LEAD_TEACHER_USER}
          onReload={onReload}
          onError={onError}
        />
      </I18nProvider>
    );

    // Expand create form Account Configurator
    await user.click(screen.getByRole('button', { name: /Account configurator/i }));

    // Teacher role button disabled because Lead Teacher only holds accounts:create_tech
    expect(screen.getByRole('button', { name: /^Teacher$/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Lab Tech$/i })).not.toBeDisabled();
    expect(screen.getByText(/System Settings.*Main Admin \(Rank 100\)/i)).toBeInTheDocument();
  });
});
