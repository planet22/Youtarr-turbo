const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const videoPersistence = require('./videoPersistence');
const { STRM_CACHE_LABEL_PREFIX } = require('./strmCacheOnPlay');

/**
 * server/routes/ytstream.js mode=hls-tap: called from spawnHlsEncodePass's
 * tap-specific `close` listener only when the tapped ffmpeg output finished
 * cleanly (exit code 0, not killed, session not tearing down, still the
 * current pass). Moves the finished temp file into the STRM video's real
 * library location and updates the Video row - same DB bookkeeping a real
 * strmCacheOnPlay download job would have done, minus the parts already
 * covered by strmMaterializer at channel-sync time (NFO/thumbnail/poster/
 * media-info cache all already exist for this row - see strmMaterializer.js,
 * which writes all of that BEFORE the .strm file itself, specifically so
 * nothing ever needs to backfill it later).
 *
 * @param {string} [sourceLabel] - distinguishes the synthetic jobType tag
 *   (see jobInstance below) between callers that share this same
 *   move-into-library + upsertVideoForJob logic - mode=hls-tap (the
 *   default, unchanged for backward compat) vs mode=hls-buffer's
 *   independent buffer-fetch finalizer (server/modules/ytstreamBufferFetch.js).
 * @returns {Promise<string|null>} the final file path on success, else null
 */
async function finalizeTapOutput({ youtubeId, tempPath, finalPath, sourceLabel = 'hls-tap' }) {
  try {
    if (!tempPath || !fs.existsSync(tempPath)) return null;
    const tempStat = fs.statSync(tempPath);
    if (!tempStat.size) {
      fs.unlink(tempPath, () => {});
      return null;
    }

    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    // tempPath lives under the HLS session's own fast local temp dir (see
    // ytstream.js's createHlsSessionInternal - deliberately NOT inside the
    // video's own library folder, to keep the tap's continuous writes off
    // whatever storage backs that folder), so this is very likely a
    // cross-device move - a plain rename would throw EXDEV. Try the cheap
    // same-device path first (works if some deployment's setup happens to
    // put them on the same filesystem), fall back to copy+unlink otherwise.
    try {
      fs.renameSync(tempPath, finalPath);
    } catch (err) {
      if (err.code !== 'EXDEV') throw err;
      fs.copyFileSync(tempPath, finalPath);
      fs.unlinkSync(tempPath);
    }

    const fileSize = fs.statSync(finalPath).size;

    // Reusing STRM_CACHE_LABEL_PREFIX as the synthetic jobType tag makes
    // upsertVideoForJob set cached_at automatically, piggybacking this
    // finalized row onto the *existing* cacheOnPlayExpiryHours nightly
    // sweep/revert-to-STRM lifecycle (videoDeletionModule.sweepExpiredCachedVideos
    // only checks is_strm===false && cached_at, not how it got set) - no
    // new expiry mechanism needed. alwaysCreateJobVideo:false means no
    // real, persisted Job row is required - jobInstance.id is never
    // dereferenced in that path.
    const jobInstance = { jobType: `${STRM_CACHE_LABEL_PREFIX}${youtubeId} (${sourceLabel})` };
    await videoPersistence.upsertVideoForJob(
      { youtubeId, filePath: finalPath, fileSize, is_strm: false },
      jobInstance,
      false
    );

    logger.info({ youtubeId, finalPath, sourceLabel }, 'ytstream: finalized - live stream tap/buffer saved as permanent download');
    return finalPath;
  } catch (err) {
    logger.warn({ err, youtubeId, tempPath, finalPath, sourceLabel }, 'ytstream: tap/buffer finalize failed');
    return null;
  }
}

/**
 * Deletes an incomplete/abandoned tap or buffer output - never left on disk,
 * never treated as done.
 * @param {string} [sourceLabel] - see finalizeTapOutput's doc comment; used
 *   only for this log line's accuracy, no functional effect.
 */
function discardTapOutput({ youtubeId, tempPath, sourceLabel = 'hls-tap' }) {
  if (!tempPath) return;
  fs.unlink(tempPath, (err) => {
    if (err && err.code !== 'ENOENT') {
      logger.warn({ err, youtubeId, tempPath, sourceLabel }, 'ytstream: failed to discard incomplete tap/buffer output');
    }
  });
}

module.exports = { finalizeTapOutput, discardTapOutput };
