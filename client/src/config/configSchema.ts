/**
 * Central configuration schema - single source of truth for all config fields
 *
 * This file defines:
 * - Default values for all configuration fields
 * - Which fields should be tracked for "unsaved changes" detection
 * - TypeScript types derived from the schema
 *
 * When adding a new config field:
 * 1. Add it to CONFIG_FIELDS with its default value and trackChanges setting
 * 2. Add it to DEFAULT_CONFIG (TypeScript will enforce this)
 * 3. ConfigState type and TRACKABLE_CONFIG_KEYS are automatically derived
 */

import { SponsorBlockCategories } from '../components/Configuration/types';

/**
 * Configuration field registry
 * Each field defines its default value and whether changes should be tracked
 */
export const CONFIG_FIELDS = {
  // Channel settings
  // Defaults must match config/config.example.json: useConfig fills missing
  // server fields from here and save POSTs the full object back.
  // Enforced by configSchemaAlignment.test.ts.
  channelAutoDownload: { default: false, trackChanges: true },
  channelDownloadFrequency: { default: '0 * * * *', trackChanges: true },
  channelFilesToDownload: { default: 5, trackChanges: true },

  // Video settings
  preferredResolution: { default: '1080', trackChanges: true },
  videoCodec: { default: 'default', trackChanges: true },

  // Post-download transcode (server/modules/hardwareEncoderModule.js,
  // applied in videoDownloadPostProcessFiles.js) - distinct from videoCodec
  // above, which only influences which existing YouTube stream yt-dlp
  // selects. This instead re-encodes the already-downloaded file with
  // ffmpeg, so it can convert to a codec YouTube doesn't serve directly
  // (e.g. HEVC) or to a smaller AV1 file, using the same hardware-encoder
  // backends as STRM playback transcoding when available.
  downloadTranscodeVideoCodec: { default: 'off' as 'off' | 'h264' | 'hevc' | 'av1', trackChanges: true },
  downloadTranscodeHardwareMode: { default: 'none' as 'none' | 'qsv' | 'nvenc' | 'vaapi' | 'amf', trackChanges: true },
  downloadTranscodeAudioCodec: { default: 'copy' as 'copy' | 'aac' | 'opus', trackChanges: true },
  defaultSubfolder: { default: '', trackChanges: true },
  defaultSkipVideoFolder: { default: false, trackChanges: true },
  videoFilenamePrefix: {
    default: '%(uploader,channel,uploader_id).80B - %(title).64B',
    trackChanges: true,
  },
  defaultLibraryMode: { default: 'movie' as 'movie' | 'series', trackChanges: true },
  episodeFilenamePrefix: {
    // Season zero-padded to 2 digits (%(season)02d) same as episode - see
    // server/modules/filesystem/constants.js's DEFAULT_EPISODE_FILENAME_PREFIX.
    default: 'S%(season)02dE%(episode)03d - %(title).64s',
    trackChanges: true,
  },
  seriesOutputSubfolder: { default: '', trackChanges: true },

  // Plex integration
  plexApiKey: { default: '', trackChanges: true },
  plexYoutubeLibraryId: { default: '', trackChanges: true },
  plexSubfolderLibraryMappings: {
    default: [] as Array<{ subfolder: string | null; libraryId: string }>,
    trackChanges: true,
  },
  plexIP: { default: '', trackChanges: true },
  plexPort: { default: '32400', trackChanges: true },
  plexViaHttps: { default: false, trackChanges: true },
  plexPlaylistToken: { default: '', trackChanges: true },

  // Jellyfin integration
  jellyfinEnabled: { default: false, trackChanges: true },
  jellyfinUrl: { default: '', trackChanges: true },
  jellyfinApiKey: { default: '', trackChanges: true },
  jellyfinUserId: { default: '', trackChanges: true },
  jellyfinVideoLibraryIds: { default: [] as string[], trackChanges: true },
  jellyfinSubfolderLibraryMappings: {
    default: [] as Array<{ subfolder: string | null; libraryId: string }>,
    trackChanges: true,
  },

  // Emby integration
  embyEnabled: { default: false, trackChanges: true },
  embyUrl: { default: '', trackChanges: true },
  embyApiKey: { default: '', trackChanges: true },
  embyUserId: { default: '', trackChanges: true },
  embyVideoLibraryIds: { default: [] as string[], trackChanges: true },

  // Media server watch status sync
  watchStatusSyncEnabled: { default: true, trackChanges: true },
  watchStatusSyncFrequency: { default: '0 */4 * * *', trackChanges: true },
  plexWatchStatusAllUsers: { default: true, trackChanges: true },
  jellyfinWatchStatusAllUsers: { default: true, trackChanges: true },
  embyWatchStatusAllUsers: { default: true, trackChanges: true },
  watchStatusWatchedRule: { default: 'any' as 'any' | 'primary', trackChanges: true },

  // YouTube Data API
  youtubeApiKey: { default: '', trackChanges: true },

  // SponsorBlock
  sponsorblockEnabled: { default: false, trackChanges: true },
  sponsorblockAction: { default: 'remove' as 'remove' | 'mark', trackChanges: true },
  sponsorblockCategories: {
    default: {
      sponsor: true,
      intro: false,
      outro: false,
      selfpromo: true,
      preview: false,
      filler: false,
      interaction: false,
      music_offtopic: false,
    } as SponsorBlockCategories,
    trackChanges: true
  },
  sponsorblockApiUrl: { default: '', trackChanges: true },

  // Download performance
  downloadSocketTimeoutSeconds: { default: 30, trackChanges: true },
  downloadThrottledRate: { default: '100K', trackChanges: true },
  downloadRetryCount: { default: 2, trackChanges: true },
  downloadAutoRetryCount: { default: 1, trackChanges: true },
  enableStallDetection: { default: true, trackChanges: true },
  stallDetectionWindowSeconds: { default: 30, trackChanges: true },
  stallDetectionRateThreshold: { default: '100K', trackChanges: true },

  // Advanced settings
  sleepRequests: { default: 1, trackChanges: true },
  proxy: { default: '', trackChanges: true },

  // Logging - empty string = use the LOG_LEVEL environment variable's value
  // (documented in docs/ENVIRONMENT_VARIABLES.md) as the startup default;
  // an explicit value here overrides it and takes effect immediately, live,
  // no restart needed (server/logger.js's level is mutable at runtime) -
  // see server/modules/configModule.js's config-save handler.
  logLevel: { default: '' as '' | 'warn' | 'info' | 'debug', trackChanges: true },

  // Cookies
  cookiesEnabled: { default: false, trackChanges: true },
  customCookiesUploaded: { default: false, trackChanges: true },

  // Kodi compatibility
  writeChannelPosters: { default: true, trackChanges: true },
  writeVideoNfoFiles: { default: true, trackChanges: true },
  writeVideoFanart: { default: false, trackChanges: true },
  writeBackdropImages: { default: false, trackChanges: true },

  // STRM / stream-only library items
  mediaMode: { default: 'download' as 'download' | 'strm' | 'both', trackChanges: true },
  strm: {
    default: {
      target: 'ytstream' as 'youtube' | 'ytstream',
      proxyBaseUrl: '',
      writeNfo: true,
      writeThumbnail: true,
      writeMediaInfoCache: true,
      cacheOnPlay: false,
      // Hours after a STRM cache-on-play download finishes before the
      // nightly sweep (cronJobs.js, 2:10 AM) reverts it back to STRM,
      // freeing the disk space - null/0 = never auto-revert. Only ever
      // applies to a video cache-on-play itself materialized (server's
      // videoPersistence.js sets cached_at only for that transition) - a
      // genuine/forced download is never a candidate, regardless of this
      // setting.
      cacheOnPlayExpiryHours: null as number | null,
      quality: null as string | null,
    },
    trackChanges: true,
  },
  // Options for the ytstream STRM target (/api/ytstream/:id). quality/transcode
  // fall back to preferredResolution/videoCodec (the normal download settings)
  // when left unset (quality: null, transcode: ''), so STRM playback matches
  // what a full download would use unless explicitly overridden here.
  ytstream: {
    default: {
      defaultMode: 'direct' as 'direct' | 'direct-pipe' | 'direct-redirect' | 'ffmpeg' | 'hls' | 'hls-tap' | 'hls-buffer' | 'raw-buffer',
      // mkv is ffmpeg-mode only (see YtstreamSettingsSection's Container select)
      container: 'mp4' as 'mp4' | 'ts' | 'mkv',
      // Empty string = auto (derive from videoCodec); copy = remux; h264 = re-encode
      transcode: '' as '' | 'copy' | 'h264',
      // null = fall back to preferredResolution / 720
      quality: null as string | null,
      // Controls how the configured `quality` height becomes a yt-dlp
      // format selector. 'fallback' (default, matches this app's
      // long-standing behavior) chains from the exact height down to
      // best-available. 'fixed' matches only that exact height - yt-dlp
      // fails cleanly (no silent substitution) if this video doesn't have
      // it. 'best' ignores the configured height entirely and always takes
      // the mode's true best-available format. See server/routes/ytstream.js
      // getDirectFormatSelector/getDashFormatSelectors.
      qualityStrictness: 'fallback' as 'fixed' | 'fallback' | 'best',
      // Hardware encoder for transcode=h264 (plugin ManagedTranscodeHardwareModes)
      hardwareMode: 'none' as 'none' | 'qsv' | 'nvenc' | 'vaapi' | 'amf',
      // Encode tuning tier for transcode=h264 (server/modules/streamEncoderTuning.js).
      // 'fast' matches this app's long-standing defaults (safest for real-time
      // HLS/live-pipe streaming); 'balanced'/'quality' trade encode speed for
      // picture quality. See the "Test real-time tuning" benchmark in Settings
      // → Streaming for which tier is actually safe on this host, per resolution.
      tuning: 'fast' as 'fast' | 'balanced' | 'quality',
      // Empty string = auto ('default,-tv' — avoids the yt-dlp "tv" client,
      // which is the most common cause of YouTube's "The page needs to be
      // reloaded." extraction error). Advanced override, e.g. "android" or
      // "web,android". See docs/YTSTREAM.md Troubleshooting.
      playerClient: '' as string,
      // mode=ffmpeg only. Reports a calculated Content-Length and answers
      // Range requests by restarting the pipeline seeked to the matching
      // calculated timestamp, so players that refuse to direct-play a
      // chunked/unknown-length stream (e.g. Jellyfin defaulting to a
      // server-side HLS transcode) see something that looks like an
      // ordinary seekable file. The estimate is necessarily approximate —
      // see docs/YTSTREAM.md. (Renamed from fakeLength; old configs are
      // migrated automatically - see configModule.js.)
      calculatedLength: false as boolean,
      // mode=hls only, pairs with strm.cacheOnPlay. Once the background
      // cache-on-play download finishes, an active HLS session switches its
      // encode source from the live yt-dlp/ffmpeg network pull to the local
      // cached file for all segments from that point on - same picture, no
      // player-visible restart, just faster/more reliable for the rest of
      // the video. No effect without cacheOnPlay (there's never a cached
      // file to switch to).
      hotSwapToCache: false as boolean,
      // Any mode, any request - not tied to an in-progress session the way
      // hotSwapToCache is. Checked first, before any mode/quality
      // resolution or yt-dlp/ffmpeg work: if this video is already fully
      // downloaded (STRM cache-on-play, or any genuine download), the real
      // local file is served directly with genuine byte-range support
      // (server/routes/ytstream.js's tryServeCachedVideoFile) instead of
      // live-proxying/transcoding it all over again. Off by default -
      // existing STRM playback behavior is unaffected unless opted in.
      serveCachedFile: false as boolean,
      // mode=hls + calculatedLength only, transcode=h264 sessions only.
      // Normally the first HLS response blocks until the real yt-dlp/ffmpeg
      // pipeline produces its first segment (a real cold start can take
      // 10-25s). When on, a small pre-generated "loading" clip (cached after
      // first use, matching the session's actual codec/hardware settings) is
      // served as segment 0 so playback starts within milliseconds while
      // the real encode catches up in the background. Has no effect for
      // transcode=copy (no single placeholder could match every video's
      // own passthrough codec) or when calculatedLength is off.
      instantStart: false as boolean,
      // transcode=h264 sessions only. A metadata-probe request (detected by
      // its bare default "Lavf/x.y.z" User-Agent - see
      // server/modules/ytstreamProbeShortcut.js) gets a tiny cached
      // standalone clip in the right codec instead of triggering a real
      // yt-dlp/ffmpeg session against YouTube. Also writes a pipe-syntax
      // custom User-Agent into every .strm this app generates - needed for
      // the detection to work at all (real playback honors that override,
      // a bare probe doesn't - see strmGenerator.js).
      probeShortcut: false as boolean,
      // When true, every playback request uses these settings as-is and
      // ignores query-string overrides - both a caller's own URL params and
      // whatever mode/quality/etc. got baked into a .strm file's URL back
      // when it was written (which can drift from these settings after a
      // later change here). Off by default so per-request overrides keep
      // working as before.
      forceServerSettings: false as boolean,
      // Nightly cron prune (server/modules/cronJobs.js, 3:15 AM) deletes
      // stream_history rows older than this. <= 0 or unset falls back to 90.
      historyRetentionDays: 90 as number,
    },
    trackChanges: true,
  },

  // Sonarr/Radarr/Prowlarr integration - Youtarr acts as a Newznab search
  // indexer + SABnzbd-compatible download client (see server/routes/nzb.js).
  // apiKey is stored and displayed in plaintext, same as jellyfinApiKey/
  // plexApiKey above - it's a service-integration token meant to be
  // copy/pasted into Sonarr/Radarr repeatedly, not a login credential, so
  // (unlike passwordHash) there's no reason to hide it after creation.
  nzb: {
    default: {
      enabled: false,
      apiKey: '',
      // Sonarr/Radarr run in their own container and may see the shared
      // media volume mounted at a different path than Youtarr does
      // internally. When set (including to '' for "no prefix at all"),
      // every path Youtarr reports to Sonarr/Radarr has its own real
      // data-root prefix swapped for this value instead (see
      // remapPathForSonarr in server/routes/nzb.js). Left at null (the
      // default), paths are reported unchanged - correct when both
      // containers see the same path.
      remoteBasePath: null as string | null,
      categories: [] as Array<{
        name: string;
        subfolder: string | null;
        mediaMode: 'download' | 'strm' | 'both';
        searchMode: 'flat' | 'episode';
        // 'hardlink': the file stays part of Youtarr's own library (DB row,
        // Jellyfin/Plex scan it); a hardlink is staged for Sonarr/Radarr to
        // import so their move only removes the hardlink, not Youtarr's own
        // copy (see stageForSonarrImport in server/routes/nzb.js).
        // 'untracked': Sonarr/Radarr are told the job is complete with the
        // real (only) file path and will move it away as usual, but Youtarr
        // removes its own DB tracking for that video right away, so it
        // never shows up in Youtarr's own video list/history to begin with
        // (see untrackFromYoutarrLibrary in server/routes/nzb.js).
        importStrategy: 'hardlink' | 'untracked';
        // One category can be declared under several Newznab category IDs
        // (e.g. both a specific quality tier and its parent, "5040" and
        // "5000") so a search naming any of them matches this category,
        // regardless of which combination the indexer client happens to
        // send together - see findCategory in server/routes/nzb.js.
        // Legacy configs with a single `newznabCategoryId` string are
        // migrated to this array once by configModule.
        newznabCategoryIds: string[];
        // When true, results are additionally required to have the search
        // terms (and, for tvsearch with a known season/episode, an SxxExx-
        // style code) actually present in the YouTube title before being
        // returned - YouTube search often returns loosely-related results
        // that only share a keyword (see applyLocalTitleFilter in
        // server/routes/nzb.js).
        additionalLocalFilter: boolean;
        // Gates the post-download transcode (downloadTranscodeVideoCodec,
        // Settings -> yt-dlp Options) for this category specifically - the
        // global setting must ALSO be on (not 'off') for this category to
        // ever transcode; this can only narrow, never override it. Lets a
        // user enable it for e.g. Movies but not TV Series. Applied before
        // Sonarr/Radarr are told the grab is complete (see
        // transcodeDownloadedVideo in server/modules/videoDownloadPostProcessFiles.js).
        // Never applies to STRM cache-on-play downloads, which are never
        // transcoded regardless of any setting.
        postEncode: boolean;
      }>,
    },
    trackChanges: true,
  },

  // Notifications
  notificationsEnabled: { default: false, trackChanges: true },
  appriseUrls: { default: [] as Array<{ url: string; name: string; richFormatting?: boolean }>, trackChanges: true },

  // Auto removal
  autoRemovalEnabled: { default: false, trackChanges: true },
  autoRemovalFreeSpaceThreshold: { default: '', trackChanges: true },
  autoRemovalVideoAgeThreshold: { default: '', trackChanges: true },
  autoRemovalWatchedEnabled: { default: false, trackChanges: true },
  autoRemovalWatchedMinDaysSinceWatched: { default: '', trackChanges: true },
  autoRemovalWatchedMinVideoAgeDays: { default: '', trackChanges: true },
  autoRemovalKeepRecentCount: { default: 0, trackChanges: true },
  // When removing a video that has an archived .strm/.strmtool.json backup
  // pair (written by STRM cache-on-play), revert to STRM playback instead of
  // fully deleting the library entry - only the big media file is removed.
  autoRemovalPreserveStrmFallback: { default: true, trackChanges: true },
  // Safety floor: a video whose tracked file is smaller than this is never
  // selected as an age/watched/space removal candidate. Protects bare .strm
  // rows (a few dozen bytes) from being "cleaned up" for ~0 bytes of savings.
  autoRemovalMinFileSizeKB: { default: 1, trackChanges: true },

  // Storage
  useTmpForDownloads: { default: false, trackChanges: true },
  tmpFilePath: { default: '/tmp/youtarr-downloads', trackChanges: false }, // Not tracked for changes

  // Subtitles
  subtitlesEnabled: { default: false, trackChanges: true },
  subtitleLanguage: { default: 'en', trackChanges: true },

  // Appearance
  darkModeEnabled: { default: false, trackChanges: true },
  channelVideosHotLoad: { default: false, trackChanges: true },

  // API Keys
  apiKeyRateLimit: { default: 10, trackChanges: true },

  // yt-dlp auto-update
  autoUpdateYtdlp: { default: false, trackChanges: true },
  ytdlpUpdateChannel: { default: 'stable' as 'stable' | 'nightly', trackChanges: true },
  ytdlpLastChecked: { default: null as string | null, trackChanges: false },
  ytdlpLastUpdated: { default: null as string | null, trackChanges: false },
  ytdlpLastResult: {
    default: null as { status: 'updated' | 'up-to-date' | 'skipped' | 'error'; message?: string; version?: string } | null,
    trackChanges: false,
  },
  rescanLastRun: {
    default: null as {
      startedAt: string;
      completedAt: string;
      trigger: 'manual' | 'scheduled' | 'startup';
      status: 'completed' | 'timed-out' | 'error';
      videosUpdated: number;
      videosMarkedMissing: number;
      videosScanned: number;
      filesFoundOnDisk: number;
      errorMessage: string | null;
    } | null,
    trackChanges: false,
  },

  // yt-dlp options (custom args, IP family, rate limit)
  ytdlpIpFamily: { default: 'ipv4' as 'ipv4' | 'ipv6' | 'auto', trackChanges: true },
  ytdlpDownloadRateLimit: { default: '', trackChanges: true },
  ytdlpCustomArgs: { default: '', trackChanges: true },

  // System/internal fields (not tracked for changes)
  youtubeOutputDirectory: { default: '', trackChanges: false },
  uuid: { default: '', trackChanges: false },
  envAuthApplied: { default: false, trackChanges: false },
};

