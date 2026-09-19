import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import JobQueueTable from '../JobQueueTable';
import WebSocketContext from '../../../contexts/WebSocketContext';
import { Job } from '../../../types/Job';

const mockSubscribe = jest.fn();
const mockUnsubscribe = jest.fn();

const mockWebSocketContextValue = {
  subscribe: mockSubscribe,
  unsubscribe: mockUnsubscribe,
  socket: null,
  isConnected: false,
};

const renderWithContext = (component: React.ReactElement) =>
  render(
    <WebSocketContext.Provider value={mockWebSocketContextValue}>
      {component}
    </WebSocketContext.Provider>
  );

const buildJob = (overrides: Partial<Job> = {}): Job => ({
  id: 'job-1',
  jobType: 'Manually Added Urls',
  status: 'Pending',
  output: '',
  timeCreated: Date.now(),
  timeInitiated: Date.now(),
  data: { videos: [] },
  ...overrides,
});

describe('JobQueueTable', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ paused: false }),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('shows an empty state when there are no pending jobs', async () => {
    renderWithContext(<JobQueueTable pendingJobs={[]} token="test-token" />);

    expect(screen.getByText('Nothing queued right now.')).toBeInTheDocument();
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/jobs/queue-state',
        expect.objectContaining({ headers: expect.any(Object) })
      );
    });
  });

  test('marks the first row as Next up and the rest as Queued #N', () => {
    const jobs = [
      buildJob({ id: 'job-1', jobType: 'Channel Downloads' }),
      buildJob({ id: 'job-2', jobType: 'Manually Added Urls' }),
    ];

    renderWithContext(<JobQueueTable pendingJobs={jobs} token="test-token" />);

    expect(screen.getByText('Next up')).toBeInTheDocument();
    expect(screen.getByText('Queued #2')).toBeInTheDocument();
  });

  test('shows video/url count details for a manual download job', () => {
    const jobs = [
      buildJob({
        id: 'job-1',
        jobType: 'Manually Added Urls',
        data: { videos: [], urls: ['https://www.youtube.com/watch?v=abc12345678'] },
      }),
    ];

    renderWithContext(<JobQueueTable pendingJobs={jobs} token="test-token" />);

    expect(screen.getByText('1 video from URL')).toBeInTheDocument();
  });

  test('up arrow is disabled on the first row and down arrow disabled on the last', () => {
    const jobs = [buildJob({ id: 'job-1' }), buildJob({ id: 'job-2' })];

    renderWithContext(<JobQueueTable pendingJobs={jobs} token="test-token" />);

    const upButtons = screen.getAllByLabelText('Move up in queue');
    expect(upButtons[0]).toBeDisabled();
    const downButtons = screen.getAllByLabelText('Move down in queue');
    expect(downButtons[downButtons.length - 1]).toBeDisabled();
  });

  test('clicking the down arrow on the first row PATCHes the swapped order', async () => {
    const user = userEvent.setup();
    const jobs = [buildJob({ id: 'job-1' }), buildJob({ id: 'job-2' })];
    const mockFetch = global.fetch as jest.Mock;
    mockFetch.mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue({}) });

    renderWithContext(<JobQueueTable pendingJobs={jobs} token="test-token" />);

    const downButtons = screen.getAllByLabelText('Move down in queue');
    await user.click(downButtons[0]);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/jobs/queue/reorder',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ orderedIds: ['job-2', 'job-1'] }),
        })
      );
    });
  });

  test('clicking delete calls the remove endpoint for that job', async () => {
    const user = userEvent.setup();
    const jobs = [buildJob({ id: 'job-1' })];
    const mockFetch = global.fetch as jest.Mock;
    mockFetch.mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue({}) });

    renderWithContext(<JobQueueTable pendingJobs={jobs} token="test-token" />);

    await user.click(screen.getByLabelText('Remove job from queue'));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/jobs/job-1',
        expect.objectContaining({ method: 'DELETE' })
      );
    });
  });

  test('pause button calls the pause endpoint and flips to Resume Queue', async () => {
    const user = userEvent.setup();
    const mockFetch = global.fetch as jest.Mock;
    mockFetch.mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue({ paused: false }) });

    renderWithContext(<JobQueueTable pendingJobs={[]} token="test-token" />);

    const pauseButton = await screen.findByText('Pause Queue');
    await user.click(pauseButton);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/jobs/queue/pause',
        expect.objectContaining({ method: 'POST' })
      );
    });
    await waitFor(() => {
      expect(screen.getByText('Resume Queue')).toBeInTheDocument();
    });
  });

  test('shows a paused banner when the initial queue state is paused', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ paused: true }),
    });

    renderWithContext(<JobQueueTable pendingJobs={[]} token="test-token" />);

    await waitFor(() => {
      expect(
        screen.getByText(/the next job will not start automatically/i)
      ).toBeInTheDocument();
    });
  });

  test('shows the running job as a pinned "Running now" row even with nothing queued', () => {
    const active = buildJob({ id: 'job-active', status: 'In Progress', jobType: 'Channel Downloads' });

    renderWithContext(<JobQueueTable pendingJobs={[]} activeJob={active} token="test-token" />);

    expect(screen.getByText('Running now')).toBeInTheDocument();
    expect(screen.queryByText('Nothing queued right now.')).not.toBeInTheDocument();
  });

  test('has no expand chevron for a job with no known video URLs', () => {
    const jobs = [buildJob({ id: 'job-1', jobType: 'Channel Downloads', data: { videos: [] } })];

    renderWithContext(<JobQueueTable pendingJobs={jobs} token="test-token" />);

    expect(screen.queryByLabelText('Expand video list')).not.toBeInTheDocument();
  });

  test('expanding a pending job with URLs shows its videos, and delete removes one via PATCH', async () => {
    const user = userEvent.setup();
    const jobs = [
      buildJob({
        id: 'job-1',
        data: {
          videos: [],
          urls: [
            'https://www.youtube.com/watch?v=aaaaaaaaaaa',
            'https://www.youtube.com/watch?v=bbbbbbbbbbb',
          ],
        },
      }),
    ];
    const mockFetch = global.fetch as jest.Mock;
    mockFetch.mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue({}) });

    renderWithContext(<JobQueueTable pendingJobs={jobs} token="test-token" />);

    await user.click(screen.getByLabelText('Expand video list'));

    expect(screen.getByText('aaaaaaaaaaa')).toBeInTheDocument();
    expect(screen.getByText('bbbbbbbbbbb')).toBeInTheDocument();

    const removeButtons = screen.getAllByLabelText('Remove video from job');
    await user.click(removeButtons[0]);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/jobs/job-1/videos',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ urls: ['https://www.youtube.com/watch?v=bbbbbbbbbbb'] }),
        })
      );
    });
  });

  test('the last remaining video in a job cannot be removed from the expansion', async () => {
    const user = userEvent.setup();
    const jobs = [
      buildJob({
        id: 'job-1',
        data: { videos: [], urls: ['https://www.youtube.com/watch?v=aaaaaaaaaaa'] },
      }),
    ];

    renderWithContext(<JobQueueTable pendingJobs={jobs} token="test-token" />);

    await user.click(screen.getByLabelText('Expand video list'));

    expect(screen.getByLabelText('Remove video from job')).toBeDisabled();
  });

  test('the running job\'s expansion is read-only (no move/remove controls) and shows per-video status', async () => {
    const user = userEvent.setup();
    const active = buildJob({
      id: 'job-active',
      status: 'In Progress',
      data: {
        videos: [{ youtubeId: 'aaaaaaaaaaa' } as any],
        failedVideos: [{ youtubeId: 'bbbbbbbbbbb', error: 'boom' } as any],
        urls: [
          'https://www.youtube.com/watch?v=aaaaaaaaaaa',
          'https://www.youtube.com/watch?v=bbbbbbbbbbb',
          'https://www.youtube.com/watch?v=ccccccccccc',
        ],
      },
    });

    renderWithContext(<JobQueueTable pendingJobs={[]} activeJob={active} token="test-token" />);

    await user.click(screen.getByLabelText('Expand video list'));

    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.queryByLabelText('Remove video from job')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Move video up')).not.toBeInTheDocument();
  });

  const buildStrmActiveJob = (overrides: Partial<Job> = {}) =>
    buildJob({
      id: 'job-strm',
      status: 'In Progress',
      data: {
        videos: [{ youtubeId: 'aaaaaaaaaaa' } as any],
        failedVideos: [],
        urls: [
          'https://www.youtube.com/watch?v=aaaaaaaaaaa',
          'https://www.youtube.com/watch?v=bbbbbbbbbbb',
          'https://www.youtube.com/watch?v=ccccccccccc',
        ],
        isStrmBatch: true,
      },
      ...overrides,
    });

  test('an active STRM job shows a Pause control and calls the pause endpoint', async () => {
    const user = userEvent.setup();
    const active = buildStrmActiveJob();
    const mockFetch = global.fetch as jest.Mock;
    mockFetch.mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue({ paused: false }) });

    renderWithContext(<JobQueueTable pendingJobs={[]} activeJob={active} token="test-token" />);

    await user.click(screen.getByLabelText('Expand video list'));

    // Done video (aaaaaaaaaaa) has no move/remove controls; the two Pending
    // ones (bbbbbbbbbbb, ccccccccccc) do - but disabled until paused (the
    // batch is still actively consuming its queue, so editing it live would
    // race whichever video starts next).
    const downButtons = screen.getAllByLabelText('Move video down');
    expect(downButtons).toHaveLength(2);
    expect(downButtons[0]).toBeDisabled();

    await user.click(screen.getByText('Pause'));
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/jobs/job-strm/strm/pause',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  test('an active STRM job shows Resume and a paused notice when already paused, with editing enabled', async () => {
    const active = buildStrmActiveJob({ data: { ...buildStrmActiveJob().data, strmPaused: true } });

    renderWithContext(<JobQueueTable pendingJobs={[]} activeJob={active} token="test-token" />);

    await userEvent.setup().click(screen.getByLabelText('Expand video list'));

    expect(screen.getByText('Resume')).toBeInTheDocument();
    expect(screen.getByText(/will not fetch the next video until resumed/i)).toBeInTheDocument();
    expect(screen.getAllByLabelText('Move video down')[0]).toBeEnabled();
  });

  test('once paused, reordering a Pending video in an active STRM job PATCHes the swapped remaining set', async () => {
    const user = userEvent.setup();
    const active = buildStrmActiveJob({ data: { ...buildStrmActiveJob().data, strmPaused: true } });
    const mockFetch = global.fetch as jest.Mock;
    mockFetch.mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue({}) });

    renderWithContext(<JobQueueTable pendingJobs={[]} activeJob={active} token="test-token" />);

    await user.click(screen.getByLabelText('Expand video list'));
    const downButtons = screen.getAllByLabelText('Move video down');
    await user.click(downButtons[0]);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/jobs/job-strm/strm/videos',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({
            urls: [
              'https://www.youtube.com/watch?v=ccccccccccc',
              'https://www.youtube.com/watch?v=bbbbbbbbbbb',
            ],
          }),
        })
      );
    });
  });

  test('once paused, removing a Pending video from an active STRM job PATCHes the remaining set without the Done video', async () => {
    const user = userEvent.setup();
    const active = buildStrmActiveJob({ data: { ...buildStrmActiveJob().data, strmPaused: true } });
    const mockFetch = global.fetch as jest.Mock;
    mockFetch.mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue({}) });

    renderWithContext(<JobQueueTable pendingJobs={[]} activeJob={active} token="test-token" />);

    await user.click(screen.getByLabelText('Expand video list'));
    const removeButtons = screen.getAllByLabelText('Remove video from job');
    await user.click(removeButtons[0]);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/jobs/job-strm/strm/videos',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ urls: ['https://www.youtube.com/watch?v=ccccccccccc'] }),
        })
      );
    });
  });
});
