import { renderHook, act, waitFor } from '@testing-library/react';
import axios from 'axios';
import { useJobEvents } from '../useJobEvents';
import type { JobEvent, JobEventFilters, JobEventPage } from '../../../../../types/JobEvent';

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));
const mockedGet = (axios as jest.Mocked<typeof axios>).get;

const event = (id: number): JobEvent => ({
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
});

const page = (ids: number[], total = ids.length): { data: JobEventPage } => ({
  data: { events: ids.map(event), total },
});

// The hook also asks for the filter options; list requests are queued separately
// so that request never consumes a response meant for the list.
const listQueue: Array<() => Promise<unknown>> = [];
let listDefault: () => Promise<unknown> = () => Promise.resolve({ data: { events: [], total: 0 } });
const listOnce = (value: unknown) => { listQueue.push(() => Promise.resolve(value)); };
const listRejectOnce = (err: Error) => { listQueue.push(() => Promise.reject(err)); };
const listAlways = (value: unknown) => { listDefault = () => Promise.resolve(value); };
const listRejectAlways = (err: Error) => { listDefault = () => Promise.reject(err); };
const emptyFacets = { data: { eventTypes: [], actors: [], channels: [], sources: [] } };
const routeRequests = (url: string) => {
  if (url === '/api/job-events/facets') return Promise.resolve(emptyFacets);
  const next = listQueue.shift();
  return (next || listDefault)();
};
const listCalls = () => mockedGet.mock.calls.filter(([url]) => url === '/api/job-events');
const lastParams = () => listCalls()[listCalls().length - 1][1]?.params;
const ids = (events: JobEvent[]) => events.map((e) => e.id);

interface Props {
  token: string | null;
  filters: JobEventFilters;
  pageNumber: number;
  pageSize: number;
  ascending: boolean;
}

describe('useJobEvents', () => {
  const render = (over: Partial<Props> = {}) =>
    renderHook((p: Props) => useJobEvents(p.token, p.filters, p.pageNumber, p.pageSize, p.ascending), {
      initialProps: { token: 'tok', filters: {}, pageNumber: 1, pageSize: 25, ascending: false, ...over },
    });

  beforeEach(() => {
    jest.clearAllMocks();
    listQueue.length = 0;
    listDefault = () => Promise.resolve(page([]));
    mockedGet.mockImplementation(routeRequests as never);
  });

  test('requests the first page newest first', async () => {
    const { result } = render();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(lastParams()).toEqual({ limit: 25, offset: 0, order: 'desc' });
  });

  test('requests oldest first when ascending', async () => {
    render({ ascending: true });

    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    expect(lastParams()).toMatchObject({ order: 'asc' });
  });

  test('turns the page number into an offset', async () => {
    render({ pageNumber: 3, pageSize: 50 });

    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    expect(lastParams()).toMatchObject({ limit: 50, offset: 100 });
  });

  test('sends every active filter', async () => {
    render({ filters: { jobId: 'j', youtubeId: 'y', level: 'error', category: 'nzb', q: 'juice', from: 'F', to: 'T' } });

    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    expect(lastParams()).toMatchObject({ jobId: 'j', youtubeId: 'y', level: 'error', category: 'nzb', q: 'juice', from: 'F', to: 'T' });
  });

  test('sends no filter parameters when none are set', async () => {
    render();

    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    expect(Object.keys(lastParams())).toEqual(['limit', 'offset', 'order']);
  });

  test('sends the auth token', async () => {
    render();

    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    expect(listCalls()[0][1]?.headers).toEqual({ 'x-access-token': 'tok' });
  });

  test('does not request anything without a token', () => {
    render({ token: null });

    expect(mockedGet).not.toHaveBeenCalled();
  });

  test('exposes the events and the total across all pages', async () => {
    listAlways(page([3, 2, 1], 250));
    const { result } = render();

    await waitFor(() => expect(result.current.events).toHaveLength(3));
    expect(result.current.total).toBe(250);
  });

  test('reports an error message when the request fails', async () => {
    listRejectAlways(new Error('Network Error'));
    const { result } = render();

    await waitFor(() => expect(result.current.error).toBe('Network Error'));
  });

  test('loads the new page when the page changes', async () => {
    listAlways(page([2, 1], 50));
    const { result, rerender } = render();
    await waitFor(() => expect(result.current.events).toHaveLength(2));

    listAlways(page([9], 50));
    rerender({ token: 'tok', filters: {}, pageNumber: 2, pageSize: 25, ascending: false });

    await waitFor(() => expect(ids(result.current.events)).toEqual([9]));
    expect(lastParams()).toMatchObject({ offset: 25 });
  });

  test('ignores a response that arrives after the filters have changed', async () => {
    let resolveSlow: (value: { data: JobEventPage }) => void = () => {};
    listQueue.push(() => new Promise((resolve) => { resolveSlow = resolve as typeof resolveSlow; }));
    const { result, rerender } = render();

    listAlways(page([9]));
    rerender({ token: 'tok', filters: { level: 'error' }, pageNumber: 1, pageSize: 25, ascending: true });
    await waitFor(() => expect(ids(result.current.events)).toEqual([9]));

    await act(async () => {
      resolveSlow(page([1, 2, 3]));
    });

    expect(ids(result.current.events)).toEqual([9]);
  });

  describe('refresh', () => {
    test('re-reads the current page and replaces it', async () => {
      listOnce(page([2, 1], 2));
      const { result } = render();
      await waitFor(() => expect(result.current.events).toHaveLength(2));

      listOnce(page([3, 2, 1], 3));
      await act(async () => {
        await result.current.refresh();
      });

      expect(ids(result.current.events)).toEqual([3, 2, 1]);
      expect(result.current.total).toBe(3);
    });

    test('does not flash the loading state', async () => {
      listOnce(page([1]));
      const { result } = render();
      await waitFor(() => expect(result.current.events).toHaveLength(1));

      listOnce(page([2, 1]));
      await act(async () => {
        await result.current.refresh();
      });

      expect(result.current.loading).toBe(false);
    });

    test('keeps what is on screen when the refresh fails', async () => {
      listOnce(page([2, 1]));
      const { result } = render();
      await waitFor(() => expect(result.current.events).toHaveLength(2));

      listRejectOnce(new Error('offline'));
      await act(async () => {
        await result.current.refresh();
      });

      expect(ids(result.current.events)).toEqual([2, 1]);
      expect(result.current.error).toBeNull();
    });
  });
});

