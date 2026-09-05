const logger = require('../logger');
// Lazy, not top-level: this module's YOUTUBE_METADATA_CACHE_RETENTION_DAYS
// constant is imported by places (e.g. videosModule.js's Library query)
// that don't necessarily want to eagerly initialize the Sequelize model
// (and its ../db dependency) just to read a number.
const getModel = () => require('../models/youtubemetadatacache');

/**
 * Shared fps/raw-yt-dlp-extraction cache (youtube_metadata_cache -
 * migrations/20260904160000-add-raw-info-json-to-youtube-metadata-cache.js)
 * - the single place every producer of a full yt-dlp extraction blob
 * (server/routes/ytstream.js's live-streaming warm-up, the real-download
 * pipeline's already-fetched .info.json, STRM materialization's own
 * metadata fetch) writes to, so the same video is never independently
 * re-fetched by more than one of those paths, and any of them can read
 * back what another one already learned.
 *
 * fps never changes for a given video, so in-memory entries never expire.
 *
 * IMPORTANT - what's safe to read back out of a stored raw_info_json blob,
 * and what is NOT: duration, fps, resolution, codec, uploader/channel,
 * upload date, title/description are all immutable facts about the video's
 * encoded content - safe to treat as permanently cached, same as this
 * module already does for fps. NEVER treat `formats[].url` / any direct
 * CDN or manifest URL, or subtitle/caption track URLs, as safe to reuse
 * from a stored blob - those are cryptographically signed and expire on
 * the order of hours, completely unrelated to how long this cache keeps a
 * row around; a future feature that wants a playback URL must always
 * re-resolve one live, never pull it from here. Similarly, view/like/comment
 * counts, availability/live_status, and age-restriction/privacy state can
 * all change after the blob was cached - fine to show as a rough
 * historical snapshot, never safe to make a playback/access DECISION from
 * a stored copy instead of a fresh check.
 */
const fpsCache = new Map();
const maxHeightCache = new Map();

// Single source of truth for how long a row survives since it was last
// accessed - cronJobs.js's nightly prune sweep and the Library page's
// per-video expiry countdown both read this same value.
const YOUTUBE_METADATA_CACHE_RETENTION_DAYS = 365;

/**
 * fps lookup - memory then the persistent DB row's raw_info_json blob.
 * @param {string} youtubeId
 * @returns {Promise<number|null>}
 */
async function getCachedFps(youtubeId) {
  if (fpsCache.has(youtubeId)) return fpsCache.get(youtubeId);
  try {
    const cached = await getModel().findByPk(youtubeId);
    if (!cached || !cached.raw_info_json) return null;
    const info = JSON.parse(cached.raw_info_json);
    const fps = Number(info && info.fps);
    if (Number.isFinite(fps) && fps > 0) {
      fpsCache.set(youtubeId, fps);
      return fps;
    }
  } catch (err) {
    logger.warn({ err, youtubeId }, 'youtubeMetadataCache: fps lookup failed');
  }
  return null;
}

/**
 * True best-available video height (what an uncapped `-f bv*` would select)
 * - memory then the persistent DB row's raw_info_json blob, computed as the
 * max `height` across `formats` entries that carry a real video codec.
 * Replaces ytstream.js's own live `-f bv* --print height` yt-dlp call
 * (resolveMaxAvailableHeight) whenever this video's metadata is already
 * cached from any producer (streaming, download, or STRM generation).
 * @param {string} youtubeId
 * @returns {Promise<number|null>}
 */
async function getCachedMaxHeight(youtubeId) {
  if (maxHeightCache.has(youtubeId)) return maxHeightCache.get(youtubeId);
  try {
    const cached = await getModel().findByPk(youtubeId);
    if (!cached || !cached.raw_info_json) return null;
    const info = JSON.parse(cached.raw_info_json);
    const heights = (info && info.formats ? info.formats : [])
      .filter((f) => f && f.vcodec && f.vcodec !== 'none')
      .map((f) => Number(f.height))
      .filter((h) => Number.isFinite(h) && h > 0);
    if (!heights.length) return null;
    const maxHeight = Math.max(...heights);
    maxHeightCache.set(youtubeId, maxHeight);
    return maxHeight;
  } catch (err) {
    logger.warn({ err, youtubeId }, 'youtubeMetadataCache: max-height lookup failed');
  }
  return null;
}

