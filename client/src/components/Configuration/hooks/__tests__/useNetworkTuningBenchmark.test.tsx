import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import WebSocketContext from '../../../../contexts/WebSocketContext';

jest.mock('axios', () => ({ post: jest.fn() }));
const axios = require('axios');

import { useNetworkTuningBenchmark } from '../useNetworkTuningBenchmark';

const presets = [
  { id: 'default', label: 'Default', httpChunkSizeMiB: 0, concurrentFragments: 1 },
  { id: 'fast', label: 'Fast', httpChunkSizeMiB: 10, concurrentFragments: 4 },
];
const results = { default: { ok: true, throughputMBps: 2 }, fast: { ok: true, throughputMBps: 5 } };

const okResponse = (overrides: Record<string, unknown> = {}) => ({ data: { ok: true, results, recommended: 'fast', presets, ...overrides } });

type Callback = (payload: unknown) => void;

const fakeSocket = () => {
  let filter: ((msg: { type?: string }) => boolean) | undefined;
  let callback: Callback | undefined;
  const subscribe = jest.fn((f: typeof filter, c: Callback) => { filter = f; callback = c; });
  const unsubscribe = jest.fn();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <WebSocketContext.Provider value={{ socket: null, isConnected: true, subscribe: subscribe as never, unsubscribe }}>
      {children}
    </WebSocketContext.Provider>
  );
  return { wrapper, subscribe, unsubscribe, getFilter: () => filter, deliver: (payload: unknown) => act(() => callback?.(payload)) };
};

