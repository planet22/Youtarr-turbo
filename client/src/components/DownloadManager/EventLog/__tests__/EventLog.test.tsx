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
  ...over,
});

const respond = (events: JobEvent[], nextCursor: number | null = null) => {
  mockedGet.mockResolvedValue({ data: { events, nextCursor } as JobEventPage });
};

const lastParams = () => mockedGet.mock.calls[mockedGet.mock.calls.length - 1][1]?.params;

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
    subscriptions = [];
    respond([]);
  });

  test('shows the recorded events', async () => {
    respond([event(2), event(1)]);
    renderPage();

    expect(await screen.findByText('Message 2')).toBeInTheDocument();
    expect(screen.getByText('Message 1')).toBeInTheDocument();
  });

  test('shows the entry count in the heading', async () => {
    respond([event(2), event(1)]);
    renderPage();

    expect(await screen.findByText(/Video \/ Events Log \(2 entries\)/)).toBeInTheDocument();
  });

  test('marks the count as a minimum when more pages exist', async () => {
    respond([event(2), event(1)], 1);
    renderPage();

    expect(await screen.findByText(/Video \/ Events Log \(2\+ entries\)/)).toBeInTheDocument();
  });

  test('says nothing has been recorded yet for an empty log', async () => {
    renderPage();

    expect(await screen.findByText('No events recorded yet.')).toBeInTheDocument();
  });

  test('says nothing matched when filters are active', async () => {
    renderPage('/downloads/log?level=error');

    expect(await screen.findByText('No events recorded for these filters.')).toBeInTheDocument();
  });

  test('shows an error when loading fails', async () => {
    mockedGet.mockRejectedValue(new Error('Network Error'));
    renderPage();

    expect(await screen.findByText('Network Error')).toBeInTheDocument();
  });

  test('requests the newest page first for the global log', async () => {
    renderPage();

    await waitFor(() => expect(mockedGet).toHaveBeenCalled());
    expect(lastParams()).toEqual({ limit: 100, order: 'desc' });
  });

  describe('deep links', () => {
    test('a ?job= link loads that job as a timeline', async () => {
      respond([event(1), event(2)]);
      renderPage('/downloads/log?job=job-1');

      await screen.findByText('Message 1');
      expect(lastParams()).toMatchObject({ jobId: 'job-1', order: 'asc' });
      expect(screen.getByRole('columnheader', { name: 'Since previous' })).toBeInTheDocument();
    });

    test('a ?video= link loads that video as a timeline', async () => {
      respond([event(1)]);
      renderPage('/downloads/log?video=abc123');

      await screen.findByText('Message 1');
      expect(lastParams()).toMatchObject({ youtubeId: 'abc123', order: 'asc' });
    });

    test('shows the job as a chip with its job type', async () => {
      respond([event(1)]);
      renderPage('/downloads/log?job=job-1');

      expect(await screen.findByText('Job: Channel Downloads')).toBeInTheDocument();
    });

    test('a ?level= link filters by level', async () => {
      renderPage('/downloads/log?level=warn');

      await waitFor(() => expect(mockedGet).toHaveBeenCalled());
      expect(lastParams()).toMatchObject({ level: 'warn' });
    });

    test('a ?q= link starts with that search text', async () => {
      renderPage('/downloads/log?q=juice');

      expect(await screen.findByRole('textbox', { name: 'Search' })).toHaveValue('juice');
      expect(lastParams()).toMatchObject({ q: 'juice' });
    });
  });

  describe('narrowing the log', () => {
    test('clicking a video title switches to that video\'s timeline', async () => {
      respond([event(1)]);
      renderPage();

      await userEvent.click(await screen.findByRole('button', { name: 'Celebrity Juice S26E09' }));

      await waitFor(() => expect(lastParams()).toMatchObject({ youtubeId: 'abc123', order: 'asc' }));
    });

    test('clicking a job type switches to that job\'s timeline', async () => {
      respond([event(1)]);
      renderPage();

      await userEvent.click(await screen.findByRole('button', { name: 'Channel Downloads' }));

      await waitFor(() => expect(lastParams()).toMatchObject({ jobId: 'job-1', order: 'asc' }));
    });

    test('removing the job chip returns to the global log', async () => {
      respond([event(1)]);
      renderPage('/downloads/log?job=job-1');

      await userEvent.click(await screen.findByLabelText('Remove'));

      await waitFor(() => expect(lastParams()).toEqual({ limit: 100, order: 'desc' }));
    });

    test('typing in the search box filters after a short pause', async () => {
      jest.useFakeTimers();
      try {
        renderPage();
        await act(async () => { await Promise.resolve(); });

        fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), { target: { value: 'juice' } });
        expect(lastParams()).not.toHaveProperty('q');

        await act(async () => { jest.advanceTimersByTime(350); });

        expect(lastParams()).toMatchObject({ q: 'juice' });
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('paging', () => {
    test('offers Load more when another page exists', async () => {
      respond([event(2)], 2);
      renderPage();

      expect(await screen.findByRole('button', { name: 'Load more' })).toBeInTheDocument();
    });

    test('offers no Load more on the last page', async () => {
      respond([event(2)]);
      renderPage();

      await screen.findByText('Message 2');
      expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    });

    test('Load more requests the next older page and appends it', async () => {
      respond([event(2)], 2);
      renderPage();
      await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));

      respond([event(1)]);
      await userEvent.click(screen.getByRole('button', { name: 'Load more' }));

      expect(await screen.findByText('Message 1')).toBeInTheDocument();
      expect(lastParams()).toMatchObject({ before: 2 });
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
