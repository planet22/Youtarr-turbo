const path = require('path');
const logger = require('../logger');

/**
 * Opportunistically caches a STRM library item to a real downloaded file the
 * first time it's played, so a later play (or a media server's own re-scan)
 * uses a local file instead of live-proxying/piping through /api/ytstream.
 *
 * Trigger point: server/routes/ytstream.js calls maybeEnqueueCacheDownload
 * fire-and-forget, before doing any of its own (unrelated) resolve/stream
 * work - this module's job is only to decide whether to enqueue a normal
 * background download job, never to affect the live playback response.
 */

const STRM_CACHE_LABEL_PREFIX = 'STRM Cache: ';

// This job runs silently in the background while someone may be actively
// watching this exact video live through /api/ytstream - an unthrottled
// download easily saturates bandwidth the live session's own yt-dlp/ffmpeg
// fetch needs, which can stall it indefinitely (observed live: a seek's
// direct-URL ffmpeg fetch never completed, error or otherwise, while this
// job pulled the same video at 10-20MB/s). Independent of the user's own
// (opt-in, often unset) global ytdlpDownloadRateLimit - this cap applies
// only to this specific background-while-watching job.
const CACHE_ON_PLAY_RATE_LIMIT = '3M';

// Synchronous race guard only - closes the window between two concurrent
// requests for the same video both passing the DB/job checks before either
// has actually finished calling jobModule.addOrUpdateJob (which happens
// after an await). The durable in-flight guard for the full job lifetime is
// hasActiveCacheJob() below, which reads jobModule's own live state.
const pendingEnqueue = new Set();

function isFeatureEnabled(config) {
  const strm = (config && config.strm) || {};
  // Explicit opt-in (=== true), not the `!== false` pattern used by
  // writeNfo/writeThumbnail/writeMediaInfoCache - this changes disk usage
  // behavior, unlike those, so it must default off for existing configs.
  return strm.cacheOnPlay === true;
}

/**
 * @param {string} youtubeId
 * @returns {boolean} true if a Pending/In-Progress cache job for this video
 *   is already sitting in jobModule's queue.
 */
function hasActiveCacheJob(youtubeId) {
  const jobModule = require('./jobModule');
  const needle = `[${youtubeId}]`;
  const jobs = jobModule.getAllJobs ? jobModule.getAllJobs() : {};
  return Object.values(jobs).some((j) =>
    (j.status === 'Pending' || j.status === 'In Progress') &&
    typeof j.jobType === 'string' &&
    j.jobType.startsWith(STRM_CACHE_LABEL_PREFIX) &&
    j.jobType.endsWith(needle)
  );
}

/**
 * Shared enqueue core for both the automatic (play-triggered) and manual
 * (force-download button) callers. Looks up the video, runs the disk-space
 * preflight, and enqueues the same STRM-cache download job either way.
 * @param {string} youtubeId
 * @returns {Promise<{queued: boolean, reason?: string}>}
 */
