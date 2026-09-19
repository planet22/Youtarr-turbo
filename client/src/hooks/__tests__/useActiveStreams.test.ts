import { renderHook, waitFor } from '@testing-library/react';

jest.mock('axios', () => ({ get: jest.fn() }));
const axios = require('axios');

import { useActiveStreams } from '../useActiveStreams';

describe('useActiveStreams', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('exposes the byte-range session counts from the streams response', async () => {
    axios.get.mockResolvedValueOnce({
      data: { streams: [], byteRangeSessions: { total: 4, encoding: 1, finished: 3 } },
    });
    const { result } = renderHook(() => useActiveStreams('token'));
    await waitFor(() => expect(result.current.byteRangeSessions).toEqual({ total: 4, encoding: 1, finished: 3 }));
  });

  it('leaves the counts null when the server does not report them', async () => {
    axios.get.mockResolvedValueOnce({ data: { streams: [] } });
    const { result } = renderHook(() => useActiveStreams('token'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.byteRangeSessions).toBeNull();
  });

  it('sends the access token when fetching streams', async () => {
    axios.get.mockResolvedValueOnce({ data: { streams: [] } });
    renderHook(() => useActiveStreams('abc'));
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/ytstream/streams', { headers: { 'x-access-token': 'abc' } }));
  });

  it('does not fetch without a token', async () => {
    const { result } = renderHook(() => useActiveStreams(null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(axios.get).not.toHaveBeenCalled();
  });
});
