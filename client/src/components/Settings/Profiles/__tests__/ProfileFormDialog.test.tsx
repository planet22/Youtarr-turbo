import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProfileFormDialog } from '../ProfileFormDialog';
import { Profile } from '../types';

jest.mock('../useJellyfinProfileOptions', () => ({ useJellyfinProfileOptions: jest.fn() }));
jest.mock('../useProfilePlexOptions', () => ({ useProfilePlexOptions: jest.fn() }));

const { useJellyfinProfileOptions } = require('../useJellyfinProfileOptions') as {
  useJellyfinProfileOptions: jest.Mock;
};
const { useProfilePlexOptions } = require('../useProfilePlexOptions') as {
  useProfilePlexOptions: jest.Mock;
};

const ALICE: Profile = {
  id: 1,
  name: 'Alice',
  jellyfinUserId: 'u1',
  jellyfinUserName: 'alice',
  jellyfinLibraryId: 'lib1',
  plexUserId: null,
  plexUserName: null,
  plexLibraryId: null,
  removeWatchedAfterDays: null,
  folderPath: '/data/__profiles__/Alice',
  channelCount: 0,
  playlistCount: 0,
  videoCount: 0,
};

function setup({
  profile = null as Profile | null,
  jellyfinError = null as string | null,
  plexError = null as string | null,
  onSubmit = jest.fn().mockResolvedValue(undefined),
} = {}) {
  useJellyfinProfileOptions.mockReturnValue({
    users: [{ id: 'u1', name: 'alice' }],
    libraries: [{ id: 'lib1', title: 'Alice TV' }],
    loading: false,
    error: jellyfinError,
  });
  useProfilePlexOptions.mockReturnValue({
    users: [{ id: 'p1', name: 'Kid' }],
    libraries: [{ id: 'pl1', title: 'Youtube Channels' }],
    loading: false,
    error: plexError,
  });
  const onClose = jest.fn();
  render(<ProfileFormDialog open token="tok" profile={profile} onClose={onClose} onSubmit={onSubmit} />);
  return { onSubmit, onClose };
}

describe('ProfileFormDialog', () => {
  beforeEach(() => jest.clearAllMocks());

  test('disables Save while the name is empty', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  test('submits a trimmed name with no Jellyfin or Plex link by default', async () => {
    const { onSubmit } = setup();
    await userEvent.type(screen.getByLabelText('Profile name'), '  Bob ');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).toHaveBeenCalledWith({
      name: 'Bob',
      jellyfinUserId: null, jellyfinUserName: null, jellyfinLibraryId: null,
      plexUserId: null, plexUserName: null, plexLibraryId: null,
      removeWatchedAfterDays: null,
    });
  });

  test('keeps an existing profile\'s Jellyfin link when editing', async () => {
    const { onSubmit } = setup({ profile: ALICE });
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).toHaveBeenCalledWith({
      name: 'Alice',
      jellyfinUserId: 'u1', jellyfinUserName: 'alice', jellyfinLibraryId: 'lib1',
      plexUserId: null, plexUserName: null, plexLibraryId: null,
      removeWatchedAfterDays: null,
    });
  });

  test('submits a Plex link alongside an existing Jellyfin link', async () => {
    const { onSubmit } = setup({ profile: ALICE });
    await userEvent.click(screen.getByRole('button', { name: /Plex user/i }));
    await userEvent.click(await screen.findByRole('option', { name: 'Kid' }));
    await userEvent.click(screen.getByRole('button', { name: /Plex library/i }));
    await userEvent.click(await screen.findByRole('option', { name: 'Youtube Channels' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      plexUserId: 'p1', plexUserName: 'Kid', plexLibraryId: 'pl1',
    }));
  });

  test('explains why Plex linking is unavailable', () => {
    setup({ plexError: 'Plex is not configured' });
    expect(screen.getByText(/Plex is not configured/)).toBeInTheDocument();
  });

  test('submits the remove-watched day count as a number', async () => {
    const { onSubmit } = setup({ profile: ALICE });
    await userEvent.type(screen.getByLabelText('Remove watched videos after (days)'), '14');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ removeWatchedAfterDays: 14 }));
  });

  test('disables Save for a zero day count', async () => {
    setup({ profile: ALICE });
    await userEvent.type(screen.getByLabelText('Remove watched videos after (days)'), '0');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  test('closes after a successful save', async () => {
    const { onClose } = setup({ profile: ALICE });
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  test('shows the server error when saving fails', async () => {
    const onSubmit = jest.fn().mockRejectedValue(new Error('nope'));
    setup({ profile: ALICE, onSubmit });
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Failed to save profile')).toBeInTheDocument();
  });

  test('explains why Jellyfin linking is unavailable', () => {
    setup({ jellyfinError: 'Jellyfin is not configured' });
    expect(screen.getByText(/Jellyfin is not configured/)).toBeInTheDocument();
  });
});
