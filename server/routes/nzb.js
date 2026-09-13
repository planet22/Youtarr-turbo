const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const logger = require('../logger');
const configModule = require('../modules/configModule');
const videoSearchModule = require('../modules/videoSearchModule');
const jobModule = require('../modules/jobModule');
const nzbFeedModule = require('../modules/nzbFeedModule');
const nzbThumbnailProbe = require('../modules/nzbThumbnailProbe');
const nzbDiagnosticLog = require('../modules/nzbDiagnosticLog');
const { nzbDownloadJobLabel } = require('../modules/download/jobTypes');
const ChannelVideo = require('../models/channelvideo');
const Video = require('../models/video');
const { formatBytes } = require('../modules/notifications/utils');

/**
 * Makes Youtarr act as BOTH a Newznab-compatible search indexer AND a
 * SABnzbd-compatible download client, so Sonarr/Radarr/Prowlarr can search
 * YouTube through Youtarr and "download" (really: trigger a real Youtarr
 * download/STRM materialize of) a video, landing in a category-mapped
 * folder. Modeled on github.com/Nikorag/iplayarr, which does the same for
 * BBC iPlayer content. See docs/NZB.md.
 *
 * Deliberately mounted at /nzb, not /api - the existing /api/* prefix
 * carries apiLimiter + verifyToken (server.js), neither of which apply
 * here: this feature has its own single dedicated API key (verifyNzbApiKey
 * below), checked via the Newznab/SABnzbd `?apikey=` query-string
 * convention rather than Youtarr's session/header-based auth.
 *
 * No server-side cache/session exists between search and grab - everything
 * addfile needs is encoded directly in the synthetic NZB file itself (see
 * nzbFeedModule.buildNzbXml/parseNzbXml).
 */

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const ALLOWED_SEARCH_COUNTS = [10, 25, 50, 100];

/**
 * nzb.debugLogging: this file's own per-request diagnostic lines (search/
 * caps/addfile/queue/history requests, cache hit/miss via videoSearchModule,
 * local-filter before/after counts, remapped Sonarr/Radarr paths, etc.) are
 * genuinely too high-volume for logger.info by default, but gating them
 * behind the global Log Level=debug setting also turns on every OTHER
 * module's debug output (most visibly databaseHealthModule's ~15s health
 * check line) - unrelated noise with no way to see just this integration's
 * own traffic. This flag decouples the two (same pattern as ytstream.js's
 * streamDebug): off (default), behaves exactly like logger.debug always
 * has; on, these specific lines print at info instead, regardless of the
 * global Log Level. Read live per call, so it takes effect immediately, no
 * restart.
 */
function nzbDebug(obj, msg) {
  // Supports both call shapes used below: nzbDebug(obj, msg) and the
  // message-only nzbDebug(msg) - passing a stray `undefined` second arg to
  // the plain-string calls would otherwise reach the real pino logger.
  const args = msg === undefined ? [obj] : [obj, msg];
  const level = configModule.getConfig().nzb?.debugLogging === true ? 'info' : 'debug';
  logger[level](...args);
}

function nearestAllowedCount(requested) {
  const n = Number.parseInt(requested, 10);
  if (!Number.isFinite(n) || n <= 0) return 25;
  return ALLOWED_SEARCH_COUNTS.reduce((best, c) => (Math.abs(c - n) < Math.abs(best - n) ? c : best), ALLOWED_SEARCH_COUNTS[0]);
}

// Newznab's offset+limit paging: unlike nearestAllowedCount (used for the
// page-size Sonarr/Radarr/Prowlarr asked for), fetching enough raw results
// to actually SLICE out a later page needs to round UP to the smallest
// bucket that covers offset+limit, not just the closest one - "closest to
// 60" is 50, which would leave a page spanning items 40-59 two items short.
// Caps at the largest bucket (100): a page starting past that isn't
// fetchable in one search call, so it comes back empty rather than erroring.
function minAllowedCountAtLeast(needed) {
  const found = ALLOWED_SEARCH_COUNTS.find((c) => c >= needed);
  return found !== undefined ? found : ALLOWED_SEARCH_COUNTS[ALLOWED_SEARCH_COUNTS.length - 1];
}

// nzb.resolutionDetection.{fixed,thumb,extract} (Settings -> Sonarr/Radarr/
// Prowlarr (NZB) -> Video Actual Resolution) - see configSchema.ts's default
// for the full fallback-chain explanation. All default true for configs
// saved before this setting existed.
function getResolutionDetectionConfig(cfg) {
  const rd = cfg.nzb?.resolutionDetection || {};
  return {
    fixed: rd.fixed !== false,
    thumb: rd.thumb !== false,
    extract: rd.extract !== false,
  };
}

/**
 * Determines each result's real resolution, mutating `results` in place with
 * `definition`/`actualHeightTier`/`resolutionSource` - the "fixed" tier of
 * the chain (a previously-downloaded video's own known resolution) plus
 * whatever of "thumb"/"extract" nzbThumbnailProbe still needs to fill in.
 * Shared between the real search branch and the blank-query RSS-mode branch
 * below, both of which end in nzbFeedModule.buildSearchXml.
 * @param {Array<object>} results - the FINAL result set only (post-filter,
 *   post offset/limit slice) - see fillUnknownDefinitions's own doc comment
 *   for why this never runs against the larger raw candidate set.
 * @param {ReturnType<typeof getResolutionDetectionConfig>} resolutionDetection
 * @returns {Promise<{durationMs: number, queryCount: number}>} timing/volume
 *   for the NZB diagnostics page's per-search trace (see recordSearchTrace's
 *   call site below) - durationMs covers this whole function (the "fixed"
 *   local-DB lookup included, not just the thumb/extract probes), queryCount
 *   is however many items fillUnknownDefinitions actually had to resolve
 *   (i.e. weren't already settled by the API or "fixed" tiers above).
 */
async function applyResolutionDetection(results, resolutionDetection) {
  const startedAt = Date.now();
  if (resolutionDetection.fixed) {
    const needsLocalLookup = results.filter((r) => r.localResolutionHeight === undefined);
    if (needsLocalLookup.length > 0) {
      await videoSearchModule.attachLocalResolutionHeight(needsLocalLookup);
    }
    for (const r of results) {
      if (typeof r.localResolutionHeight === 'number' && r.localResolutionHeight > 0) {
        r.definition = r.localResolutionHeight >= 720 ? 'hd' : 'sd';
        r.actualHeightTier = nzbFeedModule.resolveQualityTier(String(r.localResolutionHeight));
        r.resolutionSource = 'fixed';
      }
    }
  }

  // Whatever the API already enriched (contentDetails.definition) came in
  // with `definition` already set before this function ran at all - tag its
  // source now, before fillUnknownDefinitions below only touches the items
  // still null, so the debug trace can tell "YouTube's own metadata" apart
  // from "fixed"/"thumb"/"extract".
  for (const r of results) {
    if (r.definition != null && r.resolutionSource === undefined) {
      r.resolutionSource = 'api';
    }
  }

  const queryCount = await nzbThumbnailProbe.fillUnknownDefinitions(results, {
    useThumb: resolutionDetection.thumb,
    useExtract: resolutionDetection.extract,
  });

  return { durationMs: Date.now() - startedAt, queryCount: queryCount || 0 };
}

