import { useState } from 'react';
import axios from 'axios';

interface StrmSwitchResult {
  success: boolean;
  processed: number[];
  failed: Array<{ videoId: number; error: string }>;
}

interface UseStrmSwitchReturn {
  forceDownload: (videoIds: number[], token: string | null) => Promise<StrmSwitchResult>;
  revertToStrm: (videoIds: number[], token: string | null) => Promise<StrmSwitchResult>;
  loading: boolean;
  error: string | null;
}

export const useStrmSwitch = (): UseStrmSwitchReturn => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const post = async (
    url: string,
    videoIds: number[],
    token: string | null
  ): Promise<StrmSwitchResult> => {
    setLoading(true);
    setError(null);

    try {
      const response = await axios.post<StrmSwitchResult>(
        url,
        { videoIds },
        { headers: { 'x-access-token': token || '' } }
      );
      setLoading(false);
      return response.data;
    } catch (err: any) {
      const errorMessage = err.response?.data?.error || err.message || 'Request failed';
      setError(errorMessage);
      setLoading(false);
      return {
        success: false,
        processed: [],
        failed: videoIds.map((videoId) => ({ videoId, error: errorMessage })),
      };
    }
  };

  const forceDownload = (videoIds: number[], token: string | null) =>
    post('/api/videos/strm/download', videoIds, token);

  const revertToStrm = (videoIds: number[], token: string | null) =>
    post('/api/videos/strm/revert', videoIds, token);

  return { forceDownload, revertToStrm, loading, error };
};
