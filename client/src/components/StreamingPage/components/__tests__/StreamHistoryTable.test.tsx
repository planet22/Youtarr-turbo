import React from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import StreamHistoryTable, {
  RESULT_CHIPS,
  STREAM_STATUS_OPTIONS,
  resultChipFor,
  formatStarted,
  formatStartedParts,
  formatDuration,
} from '../StreamHistoryTable';
import DeleteStreamHistoryDialog from '../DeleteStreamHistoryDialog';
import { StreamHistoryRow } from '../../../../hooks/useStreamHistory';
import { renderWithProviders } from '../../../../test-utils';

const buildRow = (overrides: Partial<StreamHistoryRow> = {}): StreamHistoryRow => ({
  streamId: 's1',
  youtubeId: 'abc123DEF45',
  title: 'A Video',
  mode: 'hls',
  quality: '1080',
  container: 'mp4',
  transcode: 'copy',
  hardwareMode: null,
  clientIp: '10.0.0.5',
  userAgent: 'Jellyfin-Server/10.9',
  startedAt: '2026-03-10T12:00:00.000Z',
  endedAt: '2026-03-10T12:01:05.250Z',
  bytesTransferred: 5 * 1024 * 1024,
  endReason: 'completed',
  errorMessage: null,
  ...overrides,
});

describe('resultChipFor', () => {
  it('shows a running stream as in progress', () => {
    expect(resultChipFor(buildRow({ endedAt: null }))).toEqual({ label: 'In progress', color: 'info' });
  });

  it.each(Object.entries(RESULT_CHIPS))('maps the end reason %s', (reason, chip) => {
    expect(resultChipFor(buildRow({ endReason: reason }))).toEqual(chip);
  });

  it('shows an unknown reason as itself', () => {
    expect(resultChipFor(buildRow({ endReason: 'brand-new-reason' }))).toEqual({ label: 'brand-new-reason', color: 'default' });
  });

  it('shows a missing reason as Ended', () => {
    expect(resultChipFor(buildRow({ endReason: null }))).toEqual({ label: 'Ended', color: 'default' });
  });
});

describe('STREAM_STATUS_OPTIONS', () => {
  it('leads with the in-progress pseudo status and lists every end reason', () => {
    expect(STREAM_STATUS_OPTIONS).toEqual(['in-progress', ...Object.keys(RESULT_CHIPS)]);
  });
});

