import { useCallback, useState } from 'react';
import axios from 'axios';

export interface SegmentTimingTestResult {
  hardwareMode: string;
  /** Persisted result - whether config.ytstream.forceKeyframesByHardwareMode[hardwareMode] is now true. */
  enabled: boolean;
  measuredSeconds?: number[];
  averageSeconds?: number;
  maxDeviationSeconds?: number;
  error?: string;
}

interface UseSegmentTimingTestReturn {
  testing: boolean;
  result: SegmentTimingTestResult | null;
  error: string | null;
  /** @param vaapiQuality - see useTuningBenchmark's own doc comment; VAAPI-only, ignored for every other hardwareMode. */
  runTest: (hardwareMode: string, vaapiQuality?: number | null) => Promise<void>;
}

/**
 * Drives POST /api/ytdlp/test-segment-timing (server/modules/streamTuningBenchmark.js's
 * testSegmentTiming). Runs a real short HLS encode of a deliberately
 * non-30fps synthetic source through the candidate time-based
 * forced-keyframe args for one hardware encoder, and reports whether real
 * segments actually landed at ~4.000s on this host. Unlike
 * useTuningBenchmark (a speed check, session-only), the result here is a
 * correctness verdict that the server itself persists into
 * config.ytstream.forceKeyframesByHardwareMode[hardwareMode] - this hook's
 * `result.enabled` just reflects what the server already decided, not a
 * separate client-side toggle.
 */
export function useSegmentTimingTest(token: string | null): UseSegmentTimingTestReturn {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<SegmentTimingTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runTest = useCallback(async (hardwareMode: string, vaapiQuality?: number | null) => {
    setTesting(true);
    setError(null);
    setResult(null);
    try {
      const response = await axios.post<{ ok: boolean } & SegmentTimingTestResult>(
        '/api/ytdlp/test-segment-timing',
        { hardwareMode, vaapiQuality: vaapiQuality ?? null },
        { headers: { 'x-access-token': token || '' } }
      );
      if (response.data.ok) {
        setResult(response.data);
      } else {
        setError((response.data as unknown as { error?: string }).error || 'HLS segment timing test failed');
      }
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr.response?.data?.error || 'HLS segment timing test failed; please try again');
    } finally {
      setTesting(false);
    }
  }, [token]);

  return { testing, result, error, runTest };
}