async function _enqueueCacheDownload(youtubeId) {
  const Video = require('../models/video');
  const video = await Video.findOne({
    where: { youtubeId },
    attributes: ['youtubeId', 'youTubeVideoName', 'filePath', 'is_strm', 'channel_id'],
  });
  // Already a real download (also covers mediaMode:'both' rows) - nothing to do.
  if (!video || video.is_strm !== true || !video.filePath) {
    return { queued: false, reason: 'not-strm' };
  }
  if (hasActiveCacheJob(youtubeId)) return { queued: false, reason: 'already-queued' };

  const configModule = require('./configModule');
  const config = configModule.getConfig();

  // Pre-flight disk space check - never blocks/errors playback, log-only.
  const threshold = config.autoRemovalFreeSpaceThreshold;
  if (threshold) {
    const status = await configModule.getStorageStatus();
    if (status && configModule.isStorageBelowThreshold(status.available, threshold)) {
      logger.info({ youtubeId, availableGB: status.availableGB }, 'STRM cache-on-play: skipped, storage below auto-removal threshold');
      return { queued: false, reason: 'low-disk-space' };
    }
  }

  const targetDir = path.dirname(video.filePath);
  const fileStem = path.basename(video.filePath, path.extname(video.filePath)); // strip .strm

  logger.info({ youtubeId, targetDir, fileStem }, 'STRM cache-on-play: enqueuing background download');

  const downloadModule = require('./downloadModule');
  await downloadModule.doSpecificDownloads({
    body: {
      urls: [`https://www.youtube.com/watch?v=${youtubeId}`],
      jobLabel: `${STRM_CACHE_LABEL_PREFIX}${video.youTubeVideoName || youtubeId} [${youtubeId}]`,
      overrideSettings: {
        // Forces a real download regardless of the channel/global mediaMode
        // ('strm' or 'both'), which would otherwise re-materialize the .strm
        // via doSpecificDownloads's own STRM early-exit branch.
        mediaMode: 'download',
        // See CACHE_ON_PLAY_RATE_LIMIT above.
        ytdlpRateLimitOverride: CACHE_ON_PLAY_RATE_LIMIT,
      },
      channelId: video.channel_id || undefined,
      // Path-consistency pin - see videoDownloadPostProcessFiles.js's
      // strmCacheTargetDir/strmCacheFileStem handling. Bypasses re-resolving
      // libraryMode/subFolder/season/episode entirely: the real file must
      // land in the exact folder the existing .strm/.nfo/.jpg already live
      // in, not wherever current channel settings would independently
      // resolve to (which may have changed since the .strm was written).
      strmCacheTarget: { targetDir, fileStem },
    },
  });
  // doSpecificDownloads only awaits through enqueueing (jobModule.addOrUpdateJob),
  // not full job completion, same as every other caller. This enqueues as a
  // normal 'Pending' job - the only existing concurrency guard (one global
  // in-progress job) - it never jumps ahead of anything already queued.
  return { queued: true };
}

/**
 * @param {string} youtubeId
 * @param {{skip?: boolean}} [opts] - skip: true when ytstream.js's own
 *   mode=hls-buffer is about to start its own independent fetch
 *   (see its cheap, synchronous pre-check ahead of this call) - no second
 *   pull needed either way.
 * @returns {Promise<void>} never throws; every failure is logged and swallowed
 */
async function maybeEnqueueCacheDownload(youtubeId, opts = {}) {
  if (pendingEnqueue.has(youtubeId)) return;

  const configModule = require('./configModule');
  const config = configModule.getConfig();
  if (!isFeatureEnabled(config)) return;
  if (opts.skip) return;
  if (hasActiveCacheJob(youtubeId)) return;

  pendingEnqueue.add(youtubeId);
  try {
    await _enqueueCacheDownload(youtubeId);
  } catch (err) {
    logger.warn({ err, youtubeId }, 'STRM cache-on-play: enqueue failed');
  } finally {
    pendingEnqueue.delete(youtubeId);
  }
}

/**
 * Manual "force download now" trigger for the STRM chip's click action -
 * unlike maybeEnqueueCacheDownload, this does NOT require the global
 * `strm.cacheOnPlay` setting to be on: an explicit click is unambiguous
 * intent on its own. Still respects the same in-flight/disk-space guards.
 * @param {string} youtubeId
 * @returns {Promise<{queued: boolean, reason?: string}>}
 */
async function forceEnqueueCacheDownload(youtubeId) {
  if (pendingEnqueue.has(youtubeId)) return { queued: false, reason: 'already-queued' };
  if (hasActiveCacheJob(youtubeId)) return { queued: false, reason: 'already-queued' };

  pendingEnqueue.add(youtubeId);
  try {
    return await _enqueueCacheDownload(youtubeId);
  } catch (err) {
    logger.warn({ err, youtubeId }, 'STRM force-download: enqueue failed');
    return { queued: false, reason: 'error' };
  } finally {
    pendingEnqueue.delete(youtubeId);
  }
}

module.exports = {
  maybeEnqueueCacheDownload,
  forceEnqueueCacheDownload,
  hasActiveCacheJob,
  isFeatureEnabled,
  STRM_CACHE_LABEL_PREFIX,
};
