import React from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import NzbJobsSection from '../NzbJobsSection';
import { renderWithProviders } from '../../../../test-utils';
import type { NzbJobsSnapshot } from '../../../../hooks/useNzbStats';

let mockIsMobile = false;
jest.mock('../../../../hooks/useMediaQuery', () => ({
  useMediaQuery: () => mockIsMobile,
}));

const active = (overrides: Record<string, unknown> = {}) => ({
  jobId: 'a1',
  nzbName: 'Some.Show.S01E01',
  categoryName: 'tv',
  status: 'Downloading',
  percent: 42,
  etaSeconds: 125,
  isCurrent: true,
  ...overrides,
});

const history = (overrides: Record<string, unknown> = {}) => ({
  jobId: 'h1',
  nzbName: 'Old.Movie',
  categoryName: 'movies',
  status: 'Completed',
  bytes: 1048576,
  ...overrides,
});

const snapshot = (a: unknown[] = [], h: unknown[] = []): NzbJobsSnapshot => ({ active: a, history: h } as NzbJobsSnapshot);

const setup = (jobs: NzbJobsSnapshot | null, onCancelCurrentJob = jest.fn().mockResolvedValue(undefined)) => {
  renderWithProviders(<NzbJobsSection jobs={jobs} onCancelCurrentJob={onCancelCurrentJob} />);
  return { onCancelCurrentJob, user: userEvent.setup() };
};

describe.each([
  ['desktop tables', false],
  ['mobile lists', true],
])('NzbJobsSection (%s)', (_label, isMobile) => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsMobile = isMobile;
  });

  describe('empty states', () => {
    it.each([[null], [snapshot()]])('says nothing is queued or finished for %p', (jobs) => {
      setup(jobs);

      expect(screen.getByText('Nothing queued right now.')).toBeInTheDocument();
      expect(screen.getByText('Nothing in history yet.')).toBeInTheDocument();
    });

    it('always explains both sections', () => {
      setup(null);

      expect(screen.getByText('NZB Queue')).toBeInTheDocument();
      expect(screen.getByText('NZB History')).toBeInTheDocument();
    });
  });

  describe('the queue', () => {
    it('lists each job by name with its category', () => {
      setup(snapshot([active(), active({ jobId: 'a2', nzbName: 'Second', categoryName: 'movies', isCurrent: false, status: 'Queued' })]));

      expect(screen.getByText('Some.Show.S01E01')).toBeInTheDocument();
      expect(screen.getByText('Second')).toBeInTheDocument();
      expect(screen.getByText('tv')).toBeInTheDocument();
      expect(screen.getByText('movies')).toBeInTheDocument();
    });

    it('falls back to the job id when a job has no name', () => {
      setup(snapshot([active({ nzbName: '' })]));

      expect(screen.getByText('a1')).toBeInTheDocument();
    });

    it('shows the progress of the job that is downloading', () => {
      setup(snapshot([active()]));

      expect(screen.getByText('Downloading 42%')).toBeInTheDocument();
    });

    it('shows only the status of a job that is waiting', () => {
      setup(snapshot([active({ isCurrent: false, status: 'Queued' })]));

      expect(screen.getByText('Queued')).toBeInTheDocument();
      expect(screen.queryByText(/Queued \d/)).not.toBeInTheDocument();
    });

    it.each([
      [125, '2m 5s'],
      [59, '59s'],
      [60, '1m 0s'],
      [3600, '60m 0s'],
    ])('formats an ETA of %i seconds as %s', (seconds, expected) => {
      setup(snapshot([active({ etaSeconds: seconds })]));

      expect(screen.getByText(new RegExp(expected))).toBeInTheDocument();
    });

    it('shows a dash for an unknown ETA', () => {
      setup(snapshot([active({ etaSeconds: 0 })]));

      expect(screen.getByText(/ETA —|^—$/)).toBeInTheDocument();
    });

    it('offers Cancel only for the job that is downloading', () => {
      setup(snapshot([active(), active({ jobId: 'a2', isCurrent: false, status: 'Queued' })]));

      expect(screen.getAllByRole('button', { name: /Cancel/ })).toHaveLength(1);
    });

    it('cancels the current job', async () => {
      const { onCancelCurrentJob, user } = setup(snapshot([active()]));

      await user.click(screen.getByRole('button', { name: /Cancel/ }));

      expect(onCancelCurrentJob).toHaveBeenCalledTimes(1);
    });

    it('disables Cancel while the cancel request runs, then re-enables it', async () => {
      let resolve: () => void = () => {};
      const onCancel = jest.fn(() => new Promise<void>((r) => { resolve = r; }));
      const { user } = setup(snapshot([active()]), onCancel);

      await user.click(screen.getByRole('button', { name: /Cancel/ }));
      expect(screen.getByRole('button', { name: /Cancel/ })).toBeDisabled();
      resolve();

      await waitFor(() => expect(screen.getByRole('button', { name: /Cancel/ })).toBeEnabled());
    });
  });

  describe('the history', () => {
    it('lists each finished job with its category and size', () => {
      setup(snapshot([], [history()]));

      expect(screen.getByText('Old.Movie')).toBeInTheDocument();
      expect(screen.getByText('movies')).toBeInTheDocument();
      expect(screen.getByText('Completed')).toBeInTheDocument();
      expect(screen.getByText(/1(\.0+)? ?MB/i)).toBeInTheDocument();
    });

    it('falls back to the job id when a job has no name', () => {
      setup(snapshot([], [history({ nzbName: null })]));

      expect(screen.getByText('h1')).toBeInTheDocument();
    });

    it('shows a failed job with its status', () => {
      setup(snapshot([], [history({ status: 'Failed', bytes: 0 })]));

      expect(screen.getByText('Failed')).toBeInTheDocument();
    });

    it('leaves out the size when it is unknown', () => {
      setup(snapshot([], [history({ bytes: 0 })]));

      expect(screen.queryByText(/MB|KB|GB/i)).not.toBeInTheDocument();
    });
  });
});

describe('NzbJobsSection desktop table details', () => {
  beforeEach(() => {
    mockIsMobile = false;
  });

  it('shows a dash for a missing category', () => {
    setup(snapshot([active({ categoryName: '' })], [history({ categoryName: null })]));

    const rows = screen.getAllByRole('row');
    expect(rows.some((row) => within(row).queryByText('—'))).toBe(true);
  });

  it('shows a dash for the size of an unsized history job', () => {
    setup(snapshot([], [history({ bytes: 0 })]));

    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows a dash instead of an ETA for a job that is not running', () => {
    setup(snapshot([active({ isCurrent: false, status: 'Queued' })]));

    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});
