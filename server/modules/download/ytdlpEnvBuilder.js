const logger = require('../../logger');

// Cap on the serialized owner-channel map passed to the post-processor via an
// environment variable. Linux limits a single env var to ~128KB (MAX_ARG_STRLEN);
// stay well under it. A typical entry is ~40 bytes, so this covers thousands of videos.
const OWNER_CHANNEL_MAP_MAX_BYTES = 64 * 1024;

// The YOUTARR_* variables are read by the post-processor script to route
// files and set ratings.
function buildYtdlpEnv({ jobId, tempBasePath, postProcessDirectives, baseEnv = process.env }) {
  const {
    subfolderOverride = null,
    subfolderFallback = null,
    ratingOverride = undefined,
    ratingFallback = null,
    libraryModeFallback = null,
    skipVideoFolder = false,
    structurePerVideo = false,
    skipVideoFolderOverride = undefined,
    ownerChannelId = null,
    ownerChannelMap = null,
    strmCacheTarget = null,
    seriesSeasonOverride = null,
    seriesEpisodeOverride = null,
    skipMediaSidecarFiles = false,
  } = postProcessDirectives || {};

  const env = {
    ...baseEnv,
    YOUTARR_JOB_ID: jobId,
    TMPDIR: tempBasePath,
  };

  if (subfolderOverride !== null && subfolderOverride !== undefined) {
    env.YOUTARR_SUBFOLDER_OVERRIDE = subfolderOverride;
  }

  // Soft fallback: post-processor uses it only when the video's real channel is untracked
  if (subfolderFallback !== null && subfolderFallback !== undefined) {
    env.YOUTARR_SUBFOLDER_FALLBACK = subfolderFallback;
  }

  if (skipVideoFolder) {
    env.YOUTARR_SKIP_VIDEO_FOLDER = 'true';
  }

  // Per-video structure mode: the post-processor resolves flat-vs-subfolder
  // per video (override -> channel -> global) instead of using the fixed
  // per-job layout. The override is only present when the user chose one.
  if (structurePerVideo) {
    env.YOUTARR_STRUCTURE_PER_VIDEO = 'true';
  }
  if (skipVideoFolderOverride !== undefined) {
    env.YOUTARR_SKIP_VIDEO_FOLDER_OVERRIDE = String(!!skipVideoFolderOverride);
  }

  // null is the explicit "clear rating" sentinel -> 'NR'
  if (ratingOverride !== undefined) {
    env.YOUTARR_OVERRIDE_RATING = ratingOverride === null ? 'NR' : String(ratingOverride);
  }

  // Soft fallback: post-processor uses it only when the real channel has no default rating
  if (ratingFallback !== null && ratingFallback !== undefined) {
    env.YOUTARR_RATING_FALLBACK = String(ratingFallback);
  }

  // Soft fallback: post-processor uses it only when the video's real channel
  // has no library_mode override (a playlist's library_mode setting)
  if (libraryModeFallback !== null && libraryModeFallback !== undefined) {
    env.YOUTARR_LIBRARY_MODE_FALLBACK = String(libraryModeFallback);
  }

  // The post-processor prefers it over the video's own channel_id when resolving the owner
  if (ownerChannelId !== null && ownerChannelId !== undefined && String(ownerChannelId).trim() !== '') {
    env.YOUTARR_OWNER_CHANNEL_ID = String(ownerChannelId).trim();
  }

  // The post-processor looks up its own youtube_id, so a superset map is fine
  if (ownerChannelMap && typeof ownerChannelMap === 'object' && Object.keys(ownerChannelMap).length > 0) {
    try {
      const serialized = JSON.stringify(ownerChannelMap);
      if (serialized.length <= OWNER_CHANNEL_MAP_MAX_BYTES) {
        env.YOUTARR_OWNER_CHANNEL_MAP = serialized;
      } else {
        logger.warn({ bytes: serialized.length }, 'owner channel map exceeds env size cap; per-video owner resolution skipped');
      }
    } catch (err) {
      logger.warn({ err }, 'could not serialize owner channel map');
    }
  }

  // STRM cache-on-play: pin the post-processor's final path to the exact
  // folder the existing .strm/sidecars already live in - see the
  // strmCacheTargetDir/strmCacheFileStem handling in videoDownloadPostProcessFiles.js.
  if (strmCacheTarget && strmCacheTarget.targetDir && strmCacheTarget.fileStem) {
    env.YOUTARR_STRM_CACHE_TARGET_DIR = strmCacheTarget.targetDir;
    env.YOUTARR_STRM_CACHE_FILE_STEM = strmCacheTarget.fileStem;
  }

  // Real season/episode from an NZB grab's tvsearch (see
  // server/routes/nzb.js) - the post-processor uses these instead of
  // seriesEpisodeResolver's upload-year-as-season default when both are
  // present. Only meaningful for a single-video job (NZB grabs are always
  // exactly one URL), so there's no risk of one video's override leaking
  // onto another video in the same job.
  if (seriesSeasonOverride !== null && seriesEpisodeOverride !== null) {
    env.YOUTARR_SERIES_SEASON_OVERRIDE = String(seriesSeasonOverride);
    env.YOUTARR_SERIES_EPISODE_OVERRIDE = String(seriesEpisodeOverride);
  }

  // NZB grabs (see server/routes/nzb.js): Sonarr/Radarr generate their own
  // artwork/nfo on import, so the post-processor skips writing its own
  // nfo/season.nfo/tvshow.nfo/fanart/backdrop/poster and drops the swept-in
  // thumbnail jpg, leaving just the video file itself.
  if (skipMediaSidecarFiles) {
    env.YOUTARR_SKIP_MEDIA_SIDECAR_FILES = 'true';
  }

  return env;
}

module.exports = { buildYtdlpEnv, OWNER_CHANNEL_MAP_MAX_BYTES };
