const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const videoPersistence = require('./videoPersistence');
const Job = require('../models/job');
const jobModule = require('./jobModule');
const { serializeAuxData } = require('./jobAuxData');

// Distinct from strmCacheOnPlay.js's STRM_CACHE_LABEL_PREFIX - this finalizer
// runs after ytstream.js's own independent hls-buffer fetch, not a real
// strmCacheOnPlay-triggered download, so it gets its own honest label rather
// than borrowing that one (which previously made every finalized buffer
// fetch's Source column read "STRM Cache" regardless of how it actually got
// downloaded). See DownloadHistory.tsx's getJobSourceLabel/cleanJobTypeLabel
// for where this prefix is recognized client-side.
const HLS_BUFFER_CACHE_LABEL_PREFIX = 'HLS Buffer Cache: ';

/**
 * server/routes/ytstream.js mode=hls-buffer: called once the
 * independent buffer-fetch pipeline (startHlsBufferFetch) finishes
 * cleanly. Moves the finished temp file into the STRM video's real
 * library location and updates the Video row - same DB bookkeeping a real
 * strmCacheOnPlay download job would have done, minus the parts already
 * covered by strmMaterializer at channel-sync time (NFO/thumbnail/poster/
 * media-info cache all already exist for this row - see strmMaterializer.js,
 * which writes all of that BEFORE the .strm file itself, specifically so
 * nothing ever needs to backfill it later).
 *
 * @param {string} [sourceLabel] - the synthetic jobType tag (see jobInstance
 *   below); defaults to 'hls-buffer', its sole caller.
 * @param {boolean} [skipVideoUpsert] - true for mode=hls-buffer against a
 *   video with no `Video` row (see ytstream.js's bufferEnabled block - an
 *   NZB `mediaMode:'strm'` grab Youtarr never catalogued, or one it later
 *   disowned via `importStrategy:'untracked'`). `finalPath` in that case is
 *   Youtarr's own untracked-buffer cache dir (keyed by youtubeId), not a
 *   library location - no Video row is created and this never becomes a
 *   tracked library entry, but it still gets a completed Job row (see
 *   buildUntrackedDisplayVideo below for how Download History displays it
 *   without a Video row to read from).
 * @param {number|null} [startedAt] - Date.now() from when the fetch began
 *   (ytstream.js's fetchStartedAt) - used only to compute
 *   downloadDurationSeconds/avgDownloadMBps for Download History; omitted
 *   (or skipVideoUpsert:true) leaves both null.
 * @param {string|null} [ytdlpCommand] - the exact yt-dlp argv used for this
 *   fetch (space-joined), stored on the synthetic Job row purely as a
 *   debugging aid - never parsed back out programmatically.
 * @returns {Promise<string|null>} the final file path on success, else null
 */
