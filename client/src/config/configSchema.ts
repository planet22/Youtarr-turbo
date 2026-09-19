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
 * 2. ConfigState, DEFAULT_CONFIG, and TRACKABLE_CONFIG_KEYS are all
 *    automatically derived - nothing else to update
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

  // Replaces the simple queued-jobs chip list on the Download Activity page
  // with a reorderable/deletable table plus a queue pause button. Purely a
  // client presentation choice - see JobQueueTable.tsx.
  downloadQueueManagerEnabled: { default: false, trackChanges: true },

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
      defaultMode: 'direct' as 'direct' | 'direct-redirect' | 'hls' | 'hls-buffer' | 'hls-byterange' | 'download-cache' | 'youtube-hls',
      // mkv is ffmpeg-mode only (see YtstreamSettingsSection's Container select)
      container: 'mp4' as 'mp4' | 'ts' | 'mkv',
      // Debug-only escape hatch, not exposed in Settings UI (same pattern as
      // debugLogging below) - forces every probeShortcut synthetic clip
      // (server/modules/ytstream/probeShortcut.js) to this container
      // regardless of the real session's own `container` above, so a
      // specific container's duration-patch path can be forced on/off for
      // testing (e.g. the mp4 mvhd/tkhd/mdhd duration patch vs mkv's known-
      // good Segment Info Duration patch) without editing code each time.
      // null (default) uses the real session's `container` as before this
      // existed.
      probeShortcutContainerOverride: null as 'mp4' | 'ts' | 'mkv' | null,
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
      // Hardware DECODE backend (server/modules/hardwareDecodeModule.js) -
      // fully independent of hardwareMode (encode) above; every combination
      // (including mismatched ones, e.g. software encode + hardware decode)
      // is valid and measured exactly as configured by the tuning benchmark.
      // No 'amf' option here - AMD GPU decode acceleration in ffmpeg is a
      // Windows/D3D11 API; on this app's actual Linux runtime, AMD decode
      // goes through VAAPI instead, so a separate "amf" option would just be
      // a confusing alias for 'vaapi'. 'none' (default, unchanged behavior)
      // decodes the source in software, same as before this setting existed.
      hardwareDecodeMode: 'none' as 'none' | 'qsv' | 'nvenc' | 'vaapi',
      // Encode tuning tier for transcode=h264 (server/modules/streamEncoderTuning.js).
      // 'fast' matches this app's long-standing defaults (safest for real-time
      // HLS/live-pipe streaming); 'balanced'/'quality' trade encode speed for
      // picture quality. See the "Test real-time tuning" benchmark in Settings
      // → Streaming for which tier is actually safe on this host, per resolution.
      tuning: 'fast' as 'fast' | 'balanced' | 'quality',
      // hardwareMode=vaapi only, manual override. ffmpeg's h264_vaapi
      // encoder exposes a separate driver-level "-quality"
      // (compression_level, 1-7) knob that - unlike the tuning tiers' -qp
      // above - actually trades real encode speed for picture quality on
      // drivers that support it (notably Intel's iHD driver); -qp alone
      // barely affects a fixed-function hardware encoder's throughput,
      // which is why fast/balanced/quality otherwise measure almost
      // identically for VAAPI. null (default) doesn't mean "off" - each
      // tuning tier already bakes in its own sensible compressionLevel
      // (server/modules/streamEncoderTuning.js's TUNING_TIERS.vaapi:
      // fast=7, balanced=4, quality=1), so this field only matters when
      // manually overriding that per-tier default. Safe on drivers that
      // don't support this attribute (e.g. AMD's Mesa radeonsi), which
      // just ignore it with a warning.
      vaapiQuality: null as number | null,
      // Empty string = auto ('default,-tv' — avoids the yt-dlp "tv" client,
      // which is the most common cause of YouTube's "The page needs to be
      // reloaded." extraction error). Advanced override, e.g. "android" or
      // "web,android". See docs/YTSTREAM.md Troubleshooting.
      playerClient: '' as string,
      // Power-user yt-dlp network tuning for live playback (buildBaseArgs in
      // server/routes/ytstream.js) - see docs/YTSTREAM.md. 0 means "don't
      // pass the flag at all" (yt-dlp's own default applies) for every field
      // below; there is no other way to explicitly disable one once set.
      //
      // --http-chunk-size: splits yt-dlp's fetch of the googlevideo URL into
      // ranged HTTP requests instead of one long-lived connection - yt-dlp's
      // own docs cite this as the fix for YouTube's mid-download bandwidth
      // throttling. Only has any effect on modes where yt-dlp itself streams
      // the media bytes (hls/hls-buffer); inert (but harmless) on
      // direct/direct-redirect, where yt-dlp only resolves a URL via -g and
      // never downloads the video itself.
      httpChunkSizeMiB: 0 as number,
      // -N/--concurrent-fragments: fetches that chunking concurrently.
      // Values <= 1 are treated as "disabled" (yt-dlp's own default of a
      // single sequential fetch). Same hls/hls-buffer-only applicability as
      // httpChunkSizeMiB above.
      concurrentFragments: 0 as number,
      // --throttled-rate: yt-dlp re-extracts the URL if the measured
      // download rate drops below this. Applies to every mode's yt-dlp
      // calls, but only actually measures anything on a call that streams
      // real data (hls/hls-buffer) - a no-op on direct/direct-redirect's
      // quick -g resolve.
      throttledRateKBps: 0 as number,
      // --socket-timeout: how long yt-dlp waits on a stalled connection
      // before giving up, in seconds. Applies to every yt-dlp call this app
      // makes (including the -g resolve calls direct/direct-redirect use),
      // so a stall triggers this app's own retry/fallback logic sooner
      // instead of hanging on yt-dlp's much longer built-in default.
      socketTimeoutSeconds: 0 as number,
      // mode=hls/hls-buffer only (forced on for those; ignored for
      // direct/direct-redirect). Reports a calculated Content-Length so
      // players that refuse to direct-play a chunked/unknown-length stream
      // (e.g. Jellyfin defaulting to a server-side HLS transcode) see
      // something that looks like an ordinary seekable file. The estimate
      // is necessarily approximate — see docs/YTSTREAM.md. (Renamed from
      // fakeLength; old configs are migrated automatically - see
      // configModule.js.)
      calculatedLength: false as boolean,
      // mode=hls/hls-buffer only. Wraps the real media playlist in a thin
      // HLS master playlist (#EXT-X-STREAM-INF with BANDWIDTH/RESOLUTION,
      // pointing at the actual media playlist) instead of serving the media
      // playlist directly at the top-level ytstream URL - the more
      // broadly-compatible, spec-idiomatic HLS shape (Apple's own HLS
      // Authoring Guidelines recommend a master playlist even for a single
      // rendition), and it stops Jellyfin guessing a ~20 Mbps default
      // bandwidth on a bare media playlist, which can force needless
      // transcoding on bandwidth-limited clients. BANDWIDTH/RESOLUTION are
      // estimates (server/modules/ytstream/hlsMasterPlaylist.js) - real
      // values are known for RESOLUTION (same source-resolution lookup the
      // encoder itself uses) but BANDWIDTH is a heuristic per resolution
      // tier, since encodes are CRF/QP-quality-targeted, not fixed-bitrate.
      // CODECS is deliberately never declared - the exact profile/level
      // varies per hardware encoder and getting it wrong would misrepresent
      // the stream the same way the old probe-shortcut synthetic clip did.
      // On by default; existing STRM URLs work unchanged either way, since
      // the media playlist itself is unaffected - only whether it's wrapped.
      hlsMasterPlaylist: true as boolean,
      // mode=hls only, pairs with strm.cacheOnPlay. Once the background
      // cache-on-play download finishes, an active HLS session switches its
      // encode source from the live yt-dlp/ffmpeg network pull to the local
      // cached file for all segments from that point on - same picture, no
      // player-visible restart, just faster/more reliable for the rest of
      // the video. No effect without cacheOnPlay (there's never a cached
      // file to switch to).
      hotSwapToCache: false as boolean,
      // (No Settings UI: its only applicable mode, plain mode=hls, is hidden
      // from the Playback mode picker. Still honored from config.json.)
      // Any mode, any request - not tied to an in-progress session the way
      // hotSwapToCache is. Checked first, before any mode/quality
      // resolution or yt-dlp/ffmpeg work: if this video is already fully
      // downloaded (STRM cache-on-play, or any genuine download), the real
      // local file is served directly with genuine byte-range support
      // (server/routes/ytstream.js's tryServeCachedVideoFile) instead of
      // live-proxying/transcoding it all over again. Off by default -
      // existing STRM playback behavior is unaffected unless opted in.
      serveCachedFile: false as boolean,
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
      // Where a live HLS session's segment files (mode=hls/hls-buffer)
      // are written. 'tmp' (default, unchanged behavior) uses the OS temp
      // dir - fastest, but on some setups that's a small/volatile partition.
      // 'cache' writes under Youtarr's own persistent .youtarr_ytstream_cache
      // folder instead (same volume as the untracked-buffer cache below),
      // for hosts where the OS temp dir is undersized or where segments
      // surviving a restart is more useful than raw temp-dir speed. Segments
      // are still deleted on the same idle-timeout schedule either way -
      // this only changes WHERE they live, not how long they're kept.
      hlsStorageLocation: 'tmp' as 'tmp' | 'cache',
      // mode=hls/hls-buffer only, and only takes effect once a local
      // source is available for this session (STRM cache-on-play hot-swap,
      // or hls-buffer's own independent fetch) - a forward seek during
      // playback restarts the live encode at the seek target, permanently
      // skipping whatever segments lay between where the old pass had
      // reached and the new target. When on, once the live encode pass
      // reaches the real end of the video, a separate background ffmpeg
      // pass (reading the now-available local source, never the network)
      // fills in any such gap so every segment ends up encoded - purely for
      // faster/instant seeking later in the same session, never blocking or
      // slowing down actual playback.
      backfillMissingSegments: false as boolean,
      // mode=hls-buffer only - its finished output is always a
      // .ts container. Browsers' <video> element can't play raw .ts directly, and some external
      // players (e.g. Jellyfin) fall back to a server-side transcode rather
      // than direct-playing it. When on, once that .ts is fully finalized
      // (backfillMissingSegments completing first, if also enabled), a
      // background ffmpeg pass remuxes it (-c copy, no re-encode) into a
      // sibling .mp4 - playback/serving then prefers that .mp4 automatically
      // whenever it exists (server/modules/tsRemuxCache.js), without ever
      // touching the original .ts.
      finalizeToMp4: false as boolean,
      // mode=hls-buffer only - keeps the buffered file out of the visible
      // library folder entirely, in the same hidden cache the untracked
      // buffer cache already uses (server/routes/ytstream.js's
      // HLS_UNTRACKED_BUFFER_CACHE_DIR). The .strm is never touched (no
      // is_strm flip, no filePath change), so a media server always keeps
      // resolving playback through Youtarr instead of ever indexing a real
      // file directly - see the "Jellyfin loses track of the file mid-swap"
      // failure mode this avoids. When finalizeToMp4 is ALSO on, the hidden
      // .ts is swapped for its .mp4 remux in place once ready (.ts deleted,
      // .mp4 becomes the hidden cache's canonical file - never promoted to
      // the library), subject to the same strm.cacheOnPlayExpiryHours sweep
      // as the untracked cache. When this is off but finalizeToMp4 is
      // on, the .ts still buffers into the hidden cache first, but the
      // finished .mp4 IS promoted straight into the library once ready -
      // Jellyfin only ever sees the .strm replaced by the finished .mp4,
      // never the intermediate .ts.
      stealthCache: false as boolean,
      // mode=hls-buffer only, config.json-only (no Settings UI, same
      // pattern as probeShortcutContainerOverride above) - delays starting
      // the network-bound hls-buffer fetch (server/modules/ytstream/
      // hlsEngine.js's startHlsBufferFetch) until this many DISTINCT
      // segments have actually been requested, instead of the instant the
      // session is created. A metadata probe (Jellyfin/StrmTool) only ever
      // requests segment 0 (occasionally 1), so this avoids spinning up a
      // full background download for every probe that never becomes real
      // playback. 0 keeps the original always-start-immediately behavior
      // exactly as it was.
      bufferStartAfterSegments: 3 as number,
      // This file's own per-request/per-segment diagnostic lines (segment
      // serves, playlist polls, buffer-fetch progress ticks, etc.) are too
      // high-volume for logger.info by default, but gating them behind the
      // global Log Level=debug setting also turns on every OTHER module's
      // debug output (most visibly the ~15s database health-check line) -
      // unrelated noise with no way to see just this file's own traffic.
      // When on, these specific lines print regardless of the global Log
      // Level, without touching any other module's verbosity; when off,
      // they behave exactly as before (visible only at Log Level=debug).
      debugLogging: false as boolean,
      // mode=hls-byterange only (server/modules/ytstream/byteRangeHlsMode.js).
      // false (default): the mode's own well-supported behavior - the
      // top-level URL returns an HLS manifest (#EXT-X-MAP/#EXT-X-BYTERANGE
      // into one growing fMP4 file). true (experimental, opt-in): skips the
      // manifest entirely and serves that growing file directly via plain
      // HTTP Range requests - real risk here (a native player like AVPlayer
      // infers duration from Content-Length/probing when there's no
      // manifest to read it from instead, and a still-growing file's
      // changing declared size is a known source of playback failures) -
      // off by default for exactly that reason.
      byteRangeDeliverAsFile: false as boolean,
      // mode=hls-byterange with byteRangeDeliverAsFile only. When a cached
      // encode was cut off early (idle timeout, forced stop), resume from
      // where it stopped and stitch the new tail onto it instead of
      // re-encoding from byte 0. Off: a partial cache entry is ignored and
      // a fresh from-zero encode runs (always safe).
      byteRangeResumeCache: false as boolean,
      // mode=youtube-hls only. Which audio track to serve when the video has
      // dubbed languages ('en', 'de', 'pt-BR'...). Empty = the original
      // language. A language the video doesn't offer falls back to that.
      audioLanguage: '' as string,
      // mode=youtube-hls only. Where the player gets its playlists/segments:
      // 'off' - straight from YouTube (only the master comes from here);
      // 'proxy' - Youtarr also serves the video/audio playlists (plays become
      // visible); 'serve' - additionally every segment request goes through
      // Youtarr, which redirects to YouTube (position + estimated data rate).
      youtubeHlsProxy: 'off' as 'off' | 'proxy' | 'serve',
      // Per-hardware-mode result of the "Test HLS segment timing" check
      // (server/modules/streamTuningBenchmark.js's testSegmentTiming) -
      // only ever set by that test itself, never manually. true for a mode
      // means time-based forced keyframes (exact ~4s HLS segments,
      // regardless of source fps) were empirically confirmed working on
      // THIS host for that mode; false/absent keeps the original
      // fixed-frame-count GOP (only exactly accurate at 30fps, but a known,
      // safe default). See streamEncoderTuning.js's buildVideoEncoderArgs
      // useForceKeyframes param.
      forceKeyframesByHardwareMode: {} as Record<string, boolean>,
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
      // How long a raw search result set (keyed by the exact query+count
      // sent to the YouTube API/yt-dlp) is reused before a repeat search
      // re-fetches - see videoSearchModule.js's _fetchRaw. Sonarr/Radarr
      // poll the same Newznab query repeatedly on their own schedule; this
      // avoids spawning a redundant yt-dlp process (or burning API quota)
      // for one it already just answered. 0 disables caching entirely.
      searchCacheMinutes: 10,
      // This file's own per-request diagnostic lines (search/caps/addfile/
      // queue/history requests, cache hit/miss, local-filter before/after
      // counts, etc.) print at logger.debug by default - too high-volume for
      // logger.info, but gating them behind the global Log Level=debug
      // setting also turns on every OTHER module's debug output. This flag
      // decouples the two, same as ytstream.debugLogging above - see
      // nzbDebug in server/routes/nzb.js.
      debugLogging: false as boolean,
      // How a search result's real resolution is determined when it isn't
      // already known for free (the YouTube Data API's contentDetails.
      // definition, when that backend is in use) - see
      // server/modules/nzbFeedModule.js's resolveEffectiveHeightTier and
      // server/routes/nzb.js's search handler. Tried in this order, each a
      // fallback for the one before it; a video that reaches none of them
      // (or every enabled one fails/is inconclusive) is labeled at the
      // plain configured download quality, same as before any of this
      // existed:
      //   fixed:   a previously-downloaded video's own real recorded
      //            resolution (Videos.video_resolution) - free, exact, but
      //            only ever applies to a video Youtarr already has.
      //   thumb:   nzbThumbnailProbe's maxresdefault-thumbnail heuristic -
      //            cheap, but a "hd" answer can be a false positive (see
      //            probeViaExtraction's doc comment).
      //   extract: a REAL yt-dlp extraction of the video's watch page -
      //            authoritative, but noticeably slower and more likely to
      //            draw YouTube's rate-limiting attention if run often, so
      //            it's only ever used to confirm/correct thumb's uncertain
      //            or "hd" results. If fixed and thumb are both off, this
      //            becomes the only remaining check and runs directly.
      //            Off by default (opt-in).
      resolutionDetection: {
        fixed: true,
        thumb: true,
        extract: false,
      } as { fixed: boolean; thumb: boolean; extract: boolean },
      // How many rows each of the three nzb_diagnostic_log-backed logs
      // (see server/modules/nzbDiagnosticLog.js) keeps before pruning the
      // oldest on every write - server/routes/nzb.js's recordSearchTrace/
      // recordFailedGrab and server/modules/videoSearchModule.js's
      // recordNzbQuery. 1-100 each; these back the NZB diagnostics page's
      // Recent Queries, Search Detail/Debug, and Failed Grabs tables.
      diagnosticLogLimits: {
        recentQueries: 50,
        searchTraces: 20,
        failedGrabs: 20,
      } as { recentQueries: number; searchTraces: number; failedGrabs: number },
      // Row cap for the nzb_resolution_cache table (nzbThumbnailProbe.js's
      // thumb/extract resolution findings, keyed by youtube_id) - replaces
      // the old in-memory Map this table replaced, which was capped at 5000
      // entries via manual LRU eviction. 100-10,000; oldest rows (by
      // createdAt) are pruned once the cap is exceeded.
      videoResolutionCacheLimit: 5000,
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
        // Case-insensitive substrings ("advert", "outtakes", "behind the
        // scenes") that mark a result as junk even though it legitimately
        // contains every search keyword - a DVD-extra clip or promo often
        // does. Only applied when additionalLocalFilter is also on. See
        // titleContainsExcludedTerm in server/routes/nzb.js.
        excludeTerms: string[];
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
 * Genuinely derived from CONFIG_FIELDS (not hand-copied): every key in
 * CONFIG_FIELDS is guaranteed to appear here with its `default`, so a new
 * field can never drift out of sync with this object. The cast is required
 * because Object.fromEntries loses the per-key literal types that
 * ConfigState's mapped type expresses; the runtime shape is exact.
 */
export const DEFAULT_CONFIG: ConfigState = Object.fromEntries(
  Object.entries(CONFIG_FIELDS).map(([key, field]) => [key, field.default])
) as ConfigState;

/**
 * Array of config keys that should be tracked for unsaved changes
 * Automatically filtered from CONFIG_FIELDS where trackChanges is true
 */
export const TRACKABLE_CONFIG_KEYS = Object.entries(CONFIG_FIELDS)
  .filter(([_, meta]) => meta.trackChanges)
  .map(([key, _]) => key) as (keyof ConfigState)[];
