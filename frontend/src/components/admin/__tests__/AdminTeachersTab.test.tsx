import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../../api/client';
import { I18nProvider } from '../../../i18n';
import type { AdminTeacher } from '../../../types/api';
import { AdminTeachersTab } from '../AdminTeachersTab';
import { FALLBACK_PERMISSION_CATALOG } from '../TeacherPermissionsEditor';

const MOCK_TEACHERS: AdminTeacher[] = [
  {
    id: 2,
    da: 'm.tremblay@cgodin.qc.ca',
    name: 'Marc Tremblay',
    is_active: true,
    permissions: [
      'slicer:use',
      'classes:manage_own',
      'students:manage_own',
      'approvals:manage_own',
    ],
    has_custom_permissions: false,
    class_count: 2,
    student_count: 14,
    pending_print_approvals: 1,
    pending_account_requests: 0,
    created_at: '2026-01-01T00:00:00Z',
  },
];

describe('AdminTeachersTab (Permissions Presets & Manual Controls)', () => {
  beforeEach(() => {
    localStorage.setItem('ggprint_lang', 'en');
    vi.restoreAllMocks();
    vi.spyOn(api, 'adminGetPermissionCatalog').mockResolvedValue(FALLBACK_PERMISSION_CATALOG);
  });

  it('applies a preset, toggles a permission by hand, saves, and resets to default', async () => {
    const user = userEvent.setup();
    const updateSpy = vi
      .spyOn(api, 'adminUpdateTeacher')
      .mockResolvedValue({ ...MOCK_TEACHERS[0], has_custom_permissions: true });
    const onReload = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();

    render(
      <I18nProvider>
        <AdminTeachersTab teachers={MOCK_TEACHERS} onReload={onReload} onError={onError} />
      </I18nProvider>
    );

    // Open inline permissions editor
    await user.click(screen.getByRole('button', { name: /^Permissions$/i }));

    // Apply Lab Technician preset
    await user.click(screen.getByRole('button', { name: /Lab Technician/i }));

    // Toggle "Manage own classes" manually on top of preset
    const ownClassesCheckbox = screen.getByLabelText(/Manage own classes/i);
    expect(ownClassesCheckbox).not.toBeChecked();
    await user.click(ownClassesCheckbox);
    expect(ownClassesCheckbox).toBeChecked();

    // Save permissions
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(
        2,
        expect.objectContaining({
          permissions: expect.arrayContaining([
            'slicer:use',
            'printers:manage',
            'filaments:manage',
            'profiles:manage',
            'approvals:manage_all',
            'classes:manage_own',
          ]),
        })
      );
    });

    // Re-open and reset to default
    await user.click(screen.getByRole('button', { name: /^Permissions$/i }));
    await user.click(screen.getByRole('button', { name: /Reset to default/i }));

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(2, { reset_permissions: true });
    });
    expect(onError).not.toHaveBeenCalled();
  });
});
