import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';

/** mkv sessions only: the clusters read from the file and the sizes needed for a 0-100% readout. */
export interface MkvProgressDetail {
  durationSeconds: number | null;
  declaredTotalBytes: number | null;
  encodedSeconds: number | null;
  clusterStartsMs: number[];
  clusterBytes: number[];
  cachedBytes: number;
  resumeSeamMs: number | null;
  resumeState: 'pending' | 'ok' | 'mismatch' | null;
}

export interface ByteRangeProgress {
  container?: 'mkv' | 'mp4';
  mkv?: MkvProgressDetail;
  sessionKey: string;
  youtubeId: string;
  deliverAsFile: boolean;
  currentSizeBytes: number | null;
  elapsedMs: number;
  ytVideoExitCode: number | null;
  ytAudioExitCode: number | null;
  ffExitCode: number | null;
  failed: boolean;
  failReason: string | null;
  complete: boolean;
}

const POLL_INTERVAL_MS = 1500;
const HISTORY_SAMPLES = 6;

/**
 * Polls the byte-range progress endpoint (server/routes/ytstream.js ->
 * byteRangeHlsMode.js's getSessionProgress) only while `enabled` (the
 * popup is open) - there's no WebSocket feed for this experimental mode,
 * unlike hls/hls-buffer's segment status, so this is a small standalone
 * REST poll rather than extending activeStreams.js's existing broadcast.
 * bytesPerSecond is derived client-side from consecutive samples rather
 * than asking the server to track a rate.
 */
export function useByteRangeProgress(youtubeId: string, sessionKey: string, token: string | null, enabled: boolean) {
  const [progress, setProgress] = useState<ByteRangeProgress | null>(null);
  const [history, setHistory] = useState<{ t: number; size: number }[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setProgress(null);
      setHistory([]);
      setError(null);
      return undefined;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await axios.get<ByteRangeProgress>(
          `/api/ytstream/${encodeURIComponent(youtubeId)}/byterange-hls/${sessionKey}/progress`,
          { headers: { 'x-access-token': token || '' } }
        );
        if (cancelled) return;
        setProgress(res.data);
        setError(null);
        setHistory((prev) => [...prev, { t: Date.now(), size: res.data.currentSizeBytes || 0 }].slice(-HISTORY_SAMPLES));
      } catch (err: unknown) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load progress');
      }
    };
    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [enabled, youtubeId, sessionKey, token]);

  const bytesPerSecond = useMemo(() => {
    if (history.length < 2) return null;
    const oldest = history[0];
    const newest = history[history.length - 1];
    const deltaMs = newest.t - oldest.t;
    if (deltaMs <= 0) return null;
    return ((newest.size - oldest.size) / deltaMs) * 1000;
  }, [history]);

  return { progress, bytesPerSecond, error };
}
