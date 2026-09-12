import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';

export interface NzbSearchSettings {
  backend: 'yt-dlp' | 'youtube-api';
  cookiesEnabled: boolean | null;
  proxy: string | null;
  ipFamily: string | null;
  hasCustomArgs: boolean | null;
}

export interface NzbRecentQuery {
  // Shared with the matching NzbSearchTrace (same search, same round trip) -
  // lets the Recent Queries table link a row to its full candidate
  // breakdown. Absent on rows recorded before this field existed, or if no
  // matching trace was ever recorded for this search.
  searchId?: string;
  query: string;
  count: number;
  source: string;
  cacheHit: boolean;
  resultCount: number;
  durationMs: number;
  timestamp: number;
  settingsSnapshot: NzbSearchSettings;
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
  settingsSnapshot: NzbSearchSettings;
}

export type NzbFilterReason =
  | 'keyword'
  | 'excluded-term'
  | 'wrong-season'
  | 'wrong-episode'
  | 'no-episode-marker'
  | 'episode-code'
  | null;

export interface NzbSearchTraceItem {
  youtubeId: string;
  title: string;
  kept: boolean;
  reason: NzbFilterReason;
  matchedTerm: string | null;
  // Only set for a kept item that also landed in this page's actual
  // response (`results`, post offset/limit slice) - that's the only subset
  // the server ever resolves real quality info for. 'hd'/'sd' from the
  // YouTube Data API, a previously-downloaded video's own known resolution,
  // or (yt-dlp fallback searches) a thumbnail/real-extraction probe; null
  // means unknown (nothing ran, or everything that did run failed) or this
  // item simply wasn't part of the returned page.
  definition?: 'hd' | 'sd' | null;
  // The actual [XXXp] height this item was labeled with in the response -
  // may be lower than configuredHeightTier when definition is 'sd'. Same
  // "only for items in the returned page" caveat as definition above.
  effectiveHeightTier?: number | null;
  // Which check in nzb.resolutionDetection's fallback chain actually
  // decided `definition`/`effectiveHeightTier` - 'fixed' (a previously-
  // downloaded video's real recorded resolution), 'api' (YouTube Data API's
  // contentDetails.definition), 'thumb' (the maxresdefault-thumbnail
  // heuristic), 'extract' (a real yt-dlp extraction), or null when nothing
  // determined anything.
  resolutionSource?: 'fixed' | 'api' | 'thumb' | 'extract' | null;
}

export interface NzbSearchTrace {
  // See NzbRecentQuery.searchId - shared between the two for the same search.
  searchId?: string;
  timestamp: number;
  categoryName: string;
  searchType: string;
  query: string;
  newquery: string | null;
  season: number | null;
  ep: number | null;
  additionalLocalFilterEnabled: boolean;
  offset: number;
  limit: number;
  // The configured download quality's tier (e.g. 1080) before any
  // per-result SD capping - the ceiling each item's effectiveHeightTier is
  // measured against. Absent on traces recorded before this field existed.
  configuredHeightTier?: number;
  items: NzbSearchTraceItem[];
}

export interface NzbFailedGrab {
  jobId: string;
  categoryName: string | null;
  youtubeId: string | null;
  nzbName: string | null;
  message: string;
  timestamp: number;
}

export interface NzbActiveJob {
  jobId: string;
  isCurrent: boolean;
  status: 'Downloading' | 'Queued';
  categoryName: string | null;
  nzbName: string | null;
  percent: number;
  etaSeconds: number;
  totalBytes: number;
  downloadedBytes: number;
}

export interface NzbHistoryJob {
  jobId: string;
  status: 'Completed' | 'Failed';
  categoryName: string | null;
  nzbName: string | null;
  bytes: number;
}

export interface NzbJobsSnapshot {
  active: NzbActiveJob[];
  history: NzbHistoryJob[];
}

export interface NzbStats {
  totalQueries: number;
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number;
  queriesPerMinute: number;
  recentQueries: NzbRecentQuery[];
  cachedEntries: NzbCachedEntry[];
  searchSettings: NzbSearchSettings;
  searchTraces: NzbSearchTrace[];
  failedGrabs: NzbFailedGrab[];
  jobs: NzbJobsSnapshot;
}

interface UseNzbStatsResult {
  stats: NzbStats | null;
  loading: boolean;
  error: boolean;
  refetch: () => Promise<void>;
  deleteCacheEntries: (keys: string[]) => Promise<void>;
  cancelCurrentJob: () => Promise<void>;
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

  const cancelCurrentJob = useCallback(async () => {
    if (!token) return;
    // Reuses the same endpoint the Download Activity page's own "Terminate"
    // action calls - it terminates whatever job is currently actively
    // downloading, not a specific jobId (downloadModule only runs one job
    // at a time). Only meaningful for a row where isCurrent is true.
    await axios.post(
      '/api/jobs/terminate',
      {},
      { headers: { 'x-access-token': token } }
    );
    await fetchStats();
  }, [token, fetchStats]);

  return { stats, loading, error, refetch: fetchStats, deleteCacheEntries, cancelCurrentJob };
};
