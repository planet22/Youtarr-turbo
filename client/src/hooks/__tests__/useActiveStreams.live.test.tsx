import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import WebSocketContext, { Message } from '../../contexts/WebSocketContext';

jest.mock('axios', () => ({ get: jest.fn() }));
const axios = require('axios');

import { useActiveStreams, StreamSnapshot } from '../useActiveStreams';

const buildStream = (overrides: Partial<StreamSnapshot> = {}): StreamSnapshot => ({
  streamId: 's1',
  mode: 'hls',
  youtubeId: 'abc123DEF45',
  title: 'A Video',
  quality: '1080',
  container: 'mp4',
  transcode: 'copy',
  hardwareMode: 'none',
  clientIp: '10.0.0.1',
  userAgent: 'Jellyfin',
  state: 'active',
  error: null,
  startedAt: 1000,
  bytesTransferred: 100,
  bytesPerSecond: 10,
  lastActivityAt: 2000,
  segments: null,
  ...overrides,
});

type Callback = (data: never) => void;
type Filter = (message: Message) => boolean;

// Records every subscription so tests can fire a broadcast at the right one
function buildWebSocket() {
  const subscriptions: { filter: Filter; callback: Callback }[] = [];
  const subscribe = jest.fn((filter: Filter, callback: Callback) => { subscriptions.push({ filter, callback }); });
  const unsubscribe = jest.fn();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <WebSocketContext.Provider value={{ socket: null, isConnected: true, subscribe, unsubscribe }}>
      {children}
    </WebSocketContext.Provider>
  );
  const message = (type: string): Message => ({ destination: 'broadcast', source: 'server', type, payload: null });
  // Deliver a payload to whichever subscription's filter accepts this message type
  const broadcast = (type: string, payload: unknown) => {
    act(() => {
      subscriptions.filter((s) => s.filter(message(type))).forEach((s) => s.callback(payload as never));
    });
  };
  return { wrapper, subscribe, unsubscribe, subscriptions, broadcast, message };
}

