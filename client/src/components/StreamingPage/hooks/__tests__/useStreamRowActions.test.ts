import { renderHook, act, waitFor } from '@testing-library/react';

jest.mock('axios', () => ({ post: jest.fn() }));
const axios = require('axios');

import { useStreamRowActions } from '../useStreamRowActions';
import type { StreamSnapshot } from '../../../../hooks/useActiveStreams';

const NOW = 1_800_000_000_000;

const stream = (overrides: Partial<StreamSnapshot> = {}): StreamSnapshot => ({ streamId: 's 1/x', youtubeId: 'yt', startedAt: NOW - 65_000, ...overrides } as StreamSnapshot);

describe('useStreamRowActions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    axios.post.mockResolvedValue({});
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('elapsed clock', () => {
    it('starts at the time since the stream began', () => {
      const { result } = renderHook(() => useStreamRowActions(stream(), 'tok', jest.fn()));

      expect(result.current.elapsed).toBe('1:05');
    });

    it('ticks every second', () => {
      const { result } = renderHook(() => useStreamRowActions(stream(), 'tok', jest.fn()));

      act(() => { jest.advanceTimersByTime(3000); });

      expect(result.current.elapsed).toBe('1:08');
    });

    it('shows hours for a long stream', () => {
      const { result } = renderHook(() => useStreamRowActions(stream({ startedAt: NOW - (3600 + 61) * 1000 }), 'tok', jest.fn()));

      expect(result.current.elapsed).toBe('1:01:01');
    });

    it('restarts from the new start time when the stream changes', () => {
      const { result, rerender } = renderHook(({ s }: { s: StreamSnapshot }) => useStreamRowActions(s, 'tok', jest.fn()), { initialProps: { s: stream() } });

      rerender({ s: stream({ startedAt: NOW - 5000 }) });
      act(() => { jest.advanceTimersByTime(1000); });

      expect(result.current.elapsed).toBe('0:06');
    });

    it('stops ticking when unmounted', () => {
      const { unmount } = renderHook(() => useStreamRowActions(stream(), 'tok', jest.fn()));

      unmount();

      expect(jest.getTimerCount()).toBe(0);
    });
  });

  describe('stopping a stream', () => {
    it('is not stopping to begin with', () => {
      const { result } = renderHook(() => useStreamRowActions(stream(), 'tok', jest.fn()));

      expect(result.current.stopping).toBe(false);
    });

    it('posts the stop request with the encoded stream id and token', async () => {
      const { result } = renderHook(() => useStreamRowActions(stream(), 'tok', jest.fn()));

      await act(async () => { await result.current.handleStop(); });

      expect(axios.post).toHaveBeenCalledWith('/api/ytstream/streams/s%201%2Fx/stop', {}, { headers: { 'x-access-token': 'tok' } });
    });

    it('reports the stream as stopped and stays in the stopping state', async () => {
      const onStopped = jest.fn();
      const { result } = renderHook(() => useStreamRowActions(stream(), 'tok', onStopped));

      await act(async () => { await result.current.handleStop(); });

      expect(onStopped).toHaveBeenCalledWith('s 1/x');
      expect(result.current.stopping).toBe(true);
    });

    it('goes back to normal without reporting when the request fails', async () => {
      axios.post.mockRejectedValue(new Error('offline'));
      const onStopped = jest.fn();
      const { result } = renderHook(() => useStreamRowActions(stream(), 'tok', onStopped));

      await act(async () => { await result.current.handleStop(); });

      expect(onStopped).not.toHaveBeenCalled();
      expect(result.current.stopping).toBe(false);
    });

    it('does nothing without a token', async () => {
      const { result } = renderHook(() => useStreamRowActions(stream(), null, jest.fn()));

      await act(async () => { await result.current.handleStop(); });

      expect(axios.post).not.toHaveBeenCalled();
    });

    it('ignores a second click while a stop is in progress', async () => {
      let resolve: (value: unknown) => void = () => {};
      axios.post.mockReturnValue(new Promise((r) => { resolve = r; }));
      const { result } = renderHook(() => useStreamRowActions(stream(), 'tok', jest.fn()));

      act(() => { void result.current.handleStop(); });
      await waitFor(() => expect(result.current.stopping).toBe(true));
      await act(async () => { await result.current.handleStop(); });

      expect(axios.post).toHaveBeenCalledTimes(1);
      await act(async () => { resolve({}); });
    });
  });
});
