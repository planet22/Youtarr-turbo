/**
 * server/modules/ytstream/untrackedBufferCache.js
 *
 * CRUD + sweep helpers for mode=hls-buffer's untracked-video file cache
 * (see paths.js's HLS_UNTRACKED_BUFFER_CACHE_DIR doc comment for what lands
 * here and why). Extracted from server/routes/ytstream.js; several of these
 * functions are re-exported as attached statics on that file's own module
 * export for cronJobs.js, videosModule.js, and videoMetadataModule.js to
 * reach directly - see ytstream.js's own export block for that wiring.
 */
const fs = require('fs');
const path = require('path');
const logger = require('../../logger');
const configModule = require('../configModule');
const { HLS_UNTRACKED_BUFFER_CACHE_DIR } = require('./paths');
const { streamDebug } = require('./streamDebug');

function getUntrackedBufferCachePath(youtubeId) {
  return path.join(HLS_UNTRACKED_BUFFER_CACHE_DIR, `${youtubeId}.ts`);
}

// ytstream.finalizeToMp4 + (stealthCache on, or genuinely untracked): once a
// hidden .ts is remuxed, swapHiddenCacheToMp4 makes this .mp4 the hidden
// cache's new canonical file and deletes the .ts - so "does a warm hidden
// cache already exist for this youtubeId" has to check both extensions.
function getUntrackedBufferCacheMp4Path(youtubeId) {
  return path.join(HLS_UNTRACKED_BUFFER_CACHE_DIR, `${youtubeId}.mp4`);
}

/**
 * @param {string} youtubeId
 * @returns {string|null} whichever of the hidden cache's two possible files
 *   (.mp4 preferred - it's what a completed swapHiddenCacheToMp4 leaves
 *   behind - falling back to .ts) currently exists, or null if neither does.
 */
function findWarmUntrackedBufferCache(youtubeId) {
  const mp4Path = getUntrackedBufferCacheMp4Path(youtubeId);
  if (fs.existsSync(mp4Path)) {
    streamDebug({ youtubeId, filePath: mp4Path }, 'ytstream: findWarmUntrackedBufferCache found a warm .mp4');
    return mp4Path;
  }
  const tsPath = getUntrackedBufferCachePath(youtubeId);
  const found = fs.existsSync(tsPath) ? tsPath : null;
  streamDebug({ youtubeId, filePath: found }, found ? 'ytstream: findWarmUntrackedBufferCache found a warm .ts' : 'ytstream: findWarmUntrackedBufferCache found nothing');
  return found;
}

/**
 * Age-based cleanup for the untracked hls-buffer cache - the untracked
 * counterpart to videoDeletionModule.sweepExpiredCachedVideos(), which only
 * covers tracked library videos (there's a real Video row there to stamp
 * cached_at on and later revert to STRM). An untracked video has no such
 * row, so file mtime stands in for "how long has this been cached" instead.
 * Reuses strm.cacheOnPlayExpiryHours - no separate setting - so one number
 * governs both caches' aging. No-op when unset/<=0, same convention as
 * sweepExpiredCachedVideos. Called from cronJobs.js's existing 2:10 AM sweep.
 * @returns {Promise<{deleted: number, freedBytes: number, thresholdHours: number}>}
 */
async function sweepExpiredUntrackedBufferCache() {
  const config = configModule.getConfig();
  const thresholdHours = parseInt(config.strm?.cacheOnPlayExpiryHours, 10);
  if (!Number.isFinite(thresholdHours) || thresholdHours <= 0) {
    return { deleted: 0, freedBytes: 0, thresholdHours: 0 };
  }
  const cutoffMs = Date.now() - thresholdHours * 60 * 60 * 1000;
  let deleted = 0;
  let freedBytes = 0;
  if (fs.existsSync(HLS_UNTRACKED_BUFFER_CACHE_DIR)) {
    const entries = await fs.promises.readdir(HLS_UNTRACKED_BUFFER_CACHE_DIR);
    for (const entry of entries) {
      const filePath = path.join(HLS_UNTRACKED_BUFFER_CACHE_DIR, entry);
      try {
        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile() || stat.mtimeMs >= cutoffMs) continue;
        await fs.promises.unlink(filePath);
        deleted += 1;
        freedBytes += stat.size;
      } catch (err) {
        logger.warn({ err, filePath }, 'ytstream: failed to expire one untracked buffer cache file');
      }
    }
  }
  if (deleted > 0) {
    logger.info({ deleted, freedBytes, thresholdHours }, 'ytstream: swept expired untracked buffer cache files');
  }
  return { deleted, freedBytes, thresholdHours };
}

/**
 * Single-entry stat for the Library page's per-video "Cached Video" icon on
 * an untracked row - mirrors the aggregate GET /api/ytstream/untracked-cache
 * route's own fs.stat call, just scoped to one youtubeId.
 * @returns {Promise<{exists: boolean, size: number|null, mtime: string|null}>}
 */
async function getUntrackedBufferCacheStat(youtubeId) {
  try {
    const filePath = findWarmUntrackedBufferCache(youtubeId);
    if (!filePath) return { exists: false, size: null, mtime: null };
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return { exists: false, size: null, mtime: null };
    return { exists: true, size: stat.size, mtime: stat.mtime.toISOString() };
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, size: null, mtime: null };
    throw err;
  }
}

/**
 * Deletes one untracked buffer cache file (whichever of .ts/.mp4 currently
 * represents it - see findWarmUntrackedBufferCache); returns whether one
 * existed to delete.
 */
async function deleteUntrackedBufferCacheFile(youtubeId) {
  const filePath = findWarmUntrackedBufferCache(youtubeId);
  if (!filePath) return false;
  try {
    await fs.promises.unlink(filePath);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Every untracked buffer cache entry, for the Library page's "Show
 * untracked" bucket (videosModule.js's _getUntrackedCandidates) to merge
 * against youtube_metadata_cache rows. Recognizes both the raw .ts a fresh
 * fetch always lands first, and the .mp4 swapHiddenCacheToMp4 leaves in its
 * place once finalizeToMp4 remuxes it (see findWarmUntrackedBufferCache).
 * @returns {Promise<Array<{youtubeId: string, size: number, mtime: string}>>}
 */
async function listUntrackedBufferCacheEntries() {
  if (!fs.existsSync(HLS_UNTRACKED_BUFFER_CACHE_DIR)) return [];
  const entries = await fs.promises.readdir(HLS_UNTRACKED_BUFFER_CACHE_DIR);
  const results = [];
  for (const entry of entries) {
    const ext = path.extname(entry);
    if (ext !== '.ts' && ext !== '.mp4') continue;
    try {
      const filePath = path.join(HLS_UNTRACKED_BUFFER_CACHE_DIR, entry);
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) continue;
      results.push({ youtubeId: entry.slice(0, -ext.length), size: stat.size, mtime: stat.mtime.toISOString(), filePath });
    } catch (err) {
      logger.warn({ err, entry }, 'ytstream: failed to stat one untracked buffer cache entry while listing');
    }
  }
  return results;
}

module.exports = {
  getUntrackedBufferCachePath,
  getUntrackedBufferCacheMp4Path,
  findWarmUntrackedBufferCache,
  sweepExpiredUntrackedBufferCache,
  getUntrackedBufferCacheStat,
  deleteUntrackedBufferCacheFile,
  listUntrackedBufferCacheEntries,
};
