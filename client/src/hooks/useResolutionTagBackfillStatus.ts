import { useMaintenanceTaskStatus } from './useMaintenanceTaskStatus';

export type ResolutionTagBackfillTrigger = 'manual';
export type ResolutionTagBackfillStatus = 'completed' | 'timed-out' | 'error';

export interface ResolutionTagBackfillLastRun {
  startedAt: string;
  completedAt: string;
  trigger: ResolutionTagBackfillTrigger;
  status: ResolutionTagBackfillStatus;
  scanned: number;
  tagged: number;
  skippedNoCache: number;
  skippedNoNfo: number;
  errors: number;
  errorMessage?: string | null;
}

export interface UseResolutionTagBackfillStatusReturn {
  running: boolean;
  lastRun: ResolutionTagBackfillLastRun | null;
  loading: boolean;
  error: string | null;
  triggerBackfill: () => Promise<void>;
}

export function useResolutionTagBackfillStatus(token: string | null): UseResolutionTagBackfillStatusReturn {
  const { running, lastRun, loading, error, trigger } = useMaintenanceTaskStatus<ResolutionTagBackfillLastRun>(token, {
    statusUrl: '/api/maintenance/backfill-resolution-tags-status',
    triggerUrl: '/api/maintenance/backfill-resolution-tags',
    wsMessageType: 'resolutionTagBackfillStatus',
    loadErrorMessage: 'Failed to load resolution tag backfill status',
    alreadyRunningMessage: 'Resolution tag backfill already in progress',
    triggerErrorMessage: 'Failed to start resolution tag backfill',
  });

  return { running, lastRun, loading, error, triggerBackfill: trigger };
}
