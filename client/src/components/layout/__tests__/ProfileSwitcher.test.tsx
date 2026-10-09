import React from 'react';
import { render, screen } from '@testing-library/react';
import { ProfileSwitcher } from '../ProfileSwitcher';
import { createActiveProfileWrapper } from '../../../test-utils';

describe('ProfileSwitcher', () => {
  test('renders nothing when there are no profiles', () => {
    render(<ProfileSwitcher />);
    expect(screen.queryByTestId('profile-switcher')).not.toBeInTheDocument();
  });

  test('shows the active profile name', () => {
    render(<ProfileSwitcher />, { wrapper: createActiveProfileWrapper({ id: 2, name: 'Alice' }) });
    expect(screen.getByRole('button', { name: 'Active profile' })).toHaveTextContent('Alice');
  });
});
