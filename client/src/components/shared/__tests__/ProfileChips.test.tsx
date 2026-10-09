import React from 'react';
import { render, screen } from '@testing-library/react';
import ProfileChips from '../ProfileChips';

describe('ProfileChips', () => {
  test('renders nothing when there are no profiles', () => {
    render(<ProfileChips profiles={[]} />);
    expect(screen.queryByTestId('profile-chips')).not.toBeInTheDocument();
  });

  test('shows the profile name when only one profile is allocated', () => {
    render(<ProfileChips profiles={[{ id: 1, name: 'Alice' }]} />);
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  test('exposes media server users in the single-profile details', () => {
    render(<ProfileChips profiles={[{ id: 1, name: 'Alice', jellyfinUser: 'alice-jf', plexUser: 'alice-px' }]} />);
    expect(screen.getByLabelText('Profile: Alice · Jellyfin user: alice-jf · Plex user: alice-px')).toBeInTheDocument();
  });

  test('collapses several profiles into one count chip', () => {
    render(<ProfileChips profiles={[{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }, { id: 3, name: 'Cy' }]} />);
    expect(screen.getByLabelText('3 profiles: Alice, Bob, Cy')).toBeInTheDocument();
  });

  test('does not print individual names in the collapsed chip', () => {
    render(<ProfileChips profiles={[{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }]} />);
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
  });
});
