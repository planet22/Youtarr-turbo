import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProfileSubscriptionsDialog } from '../ProfileSubscriptionsDialog';
import { Profile } from '../types';

jest.mock('../useProfileSubscriptions', () => ({ useProfileSubscriptions: jest.fn() }));

const { useProfileSubscriptions } = require('../useProfileSubscriptions') as { useProfileSubscriptions: jest.Mock };

const ALICE: Profile = {
  id: 1,
  name: 'Alice',
  jellyfinUserId: null,
  jellyfinUserName: null,
  jellyfinLibraryId: null,
  folderPath: '/data/__profiles__/Alice',
  channelCount: 1,
  playlistCount: 0,
  videoCount: 0,
};

const SUBSCRIPTIONS = { channels: ['UC1'], playlists: [] };

function setup(overrides: Record<string, unknown> = {}) {
  const save = jest.fn().mockResolvedValue({ linked: 5, unlinked: 0, failed: 0 });
  useProfileSubscriptions.mockReturnValue({
    sources: {
      channels: [{ id: 'UC1', title: 'Cooking' }, { id: 'UC2', title: 'Gaming' }],
      playlists: [{ id: 'PL1', title: 'Bedtime' }],
    },
    subscriptions: SUBSCRIPTIONS,
    loading: false,
    error: null,
    save,
    ...overrides,
  });
  const onSaved = jest.fn();
  render(<ProfileSubscriptionsDialog token="tok" profile={ALICE} onClose={jest.fn()} onSaved={onSaved} />);
  return { save, onSaved };
}

describe('ProfileSubscriptionsDialog', () => {
  beforeEach(() => jest.clearAllMocks());

  test('pre-checks the profile\'s current channels', () => {
    setup();
    expect(screen.getByRole('checkbox', { name: 'Cooking' })).toBeChecked();
  });

  test('shows how many sources are selected', () => {
    setup();
    expect(screen.getByText('Channels (1 of 2 selected)')).toBeInTheDocument();
  });

  test('filter hides non-matching sources', async () => {
    setup();
    await userEvent.type(screen.getByLabelText('Filter'), 'bed');
    expect(screen.queryByRole('checkbox', { name: 'Cooking' })).not.toBeInTheDocument();
  });

  test('saves the toggled selection', async () => {
    const { save } = setup();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Gaming' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Bedtime' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(save).toHaveBeenCalledWith({ channels: ['UC1', 'UC2'], playlists: ['PL1'] });
  });

  test('reports the relink result after saving', async () => {
    const { onSaved } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ linked: 5, unlinked: 0, failed: 0 }));
  });

  test('disables Save when loading failed', () => {
    setup({ error: 'Failed to load subscriptions' });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});
