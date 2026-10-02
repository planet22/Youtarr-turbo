import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProfileFormDialog } from '../ProfileFormDialog';
import { Profile } from '../types';

jest.mock('../useJellyfinProfileOptions', () => ({ useJellyfinProfileOptions: jest.fn() }));

const { useJellyfinProfileOptions } = require('../useJellyfinProfileOptions') as {
  useJellyfinProfileOptions: jest.Mock;
};

const ALICE: Profile = {
  id: 1,
  name: 'Alice',
  jellyfinUserId: 'u1',
  jellyfinUserName: 'alice',
  jellyfinLibraryId: 'lib1',
  folderPath: '/data/__profiles__/Alice',
  channelCount: 0,
  playlistCount: 0,
  videoCount: 0,
};

function setup({ profile = null as Profile | null, jellyfinError = null as string | null, onSubmit = jest.fn().mockResolvedValue(undefined) } = {}) {
  useJellyfinProfileOptions.mockReturnValue({
    users: [{ id: 'u1', name: 'alice' }],
    libraries: [{ id: 'lib1', title: 'Alice TV' }],
    loading: false,
    error: jellyfinError,
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

  test('submits a trimmed name with no Jellyfin link by default', async () => {
    const { onSubmit } = setup();
    await userEvent.type(screen.getByLabelText('Profile name'), '  Bob ');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).toHaveBeenCalledWith({ name: 'Bob', jellyfinUserId: null, jellyfinUserName: null, jellyfinLibraryId: null });
  });

  test('keeps an existing profile\'s Jellyfin link when editing', async () => {
    const { onSubmit } = setup({ profile: ALICE });
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).toHaveBeenCalledWith({ name: 'Alice', jellyfinUserId: 'u1', jellyfinUserName: 'alice', jellyfinLibraryId: 'lib1' });
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
