import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';

const ENDPOINT = '/api/mediaservers/jellyfin/strmtoolturbo';
const RUNNING_POLL_INTERVAL_MS = 2_000;

export interface StrmToolTurboConfig {
  enableAutoExtract: boolean;
  enableMediaInfoCache: boolean;
  importExistingCacheWhenMissing: boolean;
  forceRefreshIgnoreExisting: boolean;
  forceRefreshIgnoreCache: boolean;
  refreshDelayMs: number;
  metadataRestoreTimeoutMinutes: number;
  maxConcurrentExtract: number;
}

export interface StrmToolTurboTaskRun {
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
}

export interface StrmToolTurboTask {
  id: string;
  name: string;
  state: string;
  running: boolean;
  progressPercent: number | null;
  lastRun: StrmToolTurboTaskRun | null;
}

export interface StrmToolTurboStatus {
  installed: boolean;
  version?: string;
  pluginStatus?: string;
  config?: StrmToolTurboConfig;
  task?: StrmToolTurboTask | null;
}

const errorMessage = (err: unknown, fallback: string): string => {
  const message = axios.isAxiosError(err) ? err.response?.data?.error : undefined;
  return typeof message === 'string' ? message : fallback;
};

// Live view of the StrmToolTurbo Jellyfin plugin, read through Youtarr's saved
// Jellyfin connection: install/active status, its settings, and the extraction
// task. While the task runs the hook polls so progress and the final result
// show without a manual refresh.
export const useStrmToolTurbo = (token: string | null) => {
  const [status, setStatus] = useState<StrmToolTurboStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);

  const refresh = useCallback(async (showLoading = true) => {
    if (!token) return;
    if (showLoading) setLoading(true);
    try {
      const res = await axios.get<StrmToolTurboStatus>(ENDPOINT, { headers: { 'x-access-token': token } });
      setStatus(res.data);
      setError(null);
    } catch (err: unknown) {
      setError(errorMessage(err, 'Could not read StrmToolTurbo status from Jellyfin'));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const taskRunning = !!status?.task?.running;
  useEffect(() => {
    if (!taskRunning) return;
    const interval = setInterval(() => refresh(false), RUNNING_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [taskRunning, refresh]);

  const save = useCallback(async (updates: Partial<StrmToolTurboConfig>): Promise<boolean> => {
    if (!token) return false;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await axios.put<{ config: StrmToolTurboConfig }>(`${ENDPOINT}/config`, updates, {
        headers: { 'x-access-token': token },
      });
      setStatus((prev) => (prev ? { ...prev, config: res.data.config } : prev));
      return true;
    } catch (err: unknown) {
      setSaveError(errorMessage(err, 'Failed to save StrmToolTurbo settings'));
      return false;
    } finally {
      setSaving(false);
    }
  }, [token]);

  const run = useCallback(async () => {
    if (!token) return;
    setStarting(true);
    setRunError(null);
    try {
      await axios.post(`${ENDPOINT}/run`, null, { headers: { 'x-access-token': token } });
      // Flip to running immediately so polling starts; the next poll replaces
      // this with Jellyfin's actual task state.
      setStatus((prev) => (prev?.task ? { ...prev, task: { ...prev.task, state: 'Running', running: true } } : prev));
    } catch (err: unknown) {
      setRunError(errorMessage(err, 'Failed to start the extraction task'));
      if (axios.isAxiosError(err) && err.response?.status === 409) refresh(false);
    } finally {
      setStarting(false);
    }
  }, [token, refresh]);

  const stop = useCallback(async () => {
    if (!token) return;
    setStopping(true);
    setStopError(null);
    try {
      await axios.post(`${ENDPOINT}/stop`, null, { headers: { 'x-access-token': token } });
      // Cancellation is asynchronous: show Cancelling now and let polling
      // pick up the final state.
      setStatus((prev) => (prev?.task ? { ...prev, task: { ...prev.task, state: 'Cancelling', running: true } } : prev));
    } catch (err: unknown) {
      setStopError(errorMessage(err, 'Failed to stop the extraction task'));
      if (axios.isAxiosError(err) && err.response?.status === 409) refresh(false);
    } finally {
      setStopping(false);
    }
  }, [token, refresh]);

  return { status, loading, error, saving, saveError, starting, runError, stopping, stopError, refresh, save, run, stop };
};
