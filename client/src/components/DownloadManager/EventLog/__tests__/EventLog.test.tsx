import React from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import EventLog from '../index';
import WebSocketContext from '../../../../contexts/WebSocketContext';
import type { JobEvent, JobEventPage } from '../../../../types/JobEvent';

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));
const mockedGet = (axios as jest.Mocked<typeof axios>).get;

const event = (id: number, over: Partial<JobEvent> = {}): JobEvent => ({
  id,
  occurredAt: `2026-09-19T17:12:00.${String(id * 100).padStart(3, '0')}Z`,
  jobId: 'job-1',
  youtubeId: 'abc123',
  eventType: 'video.failed',
  level: 'error',
  actor: 'downloader',
  message: `Message ${id}`,
  detail: null,
  videoTitle: 'Celebrity Juice S26E09',
  channelName: 'pcrobec',
  jobType: 'Channel Downloads',
  source: 'Channels',
  isTracked: true,
  ...over,
});

const respond = (events: JobEvent[], total = events.length) => {
  mockedGet.mockImplementation((url: string) =>
    Promise.resolve({
      data: url === '/api/job-events/facets'
        ? { eventTypes: ['video.failed'], actors: ['downloader'], channels: ['pcrobec'], sources: ['NZB', 'Channels'] }
        : ({ events, total } as JobEventPage),
    })
  );
};

// Facets (dropdown options) are fetched too; these helpers look only at the list requests.
const listCalls = () => mockedGet.mock.calls.filter(([url]) => url === '/api/job-events');
const lastParams = () => listCalls()[listCalls().length - 1][1]?.params;

jest.mock('../../../shared/VideoModal', () => ({
  __esModule: true,
  default: ({ video, onClose, onVideoDeleted }: { video: { title: string }; onClose: () => void; onVideoDeleted: () => void }) =>
    require('react').createElement('div', { 'data-testid': 'video-modal' }, video.title,
      require('react').createElement('button', { onClick: onClose }, 'Close modal'),
      require('react').createElement('button', { onClick: onVideoDeleted }, 'Delete video')),
}));

type Filter = (message: { destination?: string; type?: string }) => boolean;
type Callback = (data: unknown) => void;

