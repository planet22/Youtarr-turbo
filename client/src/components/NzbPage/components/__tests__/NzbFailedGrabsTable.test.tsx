import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import NzbFailedGrabsTable from '../NzbFailedGrabsTable';
import { NzbFailedGrab } from '../../../../hooks/useNzbStats';

jest.mock('../../../../hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
}));

const grab: NzbFailedGrab = {
  jobId: 'job-1',
  categoryName: 'tv',
  youtubeId: 'abc123',
  nzbName: 'Some Show S01E01',
  message: 'Completed with no video file produced',
  timestamp: Date.now() - 2 * 60 * 1000,
};

describe('NzbFailedGrabsTable', () => {
  test('hides the Delete all button when there are no failed grabs', () => {
    render(<MemoryRouter><NzbFailedGrabsTable grabs={[]} onDeleteAll={jest.fn()} /></MemoryRouter>);
    expect(screen.queryByRole('button', { name: /delete all/i })).not.toBeInTheDocument();
  });

  test('asks for confirmation before deleting', async () => {
    const onDeleteAll = jest.fn().mockResolvedValue(undefined);
    render(<MemoryRouter><NzbFailedGrabsTable grabs={[grab]} onDeleteAll={onDeleteAll} /></MemoryRouter>);
    await userEvent.click(screen.getByRole('button', { name: /delete all/i }));
    expect(screen.getByText('Delete all failed grabs?')).toBeInTheDocument();
    expect(onDeleteAll).not.toHaveBeenCalled();
  });

  test('calls onDeleteAll once the deletion is confirmed', async () => {
    const onDeleteAll = jest.fn().mockResolvedValue(undefined);
    render(<MemoryRouter><NzbFailedGrabsTable grabs={[grab]} onDeleteAll={onDeleteAll} /></MemoryRouter>);
    await userEvent.click(screen.getByRole('button', { name: /delete all/i }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /delete all/i }));
    await waitFor(() => expect(onDeleteAll).toHaveBeenCalledTimes(1));
  });

  test('does not delete when the confirmation is cancelled', async () => {
    const onDeleteAll = jest.fn().mockResolvedValue(undefined);
    render(<MemoryRouter><NzbFailedGrabsTable grabs={[grab]} onDeleteAll={onDeleteAll} /></MemoryRouter>);
    await userEvent.click(screen.getByRole('button', { name: /delete all/i }));
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onDeleteAll).not.toHaveBeenCalled();
  });

  test('lists the most recent failure first', () => {
    const older = { ...grab, jobId: 'job-old', nzbName: 'Older Show', timestamp: Date.now() - 3 * 60 * 60 * 1000 };
    const newer = { ...grab, jobId: 'job-new', nzbName: 'Newer Show', timestamp: Date.now() - 60 * 1000 };
    render(<MemoryRouter><NzbFailedGrabsTable grabs={[older, newer]} onDeleteAll={jest.fn()} /></MemoryRouter>);
    const links = screen.getAllByRole('link').map((l) => l.textContent);
    expect(links).toEqual(['Newer Show', 'Older Show']);
  });

  test('shows the relative time of the failure', () => {
    render(<MemoryRouter><NzbFailedGrabsTable grabs={[grab]} onDeleteAll={jest.fn()} /></MemoryRouter>);
    expect(screen.getByText('2m ago')).toBeInTheDocument();
  });
  test('links the grab to its job in the Event Log', () => {
    render(
      <MemoryRouter>
        <NzbFailedGrabsTable grabs={[grab]} onDeleteAll={jest.fn()} />
      </MemoryRouter>
    );
    expect(screen.getByRole('link', { name: 'Some Show S01E01' })).toHaveAttribute(
      'href',
      '/downloads/log?job=job-1'
    );
  });

  test('renders every failed video from a job that failed multiple videos', () => {
    // A single job can produce several failed grabs (e.g. a multi-episode
    // release) sharing one jobId - each video must still render as its own row.
    const first = { ...grab, youtubeId: 'video-1', nzbName: 'Show S01E01' };
    const second = { ...grab, youtubeId: 'video-2', nzbName: 'Show S01E02' };
    render(<MemoryRouter><NzbFailedGrabsTable grabs={[first, second]} onDeleteAll={jest.fn()} /></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'Show S01E01' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Show S01E02' })).toBeInTheDocument();
  });

  test('does not warn about duplicate React keys for byte-identical grab entries', () => {
    // Server-side, the same jobId+youtubeId can genuinely be recorded twice
    // (e.g. a restart resetting the persisted-dedup check) - rows must still
    // get distinct render keys even when every field is identical.
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const rows = [grab, { ...grab }, { ...grab }];
    render(<MemoryRouter><NzbFailedGrabsTable grabs={rows} onDeleteAll={jest.fn()} /></MemoryRouter>);
    expect(screen.getAllByRole('link', { name: 'Some Show S01E01' })).toHaveLength(3);
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('same key'), expect.anything());
    errorSpy.mockRestore();
  });
});
