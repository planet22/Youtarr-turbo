import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ActiveProfileNotice } from '../ActiveProfileNotice';
import ProfileContext, { ProfileContextValue } from '../../../contexts/ProfileContext';

function renderWithProfile(value: Partial<ProfileContextValue>) {
  const full: ProfileContextValue = {
    profiles: [],
    activeProfileId: null,
    activeProfile: null,
    setActiveProfileId: jest.fn(),
    refresh: jest.fn(),
    ...value,
  };
  render(
    <ProfileContext.Provider value={full}>
      <ActiveProfileNotice subject="videos" detail="Extra." />
    </ProfileContext.Provider>
  );
}

describe('ActiveProfileNotice', () => {
  test('renders nothing without an active profile', () => {
    renderWithProfile({});
    expect(screen.queryByRole('button', { name: 'Show all' })).not.toBeInTheDocument();
  });

  test('names the active profile', () => {
    const alice = { id: 1, name: 'Alice' };
    renderWithProfile({ profiles: [alice], activeProfileId: 1, activeProfile: alice });
    expect(screen.getByText('Showing videos for Alice. Extra.')).toBeInTheDocument();
  });

  test('Show all clears the active profile', async () => {
    const alice = { id: 1, name: 'Alice' };
    const setActiveProfileId = jest.fn();
    renderWithProfile({ profiles: [alice], activeProfileId: 1, activeProfile: alice, setActiveProfileId });
    await userEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(setActiveProfileId).toHaveBeenCalledWith(null);
  });
});
