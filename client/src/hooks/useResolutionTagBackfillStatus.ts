import { useCallback, useContext, useEffect, useState } from 'react';
import axios from 'axios';
import WebSocketContext from '../contexts/WebSocketContext';

export type ResolutionTagBackfillTrigger = 'manual';
export type ResolutionTagBackfillStatus = 'completed' | 'timed-out' | 'error';

export interface ResolutionTagBackfillLastRun {
  startedAt: string;
  completedAt: string;
  trigger: ResolutionTagBackfillTrigger;
  status: ResolutionTagBackfillStatus;
  scanned: number;
  tagged: number;
  skippedNoCache: number;
  skippedNoNfo: number;
  errors: number;
  errorMessage?: string | null;
}

interface StatusResponse {
  running: boolean;
  lastRun: ResolutionTagBackfillLastRun | null;
}

interface StatusPayload {
  running: boolean;
  trigger?: ResolutionTagBackfillTrigger;
  lastRun?: ResolutionTagBackfillLastRun | null;
}

export interface UseResolutionTagBackfillStatusReturn {
  running: boolean;
  lastRun: ResolutionTagBackfillLastRun | null;
  loading: boolean;
  error: string | null;
  triggerBackfill: () => Promise<void>;
}

export function useResolutionTagBackfillStatus(token: string | null): UseResolutionTagBackfillStatusReturn {
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<ResolutionTagBackfillLastRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const ws = useContext(WebSocketContext);

  useEffect(() => {
    let cancelled = false;
    const headers = token ? { 'x-access-token': token } : undefined;

    axios
      .get<StatusResponse>('/api/maintenance/backfill-resolution-tags-status', { headers })
      .then((res) => {
        if (cancelled) return;
        setRunning(res.data.running);
        setLastRun(res.data.lastRun);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Failed to load resolution tag backfill status';
        setError(message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!ws) return undefined;
    // Filter receives the full message envelope; callback receives only the
    // payload (WebSocketProvider strips the envelope before invoking).
    const filter = (msg: { type?: string }) => msg.type === 'resolutionTagBackfillStatus';
    const callback = (payload: StatusPayload) => {
      setRunning(payload.running);
      if (payload.running) {
        setError(null);
      }
      if (payload.lastRun !== undefined) {
        setLastRun(payload.lastRun);
        setError(null);
      }
    };
    ws.subscribe(filter, callback);
    return () => ws.unsubscribe(callback);
  }, [ws]);

  const triggerBackfill = useCallback(async () => {
    setError(null);
    setRunning(true);
    const headers = token ? { 'x-access-token': token } : undefined;
    try {
      await axios.post('/api/maintenance/backfill-resolution-tags', undefined, { headers });
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 409) {
        const data = err.response.data as { error?: string } | undefined;
        setError(data?.error ?? 'Resolution tag backfill already in progress');
        return;
      }
      setRunning(false);
      const message = err instanceof Error ? err.message : 'Failed to start resolution tag backfill';
      setError(message);
    }
  }, [token]);

  return { running, lastRun, loading, error, triggerBackfill };
}
