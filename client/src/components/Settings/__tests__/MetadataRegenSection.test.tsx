import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MetadataRegenSection } from '../MetadataRegenSection';
import { useMetadataRegenStatus } from '../../../hooks/useMetadataRegenStatus';
import { DEFAULT_CONFIG, ConfigState } from '../../../config/configSchema';

jest.mock('../../../hooks/useMetadataRegenStatus');

const mockUseMetadataRegenStatus = useMetadataRegenStatus as jest.MockedFunction<
  typeof useMetadataRegenStatus
>;

function renderSection(configOverrides: Partial<ConfigState> = {}, onConfigChange = jest.fn()) {
  const config: ConfigState = { ...DEFAULT_CONFIG, ...configOverrides };
  render(<MetadataRegenSection token="tok" config={config} onConfigChange={onConfigChange} />);
  return { onConfigChange, config };
}

describe('MetadataRegenSection', () => {
  beforeEach(() => {
    mockUseMetadataRegenStatus.mockReturnValue({
      running: false,
      lastRun: null,
      loading: false,
      error: null,
      triggerRegen: jest.fn(),
    });
  });

  test('reflects config.strm.writeMediaInfoCache as checked by default (undefined = on)', () => {
    renderSection({ strm: { ...DEFAULT_CONFIG.strm, writeMediaInfoCache: undefined as unknown as boolean } });
    expect(screen.getByRole('checkbox')).toBeChecked();
  });

  test('reflects config.strm.writeMediaInfoCache = false as unchecked', () => {
    renderSection({ strm: { ...DEFAULT_CONFIG.strm, writeMediaInfoCache: false } });
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  test('toggling the switch calls onConfigChange with the merged strm patch, preserving other strm fields', async () => {
    const user = userEvent.setup();
    const { onConfigChange, config } = renderSection({
      strm: { ...DEFAULT_CONFIG.strm, writeMediaInfoCache: true, target: 'ytstream' },
    });

    await user.click(screen.getByRole('checkbox'));

    expect(onConfigChange).toHaveBeenCalledWith({
      strm: { ...config.strm, writeMediaInfoCache: false },
    });
  });

  test('renders the regenerate button and triggers regeneration on click', async () => {
    const triggerRegen = jest.fn();
    mockUseMetadataRegenStatus.mockReturnValue({
      running: false,
      lastRun: null,
      loading: false,
      error: null,
      triggerRegen,
    });
    const user = userEvent.setup();

    renderSection();
    await user.click(screen.getByRole('button', { name: 'Regenerate video metadata' }));

    expect(triggerRegen).toHaveBeenCalledTimes(1);
  });

  test('shows the last run summary, distinguishing checked-and-correct from genuinely skipped', () => {
    // Real numbers from a live run: all 113 "no cached metadata" videos
    // were STRM videos whose container was checked via the fallback and
    // found already correct - zero were left completely unchecked.
    mockUseMetadataRegenStatus.mockReturnValue({
      running: false,
      lastRun: {
        startedAt: '2026-09-16T19:00:00.000Z',
        completedAt: '2026-09-16T19:17:00.000Z',
        trigger: 'manual',
        status: 'completed',
        scanned: 150,
        regenerated: 37,
        skippedNoCache: 113,
        skippedNoFile: 0,
        errors: 0,
        strmToolRegenerated: 37,
        strmToolAlreadyCorrect: 113,
        strmFilesRewritten: 0,
      },
      loading: false,
      error: null,
      triggerRegen: jest.fn(),
    });

    renderSection();

    expect(screen.getByText(/Regenerated 37 of 150 video\(s\)/)).toBeInTheDocument();
    expect(screen.getByText(/37 \.strmtool\.json sidecar\(s\) rewritten/)).toBeInTheDocument();
    expect(screen.getByText(/113 already had the correct container/)).toBeInTheDocument();
    // Every "no cached metadata" video was in fact checked, so nothing was
    // genuinely skipped - that clause should not render at all.
    expect(screen.queryByText(/skipped \(no cached metadata, nothing to check\)/)).not.toBeInTheDocument();
  });

  test('shows a genuinely-skipped count when some no-cache videos had nothing to check at all', () => {
    mockUseMetadataRegenStatus.mockReturnValue({
      running: false,
      lastRun: {
        startedAt: '2026-09-16T19:00:00.000Z',
        completedAt: '2026-09-16T19:17:00.000Z',
        trigger: 'manual',
        status: 'completed',
        scanned: 150,
        regenerated: 37,
        skippedNoCache: 113,
        skippedNoFile: 0,
        errors: 0,
        strmToolRegenerated: 37,
        strmToolAlreadyCorrect: 80,
        strmFilesRewritten: 0,
      },
      loading: false,
      error: null,
      triggerRegen: jest.fn(),
    });

    renderSection();

    expect(screen.getByText(/33 skipped \(no cached metadata, nothing to check\)/)).toBeInTheDocument();
  });
});
