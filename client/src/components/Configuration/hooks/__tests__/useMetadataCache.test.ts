import { renderHook, act, waitFor } from '@testing-library/react';

jest.mock('axios', () => ({
  get: jest.fn(),
  delete: jest.fn(),
}));

import axios from 'axios';
import { useMetadataCache } from '../useMetadataCache';

const mockedGet = axios.get as jest.MockedFunction<typeof axios.get>;
const mockedDelete = axios.delete as jest.MockedFunction<typeof axios.delete>;

describe('useMetadataCache', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('loading the count', () => {
    it('starts with an unknown count', () => {
      mockedGet.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() => useMetadataCache('tok'));

      expect(result.current).toMatchObject({ count: null, error: null, clearing: false });
    });

    it('reads the count on mount', async () => {
      mockedGet.mockResolvedValueOnce({ data: { count: 12 } });

      const { result } = renderHook(() => useMetadataCache('tok'));

      await waitFor(() => expect(result.current.count).toBe(12));
      expect(mockedGet).toHaveBeenCalledWith('/api/ytstream/metadata-cache', { headers: { 'x-access-token': 'tok' } });
    });

    it('does not fetch without a token', () => {
      renderHook(() => useMetadataCache(null));

      expect(mockedGet).not.toHaveBeenCalled();
    });

    it('is only loading while the request runs', async () => {
      let resolve: (value: unknown) => void = () => {};
      mockedGet.mockReturnValueOnce(new Promise((r) => { resolve = r; }) as never);

      const { result } = renderHook(() => useMetadataCache('tok'));

      await waitFor(() => expect(result.current.loading).toBe(true));
      await act(async () => { resolve({ data: { count: 1 } }); });
      expect(result.current.loading).toBe(false);
    });

    it('shows the server\'s error message when loading fails', async () => {
      mockedGet.mockRejectedValueOnce({ response: { data: { error: 'db down' } } });

      const { result } = renderHook(() => useMetadataCache('tok'));

      await waitFor(() => expect(result.current.error).toBe('db down'));
    });

    it('shows a generic error when the failure has no message', async () => {
      mockedGet.mockRejectedValueOnce(new Error('network'));

      const { result } = renderHook(() => useMetadataCache('tok'));

      await waitFor(() => expect(result.current.error).toBe('Failed to load metadata cache size'));
    });

    it('refreshes on demand', async () => {
      mockedGet.mockResolvedValueOnce({ data: { count: 1 } }).mockResolvedValueOnce({ data: { count: 2 } });
      const { result } = renderHook(() => useMetadataCache('tok'));
      await waitFor(() => expect(result.current.count).toBe(1));

      await act(async () => { await result.current.refresh(); });

      expect(result.current.count).toBe(2);
    });
  });

  describe('clearing the cache', () => {
    beforeEach(() => {
      mockedGet.mockResolvedValue({ data: { count: 7 } });
    });

    it('deletes the cache and zeroes the count', async () => {
      mockedDelete.mockResolvedValueOnce({});
      const { result } = renderHook(() => useMetadataCache('tok'));
      await waitFor(() => expect(result.current.count).toBe(7));

      await act(async () => { await result.current.clear(); });

      expect(mockedDelete).toHaveBeenCalledWith('/api/ytstream/metadata-cache', { headers: { 'x-access-token': 'tok' } });
      expect(result.current.count).toBe(0);
    });

    it('is only busy while the request runs', async () => {
      let resolve: (value: unknown) => void = () => {};
      mockedDelete.mockReturnValueOnce(new Promise((r) => { resolve = r; }) as never);
      const { result } = renderHook(() => useMetadataCache('tok'));
      await waitFor(() => expect(result.current.count).toBe(7));

      act(() => { void result.current.clear(); });
      await waitFor(() => expect(result.current.clearing).toBe(true));
      await act(async () => { resolve({}); });

      expect(result.current.clearing).toBe(false);
    });

    it('keeps the old count and shows the server\'s error when deleting fails', async () => {
      mockedDelete.mockRejectedValueOnce({ response: { data: { error: 'locked' } } });
      const { result } = renderHook(() => useMetadataCache('tok'));
      await waitFor(() => expect(result.current.count).toBe(7));

      await act(async () => { await result.current.clear(); });

      expect(result.current.error).toBe('locked');
      expect(result.current.count).toBe(7);
    });

    it('shows a generic error when the failure has no message', async () => {
      mockedDelete.mockRejectedValueOnce(new Error('network'));
      const { result } = renderHook(() => useMetadataCache('tok'));
      await waitFor(() => expect(result.current.count).toBe(7));

      await act(async () => { await result.current.clear(); });

      expect(result.current.error).toBe('Failed to delete metadata cache');
    });

    it('does nothing without a token', async () => {
      const { result } = renderHook(() => useMetadataCache(null));

      await act(async () => { await result.current.clear(); });

      expect(mockedDelete).not.toHaveBeenCalled();
    });
  });
});
