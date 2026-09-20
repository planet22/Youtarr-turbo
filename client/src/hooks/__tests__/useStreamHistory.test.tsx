import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import WebSocketContext, { Message } from '../../contexts/WebSocketContext';

jest.mock('axios', () => ({ get: jest.fn(), delete: jest.fn() }));
const axios = require('axios');

import { useStreamHistory, StreamHistoryRow } from '../useStreamHistory';

const buildRow = (overrides: Partial<StreamHistoryRow> = {}): StreamHistoryRow => ({
  streamId: 's1',
  youtubeId: 'abc123DEF45',
  title: 'A Video',
  mode: 'hls',
  quality: '1080',
  container: 'mp4',
  transcode: 'copy',
  hardwareMode: null,
  clientIp: '10.0.0.1',
  userAgent: 'Jellyfin',
  startedAt: '2026-01-01T00:00:00Z',
  endedAt: '2026-01-01T00:10:00Z',
  bytesTransferred: 1024,
  endReason: 'completed',
  errorMessage: null,
  ...overrides,
});

type Subscribe = (filter: (message: Message) => boolean, callback: (data: unknown) => void) => void;

function buildWebSocketWrapper() {
  const subscribe = jest.fn<void, Parameters<Subscribe>>();
  const unsubscribe = jest.fn();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <WebSocketContext.Provider value={{ socket: null, isConnected: true, subscribe, unsubscribe }}>
      {children}
    </WebSocketContext.Provider>
  );
  return { wrapper, subscribe, unsubscribe };
}

