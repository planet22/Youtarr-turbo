import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RegenerateStreamKeySection } from '../RegenerateStreamKeySection';
import { useStreamKeyRegenStatus } from '../../../hooks/useStreamKeyRegenStatus';

jest.mock('../../../hooks/useStreamKeyRegenStatus');

const mockUseStreamKeyRegenStatus = useStreamKeyRegenStatus as jest.MockedFunction<
  typeof useStreamKeyRegenStatus
>;

function renderSection() {
  render(<RegenerateStreamKeySection token="tok" />);
}

describe('RegenerateStreamKeySection', () => {
  beforeEach(() => {
    mockUseStreamKeyRegenStatus.mockReturnValue({
      running: false,
      lastRun: null,
      loading: false,
      error: null,
      triggerRegen: jest.fn().mockResolvedValue(undefined),
    });
  });

  test('shows a not-yet-rotated message before any run', () => {
    renderSection();
    expect(screen.getByText('Has not been rotated yet.')).toBeInTheDocument();
  });

  test('does not trigger regeneration until the confirm dialog is accepted', async () => {
    const triggerRegen = jest.fn().mockResolvedValue(undefined);
    mockUseStreamKeyRegenStatus.mockReturnValue({
      running: false,
      lastRun: null,
      loading: false,
      error: null,
      triggerRegen,
    });
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole('button', { name: 'Regenerate stream key' }));
    expect(triggerRegen).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Regenerate' }));
    expect(triggerRegen).toHaveBeenCalledTimes(1);
  });

  test('shows the new key after confirming rotation, with a way to copy it', async () => {
    const triggerRegen = jest.fn().mockResolvedValue('brand-new-key-value');
    mockUseStreamKeyRegenStatus.mockReturnValue({
      running: false,
      lastRun: null,
      loading: false,
      error: null,
      triggerRegen,
    });
    const user = userEvent.setup();
    // Must come after userEvent.setup(), which installs its own clipboard
    // stub for copy/paste simulation and would otherwise clobber this mock.
    const writeText = jest.fn();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    renderSection();

    await user.click(screen.getByRole('button', { name: 'Regenerate stream key' }));
    await user.click(screen.getByRole('button', { name: 'Regenerate' }));

    expect(await screen.findByText('brand-new-key-value')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Copy stream key' }));
    expect(writeText).toHaveBeenCalledWith('brand-new-key-value');
  });

  test('does not show a revealed key when rotation fails', async () => {
    const triggerRegen = jest.fn().mockResolvedValue(undefined);
    mockUseStreamKeyRegenStatus.mockReturnValue({
      running: false,
      lastRun: null,
      loading: false,
      error: null,
      triggerRegen,
    });
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole('button', { name: 'Regenerate stream key' }));
    await user.click(screen.getByRole('button', { name: 'Regenerate' }));

    expect(triggerRegen).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Copy stream key' })).not.toBeInTheDocument();
  });

  test('cancelling the confirm dialog does not trigger regeneration', async () => {
    const triggerRegen = jest.fn();
    mockUseStreamKeyRegenStatus.mockReturnValue({
      running: false,
      lastRun: null,
      loading: false,
      error: null,
      triggerRegen,
    });
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole('button', { name: 'Regenerate stream key' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(triggerRegen).not.toHaveBeenCalled();
  });

  test('shows a running indicator while a rotation is in progress', () => {
    mockUseStreamKeyRegenStatus.mockReturnValue({
      running: true,
      lastRun: null,
      loading: false,
      error: null,
      triggerRegen: jest.fn(),
    });
    renderSection();

    expect(screen.getByText(/Rotating key and rewriting \.strm files/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Regenerate stream key' })).toBeDisabled();
  });

  test('shows the last-rotation summary for a stream-key-rotation run, not a plain metadata regen', () => {
    mockUseStreamKeyRegenStatus.mockReturnValue({
      running: false,
      lastRun: {
        startedAt: '2026-09-26T00:00:00.000Z',
        completedAt: '2026-09-26T00:05:00.000Z',
        trigger: 'stream-key-rotation',
        status: 'completed',
        scanned: 150,
        regenerated: 0,
        skippedNoCache: 0,
        skippedNoFile: 0,
        errors: 0,
        strmToolRegenerated: 0,
        strmToolAlreadyCorrect: 0,
        strmFilesRewritten: 42,
      },
      loading: false,
      error: null,
      triggerRegen: jest.fn(),
    });
    renderSection();

    expect(screen.getByText(/Rewrote 42 of 150 video\(s\)/)).toBeInTheDocument();
  });

  test('ignores a lastRun left over from the plain metadata-regen button (different trigger)', () => {
    mockUseStreamKeyRegenStatus.mockReturnValue({
      running: false,
      lastRun: {
        startedAt: '2026-09-26T00:00:00.000Z',
        completedAt: '2026-09-26T00:05:00.000Z',
        trigger: 'manual',
        status: 'completed',
        scanned: 150,
        regenerated: 37,
        skippedNoCache: 0,
        skippedNoFile: 0,
        errors: 0,
        strmToolRegenerated: 37,
        strmToolAlreadyCorrect: 0,
        strmFilesRewritten: 0,
      },
      loading: false,
      error: null,
      triggerRegen: jest.fn(),
    });
    renderSection();

    expect(screen.getByText('Has not been rotated yet.')).toBeInTheDocument();
  });

  test('shows a persistent error from a failed run', () => {
    mockUseStreamKeyRegenStatus.mockReturnValue({
      running: false,
      lastRun: {
        startedAt: '2026-09-26T00:00:00.000Z',
        completedAt: '2026-09-26T00:05:00.000Z',
        trigger: 'stream-key-rotation',
        status: 'error',
        scanned: 10,
        regenerated: 0,
        skippedNoCache: 0,
        skippedNoFile: 0,
        errors: 1,
        strmToolRegenerated: 0,
        strmToolAlreadyCorrect: 0,
        strmFilesRewritten: 0,
        errorMessage: 'disk full',
      },
      loading: false,
      error: null,
      triggerRegen: jest.fn(),
    });
    renderSection();

    expect(screen.getByText('disk full')).toBeInTheDocument();
  });
});
