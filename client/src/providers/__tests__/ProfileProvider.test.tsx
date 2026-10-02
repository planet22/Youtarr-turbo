import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { ProfileProvider, ACTIVE_PROFILE_STORAGE_KEY } from '../ProfileProvider';
import { useProfileContext } from '../../contexts/ProfileContext';

jest.mock('axios', () => ({ get: jest.fn() }));

const axios = require('axios');

function renderContext(token: string | null = 'tok') {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <ProfileProvider token={token}>{children}</ProfileProvider>
  );
  return renderHook(() => useProfileContext(), { wrapper });
}

describe('ProfileProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    axios.get.mockResolvedValue({ data: { profiles: [{ id: 1, name: 'Alice', videoCount: 3 }] } });
  });

  test('loads the profile list', async () => {
    const { result } = renderContext();
    await waitFor(() => expect(result.current.profiles).toEqual([{ id: 1, name: 'Alice' }]));
  });

  test('starts with no active profile', async () => {
    const { result } = renderContext();
    await waitFor(() => expect(result.current.profiles).toHaveLength(1));
    expect(result.current.activeProfile).toBeNull();
  });

  test('restores the remembered active profile', async () => {
    window.localStorage.setItem(ACTIVE_PROFILE_STORAGE_KEY, '1');
    const { result } = renderContext();
    await waitFor(() => expect(result.current.activeProfile).toEqual({ id: 1, name: 'Alice' }));
  });

  test('forgets a remembered profile that no longer exists', async () => {
    window.localStorage.setItem(ACTIVE_PROFILE_STORAGE_KEY, '9');
    const { result } = renderContext();
    await waitFor(() => expect(result.current.profiles).toHaveLength(1));
    await waitFor(() => expect(result.current.activeProfileId).toBeNull());
  });

  test('remembers a newly selected profile', async () => {
    const { result } = renderContext();
    await waitFor(() => expect(result.current.profiles).toHaveLength(1));
    act(() => result.current.setActiveProfileId(1));
    expect(window.localStorage.getItem(ACTIVE_PROFILE_STORAGE_KEY)).toBe('1');
  });

  test('does not fetch without a token', () => {
    renderContext(null);
    expect(axios.get).not.toHaveBeenCalled();
  });
});
