import { renderHook, waitFor, act } from '@testing-library/react';
import axios from 'axios';
import { useCompactHistory } from '../useCompactHistory';

jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
  isAxiosError: (err: unknown): boolean =>
    typeof err === 'object' && err !== null && 'response' in err
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('useCompactHistory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('fetchPreview GETs the preview endpoint and stores the counts', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { totalJobs: 50, compactableCount: 42 } });

    const { result } = renderHook(() => useCompactHistory('tok'));

    await act(async () => {
      await result.current.fetchPreview();
    });

    expect(mockedAxios.get).toHaveBeenCalledWith(
      '/api/maintenance/compact-history-preview',
      expect.objectContaining({ headers: { 'x-access-token': 'tok' } })
    );
    expect(result.current.preview).toEqual({ totalJobs: 50, compactableCount: 42 });
    expect(result.current.loadingPreview).toBe(false);
    expect(result.current.error).toBeNull();
  });

  test('fetchPreview surfaces a load failure', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('Network Error'));

    const { result } = renderHook(() => useCompactHistory('tok'));

    await act(async () => {
      await result.current.fetchPreview();
    });

    expect(result.current.preview).toBeNull();
    expect(result.current.error).toBe('Network Error');
  });

  test('compact POSTs, clears the preview, and returns the deleted count', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { totalJobs: 50, compactableCount: 42 } });
    mockedAxios.post.mockResolvedValueOnce({ data: { success: true, deletedCount: 42 } });

    const { result } = renderHook(() => useCompactHistory('tok'));

    await act(async () => {
      await result.current.fetchPreview();
    });
    expect(result.current.preview).not.toBeNull();

    let deletedCount: number | null = null;
    await act(async () => {
      deletedCount = await result.current.compact();
    });

    expect(mockedAxios.post).toHaveBeenCalledWith(
      '/api/maintenance/compact-history',
      undefined,
      expect.objectContaining({ headers: { 'x-access-token': 'tok' } })
    );
    expect(deletedCount).toBe(42);
    expect(result.current.preview).toBeNull();
    expect(result.current.compacting).toBe(false);
  });

  test('compact surfaces the server error message on failure', async () => {
    const err = new Error('Server exploded') as Error & {
      response: { status: number; data: { error: string } };
    };
    err.response = { status: 500, data: { error: 'Failed to compact history' } };
    mockedAxios.post.mockRejectedValueOnce(err);

    const { result } = renderHook(() => useCompactHistory('tok'));

    let deletedCount: number | null = 0;
    await act(async () => {
      deletedCount = await result.current.compact();
    });

    expect(deletedCount).toBeNull();
    expect(result.current.error).toBe('Failed to compact history');
  });

  test('clearPreview resets the preview without a network call', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { totalJobs: 50, compactableCount: 42 } });

    const { result } = renderHook(() => useCompactHistory('tok'));
    await act(async () => {
      await result.current.fetchPreview();
    });
    expect(result.current.preview).not.toBeNull();

    act(() => {
      result.current.clearPreview();
    });

    expect(result.current.preview).toBeNull();
  });
});
