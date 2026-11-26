import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import { AuthProvider } from '../../context/AuthContext';
import { emitJobsUpdated, usePrintNotifications } from '../../hooks/usePrintNotifications';
import { I18nProvider } from '../../i18n';
import type { JobDetail, UserSummary } from '../../types/api';
import { NotificationSettingsModal } from '../NotificationSettingsModal';

const STUDENT_USER: UserSummary = {
  id: 42,
  da: '2345678',
  name: 'Alex Student',
  role: 'student',
  is_active: true,
  effective_max_active_grams: 100,
  active_grams_used: 0,
  available_grams: 100,
  enforce_duration_limit: true,
  effective_max_print_minutes: 360,
  notify_browser: false,
  notify_webhook_url: null,
};

function makeJob(id: number, status: JobDetail['status'], filename = 'part.stl'): JobDetail {
  return {
    id,
    printer_id: 1,
    printer_name: 'Prusa MK4S',
    slot_id: 1,
    original_filename: filename,
    status,
    pos_x_mm: 0,
    pos_y_mm: 0,
    quat_x: 0,
    quat_y: 0,
    quat_z: 0,
    quat_w: 1,
    scale: 1,
  };
}

describe('NotificationSettingsModal', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('printweb_lang', 'en');
    localStorage.setItem('printweb_token', 'fake-token');
    vi.restoreAllMocks();

    // Polyfill <dialog> showModal/close for jsdom
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    });

    vi.spyOn(api, 'getAuthMode').mockResolvedValue({
      dev_mode: true,
      slicer_mode: 'mock',
      fdm_mode: 'mock',
      institution: '3D Print Lab',
    });
    vi.spyOn(api, 'getMe').mockResolvedValue(STUDENT_USER);
  });

  it('lets a student enable browser notifications, test a webhook, and save preferences', async () => {
    const user = userEvent.setup();
    const requestPermission = vi.fn().mockResolvedValue('granted');
    const NotificationMock = vi.fn() as unknown as typeof Notification;
    Object.defineProperty(NotificationMock, 'permission', {
      configurable: true,
      get: () => 'default',
    });
    NotificationMock.requestPermission = requestPermission;
    vi.stubGlobal('Notification', NotificationMock);

    const testWebhookSpy = vi.spyOn(api, 'testWebhook').mockResolvedValue({
      ok: true,
      status_code: 204,
      error: null,
    });
    const updateSpy = vi.spyOn(api, 'updateNotifications').mockResolvedValue({
      ...STUDENT_USER,
      notify_browser: true,
      notify_webhook_url: 'https://discord.com/api/webhooks/123/abc',
    });

    render(
      <I18nProvider>
        <AuthProvider>
          <NotificationSettingsModal open onClose={vi.fn()} />
        </AuthProvider>
      </I18nProvider>
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Enable$/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /^Enable$/i }));
    expect(requestPermission).toHaveBeenCalledTimes(1);

    const webhookInput = screen.getByLabelText(/Webhook/i);
    await user.type(webhookInput, 'https://discord.com/api/webhooks/123/abc');

    await user.click(screen.getByRole('button', { name: /Test webhook/i }));
    await waitFor(() => {
      expect(testWebhookSpy).toHaveBeenCalledWith('https://discord.com/api/webhooks/123/abc');
      expect(screen.getByText(/HTTP 204/i)).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith({
        notify_browser: true,
        notify_webhook_url: 'https://discord.com/api/webhooks/123/abc',
      });
      expect(screen.getByText(/Notification preferences saved/i)).toBeInTheDocument();
    });
  });

  it('fires a browser notification when an active print transitions to COMPLETED', async () => {
    const createdNotifs: Array<{ title: string; options?: NotificationOptions }> = [];
    const NotificationMock = vi.fn(function (title: string, options?: NotificationOptions) {
      createdNotifs.push({ title, options });
      return { close: vi.fn(), onclick: null };
    }) as unknown as typeof Notification;
    Object.defineProperty(NotificationMock, 'permission', {
      configurable: true,
      get: () => 'granted',
    });
    vi.stubGlobal('Notification', NotificationMock);

    const enabledUser: UserSummary = { ...STUDENT_USER, notify_browser: true };
    vi.spyOn(api, 'getMe').mockResolvedValue(enabledUser);
    vi.spyOn(api, 'getMyJobs').mockResolvedValue({
      user: enabledUser,
      jobs: [makeJob(1, 'COMPLETED', 'old.stl'), makeJob(2, 'PRINTING', 'new_part.stl')],
    });

    function Harness() {
      usePrintNotifications();
      return null;
    }

    render(
      <I18nProvider>
        <AuthProvider>
          <Harness />
        </AuthProvider>
      </I18nProvider>
    );

    // Wait for initial seed poll; historical COMPLETED job #1 must NOT notify
    await waitFor(() => {
      expect(api.getMyJobs).toHaveBeenCalled();
    });
    expect(createdNotifs).toHaveLength(0);

    // Job #2 transitions from PRINTING -> COMPLETED
    act(() => {
      emitJobsUpdated([
        makeJob(1, 'COMPLETED', 'old.stl'),
        makeJob(2, 'COMPLETED', 'new_part.stl'),
      ]);
    });

    expect(createdNotifs).toHaveLength(1);
    expect(createdNotifs[0].title).toBe('Print completed');
    expect(createdNotifs[0].options?.body).toContain('new_part.stl');
    expect(createdNotifs[0].options?.body).toContain('Prusa MK4S');
  });
});
