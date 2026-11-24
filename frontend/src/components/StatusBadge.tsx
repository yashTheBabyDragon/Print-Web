import type { JobStatus, PrinterStatus } from '../types/api';
import { useI18n } from '../i18n';

const JOB_DOT_CLASSES: Record<JobStatus, string> = {
  DRAFT: 'bg-[#8A909E]',
  SLICED: 'bg-[#00A7D9]',
  PENDING_APPROVAL: 'bg-amber-500',
  QUEUED: 'bg-[#00A7D9]',
  PRINTING: 'bg-[#00A7D9]',
  COMPLETED: 'bg-emerald-500',
  CANCELLED: 'bg-[#8A909E]',
  FAILED: 'bg-rose-500',
  REJECTED: 'bg-rose-500',
};

const JOB_TEXT_CLASSES: Record<JobStatus, string> = {
  DRAFT: 'text-[#5B616E] dark:text-[#9399A6]',
  SLICED: 'text-[#007BA3] dark:text-[#38C6F4]',
  PENDING_APPROVAL: 'text-amber-700 dark:text-amber-400',
  QUEUED: 'text-[#007BA3] dark:text-[#38C6F4]',
  PRINTING: 'text-[#007BA3] dark:text-[#38C6F4]',
  COMPLETED: 'text-emerald-700 dark:text-emerald-400',
  CANCELLED: 'text-[#5B616E] dark:text-[#9399A6]',
  FAILED: 'text-rose-700 dark:text-rose-400',
  REJECTED: 'text-rose-700 dark:text-rose-400',
};

const PRINTER_DOT_CLASSES: Record<PrinterStatus, string> = {
  idle: 'bg-emerald-500',
  printing: 'bg-[#00A7D9]',
  offline: 'bg-[#8A909E]',
  error: 'bg-rose-500',
};

const PRINTER_TEXT_CLASSES: Record<PrinterStatus, string> = {
  idle: 'text-emerald-700 dark:text-emerald-400',
  printing: 'text-[#007BA3] dark:text-[#38C6F4]',
  offline: 'text-[#5B616E] dark:text-[#9399A6]',
  error: 'text-rose-700 dark:text-rose-400',
};

export function JobStatusBadge({ status }: { status: JobStatus }) {
  const { t } = useI18n();
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${JOB_TEXT_CLASSES[status]}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${JOB_DOT_CLASSES[status]}`} />
      <span>{t.status[status]}</span>
    </span>
  );
}

export function PrinterStatusBadge({ status }: { status: PrinterStatus }) {
  const { t } = useI18n();
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${PRINTER_TEXT_CLASSES[status]}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${PRINTER_DOT_CLASSES[status]}`} />
      <span>{t.status[status]}</span>
    </span>
  );
}
