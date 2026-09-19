/**
 * server/modules/ytstream/cacheFinalize.js
 *
 * Serves already-downloaded/cached video files directly, and finalizes a
 * completed hls-buffer .ts fetch into whichever permanent form applies
 * (library .mp4, hidden-cache .mp4 swap, etc). Extracted from
 * server/routes/ytstream.js so it's a real importable module instead of
 * trapped in that file's private route-factory closure.
 *
 * `findLiveSessionReferencing` and everything that calls it need to check
 * the HLS session engine's live session map before deleting/renaming a file
 * a session might still read from - that map is still owned by
 * server/routes/ytstream.js today (it moves to a dedicated HLS-engine
 * module in a later phase), so `createCacheFinalize({ hlsSessions })`
 * takes it as an explicit dependency rather than this module reaching for
 * shared mutable state directly.
 */
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const logger = require('../../logger');
const configModule = require('../configModule');
const { streamDebug } = require('./streamDebug');
const { resolveVideoTargetResolution } = require('./videoResolution');
const { findWarmUntrackedBufferCache, getUntrackedBufferCacheMp4Path } = require('./untrackedBufferCache');

/**
 * quality/container for a StreamHistory row that serves an already-downloaded
 * file directly - the probe-shortcut's existingCachedFilePath branch and
 * serveCachedFile's mode='cached-file' branch, neither of which goes
 * through resolvePlaybackPlan's requested-quality logic at all. Without this
 * their Format column stayed completely blank even though the real served
 * resolution/container is fully knowable from the source file itself (this
 * is the actual file, not a requested/configured target).
 */
async function resolveActualServedFileInfo(youtubeId, filePath, models) {
  const { height } = await resolveVideoTargetResolution(youtubeId, models);
  const container = path.extname(filePath).replace(/^\./, '').toLowerCase() || null;
  return { quality: height ? String(height) : null, container, transcode: 'copy' };
}

/**
 * ytstream.serveCachedFile: once a video is fully downloaded, serves the
 * real local file directly - no yt-dlp, no ffmpeg. Unlike the HLS-asset
 * route and tryServeProbeClip (both advertise `Accept-Ranges: bytes` but
 * always send the whole file, fine for small segments never actually
 * seeked into), this is a genuine RFC 7233 partial-content implementation,
 * since a full video needs real seek performance in the player.
 * @returns {Promise<boolean>} true if a response was sent (caller must
 *   return immediately without falling through to normal handling).
 */
