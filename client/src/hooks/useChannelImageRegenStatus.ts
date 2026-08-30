import { useCallback, useContext, useEffect, useState } from 'react';
import axios from 'axios';
import WebSocketContext from '../contexts/WebSocketContext';

export type ChannelImageRegenTrigger = 'manual';
export type ChannelImageRegenRunStatus = 'completed' | 'error';

export interface ChannelImageRegenLastRun {
  startedAt: string;
  completedAt: string;
  trigger: ChannelImageRegenTrigger;
  status: ChannelImageRegenRunStatus;
  channelsScanned?: number;
  copied?: number;
  skippedNoSource?: number;
  skippedNoFolder?: number;
  errors?: number;
  videoThumbsCopied?: number;
  videoThumbsDownloaded?: number;
  videoThumbsSkipped?: number;
  videoThumbsErrors?: number;
  errorMessage?: string | null;
}

interface StatusResponse {
  running: boolean;
  lastRun: ChannelImageRegenLastRun | null;
}

interface StatusPayload {
  running: boolean;
  trigger?: ChannelImageRegenTrigger;
  lastRun?: ChannelImageRegenLastRun | null;
}

export interface UseChannelImageRegenStatusReturn {
  running: boolean;
  lastRun: ChannelImageRegenLastRun | null;
  loading: boolean;
  error: string | null;
  triggerRegen: () => Promise<void>;
}

/**
 * Drives POST /api/maintenance/regenerate-channel-images (server/routes/maintenance.js),
 * which force re-copies poster/logo/backdrop/banner images for every
 * enabled channel, overwriting existing files - unlike the automatic
 * backfill (which only fills in missing images and so can never repair an
 * existing-but-broken one). Also fills in any video/episode's own missing
 * library-adjacent thumbnail (what its NFO's <thumb> tag references) -
 * "fill in if missing" semantics there, not force-overwrite, since a
 * missing thumbnail means it was never written, not that an existing file
 * has stale permissions. Mirrors useResolutionTagBackfillStatus's shape.
 */
export function useChannelImageRegenStatus(token: string | null): UseChannelImageRegenStatusReturn {
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<ChannelImageRegenLastRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const ws = useContext(WebSocketContext);

  useEffect(() => {
    let cancelled = false;
    const headers = token ? { 'x-access-token': token } : undefined;

    axios
      .get<StatusResponse>('/api/maintenance/regenerate-channel-images-status', { headers })
      .then((res) => {
        if (cancelled) return;
        setRunning(res.data.running);
        setLastRun(res.data.lastRun);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Failed to load channel image regeneration status';
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
    const filter = (msg: { type?: string }) => msg.type === 'channelImageRegenStatus';
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
      await axios.post('/api/maintenance/regenerate-channel-images', undefined, { headers });
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 409) {
        const data = err.response.data as { error?: string } | undefined;
        setError(data?.error ?? 'Channel image regeneration already in progress');
        return;
      }
      setRunning(false);
      const message = err instanceof Error ? err.message : 'Failed to start channel image regeneration';
      setError(message);
    }
  }, [token]);

  return { running, lastRun, loading, error, triggerRegen };
}
