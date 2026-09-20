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
const durationCache = new Map();

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
 * Duration lookup - memory then the persistent DB row's duration_seconds
 * column directly. Unlike fps/max-height, this is a plain NOT-NULL column
 * rather than something computed from raw_info_json, so it's populated even
 * for a row written by a duration-only producer that never had a full
 * extraction to store. Replaces playbackPlan.js's own live `-j` yt-dlp call
 * (getVideoDurationSeconds) whenever this video's duration is already known
 * from any producer (streaming, download, or STRM generation).
 * @param {string} youtubeId
 * @returns {Promise<number|null>}
 */
async function getCachedDurationSeconds(youtubeId) {
  if (durationCache.has(youtubeId)) return durationCache.get(youtubeId);
  try {
    const cached = await getModel().findByPk(youtubeId);
    if (!cached) return null;
    const seconds = Number(cached.duration_seconds);
    if (Number.isFinite(seconds) && seconds > 0) {
      durationCache.set(youtubeId, seconds);
      // Fire-and-forget - a stale last_accessed_at just means this row
      // might get swept a bit early, never a correctness issue.
      cached.update({ last_accessed_at: new Date() }).catch((err) => {
        logger.warn({ err, youtubeId }, 'youtubeMetadataCache: failed to bump last_accessed_at');
      });
      return seconds;
    }
  } catch (err) {
    logger.warn({ err, youtubeId }, 'youtubeMetadataCache: duration lookup failed');
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
  durationCache.set(youtubeId, seconds);
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

// In-flight dedup for getOrFetchRawInfoJson - two concurrent callers for
// the same uncached video (e.g. one needing duration, another needing
// height) share one live fetch instead of each spawning their own.
const infoLookupPromises = new Map();

/**
 * This video's full yt-dlp extraction - from the persistent cache if any
 * producer already populated it, otherwise one live fetch via `fetchFn`
 * (caller-supplied, since fetching is domain-specific - e.g. ytstream's
 * player_client override - while caching is not), persisted for every
 * future caller regardless of who asked.
 * @param {string} youtubeId
 * @param {() => Promise<object>} fetchFn - resolves to a parsed yt-dlp -j object
 * @returns {Promise<object>}
 */
async function getOrFetchRawInfoJson(youtubeId, fetchFn) {
  if (infoLookupPromises.has(youtubeId)) return infoLookupPromises.get(youtubeId);

  const lookup = (async () => {
    const cached = await getCachedRawInfoJson(youtubeId);
    if (cached) return cached.data;
    const info = await fetchFn();
    cacheRawInfoJson(youtubeId, info.duration, info);
    return info;
  })();

  infoLookupPromises.set(youtubeId, lookup);
  try {
    return await lookup;
  } finally {
    infoLookupPromises.delete(youtubeId);
  }
}

/**
 * Manual re-cache trigger (Library page's per-video/bulk "Clear Cached
 * Metadata" action) - clears the in-memory caches and destroys the DB row,
 * so the next stream/download/STRM pass relearns it from scratch.
 * @param {string} youtubeId
 * @returns {Promise<number>} rows destroyed (0 or 1)
 */
async function deleteEntry(youtubeId) {
  fpsCache.delete(youtubeId);
  maxHeightCache.delete(youtubeId);
  durationCache.delete(youtubeId);
  return getModel().destroy({ where: { youtube_id: youtubeId } });
}

/** Total cached rows - Settings UI's "Cached video metadata" count. */
async function countCached() {
  return getModel().count();
}

/** Bulk clear-all - Settings UI's "Clear cached video metadata" button. */
async function clearAll() {
  fpsCache.clear();
  maxHeightCache.clear();
  durationCache.clear();
  return getModel().destroy({ truncate: true });
}

/**
 * Batched title lookup for videos with a cached extraction but no other
 * title source (e.g. an NZB-only grab, or a Video row since removed) - the
 * Streaming page's Stream History title fallback.
 * @param {string[]} youtubeIds
 * @returns {Promise<Record<string,string>>} youtubeId -> title, only for ids that had one cached
 */
async function getCachedTitles(youtubeIds) {
  const titles = {};
  if (!youtubeIds || !youtubeIds.length) return titles;
  try {
    const rows = await getModel().findAll({
      where: { youtube_id: youtubeIds },
      attributes: ['youtube_id', 'raw_info_json'],
    });
    for (const row of rows) {
      if (!row.raw_info_json) continue;
      try {
        const info = JSON.parse(row.raw_info_json);
        if (info && info.title) titles[row.youtube_id] = info.title;
      } catch (err) {
        logger.warn({ err, youtubeId: row.youtube_id }, 'youtubeMetadataCache: failed to parse cached raw_info_json for title fallback');
      }
    }
  } catch (err) {
    logger.warn({ err }, 'youtubeMetadataCache: batched title lookup failed');
  }
  return titles;
}

/**
 * Full detail for the Library page's "Cached Metadata" dialog - everything
 * about one video's cache row, with raw_info_json already parsed into its
 * commonly-shown fields. `rawInfoJson` is always included here (the caller
 * decides whether to actually forward the (potentially large) blob in an
 * HTTP response - see server/routes/ytstream.js's `?raw=true` opt-in).
 * @param {string} youtubeId
 * @returns {Promise<object|null>} null if nothing is cached for this video
 */
async function getCacheDetail(youtubeId) {
  const row = await getModel().findByPk(youtubeId);
  if (!row) return null;

  let info = null;
  if (row.raw_info_json) {
    try {
      info = JSON.parse(row.raw_info_json);
    } catch (err) {
      logger.warn({ err, youtubeId }, 'youtubeMetadataCache: failed to parse cached raw_info_json');
    }
  }

  const expiresAt = row.last_accessed_at
    ? new Date(new Date(row.last_accessed_at).getTime() + YOUTUBE_METADATA_CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
    : null;

  return {
    durationSeconds: row.duration_seconds,
    fetchedAt: row.fetched_at,
    lastAccessedAt: row.last_accessed_at,
    expiresAt,
    title: info?.title ?? null,
    uploader: info?.uploader ?? info?.channel ?? null,
    resolution: info && info.width && info.height ? `${info.width}x${info.height}` : null,
    fps: info?.fps ?? null,
    uploadDate: info?.upload_date ?? null,
    // False for a row written by the cheap calculatedLength duration-only
    // probe (getVideoDurationSeconds) for a video that's never actually
    // streamed/downloaded/materialized past that - lets the client tell
    // "nothing here yet" apart from "something broke" for free.
    hasRawInfoJson: Boolean(row.raw_info_json),
    rawInfoJson: info,
  };
}

module.exports = {
  getCachedFps,
  getCachedDurationSeconds,
  getCachedMaxHeight,
  getCachedRawInfoJson,
  getOrFetchRawInfoJson,
  getCachedTitles,
  getCacheDetail,
  cacheRawInfoJson,
  deleteEntry,
  countCached,
  clearAll,
  YOUTUBE_METADATA_CACHE_RETENTION_DAYS,
};
