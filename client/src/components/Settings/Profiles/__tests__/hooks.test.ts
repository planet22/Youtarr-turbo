import { renderHook, waitFor, act } from '@testing-library/react';

jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  delete: jest.fn(),
  isAxiosError: jest.fn(),
}));

const axios = require('axios');

beforeEach(() => {
  axios.isAxiosError.mockImplementation((err: { isAxiosError?: boolean }) => !!err?.isAxiosError);
});
const { useProfiles } = require('../useProfiles');
const { useProfileSubscriptions } = require('../useProfileSubscriptions');
const { useJellyfinProfileOptions } = require('../useJellyfinProfileOptions');

describe('useProfiles', () => {
  beforeEach(() => jest.clearAllMocks());

  test('loads the profile list', async () => {
    axios.get.mockResolvedValue({ data: { profiles: [{ id: 1, name: 'Alice' }] } });
    const { result } = renderHook(({ token }: { token: string | null }) => useProfiles(token), { initialProps: { token: 'tok' } });
    await waitFor(() => expect(result.current.profiles).toEqual([{ id: 1, name: 'Alice' }]));
  });

  test('does not fetch without a token', () => {
    renderHook(({ token }: { token: string | null }) => useProfiles(token), { initialProps: { token: null } });
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('surfaces the server error message', async () => {
    axios.get.mockRejectedValue({ isAxiosError: true, response: { data: { error: 'DB down' } } });
    const { result } = renderHook(() => useProfiles('tok'));
    await waitFor(() => expect(result.current.error).toBe('DB down'));
  });

  test('createProfile posts the input and refetches', async () => {
    axios.get.mockResolvedValue({ data: { profiles: [] } });
    axios.post.mockResolvedValue({ data: {} });
    const { result } = renderHook(() => useProfiles('tok'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const input = { name: 'Bob', jellyfinUserId: null, jellyfinUserName: null, jellyfinLibraryId: null, removeWatchedAfterDays: null };
    await act(() => result.current.createProfile(input));
    expect(axios.post).toHaveBeenCalledWith('/api/profiles', input, { headers: { 'x-access-token': 'tok' } });
  });
});

describe('useProfileSubscriptions', () => {
  beforeEach(() => jest.clearAllMocks());

  test('stays idle without a profile', () => {
    renderHook(() => useProfileSubscriptions('tok', null));
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('loads sources and the profile\'s subscriptions', async () => {
    axios.get.mockImplementation((url: string) => Promise.resolve({
      data: url.endsWith('/sources')
        ? { channels: [{ id: 'UC1', title: 'Chan' }], playlists: [] }
        : { channels: ['UC1'], playlists: [] },
    }));
    const { result } = renderHook(() => useProfileSubscriptions('tok', 3));
    await waitFor(() => expect(result.current.subscriptions).toEqual({ channels: ['UC1'], playlists: [] }));
  });
});

describe('useJellyfinProfileOptions', () => {
  beforeEach(() => jest.clearAllMocks());

  test('does not fetch while disabled', () => {
    renderHook(() => useJellyfinProfileOptions('tok', false));
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('reports when Jellyfin is not configured', async () => {
    axios.get.mockRejectedValue({ isAxiosError: true, response: { status: 409, data: { error: 'Jellyfin is not configured' } } });
    const { result } = renderHook(() => useJellyfinProfileOptions('tok', true));
    await waitFor(() => expect(result.current.error).toBe('Jellyfin is not configured'));
  });
});
