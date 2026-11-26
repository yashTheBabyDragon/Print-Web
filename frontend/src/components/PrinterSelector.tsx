import { Check } from 'lucide-react';
import type { Printer } from '../types/api';
import { useI18n } from '../i18n';
import { PrinterStatusBadge } from './StatusBadge';

interface PrinterSelectorProps {
  printers: Printer[];
  selectedPrinterId: number | null;
  selectedSlotId: number | null;
  onSelectPrinter: (printer: Printer) => void;
  onSelectSlot: (slotId: number) => void;
}

export function PrinterSelector({
  printers,
  selectedPrinterId,
  selectedSlotId,
  onSelectPrinter,
  onSelectSlot,
}: PrinterSelectorProps) {
  const { t } = useI18n();
  const activePrinter = printers.find((p) => p.id === selectedPrinterId) ?? printers[0] ?? null;

  return (
    <div className="space-y-4">
      {/* Printer List */}
      <div className="divide-y divide-black/[0.06] overflow-hidden rounded-xl border border-black/[0.08] bg-white dark:divide-white/[0.07] dark:border-white/[0.09] dark:bg-[#15171C]">
        {printers.map((printer) => {
          const isSelected = activePrinter?.id === printer.id;
          return (
            <button
              key={printer.id}
              type="button"
              onClick={() => onSelectPrinter(printer)}
              className={`flex min-h-[44px] w-full items-center justify-between gap-2.5 px-3 py-3 text-left transition-colors sm:py-2.5 ${
                isSelected
                  ? 'bg-[#00A7D9]/[0.09] dark:bg-[#00A7D9]/[0.14]'
                  : 'hover:bg-black/[0.025] dark:hover:bg-white/[0.03]'
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span
                    className={`truncate text-[13px] font-medium ${
                      isSelected
                        ? 'text-[#007BA3] dark:text-[#38C6F4]'
                        : 'text-[#111318] dark:text-[#F4F5F7]'
                    }`}
                  >
                    {printer.name}
                  </span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] tabular-nums text-[#5B616E] dark:text-[#9399A6]">
                  <span className="whitespace-nowrap">
                    {printer.printer_type === 'klipper' ? 'Klipper' : 'PrusaLink'}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="whitespace-nowrap">
                    {printer.bed_x_mm}×{printer.bed_y_mm}×{printer.bed_z_mm}
                  </span>
                  {printer.has_mmu && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="whitespace-nowrap">
                        {t.workspace.mmuBadge} ×{printer.mmu_slots_count}
                      </span>
                    </>
                  )}
                </div>
              </div>

              <div className="flex shrink-0 flex-col items-end gap-0.5">
                <PrinterStatusBadge status={printer.status} />
                {printer.queue_count > 0 && (
                  <span className="text-[11px] tabular-nums text-[#5B616E] dark:text-[#9399A6]">
                    {printer.queue_count} {t.workspace.queueCount}
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {/* Filament / MMU Slot Picker */}
      {activePrinter && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-[#5B616E] dark:text-[#9399A6]">
            {t.workspace.selectSlotLabel}
          </div>
          {activePrinter.slots.length === 0 ? (
            <p className="text-xs text-[#5B616E] dark:text-[#9399A6]">
              {t.workspace.noLoadedSlot}
            </p>
          ) : (
            <div className="space-y-1">
              {activePrinter.slots.map((slot) => {
                const loaded = slot.is_loaded && slot.filament_id != null;
                const isSelected = slot.id === selectedSlotId;
                const swatchColor = slot.color_hex || '#94A3B8';
                return (
                  <button
                    key={slot.id}
                    type="button"
                    disabled={!loaded}
                    onClick={() => loaded && onSelectSlot(slot.id)}
                    className={`flex min-h-[44px] w-full items-center justify-between gap-2.5 rounded-xl px-3 py-2.5 text-left text-xs transition-colors sm:px-2.5 sm:py-2 ${
                      !loaded
                        ? 'cursor-not-allowed opacity-45'
                        : isSelected
                          ? 'bg-[#00A7D9]/[0.12] text-[#111318] dark:bg-[#00A7D9]/[0.18] dark:text-white'
                          : 'hover:bg-black/[0.04] dark:hover:bg-white/[0.05]'
                    }`}
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span
                        className="h-4 w-4 shrink-0 rounded-full border border-black/15 dark:border-white/20"
                        style={{ backgroundColor: swatchColor }}
                      />
                      <div className="min-w-0">
                        <div className="truncate font-medium text-[#111318] dark:text-[#F4F5F7]">
                          {loaded ? slot.filament_name : slot.label || `Slot ${slot.slot_index}`}
                        </div>
                        <div className="truncate text-[11px] text-[#5B616E] dark:text-[#9399A6]">
                          {loaded
                            ? `${slot.label || `Slot ${slot.slot_index}`} · ${slot.material}`
                            : t.workspace.emptySlot}
                        </div>
                      </div>
                    </div>
                    {isSelected && loaded && (
                      <Check className="h-3.5 w-3.5 shrink-0 text-[#00A7D9]" />
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
