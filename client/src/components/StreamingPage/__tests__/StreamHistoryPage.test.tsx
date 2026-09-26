import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import StreamHistoryPage from '../StreamHistoryPage';
import { StreamHistoryRow } from '../../../hooks/useStreamHistory';
import { renderWithProviders } from '../../../test-utils';

let mockIsMobile = false;
const mockUseStreamHistory = jest.fn();

jest.mock('../../../hooks/useMediaQuery', () => ({
  useMediaQuery: () => mockIsMobile,
}));
jest.mock('../../../hooks/useStreamHistory', () => ({
  useStreamHistory: (...args: unknown[]) => mockUseStreamHistory(...args),
}));

const buildRow = (overrides: Partial<StreamHistoryRow> = {}): StreamHistoryRow => ({
  streamId: 's1',
  youtubeId: 'abc123DEF45',
  title: 'First Video',
  mode: 'hls',
  quality: '1080',
  container: 'mp4',
  transcode: 'copy',
  hardwareMode: null,
  clientIp: '10.0.0.5',
  userAgent: 'Jellyfin',
  startedAt: '2026-03-10T12:00:00.000Z',
  endedAt: '2026-03-10T12:01:00.000Z',
  bytesTransferred: 1024,
  endReason: 'completed',
  errorMessage: null,
  ...overrides,
});

const rows = [buildRow(), buildRow({ streamId: 's2', youtubeId: 'zzzzzzzzzzz', title: 'Second Video' })];

interface HookResult {
  rows?: StreamHistoryRow[];
  total?: number;
  loading?: boolean;
  deleteResult?: { success: boolean; deleted: number };
}

function renderPage(result: HookResult = {}) {
  const refetch = jest.fn();
  const deleteEntries = jest.fn().mockResolvedValue(result.deleteResult ?? { success: true, deleted: 2 });
  mockUseStreamHistory.mockReturnValue({
    rows: result.rows ?? rows,
    total: result.total ?? (result.rows ?? rows).length,
    loading: result.loading ?? false,
    refetch,
    deleteEntries,
  });
  renderWithProviders(<StreamHistoryPage token="tok" />);
  return { refetch, deleteEntries };
}

const lastCall = () => mockUseStreamHistory.mock.calls[mockUseStreamHistory.mock.calls.length - 1];

