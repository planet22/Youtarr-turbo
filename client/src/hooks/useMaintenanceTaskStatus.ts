import { useCallback, useContext, useEffect, useState } from 'react';
import axios from 'axios';
import WebSocketContext from '../contexts/WebSocketContext';

// Shared shape behind the maintenance-task status hooks (useRescanStatus,
// useMetadataRegenStatus, useResolutionTagBackfillStatus,
// useChannelImageRegenStatus): each polls a status endpoint on mount, then
// tracks live progress via one WebSocket message type, and exposes a
// trigger action to start the task. Only the endpoints/message type/error
// copy differ between tasks - each hook below is a thin wrapper over this.
export interface MaintenanceTaskStatusResponse<TLastRun> {
  running: boolean;
  lastRun: TLastRun | null;
}

interface MaintenanceTaskStatusPayload<TLastRun> {
  running: boolean;
  lastRun?: TLastRun | null;
}

export interface MaintenanceTaskStatusConfig {
  statusUrl: string;
  triggerUrl: string;
  wsMessageType: string;
  loadErrorMessage: string;
  alreadyRunningMessage: string;
  triggerErrorMessage: string;
}

export interface UseMaintenanceTaskStatusReturn<TLastRun> {
  running: boolean;
  lastRun: TLastRun | null;
  loading: boolean;
  error: string | null;
  trigger: () => Promise<void>;
}

export function useMaintenanceTaskStatus<TLastRun>(
  token: string | null,
  config: MaintenanceTaskStatusConfig
): UseMaintenanceTaskStatusReturn<TLastRun> {
  const { statusUrl, triggerUrl, wsMessageType, loadErrorMessage, alreadyRunningMessage, triggerErrorMessage } = config;

  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<TLastRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const ws = useContext(WebSocketContext);

  useEffect(() => {
    let cancelled = false;
    const headers = token ? { 'x-access-token': token } : undefined;

    axios
      .get<MaintenanceTaskStatusResponse<TLastRun>>(statusUrl, { headers })
      .then((res) => {
        if (cancelled) return;
        setRunning(res.data.running);
        setLastRun(res.data.lastRun);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : loadErrorMessage;
        setError(message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [token, statusUrl, loadErrorMessage]);

  useEffect(() => {
    if (!ws) return undefined;
    // Filter receives the full message envelope; callback receives only the
    // payload (WebSocketProvider strips the envelope before invoking).
    const filter = (msg: { type?: string }) => msg.type === wsMessageType;
    const callback = (payload: MaintenanceTaskStatusPayload<TLastRun>) => {
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
  }, [ws, wsMessageType]);

  const trigger = useCallback(async () => {
    setError(null);
    setRunning(true);
    const headers = token ? { 'x-access-token': token } : undefined;
    try {
      await axios.post(triggerUrl, undefined, { headers });
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 409) {
        const data = err.response.data as { error?: string } | undefined;
        setError(data?.error ?? alreadyRunningMessage);
        return;
      }
      setRunning(false);
      const message = err instanceof Error ? err.message : triggerErrorMessage;
      setError(message);
    }
  }, [token, triggerUrl, alreadyRunningMessage, triggerErrorMessage]);

  return { running, lastRun, loading, error, trigger };
}
