import { useCallback, useContext, useEffect, useState } from 'react';
import axios from 'axios';
import WebSocketContext from '../../../contexts/WebSocketContext';

export interface NetworkTuningPreset {
  id: string;
  label: string;
  httpChunkSizeMiB: number;
  concurrentFragments: number;
}

export interface NetworkTuningResult {
  ok: boolean;
  bytes?: number;
  elapsedSeconds?: number;
  throughputMBps?: number;
  error?: string;
  /** Last ~800 chars of this preset's yt-dlp stderr, even on a successful (ok:true) result - a low-throughput preset (e.g. YouTube rate-limiting an overly aggressive combo) often only explains itself via a retry/HTTP-error line here. Null when yt-dlp produced no stderr output. */
  stderrTail?: string | null;
}

/** results[presetId] */
export type NetworkTuningResults = Record<string, NetworkTuningResult>;

export interface NetworkTuningProgress {
  completed: number;
  total: number;
  current?: { presetId: string };
}

interface ProgressPayload {
  running: boolean;
  completed: number;
  total: number;
  current?: { presetId: string };
}

interface UseNetworkTuningBenchmarkReturn {
  testing: boolean;
  progress: NetworkTuningProgress | null;
  results: NetworkTuningResults | null;
  recommended: string | null;
  presets: NetworkTuningPreset[] | null;
  error: string | null;
  runBenchmark: (urlOrId: string) => Promise<void>;
}

/**
 * Drives POST /api/ytdlp/test-network-tuning (server/modules/networkTuningBenchmark.js).
 * Against a user-supplied YouTube URL/video ID, times a real yt-dlp fetch
 * (video bytes discarded, no ffmpeg involved) across a handful of
 * --http-chunk-size/--concurrent-fragments presets and reports measured
 * throughput for each - a different question from useTuningBenchmark's
 * encode-speed test, which never touches the network. Live progress arrives
 * over the same WebSocket broadcast mechanism via the
 * 'networkTuningBenchmarkProgress' message type.
 */
export function useNetworkTuningBenchmark(token: string | null): UseNetworkTuningBenchmarkReturn {
  const [testing, setTesting] = useState(false);
  const [progress, setProgress] = useState<NetworkTuningProgress | null>(null);
  const [results, setResults] = useState<NetworkTuningResults | null>(null);
  const [recommended, setRecommended] = useState<string | null>(null);
  const [presets, setPresets] = useState<NetworkTuningPreset[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ws = useContext(WebSocketContext);

  useEffect(() => {
    if (!ws) return undefined;
    const filter = (msg: { type?: string }) => msg.type === 'networkTuningBenchmarkProgress';
    const callback = (payload: ProgressPayload) => {
      if (payload.running) {
        setProgress({ completed: payload.completed, total: payload.total, current: payload.current });
      }
    };
    ws.subscribe(filter, callback);
    return () => ws.unsubscribe(callback);
  }, [ws]);

  const runBenchmark = useCallback(async (urlOrId: string) => {
    setTesting(true);
    setError(null);
    setProgress({ completed: 0, total: 0 });
    setResults(null);
    setRecommended(null);
    setPresets(null);
    try {
      const response = await axios.post<{
        ok: boolean;
        results?: NetworkTuningResults;
        recommended?: string | null;
        presets?: NetworkTuningPreset[];
        error?: string;
      }>(
        '/api/ytdlp/test-network-tuning',
        { url: urlOrId },
        { headers: { 'x-access-token': token || '' } }
      );
      if (response.data.ok && response.data.results && response.data.presets) {
        setResults(response.data.results);
        setRecommended(response.data.recommended ?? null);
        setPresets(response.data.presets);
      } else {
        setError(response.data.error || 'Network tuning benchmark failed');
      }
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr.response?.data?.error || 'Network tuning benchmark failed; please try again');
    } finally {
      setTesting(false);
      setProgress(null);
    }
  }, [token]);

  return { testing, progress, results, recommended, presets, error, runBenchmark };
}
