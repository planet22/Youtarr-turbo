import { useMaintenanceTaskStatus } from './useMaintenanceTaskStatus';
import { MetadataRegenLastRun } from './useMetadataRegenStatus';

// Response body of POST /api/ytstream/regenerate-stream-key (server/routes/ytstream.js) -
// streamKey is the new value, shown once so it can be hand-verified or used
// to manually author a .strm/URL; it is never persisted client-side or
// retrievable again after this response.
interface RegenerateStreamKeyResponse {
  status: string;
  trigger: string;
  regenerationStarted: boolean;
  streamKey: string;
}

export interface UseStreamKeyRegenStatusReturn {
  running: boolean;
  lastRun: MetadataRegenLastRun | null;
  loading: boolean;
  error: string | null;
  /** Resolves to the new key value on success, or undefined if rotation failed/was refused. */
  triggerRegen: () => Promise<string | undefined>;
}

/**
 * Drives POST /api/ytstream/regenerate-stream-key (server/routes/ytstream.js),
 * which rotates ytstream.streamKey and runs the same job as
 * useMetadataRegenStatus's trigger (videosModule.regenerateVideoMetadataFiles),
 * with alsoRewriteStrmFile set so every .strm file picks up the new key. Same
 * underlying job and status/lastRun shape as metadata regen - only the
 * trigger endpoint differs - so both hooks share one running state: starting
 * either one shows as "running" for both on screen.
 */
export function useStreamKeyRegenStatus(token: string | null): UseStreamKeyRegenStatusReturn {
  const { running, lastRun, loading, error, trigger } = useMaintenanceTaskStatus<
    MetadataRegenLastRun,
    RegenerateStreamKeyResponse
  >(token, {
    statusUrl: '/api/maintenance/regenerate-metadata-status',
    triggerUrl: '/api/ytstream/regenerate-stream-key',
    wsMessageType: 'metadataRegenStatus',
    loadErrorMessage: 'Failed to load stream key regeneration status',
    alreadyRunningMessage: 'A metadata/STRM regeneration is already in progress',
    triggerErrorMessage: 'Failed to rotate the stream key',
  });

  const triggerRegen = async () => {
    const result = await trigger();
    return result?.streamKey;
  };

  return { running, lastRun, loading, error, triggerRegen };
}