describe('EventLog page', () => {
  let subscriptions: Array<{ filter: Filter; callback: Callback }>;

  const renderPage = (initialEntry = '/downloads/log') =>
    render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <WebSocketContext.Provider
          value={{
            socket: null,
            isConnected: false,
            subscribe: (filter: Filter, callback: Callback) => { subscriptions.push({ filter, callback }); },
            unsubscribe: (callback: Callback) => { subscriptions = subscriptions.filter((s) => s.callback !== callback); },
          }}
        >
          <EventLog token="tok" />
        </WebSocketContext.Provider>
      </MemoryRouter>
    );

  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    subscriptions = [];
    respond([]);
  });

  test('shows the recorded events', async () => {
    respond([event(2), event(1)]);
    renderPage();

    expect(await screen.findByText('Message 2')).toBeInTheDocument();
    expect(screen.getByText('Message 1')).toBeInTheDocument();
  });

  test('shows the total in the heading', async () => {
    respond([event(2), event(1)], 250);
    renderPage();

    expect(await screen.findByText(/Video \/ Events Log \(250 events\)/)).toBeInTheDocument();
  });

  test('says nothing has been recorded when the log is empty', async () => {
    renderPage();

    expect(await screen.findByText('No events recorded yet')).toBeInTheDocument();
  });

  test('says nothing matched when a filter is active', async () => {
    renderPage('/downloads/log?job=job-1');

    expect(await screen.findByText('No events found matching your filters')).toBeInTheDocument();
  });

  test('shows an error when loading fails', async () => {
    mockedGet.mockRejectedValue(new Error('Network Error'));
    renderPage();

    expect(await screen.findByText(/Network Error/)).toBeInTheDocument();
  });

  test('lists the latest events first when nothing is filtered', async () => {
    renderPage();

    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    expect(lastParams()).toMatchObject({ order: 'desc', offset: 0 });
  });

  describe('narrowing the log', () => {
    test('a ?job= link filters to that job, oldest first', async () => {
      respond([event(1), event(2)]);
      renderPage('/downloads/log?job=job-1');

      await screen.findByText('Message 1');
      expect(lastParams()).toMatchObject({ jobId: 'job-1', order: 'asc' });
    });

    test('a ?job= link shows the gap between steps', async () => {
      respond([event(1), event(2)]);
      renderPage('/downloads/log?job=job-1');

      expect(await screen.findByRole('columnheader', { name: 'Δ' })).toBeInTheDocument();
    });

    test('a ?video= link filters to that video, oldest first', async () => {
      respond([event(1)]);
      renderPage('/downloads/log?video=abc123');

      await screen.findByText('Message 1');
      expect(lastParams()).toMatchObject({ youtubeId: 'abc123', order: 'asc' });
    });

    test('a saved level filter applies and reads oldest first', async () => {
      window.localStorage.setItem('youtarr:eventLog:filter:level', JSON.stringify('error'));
      renderPage();

      await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
      expect(lastParams()).toMatchObject({ level: 'error', order: 'asc' });
    });

    test.each([
      ['eventType', 'video.failed'],
      ['source', 'NZB'],
      ['actor', 'downloader'],
      ['channel', 'pcrobec'],
      ['tracked', 'untracked'],
    ])('a saved %s filter applies', async (name, value) => {
      window.localStorage.setItem('youtarr:eventLog:filter:' + name, JSON.stringify(value));
      renderPage();

      await waitFor(() => expect(mockedGet).toHaveBeenCalledWith('/api/job-events', expect.anything()));
      const call = mockedGet.mock.calls.find(([url]) => url === '/api/job-events');
      expect(call?.[1]?.params).toMatchObject({ [name]: value });
    });

    test('a saved date range is sent as instants', async () => {
      window.localStorage.setItem('youtarr:eventLog:filter:dateFrom', JSON.stringify('2026-09-19'));
      renderPage();

      await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
      expect(new Date(lastParams().from).getTime()).toBe(new Date(2026, 8, 19, 0, 0, 0, 0).getTime());
    });

    test('clicking a video title switches to that video, oldest first', async () => {
      respond([event(1)]);
      renderPage();

      await userEvent.click(await screen.findByRole('button', { name: 'Celebrity Juice S26E09' }));

      await waitFor(() => expect(lastParams()).toMatchObject({ youtubeId: 'abc123', order: 'asc' }));
    });

    test('clicking a row\'s job link switches to that job', async () => {
      respond([event(1)]);
      renderPage();

      await userEvent.click(await screen.findByRole('button', { name: 'Highlight and select this job' }));

      await waitFor(() => expect(lastParams()).toMatchObject({ jobId: 'job-1', order: 'asc' }));
    });

    test('clearing the Single job only chip goes back to the whole log', async () => {
      respond([event(1)]);
      renderPage('/downloads/log?job=job-1');

      await userEvent.click(await screen.findByText('Single job only'));

      await waitFor(() => expect(lastParams().jobId).toBeUndefined());
    });

    test('clearing the Single video only chip goes back to the whole log', async () => {
      respond([event(1)]);
      renderPage('/downloads/log?video=abc123');

      await userEvent.click(await screen.findByText('Single video only'));

      await waitFor(() => expect(lastParams().youtubeId).toBeUndefined());
    });

    test('a saved component filter reads in plain words and clears from its chip', async () => {
      window.localStorage.setItem('youtarr:eventLog:filter:actor', JSON.stringify('downloader'));
      renderPage();

      await userEvent.click(await screen.findByText('Component: Downloader'));

      await waitFor(() => expect(lastParams().actor).toBeUndefined());
    });

    test('typing in the search box filters the log', async () => {
      renderPage();
      await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));

      fireEvent.change(screen.getByPlaceholderText(/Search events/), { target: { value: 'juice' } });

      await waitFor(() => expect(lastParams()).toMatchObject({ q: 'juice', order: 'asc' }));
    });
  });

  describe('optional log views', () => {
    const jobEvents = () => [
      event(1, { youtubeId: null, videoTitle: null, eventType: 'job.started' }),
      event(2, { eventType: 'video.started' }),
      event(3, { eventType: 'video.downloaded' }),
    ];

    test('offers both views when one job is shown', async () => {
      respond(jobEvents());
      renderPage('/downloads/log?job=job-1');

      expect(await screen.findByRole('button', { name: 'Swimlanes' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'By job' })).toBeInTheDocument();
    });

    test('offers By job for the whole log too', async () => {
      respond(jobEvents());
      renderPage();

      expect(await screen.findByRole('button', { name: 'By job' })).toBeInTheDocument();
    });

    test('does not offer Swimlanes for the whole log - it only makes sense for one job', async () => {
      respond(jobEvents());
      renderPage();
      await screen.findByText('Message 2');

      expect(screen.queryByRole('button', { name: 'Swimlanes' })).not.toBeInTheDocument();
    });

    test('has both views off by default', async () => {
      respond(jobEvents());
      renderPage('/downloads/log?job=job-1');
      await screen.findByText('Message 2');

      expect(screen.queryByTestId('event-swimlanes')).not.toBeInTheDocument();
      expect(screen.queryByTestId('event-group')).not.toBeInTheDocument();
    });

    test('shows the swimlanes above the table when switched on', async () => {
      respond(jobEvents());
      renderPage('/downloads/log?job=job-1');

      await userEvent.click(await screen.findByRole('button', { name: 'Swimlanes' }));

      expect(screen.getByTestId('event-swimlanes')).toBeInTheDocument();
      expect(screen.getByText('Message 2')).toBeInTheDocument();
    });

    test('groups the events by job when switched on', async () => {
      respond(jobEvents());
      renderPage('/downloads/log?job=job-1');

      await userEvent.click(await screen.findByRole('button', { name: 'By job' }));

      expect(screen.getAllByTestId('event-group')).toHaveLength(1);
    });

    test('remembers the swimlanes choice', async () => {
      respond(jobEvents());
      renderPage('/downloads/log?job=job-1');

      await userEvent.click(await screen.findByRole('button', { name: 'Swimlanes' }));

      expect(window.localStorage.getItem('youtarr:eventLog:view:swimlanes')).toBe('true');
    });

    test('remembers the grouping choice', async () => {
      respond(jobEvents());
      renderPage('/downloads/log?job=job-1');

      await userEvent.click(await screen.findByRole('button', { name: 'By job' }));

      expect(window.localStorage.getItem('youtarr:eventLog:view:groupByVideo')).toBe('true');
    });

    test('applies a remembered swimlanes choice on the next visit', async () => {
      window.localStorage.setItem('youtarr:eventLog:view:swimlanes', JSON.stringify(true));
      respond(jobEvents());
      renderPage('/downloads/log?job=job-1');

      expect(await screen.findByTestId('event-swimlanes')).toBeInTheDocument();
    });

    test('opens the row of a clicked swimlane dot', async () => {
      window.localStorage.setItem('youtarr:eventLog:view:swimlanes', JSON.stringify(true));
      respond(jobEvents());
      renderPage('/downloads/log?job=job-1');

      await userEvent.click(await screen.findByRole('button', { name: 'downloaded - Message 3' }));

      expect(screen.getByTestId('event-detail')).toHaveTextContent('Message 3');
    });

    test('opens the group of a clicked swimlane dot when grouped', async () => {
      window.localStorage.setItem('youtarr:eventLog:view:swimlanes', JSON.stringify(true));
      window.localStorage.setItem('youtarr:eventLog:view:groupByVideo', JSON.stringify(true));
      respond(jobEvents());
      renderPage('/downloads/log?job=job-1');

      await userEvent.click(await screen.findByRole('button', { name: 'downloaded - Message 3' }));

      expect(screen.getByTestId('event-detail')).toHaveTextContent('Message 3');
    });

    test('keeps different jobs in separate groups on the whole log', async () => {
      respond([
        event(1, { jobId: 'job-1', youtubeId: null, videoTitle: null, jobType: 'Channel Downloads', eventType: 'job.started' }),
        event(2, { jobId: 'job-2', youtubeId: null, videoTitle: null, jobType: 'Manual downloads', eventType: 'job.started' }),
      ]);
      renderPage();

      await userEvent.click(await screen.findByRole('button', { name: 'By job' }));

      expect(screen.getByText('Job: Channel Downloads')).toBeInTheDocument();
      expect(screen.getByText('Job: Manual downloads')).toBeInTheDocument();
    });

    test('selecting a video from within the grouped view updates the params', async () => {
      respond(jobEvents());
      renderPage();
      await userEvent.click(await screen.findByRole('button', { name: 'By job' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Expand Job: Channel Downloads' }));

      await userEvent.click(screen.getAllByRole('button', { name: 'Celebrity Juice S26E09' })[0]);

      await waitFor(() => expect(lastParams()).toMatchObject({ youtubeId: 'abc123', order: 'asc' }));
    });

    test('selecting a job from within the grouped view updates the params', async () => {
      respond(jobEvents());
      renderPage();
      await userEvent.click(await screen.findByRole('button', { name: 'By job' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Expand Job: Channel Downloads' }));

      await userEvent.click(screen.getAllByRole('button', { name: 'Highlight and select this job' })[0]);

      await waitFor(() => expect(lastParams()).toMatchObject({ jobId: 'job-1', order: 'asc' }));
    });

    test('offers Timeline once By job is on, and remembers it', async () => {
      respond(jobEvents());
      renderPage('/downloads/log?job=job-1');
      await userEvent.click(await screen.findByRole('button', { name: 'By job' }));

      expect(screen.queryByTestId('event-swimlane')).not.toBeInTheDocument();
      await userEvent.click(await screen.findByRole('button', { name: 'Timeline' }));

      expect(screen.getAllByTestId('event-swimlane').length).toBeGreaterThan(0);
      expect(window.localStorage.getItem('youtarr:eventLog:view:groupTimeline')).toBe('true');
    });
  });

  describe('filter order', () => {
    test('lists the filters in the order of the table columns', async () => {
      respond([event(1)]);
      renderPage();
      await userEvent.click(await screen.findByTestId('video-list-filters-button'));

      // "Occurred" is a plain field label; the rest are "Filter by X" buttons (see ChannelFilter).
      const finders = [
        () => screen.getByText('Occurred'),
        () => screen.getByRole('button', { name: 'Filter by Channel' }),
        () => screen.getByRole('button', { name: 'Filter by Library' }),
        () => screen.getByRole('button', { name: 'Filter by Source' }),
        () => screen.getByRole('button', { name: 'Filter by Event type' }),
        () => screen.getByRole('button', { name: 'Filter by Component' }),
        () => screen.getByRole('button', { name: 'Filter by Level' }),
      ];
      const positions = finders.map((find) => find());
      const inOrder = positions.every(
        (node, index) => index === 0 || Boolean(positions[index - 1].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)
      );
      expect(inOrder).toBe(true);
    });
  });

  describe('video popup', () => {
    test('clicking a thumbnail opens the video popup for that entry', async () => {
      respond([event(1)]);
      renderPage();

      await userEvent.click(await screen.findByTestId('video-thumbnail'));

      expect(screen.getByTestId('video-modal')).toHaveTextContent('Celebrity Juice S26E09');
    });

    test('the popup is closed until a thumbnail is clicked', async () => {
      respond([event(1)]);
      renderPage();
      await screen.findByText('Message 1');

      expect(screen.queryByTestId('video-modal')).not.toBeInTheDocument();
    });

    test('deleting the video from the popup closes it and reloads the list', async () => {
      respond([event(1)]);
      renderPage();
      await userEvent.click(await screen.findByTestId('video-thumbnail'));
      const callsBefore = listCalls().length;

      await userEvent.click(screen.getByRole('button', { name: 'Delete video' }));

      expect(screen.queryByTestId('video-modal')).not.toBeInTheDocument();
      await waitFor(() => expect(listCalls().length).toBeGreaterThan(callsBefore));
    });

    test('closing the popup removes it', async () => {
      respond([event(1)]);
      renderPage();
      await userEvent.click(await screen.findByTestId('video-thumbnail'));

      await userEvent.click(screen.getByRole('button', { name: 'Close modal' }));

      expect(screen.queryByTestId('video-modal')).not.toBeInTheDocument();
    });
  });

  describe('paging', () => {
    test('shows page controls when there is more than one page', async () => {
      respond([event(2), event(1)], 500);
      renderPage();

      expect(await screen.findAllByRole('button', { name: /next/i })).not.toHaveLength(0);
    });

    test('asks for the next page by offset', async () => {
      respond([event(2), event(1)], 500);
      renderPage();

      await userEvent.click((await screen.findAllByRole('button', { name: /next/i }))[0]);

      await waitFor(() => expect(lastParams().offset).toBeGreaterThan(0));
    });
  });

  describe('live refresh', () => {
    test('refetches when a job update is broadcast', async () => {
      jest.useFakeTimers();
      try {
        respond([event(1)]);
        renderPage();
        await act(async () => { await Promise.resolve(); });
        const callsBefore = mockedGet.mock.calls.length;

        respond([event(2), event(1)]);
        act(() => {
          subscriptions
            .filter((s) => s.filter({ destination: 'broadcast', type: 'jobsUpdated' }))
            .forEach((s) => s.callback({}));
        });
        await act(async () => { jest.advanceTimersByTime(1100); });

        expect(mockedGet.mock.calls.length).toBeGreaterThan(callsBefore);
        expect(screen.getByText('Message 2')).toBeInTheDocument();
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
