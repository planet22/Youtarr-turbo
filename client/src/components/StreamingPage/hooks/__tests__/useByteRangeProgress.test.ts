import { renderHook, act } from '@testing-library/react';

jest.mock('axios', () => ({ get: jest.fn() }));
const axios = require('axios');

import { useByteRangeProgress, ByteRangeProgress } from '../useByteRangeProgress';

const buildProgress = (currentSizeBytes: number | null): ByteRangeProgress => ({
  sessionKey: 'sess',
  youtubeId: 'abc123DEF45',
  deliverAsFile: false,
  currentSizeBytes,
  elapsedMs: 1000,
  ytVideoExitCode: null,
  ytAudioExitCode: null,
  ffExitCode: null,
  failed: false,
  failReason: null,
  complete: false,
});

describe('useByteRangeProgress', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    axios.get.mockResolvedValue({ data: buildProgress(1000) });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // flush the promise queue without advancing the clock
  const flush = () => act(async () => { await Promise.resolve(); });

  it('does not poll while disabled', async () => {
    renderHook(() => useByteRangeProgress('abc123DEF45', 'sess', 'tok', false));

    await flush();

    expect(axios.get).not.toHaveBeenCalled();
  });

  it('starts with no progress, rate or error', () => {
    const { result } = renderHook(() => useByteRangeProgress('abc123DEF45', 'sess', 'tok', false));

    expect(result.current).toEqual({ progress: null, bytesPerSecond: null, error: null });
  });

  it('polls immediately once enabled, with the token', async () => {
    renderHook(() => useByteRangeProgress('abc123DEF45', 'sess', 'tok', true));

    await flush();

    expect(axios.get).toHaveBeenCalledWith('/api/ytstream/abc123DEF45/byterange-hls/sess/progress', { headers: { 'x-access-token': 'tok' } });
  });

  it('sends an empty token header when there is no token', async () => {
    renderHook(() => useByteRangeProgress('abc123DEF45', 'sess', null, true));

    await flush();

    expect(axios.get.mock.calls[0][1]).toEqual({ headers: { 'x-access-token': '' } });
  });

  it('url-encodes the video id', async () => {
    renderHook(() => useByteRangeProgress('a/b c', 'sess', 'tok', true));

    await flush();

    expect(axios.get.mock.calls[0][0]).toBe('/api/ytstream/a%2Fb%20c/byterange-hls/sess/progress');
  });

  it('exposes the latest progress', async () => {
    const { result } = renderHook(() => useByteRangeProgress('abc123DEF45', 'sess', 'tok', true));

    await flush();

    expect(result.current.progress).toEqual(buildProgress(1000));
  });

  it('polls again every 1.5 seconds', async () => {
    renderHook(() => useByteRangeProgress('abc123DEF45', 'sess', 'tok', true));
    await flush();

    await act(async () => { jest.advanceTimersByTime(3000); });

    expect(axios.get).toHaveBeenCalledTimes(3);
  });

  it('has no rate from a single sample', async () => {
    const { result } = renderHook(() => useByteRangeProgress('abc123DEF45', 'sess', 'tok', true));

    await flush();

    expect(result.current.bytesPerSecond).toBeNull();
  });

  it('derives bytes per second from consecutive samples', async () => {
    axios.get
      .mockResolvedValueOnce({ data: buildProgress(0) })
      .mockResolvedValueOnce({ data: buildProgress(3000) });
    const { result } = renderHook(() => useByteRangeProgress('abc123DEF45', 'sess', 'tok', true));
    await flush();

    await act(async () => { jest.advanceTimersByTime(1500); });

    // 3000 bytes over 1.5s
    expect(result.current.bytesPerSecond).toBe(2000);
  });

  it('treats a missing size as zero when computing the rate', async () => {
    axios.get
      .mockResolvedValueOnce({ data: buildProgress(null) })
      .mockResolvedValueOnce({ data: buildProgress(1500) });
    const { result } = renderHook(() => useByteRangeProgress('abc123DEF45', 'sess', 'tok', true));
    await flush();

    await act(async () => { jest.advanceTimersByTime(1500); });

    expect(result.current.bytesPerSecond).toBe(1000);
  });

  it('averages over only the six most recent samples', async () => {
    let size = 0;
    axios.get.mockImplementation(async () => ({ data: buildProgress((size += 1500)) }));
    const { result } = renderHook(() => useByteRangeProgress('abc123DEF45', 'sess', 'tok', true));
    await flush();

    // 10 samples in total; only the latest 6 (5 intervals) are kept
    for (let tick = 0; tick < 9; tick++) {
      await act(async () => { jest.advanceTimersByTime(1500); });
    }

    expect(result.current.bytesPerSecond).toBe(1000);
  });

  it('reports the error message when a poll fails', async () => {
    axios.get.mockRejectedValue(new Error('gateway timeout'));

    const { result } = renderHook(() => useByteRangeProgress('abc123DEF45', 'sess', 'tok', true));
    await flush();

    expect(result.current.error).toBe('gateway timeout');
  });

  it('uses a generic message for a non-Error rejection', async () => {
    axios.get.mockRejectedValue('nope');

    const { result } = renderHook(() => useByteRangeProgress('abc123DEF45', 'sess', 'tok', true));
    await flush();

    expect(result.current.error).toBe('Failed to load progress');
  });

  it('clears the error after a later successful poll', async () => {
    axios.get.mockRejectedValueOnce(new Error('blip'));
    const { result } = renderHook(() => useByteRangeProgress('abc123DEF45', 'sess', 'tok', true));
    await flush();

    await act(async () => { jest.advanceTimersByTime(1500); });

    expect(result.current.error).toBeNull();
  });

  it('stops polling and ignores late responses on unmount', async () => {
    const { unmount } = renderHook(() => useByteRangeProgress('abc123DEF45', 'sess', 'tok', true));
    await flush();
    unmount();
    axios.get.mockClear();

    await act(async () => { jest.advanceTimersByTime(10000); });

    expect(axios.get).not.toHaveBeenCalled();
  });

  it('resets its state when disabled again', async () => {
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useByteRangeProgress('abc123DEF45', 'sess', 'tok', enabled),
      { initialProps: { enabled: true } }
    );
    await flush();
    expect(result.current.progress).not.toBeNull();

    rerender({ enabled: false });

    expect(result.current).toEqual({ progress: null, bytesPerSecond: null, error: null });
  });

  it('restarts polling for a different session', async () => {
    const { rerender } = renderHook(
      ({ sessionKey }: { sessionKey: string }) => useByteRangeProgress('abc123DEF45', sessionKey, 'tok', true),
      { initialProps: { sessionKey: 'one' } }
    );
    await flush();

    rerender({ sessionKey: 'two' });
    await flush();

    expect(axios.get.mock.calls.map((c: string[]) => c[0])).toEqual([
      '/api/ytstream/abc123DEF45/byterange-hls/one/progress',
      '/api/ytstream/abc123DEF45/byterange-hls/two/progress',
    ]);
  });
});
