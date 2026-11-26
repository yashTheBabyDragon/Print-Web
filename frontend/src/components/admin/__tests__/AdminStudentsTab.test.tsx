import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../../api/client';
import { I18nProvider } from '../../../i18n';
import type { StudentAccount, TeacherClass } from '../../../types/api';
import { AdminStudentsTab } from '../AdminStudentsTab';

const MOCK_CLASSES: TeacherClass[] = [
  {
    id: 1,
    teacher_id: 2,
    teacher_name: 'Marc Tremblay',
    name: '3DP-101 — 3D Design',
    code: '241-101',
    default_max_active_grams: 150,
    default_max_print_minutes: 300,
    is_default_individual: false,
    student_count: 2,
    enrolled_count: 2,
    registered_count: 1,
    unclaimed_count: 1,
    created_at: '2026-01-01T00:00:00Z',
    enrollments: [
      {
        id: 10,
        class_id: 1,
        da: '2345678',
        suggested_name: 'Alex Tremblay',
        registered_name: 'Alex Tremblay',
        user_id: 100,
        is_registered: true,
        is_active: true,
        created_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 11,
        class_id: 1,
        da: '2345679',
        suggested_name: 'Sophie Roy',
        is_registered: false,
        created_at: '2026-01-01T00:00:00Z',
      },
    ],
  },
  {
    id: 2,
    teacher_id: 2,
    teacher_name: 'Marc Tremblay',
    name: '3DP-202 — Prototyping',
    code: '241-202',
    is_default_individual: false,
    student_count: 0,
    enrolled_count: 0,
    registered_count: 0,
    unclaimed_count: 0,
    created_at: '2026-01-02T00:00:00Z',
    enrollments: [],
  },
];

const MOCK_STUDENTS: StudentAccount[] = [
  {
    id: 100,
    da: '2345678',
    name: 'Alex Tremblay',
    role: 'student',
    is_active: true,
    classes: [
      {
        class_id: 1,
        class_name: '3DP-101 — 3D Design',
        teacher_id: 2,
        teacher_name: 'Marc Tremblay',
      },
    ],
    active_grams_used: 25,
    effective_max_active_grams: 150,
    effective_max_print_minutes: 300,
    max_active_grams_override: 150,
    max_print_minutes_override: null,
  },
];

describe('AdminStudentsTab (Master-Detail Class Manager)', () => {
  beforeEach(() => {
    localStorage.setItem('printweb_lang', 'en');
    vi.restoreAllMocks();
    // jsdom does not implement HTMLDialogElement.showModal natively
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
      this.open = true;
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
      this.open = false;
    });
  });

  it('filters roster by search and status, and supports bulk add modal', async () => {
    const user = userEvent.setup();
    const bulkSpy = vi.spyOn(api, 'adminBulkAddClassStudents').mockResolvedValue({
      added: 2,
      skipped: 0,
      invalid: 0,
      reactivated: 0,
      invalid_lines: [],
    });
    const onReload = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();

    render(
      <I18nProvider>
        <AdminStudentsTab
          classes={MOCK_CLASSES}
          teachers={[]}
          students={MOCK_STUDENTS}
          accountRequests={[]}
          isSuperAdmin={false}
          onReload={onReload}
          onError={onError}
        />
      </I18nProvider>
    );

    // Both students visible initially
    expect(screen.getByText('2345678')).toBeInTheDocument();
    expect(screen.getByText('2345679')).toBeInTheDocument();

    // Filter to Unclaimed
    await user.click(screen.getByRole('button', { name: /^Unclaimed$/i }));
    expect(screen.queryByText('2345678')).not.toBeInTheDocument();
    expect(screen.getByText('2345679')).toBeInTheDocument();

    // Reset filter to All and search by DA
    await user.click(screen.getByRole('button', { name: /^All$/i }));
    const searchInput = screen.getByPlaceholderText(/Search by DA or name/i);
    await user.type(searchInput, 'Alex');
    expect(screen.getByText('2345678')).toBeInTheDocument();
    expect(screen.queryByText('2345679')).not.toBeInTheDocument();

    // Open Bulk Add modal and submit
    await user.click(screen.getByRole('button', { name: /Bulk add/i }));
    const textarea = screen.getByLabelText(/One student per line/i);
    await user.type(textarea, '2400001, New Student\n2400002');
    await user.click(screen.getByRole('button', { name: /Import students/i }));

    await waitFor(() => {
      expect(bulkSpy).toHaveBeenCalledWith(1, {
        raw_text: '2400001, New Student\n2400002',
      });
    });
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('transfers a student to another class', async () => {
    const user = userEvent.setup();
    const transferSpy = vi.spyOn(api, 'adminTransferClassStudent').mockResolvedValue({
      da: '2345678',
      source_class_id: 1,
      target_class_id: 2,
      moved: true,
      already_in_target: false,
    });
    const onReload = vi.fn().mockResolvedValue(undefined);

    render(
      <I18nProvider>
        <AdminStudentsTab
          classes={MOCK_CLASSES}
          teachers={[]}
          students={MOCK_STUDENTS}
          accountRequests={[]}
          isSuperAdmin={false}
          onReload={onReload}
          onError={vi.fn()}
        />
      </I18nProvider>
    );

    await user.click(screen.getByRole('button', { name: /Transfer 2345678/i }));
    await user.click(screen.getByRole('button', { name: /Confirm/i }));

    await waitFor(() => {
      expect(transferSpy).toHaveBeenCalledWith(1, {
        da: '2345678',
        target_class_id: 2,
        remove_from_source: true,
      });
    });
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('supports single-user refresh and multi-select group refresh with custom max grams', async () => {
    const user = userEvent.setup();
    const refreshSpy = vi.spyOn(api, 'adminRefreshStudentBudgets').mockResolvedValue({
      refreshed_count: 1,
      user_ids: [100],
    });
    const onReload = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();

    render(
      <I18nProvider>
        <AdminStudentsTab
          classes={MOCK_CLASSES}
          teachers={[]}
          students={MOCK_STUDENTS}
          accountRequests={[]}
          isSuperAdmin={true}
          onReload={onReload}
          onError={onError}
        />
      </I18nProvider>
    );

    // 1. Single student refresh
    await user.click(screen.getByRole('button', { name: /Refresh grams 2345678/i }));
    await user.click(screen.getByRole('button', { name: /^Refresh$/i }));

    await waitFor(() => {
      expect(refreshSpy).toHaveBeenCalledWith({
        scope: 'users',
        user_ids: [100],
        reset_usage: true,
        max_grams_mode: 'keep',
      });
    });
    expect(await screen.findByText(/Refreshed max grams for 1 student/i)).toBeInTheDocument();

    // 2. Multi-select group refresh with custom max grams
    await user.click(screen.getByLabelText('Select 2345678'));
    await user.click(screen.getByRole('button', { name: /Refresh selected \(1\)/i }));
    await user.click(screen.getByLabelText(/Set custom max grams/i));
    const customInput = screen.getByLabelText(/New max grams/i);
    await user.type(customInput, '250');
    await user.click(screen.getByRole('button', { name: /^Refresh$/i }));

    await waitFor(() => {
      expect(refreshSpy).toHaveBeenCalledWith({
        scope: 'users',
        user_ids: [100],
        reset_usage: true,
        max_grams_mode: 'custom',
        custom_max_grams: 250,
      });
    });
    expect(onReload).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
  });
});
