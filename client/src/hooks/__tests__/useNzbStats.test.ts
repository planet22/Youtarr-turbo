import { renderHook, waitFor, act } from '@testing-library/react';

jest.mock('axios', () => ({ get: jest.fn(), delete: jest.fn(), post: jest.fn() }));
const axios = require('axios');

import { useNzbStats } from '../useNzbStats';

const stats = { totalQueries: 3, cacheHits: 1, cacheMisses: 2 };

describe('useNzbStats', () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    axios.get.mockResolvedValue({ data: stats });
    axios.delete.mockResolvedValue({});
    axios.post.mockResolvedValue({});
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
    jest.useRealTimers();
  });

  describe('loading stats', () => {
    it('fetches the stats with the access token', async () => {
      renderHook(() => useNzbStats('tok'));

      await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/nzb/stats', { headers: { 'x-access-token': 'tok' } }));
    });

    it('is loading until the first response', async () => {
      const { result } = renderHook(() => useNzbStats('tok'));

      expect(result.current.loading).toBe(true);
      await waitFor(() => expect(result.current.loading).toBe(false));
    });

    it('exposes the fetched stats', async () => {
      const { result } = renderHook(() => useNzbStats('tok'));

      await waitFor(() => expect(result.current.stats).toEqual(stats));
      expect(result.current.error).toBe(false);
    });

    it('does not fetch without a token', async () => {
      const { result } = renderHook(() => useNzbStats(null));

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(axios.get).not.toHaveBeenCalled();
    });

    it('flags an error and logs when the fetch fails', async () => {
      axios.get.mockRejectedValue(new Error('down'));

      const { result } = renderHook(() => useNzbStats('tok'));

      await waitFor(() => expect(result.current.error).toBe(true));
      expect(result.current.loading).toBe(false);
      expect(consoleError).toHaveBeenCalled();
    });

    it('keeps the last stats after a failed poll', async () => {
      const { result } = renderHook(() => useNzbStats('tok'));
      await waitFor(() => expect(result.current.stats).toEqual(stats));

      axios.get.mockRejectedValueOnce(new Error('blip'));
      await act(async () => { await result.current.refetch(); });

      expect(result.current.stats).toEqual(stats);
      expect(result.current.error).toBe(true);
    });

    it('clears the error once a later fetch succeeds', async () => {
      axios.get.mockRejectedValueOnce(new Error('blip'));
      const { result } = renderHook(() => useNzbStats('tok'));
      await waitFor(() => expect(result.current.error).toBe(true));

      await act(async () => { await result.current.refetch(); });

      expect(result.current.error).toBe(false);
    });
  });

  describe('polling', () => {
    it('refetches every 5 seconds', async () => {
      jest.useFakeTimers();
      renderHook(() => useNzbStats('tok'));
      await act(async () => { await Promise.resolve(); });
      expect(axios.get).toHaveBeenCalledTimes(1);

      await act(async () => { jest.advanceTimersByTime(10000); });

      expect(axios.get).toHaveBeenCalledTimes(3);
    });

    it('stops polling on unmount', async () => {
      jest.useFakeTimers();
      const { unmount } = renderHook(() => useNzbStats('tok'));
      await act(async () => { await Promise.resolve(); });
      unmount();
      axios.get.mockClear();

      await act(async () => { jest.advanceTimersByTime(20000); });

      expect(axios.get).not.toHaveBeenCalled();
    });
  });

  describe('deleteCacheEntries', () => {
    it('deletes the cache keys then refreshes', async () => {
      const { result } = renderHook(() => useNzbStats('tok'));
      await waitFor(() => expect(result.current.loading).toBe(false));
      axios.get.mockClear();

      await act(async () => { await result.current.deleteCacheEntries(['k1', 'k2']); });

      expect(axios.delete).toHaveBeenCalledWith('/api/nzb/cache', { headers: { 'x-access-token': 'tok' }, data: { keys: ['k1', 'k2'] } });
      expect(axios.get).toHaveBeenCalledTimes(1);
    });

    it('does nothing for an empty list', async () => {
      const { result } = renderHook(() => useNzbStats('tok'));
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => { await result.current.deleteCacheEntries([]); });

      expect(axios.delete).not.toHaveBeenCalled();
    });

    it('does nothing without a token', async () => {
      const { result } = renderHook(() => useNzbStats(null));

      await act(async () => { await result.current.deleteCacheEntries(['k']); });

      expect(axios.delete).not.toHaveBeenCalled();
    });
  });

  describe('cancelCurrentJob', () => {
    it('terminates the running job then refreshes', async () => {
      const { result } = renderHook(() => useNzbStats('tok'));
      await waitFor(() => expect(result.current.loading).toBe(false));
      axios.get.mockClear();

      await act(async () => { await result.current.cancelCurrentJob(); });

      expect(axios.post).toHaveBeenCalledWith('/api/jobs/terminate', {}, { headers: { 'x-access-token': 'tok' } });
      expect(axios.get).toHaveBeenCalledTimes(1);
    });

    it('does nothing without a token', async () => {
      const { result } = renderHook(() => useNzbStats(null));

      await act(async () => { await result.current.cancelCurrentJob(); });

      expect(axios.post).not.toHaveBeenCalled();
    });
  });

  describe('clearFailedGrabs', () => {
    it('clears the failed grabs then refreshes', async () => {
      const { result } = renderHook(() => useNzbStats('tok'));
      await waitFor(() => expect(result.current.loading).toBe(false));
      axios.get.mockClear();

      await act(async () => { await result.current.clearFailedGrabs(); });

      expect(axios.delete).toHaveBeenCalledWith('/api/nzb/failed-grabs', { headers: { 'x-access-token': 'tok' } });
      expect(axios.get).toHaveBeenCalledTimes(1);
    });

    it('does nothing without a token', async () => {
      const { result } = renderHook(() => useNzbStats(null));

      await act(async () => { await result.current.clearFailedGrabs(); });

      expect(axios.delete).not.toHaveBeenCalled();
    });
  });
});
