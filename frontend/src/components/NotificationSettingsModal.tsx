import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Bell,
  CheckCircle2,
  Loader2,
  Send,
  Webhook,
  X,
} from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useI18n } from '../i18n';
import { translateApiError } from '../utils/errors';

interface NotificationSettingsModalProps {
  open: boolean;
  onClose: () => void;
}

type BrowserPermission = NotificationPermission | 'unsupported';

function getBrowserPermission(): BrowserPermission {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') {
    return 'unsupported';
  }
  return Notification.permission;
}

export function NotificationSettingsModal({ open, onClose }: NotificationSettingsModalProps) {
  const { user, setUser } = useAuth();
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const pressedOutsideRef = useRef(false);

  const [permission, setPermission] = useState<BrowserPermission>(getBrowserPermission);
  const [notifyBrowser, setNotifyBrowser] = useState(Boolean(user?.notify_browser));
  const [webhookUrl, setWebhookUrl] = useState(user?.notify_webhook_url ?? '');
  const [saving, setSaving] = useState(false);
  const [testingWebhook, setTestingWebhook] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [webhookFeedback, setWebhookFeedback] = useState<{ ok: boolean; text: string } | null>(
    null
  );

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      setPermission(getBrowserPermission());
      setNotifyBrowser(Boolean(user?.notify_browser));
      setWebhookUrl(user?.notify_webhook_url ?? '');
      setError(null);
      setSavedNotice(null);
      setWebhookFeedback(null);
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, user?.notify_browser, user?.notify_webhook_url]);

  const isOutsideRect = (ev: React.PointerEvent<HTMLDialogElement>) => {
    const dialog = dialogRef.current;
    if (!dialog) return false;
    const r = dialog.getBoundingClientRect();
    return (
      ev.clientX < r.left ||
      ev.clientX > r.right ||
      ev.clientY < r.top ||
      ev.clientY > r.bottom
    );
  };

  const handlePointerDown = (ev: React.PointerEvent<HTMLDialogElement>) => {
    pressedOutsideRef.current = isOutsideRect(ev);
  };

  const handlePointerUp = (ev: React.PointerEvent<HTMLDialogElement>) => {
    if (
      pressedOutsideRef.current &&
      isOutsideRect(ev) &&
      !('closedBy' in HTMLDialogElement.prototype)
    ) {
      dialogRef.current?.close();
    }
    pressedOutsideRef.current = false;
  };

  const handleToggleBrowser = async () => {
    setError(null);
    setSavedNotice(null);

    const nextEnabled = !notifyBrowser;
    if (nextEnabled) {
      const currentPerm = getBrowserPermission();
      setPermission(currentPerm);
      if (currentPerm === 'unsupported') return;
      if (currentPerm === 'default') {
        const result = await Notification.requestPermission();
        setPermission(result);
        if (result !== 'granted') {
          return;
        }
      } else if (currentPerm === 'denied') {
        return;
      }
    }

    setSaving(true);
    try {
      const updated = await api.updateNotifications({ notify_browser: nextEnabled });
      setUser(updated);
      setNotifyBrowser(Boolean(updated.notify_browser));
      setSavedNotice(t.notifications.savedNotice);
    } catch (err) {
      setError(translateApiError(err, t));
    } finally {
      setSaving(false);
    }
  };

  const handleTestBrowser = () => {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    new Notification(t.notifications.browserTestTitle, {
      body: t.notifications.browserTestBody,
      tag: 'ggprint-test',
    });
  };

  const handleTestWebhook = async () => {
    setError(null);
    setWebhookFeedback(null);
    setTestingWebhook(true);
    try {
      const res = await api.testWebhook(webhookUrl.trim());
      if (res.ok) {
        setWebhookFeedback({
          ok: true,
          text: t.notifications.webhookTestOk.replace('{status}', String(res.status_code ?? 200)),
        });
      } else {
        setWebhookFeedback({
          ok: false,
          text: t.notifications.webhookTestFail.replace(
            '{error}',
            res.error || `HTTP ${res.status_code ?? 'error'}`
          ),
        });
      }
    } catch (err) {
      setWebhookFeedback({
        ok: false,
        text: translateApiError(err, t),
      });
    } finally {
      setTestingWebhook(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSavedNotice(null);
    setSaving(true);
    try {
      const updated = await api.updateNotifications({
        notify_browser: notifyBrowser,
        notify_webhook_url: webhookUrl.trim() || null,
      });
      setUser(updated);
      setNotifyBrowser(Boolean(updated.notify_browser));
      setWebhookUrl(updated.notify_webhook_url ?? '');
      setSavedNotice(t.notifications.savedNotice);
    } catch (err) {
      setError(translateApiError(err, t));
    } finally {
      setSaving(false);
    }
  };

  const browserActive = notifyBrowser && permission === 'granted';

  return (
    <dialog
      ref={dialogRef}
      {...({ closedby: 'any' } as Record<string, string>)}
      aria-labelledby="notifications-dialog-title"
      onClose={onClose}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      className="gg-dialog w-full max-w-lg"
    >
      <div className="p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1
              id="notifications-dialog-title"
              className="text-base font-semibold tracking-tight text-[#111318] dark:text-[#F4F5F7]"
            >
              {t.notifications.modalTitle}
            </h1>
            <p className="mt-1 text-xs text-[#5B616E] dark:text-[#9399A6]">
              {t.notifications.modalSubtitle}
            </p>
          </div>
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            aria-label={t.common.close}
            className="btn-ghost p-1"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {error && (
          <div className="mt-4 flex items-center gap-2 rounded-xl bg-rose-500/10 px-3.5 py-2.5 text-xs font-medium text-rose-700 dark:text-rose-300">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {savedNotice && (
          <div className="mt-4 flex items-center gap-2 rounded-xl bg-emerald-500/10 px-3.5 py-2.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>{savedNotice}</span>
          </div>
        )}

        <form onSubmit={handleSave} className="mt-5 space-y-5">
          {/* Browser Notifications */}
          <div className="rounded-xl border border-black/[0.08] p-4 dark:border-white/[0.09]">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2.5">
                <Bell className="mt-0.5 h-4 w-4 shrink-0 text-[#00A7D9]" />
                <div>
                  <div className="text-sm font-medium text-[#111318] dark:text-[#F4F5F7]">
                    {t.notifications.browserTitle}
                  </div>
                  <p className="mt-0.5 text-xs text-[#5B616E] dark:text-[#9399A6]">
                    {t.notifications.browserDesc}
                  </p>
                </div>
              </div>

              {permission !== 'unsupported' && (
                <div className="flex shrink-0 items-center gap-1.5">
                  {browserActive && (
                    <button
                      type="button"
                      onClick={handleTestBrowser}
                      className="btn-ghost px-2.5 py-1 text-xs"
                    >
                      {t.notifications.browserTestBtn}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={saving || permission === 'denied'}
                    onClick={handleToggleBrowser}
                    className={
                      browserActive
                        ? 'btn-secondary px-3 py-1 text-xs text-emerald-700 dark:text-emerald-400'
                        : 'btn-primary px-3 py-1 text-xs'
                    }
                  >
                    {browserActive
                      ? t.notifications.browserDisable
                      : t.notifications.browserEnable}
                  </button>
                </div>
              )}
            </div>

            {permission === 'unsupported' && (
              <p className="mt-2.5 text-xs text-amber-700 dark:text-amber-300">
                {t.notifications.browserUnsupported}
              </p>
            )}
            {permission === 'denied' && (
              <p className="mt-2.5 text-xs text-rose-700 dark:text-rose-300">
                {t.notifications.browserDenied}
              </p>
            )}
          </div>

          {/* Webhook */}
          <div className="rounded-xl border border-black/[0.08] p-4 dark:border-white/[0.09]">
            <div className="flex items-start gap-2.5">
              <Webhook className="mt-0.5 h-4 w-4 shrink-0 text-[#00A7D9]" />
              <div className="min-w-0 flex-1">
                <label
                  htmlFor="notification-webhook-url"
                  className="block text-sm font-medium text-[#111318] dark:text-[#F4F5F7]"
                >
                  {t.notifications.webhookTitle}
                </label>
                <p className="mt-0.5 text-xs text-[#5B616E] dark:text-[#9399A6]">
                  {t.notifications.webhookDesc}
                </p>

                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <input
                    id="notification-webhook-url"
                    type="url"
                    value={webhookUrl}
                    onChange={(e) => {
                      setWebhookUrl(e.target.value);
                      setWebhookFeedback(null);
                      setSavedNotice(null);
                    }}
                    placeholder={t.notifications.webhookPlaceholder}
                    className="studio-input flex-1 font-mono text-xs"
                  />
                  <button
                    type="button"
                    disabled={testingWebhook || !webhookUrl.trim()}
                    onClick={handleTestWebhook}
                    className="btn-secondary shrink-0 px-3 py-2 text-xs"
                  >
                    {testingWebhook ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Send className="h-3.5 w-3.5" />
                    )}
                    {testingWebhook
                      ? t.notifications.webhookTesting
                      : t.notifications.webhookTestBtn}
                  </button>
                </div>

                {webhookFeedback && (
                  <p
                    className={`mt-2 text-xs font-medium ${
                      webhookFeedback.ok
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : 'text-rose-700 dark:text-rose-300'
                    }`}
                  >
                    {webhookFeedback.text}
                  </p>
                )}
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              className="btn-secondary"
            >
              {t.common.close}
            </button>
            <button type="submit" disabled={saving} className="btn-primary">
              {saving ? t.common.saving : t.common.save}
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
}
