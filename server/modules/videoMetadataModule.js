const { Video } = require('../models');
const fs = require('fs').promises;
const path = require('path');
const configModule = require('./configModule');
const ytDlpRunner = require('./ytDlpRunner');
const logger = require('../logger');
const youtubeApi = require('./youtubeApi');
const ChannelVideo = require('../models/channelvideo');
const channelVideoReanchor = require('./channelVideoReanchor');
const { parseTierFromFormatNote, extractAvailableResolutionTiers } = require('./resolutionTier');
const tsRemuxCache = require('./tsRemuxCache');
const youtubeMetadataCache = require('./youtubeMetadataCache');
const { formatRelativeTimeAgo } = require('./relativeTimeFormatter');

const NULL_METADATA = {
  description: null,
  viewCount: null,
  likeCount: null,
  commentCount: null,
  tags: null,
  categories: null,
  uploadDate: null,
  resolution: null,
  width: null,
  height: null,
  fps: null,
  aspectRatio: null,
  language: null,
  isLive: null,
  wasLive: null,
  availability: null,
  channelFollowerCount: null,
  ageLimit: null,
  webpageUrl: null,
  relatedFiles: null,
  availableResolutions: null,
  // Additive - purely informational for a consumer that wants to show "this
  // is cached data" (the video modal). isCached is false and cachedAt/
  // cachedAgo/metadataSource are null for every live-fetched path (yt-dlp,
  // the API fallback, and total failure), so an existing caller that
  // ignores these fields sees no behavior change at all. cachedAgo is a
  // pre-formatted "5h 4m ago" string (see relativeTimeFormatter.js) rather
  // than leaving relative-time math to every consumer independently - a
  // display-wording change only ever has to happen in that one place.
  isCached: false,
  cachedAt: null,
  cachedAgo: null,
  metadataSource: null,
};

const YTDLP_FETCH_TIMEOUT_MS = 60000;

// Convert yt-dlp upload_date (YYYYMMDD) to the ISO string format used by
// channelvideos.publishedAt. Returns null if unparseable.
function uploadDateToIso(uploadDate) {
  if (!uploadDate || typeof uploadDate !== 'string' || uploadDate.length < 8) {
    return null;
  }
  const year = uploadDate.substring(0, 4);
  const month = uploadDate.substring(4, 6);
  const day = uploadDate.substring(6, 8);
  const d = new Date(`${year}-${month}-${day}T00:00:00Z`);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

const FILE_EXTENSION_CATEGORIES = {
  '.jpg': 'Thumbnail', '.jpeg': 'Thumbnail', '.png': 'Thumbnail', '.webp': 'Thumbnail',
  '.nfo': 'NFO Metadata',
  '.srt': 'Subtitles', '.vtt': 'Subtitles', '.ass': 'Subtitles',
  '.json': 'Info JSON',
};

const STREAM_MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
};

const DEFAULT_STREAM_MIME_TYPE = 'application/octet-stream';

class VideoMetadataModule {
  constructor() {}

