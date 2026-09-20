import React from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import DateRangeFilter from '../DateRangeFilter';
import { renderWithProviders } from '../../../../../test-utils';

// The picker button has its own tests; stub it with buttons that report the
// value it was given and call onChange with values the test chooses.
jest.mock('../DatePickerButton', () => ({
  __esModule: true,
  default: function MockPicker(props: { value: string; onChange: (v: string) => void; ariaLabel: string; placeholder?: string; minWidth?: number | string }) {
    const React = require('react');
    return React.createElement(
      'div',
      null,
      React.createElement('span', { 'data-testid': `${props.ariaLabel}-state` }, `value=${props.value}|placeholder=${props.placeholder}|minWidth=${props.minWidth ?? 'none'}`),
      React.createElement('button', { onClick: () => props.onChange('2024-05-06') }, `set ${props.ariaLabel}`),
      React.createElement('button', { onClick: () => props.onChange('') }, `clear ${props.ariaLabel}`),
      React.createElement('button', { onClick: () => props.onChange('garbage') }, `garbage ${props.ariaLabel}`)
    );
  },
}));

const FROM = 'Published from date';
const TO = 'Published to date';

const setup = (props: Partial<React.ComponentProps<typeof DateRangeFilter>> = {}) => {
  const onFromChange = jest.fn();
  const onToChange = jest.fn();
  renderWithProviders(<DateRangeFilter dateFrom={null} dateTo={null} onFromChange={onFromChange} onToChange={onToChange} {...props} />);
  return { onFromChange, onToChange, user: userEvent.setup() };
};

describe('DateRangeFilter', () => {
  describe('showing the dates', () => {
    it('passes an empty value when there is no date', () => {
      setup();

      expect(screen.getByTestId(`${FROM}-state`)).toHaveTextContent('value=|');
      expect(screen.getByTestId(`${TO}-state`)).toHaveTextContent('value=|');
    });

    it('formats each date as YYYY-MM-DD using the local calendar day', () => {
      setup({ dateFrom: new Date(2024, 0, 5), dateTo: new Date(2024, 11, 31) });

      expect(screen.getByTestId(`${FROM}-state`)).toHaveTextContent('value=2024-01-05|');
      expect(screen.getByTestId(`${TO}-state`)).toHaveTextContent('value=2024-12-31|');
    });

    it('labels the two pickers From and To', () => {
      setup();

      expect(screen.getByTestId(`${FROM}-state`)).toHaveTextContent('placeholder=From');
      expect(screen.getByTestId(`${TO}-state`)).toHaveTextContent('placeholder=To');
    });

    it('separates them with "to"', () => {
      setup();

      expect(screen.getByText('to')).toBeInTheDocument();
    });
  });

  describe('layouts', () => {
    it('has a labelled group with wide pickers by default', () => {
      setup();

      expect(screen.getByText('Published')).toBeInTheDocument();
      expect(screen.getByTestId(`${FROM}-state`)).toHaveTextContent('minWidth=160');
    });

    it('drops the label and the width in the compact layout', () => {
      setup({ compact: true });

      expect(screen.queryByText('Published')).not.toBeInTheDocument();
      expect(screen.getByTestId(`${FROM}-state`)).toHaveTextContent('minWidth=none');
    });

    it.each([[true], [false]])('offers both pickers when compact is %p', (compact) => {
      setup({ compact });

      expect(screen.getByRole('button', { name: `set ${FROM}` })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: `set ${TO}` })).toBeInTheDocument();
    });
  });

  describe.each([[false], [true]])('picking a date (compact: %p)', (compact) => {
    it('reports the from date as a local Date', async () => {
      const { onFromChange, user } = setup({ compact });

      await user.click(screen.getByRole('button', { name: `set ${FROM}` }));

      const date = onFromChange.mock.calls[0][0] as Date;
      expect([date.getFullYear(), date.getMonth(), date.getDate()]).toEqual([2024, 4, 6]);
    });

    it('reports the to date as a local Date', async () => {
      const { onToChange, user } = setup({ compact });

      await user.click(screen.getByRole('button', { name: `set ${TO}` }));

      const date = onToChange.mock.calls[0][0] as Date;
      expect([date.getFullYear(), date.getMonth(), date.getDate()]).toEqual([2024, 4, 6]);
    });

    it('does not touch the other date', async () => {
      const { onToChange, user } = setup({ compact });

      await user.click(screen.getByRole('button', { name: `set ${FROM}` }));

      expect(onToChange).not.toHaveBeenCalled();
    });

    it('reports null when a date is cleared', async () => {
      const { onFromChange, onToChange, user } = setup({ compact });

      await user.click(screen.getByRole('button', { name: `clear ${FROM}` }));
      await user.click(screen.getByRole('button', { name: `clear ${TO}` }));

      expect(onFromChange).toHaveBeenCalledWith(null);
      expect(onToChange).toHaveBeenCalledWith(null);
    });

    it('reports null for a value that is not a date', async () => {
      const { onFromChange, user } = setup({ compact });

      await user.click(screen.getByRole('button', { name: `garbage ${FROM}` }));

      expect(onFromChange).toHaveBeenCalledWith(null);
    });
  });
});