describe('useNetworkTuningBenchmark', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    axios.post.mockResolvedValue(okResponse());
  });

  it('starts idle with no results', () => {
    const { result } = renderHook(() => useNetworkTuningBenchmark('tok'));

    expect(result.current).toMatchObject({ testing: false, progress: null, results: null, recommended: null, presets: null, error: null });
  });

  describe('running the benchmark', () => {
    it('posts the URL with the access token', async () => {
      const { result } = renderHook(() => useNetworkTuningBenchmark('tok'));

      await act(async () => { await result.current.runBenchmark('https://youtu.be/abc'); });

      expect(axios.post).toHaveBeenCalledWith('/api/ytdlp/test-network-tuning', { url: 'https://youtu.be/abc' }, { headers: { 'x-access-token': 'tok' } });
    });

    it('sends an empty token header when there is no token', async () => {
      const { result } = renderHook(() => useNetworkTuningBenchmark(null));

      await act(async () => { await result.current.runBenchmark('abc'); });

      expect(axios.post.mock.calls[0][2]).toEqual({ headers: { 'x-access-token': '' } });
    });

    it('keeps the results, recommended preset and preset list', async () => {
      const { result } = renderHook(() => useNetworkTuningBenchmark('tok'));

      await act(async () => { await result.current.runBenchmark('abc'); });

      expect(result.current).toMatchObject({ results, recommended: 'fast', presets, error: null });
    });

    it('has no recommended preset when the server gives none', async () => {
      axios.post.mockResolvedValue(okResponse({ recommended: undefined }));
      const { result } = renderHook(() => useNetworkTuningBenchmark('tok'));

      await act(async () => { await result.current.runBenchmark('abc'); });

      expect(result.current.recommended).toBeNull();
    });

    it('is busy with an empty progress bar while it runs, then idle', async () => {
      let resolve: (value: unknown) => void = () => {};
      axios.post.mockReturnValue(new Promise((r) => { resolve = r; }));
      const { result } = renderHook(() => useNetworkTuningBenchmark('tok'));

      act(() => { void result.current.runBenchmark('abc'); });
      await waitFor(() => expect(result.current.testing).toBe(true));
      expect(result.current.progress).toEqual({ completed: 0, total: 0 });

      await act(async () => { resolve(okResponse()); });

      expect(result.current.testing).toBe(false);
      expect(result.current.progress).toBeNull();
    });

    it('clears the previous run before starting a new one', async () => {
      const { result } = renderHook(() => useNetworkTuningBenchmark('tok'));
      await act(async () => { await result.current.runBenchmark('abc'); });
      let resolve: (value: unknown) => void = () => {};
      axios.post.mockReturnValue(new Promise((r) => { resolve = r; }));

      act(() => { void result.current.runBenchmark('def'); });

      await waitFor(() => expect(result.current.results).toBeNull());
      expect(result.current.recommended).toBeNull();
      expect(result.current.presets).toBeNull();
      await act(async () => { resolve(okResponse()); });
    });
  });

  describe('failures', () => {
    it('shows the server\'s message when it reports the test as failed', async () => {
      axios.post.mockResolvedValue({ data: { ok: false, error: 'yt-dlp missing' } });
      const { result } = renderHook(() => useNetworkTuningBenchmark('tok'));

      await act(async () => { await result.current.runBenchmark('abc'); });

      expect(result.current.error).toBe('yt-dlp missing');
      expect(result.current.results).toBeNull();
    });

    it('shows a generic message when a failed report has none', async () => {
      axios.post.mockResolvedValue({ data: { ok: false } });
      const { result } = renderHook(() => useNetworkTuningBenchmark('tok'));

      await act(async () => { await result.current.runBenchmark('abc'); });

      expect(result.current.error).toBe('Network tuning benchmark failed');
    });

    it('treats an ok response without results as failed', async () => {
      axios.post.mockResolvedValue({ data: { ok: true } });
      const { result } = renderHook(() => useNetworkTuningBenchmark('tok'));

      await act(async () => { await result.current.runBenchmark('abc'); });

      expect(result.current.error).toBe('Network tuning benchmark failed');
    });

    it('shows the server\'s error when the request itself fails', async () => {
      axios.post.mockRejectedValue({ response: { data: { error: 'Invalid URL' } } });
      const { result } = renderHook(() => useNetworkTuningBenchmark('tok'));

      await act(async () => { await result.current.runBenchmark('nope'); });

      expect(result.current.error).toBe('Invalid URL');
      expect(result.current.testing).toBe(false);
    });

    it('shows a generic message when the request fails without one', async () => {
      axios.post.mockRejectedValue(new Error('network'));
      const { result } = renderHook(() => useNetworkTuningBenchmark('tok'));

      await act(async () => { await result.current.runBenchmark('abc'); });

      expect(result.current.error).toBe('Network tuning benchmark failed; please try again');
    });

    it('clears an earlier error when run again', async () => {
      axios.post.mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(okResponse());
      const { result } = renderHook(() => useNetworkTuningBenchmark('tok'));
      await act(async () => { await result.current.runBenchmark('abc'); });

      await act(async () => { await result.current.runBenchmark('abc'); });

      expect(result.current.error).toBeNull();
    });
  });

  describe('live progress', () => {
    it('subscribes only to network tuning progress messages', async () => {
      const ws = fakeSocket();

      renderHook(() => useNetworkTuningBenchmark('tok'), { wrapper: ws.wrapper });

      await waitFor(() => expect(ws.subscribe).toHaveBeenCalled());
      const filter = ws.getFilter()!;
      expect(filter({ type: 'networkTuningBenchmarkProgress' })).toBe(true);
      expect(filter({ type: 'downloadProgress' })).toBe(false);
      expect(filter({})).toBe(false);
    });

    it('shows progress while the benchmark runs', async () => {
      const ws = fakeSocket();
      const { result } = renderHook(() => useNetworkTuningBenchmark('tok'), { wrapper: ws.wrapper });
      await waitFor(() => expect(ws.subscribe).toHaveBeenCalled());

      await ws.deliver({ running: true, completed: 2, total: 5, current: { presetId: 'fast' } });

      expect(result.current.progress).toEqual({ completed: 2, total: 5, current: { presetId: 'fast' } });
    });

    it('ignores a message that says the run is over', async () => {
      const ws = fakeSocket();
      const { result } = renderHook(() => useNetworkTuningBenchmark('tok'), { wrapper: ws.wrapper });
      await waitFor(() => expect(ws.subscribe).toHaveBeenCalled());

      await ws.deliver({ running: false, completed: 5, total: 5 });

      expect(result.current.progress).toBeNull();
    });

    it('unsubscribes when unmounted', async () => {
      const ws = fakeSocket();
      const { unmount } = renderHook(() => useNetworkTuningBenchmark('tok'), { wrapper: ws.wrapper });
      await waitFor(() => expect(ws.subscribe).toHaveBeenCalled());

      unmount();

      expect(ws.unsubscribe).toHaveBeenCalledTimes(1);
    });
  });
});