  /**
   * Get extended video metadata from cached .info.json or by fetching via yt-dlp.
   * Returns a curated subset of fields. Silently backfills originalDate when
   * the .info.json has a more accurate upload_date than the existing DB record.
   *
   * Source priority:
   *   1. cached .info.json on disk (fast path, always has fileDetails)
   *   2. yt-dlp fresh fetch (populates cache, always has fileDetails)
   *   3. YouTube Data API v3 fallback when yt-dlp fails (no file details)
   *
   * The API is only a fallback: third-party callers cannot request the
   * `fileDetails` part, which is where the API exposes FPS, numeric aspect
   * ratio, pixel dimensions, and the format/resolution list. yt-dlp has all
   * of those plus description/views/etc, so it stays primary. When yt-dlp
   * fails outright (rate-limited, bot-blocked, network error), the API
   * fallback lets the video modal still show something useful (description,
   * view/like counts, upload date, availability, live status) instead of a
   * completely empty state.
   *
   * @param {string} youtubeId - YouTube video ID
   * @returns {Promise<Object>} Curated metadata object (all null on failure)
   */
  /**
   * @param {string} youtubeId
   * @param {{forceRefresh?: boolean}} [options] - forceRefresh skips both the
   *   on-disk .info.json and the youtube_metadata_cache DB row and always
   *   does a live yt-dlp fetch, overwriting both caches with the result -
   *   the video modal's/Library page's "Refresh cached metadata" action.
   */
  async getVideoMetadata(youtubeId, { forceRefresh = false } = {}) {
    try {
      const infoDir = path.join(configModule.getJobsPath(), 'info');
      const infoPath = path.join(infoDir, `${youtubeId}.info.json`);

      let rawData = null;
      // Which source actually answered this call, and when that source's
      // data was captured - purely additive fields on the eventual response
      // (see NULL_METADATA) for a consumer that wants to show "this is
      // cached" (the video modal). null/false for every live-fetched path.
      let metadataSource = null;
      let cachedAt = null;

      // Try reading cached .info.json from disk, then the shared
      // youtube_metadata_cache DB row (see youtubeMetadataCache.js) - a
      // prior full yt-dlp extraction for this video (a stream/preview
      // warm-up, a completed download, STRM materialization) may already
      // be sitting there even with no .info.json file on disk at all, e.g.
      // an untracked video that was only ever previewed. forceRefresh skips
      // both and always re-fetches live.
      if (!forceRefresh) {
        try {
          const stat = await fs.stat(infoPath);
          const content = await fs.readFile(infoPath, 'utf8');
          rawData = JSON.parse(content);
          metadataSource = 'info-json';
          cachedAt = stat.mtime.toISOString();
        } catch {
          const dbCached = await youtubeMetadataCache.getCachedRawInfoJson(youtubeId);
          if (dbCached) {
            rawData = dbCached.data;
            metadataSource = 'db-cache';
            cachedAt = dbCached.fetchedAt;
            logger.debug({ youtubeId }, 'No cached .info.json; using youtube_metadata_cache DB row instead');
          }
        }
      }

      if (!rawData) {
        // Not cached anywhere (or forceRefresh) - fetch via yt-dlp
        logger.debug({ youtubeId, forceRefresh }, 'Fetching video metadata via yt-dlp');
        try {
          rawData = await ytDlpRunner.fetchMetadata(
            `https://www.youtube.com/watch?v=${youtubeId}`,
            YTDLP_FETCH_TIMEOUT_MS
          );
          metadataSource = 'yt-dlp';
          cachedAt = new Date().toISOString();

          // Cache the result for future requests - both the disk .info.json
          // this method has always used, and the shared DB cache so other
          // consumers (ytstream's fps/max-height lookups, a later untracked
          // preview) don't need their own independent yt-dlp fetch either.
          try {
            await fs.mkdir(infoDir, { recursive: true });
            await fs.writeFile(infoPath, JSON.stringify(rawData, null, 2), 'utf8');
            logger.debug({ youtubeId }, 'Cached .info.json from yt-dlp fetch');
          } catch (cacheErr) {
            logger.warn({ err: cacheErr, youtubeId }, 'Failed to cache .info.json');
          }
          if (Number.isFinite(Number(rawData.duration)) && Number(rawData.duration) > 0) {
            youtubeMetadataCache.cacheRawInfoJson(youtubeId, rawData.duration, rawData);
          }
        } catch (fetchErr) {
          logger.warn({ err: fetchErr, youtubeId }, 'Failed to fetch metadata via yt-dlp');

          // yt-dlp throws "Join this channel..." / "available to this channel's
          // members..." style errors for members-only videos. The fetch failure
          // is itself the signal: stamp subscriber_only so the next modal open
          // short-circuits the failing fetch (VideoModal skips getVideoMetadata
          // when video.status === 'members_only').
          const detectedMembersOnly = ytDlpRunner.isMembersOnlyError(fetchErr?.message);
          if (detectedMembersOnly) {
            try {
              await ChannelVideo.update(
                { availability: 'subscriber_only' },
                { where: { youtube_id: youtubeId } },
              );
            } catch (backfillErr) {
              logger.warn({ err: backfillErr, youtubeId }, 'Failed to backfill ChannelVideo.availability after members-only fetch error');
            }
          }

          // Try API fallback so the UI isn't left completely empty. File
          // detail fields will be null (API can't provide them), but text
          // fields are still useful.
          const fallbackMetadata = { ...(await this._getApiFallbackMetadata(youtubeId)) };
          // The Data API never reports 'subscriber_only' (it sees the video as
          // 'public' since the gating is membership-side). When we already
          // detected members-only from the yt-dlp error, override the response
          // so the modal renders the Members Only state on first open instead
          // of treating the video as public until the next refetch.
          if (detectedMembersOnly) {
            fallbackMetadata.availability = 'subscriber_only';
          }
          return fallbackMetadata;
        }
      }

      if (!rawData) {
        return NULL_METADATA;
      }

      // Silently backfill originalDate if yt-dlp has a more accurate value
      if (rawData.upload_date) {
        try {
          const video = await Video.findOne({ where: { youtubeId } });
          if (video) {
            const dbDate = video.originalDate;
            const ytDate = rawData.upload_date; // YYYYMMDD format
            // Backfill if DB has no date, or if yt-dlp date is different (more accurate)
            if (!dbDate || dbDate !== ytDate) {
              await video.update({ originalDate: ytDate });
              logger.debug({ youtubeId, oldDate: dbDate, newDate: ytDate }, 'Backfilled originalDate from metadata');
            }
          }
        } catch (backfillErr) {
          logger.warn({ err: backfillErr, youtubeId }, 'Failed to backfill originalDate');
        }
      }

      // Backfill ChannelVideo.availability so members-only videos surfaced via
      // modal open get marked, even when yt-dlp's flat-playlist channel listing
      // omits availability for lockupViewModel entries. Same shape as the
      // originalDate backfill above. Only runs on the yt-dlp path; the API
      // fallback never reports 'subscriber_only' so backfilling from there
      // would silently downgrade real values to 'public'.
      if (rawData.availability) {
        try {
          await ChannelVideo.update(
            { availability: rawData.availability },
            { where: { youtube_id: youtubeId } },
          );
        } catch (backfillErr) {
          logger.warn({ err: backfillErr, youtubeId }, 'Failed to backfill ChannelVideo.availability');
        }
      }

      // Backfill ChannelVideo.publishedAt from the authoritative .info.json
      // upload_date, replacing estimated/approximate dates from flat-playlist
      // channel fetches. Delegated to the re-anchor module so neighbouring
      // synthetic dates are shifted to keep the channel in YouTube order when
      // this exact date would otherwise sort the video out of place.
      const uploadDateIso = uploadDateToIso(rawData.upload_date);
      if (uploadDateIso) {
        try {
          await channelVideoReanchor.applyExactDateForVideo(youtubeId, uploadDateIso);
        } catch (backfillErr) {
          logger.warn({ err: backfillErr, youtubeId }, 'Failed to backfill ChannelVideo.publishedAt');
        }
      }

      // Use the numeric aspect_ratio from yt-dlp (e.g. 1.78 for 16:9)
      const aspectRatio = rawData.aspect_ratio ?? null;

      // Collect related files on disk (thumbnail, subtitles, nfo, etc.)
      const relatedFiles = await this._getVideoRelatedFiles(youtubeId);

      // Extract available resolutions from the formats array
      const availableResolutions = this._extractAvailableResolutions(rawData.formats);

      return {
        description: rawData.description ?? null,
        viewCount: rawData.view_count ?? null,
        likeCount: rawData.like_count ?? null,
        commentCount: rawData.comment_count ?? null,
        tags: rawData.tags ?? null,
        categories: rawData.categories ?? null,
        uploadDate: rawData.upload_date ?? null,
        resolution: rawData.resolution ?? null,
        width: rawData.width ?? null,
        height: rawData.height ?? null,
        fps: rawData.fps ?? null,
        aspectRatio,
        language: rawData.language ?? null,
        isLive: rawData.is_live ?? null,
        wasLive: rawData.was_live ?? null,
        availability: rawData.availability ?? null,
        channelFollowerCount: rawData.channel_follower_count ?? null,
        ageLimit: rawData.age_limit ?? null,
        webpageUrl: rawData.webpage_url ?? null,
        relatedFiles,
        availableResolutions,
        isCached: metadataSource === 'info-json' || metadataSource === 'db-cache',
        cachedAt,
        cachedAgo: formatRelativeTimeAgo(cachedAt),
        metadataSource,
      };
    } catch (err) {
      logger.error({ err, youtubeId }, 'Unexpected error in getVideoMetadata');
      return NULL_METADATA;
    }
  }

