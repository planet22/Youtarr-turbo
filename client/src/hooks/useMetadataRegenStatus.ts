import { useCallback, useContext, useEffect, useState } from 'react';
import axios from 'axios';
import WebSocketContext from '../contexts/WebSocketContext';

export type MetadataRegenTrigger = 'manual';
export type MetadataRegenStatus = 'completed' | 'timed-out' | 'error';

export interface MetadataRegenLastRun {
  startedAt: string;
  completedAt: string;
  trigger: MetadataRegenTrigger;
  status: MetadataRegenStatus;
  scanned: number;
  regenerated: number;
  skippedNoCache: number;
  skippedNoFile: number;
  errors: number;
  errorMessage?: string | null;
}

interface StatusResponse {
  running: boolean;
  lastRun: MetadataRegenLastRun | null;
}

interface StatusPayload {
  running: boolean;
  trigger?: MetadataRegenTrigger;
  lastRun?: MetadataRegenLastRun | null;
}

export interface UseMetadataRegenStatusReturn {
  running: boolean;
  lastRun: MetadataRegenLastRun | null;
  loading: boolean;
  error: string | null;
  triggerRegen: () => Promise<void>;
}

/**
 * Drives POST /api/maintenance/regenerate-metadata (server/routes/maintenance.js),
 * which fully rewrites every already-downloaded/STRM'd video's .nfo file from
 * its cached .info.json. Mirrors useResolutionTagBackfillStatus's shape.
 */
export function useMetadataRegenStatus(token: string | null): UseMetadataRegenStatusReturn {
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<MetadataRegenLastRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const ws = useContext(WebSocketContext);

  useEffect(() => {
    let cancelled = false;
    const headers = token ? { 'x-access-token': token } : undefined;

    axios
      .get<StatusResponse>('/api/maintenance/regenerate-metadata-status', { headers })
      .then((res) => {
        if (cancelled) return;
        setRunning(res.data.running);
        setLastRun(res.data.lastRun);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Failed to load metadata regeneration status';
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
    const filter = (msg: { type?: string }) => msg.type === 'metadataRegenStatus';
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

  const triggerRegen = useCallback(async () => {
    setError(null);
    setRunning(true);
    const headers = token ? { 'x-access-token': token } : undefined;
    try {
      await axios.post('/api/maintenance/regenerate-metadata', undefined, { headers });
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 409) {
        const data = err.response.data as { error?: string } | undefined;
        setError(data?.error ?? 'Metadata regeneration already in progress');
        return;
      }
      setRunning(false);
      const message = err instanceof Error ? err.message : 'Failed to start metadata regeneration';
      setError(message);
    }
  }, [token]);

  return { running, lastRun, loading, error, triggerRegen };
}
