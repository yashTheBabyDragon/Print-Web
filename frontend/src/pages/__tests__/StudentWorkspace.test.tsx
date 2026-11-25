import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import { AuthProvider } from '../../context/AuthContext';
import { I18nProvider } from '../../i18n';
import type { JobDetail, Printer, UserSummary } from '../../types/api';
import { StudentWorkspace } from '../StudentWorkspace';

vi.mock('../../components/BuildPlate3D', () => ({
  BuildPlate3D: (props: {
    jobId: number | null;
    workspaceMode?: 'prepare' | 'preview';
    onWorkspaceModeChange?: (mode: 'prepare' | 'preview') => void;
    canPreview?: boolean;
    sliceVersion?: number;
    onTransformChange: (next: {
      posX: number;
      posY: number;
      quatX: number;
      quatY: number;
      quatZ: number;
      quatW: number;
      scale: number;
    }) => void;
    onPreviewStateChange?: (state: {
      loading: boolean;
      ready: boolean;
      error: string | null;
      layerCount: number;
    }) => void;
  }) => {
    const { jobId, sliceVersion, onPreviewStateChange } = props;
    useEffect(() => {
      if (jobId && sliceVersion && sliceVersion > 0) {
        onPreviewStateChange?.({ loading: false, ready: true, error: null, layerCount: 12 });
      }
    }, [jobId, sliceVersion, onPreviewStateChange]);

    return (
      <div data-testid="mock-build-plate" data-mode={props.workspaceMode}>
        <button
          type="button"
          role="tab"
          aria-selected={props.workspaceMode === 'prepare'}
          onClick={() => props.onWorkspaceModeChange?.('prepare')}
        >
          Prepare
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={props.workspaceMode === 'preview'}
          aria-disabled={!props.canPreview}
          onClick={() => {
            if (props.canPreview) props.onWorkspaceModeChange?.('preview');
          }}
        >
          Preview
        </button>
        <button
          type="button"
          onClick={() =>
            props.onTransformChange({
              posX: 12,
              posY: 0,
              quatX: 0,
              quatY: 0,
              quatZ: 0,
              quatW: 1,
              scale: 1,
            })
          }
        >
          Nudge part
        </button>
      </div>
    );
  },
}));

const STUDENT_USER: UserSummary = {
  id: 1,
  da: '2345678',
  name: 'Alex Student',
  role: 'student',
  is_active: true,
  effective_max_active_grams: 100,
  active_grams_used: 0,
  available_grams: 100,
  enforce_duration_limit: true,
  effective_max_print_minutes: 360,
};

const PRINTERS: Printer[] = [
  {
    id: 1,
    name: 'Voron 2.4',
    fdm_monster_id: 'klipper-voron-1',
    printer_type: 'klipper',
    status: 'idle',
    queue_count: 0,
    bed_x_mm: 300,
    bed_y_mm: 300,
    bed_z_mm: 300,
    mmu_slots_count: 1,
    has_mmu: false,
    slots: [
      {
        id: 10,
        slot_index: 1,
        label: 'Slot 1',
        filament_id: 1,
        filament_name: 'PLA Cyan',
        material: 'PLA',
        color_hex: '#00A7D9',
        is_loaded: true,
      },
    ],
  },
];

const BASE_JOB: JobDetail = {
  id: 77,
  printer_id: 1,
  printer_name: 'Voron 2.4',
  slot_id: 10,
  original_filename: 'bracket.stl',
  status: 'DRAFT',
  pos_x_mm: 0,
  pos_y_mm: 0,
  quat_x: 0,
  quat_y: 0,
  quat_z: 0,
  quat_w: 1,
  scale: 1,
};

const SLICED_JOB: JobDetail = {
  ...BASE_JOB,
  status: 'SLICED',
  estimated_grams: 18.4,
  estimated_minutes: 42,
  layer_count: 12,
  supports_enabled: true,
  gcode_filename: 'bracket.gcode',
  gcode_url: '/api/jobs/77/gcode',
  budget_check: {
    within_grams: true,
    within_duration: true,
    can_auto_submit: true,
    exceeds_grams_by: 0,
    exceeds_minutes_by: 0,
  },
};

