import { useCallback, useState } from 'react';
import axios from 'axios';

export interface HardwareCapabilityResult {
  ok: boolean;
  error?: string;
}

export type HardwareCapabilityMatrix = Record<string, Record<string, HardwareCapabilityResult>>;

interface UseHardwareCapabilitiesReturn {
  testing: boolean;
  matrix: HardwareCapabilityMatrix | null;
  error: string | null;
  runTest: () => Promise<void>;
}

export function useHardwareCapabilities(token: string | null): UseHardwareCapabilitiesReturn {
  const [testing, setTesting] = useState(false);
  const [matrix, setMatrix] = useState<HardwareCapabilityMatrix | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runTest = useCallback(async () => {
    setTesting(true);
    setError(null);
    try {
      const response = await axios.post<{ ok: boolean; matrix?: HardwareCapabilityMatrix; error?: string }>(
        '/api/ytdlp/test-hardware-capabilities',
        {},
        { headers: { 'x-access-token': token || '' } }
      );
      if (response.data.ok && response.data.matrix) {
        setMatrix(response.data.matrix);
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

  return { testing, matrix, error, runTest };
}
