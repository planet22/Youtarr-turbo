import { useCallback, useState } from 'react';
import axios from 'axios';

export interface CompactHistoryPreview {
  totalJobs: number;
  compactableCount: number;
}

export interface UseCompactHistoryReturn {
  preview: CompactHistoryPreview | null;
  loadingPreview: boolean;
  compacting: boolean;
  error: string | null;
  fetchPreview: () => Promise<CompactHistoryPreview | null>;
  compact: () => Promise<number | null>;
  clearPreview: () => void;
}

// Drives the Maintenance page's "Compact History" dry-run + confirm flow:
// fetchPreview() gets the "N of M will be removed" counts without changing
// anything, compact() actually performs the delete.
export function useCompactHistory(token: string | null): UseCompactHistoryReturn {
  const [preview, setPreview] = useState<CompactHistoryPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const headers = token ? { 'x-access-token': token } : undefined;

  const fetchPreview = useCallback(async () => {
    setError(null);
    setLoadingPreview(true);
    try {
      const res = await axios.get<CompactHistoryPreview>(
        '/api/maintenance/compact-history-preview',
        { headers }
      );
      setPreview(res.data);
      return res.data;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load history preview';
      setError(message);
      return null;
    } finally {
      setLoadingPreview(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const compact = useCallback(async () => {
    setError(null);
    setCompacting(true);
    try {
      const res = await axios.post<{ success: boolean; deletedCount: number }>(
        '/api/maintenance/compact-history',
        undefined,
        { headers }
      );
      setPreview(null);
      return res.data.deletedCount;
    } catch (err: unknown) {
      const message = axios.isAxiosError(err)
        ? err.response?.data?.error || 'Failed to compact history'
        : 'Failed to compact history';
      setError(message);
      return null;
    } finally {
      setCompacting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const clearPreview = useCallback(() => setPreview(null), []);

  return { preview, loadingPreview, compacting, error, fetchPreview, compact, clearPreview };
}
