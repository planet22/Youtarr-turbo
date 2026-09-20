import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ClearEventLogSection } from '../ClearEventLogSection';
import { UseClearEventLogReturn } from '../../../hooks/useClearEventLog';

jest.mock('../../../hooks/useClearEventLog', () => ({
  useClearEventLog: jest.fn(),
}));

const { useClearEventLog } = require('../../../hooks/useClearEventLog') as {
  useClearEventLog: jest.Mock<UseClearEventLogReturn, [string | null]>;
};

function setup(overrides: Partial<UseClearEventLogReturn> = {}) {
  const fetchCount = jest.fn().mockResolvedValue(120);
  const clear = jest.fn().mockResolvedValue(120);
  const dismiss = jest.fn();
  useClearEventLog.mockReturnValue({
    eventCount: null,
    loadingCount: false,
    clearing: false,
    error: null,
    fetchCount,
    clear,
    dismiss,
    ...overrides,
  });
  render(<ClearEventLogSection token="tok" />);
  return { fetchCount, clear, dismiss };
}

describe('ClearEventLogSection', () => {
  beforeEach(() => jest.clearAllMocks());

  test('warns on the page itself that clearing is permanent', () => {
    setup();

    expect(screen.getByText(/clearing the event log is permanent/i)).toBeInTheDocument();
  });

  test('renders the trigger button with no dialog open by default', () => {
    setup();

    expect(screen.getByRole('button', { name: 'Clear Event Log' })).toBeEnabled();
    expect(screen.queryByText(/confirm clearing the event log/i)).not.toBeInTheDocument();
  });

  test('clicking the button counts the events first', async () => {
    const { fetchCount } = setup();

    await userEvent.click(screen.getByRole('button', { name: 'Clear Event Log' }));

    await waitFor(() => expect(fetchCount).toHaveBeenCalledTimes(1));
  });

  test('does not delete anything just from clicking the button', async () => {
    const { clear } = setup();

    await userEvent.click(screen.getByRole('button', { name: 'Clear Event Log' }));

    expect(clear).not.toHaveBeenCalled();
  });

  test('shows the warning dialog with the event count once counted', () => {
    setup({ eventCount: 120 });

    expect(screen.getByText(/confirm clearing the event log/i)).toBeInTheDocument();
    expect(screen.getByText(/permanently delete all 120 events/i)).toBeInTheDocument();
  });

  test('says the action cannot be undone', () => {
    setup({ eventCount: 120 });

    expect(screen.getByText(/this action cannot be undone/i)).toBeInTheDocument();
  });

  test('cancel closes the dialog without deleting', async () => {
    const { clear, dismiss } = setup({ eventCount: 120 });

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(dismiss).toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  test('confirming deletes and reports how many were removed', async () => {
    const { clear } = setup({ eventCount: 120 });

    await userEvent.click(screen.getByRole('button', { name: /delete 120 events/i }));

    await waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Removed 120 events.')).toBeInTheDocument();
  });

  test('says so when the log was already empty', async () => {
    const { clear } = setup({ eventCount: 3 });
    clear.mockResolvedValue(0);

    await userEvent.click(screen.getByRole('button', { name: /delete 3 events/i }));

    expect(await screen.findByText(/already empty/i)).toBeInTheDocument();
  });

  test('cannot confirm when there is nothing to delete', () => {
    setup({ eventCount: 0 });

    expect(screen.getByRole('button', { name: /delete 0 events/i })).toBeDisabled();
  });

  test('disables the button while counting', () => {
    setup({ loadingCount: true });

    expect(screen.getByRole('button', { name: 'Checking...' })).toBeDisabled();
  });

  test('shows an error from the hook', () => {
    setup({ error: 'Failed to clear the event log' });

    expect(screen.getByText('Failed to clear the event log')).toBeInTheDocument();
  });
});
