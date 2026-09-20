import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';

interface UseCacheResetReturn {
  count: number | null;
  loading: boolean;
  clearing: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  clear: () => Promise<void>;
}

/**
 * Generic count/clear pair for a server-side cache/log table exposed as
 * GET (row count) + DELETE (clear all) on the same endpoint - same shape as
 * server/routes/ytstream.js's metadata-cache and untracked-cache routes.
 * Shared by the NZB Settings section's "Diagnostic Log Limits" and "NZB
 * Video Cache" clear buttons, which are otherwise identical except for the
 * endpoint they hit.
 */
export function useCacheReset(token: string | null, endpoint: string): UseCacheResetReturn {
  const [count, setCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const response = await axios.get<{ count: number }>(endpoint, {
        headers: { 'x-access-token': token },
      });
      setCount(response.data.count);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr.response?.data?.error || 'Failed to load cache size');
    } finally {
      setLoading(false);
    }
  }, [token, endpoint]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const clear = useCallback(async () => {
    if (!token) return;
    setClearing(true);
    setError(null);
    try {
      await axios.delete(endpoint, {
        headers: { 'x-access-token': token },
      });
      setCount(0);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr.response?.data?.error || 'Failed to clear cache');
    } finally {
      setClearing(false);
    }
  }, [token, endpoint]);

  return { count, loading, clearing, error, refresh, clear };
}
