import { useCallback, useState } from 'react';
import axios from 'axios';

export interface UseClearEventLogReturn {
  // Events currently in the log; null until the confirmation was asked for.
  eventCount: number | null;
  loadingCount: boolean;
  clearing: boolean;
  error: string | null;
  // Reads how many events would be deleted, without changing anything.
  fetchCount: () => Promise<number | null>;
  // Permanently deletes every event; resolves with how many were removed.
  clear: () => Promise<number | null>;
  dismiss: () => void;
}

function messageFrom(err: unknown, fallback: string): string {
  return axios.isAxiosError(err) ? err.response?.data?.error || fallback : fallback;
}

// Drives the Maintenance page's "Clear event log" flow: fetchCount() gets the
// "N events will be deleted" figure for the warning, clear() performs the delete.
export function useClearEventLog(token: string | null): UseClearEventLogReturn {
  const [eventCount, setEventCount] = useState<number | null>(null);
  const [loadingCount, setLoadingCount] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const headers = token ? { 'x-access-token': token } : undefined;

  const fetchCount = useCallback(async () => {
    setError(null);
    setLoadingCount(true);
    try {
      // limit=1: only the total matters, not the rows.
      const res = await axios.get<{ total: number }>('/api/job-events', { headers, params: { limit: 1 } });
      setEventCount(res.data.total);
      return res.data.total;
    } catch (err: unknown) {
      setError(messageFrom(err, 'Failed to count the event log'));
      return null;
    } finally {
      setLoadingCount(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const clear = useCallback(async () => {
    setError(null);
    setClearing(true);
    try {
      const res = await axios.delete<{ success: boolean; deletedCount: number }>('/api/job-events', { headers });
      setEventCount(null);
      return res.data.deletedCount;
    } catch (err: unknown) {
      setError(messageFrom(err, 'Failed to clear the event log'));
      return null;
    } finally {
      setClearing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const dismiss = useCallback(() => setEventCount(null), []);

  return { eventCount, loadingCount, clearing, error, fetchCount, clear, dismiss };
}