async function finalizeTapOutput({ youtubeId, tempPath, finalPath, sourceLabel = 'hls-buffer', skipVideoUpsert = false, startedAt = null, ytdlpCommand = null }) {
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

    let downloadDurationSeconds = null;
    let avgDownloadMBps = null;
    if (startedAt) {
      const elapsedSeconds = (Date.now() - startedAt) / 1000;
      if (elapsedSeconds > 0) {
        downloadDurationSeconds = Math.round(elapsedSeconds);
        avgDownloadMBps = (fileSize / 1024 / 1024) / elapsedSeconds;
      }
    }

    if (skipVideoUpsert) {
      await recordUntrackedDownloadHistory({ youtubeId, finalPath, fileSize, downloadDurationSeconds, avgDownloadMBps, startedAt, ytdlpCommand });
      logger.info({ youtubeId, finalPath, sourceLabel, downloadDurationSeconds, avgDownloadMBps }, 'ytstream: finalized - live stream tap/buffer saved to the untracked-video cache (no Video row, not a library entry)');
      return finalPath;
    }

    // A REAL, persisted Job row - not the previous non-persisted stand-in
    // object literal - created directly via Job.create rather than
    // jobModule.addOrUpdateJob: this work already happened (there is nothing
    // to queue/run), so this is purely a completed-history record, never
    // touching the live job queue/executor/WebSocket progress machinery.
    // status:'Complete' from the moment it's created is what keeps it out of
    // that queue - jobModule's startup job-migration logic only ever acts on
    // Pending/In Progress rows.
    const jobInstance = await Job.create({
      status: 'Complete',
      timeInitiated: new Date(startedAt || Date.now()),
      timeCreated: new Date(startedAt || Date.now()),
      jobType: `${HLS_BUFFER_CACHE_LABEL_PREFIX}${youtubeId}`,
      output: '1 videos.',
      ytdlpCommand,
    });

    // cached_at: mirrors strmCacheOnPlay.js's own STRM-cache jobs - this is
    // the same "STRM row upgraded to a real file via an opportunistic
    // background fetch" transition, just triggered by hls-buffer instead of
    // the cache-on-play path, so it should piggyback on the same
    // cacheOnPlayExpiryHours nightly revert-to-STRM sweep
    // (videoDeletionModule.sweepExpiredCachedVideos checks is_strm===false
    // && cached_at, not which path set it).
    // alwaysCreateJobVideo:true (unlike the old non-persisted stand-in,
    // which never linked a JobVideo at all) so this real Job row actually
    // gets linked to the video - required for Download History's query
    // (Jobs+JobVideo+Video) to find it, since the video already existed as
    // a STRM row before this call (upsertVideoForJob only auto-creates that
    // link for a brand-new video otherwise).
    const videoInstance = await videoPersistence.upsertVideoForJob(
      { youtubeId, filePath: finalPath, fileSize, is_strm: false, downloadDurationSeconds, avgDownloadMBps },
      jobInstance,
      true
    );

    // jobModule.getRunningJobsWithFreshVideos (Download History's data
    // source) reads jobModule's in-memory `jobs` map, populated only at
    // server startup (loadJobsFromDB) or via jobModule's own queue methods -
    // neither of which the bypassed-queue Job.create above touches. Without
    // this, the row above would be invisible in Download History until the
    // next server restart. Seeding just the video's id is enough:
    // getRunningJobsWithFreshVideos replaces it with the full fresh Video
    // row automatically, same as it does for any other job.
    jobModule.jobs[jobInstance.id] = {
      id: jobInstance.id,
      jobType: jobInstance.jobType,
      status: jobInstance.status,
      output: jobInstance.output,
      timeInitiated: jobInstance.timeInitiated,
      timeCreated: jobInstance.timeCreated,
      ytdlpCommand: jobInstance.ytdlpCommand,
      data: { videos: [{ id: videoInstance.id }] },
    };

    logger.info({ youtubeId, finalPath, sourceLabel, jobId: jobInstance.id, downloadDurationSeconds, avgDownloadMBps }, 'ytstream: finalized - live stream tap/buffer saved as permanent download');
    return finalPath;
  } catch (err) {
    logger.warn({ err, youtubeId, tempPath, finalPath, sourceLabel }, 'ytstream: tap/buffer finalize failed');
    return null;
  }
}

/**
 * Untracked counterpart to the tracked-video Job creation above: there's no
 * `Video` row to attach fileSize/timing to (see finalizeTapOutput's
 * skipVideoUpsert doc comment), so those facts are stashed directly on the
 * synthetic Job's `aux_data` instead, under a dedicated `hlsBufferCacheInfo`
 * key - jobAuxData.js's serializeAuxData only ever strips a `videos` key, so
 * this survives a restart untouched (unlike job.data.videos itself, which is
 * always rebuilt relationally and would come back empty here with nothing to
 * rebuild it from). jobModule.getRunningJobsWithFreshVideos combines this
 * with a youtube_metadata_cache lookup (title/channel/duration, whenever
 * this video has been streamed/viewed at least once) to build a
 * display-only video object at read time - see that function's own "HLS
 * Buffer Cache" backfill branch, which mirrors videosModule.js's existing
 * "Show untracked" Library rows (id: null, isTracked: false).
 * @returns {Promise<void>}
 */
