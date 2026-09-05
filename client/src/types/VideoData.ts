/*export interface VideoData {
  youtubeId: string;
  youTubeChannelName: string;
  youTubeVideoName: string;
  duration: number;
}*/

export interface VideoData {
  // null for a "Show untracked" row - a video with no Videos table row at
  // all, surfaced only via youtube_metadata_cache and/or the untracked
  // buffer cache directory. See isTracked.
  id: number | null;
  youtubeId: string;
  youTubeChannelName: string;
  youTubeVideoName: string;
  timeCreated: string;
  originalDate: string | null;
  duration: number | null;
  description: string | null;
  filePath?: string | null;
  fileSize?: string | null;
  audioFilePath?: string | null;
  audioFileSize?: string | null;
  removed?: boolean;
  youtube_removed?: boolean;
  channel_id?: string | null;
  media_type?: string;
  normalized_rating?: string | null;
  rating_source?: string | null;
  protected?: boolean;
  // Actual downloaded pixel dimensions, e.g. "1920x1080"; "0x0" = probe failed
  video_resolution?: string | null;
  watchedBy?: string[];
  // True when filePath points at a .strm stream shortcut instead of downloaded media.
  is_strm?: boolean;
  // True when this row has a real Videos table entry (the library "tracked"
  // sense) - false for a "Show untracked" cache-only row (id is then null).
  isTracked?: boolean;
  // STRM cache-on-play materialization timestamp (Videos.cached_at) -
  // present only for a tracked video that was opportunistically cached.
  cached_at?: string | null;
  // Whether a youtube_metadata_cache row exists for this video (tracked or
  // not) - drives the Library page's "Cached Metadata" icon.
  hasCachedMetadata?: boolean;
  cachedMetadataAt?: string | null;
  // Pre-formatted "5h 4m ago" text (server/modules/relativeTimeFormatter.js)
  // - prefer this for display over computing relative time from
  // cachedMetadataAt, so a wording change only has to happen server-side.
  cachedMetadataAgo?: string | null;
  cachedMetadataExpiresAt?: string | null;
  // Whether a cached video file exists for this row - the STRM cache-on-play
  // file for a tracked row, or the untracked hls-buffer cache file for an
  // untracked one - drives the Library page's "Cached Video" icon.
  hasCachedVideo?: boolean;
  cachedVideoAt?: string | null;
  cachedVideoAgo?: string | null;
  cachedVideoExpiresAt?: string | null;
}

export interface EnabledChannel {
  channel_id: string;
  uploader: string;
}

export interface PaginatedVideosResponse {
  videos: VideoData[];
  total: number;
  page: number;
  totalPages: number;
  channels: string[];
  enabledChannels: EnabledChannel[];
  // True when the "Show untracked" bucket was truncated to its cap - see
  // videosModule.js's UNTRACKED_BUCKET_CAP.
  untrackedScopeLimited?: boolean;
}