describe('StreamHistoryPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsMobile = false;
    window.localStorage.clear();
  });

  describe('content', () => {
    it('shows the session count in the heading', () => {
      renderPage();

      expect(screen.getByText('Stream History (2 sessions)')).toBeInTheDocument();
    });

    it('uses the singular for one session', () => {
      renderPage({ rows: [buildRow()] });

      expect(screen.getByText('Stream History (1 session)')).toBeInTheDocument();
    });

    it('lists the sessions in a table on desktop', () => {
      renderPage();

      expect(screen.getByRole('table')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'First Video' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Second Video' })).toBeInTheDocument();
    });

    it('says when there is no streaming activity yet', () => {
      renderPage({ rows: [] });

      expect(screen.getByText('No streaming activity yet.')).toBeInTheDocument();
    });

    it('passes the token to the history hook', () => {
      renderPage();

      expect(lastCall()[0]).toBe('tok');
    });

    it('starts on page 1 with the default page size and no filters', () => {
      renderPage();

      const [, page, pageSize, filters] = lastCall();
      expect(page).toBe(1);
      expect(pageSize).toEqual(expect.any(Number));
      expect(filters).toEqual({ mode: undefined, status: undefined, search: undefined, dateFrom: undefined, dateTo: undefined });
    });
  });

  describe('mobile', () => {
    beforeEach(() => {
      mockIsMobile = true;
    });

    it('lists sessions as dense rows rather than a table', () => {
      renderPage();

      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      expect(screen.getByText('First Video')).toBeInTheDocument();
    });
  });

  describe('search', () => {
    it('searches server-side using the trimmed text', async () => {
      renderPage();

      await userEvent.type(screen.getByPlaceholderText('Search by video, IP, or client...'), '  cats ');

      await waitFor(() => expect(lastCall()[3]).toMatchObject({ search: 'cats' }));
    });

    it('explains an empty result set when filtered', async () => {
      renderPage({ rows: [] });

      await userEvent.type(screen.getByPlaceholderText('Search by video, IP, or client...'), 'nothing');

      expect(await screen.findByText('No sessions found matching your filters')).toBeInTheDocument();
    });
  });

  describe('selection and deleting', () => {
    it('offers no delete until something is selected', () => {
      renderPage();

      expect(screen.queryByRole('button', { name: /selected/ })).not.toBeInTheDocument();
    });

    it('offers to delete the selected sessions', async () => {
      renderPage();

      await userEvent.click(screen.getByRole('checkbox', { name: 'Select First Video' }));

      expect(screen.getByRole('button', { name: 'Delete 1 selected' })).toBeInTheDocument();
    });

    it('selects every row from the header checkbox', async () => {
      renderPage();

      await userEvent.click(screen.getByRole('checkbox', { name: 'Select all history entries' }));

      expect(screen.getByRole('button', { name: 'Delete 2 selected' })).toBeInTheDocument();
    });

    it('deselects everything from the header checkbox', async () => {
      renderPage();
      await userEvent.click(screen.getByRole('checkbox', { name: 'Select all history entries' }));

      await userEvent.click(screen.getByRole('checkbox', { name: 'Select all history entries' }));

      expect(screen.queryByRole('button', { name: /selected/ })).not.toBeInTheDocument();
    });

    it('deselects a single row', async () => {
      renderPage();
      await userEvent.click(screen.getByRole('checkbox', { name: 'Select First Video' }));

      await userEvent.click(screen.getByRole('checkbox', { name: 'Select First Video' }));

      expect(screen.queryByRole('button', { name: /selected/ })).not.toBeInTheDocument();
    });

    it('asks for confirmation before deleting', async () => {
      const { deleteEntries } = renderPage();
      await userEvent.click(screen.getByRole('checkbox', { name: 'Select First Video' }));

      await userEvent.click(screen.getByRole('button', { name: 'Delete 1 selected' }));

      expect(await screen.findByRole('dialog')).toBeInTheDocument();
      expect(deleteEntries).not.toHaveBeenCalled();
    });

    it('does not delete when the dialog is cancelled', async () => {
      const { deleteEntries } = renderPage();
      await userEvent.click(screen.getByRole('checkbox', { name: 'Select First Video' }));
      await userEvent.click(screen.getByRole('button', { name: 'Delete 1 selected' }));

      await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

      expect(deleteEntries).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('deletes the selected sessions once confirmed and refreshes', async () => {
      const { deleteEntries, refetch } = renderPage();
      await userEvent.click(screen.getByRole('checkbox', { name: 'Select all history entries' }));
      await userEvent.click(screen.getByRole('button', { name: 'Delete 2 selected' }));

      await userEvent.click(await screen.findByRole('button', { name: 'Delete Entries' }));

      await waitFor(() => expect(deleteEntries).toHaveBeenCalledWith(['s1', 's2']));
      await waitFor(() => expect(refetch).toHaveBeenCalled());
    });

    it('clears the selection after a successful delete', async () => {
      renderPage();
      await userEvent.click(screen.getByRole('checkbox', { name: 'Select First Video' }));
      await userEvent.click(screen.getByRole('button', { name: 'Delete 1 selected' }));

      await userEvent.click(await screen.findByRole('button', { name: 'Delete Entry' }));

      await waitFor(() => expect(screen.queryByRole('button', { name: /selected/ })).not.toBeInTheDocument());
    });

    it('keeps the selection and does not refresh when the delete fails', async () => {
      const { refetch, deleteEntries } = renderPage({ deleteResult: { success: false, deleted: 0 } });
      await userEvent.click(screen.getByRole('checkbox', { name: 'Select First Video' }));
      await userEvent.click(screen.getByRole('button', { name: 'Delete 1 selected' }));

      await userEvent.click(await screen.findByRole('button', { name: 'Delete Entry' }));

      await waitFor(() => expect(deleteEntries).toHaveBeenCalled());
      expect(refetch).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Delete 1 selected' })).toBeInTheDocument();
    });
  });
});