async function recordUntrackedDownloadHistory({ youtubeId, finalPath, fileSize, downloadDurationSeconds, avgDownloadMBps, startedAt, ytdlpCommand }) {
  const data = {
    hlsBufferCacheInfo: { youtubeId, filePath: finalPath, fileSize, downloadDurationSeconds, avgDownloadMBps },
  };

  const jobInstance = await Job.create({
    status: 'Complete',
    timeInitiated: new Date(startedAt || Date.now()),
    timeCreated: new Date(startedAt || Date.now()),
    jobType: `${HLS_BUFFER_CACHE_LABEL_PREFIX}${youtubeId}`,
    output: '1 videos.',
    ytdlpCommand,
    aux_data: serializeAuxData(data),
  });

  // See the tracked-path comment above on why this in-memory registration is
  // required for the row to appear before the next server restart.
  jobModule.jobs[jobInstance.id] = {
    id: jobInstance.id,
    jobType: jobInstance.jobType,
    status: jobInstance.status,
    output: jobInstance.output,
    timeInitiated: jobInstance.timeInitiated,
    timeCreated: jobInstance.timeCreated,
    ytdlpCommand: jobInstance.ytdlpCommand,
    data: { ...data, videos: [] },
  };
}

/**
 * Deletes an incomplete/abandoned buffer output - never left on disk, never
 * treated as done.
 * @param {string} [sourceLabel] - see finalizeTapOutput's doc comment; used
 *   only for this log line's accuracy, no functional effect.
 */
function discardTapOutput({ youtubeId, tempPath, sourceLabel = 'hls-buffer' }) {
  if (!tempPath) return;
  fs.unlink(tempPath, (err) => {
    if (err && err.code !== 'ENOENT') {
      logger.warn({ err, youtubeId, tempPath, sourceLabel }, 'ytstream: failed to discard incomplete tap/buffer output');
    }
  });
}

/**
 * server/routes/ytstream.js's swapHiddenCacheToMp4 (ytstream.stealthCache,
 * or a genuinely untracked video, once finalizeToMp4 remuxes its hidden
 * .ts): the .ts recorded by recordUntrackedDownloadHistory/finalizeTapOutput
 * above is about to be deleted, superseded by an .mp4 - this updates that
 * SAME job's aux_data (both the in-memory copy jobModule.getRunningJobsWithFreshVideos
 * actually reads - see its own hlsBufferInfoNeedingBackfill handling - and
 * the DB row, so it survives a restart) so Download History reflects the
 * .mp4 instead of a path that no longer exists.
 *
 * Matched by exact youtubeId + old filePath (not youtubeId alone) so a
 * later, unrelated re-cache of the same video is never misattributed to
 * this stale entry.
 * @param {string} youtubeId
 * @param {string} oldFilePath - the .ts path recorded at fetch-finalize time
 * @param {string} newFilePath - the .mp4 path that supersedes it
 * @param {number} newFileSize
 * @returns {Promise<boolean>} true if a matching job was found and updated
 */
async function updateHiddenCacheJobFileInfo(youtubeId, oldFilePath, newFilePath, newFileSize) {
  const match = Object.values(jobModule.jobs).find((j) =>
    j.data && j.data.hlsBufferCacheInfo
    && j.data.hlsBufferCacheInfo.youtubeId === youtubeId
    && j.data.hlsBufferCacheInfo.filePath === oldFilePath
  );
  if (!match) return false;
  match.data.hlsBufferCacheInfo = { ...match.data.hlsBufferCacheInfo, filePath: newFilePath, fileSize: newFileSize };
  try {
    await Job.update(
      { aux_data: serializeAuxData(match.data) },
      { where: { id: match.id } }
    );
  } catch (err) {
    logger.warn({ err, youtubeId, oldFilePath, newFilePath }, 'ytstream: failed to persist updated hidden-cache job aux_data (in-memory copy still updated)');
  }
  return true;
}

module.exports = { finalizeTapOutput, discardTapOutput, updateHiddenCacheJobFileInfo };
