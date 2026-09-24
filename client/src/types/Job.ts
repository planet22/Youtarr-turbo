import { VideoData } from './VideoData';

export interface FailedVideo {
  youtubeId: string;
  title?: string;
  channel?: string;
  error: string;
  url?: string | null;
  autoRetryQueued?: boolean;
  diagnosisKey?: string;
}

export interface DownloadDiagnosis {
  key: string;
  title: string;
  message: string;
  count: number;
}

export interface TerminatedChannelInfo {
  channelId: string;
  uploader?: string | null;
  url?: string | null;
  terminatedAt?: string | null;
}

export interface Job {
  jobType: string;
  status: string;
  output: string;
  timeCreated: number;
  timeInitiated: number;
  id: string;
  data: {
    videos: VideoData[];
    failedVideos?: FailedVideo[];
    diagnoses?: DownloadDiagnosis[];
    nzb?: {
      categoryName?: string;
      youtubeId?: string;
      nzbName?: string;
      importStrategy?: 'hardlink' | 'untracked';
      // Set once Sonarr/Radarr imported the file and Youtarr dropped its own copy.
      untracked?: boolean;
      // Server-computed, display-only summary of this NZB grab's real
      // post-download lifecycle (queued for Sonarr/Radarr import, imported,
      // removed from Sonarr/Radarr's own history, etc.) - see
      // server/routes/nzb.js's computeNzbStatusDetail. Distinct from the
      // job's own `status` field (which stays a plain SABnzbd-style string
      // like 'Complete'/'Deleted' for protocol/filter purposes); when
      // present, the UI should prefer this over the raw status text.
      statusDetail?: string;
    };
    // Advisory explanation for the terminal status (e.g. cookie/bot-detection
    // guidance, a manual/timeout termination reason, or a terminated-channel
    // count) - not always present, since a plain success has nothing to add.
    notes?: string;
    errorCode?: string;
    // ISO timestamp of when the finalizer persisted the terminal status;
    // paired with timeInitiated to show how long a completed job ran for.
    endDate?: string;
    // Already-downloaded videos this job's yt-dlp run skipped, accumulated
    // across all groups for multi-channel jobs.
    cumulativeSkipped?: number;
    terminatedChannels?: TerminatedChannelInfo[];
    terminationFailures?: string[];
    // Determines start order among Pending jobs (ascending) - see
    // JobQueueTable.tsx and server/modules/jobModule.js's startNextJob.
    queueOrder?: number;
    urls?: string[];
    groups?: Array<{ channels?: Array<{ uploader?: string | null; channel_id?: string | null }> }>;
    autoRetryAttempt?: number;
    // STRM materialize fetches metadata one video at a time (one yt-dlp call
    // per video, not one batch call), so unlike a regular download its
    // active-job loop can genuinely be paused/reordered - see
    // strmMaterializer.js's pauseActiveJob/setActiveJobRemainingUrls and the
    // /api/jobs/:jobId/strm/* routes. isStrmBatch marks a job as eligible for
    // those live controls; strmPaused mirrors the live pause state.
    isStrmBatch?: boolean;
    strmPaused?: boolean;
    // Cross-links between an HLS Buffer Cache fetch and the separate
    // "HLS Buffer Cache Finalize" job recorded once its hidden .ts is
    // remuxed to .mp4 - see ytstreamTapFinalizer.js's recordTsToMp4Finalize.
    // Only one of the two is ever set on a given job.
    finalizeOfJobId?: string;
    finalizedByJobId?: string;
  };
}