  /**
   * Fallback when yt-dlp fails: pull the fields the public API can provide
   * (description, view/like/comment counts, tags, categories, uploadDate,
   * availability, live broadcast state) and return them in the same shape
   * as the primary path, with the file-detail fields set to null.
   *
   * Returns NULL_METADATA when no API key is configured or the API call
   * also fails, so the caller's contract is unchanged.
   */
  async _getApiFallbackMetadata(youtubeId) {
    if (!youtubeApi.isAvailable()) {
      return NULL_METADATA;
    }

    try {
      const apiKey = youtubeApi.getApiKey();
      const [apiResult] = await youtubeApi.client.getVideoMetadata(apiKey, [youtubeId]);
      if (!apiResult) {
        return NULL_METADATA;
      }

      logger.info(
        { youtubeId, source: 'youtube-api-fallback' },
        'yt-dlp failed, serving partial metadata from YouTube API (no file details)'
      );

      // Silently backfill originalDate on the DB row, matching the yt-dlp path.
      if (apiResult.uploadDate) {
        try {
          const video = await Video.findOne({ where: { youtubeId } });
          if (video && (!video.originalDate || video.originalDate !== apiResult.uploadDate)) {
            await video.update({ originalDate: apiResult.uploadDate });
          }
        } catch (backfillErr) {
          logger.warn({ err: backfillErr, youtubeId }, 'Failed to backfill originalDate (API fallback path)');
        }
      }

      const relatedFiles = await this._getVideoRelatedFiles(youtubeId);

      return {
        ...NULL_METADATA,
        description: apiResult.description,
        viewCount: apiResult.viewCount,
        likeCount: apiResult.likeCount,
        commentCount: apiResult.commentCount,
        tags: apiResult.tags,
        categories: apiResult.categories,
        uploadDate: apiResult.uploadDate,
        availability: apiResult.availability,
        isLive: apiResult.liveBroadcastContent === 'live',
        webpageUrl: `https://www.youtube.com/watch?v=${youtubeId}`,
        relatedFiles,
      };
    } catch (apiErr) {
      logger.warn(
        { err: apiErr, youtubeId, code: apiErr?.code },
        'YouTube API fallback also failed'
      );
      return NULL_METADATA;
    }
  }

