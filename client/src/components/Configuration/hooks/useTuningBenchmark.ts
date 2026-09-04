import { useCallback, useContext, useEffect, useState } from 'react';
import axios from 'axios';
import WebSocketContext from '../../../contexts/WebSocketContext';

export interface TuningBenchmarkResult {
  ok: boolean;
  wallSeconds?: number;
  realtimeFactor?: number;
  realtime?: boolean;
  error?: string;
  /** True when this cell's resolution is above decodeSourceHeight - never
   * actually run (would have silently re-tested a smaller source under a
   * misleading label), not merely a failure. */
  skipped?: boolean;
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
  decodeMode?: string;
}

export interface TuningBenchmarkHistoryEntry {
  hardwareMode: string;
  /** 'none' (software decode) is a real, measured option now, not "decode skipped". */
  decodeMode: string;
  /** Which source codec was simulated - always used now, decodeMode included. */
  sourceCodec: string | null;
  /** ENCODE target codec actually benchmarked - 'h264' unless overridden (see VALID_VIDEO_CODECS server-side; ytstream's real playback always targets h264, hevc/av1 are exploratory only). */
  videoCodec: string;
  /** Height the decode sample was generated at (defaults server-side to the max tested resolution; any row above it is skipped, see TuningBenchmarkResult.skipped). */
  decodeSourceHeight: number | null;
  /** null unless an explicit override was set for this run (hardwareMode=vaapi only). */
  vaapiQuality: number | null;
  matrix: TuningBenchmarkMatrix;
  recommended: TuningRecommendationMap;
  completedAt: string;
}

/** Every run this session, oldest first (newest last) - unlike a single
 * "one entry per hardwareMode, re-testing replaces it" map, this keeps a
 * full log so runs with different decode/vaapiQuality options for the SAME
 * hardwareMode don't clobber each other, and each row can show exactly what
 * options produced it. Session-only (in-memory), resets on page reload. */
export type TuningBenchmarkHistory = TuningBenchmarkHistoryEntry[];

interface ProgressPayload {
  running: boolean;
  hardwareMode: string;
  decodeMode?: string;
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
  /** Decode backend actually used for the current `matrix`/`recommended` ('none' means software decode - still real, still measured). */
  resultDecodeMode: string | null;
  /** Source codec simulated for the current result. */
  resultSourceCodec: string | null;
  /** ENCODE target codec actually benchmarked for the current result ('h264' unless overridden). */
  resultVideoCodec: string | null;
  /** Height the decode sample was actually generated at for the current result. */
  resultDecodeSourceHeight: number | null;
  /** VAAPI -quality override actually used for the current result (post-normalization), or null. */
  resultVaapiQuality: number | null;
  /** Every run this session, for cross-run comparison - see TuningBenchmarkHistory. */
  history: TuningBenchmarkHistory;
  error: string | null;
  /**
   * @param vaapiQuality - VAAPI-only -quality (compression_level) override,
   * 1-7 or null. Ignored server-side for every other hardwareMode.
   * @param decodeMode - hardware DECODE backend to fold into the run
   * ('none' or omit for software decode - a real, measured cost, not a
   * skipped one) - independent of hardwareMode (encode); e.g. software
   * encode + hardware decode is a valid, meaningful combo to test.
   * @param sourceCodec - which source codec to simulate decoding - always
   * used, decodeMode included.
   * @param videoCodec - ENCODE target codec to benchmark ('h264' default -
   * the only one real ytstream playback ever targets; 'hevc'/'av1' are
   * exploratory "what if" tests, independent of sourceCodec).
   * @param decodeSourceHeight - height to generate the decode sample at,
   * overriding the server's default worst-case (the max tested resolution).
   * Any resolution above this is skipped rather than silently re-tested
   * against a too-small source - see TuningBenchmarkResult.skipped.
   * Always pass the current (possibly unsaved) form values, same as
   * hardwareMode - the whole point of this test is measuring exactly what
   * real playback would use.
   */
  runBenchmark: (
    hardwareMode: string,
    vaapiQuality?: number | null,
    decodeMode?: string,
    sourceCodec?: string,
    videoCodec?: string,
    decodeSourceHeight?: number | null
  ) => Promise<void>;
}

