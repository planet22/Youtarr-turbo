import { renderHook, act } from '@testing-library/react';
import axios from 'axios';
import { useClearEventLog } from '../useClearEventLog';

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn(), delete: jest.fn(), isAxiosError: jest.fn(() => false) },
}));
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('useClearEventLog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockedAxios.isAxiosError as unknown as jest.Mock).mockReturnValue(false);
  });

  test('starts with no count and nothing in progress', () => {
    const { result } = renderHook(() => useClearEventLog('tok'));

    expect(result.current).toMatchObject({ eventCount: null, loadingCount: false, clearing: false, error: null });
  });

  test('counts the events with a one-row request, sending the token', async () => {
    mockedAxios.get.mockResolvedValue({ data: { events: [], total: 137 } });
    const { result } = renderHook(() => useClearEventLog('tok'));

    await act(async () => {
      await result.current.fetchCount();
    });

    expect(mockedAxios.get).toHaveBeenCalledWith('/api/job-events', {
      headers: { 'x-access-token': 'tok' },
      params: { limit: 1 },
    });
  });

  test('exposes the counted total', async () => {
    mockedAxios.get.mockResolvedValue({ data: { events: [], total: 137 } });
    const { result } = renderHook(() => useClearEventLog('tok'));

    await act(async () => {
      await result.current.fetchCount();
    });

    expect(result.current.eventCount).toBe(137);
  });

  test('reports an error and no count when counting fails', async () => {
    mockedAxios.get.mockRejectedValue(new Error('down'));
    const { result } = renderHook(() => useClearEventLog('tok'));

    await act(async () => {
      await result.current.fetchCount();
    });

    expect(result.current.error).toBe('Failed to count the event log');
    expect(result.current.eventCount).toBeNull();
  });

  test('deletes through DELETE /api/job-events and returns how many were removed', async () => {
    mockedAxios.delete.mockResolvedValue({ data: { success: true, deletedCount: 137 } });
    const { result } = renderHook(() => useClearEventLog('tok'));
    let removed: number | null = null;

    await act(async () => {
      removed = await result.current.clear();
    });

    expect(mockedAxios.delete).toHaveBeenCalledWith('/api/job-events', { headers: { 'x-access-token': 'tok' } });
    expect(removed).toBe(137);
  });

  test('forgets the count after clearing', async () => {
    mockedAxios.get.mockResolvedValue({ data: { events: [], total: 5 } });
    mockedAxios.delete.mockResolvedValue({ data: { success: true, deletedCount: 5 } });
    const { result } = renderHook(() => useClearEventLog('tok'));
    await act(async () => {
      await result.current.fetchCount();
    });

    await act(async () => {
      await result.current.clear();
    });

    expect(result.current.eventCount).toBeNull();
  });

  test('reports an error and returns null when clearing fails', async () => {
    mockedAxios.delete.mockRejectedValue(new Error('down'));
    const { result } = renderHook(() => useClearEventLog('tok'));
    let removed: number | null = 1;

    await act(async () => {
      removed = await result.current.clear();
    });

    expect(removed).toBeNull();
    expect(result.current.error).toBe('Failed to clear the event log');
  });

  test('uses the server message when it sends one', async () => {
    (mockedAxios.isAxiosError as unknown as jest.Mock).mockReturnValue(true);
    mockedAxios.delete.mockRejectedValue({ response: { data: { error: 'Failed to clear the video/events log' } } });
    const { result } = renderHook(() => useClearEventLog('tok'));

    await act(async () => {
      await result.current.clear();
    });

    expect(result.current.error).toBe('Failed to clear the video/events log');
  });

  test('dismiss closes the confirmation without deleting', async () => {
    mockedAxios.get.mockResolvedValue({ data: { events: [], total: 9 } });
    const { result } = renderHook(() => useClearEventLog('tok'));
    await act(async () => {
      await result.current.fetchCount();
    });

    act(() => result.current.dismiss());

    expect(result.current.eventCount).toBeNull();
    expect(mockedAxios.delete).not.toHaveBeenCalled();
  });
});
