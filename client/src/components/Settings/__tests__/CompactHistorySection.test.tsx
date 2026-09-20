import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CompactHistorySection } from '../CompactHistorySection';
import { UseCompactHistoryReturn } from '../../../hooks/useCompactHistory';

jest.mock('../../../hooks/useCompactHistory', () => ({
  useCompactHistory: jest.fn()
}));

const { useCompactHistory } = require('../../../hooks/useCompactHistory') as {
  useCompactHistory: jest.Mock<UseCompactHistoryReturn, [string | null]>;
};

function setup(overrides: Partial<UseCompactHistoryReturn> = {}) {
  const fetchPreview = jest.fn().mockResolvedValue({ totalJobs: 50, compactableCount: 42 });
  const compact = jest.fn().mockResolvedValue(42);
  const clearPreview = jest.fn();
  useCompactHistory.mockReturnValue({
    preview: null,
    loadingPreview: false,
    compacting: false,
    error: null,
    fetchPreview,
    compact,
    clearPreview,
    ...overrides
  });
  render(<CompactHistorySection token="tok" />);
  return { fetchPreview, compact, clearPreview };
}

describe('CompactHistorySection', () => {
  beforeEach(() => jest.clearAllMocks());

  test('renders the trigger button with no dialog open by default', () => {
    setup();
    expect(screen.getByRole('button', { name: /compact history/i })).toBeEnabled();
    expect(screen.queryByText(/confirm history compaction/i)).not.toBeInTheDocument();
  });

  test('clicking the button fetches a preview', async () => {
    const { fetchPreview } = setup();
    await userEvent.click(screen.getByRole('button', { name: /compact history/i }));
    await waitFor(() => expect(fetchPreview).toHaveBeenCalledTimes(1));
  });

  test('shows the confirmation dialog with preview counts once loaded', () => {
    setup({ preview: { totalJobs: 50, compactableCount: 42 } });
    expect(screen.getByText(/confirm history compaction/i)).toBeInTheDocument();
    expect(screen.getByText(/42 of 50 download history rows/i)).toBeInTheDocument();
  });

  test('confirming the dialog calls compact and clears the preview first', async () => {
    const { compact, clearPreview } = setup({ preview: { totalJobs: 50, compactableCount: 42 } });
    await userEvent.click(screen.getByRole('button', { name: /compact 42 rows/i }));
    expect(clearPreview).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(compact).toHaveBeenCalledTimes(1));
  });

  test('canceling the dialog clears the preview without compacting', async () => {
    const { compact, clearPreview } = setup({ preview: { totalJobs: 50, compactableCount: 42 } });
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(clearPreview).toHaveBeenCalledTimes(1);
    expect(compact).not.toHaveBeenCalled();
  });

  test('disables the confirm button when nothing is compactable', () => {
    setup({ preview: { totalJobs: 5, compactableCount: 0 } });
    expect(screen.getByRole('button', { name: /compact 0 rows/i })).toBeDisabled();
  });

  test('shows a result message after compacting completes', async () => {
    setup({ preview: { totalJobs: 50, compactableCount: 42 } });
    await userEvent.click(screen.getByRole('button', { name: /compact 42 rows/i }));
    expect(await screen.findByText(/removed 42 history rows/i)).toBeInTheDocument();
  });

  test('displays an error message from the hook', () => {
    setup({ error: 'Failed to compact history' });
    expect(screen.getByText(/failed to compact history/i)).toBeInTheDocument();
  });

  test('disables the trigger button while a preview is loading', () => {
    setup({ loadingPreview: true });
    expect(screen.getByRole('button', { name: /checking/i })).toBeDisabled();
  });

  test('shows a compacting indicator while the delete request is in flight', () => {
    setup({ compacting: true });
    expect(screen.getByText(/compacting\.\.\./i)).toBeInTheDocument();
  });
});