describe('useStreamHistory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    axios.get.mockResolvedValue({ data: { rows: [], total: 0, page: 1, limit: 25 } });
  });

  describe('fetching', () => {
    it('loads the requested page with the access token', async () => {
      renderHook(() => useStreamHistory('tok', 2, 10));

      await waitFor(() =>
        expect(axios.get).toHaveBeenCalledWith('/api/ytstream/history', {
          params: { page: 2, limit: 10, mode: undefined, status: undefined, search: undefined, dateFrom: undefined, dateTo: undefined },
          headers: { 'x-access-token': 'tok' },
        })
      );
    });

    it('defaults to 25 rows per page', async () => {
      renderHook(() => useStreamHistory('tok', 1));

      await waitFor(() => expect(axios.get.mock.calls[0][1].params.limit).toBe(25));
    });

    it('sends the filters as query params', async () => {
      const filters = { mode: 'hls', status: 'failed', search: 'cats', dateFrom: '2026-01-01', dateTo: '2026-02-01' };
      renderHook(() => useStreamHistory('tok', 1, 25, filters));

      await waitFor(() => expect(axios.get.mock.calls[0][1].params).toMatchObject(filters));
    });

    it('exposes the returned rows and total', async () => {
      axios.get.mockResolvedValue({ data: { rows: [buildRow()], total: 41, page: 1, limit: 25 } });

      const { result } = renderHook(() => useStreamHistory('tok', 1));

      await waitFor(() => expect(result.current.rows).toHaveLength(1));
      expect(result.current.total).toBe(41);
    });

    it('is loading until the first response arrives', async () => {
      const { result } = renderHook(() => useStreamHistory('tok', 1));

      expect(result.current.loading).toBe(true);
      await waitFor(() => expect(result.current.loading).toBe(false));
    });

    it('treats a response without rows as empty', async () => {
      axios.get.mockResolvedValue({ data: {} });

      const { result } = renderHook(() => useStreamHistory('tok', 1));

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.rows).toEqual([]);
      expect(result.current.total).toBe(0);
    });

    it('does not fetch without a token', async () => {
      const { result } = renderHook(() => useStreamHistory(null, 1));

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(axios.get).not.toHaveBeenCalled();
    });

    it('keeps the previous rows when a refetch fails', async () => {
      axios.get.mockResolvedValueOnce({ data: { rows: [buildRow()], total: 1 } });
      const { result } = renderHook(() => useStreamHistory('tok', 1));
      await waitFor(() => expect(result.current.rows).toHaveLength(1));

      axios.get.mockRejectedValueOnce(new Error('network'));
      await act(async () => { await result.current.refetch(); });

      expect(result.current.rows).toHaveLength(1);
      expect(result.current.loading).toBe(false);
    });

    it('refetches when the page changes', async () => {
      const { rerender } = renderHook(({ page }: { page: number }) => useStreamHistory('tok', page), { initialProps: { page: 1 } });
      await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(1));

      rerender({ page: 2 });

      await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(2));
    });
  });

  describe('live updates', () => {
    it('subscribes to streamStopped broadcasts on page 1', async () => {
      const { wrapper, subscribe } = buildWebSocketWrapper();

      renderHook(() => useStreamHistory('tok', 1), { wrapper });

      await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
      const filter = subscribe.mock.calls[0][0];
      expect(filter({ destination: 'broadcast', source: 'server', type: 'streamStopped', payload: null })).toBe(true);
    });

    it('ignores other message types and destinations', async () => {
      const { wrapper, subscribe } = buildWebSocketWrapper();

      renderHook(() => useStreamHistory('tok', 1), { wrapper });

      await waitFor(() => expect(subscribe).toHaveBeenCalled());
      const filter = subscribe.mock.calls[0][0];
      expect(filter({ destination: 'broadcast', source: 'server', type: 'streamStarted', payload: null })).toBe(false);
      expect(filter({ destination: 'someone', source: 'server', type: 'streamStopped', payload: null })).toBe(false);
    });

    it('refetches when a stream stops', async () => {
      const { wrapper, subscribe } = buildWebSocketWrapper();
      renderHook(() => useStreamHistory('tok', 1), { wrapper });
      await waitFor(() => expect(subscribe).toHaveBeenCalled());
      axios.get.mockClear();

      act(() => { subscribe.mock.calls[0][1]({}); });

      await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(1));
    });

    it('does not subscribe on later pages', async () => {
      const { wrapper, subscribe } = buildWebSocketWrapper();

      const { result } = renderHook(() => useStreamHistory('tok', 2), { wrapper });

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(subscribe).not.toHaveBeenCalled();
    });

    it('unsubscribes on unmount', async () => {
      const { wrapper, subscribe, unsubscribe } = buildWebSocketWrapper();
      const { unmount } = renderHook(() => useStreamHistory('tok', 1), { wrapper });
      await waitFor(() => expect(subscribe).toHaveBeenCalled());

      unmount();

      expect(unsubscribe).toHaveBeenCalledWith(subscribe.mock.calls[0][1]);
    });

    it('works without a WebSocket provider', async () => {
      const { result } = renderHook(() => useStreamHistory('tok', 1));

      await waitFor(() => expect(result.current.loading).toBe(false));
    });
  });

  describe('deleteEntries', () => {
    it('deletes the given streams with the access token', async () => {
      axios.delete.mockResolvedValue({ data: { success: true, deleted: 2 } });
      const { result } = renderHook(() => useStreamHistory('tok', 1));
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => { await result.current.deleteEntries(['a', 'b']); });

      expect(axios.delete).toHaveBeenCalledWith('/api/ytstream/history', {
        headers: { 'x-access-token': 'tok' },
        data: { streamIds: ['a', 'b'] },
      });
    });

    it('returns the server result', async () => {
      axios.delete.mockResolvedValue({ data: { success: true, deleted: 2 } });
      const { result } = renderHook(() => useStreamHistory('tok', 1));
      await waitFor(() => expect(result.current.loading).toBe(false));

      let outcome;
      await act(async () => { outcome = await result.current.deleteEntries(['a', 'b']); });

      expect(outcome).toEqual({ success: true, deleted: 2 });
    });

    it('does nothing for an empty selection', async () => {
      const { result } = renderHook(() => useStreamHistory('tok', 1));
      await waitFor(() => expect(result.current.loading).toBe(false));

      let outcome;
      await act(async () => { outcome = await result.current.deleteEntries([]); });

      expect(outcome).toEqual({ success: false, deleted: 0 });
      expect(axios.delete).not.toHaveBeenCalled();
    });

    it('does nothing without a token', async () => {
      const { result } = renderHook(() => useStreamHistory(null, 1));
      await waitFor(() => expect(result.current.loading).toBe(false));

      let outcome;
      await act(async () => { outcome = await result.current.deleteEntries(['a']); });

      expect(outcome).toEqual({ success: false, deleted: 0 });
    });

    it('reports failure when the request errors', async () => {
      axios.delete.mockRejectedValue(new Error('403'));
      const { result } = renderHook(() => useStreamHistory('tok', 1));
      await waitFor(() => expect(result.current.loading).toBe(false));

      let outcome;
      await act(async () => { outcome = await result.current.deleteEntries(['a']); });

      expect(outcome).toEqual({ success: false, deleted: 0 });
    });
  });
});
