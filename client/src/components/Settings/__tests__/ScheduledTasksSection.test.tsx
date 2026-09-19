import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ScheduledTasksSection } from '../ScheduledTasksSection';
import { ScheduledTask } from '../../../hooks/useScheduledTasks';

jest.mock('../../../hooks/useScheduledTasks', () => ({
  useScheduledTasks: jest.fn()
}));

const { useScheduledTasks } = require('../../../hooks/useScheduledTasks') as {
  useScheduledTasks: jest.Mock;
};

const buildTask = (overrides: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: 'session-cleanup',
  label: 'Session cleanup',
  description: 'Removes expired sessions.',
  cron: '0 3 * * *',
  confirm: false,
  nextRun: '2026-09-20T07:00:00.000Z',
  running: false,
  lastTrigger: null,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastStatus: null,
  lastError: null,
  ...overrides
});

function setup(tasks: ScheduledTask[], extra: Record<string, unknown> = {}) {
  const runTask = jest.fn().mockResolvedValue(undefined);
  useScheduledTasks.mockReturnValue({ tasks, loading: false, error: null, runTask, ...extra });
  render(<ScheduledTasksSection token="tok" />);
  return { runTask };
}

describe('ScheduledTasksSection', () => {
  beforeEach(() => jest.clearAllMocks());

  test('lists each task with its label', () => {
    setup([buildTask()]);
    expect(screen.getByText('Session cleanup')).toBeInTheDocument();
  });

  test('shows that a never-run task has not run since restart', () => {
    setup([buildTask()]);
    expect(screen.getByText('Not run since restart')).toBeInTheDocument();
  });

  test('shows a failed last run with its error', () => {
    setup([buildTask({
      lastFinishedAt: '2026-09-19T07:00:00.000Z',
      lastTrigger: 'manual',
      lastStatus: 'error',
      lastError: 'boom'
    })]);
    expect(screen.getByText(/failed: boom/)).toBeInTheDocument();
  });

  test('runs a task immediately when it needs no confirmation', async () => {
    const { runTask } = setup([buildTask()]);
    await userEvent.click(screen.getByRole('button', { name: /run session cleanup now/i }));
    expect(runTask).toHaveBeenCalledWith('session-cleanup');
  });

  test('asks for confirmation before running a destructive task', async () => {
    const { runTask } = setup([buildTask({ id: 'auto-removal', label: 'Automatic video cleanup', confirm: true })]);
    await userEvent.click(screen.getByRole('button', { name: /run automatic video cleanup now/i }));
    expect(runTask).not.toHaveBeenCalled();
  });

  test('runs the destructive task once confirmed', async () => {
    const { runTask } = setup([buildTask({ id: 'auto-removal', label: 'Automatic video cleanup', confirm: true })]);
    await userEvent.click(screen.getByRole('button', { name: /run automatic video cleanup now/i }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /run now/i }));
    expect(runTask).toHaveBeenCalledWith('auto-removal');
  });

  test('does not run a destructive task when the confirmation is cancelled', async () => {
    const { runTask } = setup([buildTask({ id: 'auto-removal', label: 'Automatic video cleanup', confirm: true })]);
    await userEvent.click(screen.getByRole('button', { name: /run automatic video cleanup now/i }));
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(runTask).not.toHaveBeenCalled();
  });

  test('disables Run now while a task is running', () => {
    setup([buildTask({ running: true })]);
    expect(screen.getByRole('button', { name: /run session cleanup now/i })).toBeDisabled();
  });

  test('shows a load error', () => {
    setup([], { error: 'Failed to load scheduled tasks' });
    expect(screen.getByText('Failed to load scheduled tasks')).toBeInTheDocument();
  });
});
