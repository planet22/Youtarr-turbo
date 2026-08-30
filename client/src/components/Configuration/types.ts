// Import ConfigState from centralized schema
import type { ConfigState } from '../../config/configSchema';

// Re-export for convenience
export type { ConfigState };

export type SettingsSectionGroup = 'general' | 'integrations' | 'downloads' | 'advanced' | 'security';

export interface AutoRemovalDryRunVideoSummary {
  id: number;
  youtubeId: string;
  title: string;
  channel: string;
  fileSize: number;
  timeCreated: string | null;
}

export interface AutoRemovalDryRunPlanStrategy {
  enabled: boolean;
  thresholdDays?: number | null;
  threshold?: string | null;
  thresholdBytes?: number | null;
  minDaysSinceWatched?: number | null;
  minVideoAgeDays?: number | null;
  skippedReason?: string | null;
  candidateCount: number;
  estimatedFreedBytes: number;
  deletedCount: number;
  failedCount: number;
  needsCleanup?: boolean;
  iterations?: number;
  storageStatus?: {
    availableGB: string;
    totalGB: string;
    percentFree: number;
    percentUsed: number;
  } | null;
  sampleVideos: AutoRemovalDryRunVideoSummary[];
}

export interface AutoRemovalDryRunResult {
  dryRun: boolean;
  success: boolean;
  errors: string[];
  plan: {
    ageStrategy: AutoRemovalDryRunPlanStrategy;
    watchedStrategy?: AutoRemovalDryRunPlanStrategy;
    keepRecent?: {
      count: number;
      protectedCount: number;
    };
    channelKeepRecent?: {
      channelCount: number;
      protectedCount: number;
    };
    spaceStrategy: AutoRemovalDryRunPlanStrategy;
  };
  simulationTotals: {
    byAge: number;
    byWatched?: number;
    bySpace: number;
    total: number;
    estimatedFreedBytes: number;
  } | null;
}

// Mirrors resolvePlaybackPlan()'s return shape and the GET
// /api/ytstream/:youtubeId/simulate route's JSON envelope - see
// server/routes/ytstream.js.
export interface YtstreamDryRunStep {
  step: string;
  detail: string;
  probed: boolean;
}

export interface YtstreamDryRunProbeShortcut {
  wouldFire: boolean;
  reason: string;
  isMetadataProbe: boolean;
  transcode: string;
}

export interface YtstreamDryRunPlan {
  mode: 'direct' | 'ffmpeg' | 'hls';
  requestedMode: string;
  ffmpegAvailable: boolean;
  container: string;
  transcode: string;
  hardwareMode: string;
  tuning: string;
  requestedQuality: string;
  quality: string;
  qualityCapped: boolean;
  seekSeconds: number | null;
  calculatedLength: boolean;
  hotSwapToCache: boolean;
  forceServerSettings: boolean;
  ignoredQueryParams: string[];
  probeShortcut: YtstreamDryRunProbeShortcut;
  steps: YtstreamDryRunStep[];
}

export interface YtstreamDryRunResult {
  youtubeId: string;
  probed: boolean;
  plan: YtstreamDryRunPlan;
  formatSelectors: Record<string, string>;
  hls: { sessionKey: string; sessionAlreadyActive: boolean } | null;
  wouldCall: string;
}

export interface SponsorBlockCategories {
  sponsor: boolean;
  intro: boolean;
  outro: boolean;
  selfpromo: boolean;
  preview: boolean;
  filler: boolean;
  interaction: boolean;
  music_offtopic: boolean;
}

export interface PlatformManagedState {
  plexUrl: boolean;
  authEnabled: boolean;
  useTmpForDownloads: boolean;
  ytdlpUpdates: boolean;
}

export interface DeploymentEnvironment {
  platform?: string | null;
  isWsl: boolean;
}

export interface CookieStatus {
  cookiesEnabled: boolean;
  customCookiesUploaded: boolean;
  customFileExists: boolean;
}

export interface SnackbarState {
  open: boolean;
  message: string;
  severity: 'success' | 'error' | 'warning' | 'info';
}

export type PlexConnectionStatus = 'connected' | 'not_connected' | 'not_tested' | 'testing';

export type YouTubeApiKeyStatus =
  | 'not_tested'
  | 'testing'
  | 'valid'
  | 'invalid'
  | 'quota_exhausted'
  | 'rate_limited'
  | 'api_not_enabled'
  | 'key_restricted'
  | 'network_error';

export interface YouTubeApiKeyTestResult {
  ok: boolean;
  code?: string;
  reason?: string;
}