  /**
   * Find all related files for a video on disk (thumbnail, subtitles, nfo, etc.).
   * Uses the same YouTube ID matching pattern as videoDeletionModule:
   * files containing [youtubeId] or " - youtubeId" in the name.
   * Excludes the main video and audio files (those are shown separately).
   * Returns only fileName, fileSize, and type - internal paths are stripped.
   */
  async _getVideoRelatedFiles(youtubeId) {
    try {
      const video = await Video.findOne({ where: { youtubeId } });
      if (!video || !video.filePath) return null;

      const videoDir = path.dirname(video.filePath);

      let files;
      try {
        files = await fs.readdir(videoDir);
      } catch {
        return null;
      }

      // Filter to files belonging to this video
      const matchingFiles = files.filter(
        file => file.includes(`[${youtubeId}]`) || file.includes(` - ${youtubeId}`)
      );

      // Get file stats and categorize
      const result = [];
      const mainVideoBase = video.filePath ? path.basename(video.filePath) : null;
      const mainAudioBase = video.audioFilePath ? path.basename(video.audioFilePath) : null;

      for (const fileName of matchingFiles) {
        // Skip the main video and audio files (shown separately in the Files section)
        if (fileName === mainVideoBase || fileName === mainAudioBase) continue;

        const fullPath = path.join(videoDir, fileName);
        try {
          const stat = await fs.stat(fullPath);
          const ext = path.extname(fileName).toLowerCase();
          result.push({
            fileName,
            fileSize: stat.size,
            type: this._categorizeFileExtension(ext),
          });
        } catch {
          // File may have been removed between readdir and stat
        }
      }

      return result.length > 0 ? result : null;
    } catch (err) {
      logger.warn({ err, youtubeId }, 'Failed to list related video files');
      return null;
    }
  }

  /**
   * Extract available download resolutions from the yt-dlp formats array,
   * as tiers matching the labels shown elsewhere in the app. Delegates to
   * resolutionTier.js's extractAvailableResolutionTiers, shared with
   * nfoGenerator.js's Jellyfin-facing "Available: ..." tag so both surfaces
   * agree on the same numbers - kept as its own method (rather than calling
   * the shared function directly at the one call site) for test-suite
   * backward compatibility.
   */
  _extractAvailableResolutions(formats) {
    return extractAvailableResolutionTiers(formats);
  }