/**
 * Derived ConfigState type from the schema
 * This ensures type safety and automatic inference of field types
 */
export type ConfigState = {
  [K in keyof typeof CONFIG_FIELDS]: (typeof CONFIG_FIELDS)[K]['default']
};

/**
 * Default configuration object
 * Automatically generated from CONFIG_FIELDS
 */
export const DEFAULT_CONFIG: ConfigState = {
  channelAutoDownload: CONFIG_FIELDS.channelAutoDownload.default,
  channelDownloadFrequency: CONFIG_FIELDS.channelDownloadFrequency.default,
  channelFilesToDownload: CONFIG_FIELDS.channelFilesToDownload.default,
  preferredResolution: CONFIG_FIELDS.preferredResolution.default,
  videoCodec: CONFIG_FIELDS.videoCodec.default,
  downloadTranscodeVideoCodec: CONFIG_FIELDS.downloadTranscodeVideoCodec.default,
  downloadTranscodeHardwareMode: CONFIG_FIELDS.downloadTranscodeHardwareMode.default,
  downloadTranscodeAudioCodec: CONFIG_FIELDS.downloadTranscodeAudioCodec.default,
  defaultSubfolder: CONFIG_FIELDS.defaultSubfolder.default,
  defaultSkipVideoFolder: CONFIG_FIELDS.defaultSkipVideoFolder.default,
  videoFilenamePrefix: CONFIG_FIELDS.videoFilenamePrefix.default,
  defaultLibraryMode: CONFIG_FIELDS.defaultLibraryMode.default,
  episodeFilenamePrefix: CONFIG_FIELDS.episodeFilenamePrefix.default,
  seriesOutputSubfolder: CONFIG_FIELDS.seriesOutputSubfolder.default,
  plexApiKey: CONFIG_FIELDS.plexApiKey.default,
  plexYoutubeLibraryId: CONFIG_FIELDS.plexYoutubeLibraryId.default,
  plexSubfolderLibraryMappings: CONFIG_FIELDS.plexSubfolderLibraryMappings.default,
  plexIP: CONFIG_FIELDS.plexIP.default,
  plexPort: CONFIG_FIELDS.plexPort.default,
  plexViaHttps: CONFIG_FIELDS.plexViaHttps.default,
  plexPlaylistToken: CONFIG_FIELDS.plexPlaylistToken.default,
  jellyfinEnabled: CONFIG_FIELDS.jellyfinEnabled.default,
  jellyfinUrl: CONFIG_FIELDS.jellyfinUrl.default,
  jellyfinApiKey: CONFIG_FIELDS.jellyfinApiKey.default,
  jellyfinUserId: CONFIG_FIELDS.jellyfinUserId.default,
  jellyfinVideoLibraryIds: CONFIG_FIELDS.jellyfinVideoLibraryIds.default,
  jellyfinSubfolderLibraryMappings: CONFIG_FIELDS.jellyfinSubfolderLibraryMappings.default,
  embyEnabled: CONFIG_FIELDS.embyEnabled.default,
  embyUrl: CONFIG_FIELDS.embyUrl.default,
  embyApiKey: CONFIG_FIELDS.embyApiKey.default,
  embyUserId: CONFIG_FIELDS.embyUserId.default,
  embyVideoLibraryIds: CONFIG_FIELDS.embyVideoLibraryIds.default,
  watchStatusSyncEnabled: CONFIG_FIELDS.watchStatusSyncEnabled.default,
  watchStatusSyncFrequency: CONFIG_FIELDS.watchStatusSyncFrequency.default,
  plexWatchStatusAllUsers: CONFIG_FIELDS.plexWatchStatusAllUsers.default,
  jellyfinWatchStatusAllUsers: CONFIG_FIELDS.jellyfinWatchStatusAllUsers.default,
  embyWatchStatusAllUsers: CONFIG_FIELDS.embyWatchStatusAllUsers.default,
  watchStatusWatchedRule: CONFIG_FIELDS.watchStatusWatchedRule.default,
  youtubeApiKey: CONFIG_FIELDS.youtubeApiKey.default,
  sponsorblockEnabled: CONFIG_FIELDS.sponsorblockEnabled.default,
  sponsorblockAction: CONFIG_FIELDS.sponsorblockAction.default,
  sponsorblockCategories: CONFIG_FIELDS.sponsorblockCategories.default,
  sponsorblockApiUrl: CONFIG_FIELDS.sponsorblockApiUrl.default,
  downloadSocketTimeoutSeconds: CONFIG_FIELDS.downloadSocketTimeoutSeconds.default,
  downloadThrottledRate: CONFIG_FIELDS.downloadThrottledRate.default,
  downloadRetryCount: CONFIG_FIELDS.downloadRetryCount.default,
  downloadAutoRetryCount: CONFIG_FIELDS.downloadAutoRetryCount.default,
  enableStallDetection: CONFIG_FIELDS.enableStallDetection.default,
  stallDetectionWindowSeconds: CONFIG_FIELDS.stallDetectionWindowSeconds.default,
  stallDetectionRateThreshold: CONFIG_FIELDS.stallDetectionRateThreshold.default,
  sleepRequests: CONFIG_FIELDS.sleepRequests.default,
  proxy: CONFIG_FIELDS.proxy.default,
  logLevel: CONFIG_FIELDS.logLevel.default,
  cookiesEnabled: CONFIG_FIELDS.cookiesEnabled.default,
  customCookiesUploaded: CONFIG_FIELDS.customCookiesUploaded.default,
  writeChannelPosters: CONFIG_FIELDS.writeChannelPosters.default,
  writeVideoNfoFiles: CONFIG_FIELDS.writeVideoNfoFiles.default,
  writeVideoFanart: CONFIG_FIELDS.writeVideoFanart.default,
  writeBackdropImages: CONFIG_FIELDS.writeBackdropImages.default,
  notificationsEnabled: CONFIG_FIELDS.notificationsEnabled.default,
  appriseUrls: CONFIG_FIELDS.appriseUrls.default,
  autoRemovalEnabled: CONFIG_FIELDS.autoRemovalEnabled.default,
  autoRemovalFreeSpaceThreshold: CONFIG_FIELDS.autoRemovalFreeSpaceThreshold.default,
  autoRemovalVideoAgeThreshold: CONFIG_FIELDS.autoRemovalVideoAgeThreshold.default,
  autoRemovalWatchedEnabled: CONFIG_FIELDS.autoRemovalWatchedEnabled.default,
  autoRemovalWatchedMinDaysSinceWatched: CONFIG_FIELDS.autoRemovalWatchedMinDaysSinceWatched.default,
  autoRemovalWatchedMinVideoAgeDays: CONFIG_FIELDS.autoRemovalWatchedMinVideoAgeDays.default,
  autoRemovalKeepRecentCount: CONFIG_FIELDS.autoRemovalKeepRecentCount.default,
  autoRemovalPreserveStrmFallback: CONFIG_FIELDS.autoRemovalPreserveStrmFallback.default,
  autoRemovalMinFileSizeKB: CONFIG_FIELDS.autoRemovalMinFileSizeKB.default,
  useTmpForDownloads: CONFIG_FIELDS.useTmpForDownloads.default,
  tmpFilePath: CONFIG_FIELDS.tmpFilePath.default,
  subtitlesEnabled: CONFIG_FIELDS.subtitlesEnabled.default,
  subtitleLanguage: CONFIG_FIELDS.subtitleLanguage.default,
  darkModeEnabled: CONFIG_FIELDS.darkModeEnabled.default,
  channelVideosHotLoad: CONFIG_FIELDS.channelVideosHotLoad.default,
  apiKeyRateLimit: CONFIG_FIELDS.apiKeyRateLimit.default,
  autoUpdateYtdlp: CONFIG_FIELDS.autoUpdateYtdlp.default,
  ytdlpUpdateChannel: CONFIG_FIELDS.ytdlpUpdateChannel.default,
  ytdlpLastChecked: CONFIG_FIELDS.ytdlpLastChecked.default,
  ytdlpLastUpdated: CONFIG_FIELDS.ytdlpLastUpdated.default,
  ytdlpLastResult: CONFIG_FIELDS.ytdlpLastResult.default,
  rescanLastRun: CONFIG_FIELDS.rescanLastRun.default,
  ytdlpIpFamily: CONFIG_FIELDS.ytdlpIpFamily.default,
  ytdlpDownloadRateLimit: CONFIG_FIELDS.ytdlpDownloadRateLimit.default,
  ytdlpCustomArgs: CONFIG_FIELDS.ytdlpCustomArgs.default,
  youtubeOutputDirectory: CONFIG_FIELDS.youtubeOutputDirectory.default,
  uuid: CONFIG_FIELDS.uuid.default,
  envAuthApplied: CONFIG_FIELDS.envAuthApplied.default,
  mediaMode: CONFIG_FIELDS.mediaMode.default,
  strm: CONFIG_FIELDS.strm.default,
  ytstream: CONFIG_FIELDS.ytstream.default,
  nzb: CONFIG_FIELDS.nzb.default,
};

/**
 * Array of config keys that should be tracked for unsaved changes
 * Automatically filtered from CONFIG_FIELDS where trackChanges is true
 */
export const TRACKABLE_CONFIG_KEYS = Object.entries(CONFIG_FIELDS)
  .filter(([_, meta]) => meta.trackChanges)
  .map(([key, _]) => key) as (keyof ConfigState)[];
