import { useCallback, useEffect, useRef } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useI18n } from '../i18n';
import type { JobDetail, JobStatus } from '../types/api';

const ACTIVE_STATUSES = new Set<JobStatus>(['PENDING_APPROVAL', 'QUEUED', 'PRINTING']);
const JOBS_UPDATED_EVENT = 'ggprint:jobs-updated';
const POLL_INTERVAL_MS = 15_000;

export function emitJobsUpdated(jobs: JobDetail[]): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<JobDetail[]>(JOBS_UPDATED_EVENT, { detail: jobs }));
}

export function isBrowserNotificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function usePrintNotifications(onNavigateMyPrints?: () => void): void {
  const { user, setUser } = useAuth();
  const { t } = useI18n();

  const knownStatusesRef = useRef<Map<number, JobStatus>>(new Map());
  const notifiedIdsRef = useRef<Set<number>>(new Set());
  const seededUserIdRef = useRef<number | null>(null);
  const onNavigateRef = useRef(onNavigateMyPrints);
  onNavigateRef.current = onNavigateMyPrints;

  const processJobs = useCallback(
    (jobs: JobDetail[], userId: number, notifyEnabled: boolean) => {
      const prevMap = knownStatusesRef.current;
      const isSeeded = seededUserIdRef.current === userId;

      if (!isSeeded) {
        prevMap.clear();
        notifiedIdsRef.current.clear();
        for (const job of jobs) {
          prevMap.set(job.id, job.status);
        }
        seededUserIdRef.current = userId;
        return;
      }

      const canNotify =
        notifyEnabled &&
        isBrowserNotificationSupported() &&
        Notification.permission === 'granted';

      for (const job of jobs) {
        const prevStatus = prevMap.get(job.id);
        if (
          canNotify &&
          job.status === 'COMPLETED' &&
          prevStatus != null &&
          ACTIVE_STATUSES.has(prevStatus) &&
          !notifiedIdsRef.current.has(job.id)
        ) {
          notifiedIdsRef.current.add(job.id);
          const filename = job.original_filename || job.filename || `#${job.id}`;
          const printer = job.printer_name || `#${job.printer_id}`;
          const body = t.notifications.printDoneBody
            .replace('{filename}', filename)
            .replace('{printer}', printer);

          try {
            const notif = new Notification(t.notifications.printDoneTitle, {
              body,
              tag: `ggprint-job-${job.id}`,
            });
            notif.onclick = () => {
              window.focus();
              onNavigateRef.current?.();
              notif.close();
            };
          } catch {
            // Ignore browser Notification constructor errors in restricted contexts
          }
        }
        prevMap.set(job.id, job.status);
      }
    },
    [t]
  );

  const userId = user?.id ?? null;
  const notifyEnabled = Boolean(user?.notify_browser);

  useEffect(() => {
    if (userId == null) {
      knownStatusesRef.current.clear();
      notifiedIdsRef.current.clear();
      seededUserIdRef.current = null;
      return;
    }

    const handleExternalUpdate = (ev: Event) => {
      const custom = ev as CustomEvent<JobDetail[]>;
      if (Array.isArray(custom.detail)) {
        processJobs(custom.detail, userId, notifyEnabled);
      }
    };

    window.addEventListener(JOBS_UPDATED_EVENT, handleExternalUpdate);

    if (!notifyEnabled) {
      return () => {
        window.removeEventListener(JOBS_UPDATED_EVENT, handleExternalUpdate);
      };
    }

    let active = true;
    const poll = async () => {
      try {
        const res = await api.getMyJobs();
        if (!active) return;
        processJobs(res.jobs, userId, notifyEnabled);
        setUser(res.user);
      } catch {
        // Ignore transient polling errors
      }
    };

    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);

    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener(JOBS_UPDATED_EVENT, handleExternalUpdate);
    };
  }, [userId, notifyEnabled, processJobs, setUser]);
}
