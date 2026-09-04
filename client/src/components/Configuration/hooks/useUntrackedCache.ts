import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';

interface UseUntrackedCacheReturn {
  fileCount: number | null;
  totalBytes: number | null;
  loading: boolean;
  clearing: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  clear: () => Promise<void>;
}

/**
 * Youtarr's own untracked-buffer cache (HLS_UNTRACKED_BUFFER_CACHE_DIR,
 * server-side) - mode=hls-buffer's finished download for a video
 * with no library Video row (an untracked NZB grab, or one disowned via
 * importStrategy:'untracked'). Never shows up in the library or Download
 * History, so this is the only place its disk usage is visible or
 * reclaimable at all.
 */
export function useUntrackedCache(token: string | null): UseUntrackedCacheReturn {
  const [fileCount, setFileCount] = useState<number | null>(null);
  const [totalBytes, setTotalBytes] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const response = await axios.get<{ fileCount: number; totalBytes: number }>(
        '/api/ytstream/untracked-cache',
        { headers: { 'x-access-token': token } }
      );
      setFileCount(response.data.fileCount);
      setTotalBytes(response.data.totalBytes);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr.response?.data?.error || 'Failed to load untracked cache size');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const clear = useCallback(async () => {
    if (!token) return;
    setClearing(true);
    setError(null);
    try {
      await axios.delete('/api/ytstream/untracked-cache', {
        headers: { 'x-access-token': token },
      });
      setFileCount(0);
      setTotalBytes(0);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr.response?.data?.error || 'Failed to delete untracked cache');
    } finally {
      setClearing(false);
    }
  }, [token]);

  return { fileCount, totalBytes, loading, clearing, error, refresh, clear };
}
