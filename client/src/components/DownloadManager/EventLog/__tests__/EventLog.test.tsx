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
  default: ({ video, onClose }: { video: { title: string }; onClose: () => void }) =>
    require('react').createElement('div', { 'data-testid': 'video-modal' }, video.title,
      require('react').createElement('button', { onClick: onClose }, 'Close modal')),
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

      expect(await screen.findByRole('columnheader', { name: 'Since previous' })).toBeInTheDocument();
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

    test('clicking a job label switches to that job', async () => {
      respond([event(1)]);
      renderPage();

      await userEvent.click(await screen.findByRole('button', { name: 'Channels' }));

      await waitFor(() => expect(lastParams()).toMatchObject({ jobId: 'job-1', order: 'asc' }));
    });

    test('typing in the search box filters the log', async () => {
      renderPage();
      await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));

      fireEvent.change(screen.getByPlaceholderText(/Search events/), { target: { value: 'juice' } });

      await waitFor(() => expect(lastParams()).toMatchObject({ q: 'juice', order: 'asc' }));
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
