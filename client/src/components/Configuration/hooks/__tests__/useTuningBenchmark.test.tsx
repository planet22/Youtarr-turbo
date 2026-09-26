import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import WebSocketContext from '../../../../contexts/WebSocketContext';

jest.mock('axios', () => ({ post: jest.fn() }));
const axios = require('axios');

import { useTuningBenchmark } from '../useTuningBenchmark';

const matrix = { '1080': { fast: { ok: true, realtimeFactor: 3.2, realtime: true } } };
const recommended = { '1080': 'fast' };

const okResponse = (overrides: Record<string, unknown> = {}) => ({
  data: { ok: true, hardwareMode: 'vaapi', matrix, recommended, decodeMode: 'vaapi', sourceCodec: 'vp9', videoCodec: 'hevc', decodeSourceHeight: 2160, vaapiQuality: 4, ...overrides },
});

describe('useTuningBenchmark', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    axios.post.mockResolvedValue(okResponse());
  });

  it('starts idle with no results', () => {
    const { result } = renderHook(() => useTuningBenchmark('tok'));

    expect(result.current).toMatchObject({
      testing: false,
      progress: null,
      matrix: null,
      recommended: null,
      resultHardwareMode: null,
      history: [],
      error: null,
    });
  });

  describe('runBenchmark request', () => {
    it('posts the chosen options with the access token', async () => {
      const { result } = renderHook(() => useTuningBenchmark('tok'));

      await act(async () => { await result.current.runBenchmark('vaapi', 4, 'vaapi', 'vp9', 'hevc', 2160); });

      expect(axios.post).toHaveBeenCalledWith(
        '/api/ytdlp/test-tuning-benchmark',
        { hardwareMode: 'vaapi', vaapiQuality: 4, decodeMode: 'vaapi', sourceCodec: 'vp9', videoCodec: 'hevc', decodeSourceHeight: 2160 },
        { headers: { 'x-access-token': 'tok' } }
      );
    });

    it('defaults the optional options', async () => {
      const { result } = renderHook(() => useTuningBenchmark('tok'));

      await act(async () => { await result.current.runBenchmark('none'); });

      expect(axios.post.mock.calls[0][1]).toEqual({
        hardwareMode: 'none',
        vaapiQuality: null,
        decodeMode: 'none',
        sourceCodec: 'h264',
        videoCodec: 'h264',
        decodeSourceHeight: null,
      });
    });

    it('sends an empty token header when there is no token', async () => {
      const { result } = renderHook(() => useTuningBenchmark(null));

      await act(async () => { await result.current.runBenchmark('none'); });

      expect(axios.post.mock.calls[0][2]).toEqual({ headers: { 'x-access-token': '' } });
    });

    it('reports testing while the request is in flight', async () => {
      axios.post.mockReturnValue(new Promise(() => {}));
      const { result } = renderHook(() => useTuningBenchmark('tok'));

      act(() => { void result.current.runBenchmark('none'); });

      expect(result.current.testing).toBe(true);
      expect(result.current.progress).toEqual({ completed: 0, total: 0 });
    });

    it('clears the previous results as soon as a new run starts', async () => {
      const { result } = renderHook(() => useTuningBenchmark('tok'));
      await act(async () => { await result.current.runBenchmark('vaapi'); });
      expect(result.current.matrix).not.toBeNull();
      axios.post.mockReturnValue(new Promise(() => {}));

      act(() => { void result.current.runBenchmark('vaapi'); });

      expect(result.current.matrix).toBeNull();
      expect(result.current.recommended).toBeNull();
      expect(result.current.resultHardwareMode).toBeNull();
    });
  });

  describe('successful run', () => {
    it('exposes the matrix and recommendations', async () => {
      const { result } = renderHook(() => useTuningBenchmark('tok'));

      await act(async () => { await result.current.runBenchmark('vaapi'); });

      expect(result.current.matrix).toEqual(matrix);
      expect(result.current.recommended).toEqual(recommended);
    });

    it('exposes the options the server actually used', async () => {
      const { result } = renderHook(() => useTuningBenchmark('tok'));

      await act(async () => { await result.current.runBenchmark('vaapi'); });

      expect(result.current).toMatchObject({
        resultHardwareMode: 'vaapi',
        resultDecodeMode: 'vaapi',
        resultSourceCodec: 'vp9',
        resultVideoCodec: 'hevc',
        resultDecodeSourceHeight: 2160,
        resultVaapiQuality: 4,
      });
    });

    it('falls back to the requested hardware mode and defaults when the server omits them', async () => {
      axios.post.mockResolvedValue({ data: { ok: true, matrix, recommended } });
      const { result } = renderHook(() => useTuningBenchmark('tok'));

      await act(async () => { await result.current.runBenchmark('qsv'); });

      expect(result.current).toMatchObject({
        resultHardwareMode: 'qsv',
        resultDecodeMode: 'none',
        resultSourceCodec: null,
        resultVideoCodec: 'h264',
        resultDecodeSourceHeight: null,
        resultVaapiQuality: null,
      });
    });

    it('finishes testing and clears progress', async () => {
      const { result } = renderHook(() => useTuningBenchmark('tok'));

      await act(async () => { await result.current.runBenchmark('vaapi'); });

      expect(result.current.testing).toBe(false);
      expect(result.current.progress).toBeNull();
    });

    it('appends the run to the session history', async () => {
      const { result } = renderHook(() => useTuningBenchmark('tok'));

      await act(async () => { await result.current.runBenchmark('vaapi'); });

      expect(result.current.history).toHaveLength(1);
      expect(result.current.history[0]).toMatchObject({ hardwareMode: 'vaapi', decodeMode: 'vaapi', videoCodec: 'hevc', matrix, recommended });
      expect(result.current.history[0].completedAt).toEqual(expect.any(String));
    });

    it('keeps every run in the history, oldest first', async () => {
      const { result } = renderHook(() => useTuningBenchmark('tok'));

      await act(async () => { await result.current.runBenchmark('vaapi'); });
      axios.post.mockResolvedValue(okResponse({ hardwareMode: 'nvenc' }));
      await act(async () => { await result.current.runBenchmark('nvenc'); });

      expect(result.current.history.map((h) => h.hardwareMode)).toEqual(['vaapi', 'nvenc']);
    });
  });

  describe('failures', () => {
    it('shows the server message when the run reports failure', async () => {
      axios.post.mockResolvedValue({ data: { ok: false, error: 'ffmpeg not found' } });
      const { result } = renderHook(() => useTuningBenchmark('tok'));

      await act(async () => { await result.current.runBenchmark('vaapi'); });

      expect(result.current.error).toBe('ffmpeg not found');
    });

    it('uses a generic message when a failed run has no error text', async () => {
      axios.post.mockResolvedValue({ data: { ok: false } });
      const { result } = renderHook(() => useTuningBenchmark('tok'));

      await act(async () => { await result.current.runBenchmark('vaapi'); });

      expect(result.current.error).toBe('Encoding tuning benchmark failed');
    });

    it('treats an ok response with no matrix as a failure', async () => {
      axios.post.mockResolvedValue({ data: { ok: true } });
      const { result } = renderHook(() => useTuningBenchmark('tok'));

      await act(async () => { await result.current.runBenchmark('vaapi'); });

      expect(result.current.error).toBe('Encoding tuning benchmark failed');
      expect(result.current.history).toEqual([]);
    });

    it('shows the server message when the request throws', async () => {
      axios.post.mockRejectedValue({ response: { data: { error: 'A benchmark is already running' } } });
      const { result } = renderHook(() => useTuningBenchmark('tok'));

      await act(async () => { await result.current.runBenchmark('vaapi'); });

      expect(result.current.error).toBe('A benchmark is already running');
    });

    it('uses a generic retry message when the request throws without server text', async () => {
      axios.post.mockRejectedValue(new Error('network'));
      const { result } = renderHook(() => useTuningBenchmark('tok'));

      await act(async () => { await result.current.runBenchmark('vaapi'); });

      expect(result.current.error).toBe('Encoding tuning benchmark failed; please try again');
    });

    it('stops testing after a failure', async () => {
      axios.post.mockRejectedValue(new Error('network'));
      const { result } = renderHook(() => useTuningBenchmark('tok'));

      await act(async () => { await result.current.runBenchmark('vaapi'); });

      expect(result.current.testing).toBe(false);
      expect(result.current.progress).toBeNull();
    });

    it('clears an earlier error when a new run starts', async () => {
      axios.post.mockRejectedValueOnce(new Error('network'));
      const { result } = renderHook(() => useTuningBenchmark('tok'));
      await act(async () => { await result.current.runBenchmark('vaapi'); });

      await act(async () => { await result.current.runBenchmark('vaapi'); });

      expect(result.current.error).toBeNull();
    });
  });

  describe('live progress', () => {
    type Callback = (payload: unknown) => void;

    function buildWebSocket() {
      let filter: ((message: { type?: string }) => boolean) | null = null;
      let callback: Callback | null = null;
      const subscribe = jest.fn((f: typeof filter, c: Callback) => { filter = f; callback = c; });
      const unsubscribe = jest.fn();
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <WebSocketContext.Provider value={{ socket: null, isConnected: true, subscribe: subscribe as never, unsubscribe }}>
          {children}
        </WebSocketContext.Provider>
      );
      return { wrapper, subscribe, unsubscribe, getFilter: () => filter, deliver: (payload: unknown) => act(() => callback?.(payload)) };
    }

    it('subscribes only to tuningBenchmarkProgress messages', async () => {
      const ws = buildWebSocket();

      renderHook(() => useTuningBenchmark('tok'), { wrapper: ws.wrapper });

      await waitFor(() => expect(ws.subscribe).toHaveBeenCalled());
      expect(ws.getFilter()?.({ type: 'tuningBenchmarkProgress' })).toBe(true);
      expect(ws.getFilter()?.({ type: 'streamProgress' })).toBe(false);
    });

    it('reports progress while running', async () => {
      const ws = buildWebSocket();
      const { result } = renderHook(() => useTuningBenchmark('tok'), { wrapper: ws.wrapper });
      await waitFor(() => expect(ws.subscribe).toHaveBeenCalled());

      ws.deliver({ running: true, hardwareMode: 'vaapi', completed: 3, total: 12, current: { tuning: 'fast', height: 1080 }, decodeMode: 'vaapi' });

      expect(result.current.progress).toEqual({ completed: 3, total: 12, current: { tuning: 'fast', height: 1080 }, decodeMode: 'vaapi' });
    });

    it('ignores a message that says the run is not running', async () => {
      const ws = buildWebSocket();
      const { result } = renderHook(() => useTuningBenchmark('tok'), { wrapper: ws.wrapper });
      await waitFor(() => expect(ws.subscribe).toHaveBeenCalled());

      ws.deliver({ running: false, hardwareMode: 'vaapi', completed: 12, total: 12 });

      expect(result.current.progress).toBeNull();
    });

    it('unsubscribes on unmount', async () => {
      const ws = buildWebSocket();
      const { unmount } = renderHook(() => useTuningBenchmark('tok'), { wrapper: ws.wrapper });
      await waitFor(() => expect(ws.subscribe).toHaveBeenCalled());

      unmount();

      expect(ws.unsubscribe).toHaveBeenCalled();
    });
  });
});
