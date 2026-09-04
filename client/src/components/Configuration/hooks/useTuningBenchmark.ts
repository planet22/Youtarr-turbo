import { useCallback, useContext, useEffect, useState } from 'react';
import axios from 'axios';
import WebSocketContext from '../../../contexts/WebSocketContext';

export interface TuningBenchmarkResult {
  ok: boolean;
  wallSeconds?: number;
  realtimeFactor?: number;
  realtime?: boolean;
  error?: string;
}

/** matrix[height][tuning] - scoped server-side to one hardwareMode per run, see resultHardwareMode. */
export type TuningBenchmarkMatrix = Record<string, Record<string, TuningBenchmarkResult>>;
/** recommended[height] -> tuning tier id, or null if every tier failed outright */
export type TuningRecommendationMap = Record<string, string | null>;

export interface TuningBenchmarkProgress {
  completed: number;
  total: number;
  /** `warmup: true` marks the one discarded priming encode run before the
   * real matrix starts (see streamTuningBenchmark.js) - not one of the
   * measured combos, so it never advances `completed`. */
  current?: { tuning: string; height: number; warmup?: boolean };
}

export interface TuningBenchmarkHistoryEntry {
  hardwareMode: string;
  matrix: TuningBenchmarkMatrix;
  recommended: TuningRecommendationMap;
  completedAt: string;
}

/** One entry per hardwareMode tested this session (re-testing an encoder replaces its entry), so different encoders' results can be compared side by side even though the main table only shows one at a time. */
export type TuningBenchmarkHistory = Record<string, TuningBenchmarkHistoryEntry>;

interface ProgressPayload {
  running: boolean;
  hardwareMode: string;
  completed: number;
  total: number;
  current?: { tuning: string; height: number; warmup?: boolean };
}

interface UseTuningBenchmarkReturn {
  testing: boolean;
  progress: TuningBenchmarkProgress | null;
  matrix: TuningBenchmarkMatrix | null;
  recommended: TuningRecommendationMap | null;
  /** Which hardwareMode `matrix`/`recommended` were measured for - compare against the
   * currently-selected encoder to detect stale results (e.g. after switching encoders). */
  resultHardwareMode: string | null;
  /** Every encoder tested so far this session, for cross-encoder comparison - see TuningBenchmarkHistory. */
  history: TuningBenchmarkHistory;
  error: string | null;
  /**
   * @param vaapiQuality - VAAPI-only -quality (compression_level) override,
   * 1-7 or null. Ignored server-side for every other hardwareMode. Always
   * pass the current (possibly unsaved) form value, same as hardwareMode -
   * the whole point of this test is measuring exactly what real playback
   * would use.
   */
  runBenchmark: (hardwareMode: string, vaapiQuality?: number | null) => Promise<void>;
}

/**
 * Drives POST /api/ytdlp/test-tuning-benchmark (server/modules/streamTuningBenchmark.js).
 * Scoped to a single hardwareMode per call - the one actually selected in
 * Settings, not every possible encoder, so this only ever spends time
 * measuring an encoder the host will actually use. For every tuning tier x
 * Stream-quality resolution, runs a real timed ffmpeg encode using
 * ytstream's actual encoder args, reporting whether it ran fast enough to
 * be safe for real-time HLS/live-pipe streaming at that resolution.
 *
 * Live progress arrives over the same WebSocket broadcast mechanism used
 * elsewhere (streamProgress, channelImageRegenStatus) via the
 * 'tuningBenchmarkProgress' message type, so the UI can show real "X/Y"
 * progress instead of a static "this can take a while" message.
 */
export function useTuningBenchmark(token: string | null): UseTuningBenchmarkReturn {
  const [testing, setTesting] = useState(false);
  const [progress, setProgress] = useState<TuningBenchmarkProgress | null>(null);
  const [matrix, setMatrix] = useState<TuningBenchmarkMatrix | null>(null);
  const [recommended, setRecommended] = useState<TuningRecommendationMap | null>(null);
  const [resultHardwareMode, setResultHardwareMode] = useState<string | null>(null);
  const [history, setHistory] = useState<TuningBenchmarkHistory>({});
  const [error, setError] = useState<string | null>(null);

  const ws = useContext(WebSocketContext);

  useEffect(() => {
    if (!ws) return undefined;
    // Filter receives the full message envelope; callback receives only the
    // payload (WebSocketProvider strips the envelope before invoking).
    const filter = (msg: { type?: string }) => msg.type === 'tuningBenchmarkProgress';
    const callback = (payload: ProgressPayload) => {
      if (payload.running) {
        setProgress({ completed: payload.completed, total: payload.total, current: payload.current });
      }
    };
    ws.subscribe(filter, callback);
    return () => ws.unsubscribe(callback);
  }, [ws]);

  const runBenchmark = useCallback(async (hardwareMode: string, vaapiQuality?: number | null) => {
    setTesting(true);
    setError(null);
    setProgress({ completed: 0, total: 0 });
    // Clear any prior run's results immediately - otherwise the table would
    // keep showing the old (possibly different-encoder) matrix underneath
    // the live "Testing..." progress overlay until the new response lands,
    // which reads as stale/wrong values sitting next to a running test.
    setMatrix(null);
    setRecommended(null);
    setResultHardwareMode(null);
    try {
      const response = await axios.post<{
        ok: boolean;
        hardwareMode?: string;
        matrix?: TuningBenchmarkMatrix;
        recommended?: TuningRecommendationMap;
        error?: string;
      }>(
        '/api/ytdlp/test-tuning-benchmark',
        { hardwareMode, vaapiQuality: vaapiQuality ?? null },
        { headers: { 'x-access-token': token || '' } }
      );
      if (response.data.ok && response.data.matrix && response.data.recommended) {
        const resolvedHardwareMode = response.data.hardwareMode ?? hardwareMode;
        setMatrix(response.data.matrix);
        setRecommended(response.data.recommended);
        setResultHardwareMode(resolvedHardwareMode);
        setHistory((prev) => ({
          ...prev,
          [resolvedHardwareMode]: {
            hardwareMode: resolvedHardwareMode,
            matrix: response.data.matrix as TuningBenchmarkMatrix,
            recommended: response.data.recommended as TuningRecommendationMap,
            completedAt: new Date().toISOString(),
          },
        }));
      } else {
        setError(response.data.error || 'Encoding tuning benchmark failed');
      }
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr.response?.data?.error || 'Encoding tuning benchmark failed; please try again');
    } finally {
      setTesting(false);
      setProgress(null);
    }
  }, [token]);

  return { testing, progress, matrix, recommended, resultHardwareMode, history, error, runBenchmark };
}
