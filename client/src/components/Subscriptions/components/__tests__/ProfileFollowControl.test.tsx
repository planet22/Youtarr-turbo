import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ProfileContext, { ProfileContextValue } from '../../../../contexts/ProfileContext';
import { TooltipProvider } from '../../../ui/tooltip';
import ProfileFollowControl from '../ProfileFollowControl';
import { followInProfile } from '../../../../utils/profileFollow';

jest.mock('../../../../utils/profileFollow', () => ({
  followInProfile: jest.fn(),
}));

const ALICE = { id: 1, name: 'Alice' };
const BOB = { id: 2, name: 'Bob' };

function renderControl(
  ctx: Partial<ProfileContextValue>,
  props: Partial<React.ComponentProps<typeof ProfileFollowControl>> = {}
) {
  const value: ProfileContextValue = {
    profiles: [ALICE, BOB],
    activeProfileId: null,
    activeProfile: null,
    setActiveProfileId: jest.fn(),
    refresh: jest.fn().mockResolvedValue(undefined),
    ...ctx,
  };
  return render(
    <ProfileContext.Provider value={value}>
      <TooltipProvider>
        <ProfileFollowControl
          token="tok"
          sourceType="channel"
          sourceId="UC1"
          sourceName="My Channel"
          profiles={[ALICE]}
          {...props}
        />
      </TooltipProvider>
    </ProfileContext.Provider>
  );
}

describe('ProfileFollowControl', () => {
  beforeEach(() => {
    (followInProfile as jest.Mock).mockReset().mockResolvedValue(true);
  });

  test('renders nothing when the app has no profiles', () => {
    renderControl({ profiles: [] });
    expect(screen.queryByTestId('profile-follow-control')).not.toBeInTheDocument();
  });

  test('shows the add button in the all-profiles view', () => {
    renderControl({});
    expect(screen.getByRole('button', { name: 'Add users to My Channel' })).toBeInTheDocument();
  });

  test('shows only the selected user and no add button in a profile view', () => {
    renderControl({ activeProfileId: 2, activeProfile: BOB });
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add users to My Channel' })).not.toBeInTheDocument();
  });

  test('hides the add button when every profile already follows the source', () => {
    renderControl({}, { profiles: [ALICE, BOB] });
    expect(screen.queryByRole('button', { name: 'Add users to My Channel' })).not.toBeInTheDocument();
  });

  test('adds the chosen user to the channel and reports the change', async () => {
    const onChanged = jest.fn();
    renderControl({}, { onChanged });
    await userEvent.click(screen.getByRole('button', { name: 'Add users to My Channel' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Bob' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(followInProfile).toHaveBeenCalledWith('tok', 2, { channels: ['UC1'] });
  });

  test('offers only users not already following', async () => {
    renderControl({});
    await userEvent.click(screen.getByRole('button', { name: 'Add users to My Channel' }));
    expect(screen.queryByRole('checkbox', { name: 'Alice' })).not.toBeInTheDocument();
  });

  test('uses the playlists key for playlist sources', async () => {
    renderControl({}, { sourceType: 'playlist', sourceId: 'PL1', sourceName: 'My Playlist' });
    await userEvent.click(screen.getByRole('button', { name: 'Add users to My Playlist' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Bob' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(followInProfile).toHaveBeenCalledWith('tok', 2, { playlists: ['PL1'] }));
  });

  test('shows an error and keeps the dialog open when a follow fails', async () => {
    (followInProfile as jest.Mock).mockResolvedValue(false);
    renderControl({});
    await userEvent.click(screen.getByRole('button', { name: 'Add users to My Channel' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Bob' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(await screen.findByText('Some profiles could not be updated. Please try again.')).toBeInTheDocument();
  });
});