describe('useActiveStreams live updates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    axios.get.mockResolvedValue({ data: { streams: [buildStream(), buildStream({ streamId: 's2', title: 'Other' })] } });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('subscribes to progress, started and stopped broadcasts', async () => {
    const ws = buildWebSocket();

    renderHook(() => useActiveStreams('tok'), { wrapper: ws.wrapper });

    await waitFor(() => expect(ws.subscriptions).toHaveLength(3));
    for (const type of ['streamProgress', 'streamStarted', 'streamStopped']) {
      expect(ws.subscriptions.filter((s) => s.filter(ws.message(type)))).toHaveLength(1);
    }
  });

  it('ignores messages that are not broadcasts', async () => {
    const ws = buildWebSocket();
    renderHook(() => useActiveStreams('tok'), { wrapper: ws.wrapper });
    await waitFor(() => expect(ws.subscriptions).toHaveLength(3));

    const direct: Message = { destination: 'someone', source: 'server', type: 'streamProgress', payload: null };

    expect(ws.subscriptions.some((s) => s.filter(direct))).toBe(false);
  });

  it('works without a WebSocket provider', async () => {
    const { result } = renderHook(() => useActiveStreams('tok'));

    await waitFor(() => expect(result.current.streams).toHaveLength(2));
  });

  describe('streamProgress', () => {
    it('merges the update into the matching stream', async () => {
      const ws = buildWebSocket();
      const { result } = renderHook(() => useActiveStreams('tok'), { wrapper: ws.wrapper });
      await waitFor(() => expect(result.current.streams).toHaveLength(2));

      ws.broadcast('streamProgress', { streams: [{ streamId: 's1', bytesTransferred: 9999, bytesPerSecond: 500 }] });

      expect(result.current.streams[0]).toMatchObject({ streamId: 's1', bytesTransferred: 9999, bytesPerSecond: 500 });
    });

    it('keeps the REST-only title when the lighter snapshot omits it', async () => {
      const ws = buildWebSocket();
      const { result } = renderHook(() => useActiveStreams('tok'), { wrapper: ws.wrapper });
      await waitFor(() => expect(result.current.streams).toHaveLength(2));

      ws.broadcast('streamProgress', { streams: [{ streamId: 's1', bytesTransferred: 1 }] });

      expect(result.current.streams[0].title).toBe('A Video');
    });

    it('leaves streams that are not in the update alone', async () => {
      const ws = buildWebSocket();
      const { result } = renderHook(() => useActiveStreams('tok'), { wrapper: ws.wrapper });
      await waitFor(() => expect(result.current.streams).toHaveLength(2));

      ws.broadcast('streamProgress', { streams: [{ streamId: 's1', bytesTransferred: 1 }] });

      expect(result.current.streams[1]).toEqual(buildStream({ streamId: 's2', title: 'Other' }));
    });

    it('does not add a stream it has never seen', async () => {
      const ws = buildWebSocket();
      const { result } = renderHook(() => useActiveStreams('tok'), { wrapper: ws.wrapper });
      await waitFor(() => expect(result.current.streams).toHaveLength(2));

      ws.broadcast('streamProgress', { streams: [{ streamId: 'brand-new', bytesTransferred: 1 }] });

      expect(result.current.streams.map((s) => s.streamId)).toEqual(['s1', 's2']);
    });
  });

  describe('streamStopped', () => {
    it('removes the stopped stream without refetching', async () => {
      const ws = buildWebSocket();
      const { result } = renderHook(() => useActiveStreams('tok'), { wrapper: ws.wrapper });
      await waitFor(() => expect(result.current.streams).toHaveLength(2));
      axios.get.mockClear();

      ws.broadcast('streamStopped', { streamId: 's1' });

      expect(result.current.streams.map((s) => s.streamId)).toEqual(['s2']);
      expect(axios.get).not.toHaveBeenCalled();
    });
  });

  describe('streamStarted', () => {
    async function setup() {
      const ws = buildWebSocket();
      const view = renderHook(() => useActiveStreams('tok'), { wrapper: ws.wrapper });
      await waitFor(() => expect(view.result.current.streams).toHaveLength(2));
      axios.get.mockClear();
      jest.useFakeTimers();
      return { ...ws, result: view.result };
    }

    it('refetches after a one second debounce', async () => {
      const { result, ...ws } = await setup();

      ws.broadcast('streamStarted', {});
      expect(axios.get).not.toHaveBeenCalled();
      await act(async () => { jest.advanceTimersByTime(1000); });

      expect(axios.get).toHaveBeenCalledTimes(1);
    });

    it('collapses a burst of starts into one refetch', async () => {
      const { result, ...ws } = await setup();

      ws.broadcast('streamStarted', {});
      await act(async () => { jest.advanceTimersByTime(500); });
      ws.broadcast('streamStarted', {});
      await act(async () => { jest.advanceTimersByTime(500); });
      ws.broadcast('streamStarted', {});
      await act(async () => { jest.advanceTimersByTime(1000); });

      expect(axios.get).toHaveBeenCalledTimes(1);
    });

    it('picks up the new stream from the refetch', async () => {
      const { result, ...ws } = await setup();
      axios.get.mockResolvedValue({ data: { streams: [buildStream(), buildStream({ streamId: 's3', title: 'Fresh' })] } });

      ws.broadcast('streamStarted', {});
      await act(async () => { jest.advanceTimersByTime(1000); });

      expect(result.current.streams.map((s) => s.streamId)).toEqual(['s1', 's3']);
    });
  });

  describe('cleanup', () => {
    it('unsubscribes every callback on unmount', async () => {
      const ws = buildWebSocket();
      const { unmount } = renderHook(() => useActiveStreams('tok'), { wrapper: ws.wrapper });
      await waitFor(() => expect(ws.subscriptions).toHaveLength(3));

      unmount();

      expect(ws.unsubscribe).toHaveBeenCalledTimes(3);
      ws.subscriptions.forEach((s) => expect(ws.unsubscribe).toHaveBeenCalledWith(s.callback));
    });

    it('cancels a pending debounced refetch on unmount', async () => {
      const ws = buildWebSocket();
      const { result, unmount } = renderHook(() => useActiveStreams('tok'), { wrapper: ws.wrapper });
      await waitFor(() => expect(result.current.streams).toHaveLength(2));
      axios.get.mockClear();
      jest.useFakeTimers();
      ws.broadcast('streamStarted', {});

      unmount();
      await act(async () => { jest.advanceTimersByTime(5000); });

      expect(axios.get).not.toHaveBeenCalled();
    });
  });

  describe('REST fetch', () => {
    it('keeps the current streams when a refetch fails', async () => {
      const { result } = renderHook(() => useActiveStreams('tok'));
      await waitFor(() => expect(result.current.streams).toHaveLength(2));

      axios.get.mockRejectedValueOnce(new Error('network'));
      await act(async () => { await result.current.refetch(); });

      expect(result.current.streams).toHaveLength(2);
    });

    it('clears the streams when the token is removed', async () => {
      const { result, rerender } = renderHook(({ token }: { token: string | null }) => useActiveStreams(token), { initialProps: { token: 'tok' as string | null } });
      await waitFor(() => expect(result.current.streams).toHaveLength(2));

      rerender({ token: null });

      await waitFor(() => expect(result.current.streams).toEqual([]));
    });

    it('treats a response without streams as empty', async () => {
      axios.get.mockResolvedValue({ data: {} });

      const { result } = renderHook(() => useActiveStreams('tok'));

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.streams).toEqual([]);
    });
  });
});
