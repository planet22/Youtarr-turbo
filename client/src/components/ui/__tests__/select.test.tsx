import React from 'react';
import { render, screen } from '@testing-library/react';
import { MenuItem, Select } from '../select';

describe('Select', () => {
  test('uses aria-label as the trigger accessible name', () => {
    render(
      <Select value="a" aria-label="Videos per page">
        <MenuItem value="a">A</MenuItem>
      </Select>
    );
    expect(screen.getByRole('button', { name: 'Videos per page' })).toBeInTheDocument();
  });

  test('forwards data-testid to the trigger', () => {
    render(
      <Select value="a" data-testid="my-select">
        <MenuItem value="a">A</MenuItem>
      </Select>
    );
    expect(screen.getByTestId('my-select')).toHaveTextContent('A');
  });

  test('lets inputProps override the direct props', () => {
    render(
      <Select value="a" data-testid="outer" inputProps={{ 'data-testid': 'inner' }}>
        <MenuItem value="a">A</MenuItem>
      </Select>
    );
    expect(screen.getByTestId('inner')).toBeInTheDocument();
  });
});