/**
 * Persists a full yt-dlp extraction (memory fps + the DB row's
 * raw_info_json) - call this from anywhere that already has one in hand,
 * so it's never independently re-fetched elsewhere. `info` is the PARSED
 * yt-dlp JSON object (--dump-single-json/-j shape); stringified once here
 * for storage. `durationSeconds` is required so a brand-new row still
 * satisfies duration_seconds' NOT NULL constraint.
 * @param {string} youtubeId
 * @param {number} durationSeconds
 * @param {object} info
 */
function cacheRawInfoJson(youtubeId, durationSeconds, info) {
  if (!info) return;
  const fps = Number(info.fps);
  if (Number.isFinite(fps) && fps > 0) {
    fpsCache.set(youtubeId, fps);
  }
  const heights = (info.formats || [])
    .filter((f) => f && f.vcodec && f.vcodec !== 'none')
    .map((f) => Number(f.height))
    .filter((h) => Number.isFinite(h) && h > 0);
  if (heights.length) {
    maxHeightCache.set(youtubeId, Math.max(...heights));
  }
  const seconds = Number(durationSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  const now = new Date();
  getModel().upsert({
    youtube_id: youtubeId,
    duration_seconds: Math.round(seconds),
    raw_info_json: JSON.stringify(info),
    fetched_at: now,
    last_accessed_at: now,
  }).catch((err) => {
    logger.warn({ err, youtubeId }, 'youtubeMetadataCache: failed to persist raw_info_json');
  });
}

/**
 * Full parsed raw_info_json blob for a video plus when it was fetched, or
 * null if there's no row or no blob. Read-only counterpart to
 * cacheRawInfoJson, for a consumer (e.g. the video modal's getVideoMetadata)
 * that wants the whole cached yt-dlp extraction rather than just
 * fps/max-height - see this module's top-level doc comment for what's safe
 * to read out of it and what emphatically isn't (signed CDN/format URLs).
 * `fetchedAt` is returned alongside the data (rather than just the data) so
 * callers can tell a consumer of THEIR OWN response when the underlying
 * extraction actually happened, instead of it silently looking live.
 * @param {string} youtubeId
 * @returns {Promise<{data: object, fetchedAt: string}|null>}
 */
async function getCachedRawInfoJson(youtubeId) {
  try {
    const cached = await getModel().findByPk(youtubeId);
    if (!cached || !cached.raw_info_json) return null;
    return {
      data: JSON.parse(cached.raw_info_json),
      fetchedAt: cached.fetched_at instanceof Date ? cached.fetched_at.toISOString() : cached.fetched_at,
    };
  } catch (err) {
    logger.warn({ err, youtubeId }, 'youtubeMetadataCache: raw info json lookup failed');
    return null;
  }
}

/** Manual re-cache trigger's in-memory half - see ytstream.js's DELETE route for the DB-row half. */
function clearCachedEntry(youtubeId) {
  fpsCache.delete(youtubeId);
  maxHeightCache.delete(youtubeId);
}

/** Total cached rows - Settings UI's "Cached video metadata" count. */
async function countCached() {
  return getModel().count();
}

/** Bulk clear-all - Settings UI's "Clear cached video metadata" button. */
async function clearAll() {
  fpsCache.clear();
  maxHeightCache.clear();
  return getModel().destroy({ truncate: true });
}

module.exports = {
  getCachedFps,
  getCachedMaxHeight,
  getCachedRawInfoJson,
  cacheRawInfoJson,
  clearCachedEntry,
  countCached,
  clearAll,
  YOUTUBE_METADATA_CACHE_RETENTION_DAYS,
};
