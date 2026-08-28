import { useState } from 'react';
import axios from 'axios';

interface PurgeResult {
  success: boolean;
  purged: number[];
  failed: Array<{ videoId: number; error: string }>;
}

interface UseVideoPurgeReturn {
  purgeVideos: (videoIds: number[], token: string | null) => Promise<PurgeResult>;
  loading: boolean;
  error: string | null;
}

// Purges (permanently removes the database row for) videos already marked
// missing from disk — no file operations, since there's nothing left to
// delete. See useVideoDeletion for the "delete file + mark removed" flow
// this is deliberately separate from.
export const useVideoPurge = (): UseVideoPurgeReturn => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const purgeVideos = async (
    videoIds: number[],
    token: string | null
  ): Promise<PurgeResult> => {
    setLoading(true);
    setError(null);

    try {
      const response = await axios.delete<PurgeResult>('/api/videos/purge', {
        headers: {
          'x-access-token': token || '',
        },
        data: {
          videoIds,
        },
      });

      setLoading(false);
      return response.data;
    } catch (err: any) {
      const errorMessage = err.response?.data?.error || err.message || 'Failed to purge videos';
      setError(errorMessage);
      setLoading(false);

      return {
        success: false,
        purged: [],
        failed: videoIds.map(id => ({ videoId: id, error: errorMessage })),
      };
    }
  };

  return {
    purgeVideos,
    loading,
    error,
  };
};