/**
 * Drives POST /api/ytdlp/test-tuning-benchmark (server/modules/streamTuningBenchmark.js).
 * Scoped to a single hardwareMode (encode) x decodeMode pair per call - the
 * ones actually selected in Settings, not every possible combo, so this
 * only ever spends time measuring what the host will actually use. For
 * every tuning tier x Stream-quality resolution, runs a real timed ffmpeg
 * encode using ytstream's actual encoder args, reporting whether it ran
 * fast enough to be safe for real-time HLS/live-pipe streaming at that
 * resolution - including real decode cost when a decodeMode is selected.
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
  const [resultDecodeMode, setResultDecodeMode] = useState<string | null>(null);
  const [resultSourceCodec, setResultSourceCodec] = useState<string | null>(null);
  const [resultVideoCodec, setResultVideoCodec] = useState<string | null>(null);
  const [resultDecodeSourceHeight, setResultDecodeSourceHeight] = useState<number | null>(null);
  const [resultVaapiQuality, setResultVaapiQuality] = useState<number | null>(null);
  const [history, setHistory] = useState<TuningBenchmarkHistory>([]);
  const [error, setError] = useState<string | null>(null);

  const ws = useContext(WebSocketContext);

  useEffect(() => {
    if (!ws) return undefined;
    // Filter receives the full message envelope; callback receives only the
    // payload (WebSocketProvider strips the envelope before invoking).
    const filter = (msg: { type?: string }) => msg.type === 'tuningBenchmarkProgress';
    const callback = (payload: ProgressPayload) => {
      if (payload.running) {
        setProgress({ completed: payload.completed, total: payload.total, current: payload.current, decodeMode: payload.decodeMode });
      }
    };
    ws.subscribe(filter, callback);
    return () => ws.unsubscribe(callback);
  }, [ws]);

  const runBenchmark = useCallback(async (
    hardwareMode: string,
    vaapiQuality?: number | null,
    decodeMode?: string,
    sourceCodec?: string,
    videoCodec?: string,
    decodeSourceHeight?: number | null
  ) => {
    setTesting(true);
    setError(null);
    setProgress({ completed: 0, total: 0 });
    // Clear any prior run's results immediately - otherwise the table would
    // keep showing the old (possibly different-options) matrix underneath
    // the live "Testing..." progress overlay until the new response lands,
    // which reads as stale/wrong values sitting next to a running test.
    setMatrix(null);
    setRecommended(null);
    setResultHardwareMode(null);
    setResultDecodeMode(null);
    setResultSourceCodec(null);
    setResultVideoCodec(null);
    setResultDecodeSourceHeight(null);
    setResultVaapiQuality(null);
    try {
      const response = await axios.post<{
        ok: boolean;
        hardwareMode?: string;
        matrix?: TuningBenchmarkMatrix;
        recommended?: TuningRecommendationMap;
        vaapiQuality?: number | null;
        decodeMode?: string;
        sourceCodec?: string | null;
        videoCodec?: string;
        decodeSourceHeight?: number | null;
        error?: string;
      }>(
        '/api/ytdlp/test-tuning-benchmark',
        {
          hardwareMode,
          vaapiQuality: vaapiQuality ?? null,
          decodeMode: decodeMode ?? 'none',
          sourceCodec: sourceCodec ?? 'h264',
          videoCodec: videoCodec ?? 'h264',
          decodeSourceHeight: decodeSourceHeight ?? null,
        },
        { headers: { 'x-access-token': token || '' } }
      );
      if (response.data.ok && response.data.matrix && response.data.recommended) {
        const resolvedHardwareMode = response.data.hardwareMode ?? hardwareMode;
        const resolvedDecodeMode = response.data.decodeMode ?? 'none';
        const resolvedSourceCodec = response.data.sourceCodec ?? null;
        const resolvedVideoCodec = response.data.videoCodec ?? 'h264';
        const resolvedDecodeSourceHeight = response.data.decodeSourceHeight ?? null;
        const resolvedVaapiQuality = response.data.vaapiQuality ?? null;
        setMatrix(response.data.matrix);
        setRecommended(response.data.recommended);
        setResultHardwareMode(resolvedHardwareMode);
        setResultDecodeMode(resolvedDecodeMode);
        setResultSourceCodec(resolvedSourceCodec);
        setResultVideoCodec(resolvedVideoCodec);
        setResultDecodeSourceHeight(resolvedDecodeSourceHeight);
        setResultVaapiQuality(resolvedVaapiQuality);
        setHistory((prev) => [
          ...prev,
          {
            hardwareMode: resolvedHardwareMode,
            decodeMode: resolvedDecodeMode,
            sourceCodec: resolvedSourceCodec,
            videoCodec: resolvedVideoCodec,
            decodeSourceHeight: resolvedDecodeSourceHeight,
            vaapiQuality: resolvedVaapiQuality,
            matrix: response.data.matrix as TuningBenchmarkMatrix,
            recommended: response.data.recommended as TuningRecommendationMap,
            completedAt: new Date().toISOString(),
          },
        ]);
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

  return {
    testing, progress, matrix, recommended,
    resultHardwareMode, resultDecodeMode, resultSourceCodec, resultVideoCodec, resultDecodeSourceHeight, resultVaapiQuality,
    history, error, runBenchmark,
  };
}
