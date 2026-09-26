import { renderHook, act, waitFor } from '@testing-library/react';

jest.mock('axios', () => ({
  get: jest.fn(),
  delete: jest.fn(),
}));

import axios from 'axios';
import { useUntrackedCache } from '../useUntrackedCache';

const mockedGet = axios.get as jest.MockedFunction<typeof axios.get>;
const mockedDelete = axios.delete as jest.MockedFunction<typeof axios.delete>;

describe('useUntrackedCache', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('loading the cache size', () => {
    it('starts with unknown sizes', () => {
      mockedGet.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() => useUntrackedCache('tok'));

      expect(result.current).toMatchObject({ fileCount: null, totalBytes: null, error: null, clearing: false });
    });

    it('reads the file count and total size on mount', async () => {
      mockedGet.mockResolvedValueOnce({ data: { fileCount: 3, totalBytes: 2048 } });

      const { result } = renderHook(() => useUntrackedCache('tok'));

      await waitFor(() => expect(result.current.fileCount).toBe(3));
      expect(result.current.totalBytes).toBe(2048);
      expect(mockedGet).toHaveBeenCalledWith('/api/ytstream/untracked-cache', { headers: { 'x-access-token': 'tok' } });
    });

    it('shows it is loading while the request is in flight', async () => {
      let resolve: (value: unknown) => void = () => {};
      mockedGet.mockReturnValueOnce(new Promise((r) => { resolve = r; }) as never);

      const { result } = renderHook(() => useUntrackedCache('tok'));

      await waitFor(() => expect(result.current.loading).toBe(true));
      await act(async () => { resolve({ data: { fileCount: 0, totalBytes: 0 } }); });
      expect(result.current.loading).toBe(false);
    });

    it('does not fetch without a token', () => {
      renderHook(() => useUntrackedCache(null));

      expect(mockedGet).not.toHaveBeenCalled();
    });

    it('fetches again when the token changes', async () => {
      mockedGet.mockResolvedValue({ data: { fileCount: 1, totalBytes: 1 } });

      const { rerender } = renderHook(({ token }: { token: string | null }) => useUntrackedCache(token), { initialProps: { token: 'a' as string | null } });
      await waitFor(() => expect(mockedGet).toHaveBeenCalledTimes(1));
      rerender({ token: 'b' });

      await waitFor(() => expect(mockedGet).toHaveBeenCalledTimes(2));
    });

    it('shows the server\'s error message when loading fails', async () => {
      mockedGet.mockRejectedValueOnce({ response: { data: { error: 'cache dir unreadable' } } });

      const { result } = renderHook(() => useUntrackedCache('tok'));

      await waitFor(() => expect(result.current.error).toBe('cache dir unreadable'));
      expect(result.current.loading).toBe(false);
    });

    it('shows a generic error when the failure has no message', async () => {
      mockedGet.mockRejectedValueOnce(new Error('network'));

      const { result } = renderHook(() => useUntrackedCache('tok'));

      await waitFor(() => expect(result.current.error).toBe('Failed to load untracked cache size'));
    });

    it('clears an earlier error on a successful refresh', async () => {
      mockedGet.mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce({ data: { fileCount: 5, totalBytes: 9 } });
      const { result } = renderHook(() => useUntrackedCache('tok'));
      await waitFor(() => expect(result.current.error).not.toBeNull());

      await act(async () => { await result.current.refresh(); });

      expect(result.current.error).toBeNull();
      expect(result.current.fileCount).toBe(5);
    });
  });

  describe('clearing the cache', () => {
    beforeEach(() => {
      mockedGet.mockResolvedValue({ data: { fileCount: 4, totalBytes: 4096 } });
    });

    it('deletes the cache and zeroes the sizes', async () => {
      mockedDelete.mockResolvedValueOnce({});
      const { result } = renderHook(() => useUntrackedCache('tok'));
      await waitFor(() => expect(result.current.fileCount).toBe(4));

      await act(async () => { await result.current.clear(); });

      expect(mockedDelete).toHaveBeenCalledWith('/api/ytstream/untracked-cache', { headers: { 'x-access-token': 'tok' } });
      expect(result.current.fileCount).toBe(0);
      expect(result.current.totalBytes).toBe(0);
    });

    it('is only busy while the request runs', async () => {
      let resolve: (value: unknown) => void = () => {};
      mockedDelete.mockReturnValueOnce(new Promise((r) => { resolve = r; }) as never);
      const { result } = renderHook(() => useUntrackedCache('tok'));
      await waitFor(() => expect(result.current.fileCount).toBe(4));

      act(() => { void result.current.clear(); });
      await waitFor(() => expect(result.current.clearing).toBe(true));
      await act(async () => { resolve({}); });

      expect(result.current.clearing).toBe(false);
    });

    it('keeps the old sizes and shows the server\'s error when deleting fails', async () => {
      mockedDelete.mockRejectedValueOnce({ response: { data: { error: 'in use' } } });
      const { result } = renderHook(() => useUntrackedCache('tok'));
      await waitFor(() => expect(result.current.fileCount).toBe(4));

      await act(async () => { await result.current.clear(); });

      expect(result.current.error).toBe('in use');
      expect(result.current.fileCount).toBe(4);
    });

    it('shows a generic error when the failure has no message', async () => {
      mockedDelete.mockRejectedValueOnce(new Error('network'));
      const { result } = renderHook(() => useUntrackedCache('tok'));
      await waitFor(() => expect(result.current.fileCount).toBe(4));

      await act(async () => { await result.current.clear(); });

      expect(result.current.error).toBe('Failed to delete untracked cache');
    });

    it('does nothing without a token', async () => {
      const { result } = renderHook(() => useUntrackedCache(null));

      await act(async () => { await result.current.clear(); });

      expect(mockedDelete).not.toHaveBeenCalled();
    });
  });
});
