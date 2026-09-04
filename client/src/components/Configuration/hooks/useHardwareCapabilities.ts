import { useCallback, useState } from 'react';
import axios from 'axios';

export interface HardwareCapabilityResult {
  ok: boolean;
  error?: string;
}

export type HardwareCapabilityMatrix = Record<string, Record<string, HardwareCapabilityResult>>;

interface UseHardwareCapabilitiesReturn {
  testing: boolean;
  /** matrix[hardwareMode][videoCodec] - encode capability, unchanged shape. */
  matrix: HardwareCapabilityMatrix | null;
  /** decodeMatrix[decodeMode][sourceCodec] - a separate axis from `matrix`:
   * decode's hardware list has no 'amf' entry, and its codec axis is the
   * SOURCE codec (what a real DASH fetch would serve), not a target choice -
   * see server/modules/hardwareDecodeModule.js. */
  decodeMatrix: HardwareCapabilityMatrix | null;
  error: string | null;
  runTest: () => Promise<void>;
}

export function useHardwareCapabilities(token: string | null): UseHardwareCapabilitiesReturn {
  const [testing, setTesting] = useState(false);
  const [matrix, setMatrix] = useState<HardwareCapabilityMatrix | null>(null);
  const [decodeMatrix, setDecodeMatrix] = useState<HardwareCapabilityMatrix | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runTest = useCallback(async () => {
    setTesting(true);
    setError(null);
    try {
      const response = await axios.post<{
        ok: boolean;
        matrix?: HardwareCapabilityMatrix;
        decodeMatrix?: HardwareCapabilityMatrix;
        error?: string;
      }>(
        '/api/ytdlp/test-hardware-capabilities',
        {},
        { headers: { 'x-access-token': token || '' } }
      );
      if (response.data.ok && response.data.matrix) {
        setMatrix(response.data.matrix);
        setDecodeMatrix(response.data.decodeMatrix || null);
      } else {
        setError(response.data.error || 'Hardware capability test failed');
      }
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr.response?.data?.error || 'Hardware capability test failed; please try again');
    } finally {
      setTesting(false);
    }
  }, [token]);

  return { testing, matrix, decodeMatrix, error, runTest };
}
