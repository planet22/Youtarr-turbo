import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';

interface UseMetadataCacheReturn {
  count: number | null;
  loading: boolean;
  clearing: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  clear: () => Promise<void>;
}

/**
 * The persistent yt-dlp metadata cache (server/modules/youtubeMetadataCache.js
 * - youtube_metadata_cache table). Holds each video's fps/duration/etc. (the
 * raw yt-dlp -j blob) so ytstream's segment-duration correction and
 * seek-restart cache warming never need an extra live yt-dlp call for a
 * video seen before, whether via streaming, download, or STRM generation.
 * No TTL - entries persist until manually cleared here.
 */
export function useMetadataCache(token: string | null): UseMetadataCacheReturn {
  const [count, setCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const response = await axios.get<{ count: number }>(
        '/api/ytstream/metadata-cache',
        { headers: { 'x-access-token': token } }
      );
      setCount(response.data.count);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr.response?.data?.error || 'Failed to load metadata cache size');
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
      await axios.delete('/api/ytstream/metadata-cache', {
        headers: { 'x-access-token': token },
      });
      setCount(0);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr.response?.data?.error || 'Failed to delete metadata cache');
    } finally {
      setClearing(false);
    }
  }, [token]);

  return { count, loading, clearing, error, refresh, clear };
}
