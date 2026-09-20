import React from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import NzbCachedQueriesTable from '../NzbCachedQueriesTable';
import { NzbCachedEntry } from '../../../../hooks/useNzbStats';
import { renderWithProviders } from '../../../../test-utils';

let mockIsMobile = false;
jest.mock('../../../../hooks/useMediaQuery', () => ({
  useMediaQuery: () => mockIsMobile,
}));

const buildEntry = (overrides: Partial<NzbCachedEntry> = {}): NzbCachedEntry => ({
  key: 'k1',
  query: 'cats',
  count: 3,
  source: 'yt-dlp',
  resultCount: 12,
  cachedAt: Date.now() - 2 * 60 * 1000,
  expiresAt: Date.now() + 125_000,
  expiresInMs: 125_000,
  settingsSnapshot: { backend: 'yt-dlp', cookiesEnabled: false, proxy: null, ipFamily: null, hasCustomArgs: false },
  ...overrides,
});

const entries = [
  buildEntry({ key: 'k1', query: 'cats' }),
  buildEntry({ key: 'k2', query: 'dogs', count: 1, resultCount: 4, expiresInMs: 0 }),
];

function renderTable(rows: NzbCachedEntry[] = entries, onDelete = jest.fn().mockResolvedValue(undefined)) {
  const utils = renderWithProviders(<NzbCachedQueriesTable entries={rows} onDelete={onDelete} />);
  return { ...utils, onDelete };
}

