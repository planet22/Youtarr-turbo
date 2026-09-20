import { renderHook, act, waitFor } from '@testing-library/react';
import axios from 'axios';
import { useJobEvents } from '../useJobEvents';
import type { JobEvent, JobEventFilters, JobEventPage } from '../../../../../types/JobEvent';

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));
const mockedGet = (axios as jest.Mocked<typeof axios>).get;

const event = (id: number, over: Partial<JobEvent> = {}): JobEvent => ({
  id,
  occurredAt: `2026-09-19T17:12:${String(id).padStart(2, '0')}.000Z`,
  jobId: 'job-1',
  youtubeId: 'abc',
  eventType: 'job.started',
  level: 'info',
  actor: 'job',
  message: `event ${id}`,
  detail: null,
  videoTitle: null,
  channelName: null,
  jobType: null,
  ...over,
});

const page = (ids: number[], nextCursor: number | null = null): { data: JobEventPage } => ({
  data: { events: ids.map((id) => event(id)), nextCursor },
});

const lastParams = () => mockedGet.mock.calls[mockedGet.mock.calls.length - 1][1]?.params;
const ids = (events: JobEvent[]) => events.map((e) => e.id);

describe('useJobEvents', () => {
  const render = (filters: JobEventFilters = {}, token: string | null = 'tok') =>
    renderHook(({ f, t }: { f: JobEventFilters; t: string | null }) => useJobEvents(t, f), {
      initialProps: { f: filters, t: token },
    });

  beforeEach(() => {
    jest.clearAllMocks();
    mockedGet.mockResolvedValue(page([]));
  });

  describe('loading', () => {
    test('requests the newest page first for the global log', async () => {
      const { result } = render();

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(lastParams()).toEqual({ limit: 100, order: 'desc' });
    });

    test('sends the auth token', async () => {
      render();

      await waitFor(() => expect(mockedGet).toHaveBeenCalled());
      expect(mockedGet.mock.calls[0][1]?.headers).toEqual({ 'x-access-token': 'tok' });
    });

    test('does not request anything without a token', () => {
      render({}, null);

      expect(mockedGet).not.toHaveBeenCalled();
    });

    test('is a timeline, oldest first, when filtered to a job', async () => {
      const { result } = render({ jobId: 'job-1' });

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.timeline).toBe(true);
      expect(lastParams()).toMatchObject({ order: 'asc', jobId: 'job-1' });
    });

    test('is a timeline when filtered to a video', async () => {
      const { result } = render({ youtubeId: 'abc' });

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(lastParams()).toMatchObject({ order: 'asc', youtubeId: 'abc' });
    });

    test('is not a timeline for level or search filters alone', async () => {
      const { result } = render({ level: 'error', q: 'juice' });

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.timeline).toBe(false);
      expect(lastParams()).toMatchObject({ level: 'error', q: 'juice' });
    });

    test('exposes the loaded events', async () => {
      mockedGet.mockResolvedValue(page([3, 2, 1]));
      const { result } = render();

      await waitFor(() => expect(result.current.events).toHaveLength(3));
      expect(ids(result.current.events)).toEqual([3, 2, 1]);
    });

    test('reports an error message when the request fails', async () => {
      mockedGet.mockRejectedValue(new Error('Network Error'));
      const { result } = render();

      await waitFor(() => expect(result.current.error).toBe('Network Error'));
    });

    test('reloads from the first page when the filters change', async () => {
      mockedGet.mockResolvedValue(page([2, 1]));
      const { result, rerender } = render();
      await waitFor(() => expect(result.current.events).toHaveLength(2));

      mockedGet.mockResolvedValue(page([9]));
      rerender({ f: { level: 'error' }, t: 'tok' });

      await waitFor(() => expect(ids(result.current.events)).toEqual([9]));
    });

    test('ignores a response that arrives after the filters have changed', async () => {
      let resolveSlow: (value: { data: JobEventPage }) => void = () => {};
      mockedGet.mockImplementationOnce(() => new Promise((resolve) => { resolveSlow = resolve; }));
      const { result, rerender } = render();

      mockedGet.mockResolvedValue(page([9]));
      rerender({ f: { level: 'error' }, t: 'tok' });
      await waitFor(() => expect(ids(result.current.events)).toEqual([9]));

      await act(async () => {
        resolveSlow(page([1, 2, 3]));
      });

      expect(ids(result.current.events)).toEqual([9]);
    });
  });

  describe('loadMore', () => {
    test('reports hasMore from the page cursor', async () => {
      mockedGet.mockResolvedValue(page([3, 2], 2));
      const { result } = render();

      await waitFor(() => expect(result.current.hasMore).toBe(true));
    });

    test('pages backwards with before for the global log', async () => {
      mockedGet.mockResolvedValueOnce(page([3, 2], 2));
      const { result } = render();
      await waitFor(() => expect(result.current.hasMore).toBe(true));

      mockedGet.mockResolvedValueOnce(page([1]));
      await act(async () => {
        await result.current.loadMore();
      });

      expect(lastParams()).toMatchObject({ before: 2, order: 'desc' });
    });

    test('pages forwards with after for a timeline', async () => {
      mockedGet.mockResolvedValueOnce(page([1, 2], 2));
      const { result } = render({ jobId: 'job-1' });
      await waitFor(() => expect(result.current.hasMore).toBe(true));

      mockedGet.mockResolvedValueOnce(page([3]));
      await act(async () => {
        await result.current.loadMore();
      });

      expect(lastParams()).toMatchObject({ after: 2, order: 'asc' });
    });

    test('appends the next page and clears hasMore on the last one', async () => {
      mockedGet.mockResolvedValueOnce(page([3, 2], 2));
      const { result } = render();
      await waitFor(() => expect(result.current.hasMore).toBe(true));

      mockedGet.mockResolvedValueOnce(page([1]));
      await act(async () => {
        await result.current.loadMore();
      });

      expect(ids(result.current.events)).toEqual([3, 2, 1]);
      expect(result.current.hasMore).toBe(false);
    });

    test('does nothing when there is no further page', async () => {
      mockedGet.mockResolvedValue(page([1]));
      const { result } = render();
      await waitFor(() => expect(result.current.events).toHaveLength(1));
      mockedGet.mockClear();

      await act(async () => {
        await result.current.loadMore();
      });

      expect(mockedGet).not.toHaveBeenCalled();
    });
  });

  describe('refresh (global log)', () => {
    test('prepends only entries newer than the newest one held', async () => {
      mockedGet.mockResolvedValueOnce(page([3, 2, 1]));
      const { result } = render();
      await waitFor(() => expect(result.current.events).toHaveLength(3));

      mockedGet.mockResolvedValueOnce(page([5, 4, 3, 2, 1]));
      await act(async () => {
        await result.current.refresh();
      });

      expect(ids(result.current.events)).toEqual([5, 4, 3, 2, 1]);
    });

    test('leaves the list untouched when nothing is new', async () => {
      mockedGet.mockResolvedValueOnce(page([3, 2, 1]));
      const { result } = render();
      await waitFor(() => expect(result.current.events).toHaveLength(3));
      const before = result.current.events;

      mockedGet.mockResolvedValueOnce(page([3, 2, 1]));
      await act(async () => {
        await result.current.refresh();
      });

      expect(result.current.events).toBe(before);
    });

    test('keeps entries loaded by loadMore when it prepends new ones', async () => {
      mockedGet.mockResolvedValueOnce(page([3, 2], 2));
      const { result } = render();
      await waitFor(() => expect(result.current.hasMore).toBe(true));
      mockedGet.mockResolvedValueOnce(page([1]));
      await act(async () => {
        await result.current.loadMore();
      });

      mockedGet.mockResolvedValueOnce(page([4, 3, 2], 2));
      await act(async () => {
        await result.current.refresh();
      });

      expect(ids(result.current.events)).toEqual([4, 3, 2, 1]);
    });

    test('starts over when the new page has a gap behind it', async () => {
      mockedGet.mockResolvedValueOnce(page([3, 2, 1]));
      const { result } = render();
      await waitFor(() => expect(result.current.events).toHaveLength(3));

      mockedGet.mockResolvedValueOnce(page([203, 202, 201], 201));
      await act(async () => {
        await result.current.refresh();
      });

      expect(ids(result.current.events)).toEqual([203, 202, 201]);
      expect(result.current.hasMore).toBe(true);
    });

    test('fills an empty list from the first page', async () => {
      const { result } = render();
      await waitFor(() => expect(result.current.loading).toBe(false));

      mockedGet.mockResolvedValueOnce(page([2, 1]));
      await act(async () => {
        await result.current.refresh();
      });

      expect(ids(result.current.events)).toEqual([2, 1]);
    });

    test('keeps what is on screen when the refresh request fails', async () => {
      mockedGet.mockResolvedValueOnce(page([2, 1]));
      const { result } = render();
      await waitFor(() => expect(result.current.events).toHaveLength(2));

      mockedGet.mockRejectedValueOnce(new Error('offline'));
      await act(async () => {
        await result.current.refresh();
      });

      expect(ids(result.current.events)).toEqual([2, 1]);
      expect(result.current.error).toBeNull();
    });
  });

  describe('refresh (timeline)', () => {
    test('appends entries recorded after the last one held', async () => {
      mockedGet.mockResolvedValueOnce(page([1, 2]));
      const { result } = render({ jobId: 'job-1' });
      await waitFor(() => expect(result.current.events).toHaveLength(2));

      mockedGet.mockResolvedValueOnce(page([3, 4]));
      await act(async () => {
        await result.current.refresh();
      });

      expect(lastParams()).toMatchObject({ after: 2, order: 'asc' });
      expect(ids(result.current.events)).toEqual([1, 2, 3, 4]);
    });

    test('does not fetch while earlier pages are still unloaded', async () => {
      mockedGet.mockResolvedValueOnce(page([1, 2], 2));
      const { result } = render({ jobId: 'job-1' });
      await waitFor(() => expect(result.current.hasMore).toBe(true));
      mockedGet.mockClear();

      await act(async () => {
        await result.current.refresh();
      });

      expect(mockedGet).not.toHaveBeenCalled();
    });
  });
});