async function tryServeCachedVideoFile(req, res, filePath, onBytesSent = undefined) {
  // ytstream.finalizeToMp4: prefer an already-finalized .mp4 remux over the
  // raw .ts whenever one exists (never triggers ffmpeg here - only a peek;
  // see tsRemuxCache.js). Avoids ever handing a real player (or Jellyfin's
  // own probe/transcode) a container it can't direct-play, without adding
  // any latency to this request when no remux exists yet.
  if (path.extname(filePath).toLowerCase() === '.ts') {
    const remuxPath = require('../tsRemuxCache').findExistingSeekableMp4(filePath);
    if (remuxPath) filePath = remuxPath;
  }

  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (err) {
    logger.warn({ err, filePath }, 'ytstream: serveCachedFile stat failed; falling back to normal handling');
    return false;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = ext === '.mkv' ? 'video/x-matroska' : ext === '.webm' ? 'video/webm' : ext === '.ts' ? 'video/mp2t' : 'video/mp4';
  const range = req.headers.range;

  if (!range) {
    res.set({ 'Content-Type': contentType, 'Content-Length': String(stat.size), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') { res.end(); return true; }
    // stream.pipeline (not a bare .pipe() + manual Promise) so a client that
    // stops reading mid-transfer - e.g. a metadata-probe UA (Lavf/ffprobe)
    // that only wants the header atoms and then drops the connection - gets
    // detected: pipeline treats the response closing before the source ends
    // as ERR_STREAM_PREMATURE_CLOSE, destroys the read stream, and settles.
    // A bare .pipe() never observes the destination closing early, so the
    // wrapping Promise (and this whole await, and the caller's history-end
    // write) hung forever - see stream_history rows stuck "in progress".
    try {
      const source = fs.createReadStream(filePath);
      if (onBytesSent) source.on('data', (chunk) => onBytesSent(chunk.length));
      await pipeline(source, res);
    } catch (err) {
      if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        logger.warn({ err, filePath }, 'ytstream: serveCachedFile stream failed');
      }
    }
    return true;
  }

  // Only the single-range "bytes=START-END" form (END and/or START optional)
  // is handled - every real player/browser only ever sends one range.
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) {
    res.status(416).set('Content-Range', `bytes */${stat.size}`).end();
    return true;
  }
  let start = match[1] ? parseInt(match[1], 10) : undefined;
  let end = match[2] ? parseInt(match[2], 10) : undefined;
  if (start === undefined) {
    // Suffix range, e.g. "bytes=-500" = the last 500 bytes.
    start = Math.max(0, stat.size - end);
    end = stat.size - 1;
  } else if (end === undefined || end >= stat.size) {
    end = stat.size - 1;
  }
  if (start > end || start >= stat.size) {
    res.status(416).set('Content-Range', `bytes */${stat.size}`).end();
    return true;
  }

  res.status(206).set({
    'Content-Type': contentType,
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') { res.end(); return true; }
  // See the no-range branch above for why this is pipeline() and not a bare
  // .pipe(): without it, a probe that opens a range request and disconnects
  // before reading the whole range leaves this await (and the caller's
  // history-end write) hanging indefinitely.
  try {
    const source = fs.createReadStream(filePath, { start, end });
    if (onBytesSent) source.on('data', (chunk) => onBytesSent(chunk.length));
    await pipeline(source, res);
  } catch (err) {
    if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      logger.warn({ err, filePath }, 'ytstream: serveCachedFile ranged stream failed');
    }
  }
  return true;
}

/**
 * ytstream.probeShortcut: if a real, complete local copy of this video
 * already exists (genuine download, or the untracked hls-buffer cache),
 * there's no reason to hand a probe request the synthetic clip - the real
 * file already has correct duration/codecs, and serving it is the same
 * cost (local disk read). Checked ahead of tryServeProbeClip so the fake
 * clip machinery only runs when no real file exists yet. Unlike the
 * config-gated `serveCachedFile` feature (which controls whether REAL
 * playback bypasses transcoding), this always applies regardless of that
 * setting - answering a probe accurately carries none of its tradeoffs.
 * @returns {Promise<string|null>} the real file's path, or null if no
 *   complete local copy exists yet.
 */
async function findExistingCachedVideoFilePath(youtubeId, models) {
  const untrackedPath = findWarmUntrackedBufferCache(youtubeId);
  if (untrackedPath) return untrackedPath;
  if (models && models.Video) {
    try {
      const video = await models.Video.findOne({ where: { youtubeId }, attributes: ['is_strm', 'filePath'] });
      if (video && video.is_strm === false && video.filePath && fs.existsSync(video.filePath)) {
        streamDebug({ youtubeId, filePath: video.filePath }, 'ytstream: findExistingCachedVideoFilePath found a real downloaded library file');
        return video.filePath;
      }
      streamDebug({ youtubeId, hasVideoRow: !!video, isStrm: video?.is_strm }, 'ytstream: findExistingCachedVideoFilePath found nothing');
    } catch (err) {
      logger.warn({ err, youtubeId }, 'ytstream: findExistingCachedVideoFilePath DB lookup failed; treating as no cached file');
    }
  }
  return null;
}

/**
 * @param {Map} hlsSessions - the HLS session engine's live session map (see
 *   this module's own doc comment for why it's injected rather than owned
 *   here).
 */
function createCacheFinalize({ hlsSessions }) {
  /**
   * Any live (non-destroying) HLS session that still has `finalPath` as its
   * cachedFilePath - such a session could still open a brand-new read of it
   * later (a seek-restart, or another backfill pass triggered by
   * maybeBackfillMissingSegments), so neither deleting nor renaming-away
   * `finalPath` is safe while this returns non-null. Not a concern for reads
   * already in progress right now: POSIX unlink/rename-while-open semantics
   * mean an already-open read (a viewer's in-flight download, mid-transfer)
   * keeps working fine off its existing file handle regardless - only a NEW
   * open of the now-missing/renamed path would fail, which is exactly what
   * this guards against.
   * @param {string} finalPath
   * @returns {object|null} the blocking session, or null if none
   */
  function findLiveSessionReferencing(finalPath) {
    return [...hlsSessions.values()].find((s) => !s.destroying && s.cachedFilePath === finalPath) || null;
  }

  /**
   * Deletes a permanently-finalized .ts file now that a seekable .mp4 remux
   * of it exists, once findLiveSessionReferencing confirms it's safe. Only
   * used for a .ts with no library Video row to promote instead (see
   * promoteFinalizedTsToLibraryMp4) - freeing this disk space is a
   * nice-to-have, never worth risking a live session over.
   * @param {string} finalPath - the .ts file's real on-disk path
   * @param {object} context - extra fields for the log lines only (e.g. youtubeId, sourceLabel)
   */
  function trySafeDeleteFinalizedTs(finalPath, context) {
    const stillReferencedBy = findLiveSessionReferencing(finalPath);
    if (stillReferencedBy) {
      logger.info(
        { ...context, finalPath, blockedBySessionKey: stillReferencedBy.key },
        'ytstream: keeping finalized .ts for now - still referenced by an active HLS session'
      );
      return;
    }
    fs.unlink(finalPath, (err) => {
      if (err) {
        if (err.code !== 'ENOENT') {
          logger.warn({ err, ...context, finalPath }, 'ytstream: failed to delete finalized .ts after successful .mp4 remux');
        }
        return;
      }
      logger.info({ ...context, finalPath }, 'ytstream: deleted finalized .ts - its .mp4 remux exists and no active session references it');
    });
  }

  /**
   * Promotes a finalized-.ts's tsRemuxCache .mp4 (an internal, hashed-filename
   * cache-only copy - see tsRemuxCache.js) into a REAL library file: same
   * folder, same basename as the .ts, sibling .mp4, with the Video row's
   * filePath/fileSize repointed at it. Without this, a tracked library video
   * left as .ts (its Video.filePath) with only a cache-dir .mp4 shadow copy
   * goes permanently unplayable via the general /api/videos/:id/stream route
   * the moment the .ts is later deleted - that route checks fs.access(video.filePath)
   * before ever consulting tsRemuxCache, and ytstream's own routes are the
   * only ones that know to prefer the cache copy.
   *
   * Guarded by the exact same findLiveSessionReferencing check
   * trySafeDeleteFinalizedTs uses - deferred (never retried automatically
   * except via destroyHlsSession's teardown hook) while still referenced.
   *
   * Falls back to trySafeDeleteFinalizedTs (today's plain-delete behavior)
   * when no Video row's filePath still matches finalPath - an untracked
   * buffer-fetch (no Video row - see finalizeTapOutput's skipVideoUpsert) has
   * no library location to promote into; its .mp4 keeps being served out of
   * the internal tsRemuxCache exactly as before.
   * @param {string} youtubeId
   * @param {string} finalPath - the .ts file's real on-disk path
   * @param {string} mp4CachePath - tsRemuxCache's already-produced .mp4 for it
   * @param {object} context - extra fields for the log lines only
   */
  async function promoteFinalizedTsToLibraryMp4(youtubeId, finalPath, mp4CachePath, context) {
    const stillReferencedBy = findLiveSessionReferencing(finalPath);
    if (stillReferencedBy) {
      logger.info(
        { ...context, finalPath, blockedBySessionKey: stillReferencedBy.key },
        'ytstream: keeping finalized .ts for now - still referenced by an active HLS session'
      );
      return;
    }
    try {
      const Video = require('../../models/video');
      const video = await Video.findOne({ where: { youtubeId, filePath: finalPath } });
      if (!video) {
        trySafeDeleteFinalizedTs(finalPath, context);
        return;
      }
      const libraryMp4Path = path.join(path.dirname(finalPath), `${path.basename(finalPath, path.extname(finalPath))}.mp4`);
      try {
        fs.renameSync(mp4CachePath, libraryMp4Path);
      } catch (err) {
        if (err.code !== 'EXDEV') throw err;
        fs.copyFileSync(mp4CachePath, libraryMp4Path);
        fs.unlinkSync(mp4CachePath);
      }
      const fileSize = fs.statSync(libraryMp4Path).size;
      await video.update({ filePath: libraryMp4Path, fileSize });
      fs.unlink(finalPath, (err) => {
        if (err && err.code !== 'ENOENT') {
          logger.warn({ err, ...context, finalPath }, 'ytstream: failed to delete original .ts after promoting to library .mp4');
        }
      });
      logger.info({ ...context, finalPath, libraryMp4Path }, 'ytstream: promoted finalized .ts to a real library .mp4 (Video row repointed)');
    } catch (err) {
      logger.warn({ err, ...context, finalPath, mp4CachePath }, 'ytstream: promoteFinalizedTsToLibraryMp4 failed; leaving .ts and cache .mp4 as-is');
    }
  }

  /**
   * Hybrid finalizeToMp4 path (ytstream.stealthCache off, finalizeToMp4 on):
   * promotes a hidden hls-buffer cache .ts's tsRemuxCache .mp4 (see
   * tsRemuxCache.js) directly into a still-STRM video's real library location
   * as a `.mp4` sibling of its `.strm` - the `.ts` itself never touched the
   * visible library folder at any point (it was buffer-fetched into the same
   * hidden cache the untracked path uses). Jellyfin's scanner therefore only
   * ever sees the `.strm` replaced by the finished `.mp4` in one step, never
   * an intermediate `.ts` it could index and then lose - the exact race the
   * old always-visible-.ts flow (promoteFinalizedTsToLibraryMp4) doesn't
   * protect against.
   *
   * Unlike promoteFinalizedTsToLibraryMp4, the Video row's filePath was never
   * repointed at the hidden .ts (finalizeTapOutput ran with
   * skipVideoUpsert:true for it, same as the untracked-cache path), so this
   * looks the video up by youtubeId + is_strm:true instead of an exact
   * filePath match, and resolves targetDir/fileStem from its CURRENT .strm
   * path at promotion time (which may differ from whatever it was when
   * buffering started).
   *
   * Guarded by the same findLiveSessionReferencing check
   * promoteFinalizedTsToLibraryMp4 uses - deferred while the hidden .ts is
   * still an active session's source, retried by destroyHlsSession's teardown
   * hook. Deliberately never deletes the hidden .ts (unlike
   * trySafeDeleteFinalizedTs) - it's the same shared cache the untracked path
   * uses and stays a valid warm copy either way, reclaimed later by the
   * existing untracked-cache expiry sweep rather than here.
   * @param {string} youtubeId
   * @param {string} hiddenTsPath - the hidden-cache .ts file's on-disk path
   * @param {string} mp4CachePath - tsRemuxCache's already-produced .mp4 for it
   * @param {object} context - extra fields for the log lines only
   */
  async function promoteHiddenMp4ToLibrary(youtubeId, hiddenTsPath, mp4CachePath, context) {
    streamDebug({ ...context, youtubeId, hiddenTsPath, mp4CachePath }, 'ytstream: promoteHiddenMp4ToLibrary invoked');
    const stillReferencedBy = findLiveSessionReferencing(hiddenTsPath);
    if (stillReferencedBy) {
      logger.info(
        { ...context, hiddenTsPath, blockedBySessionKey: stillReferencedBy.key },
        'ytstream: keeping hidden .ts for now - still referenced by an active HLS session'
      );
      return;
    }
    try {
      const Video = require('../../models/video');
      const video = await Video.findOne({ where: { youtubeId, is_strm: true } });
      if (!video || !video.filePath) {
        // Already promoted by a previous run, or no longer STRM/tracked -
        // nothing to do here; the hidden .ts is left alone either way.
        streamDebug(
          { ...context, youtubeId, hiddenTsPath, videoFound: !!video },
          'ytstream: promoteHiddenMp4ToLibrary skipped - no longer a STRM Video row to promote into'
        );
        return;
      }
      const targetDir = path.dirname(video.filePath);
      const fileStem = path.basename(video.filePath, path.extname(video.filePath));
      const libraryMp4Path = path.join(targetDir, `${fileStem}.mp4`);
      fs.mkdirSync(targetDir, { recursive: true });
      try {
        fs.renameSync(mp4CachePath, libraryMp4Path);
      } catch (err) {
        if (err.code !== 'EXDEV') throw err;
        fs.copyFileSync(mp4CachePath, libraryMp4Path);
        fs.unlinkSync(mp4CachePath);
      }
      const fileSize = fs.statSync(libraryMp4Path).size;

      // A REAL, persisted Job row for Download History - same shape as
      // finalizeTapOutput's tracked-path Job.create, just a second row for
      // this video (the earlier hidden-cache finalize already created one via
      // skipVideoUpsert): that one records "buffered into the hidden cache",
      // this one records "promoted to a real library file" - two genuinely
      // distinct events worth keeping separate in the history.
      const Job = require('../../models/job');
      const jobInstance = await Job.create({
        status: 'Complete',
        timeInitiated: new Date(),
        timeCreated: new Date(),
        jobType: `HLS Buffer Cache: ${youtubeId}`,
        output: '1 videos.',
      });
      const videoPersistence = require('../videoPersistence');
      // is_strm:false here is what triggers upsertVideoForJob's
      // _archiveStaleStrmSidecars - the .strm gets renamed to .strm.cached in
      // this exact call, replaced by libraryMp4Path, so Jellyfin's next scan
      // finds the .mp4 and nothing else.
      const videoInstance = await videoPersistence.upsertVideoForJob(
        { youtubeId, filePath: libraryMp4Path, fileSize, is_strm: false },
        jobInstance,
        true
      );
      const jobModule = require('../jobModule');
      jobModule.jobs[jobInstance.id] = {
        id: jobInstance.id,
        jobType: jobInstance.jobType,
        status: jobInstance.status,
        output: jobInstance.output,
        timeInitiated: jobInstance.timeInitiated,
        timeCreated: jobInstance.timeCreated,
        data: { videos: [{ id: videoInstance.id }] },
      };

      logger.info(
        { ...context, hiddenTsPath, libraryMp4Path },
        'ytstream: promoted hidden hls-buffer cache to a real library .mp4 - .strm archived, Jellyfin never saw the .ts'
      );
    } catch (err) {
      logger.warn({ err, ...context, hiddenTsPath, mp4CachePath }, 'ytstream: promoteHiddenMp4ToLibrary failed; leaving .strm and hidden .ts as-is');
    }
  }

  /**
   * ytstream.stealthCache (full stealth), or a genuinely untracked video:
   * once the hidden .ts has been remuxed to .mp4 (maybeFinalizeTsToMp4 /
   * tsRemuxCache.ensureSeekableMp4), makes that .mp4 the hidden cache's new
   * canonical file instead of leaving it as an orphaned copy inside
   * tsRemuxCache's own hashed-name dir - moves it to
   * getUntrackedBufferCacheMp4Path(youtubeId), right alongside where the .ts
   * used to live, then deletes the now-redundant .ts. Every lookup of this
   * hidden cache (findWarmUntrackedBufferCache, probe-shortcut,
   * listUntrackedBufferCacheEntries) already checks both extensions, so this
   * swap is transparent to them - there's no promotion to a library location
   * here (unlike promoteFinalizedTsToLibraryMp4/promoteHiddenMp4ToLibrary),
   * is_strm/.strm are never touched.
   *
   * Also records a separate "HLS Buffer Cache Finalize" Job (ytstreamTapFinalizer.
   * recordTsToMp4Finalize) so Download History shows the .mp4 and its real
   * size as its own history line, cross-linked to the original fetch's row,
   * rather than overwriting that row's own recorded fileSize/speed.
   *
   * Guarded by the same findLiveSessionReferencing check the library-promote
   * functions use - deferred while the hidden .ts is still an active
   * session's source, retried by destroyHlsSession's teardown hook.
   * @param {string} youtubeId
   * @param {string} hiddenTsPath - the hidden-cache .ts file's on-disk path
   * @param {string} mp4CachePath - tsRemuxCache's already-produced .mp4 for it
   * @param {object} context - extra fields for the log lines only
   */
  async function swapHiddenCacheToMp4(youtubeId, hiddenTsPath, mp4CachePath, context) {
    const stillReferencedBy = findLiveSessionReferencing(hiddenTsPath);
    if (stillReferencedBy) {
      logger.info(
        { ...context, hiddenTsPath, blockedBySessionKey: stillReferencedBy.key },
        'ytstream: keeping hidden .ts for now - still referenced by an active HLS session'
      );
      return;
    }
    try {
      const hiddenMp4Path = getUntrackedBufferCacheMp4Path(youtubeId);
      fs.mkdirSync(path.dirname(hiddenMp4Path), { recursive: true });
      try {
        fs.renameSync(mp4CachePath, hiddenMp4Path);
      } catch (err) {
        if (err.code !== 'EXDEV') throw err;
        fs.copyFileSync(mp4CachePath, hiddenMp4Path);
        fs.unlinkSync(mp4CachePath);
      }
      const fileSize = fs.statSync(hiddenMp4Path).size;
      fs.unlink(hiddenTsPath, (err) => {
        if (err && err.code !== 'ENOENT') {
          logger.warn({ err, ...context, hiddenTsPath }, 'ytstream: failed to delete hidden .ts after swapping stealth cache to .mp4');
        }
      });
      const updated = await require('../ytstreamTapFinalizer').recordTsToMp4Finalize(youtubeId, hiddenTsPath, hiddenMp4Path, fileSize);
      logger.info(
        { ...context, hiddenTsPath, hiddenMp4Path, downloadHistoryUpdated: updated },
        'ytstream: swapped hidden hls-buffer cache from .ts to .mp4'
      );
    } catch (err) {
      logger.warn({ err, ...context, hiddenTsPath, mp4CachePath }, 'ytstream: swapHiddenCacheToMp4 failed; leaving hidden .ts and cache .mp4 as-is');
    }
  }

  /**
   * Picks the right "what to do once this .ts is remuxed to .mp4" strategy
   * for an hls-buffer session, shared by both the finalize-success dispatch
   * and destroyHlsSession's teardown-retry hook so they can never disagree:
   *  - bufferStealth (ytstream.stealthCache on): swap the hidden cache to
   *    .mp4 in place - see swapHiddenCacheToMp4's own doc comment.
   *  - bufferHybridPromote (stealthCache off, finalizeToMp4 on): promote the
   *    .mp4 straight into the library - see promoteHiddenMp4ToLibrary.
   *  - bufferUntracked (genuinely no Video row, stealthCache/hybrid both
   *    irrelevant): same hidden cache, same swap-to-mp4 treatment - there's
   *    no library to promote into either way.
   *  - none of the above (today's plain tracked-library .ts, unrelated to
   *    any of ytstream.stealthCache's hidden-cache machinery): the original
   *    promoteFinalizedTsToLibraryMp4.
   * @param {object} session
   * @returns {(youtubeId: string, finalPath: string, mp4Path: string, context: object) => Promise<void>}
   */
  function resolveHlsBufferPromoteFn(session) {
    if (session.bufferStealth) return swapHiddenCacheToMp4;
    if (session.bufferHybridPromote) return promoteHiddenMp4ToLibrary;
    if (session.bufferUntracked) return swapHiddenCacheToMp4;
    return promoteFinalizedTsToLibraryMp4;
  }

  /**
   * A reused hidden-cache hit (bufferEnabled's "already warm, skip fetch"
   * branches) never otherwise gets a chance at maybeFinalizeTsToMp4 - that
   * only ever runs off a FRESH finalize's finish() callback. Without this, a
   * video cached while finalizeToMp4 was off (or before a remux attempt ever
   * succeeded) would stay a .ts forever once warm - nothing else re-triggers
   * a remux for an already-cached file, so every later reuse would just keep
   * finding the same untouched .ts. Safe to call unconditionally on every
   * reuse hit: tsRemuxCache.ensureSeekableMp4 is a cheap existence check once
   * a remux already exists, and joins/dedupes an in-flight one otherwise -
   * see its own doc comment.
   * @param {string} youtubeId
   * @param {string} cachedFilePath - whatever findWarmUntrackedBufferCache returned
   * @param {object} session
   */
  function maybeRetroactivelyRemuxReusedCache(youtubeId, cachedFilePath, session) {
    if (path.extname(cachedFilePath).toLowerCase() !== '.ts') return;
    const promoteFn = resolveHlsBufferPromoteFn(session);
    maybeFinalizeTsToMp4(youtubeId, cachedFilePath, 'hls-buffer-reuse', {
      promote: (mp4Path) => promoteFn(youtubeId, cachedFilePath, mp4Path, { youtubeId, sourceLabel: 'hls-buffer-reuse' }),
    });
  }

  /**
   * ytstream.finalizeToMp4: called after finalizeTapOutput (mode=hls-buffer)
   * successfully lands a session's permanent output file. Fires a
   * background (never awaited by any caller) tsRemuxCache.ensureSeekableMp4
   * run when that output is a .ts - purely eager pre-warming, so the FIRST
   * real playback/probe of it already finds the .mp4 via
   * tryServeCachedVideoFile's own findExistingSeekableMp4 check instead of
   * paying the remux cost live. No-op (and no ffmpeg run at all) unless the
   * config option is on and the file is actually .ts.
   *
   * `promote`, if given, is called with the finished .mp4's cache path once
   * the remux succeeds - the caller picks the right strategy for how this
   * particular .ts got here: promoteFinalizedTsToLibraryMp4 for a .ts that
   * was already sitting in the library, promoteHiddenMp4ToLibrary for one
   * that was deliberately kept hidden (ytstream.stealthCache's hybrid mode),
   * or omitted entirely for a full-stealth session, which must never promote
   * or delete anything - see that branch's own comment on why the hidden .ts
   * has to survive the remux. Failures are logged internally by whichever
   * promote function runs; destroyHlsSession's teardown-retry hook
   * re-attempts a blocked promotion once the session that was blocking it ends.
   */
  function maybeFinalizeTsToMp4(youtubeId, finalPath, sourceLabel, { promote } = {}) {
    try {
      if ((configModule.getConfig().ytstream || {}).finalizeToMp4 !== true) return;
      if (!finalPath || path.extname(finalPath).toLowerCase() !== '.ts') return;
      logger.info({ youtubeId, finalPath, sourceLabel }, 'ytstream: starting background .ts -> .mp4 finalize');
      streamDebug({ youtubeId, finalPath, sourceLabel, willPromote: !!promote }, 'ytstream: maybeFinalizeTsToMp4 promote-strategy decision');
      require('../tsRemuxCache').ensureSeekableMp4(finalPath)
        .then((mp4Path) => {
          if (mp4Path) {
            logger.info({ youtubeId, finalPath, mp4Path, sourceLabel }, 'ytstream: finalized .ts remuxed to .mp4 for direct playback');
            if (promote) {
              promote(mp4Path).catch(() => { /* already logs internally */ });
            }
          }
        })
        .catch((err) => logger.warn({ err, youtubeId, finalPath, sourceLabel }, 'ytstream: post-finalize .ts -> .mp4 remux failed'));
    } catch (err) {
      logger.warn({ err, youtubeId, finalPath, sourceLabel }, 'ytstream: maybeFinalizeTsToMp4 failed');
    }
  }

  return {
    findLiveSessionReferencing,
    trySafeDeleteFinalizedTs,
    promoteFinalizedTsToLibraryMp4,
    promoteHiddenMp4ToLibrary,
    swapHiddenCacheToMp4,
    resolveHlsBufferPromoteFn,
    maybeRetroactivelyRemuxReusedCache,
    maybeFinalizeTsToMp4,
  };
}

module.exports = {
  resolveActualServedFileInfo,
  tryServeCachedVideoFile,
  findExistingCachedVideoFilePath,
  createCacheFinalize,
};