describe('NzbCachedQueriesTable', () => {
  beforeEach(() => {
    mockIsMobile = false;
  });

  describe('desktop table', () => {
    it('is titled and explains its purpose', () => {
      renderTable();

      expect(screen.getByText('Cached NZB Queries')).toBeInTheDocument();
      expect(screen.getByText(/Results reused for a repeat query/)).toBeInTheDocument();
    });

    it('shows an explanation when nothing is cached', () => {
      renderTable([]);

      expect(screen.getByText(/Nothing cached right now/)).toBeInTheDocument();
    });

    it('shows a row per cached query', () => {
      renderTable();

      expect(screen.getByText('cats')).toBeInTheDocument();
      expect(screen.getByText('dogs')).toBeInTheDocument();
    });

    it('labels a blank query as RSS mode', () => {
      renderTable([buildEntry({ query: '' })]);

      expect(screen.getByText('(blank / RSS mode)')).toBeInTheDocument();
    });

    it('shows the hit count, result count and expiry countdown', () => {
      renderTable([buildEntry({ count: 7, resultCount: 21, expiresInMs: 125_000 })]);

      const row = screen.getByRole('row', { name: /cats/ });
      expect(within(row).getByText('7')).toBeInTheDocument();
      expect(within(row).getByText('21')).toBeInTheDocument();
      expect(within(row).getByText('2m 5s')).toBeInTheDocument();
    });

    it('shows an expired entry as expired', () => {
      renderTable();

      expect(screen.getByText('expired')).toBeInTheDocument();
    });

    it('shows how long ago each entry was cached', () => {
      renderTable([buildEntry()]);

      expect(screen.getByText('2m ago')).toBeInTheDocument();
    });

    it('starts with nothing selected and no bulk delete button', () => {
      renderTable();

      expect(screen.queryByRole('button', { name: /selected/ })).not.toBeInTheDocument();
    });

    it('disables select-all when there are no entries', () => {
      renderTable([]);

      expect(screen.getAllByRole('checkbox')[0]).toBeDisabled();
    });

    it('selects a single entry', async () => {
      renderTable();

      await userEvent.click(screen.getAllByRole('checkbox')[1]);

      expect(screen.getByRole('button', { name: /Delete 1 selected/ })).toBeInTheDocument();
    });

    it('deselects an entry again', async () => {
      renderTable();
      await userEvent.click(screen.getAllByRole('checkbox')[1]);

      await userEvent.click(screen.getAllByRole('checkbox')[1]);

      expect(screen.queryByRole('button', { name: /selected/ })).not.toBeInTheDocument();
    });

    it('selects every entry from the header checkbox', async () => {
      renderTable();

      await userEvent.click(screen.getAllByRole('checkbox')[0]);

      expect(screen.getByRole('button', { name: /Delete 2 selected/ })).toBeInTheDocument();
    });

    it('clears the selection from the header checkbox when everything is selected', async () => {
      renderTable();
      await userEvent.click(screen.getAllByRole('checkbox')[0]);

      await userEvent.click(screen.getAllByRole('checkbox')[0]);

      expect(screen.queryByRole('button', { name: /selected/ })).not.toBeInTheDocument();
    });

    it('deletes the selected entries and then clears the selection', async () => {
      const { onDelete } = renderTable();
      await userEvent.click(screen.getAllByRole('checkbox')[0]);

      await userEvent.click(screen.getByRole('button', { name: /Delete 2 selected/ }));

      expect(onDelete).toHaveBeenCalledWith(['k1', 'k2']);
      await waitFor(() => expect(screen.queryByRole('button', { name: /selected/ })).not.toBeInTheDocument());
    });

    it('disables the bulk delete while it is running', async () => {
      const onDelete = jest.fn().mockReturnValue(new Promise(() => {}));
      renderTable(entries, onDelete);
      await userEvent.click(screen.getAllByRole('checkbox')[1]);

      await userEvent.click(screen.getByRole('button', { name: /Delete 1 selected/ }));

      expect(await screen.findByRole('button', { name: /Delete 1 selected/ })).toBeDisabled();
    });

    it('deletes a single entry from its row', async () => {
      const { onDelete } = renderTable();

      await userEvent.click(screen.getAllByRole('button', { name: 'Delete cached entry' })[1]);

      expect(onDelete).toHaveBeenCalledWith(['k2']);
    });

    it('drops a deleted entry from the selection', async () => {
      renderTable();
      await userEvent.click(screen.getAllByRole('checkbox')[1]);
      await userEvent.click(screen.getAllByRole('checkbox')[2]);

      await userEvent.click(screen.getAllByRole('button', { name: 'Delete cached entry' })[0]);

      expect(await screen.findByRole('button', { name: /Delete 1 selected/ })).toBeInTheDocument();
    });

    it('disables the row delete buttons while a delete is running', async () => {
      const onDelete = jest.fn().mockReturnValue(new Promise(() => {}));
      renderTable(entries, onDelete);

      await userEvent.click(screen.getAllByRole('button', { name: 'Delete cached entry' })[0]);

      await waitFor(() => expect(screen.getAllByRole('button', { name: 'Delete cached entry' })[1]).toBeDisabled());
    });
  });

  describe('mobile list', () => {
    beforeEach(() => {
      mockIsMobile = true;
    });

    it('shows an explanation when nothing is cached', () => {
      renderTable([]);

      expect(screen.getByText(/Nothing cached right now/)).toBeInTheDocument();
    });

    it('shows each entry with its stats as chips', () => {
      renderTable([buildEntry({ count: 3, resultCount: 12, expiresInMs: 125_000 })]);

      expect(screen.getByText('cats')).toBeInTheDocument();
      expect(screen.getByText('Count: 3')).toBeInTheDocument();
      expect(screen.getByText('Results: 12')).toBeInTheDocument();
      expect(screen.getByText('Expires: 2m 5s')).toBeInTheDocument();
      expect(screen.getByText('Cached 2m ago')).toBeInTheDocument();
    });

    it('labels a blank query as RSS mode', () => {
      renderTable([buildEntry({ query: '' })]);

      expect(screen.getByText('(blank / RSS mode)')).toBeInTheDocument();
    });

    it('does not render the desktop table', () => {
      renderTable();

      expect(screen.queryByRole('table')).not.toBeInTheDocument();
    });

    it('selects an entry and offers a bulk delete', async () => {
      renderTable();

      await userEvent.click(screen.getAllByRole('checkbox')[0]);

      expect(screen.getByRole('button', { name: /Delete 1 selected/ })).toBeInTheDocument();
    });

    it('deletes one entry from its card', async () => {
      const { onDelete } = renderTable();

      await userEvent.click(screen.getAllByRole('button', { name: 'Delete cached entry' })[0]);

      expect(onDelete).toHaveBeenCalledWith(['k1']);
    });
  });
});
