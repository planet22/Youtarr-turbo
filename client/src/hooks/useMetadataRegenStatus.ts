import { useMaintenanceTaskStatus } from './useMaintenanceTaskStatus';

export type MetadataRegenTrigger = 'manual';
export type MetadataRegenStatus = 'completed' | 'timed-out' | 'error';

export interface MetadataRegenLastRun {
  startedAt: string;
  completedAt: string;
  trigger: MetadataRegenTrigger;
  status: MetadataRegenStatus;
  scanned: number;
  regenerated: number;
  skippedNoCache: number;
  skippedNoFile: number;
  errors: number;
  /** Count of STRM videos whose .strmtool.json sidecar was rewritten (full rebuild, or a stale container patched). */
  strmToolRegenerated: number;
  /**
   * Count of STRM videos with no cached metadata (folded into skippedNoCache)
   * whose EXISTING .strmtool.json was still checked and found to already
   * have the correct container - not left untouched, just nothing to write.
   * Without this, skippedNoCache alone reads as "nothing happened" for
   * these videos, which isn't true.
   */
  strmToolAlreadyCorrect: number;
  errorMessage?: string | null;
}

export interface UseMetadataRegenStatusReturn {
  running: boolean;
  lastRun: MetadataRegenLastRun | null;
  loading: boolean;
  error: string | null;
  triggerRegen: () => Promise<void>;
}

/**
 * Drives POST /api/maintenance/regenerate-metadata (server/routes/maintenance.js),
 * which fully rewrites every already-downloaded/STRM'd video's .nfo file (and,
 * for STRM videos, its .strmtool.json sidecar - see strmMediaInfoCache.js)
 * from its cached .info.json. Mirrors useResolutionTagBackfillStatus's shape.
 */
export function useMetadataRegenStatus(token: string | null): UseMetadataRegenStatusReturn {
  const { running, lastRun, loading, error, trigger } = useMaintenanceTaskStatus<MetadataRegenLastRun>(token, {
    statusUrl: '/api/maintenance/regenerate-metadata-status',
    triggerUrl: '/api/maintenance/regenerate-metadata',
    wsMessageType: 'metadataRegenStatus',
    loadErrorMessage: 'Failed to load metadata regeneration status',
    alreadyRunningMessage: 'Metadata regeneration already in progress',
    triggerErrorMessage: 'Failed to start metadata regeneration',
  });

  return { running, lastRun, loading, error, triggerRegen: trigger };
}