// SABnzbd's timeleft is "H:MM:SS" (no zero-padded hours).
function formatTimeleft(etaSeconds) {
  const total = Math.max(0, Math.round(etaSeconds || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Sonarr/Radarr run in their own container and may have the shared media
 * volume mounted at a different path than Youtarr sees it at internally
 * (e.g. Youtarr's directoryPath is /usr/src/app/data, but Sonarr's own
 * mount of that same folder is rooted elsewhere - or at /, with no prefix
 * at all). Rather than requiring Sonarr-side Remote Path Mapping, when
 * nzb.remoteBasePath is configured, every path reported to Sonarr/Radarr
 * (history's storage/path) has Youtarr's real directoryPath prefix swapped
 * for it. Left at its default (null/undefined), paths are reported
 * unchanged - the historical behavior for setups where both containers see
 * the same path.
 */
function remapPathForSonarr(absolutePath) {
  if (!absolutePath) return absolutePath;
  const cfg = configModule.getConfig();
  const remoteBase = cfg.nzb?.remoteBasePath;
  if (remoteBase === null || remoteBase === undefined) return absolutePath;
  const localBase = String(configModule.directoryPath || '').replace(/[/\\]+$/, '');
  if (!localBase || !absolutePath.startsWith(localBase)) return absolutePath;
  const suffix = absolutePath.slice(localBase.length); // keeps its leading slash, e.g. "/__sonarr/pcrobec/..."
  return `${String(remoteBase).replace(/[/\\]+$/, '')}${suffix}`;
}

function verifyNzbApiKey(req, res, next) {
  const cfg = configModule.getConfig();
  if (!cfg.nzb?.enabled || !cfg.nzb?.apiKey) {
    return res.status(503).send('Youtarr NZB integration is not enabled');
  }
  const provided = req.query.apikey;
  if (!provided || typeof provided !== 'string') {
    return res.status(401).send('Missing apikey');
  }
  // Stored in plaintext (see configSchema.ts's nzb.apiKey comment) - still a
  // constant-time compare against a length-normalized buffer pair so this
  // doesn't leak timing information about how much of the key matched.
  const storedBuf = Buffer.from(cfg.nzb.apiKey, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');
  if (storedBuf.length !== providedBuf.length || !crypto.timingSafeEqual(storedBuf, providedBuf)) {
    return res.status(401).send('Invalid apikey');
  }
  next();
}

/**
 * Sonarr/Radarr's import step MOVES (or copies+deletes) whatever `storage`/
 * `path` a history entry reports into their own managed library folder. If
 * that pointed at Youtarr's own real library file, the file would vanish
 * from where Youtarr (and Jellyfin/Plex) expect it, and Youtarr's Video row
 * would go dangling. Instead, hardlink the real file into a dot-prefixed
 * staging folder (excluded from subfolder/library scanning, same convention
 * as .youtarr_tmp) and report that path - Sonarr/Radarr's move only removes
 * the hardlink; Youtarr's own copy is untouched since both links share the
 * same underlying data on disk. This is also self-cleaning: once Sonarr/
 * Radarr imports it, the staged hardlink is gone (moved away by them).
 * Idempotent per job via job.data.nzb.stagedPath, since Sonarr/Radarr poll
 * history repeatedly before importing.
 */
function stageForSonarrImport(job, categoryName, videoRow) {
  if (job.data.nzb.stagedPath) {
    if (fs.existsSync(job.data.nzb.stagedPath)) {
      return job.data.nzb.stagedPath;
    }
    // The previously-staged hardlink is gone - the only thing that ever
    // removes it is Sonarr/Radarr's own import step (see this function's doc
    // comment above), so that's proof the import already happened. Recorded
    // once, in-memory only (like stagedPath itself - never persisted via
    // saveJobOnly, so it resets on restart the same way stagedPath does);
    // computeNzbStatusDetail below is what surfaces it to the Download
    // History page. The block below still re-stages a fresh hardlink as
    // before - unrelated to this flag, and left as-is.
    if (!job.data.nzb.importedAt) {
      job.data.nzb.importedAt = Date.now();
    }
  }
  const filePath = videoRow?.filePath;
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  const stagingDir = path.join(configModule.directoryPath, '.nzb_staging', categoryName);
  const stagedPath = path.join(stagingDir, path.basename(filePath));
  try {
    fs.mkdirSync(stagingDir, { recursive: true });
    if (!fs.existsSync(stagedPath)) {
      try {
        fs.linkSync(filePath, stagedPath);
      } catch (err) {
        if (err.code === 'EEXIST') {
          // Another concurrent history poll already created it - fine.
        } else if (err.code === 'EXDEV') {
          logger.warn({ filePath, stagedPath }, 'nzb: staging folder is on a different filesystem than the library - falling back to a real copy (doubles disk usage until Sonarr/Radarr imports it)');
          fs.copyFileSync(filePath, stagedPath);
        } else {
          throw err;
        }
      }
    }
    job.data.nzb.stagedPath = stagedPath;
    return stagedPath;
  } catch (err) {
    logger.warn({ err, filePath }, "nzb: failed to stage file for Sonarr/Radarr import - reporting the real library path instead, so Sonarr/Radarr's import will move it out of Youtarr's library");
    return filePath;
  }
}

/**
 * For importStrategy 'untracked': Sonarr/Radarr are told the job is
 * complete with the real (only) file path and will move it away as usual.
 * Until then the video is a completely normal, visible entry in Youtarr's
 * own library (same as 'hardlink') - this function is what removes it, and
 * it is ONLY ever called in response to an explicit removal signal: a real
 * mode=history&name=delete call from Sonarr/Radarr (see the handler below),
 * or the user deleting/purging the video themselves in Youtarr's own UI
 * (the normal delete/purge flow, unrelated to this file). It must NEVER run
 * automatically just because a job completed or Sonarr/Radarr merely
 * polled history - doing so previously caused a real bug: if the DB row got
 * purged before Sonarr's own history poll ever read it (e.g. a Youtarr
 * restart in between), resolveNzbVideoRow had nothing left to fall back to
 * and Sonarr/Radarr received an empty path it could never import - the grab
 * would vanish from the queue without ever usably appearing in history.
 *
 * Only the Video row + its JobVideo/VideoWatchStatus rows are removed (same
 * scope as videoDeletionModule.purgeVideoById); ChannelVideo is deliberately
 * left alone - it keys by youtube_id and represents the YouTube-catalog
 * listing independent of this local download. The file itself is NEVER
 * touched here - Sonarr/Radarr's own import step is what moves it. Idempotent
 * via job.data.nzb.untracked.
 *
 * Also removes the video from yt-dlp's download-archive. That archive's
 * whole purpose is "don't re-download a file Youtarr still has" - once
 * untracked, Youtarr no longer has it (Sonarr/Radarr own it now), so a
 * later re-grab of the same video (a Sonarr retry, a second matching
 * release, etc.) must be allowed to actually re-download instead of
 * silently skipping ("already recorded in the archive") and then failing
 * because the original copy is gone from where it used to be.
 */
async function untrackFromYoutarrLibrary(job, videoRow) {
  if (job.data.nzb.untracked) {
    logger.info({ jobId: job.id, videoId: videoRow?.id }, 'nzb: untrackFromYoutarrLibrary - already untracked, no-op');
    return { outcome: 'already-untracked' };
  }
  const videoId = videoRow?.id;
  if (!videoId) {
    logger.warn(
      { jobId: job.id, videoRow },
      'nzb: untrackFromYoutarrLibrary - resolveNzbVideoRow returned no usable id, nothing was destroyed'
    );
    return { outcome: 'no-video-id' };
  }
  let counts = null;
  try {
    const { JobVideo, VideoWatchStatus } = require('../models');
    const jobVideoCount = await JobVideo.destroy({ where: { video_id: videoId } });
    const watchStatusCount = await VideoWatchStatus.destroy({ where: { video_id: videoId } });
    const videoCount = await Video.destroy({ where: { id: videoId } });
    counts = { jobVideoCount, watchStatusCount, videoCount };
    job.data.nzb.untracked = true;
    job.data.nzb.untrackedAt = Date.now();
    if (videoCount === 0) {
      // destroy() resolves with 0 rather than throwing when nothing matches,
      // so this is the only signal that the "successful" untrack above was
      // actually a no-op - the Video row this call thought it was removing
      // either didn't exist under this id, or something else already removed
      // it (in which case jobVideoCount/watchStatusCount being 0 too is
      // expected and fine; jobVideoCount > 0 here alongside videoCount === 0
      // would mean the id was stale/wrong, not just already-cleaned-up).
      logger.warn(
        { jobId: job.id, videoId, counts },
        'nzb: untrackFromYoutarrLibrary - Video.destroy matched 0 rows; video row was not actually removed'
      );
    } else {
      logger.info({ jobId: job.id, videoId, counts }, 'nzb: untrackFromYoutarrLibrary - destroyed tracking rows');
    }
  } catch (err) {
    logger.warn({ err, jobId: job.id, videoId }, 'nzb: failed to remove untracked video from Youtarr DB');
    return { outcome: 'error', counts };
  }
  if (videoRow?.youtubeId) {
    try {
      const archiveModule = require('../modules/archiveModule');
      await archiveModule.removeVideoFromArchive(videoRow.youtubeId);
    } catch (err) {
      logger.warn({ err, youtubeId: videoRow.youtubeId }, 'nzb: failed to remove untracked video from yt-dlp archive');
    }
  }
  return { outcome: counts.videoCount > 0 ? 'destroyed' : 'zero-rows-matched', counts };
}

/**
 * Best-effort CLEANUP counterpart to untrackFromYoutarrLibrary's
 * history-delete path, for importStrategy 'untracked'. That path is and
 * remains the primary/authoritative untrack mechanism (an explicit
 * mode=history&name=delete call from Sonarr/Radarr) - this function only
 * exists because plenty of real installs never send that call at all (e.g.
 * Sonarr/Radarr's own "Remove completed downloads" setting left off), which
 * without this would leave the Video row behind forever once the import has
 * already moved the real file away: Youtarr's own file check then
 * (correctly, from its own point of view) flags it removed=true, and
 * instead of quietly disappearing the way an 'untracked' grab is supposed
 * to, it shows up in the Library as a permanently "Missing" video.
 *
 * Deliberately looks the video up via the persisted JobVideo -> Job
 * relation (both are real DB tables, never pruned) rather than scanning
 * jobModule's in-memory job cache by youtubeId - that cache is capped/aged
 * out (see JOB_RETENTION_DAYS/MAX_HISTORY_JOBS in jobModule.js) and isn't a
 * reliable way to answer "did this specific video come from an
 * 'untracked'-strategy nzb job" days or weeks later.
 *
 * Also removes the video from yt-dlp's download-archive (complete.list),
 * same as untrackFromYoutarrLibrary and for the same reason: jobModule's
 * backfillFromCompleteList runs on every server startup (not just its
 * 2:20am cron) and will silently RECREATE a Video row for any youtubeId
 * still listed in complete.list whose jobs/info/<id>.info.json sidecar is
 * still lying around. Skipping this cleanup here used to mean a video
 * whose *actual* removal happened via this fallback path (rather than the
 * primary delete-call path) would resurrect itself on every subsequent
 * restart, indefinitely - the JobVideo row's own removal is what makes the
 * DB side of this idempotent (a later call for the same video finds no
 * JobVideo rows and is a no-op), but that idempotency doesn't help once
 * complete.list keeps bringing the row back to life.
 *
 * Called from videosModule's real-time per-page file check and its backfill
 * safety-net sweep, both right after a video is confirmed removed=true: the
 * missing file IS the proof Sonarr/Radarr already imported it (Youtarr
 * itself never deletes the file on its own), so it's safe to finish
 * clearing Youtarr's own tracking rows here instead of waiting on a delete
 * call that may never arrive.
 * @param {{id: number, youtubeId: string}} videoRow
 * @returns {Promise<boolean>} true if the video's tracking rows were removed
 */
async function reconcileMovedUntrackedVideo(videoRow) {
  if (!videoRow?.id) return false;
  const { JobVideo, Job, VideoWatchStatus } = require('../models');
  const { parseAuxData } = require('../modules/jobAuxData');

  const jobVideos = await JobVideo.findAll({ where: { video_id: videoRow.id } });
  if (!jobVideos.length) {
    logger.info(
      { videoId: videoRow.id, youtubeId: videoRow.youtubeId },
      'nzb: reconcileMovedUntrackedVideo - no JobVideo row for this video (nothing to untrack)'
    );
    return false;
  }

  // More than one JobVideo row pointing at the same video_id is unexpected
  // for an 'untracked' video (the whole point of untrackFromYoutarrLibrary is
  // to remove this row's JobVideo the moment the first job is done with it) -
  // if it happens, it means either a prior untrack silently failed to clear
  // the old link, or a second job got attached to an already-tracked video
  // (e.g. yt-dlp's archive-skip fallback re-resolving by youtubeId). Logging
  // the full set up front makes that visible instead of only ever reporting
  // whichever one wins the importStrategy match below.
  if (jobVideos.length > 1) {
    logger.warn(
      { videoId: videoRow.id, youtubeId: videoRow.youtubeId, jobIds: jobVideos.map((jv) => jv.job_id) },
      'nzb: reconcileMovedUntrackedVideo - multiple JobVideo rows for one video_id (expected at most one for an untracked-strategy video)'
    );
  }

  const jobs = await Job.findAll({
    where: { id: jobVideos.map((jv) => jv.job_id) },
    order: [['timeCreated', 'DESC']],
  });
  const cfg = configModule.getConfig();

  let matchedJobId = null;
  let sawNzbJob = false;
  for (const job of jobs) {
    const aux = parseAuxData(job.aux_data);
    if (!aux.nzb) continue;
    sawNzbJob = true;
    const category = findCategory(cfg.nzb?.categories || [], { name: aux.nzb.categoryName });
    if ((category?.importStrategy || 'hardlink') === 'untracked') {
      matchedJobId = job.id;
      break;
    }
  }

  if (!matchedJobId) {
    logger.info(
      { videoId: videoRow.id, youtubeId: videoRow.youtubeId, jobCount: jobs.length, sawNzbJob },
      'nzb: reconcileMovedUntrackedVideo - no associated job uses importStrategy "untracked", leaving video as Missing'
    );
    return false;
  }

  let counts;
  try {
    const jobVideoCount = await JobVideo.destroy({ where: { video_id: videoRow.id } });
    const watchStatusCount = await VideoWatchStatus.destroy({ where: { video_id: videoRow.id } });
    const videoCount = await Video.destroy({ where: { id: videoRow.id } });
    counts = { jobVideoCount, watchStatusCount, videoCount };
  } catch (err) {
    logger.warn({ err, videoId: videoRow.id }, 'nzb: reconcileMovedUntrackedVideo - failed to remove tracking rows');
    return false;
  }

  if (counts.videoCount === 0) {
    // Same blind spot as untrackFromYoutarrLibrary: destroy() doesn't throw
    // on a 0-row match, so without checking the count this would otherwise
    // log success and return true for a video row that's still sitting in
    // the DB - exactly the symptom of the same video getting "untracked"
    // again on a later sweep/backfill with no error ever logged anywhere.
    logger.warn(
      { jobId: matchedJobId, videoId: videoRow.id, youtubeId: videoRow.youtubeId, counts },
      'nzb: reconcileMovedUntrackedVideo - Video.destroy matched 0 rows; video row was NOT actually removed'
    );
    return false;
  }

  // Verify the row is actually gone rather than trusting the destroy count
  // alone - catches cases like a replica/connection-pool read seeing stale
  // state, or another process re-inserting a row with the same id in the
  // gap between destroy() and this check.
  const stillExists = await Video.findByPk(videoRow.id);
  if (stillExists) {
    logger.warn(
      { jobId: matchedJobId, videoId: videoRow.id, youtubeId: videoRow.youtubeId, counts },
      'nzb: reconcileMovedUntrackedVideo - Video.destroy reported a row removed, but the id still exists on immediate re-read'
    );
    return false;
  }

  if (videoRow.youtubeId) {
    try {
      const archiveModule = require('../modules/archiveModule');
      await archiveModule.removeVideoFromArchive(videoRow.youtubeId);
    } catch (err) {
      logger.warn(
        { err, jobId: matchedJobId, videoId: videoRow.id, youtubeId: videoRow.youtubeId },
        'nzb: reconcileMovedUntrackedVideo - failed to remove video from yt-dlp archive (it will resurrect on next backfillFromCompleteList run if this keeps failing)'
      );
    }
  }

  // Mirror untrackFromYoutarrLibrary's own bookkeeping on the job record, so
  // the Download History page (computeNzbStatusDetail below) can tell this
  // job apart from one still awaiting import even though no history-delete
  // call ever arrived for it - without this the job's status silently stayed
  // "Downloaded - awaiting import" forever despite the video being long gone.
  try {
    const matchedJob = jobModule.getJob(matchedJobId);
    if (matchedJob?.data?.nzb) {
      matchedJob.data.nzb.untracked = true;
      matchedJob.data.nzb.untrackedAt = Date.now();
      // skipVideoPersistence: the Video/JobVideo rows for this job were just
      // deleted above - matchedJob.data.videos still holds the stale, now-
      // deleted video object, so a normal saveJobOnly would immediately
      // resurrect it.
      await jobModule.saveJobOnly(matchedJobId, matchedJob, { skipVideoPersistence: true });
    }
  } catch (err) {
    logger.warn(
      { err, jobId: matchedJobId },
      'nzb: reconcileMovedUntrackedVideo - failed to stamp job as untracked (video DB rows were still removed above)'
    );
  }

  logger.info(
    { jobId: matchedJobId, videoId: videoRow.id, youtubeId: videoRow.youtubeId, counts },
    'nzb: untracked video after its file was moved away by Sonarr/Radarr import (no history-delete call received)'
  );
  return true;
}

/**
 * The video this job's history entry should report on. Usually just
 * job.data.videos[0] (populated fresh from the DB when the job completed -
 * see jobModule.js's completed-job video reload). But when yt-dlp finds the
 * video already in its download archive (already downloaded by an earlier
 * job, e.g. a prior manual grab or a retried NZB request), it skips the
 * download entirely - no --exec post-processor run, no JobVideo row created
 * for *this* job, so job.data.videos comes back empty even though the video
 * genuinely already exists in the library. Falls back to a fresh DB lookup
 * by youtubeId so Sonarr/Radarr still gets told the grab is complete (with
 * the video's real, already-downloaded path) instead of an empty history
 * entry they can never import.
 */
async function resolveNzbVideoRow(job) {
  const fromJob = job.data?.videos?.[0];
  if (fromJob?.filePath) return fromJob;
  const youtubeId = job.data?.nzb?.youtubeId;
  if (!youtubeId) return null;
  try {
    const video = await Video.findOne({ where: { youtubeId } });
    return video ? video.dataValues : null;
  } catch (err) {
    logger.warn({ err, youtubeId }, 'nzb: failed to look up already-downloaded video for history');
    return null;
  }
}

function findCategory(categories, { name, newznabCategoryId }) {
  if (name) {
    const byName = categories.find((c) => c.name === name);
    if (byName) return byName;
  }
  if (newznabCategoryId) {
    // Sonarr/Radarr routinely send `cat` as a comma-separated list (e.g. a
    // specific subcategory plus its parent, "5040,5000") rather than a
    // single id, and a category can itself be declared under several ids
    // (see newznabCategoryIds - one Youtarr category matching multiple
    // Newznab quality tiers). Match on any overlap between the two sets
    // instead of a single-value equality check - without this, a request
    // naming an id combination the category doesn't happen to have handy
    // silently falls through to "first configured category" below, which
    // for a multi-category setup means the *wrong* category's settings
    // (searchMode, importStrategy, etc.) get used regardless of what was
    // actually requested.
    const requestedIds = String(newznabCategoryId).split(',').map((id) => id.trim());
    const byId = categories.find((c) =>
      (c.newznabCategoryIds || []).some((id) => requestedIds.includes(String(id)))
    );
    if (byId) return byId;
  }
  return categories.find((c) => c.name) || null;
}

/**
 * Handles a real SABnzbd/NZBGet-style "remove this history entry" call
 * (mode=history&name=delete&value=<nzo_id>[,<nzo_id2>,...]). Real clients
 * drop the slot from history the moment this is called, so the job's
 * status is set to 'Deleted' - a status the mode=history handler below
 * doesn't include in its list, so the entry stops showing up there, and
 * job.data.nzb.historyRemoved is also set for explicit intent. Persisted
 * immediately via jobModule.saveJobOnly: without that, this only lived in
 * the in-memory job object and was lost on every server restart, so
 * Sonarr/Radarr's next history poll saw the "deleted" job as if it had
 * never been removed and deleted it all over again.
 *
 * Untracking the video from Youtarr's own DB (see
 * untrackFromYoutarrLibrary's doc comment for why) only happens for
 * 'untracked'-strategy videos - 'hardlink'-strategy videos are deliberately
 * left alone even though their history slot is now hidden: they're
 * permanent Youtarr library entries by design, not something a
 * download-client history cleanup should ever delete.
 * @param {string[]} jobIds - nzo_ids (Youtarr job ids) from the delete call's `value`
 */
async function handleHistoryDeleteRequest(jobIds) {
  const cfg = configModule.getConfig();
  const categories = cfg.nzb?.categories || [];
  for (const jobId of jobIds) {
    try {
      const job = jobModule.getJob(jobId);
      if (!job?.data?.nzb) continue;
      job.data.nzb.historyRemoved = true;
      job.data.nzb.historyRemovedAt = Date.now();
      job.status = 'Deleted';
      const category = findCategory(categories, { name: job.data.nzb.categoryName });
      if ((category?.importStrategy || 'hardlink') === 'untracked') {
        const videoRow = await resolveNzbVideoRow(job);
        logger.info(
          { jobId, resolvedVideoId: videoRow?.id ?? null, resolvedYoutubeId: videoRow?.youtubeId ?? null, resolvedFilePath: videoRow?.filePath ?? null },
          'nzb: resolved video row for history delete request'
        );
        const result = await untrackFromYoutarrLibrary(job, videoRow);
        logger.info({ jobId, result }, 'nzb: processed untracked video in response to history delete request');
      } else {
        logger.info({ jobId }, 'nzb: hid history entry in response to delete request (hardlink strategy - library video untouched)');
      }
      // skipVideoPersistence: for 'untracked'-strategy videos,
      // untrackFromYoutarrLibrary above just deleted this job's Video/
      // JobVideo rows - job.data.videos still holds the stale, now-deleted
      // video object, so a normal saveJobOnly would immediately resurrect it.
      await jobModule.saveJobOnly(jobId, job, { skipVideoPersistence: true });
    } catch (err) {
      logger.warn({ err, jobId }, 'nzb: failed to process history delete request');
    }
  }
}

/**
 * Optional per-category strictness filter ("additional local filter" in the
 * UI). YouTube search - even via the yt-dlp fallback - regularly returns
 * loosely-related results (reactions, compilations, unrelated uploads that
 * only share a keyword), which Sonarr/Radarr then grab as if they were the
 * real episode/movie. When a category enables this, results are dropped
 * unless the video's own title actually contains the search terms and,
 * for a tvsearch where Sonarr supplied season and/or episode, a
 * recognizable SxxExx-style code.
 *
 * Sonarr often searches with only a season known (no specific episode yet -
 * "any missing episode in this season"). A YouTube upload is always a single
 * video, never a real multi-episode archive, so a title that only mentions
 * the season with no episode number (e.g. a "Series 4 Advert"/trailer/promo
 * upload) is never a genuine episode - but is exactly the shape Sonarr's own
 * release parser reads as a season pack (season number present, episode
 * number absent), so it grabs it expecting an archive to extract, gets a
 * single non-matching video, and the cycle repeats. So a season-only search
 * still requires an actual SxxEyy-shaped marker - any episode number, since
 * Sonarr itself picks which specific one it wants from the candidates
 * returned - never just a bare season mention.
 */
function normalizeForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const LOCAL_FILTER_STOPWORDS = new Set(['a', 'an', 'the', 'of', 'and', 'or']);

function queryTerms(query) {
  return normalizeForMatch(query)
    .split(/\s+/)
    .filter((t) => t.length > 1 && !LOCAL_FILTER_STOPWORDS.has(t));
}

function titleMatchesEpisodeCode(title, season, ep) {
  if (season == null && ep == null) return true;
  const patterns = [];
  if (season != null && ep != null) {
    patterns.push(new RegExp(`\\bs0*${season}\\s*[.\\-]?\\s*e0*${ep}\\b`, 'i'));
    patterns.push(new RegExp(`\\b0*${season}\\s*x\\s*0*${ep}\\b`, 'i'));
    // Spelled-out form ("Season 22 Episode 5", "Series 22, Ep 5") - British
    // shows commonly say "Series" instead of "Season", and YouTube titles
    // spell episode codes out far more often than they use "S22E05".
    // \D{0,20} between the two numbers never crosses another digit, so this
    // can't accidentally span an unrelated number elsewhere in the title
    // (e.g. an air date).
    patterns.push(new RegExp(`\\bs(?:eason|eries)?\\.?\\s*0*${season}\\D{0,20}?e(?:p(?:isode)?)?\\.?\\s*0*${ep}\\b`, 'i'));
  } else if (season != null) {
    // Season known, episode not yet (see this function's doc comment above)
    // - require SOME episode number alongside the season, not just a bare
    // season mention. Same three shapes as the season+episode branch above,
    // but with the episode digits left as a wildcard (\d+) since we don't
    // know which specific episode(s) Sonarr is after yet.
    patterns.push(new RegExp(`\\bs0*${season}\\s*[.\\-]?\\s*e0*\\d+\\b`, 'i'));
    patterns.push(new RegExp(`\\b0*${season}\\s*x\\s*0*\\d+\\b`, 'i'));
    patterns.push(new RegExp(`\\bs(?:eason|eries)?\\.?\\s*0*${season}\\D{0,20}?e(?:p(?:isode)?)?\\.?\\s*0*\\d+\\b`, 'i'));
  } else {
    patterns.push(new RegExp(`\\be(?:p(?:isode)?)?\\.?\\s*0*${ep}\\b`, 'i'));
    // "#5"-style numbering - common on YouTube for numbered series that
    // never actually use the word "Episode".
    patterns.push(new RegExp(`#\\s*0*${ep}\\b`));
  }
  return patterns.some((re) => re.test(title));
}

/**
 * Best-effort read of WHATEVER season/episode-shaped marker a title
 * actually contains, regardless of what was being searched for - used only
 * to explain why titleMatchesEpisodeCode rejected a title (never to decide
 * whether to accept one; that decision stays entirely in the exact-match
 * patterns above). Same three structured shapes as titleMatchesEpisodeCode,
 * checked most-specific-first, falling back to season-only/episode-only if
 * no combined marker is found. The NxM shape is the least reliable (a
 * resolution like "1920x1080" can false-positive as season 1920 episode
 * 1080) but it's the same risk titleMatchesEpisodeCode itself already
 * accepts as valid evidence, so this is no less accurate than the real
 * filter - only mis-describing an already-correct rejection in a rare edge
 * case, never changing which results are kept.
 * @returns {{season: number|null, ep: number|null, matchedText: string|null}}
 */
function findAnySeasonEpisode(title) {
  let m = /\bs0*(\d+)\s*[.\-]?\s*e0*(\d+)\b/i.exec(title);
  if (m) return { season: Number(m[1]), ep: Number(m[2]), matchedText: m[0] };

  m = /\bs(?:eason|eries)?\.?\s*0*(\d+)\D{0,20}?e(?:p(?:isode)?)?\.?\s*0*(\d+)\b/i.exec(title);
  if (m) return { season: Number(m[1]), ep: Number(m[2]), matchedText: m[0] };

  m = /\b0*(\d+)\s*x\s*0*(\d+)\b/i.exec(title);
  if (m) return { season: Number(m[1]), ep: Number(m[2]), matchedText: m[0] };

  const seasonOnly = /\bs(?:eason|eries)?\.?\s*0*(\d+)(?!\d)/i.exec(title);
  const epOnly = /\be(?:p(?:isode)?)?\.?\s*0*(\d+)\b/i.exec(title) || /#\s*0*(\d+)\b/.exec(title);
  return {
    season: seasonOnly ? Number(seasonOnly[1]) : null,
    ep: epOnly ? Number(epOnly[1]) : null,
    matchedText: seasonOnly ? seasonOnly[0] : (epOnly ? epOnly[0] : null),
  };
}

/**
 * Per-category, user-maintained denylist ("Exclude if title contains" in
 * Settings) - case/diacritic-insensitive substrings that mark a result as
 * definitely NOT the thing being searched for even though it legitimately
 * contains every query keyword: DVD-extra clips ("outtakes", "behind the
 * scenes", "unseen", "deleted scenes"), promos ("advert", "trailer",
 * "sneak peek"). Unlike titleMatchesEpisodeCode, there's no structural
 * SxxEyy-style signal for movies to check instead - a plain substring list
 * is the only practical way to teach the filter about a specific channel's
 * junk-title conventions. Deliberately plain substrings, not regex: safe
 * (no ReDoS surface from a user-typed pattern) and something a non-technical
 * user can read back and understand.
 *
 * evaluateTitleFilter is the single source of truth for why a title is kept
 * or rejected - used both by applyLocalTitleFilter (the real filtering) and
 * by the NZB diagnostics page's per-search trace (see recordSearchTrace),
 * so the reason shown there can never drift from the reason actually
 * applied. The episode-code failure path is broken down into the specific
 * sub-reason (wrong season/wrong episode/no episode marker at all/nothing
 * found) rather than one generic bucket, since "S20 search rejected a S21
 * title" and "S20 search rejected an untitled advert" need very different
 * fixes from whoever's reading the diagnostics page.
 * @returns {{kept: boolean, reason: 'keyword'|'excluded-term'|'wrong-season'|'wrong-episode'|'no-episode-marker'|'episode-code'|null, matchedTerm: string|null}}
 */
function evaluateTitleFilter(title, query, { season = null, ep = null, excludeTerms = [] } = {}) {
  const terms = queryTerms(query);
  const normalizedTitle = normalizeForMatch(title);

  const missingTerm = terms.find((term) => !normalizedTitle.includes(term));
  if (missingTerm !== undefined) {
    return { kept: false, reason: 'keyword', matchedTerm: missingTerm };
  }

  const excludeMatch = (excludeTerms || [])
    .map((term) => ({ raw: term, normalized: normalizeForMatch(term) }))
    .find(({ normalized }) => normalized.length > 0 && normalizedTitle.includes(normalized));
  if (excludeMatch) {
    return { kept: false, reason: 'excluded-term', matchedTerm: excludeMatch.raw };
  }

  if (!titleMatchesEpisodeCode(title, season, ep)) {
    const found = findAnySeasonEpisode(title);
    if (season != null && found.season != null && found.season !== season) {
      return { kept: false, reason: 'wrong-season', matchedTerm: found.matchedText };
    }
    if (ep != null && found.ep != null && found.ep !== ep) {
      return { kept: false, reason: 'wrong-episode', matchedTerm: found.matchedText };
    }
    if (season != null && ep == null && found.season === season && found.ep == null) {
      return { kept: false, reason: 'no-episode-marker', matchedTerm: found.matchedText };
    }
    return { kept: false, reason: 'episode-code', matchedTerm: null };
  }

  return { kept: true, reason: null, matchedTerm: null };
}

function applyLocalTitleFilter(results, query, opts = {}) {
  return results.filter((r) => evaluateTitleFilter(r.title, query, opts).kept);
}

// Rolling trace of recent searches (raw candidates + why each was kept or
// rejected) for the NZB diagnostics page's per-search detail view - separate
// from videoSearchModule's own recentQueries/cache stats, which only know
// about the underlying yt-dlp/API fetch, not this file's category-level
// filtering. Recorded for every real search (query non-blank), regardless
// of whether additionalLocalFilter is even on, so the raw candidate list is
// always inspectable - not just the ones that got rejected.
const MAX_SEARCH_TRACES = 20;

async function recordSearchTrace(trace) {
  await nzbDiagnosticLog.recordDiagnosticEvent('trace', trace, MAX_SEARCH_TRACES);
}

async function getRecentSearchTraces() {
  return nzbDiagnosticLog.getDiagnosticEvents('trace', MAX_SEARCH_TRACES);
}

// Rolling list of NZB grabs that completed with nothing to show for it (see
// the mode=history handler's `failed` computation below) - the only place
// this is otherwise visible is a server log line for the underlying error
// (age-restricted content, yt-dlp bot-check, network failure, etc.), which
// the regular Download History page has no way to surface since the job
// itself isn't marked Error/Terminated. Deduped by job id (recordedFailedGrabJobIds)
// so Sonarr/Radarr's repeated history polling doesn't push the same failure
// in over and over.
const MAX_FAILED_GRABS = 20;
// Dedup only, not the log itself (that's nzb_diagnostic_log now) - reset on
// restart, so a job whose failure was already recorded before a restart can
// in theory be recorded a second time by the next history poll. Harmless:
// worst case is one duplicate row that ages out of the last-20 window like
// any other.
const recordedFailedGrabJobIds = new Set();

async function recordFailedGrab(job, message) {
  if (recordedFailedGrabJobIds.has(job.id)) return;
  recordedFailedGrabJobIds.add(job.id);
  await nzbDiagnosticLog.recordDiagnosticEvent('failedGrab', {
    jobId: String(job.id),
    categoryName: job.data?.nzb?.categoryName || null,
    youtubeId: job.data?.nzb?.youtubeId || null,
    nzbName: job.data?.nzb?.nzbName || null,
    message,
    timestamp: Date.now(),
  }, MAX_FAILED_GRABS);
}

async function getRecentFailedGrabs() {
  return nzbDiagnosticLog.getDiagnosticEvents('failedGrab', MAX_FAILED_GRABS);
}

/**
 * A job that isn't explicitly Error/Terminated but still has no resolvable
 * video (e.g. StrmMaterializer's metadata fetch threw - age-restricted,
 * bot-check, network failure) genuinely produced nothing. Reporting that to
 * Sonarr/Radarr as Completed with an empty path tells them the grab
 * succeeded, so they never retry with a different release - both the real
 * mode=history handler and the read-only diagnostics snapshot below treat
 * this the same way, via this one shared check.
 * @returns {Promise<{failed: boolean, explicitlyFailed: boolean, videoRow: object|null}>}
 */
async function resolveNzbJobOutcome(job) {
  const explicitlyFailed = job.status === 'Error' || job.status === 'Terminated';
  const videoRow = explicitlyFailed ? null : await resolveNzbVideoRow(job);
  const failed = explicitlyFailed || !videoRow;
  if (failed && !explicitlyFailed) {
    await recordFailedGrab(job, 'Completed with no video file produced - check server logs for the underlying error (e.g. age-restricted content, yt-dlp bot-check, network failure).');
  }
  return { failed, explicitlyFailed, videoRow };
}

// HH:MM:SS.mmm (local time) - millisecond precision matters here because
// several of these events (a history poll noticing an import, a delete
// request) can land within the same second, and the raw epoch-ms
// timestamps behind them (Date.now()) already carry that precision - a
// second-granularity display would silently throw it away.
function formatEventTimestamp(epochMs) {
  if (!epochMs) return null;
  const d = new Date(epochMs);
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/**
 * Human-readable post-download status for the regular Download History page
 * (client/src/components/DownloadManager/DownloadHistory.tsx) - reuses the
 * same facts this file already tracks for the Newznab/SABnzbd emulation
 * itself: which import strategy the grab used, whether Sonarr/Radarr's
 * staged hardlink has since been consumed (see stageForSonarrImport's
 * importedAt), whether the video was untracked from Youtarr's own library
 * (see untrackFromYoutarrLibrary/reconcileMovedUntrackedVideo), and whether
 * Sonarr/Radarr removed the item from ITS OWN history (see
 * handleHistoryDeleteRequest). job.status itself is deliberately left
 * untouched by this (e.g. it still literally reads 'Deleted' after a
 * history-delete call) since other code - the mode=history filter above,
 * status-based UI filters on the client - depends on those exact values;
 * this only computes an additional display-only string layered on top.
 * Returns null for non-NZB jobs, still-active jobs, and Error/Terminated
 * jobs (whose existing status text/notes are already accurate), so the
 * caller falls back to the plain job.status text in all of those cases.
 * @returns {Promise<string|null>}
 */
async function computeNzbStatusDetail(job) {
  if (!job?.data?.nzb) return null;
  if (job.status === 'Pending' || job.status === 'In Progress') return null;
  if (job.status === 'Error' || job.status === 'Terminated') return null;

  const { failed } = await resolveNzbJobOutcome(job);
  if (failed) return 'Failed - no video produced';

  const nzb = job.data.nzb;
  const cfg = configModule.getConfig();
  const category = findCategory(cfg.nzb?.categories || [], { name: nzb.categoryName });
  const strategy = nzb.importStrategy || category?.importStrategy || 'hardlink';
  const historyRemoved = Boolean(nzb.historyRemoved);
  const historyRemovedAt = formatEventTimestamp(nzb.historyRemovedAt);
  const untrackedAt = formatEventTimestamp(nzb.untrackedAt);

  if (strategy === 'untracked') {
    if (nzb.untracked) {
      return `Imported by Sonarr/Radarr - removed from Youtarr library${untrackedAt ? ` at ${untrackedAt}` : ''}`;
    }
    if (historyRemoved) {
      // handleHistoryDeleteRequest asked untrackFromYoutarrLibrary to remove
      // the video but that DB operation itself threw (its `outcome: 'error'`
      // branch) - historyRemoved got set regardless, but the video is still
      // here.
      return `Removed from Sonarr/Radarr history${historyRemovedAt ? ` at ${historyRemovedAt}` : ''} - untrack failed, check server logs`;
    }
    return 'Downloaded - awaiting Sonarr/Radarr import';
  }

  // hardlink strategy: the real library file is never touched by Sonarr/
  // Radarr's import (only the staged copy is - see stageForSonarrImport), so
  // "imported" here just means that staged hardlink has been consumed since
  // it was created.
  const imported = Boolean(nzb.importedAt) ||
    (nzb.stagedPath ? !fs.existsSync(nzb.stagedPath) : false);
  const importedAt = formatEventTimestamp(nzb.importedAt);

  if (historyRemoved) {
    return imported
      ? `Imported by Sonarr/Radarr (history cleared${historyRemovedAt ? ` at ${historyRemovedAt}` : ''})`
      : `Removed from Sonarr/Radarr history${historyRemovedAt ? ` at ${historyRemovedAt}` : ''} (still in Youtarr library)`;
  }
  return imported
    ? `Imported by Sonarr/Radarr${importedAt ? ` at ${importedAt}` : ''}`
    : 'Downloaded - awaiting Sonarr/Radarr import';
}

/**
 * Read-only snapshot of NZB-originated jobs (active queue + recent history)
 * for the NZB diagnostics page - a Newznab/SABnzbd-filtered lens on the same
 * jobModule data the regular Download Activity/History pages already show,
 * not a replacement for them. No independent state of its own; recomputed
 * fresh on every read.
 */
async function getNzbJobsSnapshot() {
  const activeJobs = jobModule.getRunningJobs().filter(
    (j) => j.data?.nzb && (j.status === 'Pending' || j.status === 'In Progress')
  );
  let currentSnapshot = null;
  try {
    const downloadModule = require('../modules/downloadModule');
    currentSnapshot = downloadModule.getCurrentActivitySnapshot ? downloadModule.getCurrentActivitySnapshot() : null;
  } catch { /* best-effort only */ }

  const active = activeJobs.map((j) => {
    const isCurrent = currentSnapshot && String(currentSnapshot.jobId) === String(j.id);
    const progress = isCurrent ? currentSnapshot.activity?.progress : null;
    return {
      jobId: String(j.id),
      isCurrent: Boolean(isCurrent),
      status: j.status === 'In Progress' ? 'Downloading' : 'Queued',
      categoryName: j.data.nzb.categoryName || null,
      nzbName: j.data.nzb.nzbName || null,
      percent: progress?.percent ? Math.trunc(progress.percent) : 0,
      etaSeconds: progress?.etaSeconds || 0,
      totalBytes: progress?.totalBytes || 0,
      downloadedBytes: progress?.downloadedBytes || 0,
    };
  });

  const historyJobs = jobModule.getRunningJobs().filter(
    (j) => j.data?.nzb && !j.data.nzb.historyRemoved &&
      ['Complete', 'Complete with Warnings', 'Error', 'Terminated'].includes(j.status)
  );
  const history = await Promise.all(historyJobs.map(async (j) => {
    const { failed, videoRow } = await resolveNzbJobOutcome(j);
    return {
      jobId: String(j.id),
      status: failed ? 'Failed' : 'Completed',
      categoryName: j.data.nzb.categoryName || null,
      nzbName: j.data.nzb.nzbName || null,
      bytes: videoRow?.fileSize || 0,
    };
  }));

  return { active, history };
}

module.exports = function createNzbRoutes() {
  const router = express.Router();
  router.use(['/nzb/newznab', '/nzb/download', '/nzb/sab'], verifyNzbApiKey);

  // ---- Newznab ----

  router.get('/nzb/newznab', async (req, res) => {
    nzbDebug({ query: req.query }, 'nzb: newznab request');
    const cfg = configModule.getConfig();
    const categories = cfg.nzb?.categories || [];
    const t = String(req.query.t || '').toLowerCase();

    if (t === 'caps') {
      nzbDebug('nzb: caps request');
      res.type('application/xml').send(nzbFeedModule.buildCapsXml(categories));
      return;
    }

    if (t === 'search' || t === 'tvsearch' || t === 'movie') {
      logger.info({ query: req.query }, `nzb: ${t} request`);
      const category = findCategory(categories, { newznabCategoryId: req.query.cat });
      if (!category) {
        res.status(400).type('application/xml').send('<?xml version="1.0"?><error code="200" description="No category configured"/>');
        return;
      }

      const query = String(req.query.q || '').trim();
      const limit = nearestAllowedCount(req.query.limit);
      // Newznab clients occasionally page past the first `limit` results
      // (offset=N) rather than assuming there are none beyond it - previously
      // ignored entirely, so every page request silently returned page one
      // again. fetchCount is how many raw results we actually ask for so a
      // later page can be sliced out of them (see minAllowedCountAtLeast);
      // the response itself is still exactly `limit` items (or fewer, past
      // the end), sliced below after filtering.
      const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
      const fetchCount = minAllowedCountAtLeast(offset + limit);
      const responseOpts = {
        categoryName: category.name,
        newznabCategoryIds: category.newznabCategoryIds,
        baseUrl: `${req.protocol}://${req.get('host')}`,
        apikey: req.query.apikey,
        // The quality every grab actually downloads at - see
        // nzbFeedModule.buildSearchXml's `quality` doc for why this drives
        // the title's [XXXp] label and size estimate instead of a per-video
        // probe (search results have no real resolution data available).
        quality: cfg.preferredResolution,
      };

      // No `q` is standard Newznab "RSS mode" - Prowlarr's indexer Test uses
      // it and Sonarr/Radarr's periodic
      // RSS auto-sync (not just manual searches) depends on it returning
      // real recent items, not an empty set. There's no live "trending
      // YouTube" search to answer this with, so it's served from Youtarr's
      // own knowledge of channel videos instead - the most recently known
      // videos across all subscriptions, newest first.
      if (!query) {
        try {
          const recent = await ChannelVideo.findAll({
            where: { ignored: false, youtube_removed: false, media_type: 'video' },
            order: [['publishedAt', 'DESC']],
            limit,
            offset,
          });
          const results = recent.map((v) => ({
            youtubeId: v.youtube_id,
            title: v.title,
            publishedAt: v.publishedAt,
          }));
          // These never went through videoSearchModule, so `definition` is
          // always unset here - same resolution detection as the real search
          // branch above.
          await applyResolutionDetection(results, getResolutionDetectionConfig(cfg));
          res.type('application/xml').send(nzbFeedModule.buildSearchXml(results, responseOpts));
        } catch (err) {
          logger.error({ err }, 'nzb: RSS-mode (blank query) lookup failed');
          res.status(500).type('application/xml').send('<?xml version="1.0"?><error code="900" description="Search failed"/>');
        }
        return;
      }

      try {
        let newquery = query;
        let season = null;
        let ep = null;
        if (t === 'tvsearch' && (req.query.season || req.query.ep)) {
          if (req.query.season) {
            season = Number.parseInt(req.query.season, 10);
            if (!Number.isFinite(season)) {
              res.status(400).type('application/xml').send('<?xml version="1.0"?><error code="201" description="Invalid season number"/>');
              return;
            }
          }
          if (req.query.ep) {
            ep = Number.parseInt(req.query.ep, 10);
            if (!Number.isFinite(ep)) {
              res.status(400).type('application/xml').send('<?xml version="1.0"?><error code="201" description="Invalid episode number"/>');
              return;
            }
          }

          if (category.searchMode === 'episode') {
            const seasonStr = season !== null ? 'S' + String(season).padStart(2, '0') : '';
            const epStr = ep !== null ? 'E' + String(ep).padStart(2, '0') : '';
            newquery = `${query} ${seasonStr}${epStr}`;
            nzbDebug({ query, season, ep , newquery}, 'nzb: tvsearch with episode mode - adjusted query');
          }

          // Carry Sonarr/Radarr's real season+episode through to the grab so
          // a series-mode download can use them instead of Youtarr's own
          // upload-year-as-season scheme (see seriesEpisodeResolver.js).
          // Only passed through when both are known - a season-only or
          // episode-only override would land in a mismatched folder/filename.
          if (season !== null && ep !== null) {
            responseOpts.season = season;
            responseOpts.ep = ep;
          }
        }

        // Shared between the Recent Query record (videoSearchModule.js) and
        // the search trace recorded below - lets the diagnostics page's
        // Recent Queries table link a row straight to its own trace's
        // full candidate breakdown instead of just showing resultCount.
        const searchId = crypto.randomUUID();
        const rawResults = await videoSearchModule.searchVideos(newquery, fetchCount, { origin: 'nzb', searchId });
        let results = rawResults;

        // Per-candidate verdict (kept/rejected + why) - computed regardless
        // of whether additionalLocalFilter is even on, so the trace below
        // always has something to show. When the filter is off every
        // candidate is trivially "kept" (nothing evaluated it).
        let traceItems;
        if (category.additionalLocalFilter) {
          const beforeCount = results.length;
          // Only enforce the season/episode-code requirement in 'episode'
          // search mode - a 'flat' category has explicitly opted out of
          // season/episode-aware query building above, so it shouldn't
          // silently get season/episode-aware *filtering* anyway. Without
          // this, a flat-mode tvsearch with season/ep params (Sonarr sends
          // these on every tvsearch, regardless of how the category is
          // configured) demanded the title literally contain "Season 22"/
          // "S22" - text real YouTube titles essentially never have -
          // which quietly filtered every real result down to zero.
          const codeConstraint = (t === 'tvsearch' && category.searchMode === 'episode') ? { season, ep } : {};
          const filterOpts = { ...codeConstraint, excludeTerms: category.excludeTerms || [] };

          traceItems = rawResults.map((r) => ({
            youtubeId: r.youtubeId,
            title: r.title,
            ...evaluateTitleFilter(r.title, query, filterOpts),
          }));
          results = rawResults.filter((_, i) => traceItems[i].kept);

          logger.info(
            { categoryName: category.name, beforeCount, afterCount: results.length },
            'nzb: applied additional local filter'
          );
          const rejected = traceItems.filter((item) => !item.kept);
          if (rejected.length > 0) {
            nzbDebug({ categoryName: category.name, rejected }, 'nzb: local filter rejected results');
          }
        } else {
          traceItems = rawResults.map((r) => ({ youtubeId: r.youtubeId, title: r.title, kept: true, reason: null, matchedTerm: null }));
        }

        // Slice the requested page out of the (possibly filtered) results -
        // see fetchCount's comment above for why enough raw results were
        // fetched to cover this. Past the end of what's available, this is
        // just an empty page, not an error.
        results = results.slice(offset, offset + limit);

        // Best-effort resolution detection for whatever's left in `results` -
        // deliberately AFTER filtering/slicing above, not on the full
        // fetchCount-sized rawResults: raw candidates routinely outnumber
        // what actually survives the local title filter and page slice, and
        // probing one about to be discarded would be wasted work. See
        // applyResolutionDetection's doc comment for the fixed/api/thumb/
        // extract fallback chain this runs.
        const { durationMs: resolutionMs, queryCount: resolutionQueryCount } =
          await applyResolutionDetection(results, getResolutionDetectionConfig(cfg));

        // Attach the resolution info just determined onto the matching trace
        // items, so the diagnostics dialog can show, per kept item, the
        // actual [XXXp] label it'll be sent to Sonarr/Radarr with (and which
        // method decided it) - not just whether the title filter kept it.
        // Only items in this page (`results`, post-slice) were ever probed;
        // a kept item that fell outside this page (a later offset request
        // would return it instead) gets no resolution info here, same as a
        // rejected one.
        const configuredHeightTier = nzbFeedModule.resolveQualityTier(cfg.preferredResolution);
        const resultByYoutubeId = new Map(results.map((r) => [r.youtubeId, r]));
        for (const item of traceItems) {
          const r = resultByYoutubeId.get(item.youtubeId);
          if (!r) continue;
          item.definition = r.definition ?? null;
          item.effectiveHeightTier = nzbFeedModule.resolveEffectiveHeightTier(configuredHeightTier, r);
          item.resolutionSource = r.resolutionSource ?? null;
        }

        await recordSearchTrace({
          searchId,
          timestamp: Date.now(),
          categoryName: category.name,
          searchType: t,
          query,
          newquery: newquery !== query ? newquery : null,
          season,
          ep,
          additionalLocalFilterEnabled: Boolean(category.additionalLocalFilter),
          offset,
          limit,
          configuredHeightTier,
          resolutionMs,
          resolutionQueryCount,
          items: traceItems,
        });

        nzbDebug({ results }, 'nzb: search complete');

        res.type('application/xml').send(nzbFeedModule.buildSearchXml(results, responseOpts));
      } catch (err) {
        logger.error({ err, query }, 'nzb: search failed');
        res.status(500).type('application/xml').send('<?xml version="1.0"?><error code="900" description="Search failed"/>');
      }
      return;
    }

    res.status(400).type('application/xml').send('<?xml version="1.0"?><error code="202" description="Unsupported search type"/>');
  });

  // ---- Synthetic per-video NZB download link ----

  router.get('/nzb/download/:categoryName/:file', (req, res) => {
    logger.info({ params: req.params, query: req.query }, 'nzb: download request');
    const { categoryName, file } = req.params;
    const youtubeId = String(file || '').replace(/\.nzb$/i, '');
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(youtubeId)) {
      return res.status(400).send('Invalid video id');
    }
    const title = req.query.title ? String(req.query.title) : youtubeId;
    const season = req.query.season !== undefined ? Number.parseInt(req.query.season, 10) : null;
    const ep = req.query.ep !== undefined ? Number.parseInt(req.query.ep, 10) : null;
    const xml = nzbFeedModule.buildNzbXml({
      youtubeId,
      categoryName,
      title,
      season: Number.isFinite(season) ? season : null,
      ep: Number.isFinite(ep) ? ep : null,
    });
    res.set({
      'Content-Type': 'application/x-nzb',
      'Content-Disposition': `attachment; filename="${youtubeId}.nzb"`,
    });
    res.send(xml);
  });

  // ---- SABnzbd ----

  router.all('/nzb/sab/api', upload.any(), async (req, res) => {
    nzbDebug({ method: req.method, query: req.query, params: req.params, body: req.body }, 'nzb/sab/api request');
    const mode = String(req.query.mode || '').toLowerCase();
    const cfg = configModule.getConfig();
    const categories = cfg.nzb?.categories || [];

    if (mode === 'version') {
      nzbDebug('nzb: version request');
      res.json({ version: '1.0.0' });
      return;
    }

    if (mode === 'get_config') {
      nzbDebug('nzb: get_config request');
      // Field names/types match iplayarr's SabNZBDConfigCategoryResponse
      // exactly, including the mandatory '*' catch-all category Sonarr/
      // Radarr expect as the first entry.
      res.json({
        config: {
          misc: { download_dir: '', complete_dir: '' },
          categories: [
            { name: '*', order: 0, pp: '3', script: 'None', dir: '', newzbin: '', priority: 0 },
            ...categories.map((c, index) => ({
              name: c.name,
              order: index + 1,
              pp: '',
              script: 'None',
              dir: c.subfolder || '',
              newzbin: '',
              priority: 0,
            })),
          ],
          servers: [],
        },
      });
      return;
    }

    if (mode === 'addfile') {
      logger.info(
        {
          files: (req.files || []).map((f) => ({ fieldname: f.fieldname, originalname: f.originalname, mimetype: f.mimetype, size: f.size })),
          body: req.body,
        },
        'nzb: addfile request'
      );
      const downloadModule = require('../modules/downloadModule');
      const file = (req.files || [])[0];
      if (!file || !file.buffer) {
        // Real SABnzbd always answers addfile with HTTP 200 and a JSON
        // status field, even for a rejected upload - Sonarr/Radarr's
        // SabnzbdProxy treats any non-2xx as a DownloadClientException
        // (connection/health failure), which would incorrectly mark the
        // whole download client unavailable instead of just skipping this
        // one release.
        res.status(200).json({ status: false, error: 'No NZB file uploaded' });
        return;
      }

      const { youtubeId, categoryName, nzbName, season, ep } = nzbFeedModule.parseNzbXml(file.buffer);
      if (!youtubeId) {
        res.status(200).json({ status: false, error: 'Could not recover video id from NZB' });
        return;
      }

      const category = findCategory(categories, { name: categoryName });
      if (!category) {
        res.status(200).json({ status: false, error: `Unknown category: ${categoryName}` });
        return;
      }

      try {
        const jobId = await downloadModule.doSpecificDownloads({
          body: {
            urls: [`https://www.youtube.com/watch?v=${youtubeId}`],
            jobLabel: nzbDownloadJobLabel(category.name, youtubeId),
            overrideSettings: {
              subfolder: category.subfolder || null,
              mediaMode: category.mediaMode || 'download',
              // Real season/episode from Sonarr/Radarr's tvsearch, when
              // known - see downloadModule.js/strmMaterializer.js for how
              // this overrides the upload-year-as-season default.
              ...(season != null && ep != null ? { seriesSeasonOverride: season, seriesEpisodeOverride: ep } : {}),
              // Sonarr/Radarr generate their own artwork/nfo on import - skip
              // Youtarr's nfo/season.nfo/tvshow.nfo/fanart/backdrop/poster/
              // thumbnail-jpg for every NZB grab, real download or STRM.
              skipMediaSidecarFiles: true,
            },
            // importStrategy is snapshotted here rather than always re-read
            // live from config later (computeNzbStatusDetail still falls
            // back to a live lookup for older jobs saved before this field
            // existed) - a category can be renamed/reconfigured/deleted
            // after the grab, which would otherwise silently reinterpret an
            // old job's history under today's (or the default) strategy.
            nzb: { categoryName: category.name, youtubeId, nzbName: nzbName || youtubeId, importStrategy: category.importStrategy || 'hardlink' },
          },
        });
        res.json({ status: true, nzo_ids: [String(jobId)] });
      } catch (err) {
        logger.error({ err, youtubeId, categoryName }, 'nzb: addfile failed to enqueue download');
        res.status(200).json({ status: false, error: err.message || 'Failed to enqueue download' });
      }
      return;
    }

    if (mode === 'queue') {
      nzbDebug('nzb: queue request');
      const jobs = jobModule.getRunningJobs().filter(
        (j) => j.data?.nzb && (j.status === 'Pending' || j.status === 'In Progress')
      );
      let snapshot = null;
      try {
        const downloadModule = require('../modules/downloadModule');
        snapshot = downloadModule.getCurrentActivitySnapshot ? downloadModule.getCurrentActivitySnapshot() : null;
      } catch { /* best-effort only */ }

      // Field names/types match iplayarr's SabNZBDQueueResponse/SabNZBQueueEntry
      // (github.com/Nikorag/iplayarr) exactly - Sonarr/Radarr's SABnzbd client
      // expects numeric mb/mbleft/percentage, not strings, and several
      // always-present skeleton fields it otherwise fails to deserialize.
      const slots = jobs.map((j, index) => {
        const isCurrent = snapshot && String(snapshot.jobId) === String(j.id);
        const progress = isCurrent ? snapshot.activity?.progress : null;
        const totalBytes = progress?.totalBytes || 0;
        const downloadedBytes = progress?.downloadedBytes || 0;
        const percent = progress?.percent ? Math.trunc(progress.percent) : 0;
        nzbDebug({ jobId: j.id, isCurrent, totalBytes, downloadedBytes, percent }, 'nzb: queue entry');
        return {
          status: j.status === 'In Progress' ? 'Downloading' : 'Queued',
          index,
          password: '',
          avg_age: '0d',
          script: 'None',
          direct_unpack: '',
          mb: totalBytes / (1024 * 1024),
          mbleft: Math.max(0, (totalBytes - downloadedBytes) / (1024 * 1024)),
          filename: j.data.nzb.nzbName,
          labels: [],
          priority: 'Normal',
          cat: j.data.nzb.categoryName || 'youtarr',
          timeleft: formatTimeleft(progress?.etaSeconds || 0),
          percentage: percent,
          nzo_id: String(j.id),
          unpackopts: 3,
        };
      });

      nzbDebug({ slots }, 'nzb: queue response');

      res.json({
        queue: {
          speedlimit: 0,
          speedlimit_abs: 0,
          paused: false,
          limit: 10,
          start: 0,
          have_warnings: 0,
          pause_int: 0,
          left_quota: 0,
          version: '4.0.0',
          cache_art: 0,
          cache_size: '0 MB',
          finishaction: null,
          paused_all: false,
          quota: 0,
          have_quota: false,
          diskspace1: '0 G',
          diskspacetotal1: '0 G',
          diskspace1_norm: '0 G',
          status: slots.some((s) => s.status === 'Downloading') ? 'Downloading' : 'Idle',
          noofslots_total: slots.length,
          noofslots: slots.length,
          finish: 0,
          speed: '0 KB/s',
          size: '0 MB',
          sizeleft: '0 MB',
          kbpersec: '0',
          slots,
        },
      });
      return;
    }

    // Real SABnzbd/NZBGet history entries persist until explicitly removed -
    // Sonarr/Radarr send this (mode=history&name=delete&value=<nzo_id>[,...])
    // when the user removes an item from Activity/History in their own UI,
    // or when "Remove completed downloads" is enabled. This is the only
    // thing that should ever purge an 'untracked'-strategy video from
    // Youtarr's own library - see handleHistoryDeleteRequest's doc comment.
    if (mode === 'history' && String(req.query.name || '').toLowerCase() === 'delete') {
      const jobIds = String(req.query.value || '').split(',').map((s) => s.trim()).filter(Boolean);
      logger.info({ jobIds }, 'nzb: history delete request');
      await handleHistoryDeleteRequest(jobIds);
      res.json({ status: true });
      return;
    }

    if (mode === 'history') {
      nzbDebug('nzb: history request');
      const jobs = jobModule.getRunningJobs().filter(
        (j) => j.data?.nzb && !j.data.nzb.historyRemoved &&
          ['Complete', 'Complete with Warnings', 'Error', 'Terminated'].includes(j.status)
      );

      nzbDebug({ jobs: jobs.map((j) => ({ jobId: j.id, status: j.status })) }, 'nzb: history entries');
      
      // Field names/types match iplayarr's SabNZBDHistoryResponse/
      // SABNZBDHistoryEntryResponse exactly. storage/path is either a staged
      // hardlink (importStrategy 'hardlink', protecting Youtarr's own library
      // copy - see stageForSonarrImport) or the real file directly
      // (importStrategy 'untracked'). Either way the video stays a normal,
      // visible entry in Youtarr's own library - it is NOT purged here just
      // because Sonarr/Radarr polled history; that only happens in response
      // to an explicit mode=history&name=delete call (real SABnzbd/NZBGet
      // clients keep history entries until told to remove them - see
      // untrackFromYoutarrLibrary below).
      const slots = await Promise.all(jobs.map(async (j) => {
        const { failed, explicitlyFailed, videoRow } = await resolveNzbJobOutcome(j);
        const bytes = videoRow?.fileSize || 0;
        const category = findCategory(categories, { name: j.data.nzb.categoryName });
        const strategy = category?.importStrategy || 'hardlink';
        let filePath = null;
        if (!failed) {
          if (strategy === 'untracked') {
            filePath = videoRow?.filePath || null;
            nzbDebug({ jobId: j.id, filePath }, 'nzb: history entry - untracked strategy');
          } else {
            filePath = stageForSonarrImport(j, j.data.nzb.categoryName || 'youtarr', videoRow);
          }
        }
        nzbDebug({ jobId: j.id, failed, filePath, bytes, strategy }, 'nzb: history entry');
        const reportedPath = remapPathForSonarr(filePath);
        nzbDebug({ jobId: j.id, reportedPath }, 'nzb: history entry remapped path for Sonarr/Radarr');
        const nowSeconds = Math.floor(Date.now() / 1000);
        return {
          action_line: '',
          duplicate_key: String(j.id),
          meta: null,
          fail_message: failed
            ? (explicitlyFailed ? (j.output || 'Failed') : 'No video file was produced - check Youtarr server logs')
            : '',
          loaded: false,
          size: formatBytes(bytes),
          category: j.data.nzb.categoryName || 'youtarr',
          pp: 'D',
          retry: 0,
          script: 'None',
          nzb_name: `${j.data.nzb.nzbName}.nzb`,
          download_time: 0,
          storage: reportedPath || '',
          has_rating: false,
          status: failed ? 'Failed' : 'Completed',
          script_line: '',
          completed: nowSeconds,
          nzo_id: String(j.id),
          downloaded: bytes,
          report: '',
          password: '',
          path: reportedPath || '',
          postproc_time: 0,
          name: j.data.nzb.nzbName,
          url: `${j.data.nzb.nzbName}.nzb`,
          md5sum: '',
          archive: false,
          bytes,
          url_info: '',
          stage_log: [],
        };
      }));

      res.json({
        history: {
          noofslots: slots.length,
          ppslots: 0,
          day_size: '0 MB',
          week_size: '0 MB',
          month_size: '0 MB',
          total_size: '0 MB',
          last_history_update: Math.floor(Date.now() / 1000),
          slots,
        },
      });
      return;
    }

    res.status(200).json({ status: false, error: `Unsupported mode: ${mode}` });
  });

  return router;
};

// Exposed on the factory function (still callable exactly as before) purely
// so the local-filter regex logic can be unit tested directly, without
// spinning up an Express app/request - see __tests__/nzb.test.js.
module.exports.titleMatchesEpisodeCode = titleMatchesEpisodeCode;
module.exports.applyLocalTitleFilter = applyLocalTitleFilter;
module.exports.evaluateTitleFilter = evaluateTitleFilter;
module.exports.getResolutionDetectionConfig = getResolutionDetectionConfig;
module.exports.applyResolutionDetection = applyResolutionDetection;
// Real production use (not just testability, unlike the two above): the
// NZB diagnostics page's GET /api/nzb/stats (server/routes/config.js) reads
// this same factory-function property to surface the per-search trace and
// failed-grab tables - both now backed by the persisted nzb_diagnostic_log
// table (see nzbDiagnosticLog.js), not an in-memory array.
module.exports.getRecentSearchTraces = getRecentSearchTraces;
module.exports.getRecentFailedGrabs = getRecentFailedGrabs;
module.exports.getNzbJobsSnapshot = getNzbJobsSnapshot;
// Consumed by routes/jobs.js's /runningjobs handler to enrich NZB-originated
// jobs for the regular Download History page - see this function's own doc
// comment for why job.status itself is never changed to carry this instead.
module.exports.computeNzbStatusDetail = computeNzbStatusDetail;
// Consumed by videosModule's real-time file check - see this function's own
// doc comment for why the reconciliation can't just live inside nzb.js.
module.exports.reconcileMovedUntrackedVideo = reconcileMovedUntrackedVideo;
