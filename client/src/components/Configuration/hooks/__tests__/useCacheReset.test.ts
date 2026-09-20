import { renderHook, act, waitFor } from '@testing-library/react';

jest.mock('axios', () => ({
  get: jest.fn(),
  delete: jest.fn(),
}));

import axios from 'axios';
import { useCacheReset } from '../useCacheReset';

const mockedAxiosGet = axios.get as jest.MockedFunction<typeof axios.get>;
const mockedAxiosDelete = axios.delete as jest.MockedFunction<typeof axios.delete>;

describe('useCacheReset', () => {
  beforeEach(() => jest.clearAllMocks());

  test('loads the row count from the given endpoint on mount', async () => {
    mockedAxiosGet.mockResolvedValueOnce({ data: { count: 42 } });

    const { result } = renderHook(() => useCacheReset('t', '/api/nzb/diagnostic-logs'));

    await waitFor(() => expect(result.current.count).toBe(42));
    expect(mockedAxiosGet).toHaveBeenCalledWith(
      '/api/nzb/diagnostic-logs',
      expect.objectContaining({ headers: { 'x-access-token': 't' } })
    );
  });

  test('does not fetch when token is null', () => {
    renderHook(() => useCacheReset(null, '/api/nzb/diagnostic-logs'));
    expect(mockedAxiosGet).not.toHaveBeenCalled();
  });

  test('sets an error when the count request fails', async () => {
    mockedAxiosGet.mockRejectedValueOnce({ response: { data: { error: 'boom' } } });

    const { result } = renderHook(() => useCacheReset('t', '/api/nzb/resolution-cache'));

    await waitFor(() => expect(result.current.error).toBe('boom'));
  });

  test('clear() deletes at the endpoint and resets count to 0', async () => {
    mockedAxiosGet.mockResolvedValueOnce({ data: { count: 10 } });
    mockedAxiosDelete.mockResolvedValueOnce({ data: { success: true } });

    const { result } = renderHook(() => useCacheReset('t', '/api/nzb/resolution-cache'));
    await waitFor(() => expect(result.current.count).toBe(10));

    await act(async () => {
      await result.current.clear();
    });

    expect(mockedAxiosDelete).toHaveBeenCalledWith(
      '/api/nzb/resolution-cache',
      expect.objectContaining({ headers: { 'x-access-token': 't' } })
    );
    expect(result.current.count).toBe(0);
    expect(result.current.clearing).toBe(false);
  });

  test('sets an error when clear() fails, without resetting count', async () => {
    mockedAxiosGet.mockResolvedValueOnce({ data: { count: 10 } });
    mockedAxiosDelete.mockRejectedValueOnce({ response: { data: { error: 'clear failed' } } });

    const { result } = renderHook(() => useCacheReset('t', '/api/nzb/resolution-cache'));
    await waitFor(() => expect(result.current.count).toBe(10));

    await act(async () => {
      await result.current.clear();
    });

    expect(result.current.error).toBe('clear failed');
    expect(result.current.count).toBe(10);
  });
});
