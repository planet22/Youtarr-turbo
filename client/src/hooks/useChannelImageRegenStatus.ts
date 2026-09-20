import { useMaintenanceTaskStatus } from './useMaintenanceTaskStatus';

export type ChannelImageRegenTrigger = 'manual';
export type ChannelImageRegenRunStatus = 'completed' | 'error';

export interface ChannelImageRegenLastRun {
  startedAt: string;
  completedAt: string;
  trigger: ChannelImageRegenTrigger;
  status: ChannelImageRegenRunStatus;
  channelsScanned?: number;
  copied?: number;
  skippedNoSource?: number;
  skippedNoFolder?: number;
  errors?: number;
  videoThumbsCopied?: number;
  videoThumbsDownloaded?: number;
  videoThumbsSkipped?: number;
  videoThumbsErrors?: number;
  errorMessage?: string | null;
}

export interface UseChannelImageRegenStatusReturn {
  running: boolean;
  lastRun: ChannelImageRegenLastRun | null;
  loading: boolean;
  error: string | null;
  triggerRegen: () => Promise<void>;
}

/**
 * Drives POST /api/maintenance/regenerate-channel-images (server/routes/maintenance.js),
 * which force re-copies poster/logo/backdrop/banner images for every
 * enabled channel, overwriting existing files - unlike the automatic
 * backfill (which only fills in missing images and so can never repair an
 * existing-but-broken one). Also fills in any video/episode's own missing
 * library-adjacent thumbnail (what its NFO's <thumb> tag references) -
 * "fill in if missing" semantics there, not force-overwrite, since a
 * missing thumbnail means it was never written, not that an existing file
 * has stale permissions. Mirrors useResolutionTagBackfillStatus's shape.
 */
export function useChannelImageRegenStatus(token: string | null): UseChannelImageRegenStatusReturn {
  const { running, lastRun, loading, error, trigger } = useMaintenanceTaskStatus<ChannelImageRegenLastRun>(token, {
    statusUrl: '/api/maintenance/regenerate-channel-images-status',
    triggerUrl: '/api/maintenance/regenerate-channel-images',
    wsMessageType: 'channelImageRegenStatus',
    loadErrorMessage: 'Failed to load channel image regeneration status',
    alreadyRunningMessage: 'Channel image regeneration already in progress',
    triggerErrorMessage: 'Failed to start channel image regeneration',
  });

  return { running, lastRun, loading, error, triggerRegen: trigger };
}
