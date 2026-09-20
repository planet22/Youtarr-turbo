import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';

export interface ScheduledTask {
  id: string;
  label: string;
  description: string;
  cron: string;
  confirm: boolean;
  nextRun: string | null;
  running: boolean;
  lastTrigger: 'scheduled' | 'manual' | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastStatus: 'ok' | 'error' | null;
  lastError: string | null;
}

interface UseScheduledTasksResult {
  tasks: ScheduledTask[];
  loading: boolean;
  error: string | null;
  runTask: (id: string) => Promise<void>;
}

const RUNNING_POLL_INTERVAL_MS = 2000;

export function useScheduledTasks(token: string | null): UseScheduledTasksResult {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchTasks = useCallback(async () => {
    if (!token) {
      setLoading(false);
      return;
    }
    try {
      const response = await axios.get<{ tasks: ScheduledTask[] }>('/api/maintenance/tasks', {
        headers: { 'x-access-token': token },
      });
      setTasks(response.data.tasks);
      setError(null);
    } catch (err: unknown) {
      setError('Failed to load scheduled tasks');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void fetchTasks();
  }, [fetchTasks]);

  const anyRunning = tasks.some((task) => task.running);
  useEffect(() => {
    if (!anyRunning) return undefined;
    const interval = setInterval(() => void fetchTasks(), RUNNING_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [anyRunning, fetchTasks]);

  const runTask = useCallback(
    async (id: string) => {
      if (!token) return;
      let startError: string | null = null;
      try {
        await axios.post(`/api/maintenance/tasks/${encodeURIComponent(id)}/run`, {}, {
          headers: { 'x-access-token': token },
        });
      } catch (err: unknown) {
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;
        startError = status === 409 ? 'Task is already running' : 'Failed to start task';
      }
      // Refetch first: a successful fetch clears the error state.
      await fetchTasks();
      if (startError) setError(startError);
    },
    [token, fetchTasks]
  );

  return { tasks, loading, error, runTask };
}
