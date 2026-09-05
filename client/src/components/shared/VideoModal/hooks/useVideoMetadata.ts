import { useState, useEffect } from 'react';
import axios from 'axios';
import { VideoExtendedMetadata } from '../types';

interface UseVideoMetadataReturn {
  metadata: VideoExtendedMetadata | null;
  loading: boolean;
  error: string | null;
  refreshing: boolean;
  refresh: () => Promise<void>;
}

export const useVideoMetadata = (
  youtubeId: string,
  token: string | null
): UseVideoMetadataReturn => {
  const [metadata, setMetadata] = useState<VideoExtendedMetadata | null>(null);
  const [metadataYoutubeId, setMetadataYoutubeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!youtubeId || !token) {
      setMetadata(null);
      setMetadataYoutubeId(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;

    const fetchMetadata = async () => {
      setLoading(true);
      setMetadata(null);
      setMetadataYoutubeId(youtubeId);
      setError(null);

      try {
        const response = await axios.get<VideoExtendedMetadata>(
          `/api/videos/${youtubeId}/metadata`,
          { headers: { 'x-access-token': token } }
        );

        if (!cancelled) {
          setMetadata(response.data);
          setMetadataYoutubeId(youtubeId);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          const errorMessage =
            (err as { response?: { data?: { error?: string } } })?.response?.data?.error ||
            (err instanceof Error ? err.message : 'Failed to fetch video metadata');
          setError(errorMessage);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    fetchMetadata();

    return () => {
      cancelled = true;
    };
  }, [youtubeId, token]);

  const refresh = async () => {
    if (!youtubeId || !token) return;
    setRefreshing(true);
    setError(null);
    try {
      const response = await axios.post<VideoExtendedMetadata>(
        `/api/videos/${youtubeId}/metadata/refresh`,
        null,
        { headers: { 'x-access-token': token } }
      );
      setMetadata(response.data);
      setMetadataYoutubeId(youtubeId);
    } catch (err: unknown) {
      const errorMessage =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ||
        (err instanceof Error ? err.message : 'Failed to refresh video metadata');
      setError(errorMessage);
    } finally {
      setRefreshing(false);
    }
  };

  return {
    metadata: Boolean(token) && metadataYoutubeId === youtubeId ? metadata : null,
    loading,
    error,
    refreshing,
    refresh,
  };
};
