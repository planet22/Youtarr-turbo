import React from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import type { StrmToolTurboStatus } from '../../hooks/useStrmToolTurbo';

const mockRun = jest.fn();
const mockSave = jest.fn();
const mockRefresh = jest.fn();
const hookReturn = {
  status: null as StrmToolTurboStatus | null,
  loading: false,
  error: null as string | null,
  saving: false,
  saveError: null as string | null,
  starting: false,
  runError: null as string | null,
  refresh: mockRefresh,
  save: mockSave,
  run: mockRun,
};
jest.mock('../../hooks/useStrmToolTurbo', () => ({
  useStrmToolTurbo: () => hookReturn,
}));

import StrmToolTurboPanel from '../StrmToolTurboPanel';
import { renderWithProviders } from '../../../../test-utils';

const CONFIG = {
  enableAutoExtract: false,
  enableMediaInfoCache: true,
  importExistingCacheWhenMissing: true,
  forceRefreshIgnoreExisting: false,
  forceRefreshIgnoreCache: false,
  refreshDelayMs: 5000,
  metadataRestoreTimeoutMinutes: 5,
  maxConcurrentExtract: 5,
};

const activeStatus = (task: StrmToolTurboStatus['task']): StrmToolTurboStatus => ({
  installed: true,
  version: '1.0.0.0',
  pluginStatus: 'Active',
  config: CONFIG,
  task,
});

const idleTask = { id: 't1', name: 'Extract', state: 'Idle', running: false, progressPercent: null, lastRun: null };

describe('StrmToolTurboPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    hookReturn.status = null;
    hookReturn.loading = false;
    hookReturn.error = null;
    hookReturn.saveError = null;
    hookReturn.starting = false;
    hookReturn.runError = null;
  });

  test('shows a not-installed message when the plugin is missing', () => {
    hookReturn.status = { installed: false };
    renderWithProviders(<StrmToolTurboPanel token="tok" />);
    expect(screen.getByText(/not installed on this Jellyfin server/i)).toBeInTheDocument();
  });

  test('explains a non-active plugin and hides the controls', () => {
    hookReturn.status = { installed: true, version: '1.0.0.0', pluginStatus: 'Disabled' };
    renderWithProviders(<StrmToolTurboPanel token="tok" />);
    expect(screen.getByText(/its status is Disabled/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Run extraction now/i })).not.toBeInTheDocument();
  });

  test('shows the load error', () => {
    hookReturn.error = 'Could not reach Jellyfin: timeout';
    renderWithProviders(<StrmToolTurboPanel token="tok" />);
    expect(screen.getByText('Could not reach Jellyfin: timeout')).toBeInTheDocument();
  });

  test('shows the plugin version when active', () => {
    hookReturn.status = activeStatus(idleTask);
    renderWithProviders(<StrmToolTurboPanel token="tok" />);
    expect(screen.getByText('Version 1.0.0.0')).toBeInTheDocument();
  });

  test('starts the extraction from the run button', async () => {
    hookReturn.status = activeStatus(idleTask);
    renderWithProviders(<StrmToolTurboPanel token="tok" />);
    await userEvent.click(screen.getByRole('button', { name: 'Run extraction now' }));
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  test('disables the run button while the task is running', () => {
    hookReturn.status = activeStatus({ ...idleTask, state: 'Running', running: true, progressPercent: 30 });
    renderWithProviders(<StrmToolTurboPanel token="tok" />);
    expect(screen.getByRole('button', { name: 'Extraction running...' })).toBeDisabled();
  });

  test('shows progress while running', () => {
    hookReturn.status = activeStatus({ ...idleTask, state: 'Running', running: true, progressPercent: 30 });
    renderWithProviders(<StrmToolTurboPanel token="tok" />);
    expect(screen.getByText(/Extracting media info... 30%/)).toBeInTheDocument();
  });

  test('shows the last run outcome when idle', () => {
    hookReturn.status = activeStatus({
      ...idleTask,
      lastRun: { status: 'Failed', startedAt: null, endedAt: null, error: 'ffprobe missing' },
    });
    renderWithProviders(<StrmToolTurboPanel token="tok" />);
    expect(screen.getByText(/Last run: Failed - ffprobe missing/)).toBeInTheDocument();
  });

  test('disables the run button and explains when the task is not found', () => {
    hookReturn.status = activeStatus(null);
    renderWithProviders(<StrmToolTurboPanel token="tok" />);
    expect(screen.getByRole('button', { name: 'Run extraction now' })).toBeDisabled();
    expect(screen.getByText(/extraction task was not found/i)).toBeInTheDocument();
  });

  test('shows a run error', () => {
    hookReturn.status = activeStatus(idleTask);
    hookReturn.runError = 'The extraction task is already running';
    renderWithProviders(<StrmToolTurboPanel token="tok" />);
    expect(screen.getByText('The extraction task is already running')).toBeInTheDocument();
  });

  test('refreshes from Jellyfin on demand', async () => {
    hookReturn.status = activeStatus(idleTask);
    renderWithProviders(<StrmToolTurboPanel token="tok" />);
    await userEvent.click(screen.getByRole('button', { name: 'Refresh from Jellyfin' }));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });
});
