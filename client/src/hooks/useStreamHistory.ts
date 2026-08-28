import { useCallback, useContext, useEffect, useState } from 'react';
import axios from 'axios';
import WebSocketContext, { Message } from '../contexts/WebSocketContext';

export interface StreamHistoryRow {
  streamId: string;
  youtubeId: string;
  title: string | null;
  mode: 'hls' | 'ffmpeg';
  quality: string | null;
  container: string | null;
  transcode: string | null;
  hardwareMode: string | null;
  clientIp: string | null;
  userAgent: string | null;
  startedAt: string;
  endedAt: string | null;
  bytesTransferred: number;
  endReason: string | null;
  errorMessage: string | null;
}

interface StreamHistoryResponse {
  rows: StreamHistoryRow[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Server-side-paginated fetch of the persisted stream-history audit trail
 * (server/models/streamhistory.js, via GET /api/ytstream/history) - unlike
 * useActiveStreams, which fetches everything (the live-stream count is
 * naturally small). History has no such bound, so page/limit are query
 * params rather than client-side slicing.
 *
 * Only refetches on a `streamStopped` broadcast while viewing page 1 - a
 * newly-finished stream should appear at the top of "recent activity"
 * without the user having to manually refresh, but older pages don't shift
 * around under a viewer just because something elsewhere finished.
 */
export function useStreamHistory(token: string | null, page: number, limit = 25) {
  const [rows, setRows] = useState<StreamHistoryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const wsContext = useContext(WebSocketContext);
  const subscribe = wsContext?.subscribe;
  const unsubscribe = wsContext?.unsubscribe;

  const fetchHistory = useCallback(async () => {
    if (!token) {
      setRows([]);
      setTotal(0);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const response = await axios.get<StreamHistoryResponse>('/api/ytstream/history', {
        params: { page, limit },
        headers: { 'x-access-token': token },
      });
      setRows(response.data?.rows || []);
      setTotal(response.data?.total || 0);
    } catch {
      // Leave the current value; the page can be manually refreshed.
    } finally {
      setLoading(false);
    }
  }, [token, page, limit]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  useEffect(() => {
    if (!subscribe || !unsubscribe || page !== 1) return;

    const stoppedFilter = (message: Message) =>
      message.destination === 'broadcast' && message.type === 'streamStopped';
    const stoppedCallback = () => fetchHistory();

    subscribe(stoppedFilter, stoppedCallback);
    return () => unsubscribe(stoppedCallback);
  }, [subscribe, unsubscribe, page, fetchHistory]);

  return { rows, total, loading, refetch: fetchHistory };
}
