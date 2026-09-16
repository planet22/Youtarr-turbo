import { useMaintenanceTaskStatus } from './useMaintenanceTaskStatus';

export type RescanTrigger = 'manual' | 'scheduled' | 'startup';
export type RescanStatus = 'completed' | 'timed-out' | 'error';

export interface RescanLastRun {
  startedAt: string;
  completedAt: string;
  trigger: RescanTrigger;
  status: RescanStatus;
  videosUpdated: number;
  videosMarkedMissing: number;
  videosScanned: number;
  filesFoundOnDisk: number;
  errorMessage: string | null;
}

export interface UseRescanStatusReturn {
  running: boolean;
  lastRun: RescanLastRun | null;
  loading: boolean;
  error: string | null;
  triggerRescan: () => Promise<void>;
}

export function useRescanStatus(token: string | null): UseRescanStatusReturn {
  const { running, lastRun, loading, error, trigger } = useMaintenanceTaskStatus<RescanLastRun>(token, {
    statusUrl: '/api/maintenance/rescan-status',
    triggerUrl: '/api/maintenance/rescan-files',
    wsMessageType: 'rescanStatus',
    loadErrorMessage: 'Failed to load rescan status',
    alreadyRunningMessage: 'Rescan already in progress',
    triggerErrorMessage: 'Failed to start rescan',
  });

  return { running, lastRun, loading, error, triggerRescan: trigger };
}