describe('StudentWorkspace Prepare / Preview slicing flow', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('ggprint_lang', 'en');
    localStorage.setItem('ggprint_token', 'fake-token');
    vi.restoreAllMocks();

    vi.spyOn(api, 'getAuthMode').mockResolvedValue({
      dev_mode: true,
      slicer_mode: 'mock',
      fdm_mode: 'mock',
      institution: 'Cégep Gérald-Godin',
    });
    vi.spyOn(api, 'getMe').mockResolvedValue(STUDENT_USER);
    vi.spyOn(api, 'getPrinters').mockResolvedValue(PRINTERS);
    vi.spyOn(api, 'getSamples').mockResolvedValue([
      { id: 'tilted-bracket.stl', name: 'Tilted Bracket', description: 'Sample' },
    ]);
    vi.spyOn(api, 'downloadSampleStl').mockResolvedValue(
      new File(['solid x'], 'tilted-bracket.stl', { type: 'model/stl' })
    );
    vi.spyOn(api, 'uploadJob').mockResolvedValue(BASE_JOB);
    vi.spyOn(api, 'sliceJob').mockResolvedValue(SLICED_JOB);
    vi.spyOn(api, 'submitJob').mockResolvedValue({ ...SLICED_JOB, status: 'QUEUED' });
  });

  it('auto-switches to Preview after slicing, allows switching back and forth, and gates Send to printer', async () => {
    const user = userEvent.setup();

    render(
      <I18nProvider>
        <AuthProvider>
          <StudentWorkspace onNavigateMyPrints={vi.fn()} />
        </AuthProvider>
      </I18nProvider>
    );

    // Wait for printers & samples
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Load$/i })).toBeEnabled();
    });

    // Load a sample STL -> lands in Prepare with Preview disabled and no Send to printer
    await user.click(screen.getByRole('button', { name: /^Load$/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Slice model/i })).toBeInTheDocument();
    });
    expect(screen.getByRole('tab', { name: /^Prepare$/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /^Preview$/i })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByRole('button', { name: /Send to printer/i })).not.toBeInTheDocument();

    // Click Slice model -> automatically switches to Preview and shows Send to printer
    await user.click(screen.getByRole('button', { name: /Slice model/i }));

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /^Preview$/i })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('button', { name: /Send to printer/i })).toBeEnabled();
    });

    // Switch back to Prepare -> Preview stays enabled, Send to printer is hidden, View preview is offered
    await user.click(screen.getByRole('tab', { name: /^Prepare$/i }));
    expect(screen.getByRole('tab', { name: /^Prepare$/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /^Preview$/i })).toHaveAttribute('aria-disabled', 'false');
    expect(screen.queryByRole('button', { name: /Send to printer/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /View preview/i })).toBeInTheDocument();

    // Switch back to Preview via View preview -> Send to printer is ready again
    await user.click(screen.getByRole('button', { name: /View preview/i }));
    expect(screen.getByRole('tab', { name: /^Preview$/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: /Send to printer/i })).toBeEnabled();

    // Go back to Prepare and move the part -> marks slice stale and requires re-slicing
    await user.click(screen.getByRole('tab', { name: /^Prepare$/i }));
    await user.click(screen.getByRole('button', { name: /Nudge part/i }));
    expect(screen.getByRole('button', { name: /Slice model/i })).toBeInTheDocument();

    // Even if user inspects outdated Preview tab, Send to printer is gated until re-sliced
    await user.click(screen.getByRole('tab', { name: /^Preview$/i }));
    expect(screen.queryByRole('button', { name: /Send to printer/i })).not.toBeInTheDocument();

    // Re-slice -> fresh Preview -> Send to printer submits job
    await user.click(screen.getByRole('button', { name: /Slice model/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Send to printer/i })).toBeEnabled();
    });
    await user.click(screen.getByRole('button', { name: /Send to printer/i }));

    await waitFor(() => {
      expect(api.submitJob).toHaveBeenCalledWith(77);
      expect(screen.getByText(/Print job added to the queue/i)).toBeInTheDocument();
    });
  });
});