describe('useJobEvents filters and facets', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGet.mockImplementation((url: string) =>
      Promise.resolve(
        url === '/api/job-events/facets'
          ? { data: { eventTypes: ['video.failed'], actors: ['nzb'], channels: ['pcrobec'], sources: ['NZB'] } }
          : page([])
      )
    );
  });

  const listParams = () => mockedGet.mock.calls.filter(([url]) => url === '/api/job-events').pop()?.[1]?.params;

  test('sends event type, actor, channel and source filters', async () => {
    renderHook(() => useJobEvents('tok', { eventType: 'video.failed', actor: 'nzb', channel: 'pcrobec', source: 'NZB' }, 1, 25, true));

    await waitFor(() => expect(listParams()).toMatchObject({ eventType: 'video.failed', actor: 'nzb', channel: 'pcrobec', source: 'NZB' }));
  });

  test('exposes the dropdown options from the facets endpoint', async () => {
    const { result } = renderHook(() => useJobEvents('tok', {}, 1, 25, false));

    await waitFor(() => expect(result.current.facets.actors).toEqual(['nzb']));
    expect(result.current.facets.sources).toEqual(['NZB']);
  });

  test('has empty options until the facets arrive', () => {
    const { result } = renderHook(() => useJobEvents('tok', {}, 1, 25, false));

    expect(result.current.facets).toEqual({ eventTypes: [], actors: [], channels: [], sources: [] });
  });

  test('still lists events when the facets request fails', async () => {
    mockedGet.mockImplementation((url: string) =>
      url === '/api/job-events/facets' ? Promise.reject(new Error('nope')) : Promise.resolve(page([1], 1))
    );
    const { result } = renderHook(() => useJobEvents('tok', {}, 1, 25, false));

    await waitFor(() => expect(result.current.events).toHaveLength(1));
    expect(result.current.error).toBeNull();
  });

  test('does not ask for facets without a token', () => {
    renderHook(() => useJobEvents(null, {}, 1, 25, false));

    expect(mockedGet).not.toHaveBeenCalled();
  });
});
