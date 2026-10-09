import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProfilesSection } from '../ProfilesSection';
import { Profile } from '../Profiles/types';

jest.mock('../Profiles/useProfiles', () => ({ useProfiles: jest.fn() }));
jest.mock('../Profiles/useJellyfinProfileOptions', () => ({ useJellyfinProfileOptions: jest.fn() }));
jest.mock('../Profiles/useProfilePlexOptions', () => ({ useProfilePlexOptions: jest.fn() }));
jest.mock('../Profiles/useProfileSubscriptions', () => ({ useProfileSubscriptions: jest.fn() }));

const { useProfiles } = require('../Profiles/useProfiles') as { useProfiles: jest.Mock };
const { useJellyfinProfileOptions } = require('../Profiles/useJellyfinProfileOptions') as { useJellyfinProfileOptions: jest.Mock };
const { useProfilePlexOptions } = require('../Profiles/useProfilePlexOptions') as { useProfilePlexOptions: jest.Mock };
const { useProfileSubscriptions } = require('../Profiles/useProfileSubscriptions') as { useProfileSubscriptions: jest.Mock };

const ALICE: Profile = {
  id: 1,
  name: 'Alice',
  jellyfinUserId: 'u1',
  jellyfinUserName: 'alice',
  jellyfinLibraryId: null,
  plexUserId: null,
  plexUserName: null,
  plexLibraryId: null,
  removeWatchedAfterDays: null,
  folderPath: '/data/__profiles__/Alice',
  channelCount: 2,
  playlistCount: 1,
  videoCount: 40,
};

function setup(overrides: Record<string, unknown> = {}) {
  const hook = {
    profiles: [ALICE],
    loading: false,
    error: null,
    refetch: jest.fn(),
    createProfile: jest.fn().mockResolvedValue(undefined),
    updateProfile: jest.fn().mockResolvedValue(undefined),
    deleteProfile: jest.fn().mockResolvedValue(undefined),
    relinkProfile: jest.fn().mockResolvedValue({ linked: 3, unlinked: 1, failed: 0 }),
    ...overrides,
  };
  useProfiles.mockReturnValue(hook);
  render(<ProfilesSection token="tok" />);
  return hook;
}

describe('ProfilesSection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useJellyfinProfileOptions.mockReturnValue({ users: [], libraries: [], loading: false, error: null });
    useProfilePlexOptions.mockReturnValue({ users: [], libraries: [], loading: false, error: null });
    useProfileSubscriptions.mockReturnValue({
      sources: { channels: [], playlists: [] },
      subscriptions: { channels: [], playlists: [] },
      loading: false,
      error: null,
      save: jest.fn(),
    });
  });

  test('shows an empty state when there are no profiles', () => {
    setup({ profiles: [] });
    expect(screen.getByText('No profiles yet.')).toBeInTheDocument();
  });

  test('shows a profile with its counts', () => {
    setup();
    expect(screen.getByText(/2 channels, 1 playlists, 40 videos linked/)).toBeInTheDocument();
  });

  test('shows the profile folder path', () => {
    setup();
    expect(screen.getByText('/data/__profiles__/Alice')).toBeInTheDocument();
  });

  test('shows a load error from the hook', () => {
    setup({ error: 'Failed to load profiles' });
    expect(screen.getByText('Failed to load profiles')).toBeInTheDocument();
  });

  test('Add profile opens the create dialog', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Add profile' }));
    expect(screen.getByLabelText('Profile name')).toHaveValue('');
  });

  test('Relink reports the link counts', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Relink' }));
    expect(await screen.findByText('Alice: 3 linked, 1 removed.')).toBeInTheDocument();
  });

  test('confirming the delete dialog deletes the profile', async () => {
    const hook = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const confirmButtons = screen.getAllByRole('button', { name: 'Delete' });
    await userEvent.click(confirmButtons[confirmButtons.length - 1]);
    await waitFor(() => expect(hook.deleteProfile).toHaveBeenCalledWith(1));
  });

  test('Channels & playlists opens the subscriptions dialog for the profile', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Channels & playlists' }));
    expect(screen.getByText('Channels & playlists for Alice')).toBeInTheDocument();
  });
});