  /**
   * Parse a YouTube quality tier from a yt-dlp format_note string.
   * Examples: "1080p" -> 1080, "1080p60" -> 1080, "1080p+medium" -> 1080.
   * Returns null if the string isn't present or doesn't start with a tier.
   */
  _extractTierFromFormatNote(formatNote) {
    return parseTierFromFormatNote(formatNote);
  }

  _categorizeFileExtension(ext) {
    return FILE_EXTENSION_CATEGORIES[ext] || 'Other';
  }

  /**
   * Resolve stream info for a video file (video or audio).
   * Looks up the video in the database, checks the file exists on disk,
   * and returns the path, content type, and file size.
   * @param {string} youtubeId - YouTube video ID
   * @param {string} type - 'video' or 'audio'
   * @returns {Promise<{filePath: string, contentType: string, fileSize: number}|null>}
   *   Returns null if video not found; throws with a message property for specific error cases.
   */
  async getVideoStreamInfo(youtubeId, type) {
    const video = await Video.findOne({ where: { youtubeId } });

    let filePath;
    if (video) {
      filePath = type === 'audio' ? video.audioFilePath : video.filePath;
      if (!filePath) {
        return { error: 'no_file', message: `No ${type} file available for this video` };
      }

      // STRM-only entries store a .strm shortcut (or is_strm=true) instead of
      // real media. The in-app player cannot play that text file; callers should
      // redirect to /api/ytstream/:id (see videoDetail stream route).
      const isStrm = Boolean(video.is_strm) || path.extname(filePath).toLowerCase() === '.strm';
      if (isStrm && type === 'video') {
        return {
          isStrm: true,
          youtubeId: video.youtubeId,
          filePath,
        };
      }
    } else {
      // No Videos table row - this id was only ever streamed/previewed, not
      // added to the library. Its one possible local copy is the untracked
      // hls-buffer cache (see ytstream.js's HLS_UNTRACKED_BUFFER_CACHE_DIR),
      // which is always a muxed video+audio .ts keyed by youtubeId alone -
      // there's no audio-only counterpart, so only 'video' can fall back to it.
      if (type !== 'video') {
        return { error: 'not_found', message: 'Video not found' };
      }
      filePath = require('../routes/ytstream').getUntrackedBufferCachePath(youtubeId);
    }

    // Verify file exists on disk
    let stat;
    try {
      await fs.access(filePath);
      stat = await fs.stat(filePath);
    } catch {
      return video
        ? { error: 'file_missing', message: 'File not found on disk' }
        : { error: 'not_found', message: 'Video not found' };
    }

    // .ts (MPEG-TS) isn't in STREAM_MIME_TYPES at all - it falls through to
    // 'application/octet-stream', which the in-app <video> player refuses
    // to play outright (no browser has a native MPEG-TS demuxer for a plain
    // progressive source). Real .ts library files come from the NZB/Sonarr
    // grab pipeline and finalized hls-buffer downloads (tracked or
    // untracked) - swap in a one-time seekable .mp4 remux (see
    // tsRemuxCache) instead of the raw file whenever one exists or can be
    // produced.
    const ext = path.extname(filePath).toLowerCase();
    let servedFilePath = filePath;
    let servedFileSize = stat.size;
    if (ext === '.ts' && type === 'video') {
      const remuxPath = await tsRemuxCache.ensureSeekableMp4(filePath).catch((err) => {
        logger.warn({ err, filePath }, 'videoMetadataModule: .ts remux lookup failed; falling back to the raw file');
        return null;
      });
      if (remuxPath) {
        servedFilePath = remuxPath;
        servedFileSize = (await fs.stat(remuxPath)).size;
      }
    }

    const contentType = servedFilePath === filePath ? (STREAM_MIME_TYPES[ext] || DEFAULT_STREAM_MIME_TYPE) : 'video/mp4';

    return {
      filePath: servedFilePath,
      contentType,
      fileSize: servedFileSize,
      isStrm: false,
    };
  }
}

module.exports = new VideoMetadataModule();
