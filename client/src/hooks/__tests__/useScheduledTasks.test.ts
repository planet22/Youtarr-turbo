import { renderHook, waitFor, act } from '@testing-library/react';
import { useScheduledTasks, ScheduledTask } from '../useScheduledTasks';

jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
  isAxiosError: jest.fn(),
}));

const axios = require('axios') as { get: jest.Mock; post: jest.Mock; isAxiosError: jest.Mock };

const task: ScheduledTask = {
  id: 'session-cleanup',
  label: 'Session cleanup',
  description: '',
  cron: '0 3 * * *',
  confirm: false,
  nextRun: null,
  running: false,
  lastTrigger: null,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastStatus: null,
  lastError: null,
};

describe('useScheduledTasks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    axios.get.mockResolvedValue({ data: { tasks: [task] } });
    axios.post.mockResolvedValue({ data: { status: 'started' } });
  });

  test('loads the tasks on mount', async () => {
    const { result } = renderHook(() => useScheduledTasks('tok'));
    await waitFor(() => expect(result.current.tasks).toEqual([task]));
  });

  test('does not fetch without a token', async () => {
    const { result } = renderHook(() => useScheduledTasks(null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('reports a load error', async () => {
    axios.get.mockRejectedValue(new Error('down'));
    const { result } = renderHook(() => useScheduledTasks('tok'));
    await waitFor(() => expect(result.current.error).toBe('Failed to load scheduled tasks'));
  });

  test('runTask posts to the task run endpoint and refetches', async () => {
    const { result } = renderHook(() => useScheduledTasks('tok'));
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));

    await act(async () => {
      await result.current.runTask('session-cleanup');
    });

    expect(axios.post).toHaveBeenCalledWith(
      '/api/maintenance/tasks/session-cleanup/run',
      {},
      { headers: { 'x-access-token': 'tok' } }
    );
    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  test('runTask reports an already-running task', async () => {
    axios.isAxiosError.mockReturnValue(true);
    axios.post.mockRejectedValue({ isAxiosError: true, response: { status: 409 } });
    const { result } = renderHook(() => useScheduledTasks('tok'));
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));

    await act(async () => {
      await result.current.runTask('session-cleanup');
    });

    expect(result.current.error).toBe('Task is already running');
  });
});