describe('formatDuration', () => {
  it('shows minutes, seconds and milliseconds', () => {
    expect(formatDuration(buildRow())).toBe('1:05.250');
  });

  it('shows a sub-second session as 0:00 with milliseconds', () => {
    expect(formatDuration(buildRow({ endedAt: '2026-03-10T12:00:00.420Z' }))).toBe('0:00.420');
  });

  it('adds hours with padded minutes', () => {
    expect(formatDuration(buildRow({ endedAt: '2026-03-10T14:05:09.007Z' }))).toBe('2:05:09.007');
  });

  it('never goes negative', () => {
    expect(formatDuration(buildRow({ endedAt: '2026-03-10T11:00:00Z' }))).toBe('0:00.000');
  });

  it('measures a running stream up to now', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-10T12:00:10.000Z'));
    try {
      expect(formatDuration(buildRow({ endedAt: null }))).toBe('0:10.000');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('formatStartedParts / formatStarted', () => {
  it('omits the year for the current year', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-01T00:00:00Z'));
    try {
      expect(formatStartedParts('2026-03-10T12:00:00.123Z').date).not.toContain('2026');
    } finally {
      jest.useRealTimers();
    }
  });

  it('includes the year for another year', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-01T00:00:00Z'));
    try {
      expect(formatStartedParts('2024-03-10T12:00:00.123Z').date).toContain('2024');
    } finally {
      jest.useRealTimers();
    }
  });

  it('includes fractional seconds in the time', () => {
    expect(formatStartedParts('2026-03-10T12:00:00.123Z').time).toMatch(/:\d{2}\.123/);
  });

  it('formats the single-line form with milliseconds', () => {
    expect(formatStarted('2026-03-10T12:00:00.123Z')).toMatch(/\.123/);
  });
});

describe('StreamHistoryTable', () => {
  const renderTable = (rows: StreamHistoryRow[], selectedIds: string[] = []) => {
    const onToggleSelect = jest.fn();
    const onSelectAll = jest.fn();
    renderWithProviders(<StreamHistoryTable rows={rows} selectedIds={selectedIds} onToggleSelect={onToggleSelect} onSelectAll={onSelectAll} />);
    return { onToggleSelect, onSelectAll };
  };

  it('shows the column headings', () => {
    renderTable([buildRow()]);

    for (const heading of ['Video', 'Client', 'Started', 'Duration', 'Total', 'Result']) {
      expect(screen.getByRole('columnheader', { name: heading })).toBeInTheDocument();
    }
  });

  it('shows a row per session', () => {
    renderTable([buildRow(), buildRow({ streamId: 's2', title: 'Other' })]);

    expect(screen.getAllByRole('row')).toHaveLength(3);
  });

  it('links the title to YouTube', () => {
    renderTable([buildRow()]);

    const link = screen.getByRole('link', { name: 'A Video' });
    expect(link).toHaveAttribute('href', 'https://www.youtube.com/watch?v=abc123DEF45');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('shows the video id when there is no title', () => {
    renderTable([buildRow({ title: null })]);

    expect(screen.getByRole('link', { name: 'abc123DEF45' })).toBeInTheDocument();
  });

  it('shows the cached thumbnail', () => {
    renderTable([buildRow()]);

    expect(screen.getByRole('img', { name: 'A Video' })).toHaveAttribute('src', '/images/videothumb-abc123DEF45.jpg');
  });

  it('shows a short mode label', () => {
    renderTable([buildRow({ mode: 'hls-buffer' })]);

    expect(screen.getByText('HLS+Buf')).toBeInTheDocument();
  });

  it('shows the client ip and a friendly client name', () => {
    renderTable([buildRow()]);

    expect(screen.getByText('10.0.0.5')).toBeInTheDocument();
    expect(screen.getByText('Jellyfin')).toBeInTheDocument();
  });

  it('shows an unknown client when no user agent was reported', () => {
    renderTable([buildRow({ userAgent: null })]);

    expect(screen.getByText('Unknown client')).toBeInTheDocument();
  });

  it('shows the duration and total bytes', () => {
    renderTable([buildRow()]);

    expect(screen.getByText('1:05.250')).toBeInTheDocument();
    expect(screen.getByText('5.0 MB')).toBeInTheDocument();
  });

  it('shows zero bytes when none were recorded', () => {
    renderTable([buildRow({ bytesTransferred: null as unknown as number })]);

    expect(screen.getByText('0 B')).toBeInTheDocument();
  });

  it('shows the result chip', () => {
    renderTable([buildRow({ endReason: 'client-disconnected' })]);

    expect(screen.getByText('Disconnected')).toBeInTheDocument();
  });

  it('shows the error message in a tooltip on the result chip', async () => {
    renderTable([buildRow({ endReason: 'error', errorMessage: 'yt-dlp exploded' })]);

    await userEvent.hover(screen.getByText('Error'));

    expect((await screen.findAllByText('yt-dlp exploded')).length).toBeGreaterThan(0);
  });

  describe('selection', () => {
    it('reflects the selected rows', () => {
      renderTable([buildRow(), buildRow({ streamId: 's2', title: 'Other' })], ['s2']);

      expect(screen.getByRole('checkbox', { name: 'Select A Video' })).not.toBeChecked();
      expect(screen.getByRole('checkbox', { name: 'Select Other' })).toBeChecked();
    });

    it('toggles a row', async () => {
      const { onToggleSelect } = renderTable([buildRow()]);

      await userEvent.click(screen.getByRole('checkbox', { name: 'Select A Video' }));

      expect(onToggleSelect).toHaveBeenCalledWith('s1');
    });

    it('labels a row by its id when it has no title', () => {
      renderTable([buildRow({ title: null })]);

      expect(screen.getByRole('checkbox', { name: 'Select abc123DEF45' })).toBeInTheDocument();
    });

    it('selects everything from the header', async () => {
      const { onSelectAll } = renderTable([buildRow()]);

      await userEvent.click(screen.getByRole('checkbox', { name: 'Select all history entries' }));

      expect(onSelectAll).toHaveBeenCalledWith(true);
    });

    it('shows the header as checked when every row is selected', () => {
      renderTable([buildRow()], ['s1']);

      expect(screen.getByRole('checkbox', { name: 'Select all history entries' })).toBeChecked();
    });

    it('deselects everything from a checked header', async () => {
      const { onSelectAll } = renderTable([buildRow()], ['s1']);

      await userEvent.click(screen.getByRole('checkbox', { name: 'Select all history entries' }));

      expect(onSelectAll).toHaveBeenCalledWith(false);
    });

    it('shows the header as mixed when only some rows are selected', () => {
      renderTable([buildRow(), buildRow({ streamId: 's2' })], ['s1']);

      expect(screen.getByRole('checkbox', { name: 'Select all history entries' })).toBePartiallyChecked();
    });
  });
});

describe('DeleteStreamHistoryDialog', () => {
  const renderDialog = (entryCount: number, open = true) => {
    const onClose = jest.fn();
    const onConfirm = jest.fn();
    renderWithProviders(<DeleteStreamHistoryDialog open={open} onClose={onClose} onConfirm={onConfirm} entryCount={entryCount} />);
    return { onClose, onConfirm };
  };

  it('renders nothing when closed', () => {
    renderDialog(2, false);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('uses the singular for one entry', () => {
    renderDialog(1);

    expect(screen.getByText('Delete History Entry')).toBeInTheDocument();
    expect(screen.getByText(/permanently delete 1 stream history entry\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Entry' })).toBeInTheDocument();
  });

  it('uses the plural for several entries', () => {
    renderDialog(3);

    expect(screen.getByText('Delete History Entries')).toBeInTheDocument();
    expect(screen.getByText(/permanently delete 3 stream history entries\./)).toBeInTheDocument();
  });

  it('says the video files are not affected', () => {
    renderDialog(2);

    expect(screen.getByText(/doesn.t affect the video files themselves/)).toBeInTheDocument();
  });

  it('cancels', async () => {
    const { onClose, onConfirm } = renderDialog(2);

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('confirms', async () => {
    const { onConfirm } = renderDialog(2);

    await userEvent.click(screen.getByRole('button', { name: 'Delete Entries' }));

    expect(onConfirm).toHaveBeenCalled();
  });
});
