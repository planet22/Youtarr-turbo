import { useCallback, useState } from 'react';
import axios from 'axios';

export interface MetadataCacheDetail {
  youtubeId: string;
  durationSeconds: number | null;
  fetchedAt: string | null;
  // Pre-formatted "5h 4m ago" text (server/modules/relativeTimeFormatter.js)
  // - prefer this for display over computing relative time from fetchedAt.
  fetchedAgo: string | null;
  lastAccessedAt: string | null;
  lastAccessedAgo: string | null;
  expiresAt: string | null;
  title: string | null;
  uploader: string | null;
  resolution: string | null;
  fps: number | null;
  uploadDate: string | null;
  rawInfoJson?: unknown;
}

export interface UntrackedCacheDetail {
  exists: boolean;
  size: number | null;
  mtime: string | null;
}

interface BulkResult {
  success: boolean;
  failed: string[];
}

export interface UseCacheActionsReturn {
  loading: boolean;
  error: string | null;
  clearMetadataCache: (youtubeId: string) => Promise<boolean>;
  bulkClearMetadataCache: (youtubeIds: string[]) => Promise<BulkResult>;
  fetchMetadataDetail: (youtubeId: string, includeRaw?: boolean) => Promise<MetadataCacheDetail | null>;
  refreshMetadataCache: (youtubeId: string) => Promise<boolean>;
  clearVideoCache: (youtubeId: string) => Promise<boolean>;
  bulkClearVideoCache: (youtubeIds: string[]) => Promise<BulkResult>;
  fetchVideoCacheDetail: (youtubeId: string) => Promise<UntrackedCacheDetail | null>;
}

// Per-video counterpart to Configuration/hooks/useMetadataCache.ts and
// useUntrackedCache.ts, which only wrap the Settings page's aggregate
// count/clear-all endpoints. This hook backs the Library page's per-row
// "Cached Metadata"/"Cached Video" icons and their bulk-action toolbar
// entries - one row (or a bulk selection) at a time, not the whole cache.
export function useCacheActions(token: string | null): UseCacheActionsReturn {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const authHeaders = { headers: { 'x-access-token': token || '' } };

  const clearMetadataCache = useCallback(
    async (youtubeId: string): Promise<boolean> => {
      if (!token) return false;
      setLoading(true);
      setError(null);
      try {
        await axios.delete(`/api/ytstream/${encodeURIComponent(youtubeId)}/metadata-cache`, authHeaders);
        return true;
      } catch (err: unknown) {
        const axiosErr = err as { response?: { data?: { error?: string } } };
        setError(axiosErr.response?.data?.error || 'Failed to clear cached metadata');
        return false;
      } finally {
        setLoading(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [token]
  );

  const bulkClearMetadataCache = useCallback(
    async (youtubeIds: string[]): Promise<BulkResult> => {
      if (!token || youtubeIds.length === 0) return { success: false, failed: youtubeIds };
      setLoading(true);
      setError(null);
      try {
        const response = await axios.delete<{ success: boolean; failed: string[] }>(
          '/api/ytstream/metadata-cache/bulk',
          { ...authHeaders, data: { youtubeIds } }
        );
        return { success: response.data.success, failed: response.data.failed || [] };
      } catch (err: unknown) {
        const axiosErr = err as { response?: { data?: { error?: string } } };
        setError(axiosErr.response?.data?.error || 'Failed to clear cached metadata');
        return { success: false, failed: youtubeIds };
      } finally {
        setLoading(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [token]
  );

  const fetchMetadataDetail = useCallback(
    async (youtubeId: string, includeRaw = false): Promise<MetadataCacheDetail | null> => {
      if (!token) return null;
      setLoading(true);
      setError(null);
      try {
        const response = await axios.get<MetadataCacheDetail>(
          `/api/ytstream/${encodeURIComponent(youtubeId)}/metadata-cache/detail${includeRaw ? '?raw=true' : ''}`,
          authHeaders
        );
        return response.data;
      } catch (err: unknown) {
        const axiosErr = err as { response?: { data?: { error?: string } } };
        setError(axiosErr.response?.data?.error || 'Failed to load cached metadata');
        return null;
      } finally {
        setLoading(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [token]
  );

  // Forces a fresh yt-dlp fetch that overwrites both the on-disk .info.json
  // and the youtube_metadata_cache DB row (see videoMetadataModule's
  // getVideoMetadata forceRefresh option) - the Library page's per-row
  // "Refresh Cached Metadata" action, same endpoint the video modal itself
  // uses to refresh what it's showing.
  const refreshMetadataCache = useCallback(
    async (youtubeId: string): Promise<boolean> => {
      if (!token) return false;
      setLoading(true);
      setError(null);
      try {
        await axios.post(`/api/videos/${encodeURIComponent(youtubeId)}/metadata/refresh`, null, authHeaders);
        return true;
      } catch (err: unknown) {
        const axiosErr = err as { response?: { data?: { error?: string } } };
        setError(axiosErr.response?.data?.error || 'Failed to refresh cached metadata');
        return false;
      } finally {
        setLoading(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [token]
  );

  const clearVideoCache = useCallback(
    async (youtubeId: string): Promise<boolean> => {
      if (!token) return false;
      setLoading(true);
      setError(null);
      try {
        await axios.delete(`/api/ytstream/${encodeURIComponent(youtubeId)}/untracked-cache`, authHeaders);
        return true;
      } catch (err: unknown) {
        const axiosErr = err as { response?: { data?: { error?: string } } };
        setError(axiosErr.response?.data?.error || 'Failed to clear cached video');
        return false;
      } finally {
        setLoading(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [token]
  );

  const bulkClearVideoCache = useCallback(
    async (youtubeIds: string[]): Promise<BulkResult> => {
      if (!token || youtubeIds.length === 0) return { success: false, failed: youtubeIds };
      setLoading(true);
      setError(null);
      try {
        const response = await axios.delete<{ success: boolean; failed: string[] }>(
          '/api/ytstream/untracked-cache/bulk',
          { ...authHeaders, data: { youtubeIds } }
        );
        return { success: response.data.success, failed: response.data.failed || [] };
      } catch (err: unknown) {
        const axiosErr = err as { response?: { data?: { error?: string } } };
        setError(axiosErr.response?.data?.error || 'Failed to clear cached video');
        return { success: false, failed: youtubeIds };
      } finally {
        setLoading(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [token]
  );

  const fetchVideoCacheDetail = useCallback(
    async (youtubeId: string): Promise<UntrackedCacheDetail | null> => {
      if (!token) return null;
      setLoading(true);
      setError(null);
      try {
        const response = await axios.get<UntrackedCacheDetail>(
          `/api/ytstream/${encodeURIComponent(youtubeId)}/untracked-cache`,
          authHeaders
        );
        return response.data;
      } catch (err: unknown) {
        const axiosErr = err as { response?: { data?: { error?: string } } };
        setError(axiosErr.response?.data?.error || 'Failed to load cached video info');
        return null;
      } finally {
        setLoading(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [token]
  );

  return {
    loading,
    error,
    clearMetadataCache,
    bulkClearMetadataCache,
    fetchMetadataDetail,
    refreshMetadataCache,
    clearVideoCache,
    bulkClearVideoCache,
    fetchVideoCacheDetail,
  };
}
