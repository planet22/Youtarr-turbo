import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';

export interface NzbRecentQuery {
  query: string;
  count: number;
  source: string;
  cacheHit: boolean;
  resultCount: number;
  durationMs: number;
  timestamp: number;
}

export interface NzbCachedEntry {
  key: string;
  query: string;
  count: number;
  source: string;
  resultCount: number;
  cachedAt: number;
  expiresAt: number;
  expiresInMs: number;
}

export interface NzbStats {
  totalQueries: number;
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number;
  queriesPerSecond: number;
  recentQueries: NzbRecentQuery[];
  cachedEntries: NzbCachedEntry[];
}

interface UseNzbStatsResult {
  stats: NzbStats | null;
  loading: boolean;
  error: boolean;
  refetch: () => Promise<void>;
  deleteCacheEntries: (keys: string[]) => Promise<void>;
}

const POLL_INTERVAL_MS = 5000;

export const useNzbStats = (token: string | null): UseNzbStatsResult => {
  const [stats, setStats] = useState<NzbStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const fetchStats = useCallback(async () => {
    if (!token) {
      setLoading(false);
      return;
    }
    try {
      const response = await axios.get<NzbStats>('/api/nzb/stats', {
        headers: { 'x-access-token': token },
      });
      setStats(response.data);
      setError(false);
    } catch (err) {
      console.error('Failed to fetch NZB stats:', err);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchStats]);

  const deleteCacheEntries = useCallback(
    async (keys: string[]) => {
      if (!token || keys.length === 0) return;
      await axios.delete('/api/nzb/cache', {
        headers: { 'x-access-token': token },
        data: { keys },
      });
      await fetchStats();
    },
    [token, fetchStats]
  );

  return { stats, loading, error, refetch: fetchStats, deleteCacheEntries };
};
