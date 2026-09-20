import { renderHook, waitFor, act } from '@testing-library/react';

jest.mock('axios', () => ({ get: jest.fn(), isAxiosError: jest.fn() }));
const axios = require('axios');

import { useMediaServerStatus } from '../useMediaServerStatus';

describe('useMediaServerStatus', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    axios.isAxiosError.mockReturnValue(false);
    axios.get.mockResolvedValue({ data: { plex: true, jellyfin: false, emby: false } });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('starts empty and not configured', () => {
    const { result } = renderHook(() => useMediaServerStatus(null));

    expect(result.current.status).toEqual({ plex: false, jellyfin: false, emby: false });
    expect(result.current.anyConfigured).toBe(false);
  });

  it('is not loading without a token', () => {
    const { result } = renderHook(() => useMediaServerStatus(null));

    expect(result.current.loading).toBe(false);
  });

  it('does not request anything without a token', async () => {
    renderHook(() => useMediaServerStatus(null));

    await act(async () => { await Promise.resolve(); });

    expect(axios.get).not.toHaveBeenCalled();
  });

  it('loads status with the access token', async () => {
    renderHook(() => useMediaServerStatus('tok'));

    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/mediaservers/status', { headers: { 'x-access-token': 'tok' } }));
  });

  it('exposes which servers are configured', async () => {
    axios.get.mockResolvedValue({ data: { plex: true, jellyfin: false, emby: true } });

    const { result } = renderHook(() => useMediaServerStatus('tok'));

    await waitFor(() => expect(result.current.status).toEqual({ plex: true, jellyfin: false, emby: true }));
    expect(result.current.anyConfigured).toBe(true);
  });

  it('coerces missing or truthy values to booleans', async () => {
    axios.get.mockResolvedValue({ data: { plex: 'yes' } });

    const { result } = renderHook(() => useMediaServerStatus('tok'));

    await waitFor(() => expect(result.current.status).toEqual({ plex: true, jellyfin: false, emby: false }));
  });

  it('reports none configured when every server is off', async () => {
    axios.get.mockResolvedValue({ data: { plex: false, jellyfin: false, emby: false } });

    const { result } = renderHook(() => useMediaServerStatus('tok'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.anyConfigured).toBe(false);
  });

  it('is loading until the first response', async () => {
    const { result } = renderHook(() => useMediaServerStatus('tok'));

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  describe('errors', () => {
    it('uses the server error message from an axios error', async () => {
      axios.isAxiosError.mockReturnValue(true);
      axios.get.mockRejectedValue({ response: { data: { error: 'Unauthorized' } } });

      const { result } = renderHook(() => useMediaServerStatus('tok'));

      await waitFor(() => expect(result.current.error).toBe('Unauthorized'));
    });

    it('uses a generic message for a non-axios error', async () => {
      axios.get.mockRejectedValue(new Error('boom'));

      const { result } = renderHook(() => useMediaServerStatus('tok'));

      await waitFor(() => expect(result.current.error).toBe('Failed to load media server status'));
    });

    it('uses the generic message when the server sends no error text', async () => {
      axios.isAxiosError.mockReturnValue(true);
      axios.get.mockRejectedValue({ response: { data: {} } });

      const { result } = renderHook(() => useMediaServerStatus('tok'));

      await waitFor(() => expect(result.current.error).toBe('Failed to load media server status'));
    });

    it('uses the generic message when the server error is not a string', async () => {
      axios.isAxiosError.mockReturnValue(true);
      axios.get.mockRejectedValue({ response: { data: { error: { code: 1 } } } });

      const { result } = renderHook(() => useMediaServerStatus('tok'));

      await waitFor(() => expect(result.current.error).toBe('Failed to load media server status'));
    });

    it('stops loading after a failure', async () => {
      axios.get.mockRejectedValue(new Error('boom'));

      const { result } = renderHook(() => useMediaServerStatus('tok'));

      await waitFor(() => expect(result.current.loading).toBe(false));
    });

    it('clears a previous error on the next successful fetch', async () => {
      axios.get.mockRejectedValueOnce(new Error('boom'));
      const { result } = renderHook(() => useMediaServerStatus('tok'));
      await waitFor(() => expect(result.current.error).not.toBeNull());

      await act(async () => { await result.current.refetch(); });

      expect(result.current.error).toBeNull();
    });
  });

  describe('polling', () => {
    it('refreshes every minute', async () => {
      jest.useFakeTimers();
      renderHook(() => useMediaServerStatus('tok'));
      await act(async () => { await Promise.resolve(); });
      expect(axios.get).toHaveBeenCalledTimes(1);

      await act(async () => { jest.advanceTimersByTime(120000); });

      expect(axios.get).toHaveBeenCalledTimes(3);
    });

    it('stops polling on unmount', async () => {
      jest.useFakeTimers();
      const { unmount } = renderHook(() => useMediaServerStatus('tok'));
      await act(async () => { await Promise.resolve(); });
      unmount();
      axios.get.mockClear();

      await act(async () => { jest.advanceTimersByTime(300000); });

      expect(axios.get).not.toHaveBeenCalled();
    });

    it('does not poll without a token', async () => {
      jest.useFakeTimers();
      renderHook(() => useMediaServerStatus(null));

      await act(async () => { jest.advanceTimersByTime(300000); });

      expect(axios.get).not.toHaveBeenCalled();
    });

    it('resets to empty when the token is removed', async () => {
      const { result, rerender } = renderHook(({ token }: { token: string | null }) => useMediaServerStatus(token), { initialProps: { token: 'tok' as string | null } });
      await waitFor(() => expect(result.current.status.plex).toBe(true));

      rerender({ token: null });

      await waitFor(() => expect(result.current.status.plex).toBe(false));
    });
  });
});
