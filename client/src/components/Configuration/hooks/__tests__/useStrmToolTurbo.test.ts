jest.mock('axios', () => ({ get: jest.fn(), put: jest.fn(), post: jest.fn(), isAxiosError: jest.fn(() => false) }));

import { renderHook, waitFor, act } from '@testing-library/react';
import { StrmToolTurboStatus, useStrmToolTurbo } from '../useStrmToolTurbo';

const axios = require('axios');

const ENDPOINT = '/api/mediaservers/jellyfin/strmtoolturbo';
const HEADERS = { headers: { 'x-access-token': 'tok' } };

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

const idleStatus: StrmToolTurboStatus = {
  installed: true,
  version: '1.0.0.0',
  pluginStatus: 'Active',
  config: CONFIG,
  task: { id: 't1', name: 'Extract', state: 'Idle', running: false, progressPercent: null, lastRun: null },
};

describe('useStrmToolTurbo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    axios.isAxiosError.mockReturnValue(false);
  });

  test('fetches status on mount', async () => {
    axios.get.mockResolvedValueOnce({ data: idleStatus });
    const { result } = renderHook(() => useStrmToolTurbo('tok'));
    await waitFor(() => expect(result.current.status).not.toBeNull());
    expect(axios.get).toHaveBeenCalledWith(ENDPOINT, HEADERS);
    expect(result.current.status?.version).toBe('1.0.0.0');
  });

  test('does not fetch without a token', () => {
    renderHook(() => useStrmToolTurbo(null));
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('surfaces the server error message when the fetch fails', async () => {
    axios.isAxiosError.mockReturnValue(true);
    axios.get.mockRejectedValueOnce({ response: { data: { error: 'Jellyfin rejected the API key' } } });
    const { result } = renderHook(() => useStrmToolTurbo('tok'));
    await waitFor(() => expect(result.current.error).toBe('Jellyfin rejected the API key'));
  });

  test('save puts only the given updates and stores the returned config', async () => {
    axios.get.mockResolvedValueOnce({ data: idleStatus });
    axios.put.mockResolvedValueOnce({ data: { config: { ...CONFIG, maxConcurrentExtract: 9 } } });
    const { result } = renderHook(() => useStrmToolTurbo('tok'));
    await waitFor(() => expect(result.current.status).not.toBeNull());

    let ok = false;
    await act(async () => {
      ok = await result.current.save({ maxConcurrentExtract: 9 });
    });

    expect(ok).toBe(true);
    expect(axios.put).toHaveBeenCalledWith(`${ENDPOINT}/config`, { maxConcurrentExtract: 9 }, HEADERS);
    expect(result.current.status?.config?.maxConcurrentExtract).toBe(9);
  });

  test('save reports the server error and returns false', async () => {
    axios.get.mockResolvedValueOnce({ data: idleStatus });
    axios.isAxiosError.mockReturnValue(true);
    axios.put.mockRejectedValueOnce({ response: { data: { error: 'maxConcurrentExtract must be a whole number from 1 to 50' } } });
    const { result } = renderHook(() => useStrmToolTurbo('tok'));
    await waitFor(() => expect(result.current.status).not.toBeNull());

    let ok = true;
    await act(async () => {
      ok = await result.current.save({ maxConcurrentExtract: 0 });
    });

    expect(ok).toBe(false);
    expect(result.current.saveError).toBe('maxConcurrentExtract must be a whole number from 1 to 50');
  });

  test('run posts to the run endpoint and flips the task to running', async () => {
    axios.get.mockResolvedValueOnce({ data: idleStatus });
    axios.post.mockResolvedValueOnce({ status: 202, data: { started: true } });
    const { result } = renderHook(() => useStrmToolTurbo('tok'));
    await waitFor(() => expect(result.current.status).not.toBeNull());

    await act(async () => {
      await result.current.run();
    });

    expect(axios.post).toHaveBeenCalledWith(`${ENDPOINT}/run`, null, HEADERS);
    expect(result.current.status?.task?.running).toBe(true);
  });

  test('run reports the server error when the task cannot start', async () => {
    axios.get.mockResolvedValueOnce({ data: idleStatus });
    axios.isAxiosError.mockReturnValue(true);
    axios.post.mockRejectedValueOnce({ response: { status: 404, data: { error: 'Task not found' } } });
    const { result } = renderHook(() => useStrmToolTurbo('tok'));
    await waitFor(() => expect(result.current.status).not.toBeNull());

    await act(async () => {
      await result.current.run();
    });

    expect(result.current.runError).toBe('Task not found');
  });

  test('stop posts to the stop endpoint and flips the task to cancelling', async () => {
    const runningTask = { ...idleStatus.task!, state: 'Running', running: true };
    axios.get.mockResolvedValue({ data: { ...idleStatus, task: runningTask } });
    axios.post.mockResolvedValueOnce({ status: 202, data: { stopping: true } });
    const { result } = renderHook(() => useStrmToolTurbo('tok'));
    await waitFor(() => expect(result.current.status).not.toBeNull());

    await act(async () => {
      await result.current.stop();
    });

    expect(axios.post).toHaveBeenCalledWith(`${ENDPOINT}/stop`, null, HEADERS);
    expect(result.current.status?.task?.state).toBe('Cancelling');
  });

  test('stop reports the server error and refreshes on a 409', async () => {
    axios.get.mockResolvedValue({ data: idleStatus });
    axios.isAxiosError.mockReturnValue(true);
    axios.post.mockRejectedValueOnce({ response: { status: 409, data: { error: 'The extraction task is not running' } } });
    const { result } = renderHook(() => useStrmToolTurbo('tok'));
    await waitFor(() => expect(result.current.status).not.toBeNull());
    const callsBefore = axios.get.mock.calls.length;

    await act(async () => {
      await result.current.stop();
    });

    expect(result.current.stopError).toBe('The extraction task is not running');
    expect(axios.get.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  test('polls while the task runs and stops once it finishes', async () => {
    jest.useFakeTimers();
    try {
      const runningTask = { ...idleStatus.task!, state: 'Running', running: true, progressPercent: 40 };
      axios.get
        .mockResolvedValueOnce({ data: { ...idleStatus, task: runningTask } })
        .mockResolvedValueOnce({ data: idleStatus });

      const { result } = renderHook(() => useStrmToolTurbo('tok'));
      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current.status?.task?.running).toBe(true);

      await act(async () => {
        jest.advanceTimersByTime(2000);
      });
      expect(result.current.status?.task?.running).toBe(false);

      const callsAfterFinish = axios.get.mock.calls.length;
      await act(async () => {
        jest.advanceTimersByTime(6000);
      });
      expect(axios.get.mock.calls.length).toBe(callsAfterFinish);
    } finally {
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
    }
  });

  test('stops polling on unmount', async () => {
    jest.useFakeTimers();
    try {
      const runningTask = { ...idleStatus.task!, state: 'Running', running: true };
      axios.get.mockResolvedValue({ data: { ...idleStatus, task: runningTask } });
      const { unmount } = renderHook(() => useStrmToolTurbo('tok'));
      await act(async () => {
        await Promise.resolve();
      });
      unmount();
      const calls = axios.get.mock.calls.length;
      await act(async () => {
        jest.advanceTimersByTime(6000);
      });
      expect(axios.get.mock.calls.length).toBe(calls);
    } finally {
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
    }
  });
});
