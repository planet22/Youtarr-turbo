/**
 * server/modules/ytstream/byteRangeHlsMode.js
 *
 * `mode=hls-byterange` (experimental): ffmpeg encodes into one continuously-
 * growing fragmented-mp4 file (`-f hls -hls_flags single_file
 * -hls_segment_type fmp4`). Two delivery styles for the SAME underlying
 * session/file, chosen by `ytstream.byteRangeDeliverAsFile`
 * (`resolveYtstreamParams`'s `byteRangeDeliverAsFile`, threaded through
 * server/routes/ytstream.js's experimental-mode interception):
 *
 *   - Default (false) - "byte-range HLS": the top-level URL returns the
 *     `.m3u8` manifest (`#EXT-X-MAP`/`#EXT-X-BYTERANGE` pointing into the
 *     single growing file), served via a separate asset route
 *     (handleByteRangeHlsAsset) with real HTTP Range support. This is the
 *     well-supported path: an HLS-aware client reads duration/seek info
 *     from the manifest, never from Content-Length.
 *   - Opt-in (true) - "deliver as file": the top-level URL serves the
 *     growing `stream.mp4` directly via Range, no manifest at all - the
 *     client never knows this is HLS-shaped internally. Real, documented
 *     risk here (see the "byte-range HLS as raw file" research this
 *     option came out of): without a manifest, a native player (AVPlayer
 *     included) determines duration by probing the file/Content-Length
 *     itself, and a currently-growing file's changing declared size is a
 *     known source of "byte range and no content length"-style failures.
 *     Opt-in and off by default for exactly that reason.
 *
 * strmMediaInfoCache.js's `_resolveContainer` mirrors this exact choice:
 * 'hls' when byteRangeDeliverAsFile is false (a genuine manifest is
 * served), 'mp4' when true (a genuine flat/Range-servable file is served)
 * - getting this wrong reproduces the original "moov atom not found"
 * Container-misdetection bug this whole investigation started from.
 *
 * Deliberately a fresh, standalone, much-simplified module rather than a
 * new branch inside hlsEngine.js: it does NOT share hlsEngine.js's session
 * map, spawn/pipe logic, or asset route, specifically so this experimental
 * mode can never regress mode=hls/hls-buffer. Simplifications versus that
 * file (by design, not oversight):
 *   - No seek-restart: forward-only playback. A player seeking past the
 *     encoded frontier has nothing to jump to (this mode has no equivalent
 *     of ensureHlsSegmentAvailable's restart-the-encoder logic).
 *   - No calculatedLength/pre-declared duration.
 *   - No hot-swap-to-cache, no backfill, no info-json seek caching, no
 *     player-client retry-on-error. One straight yt-dlp(video)+yt-dlp(audio)
 *     piped into one ffmpeg pass, same shape as hlsEngine's plain network
 *     path, just simpler.
 *   - The `container` setting is ignored - always fMP4/mp4.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const logger = require('../../logger');
const { normalizeHardwareMode, normalizeTuning, buildVideoEncoderArgs } = require('../streamEncoderTuning');
const { getDashFormatSelectors, resolveQualityHeight } = require('./formatSelection');
const { buildBaseArgs } = require('./ytdlpArgs');
const { registerChildProcess, killChildProcess, isFfprobeAvailable } = require('./processRegistry');
const { serveFileWithRangeSupport, parseSingleRange } = require('./rangeFileServe');
const { waitForRangeAvailable, serveResumeAwareRange, serveDeclaredRange, isFfmpegClient, statSize } = require('./byteRangeServe');
const { parseDownloadSizeBytes, computeDeclaredTotal, padFileToSize, isInZeroTail } = require('./byteRangeDeclaredLength');
const { patchFileHeaderDuration, patchMkvHeaderDuration, parseFfmpegInputDurations } = require('./byteRangeHeaderDuration');
const { getVideoDurationSeconds } = require('./playbackPlan');
const {
  RESUME_OVERLAP_SECONDS,
  computeResumeFromSeconds,
  probeDurationSeconds,
  findCompleteBoxEnd,
  stitchResumeFiles,
} = require('./byteRangeResume');
const { scanMkv, pickResumePoint, getServableResumeBytes, getMkvProgress, stitchMkvResume } = require('./mkvResume');
const { beginCacheHit } = require('./byteRangeCacheHitRow');
const { streamDebug } = require('./streamDebug');
const {
  trackStream,
  untrackStream,
  failStreamThenUntrack,
  getStream: getActiveStream,
  createBytesCounter,
} = require('./activeStreams');
const { PERSISTENT_CACHE_DIR, PARTIAL_MARKER, removeOrphanPartials } = require('./byteRangeCacheIndex');
const { YTSTREAM_CACHE_DIR } = require('./paths');

// Debug-only escape hatch for live testing (e.g. inspecting a still-idle
// session's temp files without the reaper deleting them out from under
// you) - flip by hand, never persisted/config-driven. Leaves every other
// reaper mechanic (heartbeat, logging) running; only skips the actual
// destroySession call.
const DEBUG_DISABLE_IDLE_TEARDOWN = false;

// Dot-prefixed (hidden), matching paths.js's YTSTREAM_CACHE_DIR convention -
// even though os.tmpdir() itself is never inside a media library path.
const BASE_DIR = path.join(os.tmpdir(), '.youtarr-ytstream-byterange-hls');
// ytstream.hlsStorageLocation='cache' alternative (read fresh per session,
// same convention as hlsEngine.js's resolveHlsBaseDir): session dirs live
// under the persistent cache folder, and a deliverAsFile session's growing
// file is written straight into PERSISTENT_CACHE_DIR (see spawnSession)
// instead of being copied there when it finishes.
const SESSIONS_IN_CACHE_DIR = path.join(YTSTREAM_CACHE_DIR, '.byterange-sessions');
const STREAM_FILENAME = 'stream.mp4';
// "Stealth cache" for deliverAsFile=true, same idea as ytstream.stealthCache
// (hls-buffer's own hidden permanent cache): a session's stream.mp4 is
// copied here on close - whether it finished clean or was torn down early
// (idle timeout, forced stop) - so a later request for the exact same
// params can potentially be served instantly, with no live session at
// all. Each entry has a `.json` completeness/duration sidecar (see
// readCacheMeta) - only a cache entry actually reaching the real end of
// the video (isSessionComplete) is safe to serve as-is; a partial one is
// NOT (would silently truncate playback) and falls through to a fresh
// session instead (see handleByteRangeHlsRequest's cache-hit check).
// With ytstream.byteRangeResumeCache on, a partial entry is instead
// resumed from (see getOrCreateSession/stitchResumeIntoCache); with it off
// the partial is simply ignored. Only for deliverAsFile - the manifest
// path (deliverAsFile=false) would need its own finished-VOD manifest to
// serve a cache hit consistently with its declared container='hls', out
// of scope for now. The directory itself is defined in byteRangeCacheIndex.js,
// which also exposes these entries to the Library page's stealth-cache
// indicators (via untrackedBufferCache.js) - the sidecar's `youtubeId` is
// what makes that possible.

/** @returns {string} where a finished deliverAsFile encode for these params would be cached. */
function getPersistentCachePath(params) {
  const key = buildSessionKey(params);
  const mp4Path = path.join(PERSISTENT_CACHE_DIR, `${key}.mp4`);
  if (params.container !== 'mkv') return mp4Path;
  // Container = MKV entries are `.mkv`; ones written before that were `.mp4`
  // and stay usable under their old name.
  const mkvPath = path.join(PERSISTENT_CACHE_DIR, `${key}.mkv`);
  return !fs.existsSync(mkvPath) && fs.existsSync(mp4Path) ? mp4Path : mkvPath;
}

/** @returns {string} the completeness/duration sidecar for a given cache entry - see readCacheMeta's doc comment. */
function getPersistentCacheMetaPath(params) {
  return path.join(PERSISTENT_CACHE_DIR, `${buildSessionKey(params)}.json`);
}

/**
 * A cache entry is only "complete" (the real end of the video, safe to
 * instant-serve as-is) when EVERY child in the pipeline exited clean - not
 * just ffmpeg. Checking ffmpeg's own exit code alone is a real bug: if a
 * yt-dlp child errors mid-stream, its stdout pipe closes, ffmpeg sees a
 * clean EOF on pipe:3/4 and very plausibly exits 0 too - that used to get
 * cached as "the finished file" with nothing to say otherwise.
 */
function isSessionComplete(session) {
  return session.ff.exitCode === 0 && session.ytVideo.exitCode === 0 && session.ytAudio.exitCode === 0;
}

/**
 * Reads a cache entry's completeness/duration sidecar. Returns `null` when
 * it's missing (including every cache entry written before this sidecar
 * existed) or unparseable - callers treat a `null` read as `complete: true`
 * (today's pre-existing assumption: a cached file with no metadata is
 * assumed to be the finished video, so old cache entries aren't needlessly
 * invalidated), logging once that the fallback fired.
 */
function readCacheMeta(params) {
  try {
    return JSON.parse(fs.readFileSync(getPersistentCacheMetaPath(params), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Writes the sidecar atomically (temp file + rename) so a reader never sees
 * a half-written meta file. Always records `youtubeId`: the filenames are a
 * params hash, so this is how byteRangeCacheIndex.js maps an entry back to a
 * video for the Library page's stealth-cache indicators.
 */
function writeCacheMetaAtomic(params, meta) {
  const metaPath = getPersistentCacheMetaPath(params);
  const tmpPath = `${metaPath}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmpPath, JSON.stringify({ ...meta, youtubeId: params.youtubeId }));
  fs.renameSync(tmpPath, metaPath);
}

/**
 * Copies a deliverAsFile session's stream.mp4 into PERSISTENT_CACHE_DIR for
 * instant reuse later, alongside a completeness/duration sidecar (see
 * readCacheMeta) - called both on a clean ffmpeg finish AND on early
 * teardown (idle timeout, forced stop), so a session cut off partway
 * through still leaves SOMETHING reusable behind rather than losing all
 * that work. Only overwrites an existing cache entry when this session's
 * copy is bigger (more complete) - never regresses an already-cached
 * finished/further-along file with an earlier, smaller partial one (e.g.
 * a stale second session for the same params that happened to close
 * later but got less far). Fire-and-forget; failure is logged, never
 * fatal - the session's own temp copy already served whatever requests
 * it needed to.
 */
function persistFreshEncode(session) {
  return new Promise((resolve) => {
    if (!session.deliverAsFile || !session.cacheParams) return resolve();
    // Already saved as a complete entry (the close-time persist): a later
    // teardown must not copy it again, or a cache the user cleared in the
    // meantime would be silently recreated from this session's temp file.
    if (session.persistedComplete) return resolve();
    let sourceSize = 0;
    try { sourceSize = fs.statSync(session.streamPath).size; } catch { /* nothing written at all */ }
    if (sourceSize <= 0) return resolve();

    const cachePath = getPersistentCachePath(session.cacheParams);
    let existingSize = 0;
    try { existingSize = fs.statSync(cachePath).size; } catch { /* no existing cache entry */ }
    if (existingSize >= sourceSize) {
      streamDebug(
        { sessionKey: session.key, youtubeId: session.youtubeId, cachePath, sourceSize, existingSize },
        'ytstream: hls-byterange - existing stealth cache entry is already as large or larger, not overwriting'
      );
      const existingMeta = readCacheMeta(session.cacheParams);
      if (isSessionComplete(session) && (!existingMeta || existingMeta.complete !== false)) session.persistedComplete = true;
      return resolve();
    }

    fs.mkdirSync(PERSISTENT_CACHE_DIR, { recursive: true });
    const installContext = { cachePath, sourceSize, existingSize };
    // Written in place (hlsStorageLocation=cache): nothing to copy, just
    // rename the finished partial into the cache.
    if (session.streamInCache) {
      installIntoCache(session, session.streamPath, installContext).then(resolve);
      return;
    }
    // Copied to a temp name and only renamed into place (in the same
    // synchronous step as the sidecar write) once complete: the cache-hit
    // check treats "file present, no sidecar" as a finished legacy entry, so
    // a file visible mid-copy would be served truncated - a probe reading its
    // (partial) tail reports a wildly short duration.
    const tmpPath = `${cachePath}.persist-${crypto.randomBytes(4).toString('hex')}.tmp`;
    const removeTmp = () => fs.rm(tmpPath, { force: true }, () => { /* best-effort temp cleanup */ });
    fs.copyFile(session.streamPath, tmpPath, (err) => {
      if (err) {
        logger.warn({ err, sessionKey: session.key, youtubeId: session.youtubeId, cachePath, sourceSize }, 'ytstream: hls-byterange failed to persist encode to the stealth cache');
        removeTmp();
        resolve();
        return;
      }
      installIntoCache(session, tmpPath, { ...installContext, onFailure: removeTmp }).then(resolve);
    });
  });
}

/**
 * Moves a fully-written file (`sourcePath`: the copy's temp file, or the
 * session's own in-place partial) into the stealth cache with its sidecar.
 * The rename and the sidecar write happen in one synchronous step - see
 * persistFreshEncode's comment on why no request may observe the file
 * without its sidecar. Never throws.
 */
async function installIntoCache(session, sourcePath, { cachePath, sourceSize, existingSize, onFailure }) {
  const logContext = { sessionKey: session.key, youtubeId: session.youtubeId, cachePath };
  const complete = isSessionComplete(session);
  const durationSeconds = await probeDurationSeconds(sourcePath);
  let renamed = false;
  try {
    fs.renameSync(sourcePath, cachePath);
    renamed = true;
    writeCacheMetaAtomic(session.cacheParams, { complete, durationSeconds, sizeBytes: sourceSize, updatedAt: new Date().toISOString() });
  } catch (err) {
    logger.warn({ err, ...logContext }, 'ytstream: hls-byterange failed to install the persisted encode into the stealth cache');
    // A partial left with no sidecar would be served as complete.
    if (renamed && !complete) fs.rmSync(cachePath, { force: true });
    if (onFailure) onFailure();
    return;
  }
  if (session.streamInCache) {
    // The session keeps serving (and reporting progress) from the same
    // bytes, now at their final path.
    session.streamPath = cachePath;
    session.streamInCache = false;
  }
  session.persistedComplete = complete;
  logger.info({ ...logContext, sourceSize, existingSize, complete, durationSeconds }, 'ytstream: hls-byterange persisted encode to the stealth cache');
}

/**
 * Stitches a finished/torn-down RESUME session's new tail onto its cached
 * base snapshot and installs the result as the cache entry - the resume
 * counterpart of persistFreshEncode. Idempotent per session (a clean ffmpeg
 * finish triggers it early; the later teardown reuses the same promise).
 * Never throws and never installs anything that fails validation (see
 * stitchResumeFiles): on any failure the existing cache entry is left
 * exactly as it was.
 */
function stitchResumeIntoCache(session) {
  if (!session.stitchPromise) session.stitchPromise = runStitchResumeIntoCache(session);
  return session.stitchPromise;
}

async function runStitchResumeIntoCache(session) {
  const logContext = { sessionKey: session.key, youtubeId: session.youtubeId };
  let tmpPath = null;
  try {
    if (statSize(session.streamPath) <= 0) {
      streamDebug(logContext, 'ytstream: hls-byterange resume produced no new bytes - leaving the cache entry untouched');
      return;
    }
    const cachePath = getPersistentCachePath(session.cacheParams);
    fs.mkdirSync(PERSISTENT_CACHE_DIR, { recursive: true });
    // Same directory as the destination so the install below is an atomic
    // same-filesystem rename.
    tmpPath = `${cachePath}.stitch-${crypto.randomBytes(4).toString('hex')}.tmp`;
    const mkvSeam = session.resumeBaseCopy.mkv;
    const result = mkvSeam
      ? await stitchMkvResume({
        basePath: session.resumeBaseCopy.path,
        resumePath: session.streamPath,
        outPath: tmpPath,
        seamMs: mkvSeam.seamMs,
        previousDurationSeconds: session.resumeBaseCopy.durationSeconds,
      })
      : await stitchResumeFiles({
        basePath: session.resumeBaseCopy.path,
        resumePath: session.streamPath,
        workDir: session.dir,
        outPath: tmpPath,
        resumeFromSeconds: session.resumeFromSeconds,
        previousDurationSeconds: session.resumeBaseCopy.durationSeconds,
      });
    if (!result.ok) {
      logger.warn(
        { ...logContext, reason: result.reason, permanent: !!result.permanent, previousDurationSeconds: session.resumeBaseCopy.durationSeconds },
        'ytstream: hls-byterange resume stitch was rejected - keeping the existing cache entry unchanged'
      );
      if (result.permanent) markMkvResumeFailed(session);
      return;
    }
    // .mp4 before .json: a reader briefly seeing the bigger file next to
    // the stale (shorter) sidecar self-heals on the next request.
    fs.renameSync(tmpPath, cachePath);
    tmpPath = null;
    const complete = isSessionComplete(session);
    writeCacheMetaAtomic(session.cacheParams, {
      complete,
      durationSeconds: result.durationSeconds,
      sizeBytes: statSize(cachePath),
      updatedAt: new Date().toISOString(),
    });
    session.persistedComplete = complete;
    logger.info(
      { ...logContext, cachePath, complete, durationSeconds: result.durationSeconds },
      'ytstream: hls-byterange installed stitched resume into the stealth cache'
    );
  } catch (err) {
    logger.warn({ err, ...logContext }, 'ytstream: hls-byterange resume stitch failed unexpectedly - existing cache entry left as-is');
  } finally {
    if (tmpPath) fs.rm(tmpPath, { force: true }, () => { /* best-effort temp cleanup */ });
  }
}

/**
 * Returns what a resume needs from the persistent cache, or null when this
 * request should just run a fresh encode: only a PARTIAL entry (meta.complete
 * === false) with a usable recorded duration qualifies, and ffprobe/ffmpeg
 * must be present (the stitch needs both).
 */
function findResumableCacheEntry(cacheParams) {
  const cachePath = getPersistentCachePath(cacheParams);
  if (!fs.existsSync(cachePath)) return null;
  const meta = readCacheMeta(cacheParams);
  if (!meta || meta.complete !== false) return null;
  if (cacheParams.container === 'mkv') {
    // The seam comes from scanning the file itself (see snapshotResumeBase), so
    // neither a recorded duration nor ffprobe is needed. A partial whose
    // resume once failed to line up is not tried again.
    if (meta.mkvResumeFailed) {
      streamDebug({ youtubeId: cacheParams.youtubeId, cachePath }, 'ytstream: hls-byterange mkv resume skipped - an earlier resume of this partial did not line up');
      return null;
    }
    return { cachePath, metaPath: getPersistentCacheMetaPath(cacheParams), durationSeconds: meta.durationSeconds || 0, resumeFromSeconds: null, mkv: true };
  }
  const resumeFromSeconds = computeResumeFromSeconds(meta.durationSeconds);
  if (resumeFromSeconds === null) return null;
  if (!isFfprobeAvailable()) {
    logger.warn({ youtubeId: cacheParams.youtubeId }, 'ytstream: hls-byterange resume skipped - ffprobe is not available on PATH');
    return null;
  }
  return { cachePath, metaPath: getPersistentCacheMetaPath(cacheParams), durationSeconds: meta.durationSeconds, resumeFromSeconds };
}

/**
 * Snapshots the cached partial into the resume session's own dir (so live
 * serving is decoupled from the eventual stitch, and the snapshot is
 * cleaned up with the dir), trimmed to its last complete top-level box.
 * Synchronous copy: spawnSession is synchronous, and a partial is
 * typically at most a few hundred MB on local disk. Returns null on any
 * failure so the caller falls back to a fresh encode.
 */
function snapshotResumeBase(dir, resume) {
  try {
    if (resume.mkv) return snapshotMkvResumeBase(dir, resume);
    const basePath = path.join(dir, 'base.mp4');
    fs.copyFileSync(resume.cachePath, basePath);
    fs.copyFileSync(resume.metaPath, path.join(dir, 'base.json'));
    const completeEnd = findCompleteBoxEnd(basePath);
    if (completeEnd <= 0) return null;
    fs.truncateSync(basePath, completeEnd);
    return { path: basePath, size: completeEnd, durationSeconds: resume.durationSeconds };
  } catch (err) {
    logger.warn({ err }, 'ytstream: hls-byterange failed to snapshot the cached partial for resume - falling back to a fresh encode');
    return null;
  }
}

/**
 * mkv counterpart of the snapshot: copies the partial, works out the seam
 * (a keyframe-led cluster >= RESUME_OVERLAP before its end - see
 * mkvResume.pickResumePoint) and cuts the copy there. Null (fresh encode)
 * when the partial has no usable seam.
 */
function snapshotMkvResumeBase(dir, resume) {
  const basePath = path.join(dir, 'base.mkv');
  fs.copyFileSync(resume.cachePath, basePath);
  const scan = scanMkv(basePath);
  const pick = pickResumePoint(scan);
  streamDebug(
    { cachePath: resume.cachePath, scanOk: scan.ok, clusters: scan.ok ? scan.clusters.length : null, pick },
    'ytstream: hls-byterange mkv resume - scanned the cached partial'
  );
  if (!pick.ok) {
    logger.info({ cachePath: resume.cachePath, reason: pick.reason }, 'ytstream: hls-byterange mkv partial is not resumable - starting a fresh encode');
    fs.rmSync(basePath, { force: true });
    return null;
  }
  fs.truncateSync(basePath, pick.cutOffset);
  return {
    path: basePath,
    size: pick.cutOffset,
    durationSeconds: pick.cachedEndSeconds,
    resumeFromSeconds: pick.resumeFromSeconds,
    mkv: { seamMs: pick.seamMs, streamSkip: null, state: 'pending', firstTimecodeMs: null },
  };
}

/** Records on the partial's sidecar that resuming it does not work, so it is never resumed again. */
function markMkvResumeFailed(session) {
  try {
    const meta = readCacheMeta(session.cacheParams);
    if (meta) writeCacheMetaAtomic(session.cacheParams, { ...meta, mkvResumeFailed: true });
  } catch (err) {
    logger.warn({ err, sessionKey: session.key }, 'ytstream: hls-byterange could not flag a partial as not resumable');
  }
}

/**
 * The size servable to a client right now: for a resume session the cached
 * base plus whatever of the resume pass continues it. An mkv resume whose
 * first cluster does not line up with the seam is ended here.
 */
function sessionServableSize(session) {
  const streamBytes = statSize(session.streamPath);
  if (!session.resumeBaseCopy) return streamBytes;
  const seam = session.resumeBaseCopy.mkv;
  const resumeBytes = seam ? getServableResumeBytes(session, streamBytes) : streamBytes;
  if (seam && seam.state === 'mismatch' && !session.failed) {
    session.failed = true;
    session.failReason = 'mkv resume did not line up with the cached base';
    markMkvResumeFailed(session);
    logger.error({ sessionKey: session.key, youtubeId: session.youtubeId }, 'ytstream: hls-byterange mkv resume abandoned - a fresh encode will be used next time');
    failStreamThenUntrack(session.key, 'failed', session.failReason);
  }
  return session.resumeBaseCopy.size + resumeBytes;
}

const CHILD_EXIT_WAIT_TIMEOUT_MS = 5000;

/**
 * Resolves once `child` has exited (by code or signal), or after
 * CHILD_EXIT_WAIT_TIMEOUT_MS - never rejects, so a stuck child can't
 * block persisting forever.
 */
function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      child.removeListener('exit', done);
      resolve();
    };
    const timer = setTimeout(done, CHILD_EXIT_WAIT_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    child.once('exit', done);
  });
}

const SEGMENT_DURATION_SECONDS = 6;
const READY_TIMEOUT_MS = 45000;
const READY_POLL_INTERVAL_MS = 500;
const IDLE_SWEEP_INTERVAL_MS = 30 * 1000;
const HEARTBEAT_INTERVAL_MS = 5000;
// Idle-teardown timeout scales with how much real progress a session has
// made (see computeIdleTimeoutMs) - a session only seconds old (most
// likely a probe, or a request that never really turned into playback)
// is torn down fast; one that's been genuinely encoding for a while, or
// has already finished, gets a much longer grace period, since redoing
// that work from byte 0 is expensive and a real viewer resuming after a
// pause shouldn't have to pay for it. Confirmed live: a session recreated
// after only 2 minutes idle caused a real seek to 416 (see the "seeking
// bug" this replaces the flat IDLE_TIMEOUT_MS to fix).
const IDLE_TIMEOUT_MS_MIN = 30 * 1000;
// A FINISHED Plain file session (encode done, file cached) is torn down this
// long after the player's LAST open request closes (see trackSessionRequest)
// instead of waiting out the idle timeout. Long enough for a player that
// aborts a request and immediately opens the next (a seek); a paused player
// keeps its connection open, so it never triggers this. A session still
// encoding is left to the idle timeout.
const CLIENT_CLOSE_GRACE_MS = 20 * 1000;
const IDLE_TIMEOUT_MS_BASE = 2 * 60 * 1000;
const IDLE_TIMEOUT_MS_FINISHED = 30 * 60 * 1000;
// A deliverAsFile session that finished AND was saved as a complete stealth
// cache entry is redundant: every later request is served from the cache
// (which never touches the session, so lastAccess stops advancing) - the
// session only pins a full-size temp copy of the video. Reaped quickly.
const IDLE_TIMEOUT_MS_PERSISTED = 60 * 1000;
const IDLE_TIMEOUT_RAMP_MS = 60 * 1000;

/**
 * @param {object} session
 * @returns {number} how long this session may sit idle before the reaper
 *   tears it down - see the constants' own comments above for the
 *   reasoning behind each tier.
 */
function computeIdleTimeoutMs(session) {
  if (session.ff.exitCode !== null) return session.persistedComplete ? IDLE_TIMEOUT_MS_PERSISTED : IDLE_TIMEOUT_MS_FINISHED;
  const elapsedMs = Date.now() - session.startedAt;
  if (elapsedMs >= IDLE_TIMEOUT_RAMP_MS) return IDLE_TIMEOUT_MS_BASE;
  const ratio = elapsedMs / IDLE_TIMEOUT_RAMP_MS;
  return Math.round(IDLE_TIMEOUT_MS_MIN + (IDLE_TIMEOUT_MS_BASE - IDLE_TIMEOUT_MS_MIN) * ratio);
}

/**
 * Waits for a Range request's start byte to exist in this session's
 * servable file(s) - see byteRangeServe.waitForRangeAvailable. A resume
 * session's servable size is base + resume stream.
 */
function waitForSessionRange(session, req, declared = session.declaredTotal) {
  // Against a declared total the wait target is the range's real start
  // (this also resolves suffix ranges like `bytes=-4096`, which
  // waitForRangeAvailable alone ignores) and the encode counts as done only
  // once its length has been finalized (padding applied).
  let waitReq = req;
  if (declared !== null) {
    const range = parseSingleRange(req.headers.range || 'bytes=0-', declared);
    // End-of-file probes are answered from the known zero tail, not waited for.
    if (range && isInZeroTail(range.start, declared)) return Promise.resolve();
    if (range) waitReq = { headers: { range: `bytes=${range.start}-` } };
  }
  return waitForRangeAvailable(waitReq, {
    getSize: () => sessionServableSize(session),
    isDone: () => (declared !== null ? session.lengthFinal : session.ff.exitCode !== null),
    isFailed: () => session.failed,
    logContext: { sessionKey: session.key, youtubeId: session.youtubeId },
  });
}

// How long the first response may wait for yt-dlp to report both stream
// sizes (normally already known by the time the first fragment is ready).
const DECLARED_TOTAL_WAIT_MS = 6000;
const DECLARED_TOTAL_POLL_MS = 100;

/**
 * Records a stream's exact size from a chunk of yt-dlp stderr and, once both
 * the video and audio sizes are known, fixes the session's declared total.
 * A no-op for anything but a plain-remux deliverAsFile session.
 */
function noteStreamSize(session, which, text) {
  // An mkv resume downloads the whole stream like a fresh encode, so its final
  // size is declared the same way; an mp4 resume (a sectioned download) has no
  // full size to go by.
  if (session.declaredTotal !== null || session.willEncode || (session.resumeBaseCopy && !session.isMkv) || !session.deliverAsFile) return;
  if (session.sourceBytes[which] === null) session.sourceBytes[which] = parseDownloadSizeBytes(text);
  const { video, audio } = session.sourceBytes;
  if (video === null || audio === null) return;
  session.declaredTotal = computeDeclaredTotal(video, audio, session.isMkv ? 'mkv' : 'mp4');
  logger.info(
    { sessionKey: session.key, youtubeId: session.youtubeId, videoBytes: video, audioBytes: audio, declaredTotal: session.declaredTotal, container: session.isMkv ? 'mkv' : 'mp4' },
    'ytstream: hls-byterange declaring the final file size up front'
  );
}

/**
 * When the encode ends cleanly, pads the file (with a skippable MP4 `free`
 * box) to exactly the size that was declared, so bytes a player was told
 * exist really do. Never throws. An encode that ended badly is left as-is.
 */
function finalizeDeclaredLength(session, exitCode) {
  if (session.declaredTotal === null || exitCode !== 0) return;
  // An mkv resume's virtual file is the cached base plus the resume file from
  // its seam cluster on, so it is the resume file that gets padded, to the
  // size that makes that virtual file exactly the declared total.
  let target = session.declaredTotal;
  if (session.resumeBaseCopy) {
    const seam = session.resumeBaseCopy.mkv;
    if (!seam || seam.state !== 'ok') return;
    target = session.declaredTotal - session.resumeBaseCopy.size + seam.streamSkip;
  }
  const result = padFileToSize(session.streamPath, target, session.isMkv ? 'mkv' : 'mp4');
  const logContext = { sessionKey: session.key, youtubeId: session.youtubeId, declaredTotal: session.declaredTotal };
  if (!result.ok) {
    // The estimate was too small: clients were told a shorter file than
    // exists. Rare (the estimate has a margin) but worth seeing.
    logger.error({ ...logContext, reason: result.reason, actualBytes: result.actualBytes }, 'ytstream: hls-byterange could not pad the finished file to its declared size');
    return;
  }
  streamDebug({ ...logContext, paddedBytes: result.paddedBytes }, 'ytstream: hls-byterange padded the finished file to its declared size');
}

/**
 * Writes the video's real duration into the file's init segment, in place.
 * The encoder leaves every duration field zero, so a reader (Jellyfin's
 * ffmpeg included) otherwise has to read the whole file to work the length
 * out - see byteRangeHeaderDuration.js. Retried on later calls while the
 * init segment isn't fully written; logs the boxes it found so an
 * unexpected header layout is visible.
 */
function applyHeaderDuration(session) {
  if (session.headerDurationDone || !session.durationSeconds || session.resumeBaseCopy || !session.deliverAsFile) return;
  const result = session.isMkv
    ? patchMkvHeaderDuration(session.streamPath, session.durationSeconds)
    : patchFileHeaderDuration(session.streamPath, session.durationSeconds);
  streamDebug({ sessionKey: session.key, isMkv: !!session.isMkv, durationSeconds: session.durationSeconds, ok: result.ok, retry: result.retry, reason: result.reason, infoHex: result.infoHex }, 'ytstream: hls-byterange header duration patch attempt');
  const logContext = { sessionKey: session.key, youtubeId: session.youtubeId, durationSeconds: session.durationSeconds };
  if (result.ok) {
    session.headerDurationDone = true;
    logger.info({ ...logContext, source: session.durationSource, patched: result.patched, boxes: result.boxes }, 'ytstream: hls-byterange wrote the video duration into the file header');
    return;
  }
  if (result.retry) return;
  session.headerDurationDone = true;
  logger.warn({ ...logContext, reason: result.reason, boxes: result.boxes, infoHex: result.infoHex }, 'ytstream: hls-byterange could not write the duration into the file header');
}

const HEADER_DURATION_WAIT_MS = 2000;
const HEADER_DURATION_POLL_MS = 50;

/**
 * Takes the video's duration from ffmpeg's own startup log: each input (the
 * video and the audio pipe from yt-dlp) is a complete DASH file whose header
 * states its length, and ffmpeg prints it as `Duration: HH:MM:SS.xx`. That
 * needs no metadata lookup at all and is the exact container duration. Uses
 * the longer of the two inputs. Ignored once a duration is known.
 */
function noteFfmpegDuration(session, text) {
  if (!session.deliverAsFile || session.resumeBaseCopy || session.durationSeconds !== null || session.ffDurations.length >= 2) return;
  session.ffDurations.push(...parseFfmpegInputDurations(text));
  if (session.ffDurations.length < 2) return;
  session.durationSeconds = Math.max(...session.ffDurations);
  session.durationSource = 'ffmpeg';
  logger.info(
    { sessionKey: session.key, youtubeId: session.youtubeId, inputDurations: session.ffDurations, durationSeconds: session.durationSeconds },
    'ytstream: hls-byterange read the video duration from ffmpeg\'s input headers'
  );
  applyHeaderDuration(session);
}

/**
 * Lets the duration lookup finish (briefly) before the first response, so
 * the init segment goes out already carrying it. A cold lookup that is
 * still running is patched in later instead.
 */
async function waitForHeaderDuration(session, timeoutMs = HEADER_DURATION_WAIT_MS) {
  // A resume session's header is already in the cached base: there is nothing to
  // wait for (this used to hold every request back by the full timeout).
  if (session.resumeBaseCopy) return;
  // Whichever source lands first: ffmpeg's startup log or the cached lookup.
  const deadline = Date.now() + timeoutMs;
  while (!session.durationSeconds && !session.headerDurationDone && !session.failed && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, HEADER_DURATION_POLL_MS));
  }
  applyHeaderDuration(session);
}

/**
 * Gives yt-dlp a moment to report both stream sizes before the first
 * response goes out, so it can carry the final total. Returns without
 * waiting for anything that can't have one (re-encodes, resumes, failures).
 */
async function waitForDeclaredTotal(session, { timeoutMs = DECLARED_TOTAL_WAIT_MS, pollMs = DECLARED_TOTAL_POLL_MS } = {}) {
  if (!session.deliverAsFile || session.willEncode || (session.resumeBaseCopy && !session.isMkv)) return;
  const deadline = Date.now() + timeoutMs;
  while (session.declaredTotal === null && !session.failed && session.ff.exitCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** sessionKey -> session */
const sessions = new Map();
let reaperInterval = null;
let orphansCleaned = false;

function buildSessionKey({ youtubeId, quality, qualityStrictness, transcode, hardwareMode, tuning, container }) {
  // Only mkv is part of the key: existing mp4 sessions/cache entries keep
  // their keys, while an mkv encode can never collide with an mp4 one.
  const base = { youtubeId, quality, qualityStrictness, transcode, hardwareMode, tuning };
  const raw = JSON.stringify(container === 'mkv' ? { ...base, container: 'mkv' } : base);
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 20);
}

/**
 * Runs once, when the first session of this process starts (so nothing else
 * of this process can be running yet): removes in-progress files a previous
 * process left in the cache folder and stale session dirs under
 * SESSIONS_IN_CACHE_DIR, apart from `firstSession`'s own.
 */
function cleanupOrphansOnce(firstSession) {
  removeOrphanPartials([firstSession.streamPath]);
  fs.readdir(SESSIONS_IN_CACHE_DIR, (err, names) => {
    if (err) return;
    for (const name of names) {
      const dirPath = path.join(SESSIONS_IN_CACHE_DIR, name);
      if (dirPath === firstSession.dir) continue;
      fs.rm(dirPath, { recursive: true, force: true }, () => { /* best-effort orphan cleanup */ });
    }
  });
}

function ensureReaper(firstSession) {
  if (!orphansCleaned) {
    orphansCleaned = true;
    cleanupOrphansOnce(firstSession);
  }
  if (reaperInterval) return;
  streamDebug({ sweepIntervalMs: IDLE_SWEEP_INTERVAL_MS }, 'ytstream: hls-byterange idle reaper starting');
  reaperInterval = setInterval(() => {
    // Nothing to reap: stop ticking (and logging) until the next session.
    if (sessions.size === 0) {
      clearInterval(reaperInterval);
      reaperInterval = null;
      streamDebug({}, 'ytstream: hls-byterange idle reaper stopped - no sessions');
      return;
    }
    const now = Date.now();
    streamDebug({ activeSessionCount: sessions.size }, 'ytstream: hls-byterange idle reaper sweep tick');
    for (const [key, session] of sessions) {
      const idleForMs = now - session.lastAccess;
      const idleTimeoutMs = computeIdleTimeoutMs(session);
      if (idleForMs > idleTimeoutMs) {
        if (DEBUG_DISABLE_IDLE_TEARDOWN) {
          logger.info({ sessionKey: key, youtubeId: session.youtubeId, idleForMs, idleTimeoutMs }, 'ytstream: hls-byterange session idle timeout reached, but DEBUG_DISABLE_IDLE_TEARDOWN is on - leaving it alone');
        } else {
          logger.info({ sessionKey: key, youtubeId: session.youtubeId, idleForMs, idleTimeoutMs, ffExitCode: session.ff.exitCode }, 'ytstream: hls-byterange session idle timeout - tearing down');
          destroySession(key, 'idle-timeout');
        }
      } else {
        streamDebug({ sessionKey: key, youtubeId: session.youtubeId, idleForMs, idleTimeoutMs }, 'ytstream: hls-byterange idle reaper - session still active, leaving it alone');
      }
    }
  }, IDLE_SWEEP_INTERVAL_MS);
  reaperInterval.unref();
}

/**
 * Logs the growing file's size every HEARTBEAT_INTERVAL_MS - lets you
 * watch a session's real encode progress (and each process's running/
 * exited state) directly in the logs, without having to guess from
 * request timing alone. Self-stops once the session is gone or ffmpeg has
 * exited (one extra tick after teardown is possible - harmless).
 */
function ensureSizeHeartbeat(session) {
  let lastSize = 0;
  let lastCheckAt = session.startedAt;
  session.heartbeatInterval = setInterval(() => {
    if (!sessions.has(session.key) || session.ff.exitCode !== null) {
      clearInterval(session.heartbeatInterval);
      return;
    }
    let currentSize = null;
    try { currentSize = fs.statSync(session.streamPath).size; } catch { /* not created yet */ }
    const now = Date.now();
    const deltaBytes = currentSize !== null ? currentSize - lastSize : null;
    const deltaMs = now - lastCheckAt;
    const bytesPerSecond = deltaBytes !== null && deltaMs > 0 ? Math.round((deltaBytes / deltaMs) * 1000) : null;
    logger.info(
      {
        sessionKey: session.key,
        youtubeId: session.youtubeId,
        elapsedMs: now - session.startedAt,
        currentStreamSizeBytes: currentSize,
        deltaBytesSinceLastCheck: deltaBytes,
        bytesPerSecond,
        ytVideoExitCode: session.ytVideo.exitCode,
        ytAudioExitCode: session.ytAudio.exitCode,
        ffExitCode: session.ff.exitCode,
      },
      'ytstream: hls-byterange size heartbeat'
    );
    if (currentSize !== null) lastSize = currentSize;
    lastCheckAt = now;
  }, HEARTBEAT_INTERVAL_MS);
  if (typeof session.heartbeatInterval.unref === 'function') session.heartbeatInterval.unref();
}

/**
 * @param {string} sessionKey
 * @param {string} [untrackReason] - when given, also untracks this
 *   session's activeStreams entry (see activeStreams.js) with this reason,
 *   before the process/directory cleanup below - folded in here so every
 *   teardown path (idle reaper, recreate-after-failure) untracks
 *   consistently instead of each call site having to remember to. Safe to
 *   call even when the entry is already gone (e.g. markFailed's own
 *   failStreamThenUntrack already removed it) - untrackStream no-ops.
 */
/**
 * Counts a Plain file request against its session and, once the last one has
 * closed (the player stopped, or was closed), frees the session after
 * CLIENT_CLOSE_GRACE_MS unless another request arrives - but only when its
 * encode has already finished; a running encode is left to the idle timeout.
 *
 * @param {object} session
 * @param {import('express').Response} res
 * @param {(session: object) => void} [onClosed] - what to do when the grace ends (default: destroySession)
 */
function trackSessionRequest(session, res, onClosed = (s) => {
  // The key may already belong to a replacement session by now.
  if (sessions.get(s.key) !== s) return;
  destroySession(s.key, 'client-closed').catch((err) => {
    logger.warn({ err, sessionKey: s.key }, 'ytstream: hls-byterange teardown after the client closed failed');
  });
}) {
  session.openRequests = (session.openRequests || 0) + 1;
  if (session.closeTimer) {
    clearTimeout(session.closeTimer);
    session.closeTimer = null;
    streamDebug({ sessionKey: session.key, openRequests: session.openRequests }, 'ytstream: hls-byterange a new request arrived - client-closed teardown cancelled');
  }
  res.on('close', () => {
    session.openRequests = Math.max(0, session.openRequests - 1);
    streamDebug(
      { sessionKey: session.key, openRequests: session.openRequests, aborted: !res.writableFinished, ffExitCode: session.ff.exitCode },
      'ytstream: hls-byterange client request closed'
    );
    if (session.openRequests > 0 || session.tearingDown) return;
    if (session.closeTimer) clearTimeout(session.closeTimer);
    session.closeTimer = setTimeout(() => {
      session.closeTimer = null;
      if (session.openRequests > 0 || session.tearingDown) return;
      if (session.ff.exitCode === null) {
        streamDebug({ sessionKey: session.key }, 'ytstream: hls-byterange the last client request closed but the encode is still running - leaving it to the idle timeout');
        return;
      }
      logger.info(
        { sessionKey: session.key, youtubeId: session.youtubeId, graceMs: CLIENT_CLOSE_GRACE_MS, ffExitCode: session.ff.exitCode },
        'ytstream: hls-byterange the last client request closed and no new one arrived - freeing the finished session'
      );
      onClosed(session);
    }, CLIENT_CLOSE_GRACE_MS);
    session.closeTimer.unref();
  });
}

async function destroySession(sessionKey, untrackReason) {
  if (untrackReason) untrackStream(sessionKey, untrackReason, null);
  const session = sessions.get(sessionKey);
  if (!session) {
    streamDebug({ sessionKey }, 'ytstream: hls-byterange destroySession called for an already-gone session key - no-op');
    return;
  }
  // Reaper sweeps and recreate-after-failure can both land here for the
  // same session while its (slow) stitch is still running.
  if (session.tearingDown) return;
  session.tearingDown = true;
  if (session.closeTimer) {
    clearTimeout(session.closeTimer);
    session.closeTimer = null;
  }
  streamDebug({ sessionKey, youtubeId: session.youtubeId, dir: session.dir }, 'ytstream: hls-byterange destroySession - killing children and scheduling directory removal');
  // A fresh session leaves the map immediately (a request landing during
  // its persist spawns a clean replacement). A resume session stays
  // registered until its stitch has landed in the cache: removing it first
  // would let a request landing in that window see no session AND the old,
  // un-stitched cache entry, and spawn a duplicate resume.
  if (!session.resumeBaseCopy) sessions.delete(sessionKey);
  if (session.heartbeatInterval) clearInterval(session.heartbeatInterval);
  // Kill first so the file is stable (nothing still appending to it)
  // before caching whatever got written so far - an early/idle teardown
  // shouldn't throw away real encoding work just because the session
  // never reached a clean finish. Awaited so the copy has definitely
  // finished reading the source before the directory removal below can
  // possibly delete it out from under it.
  killChildProcess(session.ytVideo, 'byterange-hls-teardown');
  killChildProcess(session.ytAudio, 'byterange-hls-teardown');
  killChildProcess(session.ff, 'byterange-hls-teardown');
  try {
    await (session.resumeBaseCopy ? stitchResumeIntoCache(session) : persistFreshEncode(session));
  } finally {
    // Identity check: a fresh session's key may already belong to its
    // replacement by now.
    if (sessions.get(sessionKey) === session) sessions.delete(sessionKey);
  }
  // An in-place partial that was never installed (nothing worth caching, or
  // a bigger entry already existed) must not be left in the cache folder.
  if (session.streamInCache) fs.rm(session.streamPath, { force: true }, () => { /* best-effort */ });
  fs.rm(session.dir, { recursive: true, force: true }, (err) => {
    if (err) logger.warn({ err, sessionKey, dir: session.dir }, 'ytstream: hls-byterange failed to remove session directory during teardown');
    else streamDebug({ sessionKey, dir: session.dir }, 'ytstream: hls-byterange session directory removed');
  });
}

/**
 * @param {string} sessionKey
 * @param {object} params
 * @param {object|null} [resume] - from findResumableCacheEntry: when given
 *   (and its base snapshot succeeds), this pass only encodes from
 *   `resume.resumeFromSeconds` onward into a brand-new file; the cached head
 *   is served from the snapshot and stitched on at teardown.
 */
function spawnSession(sessionKey, { youtubeId, quality, qualityStrictness, transcode, hardwareMode, tuning, config, playerClient, clientIp, userAgent, deliverAsFile, container }, resume = null) {
  const useCacheStorage = ((config && config.ytstream) || {}).hlsStorageLocation === 'cache';
  const dir = path.join(useCacheStorage ? SESSIONS_IN_CACHE_DIR : BASE_DIR, `${sessionKey}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  const isMkv = !!deliverAsFile && container === 'mkv';
  const resumeBaseCopy = resume ? snapshotResumeBase(dir, resume) : null;
  // An mkv resume works out its own start (the seam) while snapshotting.
  const resumeFromSeconds = resumeBaseCopy ? (resumeBaseCopy.resumeFromSeconds ?? resume.resumeFromSeconds) : null;
  // A resume session's file is stitched onto its base, never installed as-is,
  // so only plain deliverAsFile sessions can write straight into the cache.
  const streamInCache = !!deliverAsFile && useCacheStorage && !resumeBaseCopy;
  if (streamInCache) fs.mkdirSync(PERSISTENT_CACHE_DIR, { recursive: true });
  const streamPath = streamInCache
    ? path.join(PERSISTENT_CACHE_DIR, `${sessionKey}${PARTIAL_MARKER}${crypto.randomBytes(4).toString('hex')}${isMkv ? '.mkv' : '.mp4'}`)
    : path.join(dir, isMkv ? 'stream.mkv' : STREAM_FILENAME);
  // deliverAsFile=false: this file IS served to the client (via the
  // manifest's #EXT-X-MAP/#EXT-X-BYTERANGE references) - see the module
  // doc comment. deliverAsFile=true: purely an internal readiness signal,
  // never served.
  const playlistPath = path.join(dir, 'internal.m3u8');

  const hw = normalizeHardwareMode(hardwareMode);
  const tier = normalizeTuning(tuning);
  const { videoFormat, audioFormat } = getDashFormatSelectors(quality, qualityStrictness);
  streamDebug({ sessionKey, youtubeId, quality, qualityStrictness, videoFormat, audioFormat }, 'ytstream: hls-byterange resolved yt-dlp format selectors');
  const watchUrl = `https://youtube.com/watch?v=${youtubeId}`;
  const commonYtArgs = [...buildBaseArgs(config, { playerClient }), '-o', '-', '--no-playlist', '--no-warnings'];
  // Same sectioned-pipe technique as hlsEngine.js's useSectionedPipe (see
  // its comments): --download-sections alone fails piped to `-o -` on
  // fragmented DASH, so the internal extraction is forced to Matroska, and
  // -copyts keeps each pipe's real timestamp instead of re-zeroing them.
  // mkv resume downloads the streams whole and runs ffmpeg EXACTLY like the
  // fresh encode that made the cached part (no -copyts, no trimming), so both
  // files have the same timeline and cluster boundaries; the resume file's
  // clusters before the seam are then skipped when joining (mkvResume.js).
  // yt-dlp's native chunked download runs at full speed, whereas a sectioned
  // download goes through ffmpeg's own HTTP client, which YouTube throttles to
  // roughly twice real time (measured: ~0.5 MB/s against ~22 MB/s). Trimming
  // with -ss/-copyts was tried and left the file starting at 0:00 with a
  // shifted timeline, so nothing lined up.
  const fullDownloadResume = isMkv && resumeFromSeconds !== null;
  const sectionArgs = resumeFromSeconds !== null && !fullDownloadResume
    ? ['--download-sections', `*${resumeFromSeconds}-inf`, '--downloader-args', 'ffmpeg:-f matroska -copyts']
    : [];
  const ytVideoArgs = [...commonYtArgs, ...sectionArgs, '-f', videoFormat, watchUrl];
  const ytAudioArgs = [...commonYtArgs, ...sectionArgs, '-f', audioFormat, watchUrl];

  const encoder = transcode === 'h264'
    ? buildVideoEncoderArgs(hw, resolveQualityHeight(quality), tier, (config.ytstream || {}).vaapiQuality, 'h264', false)
    : null;
  streamDebug({ sessionKey, youtubeId, transcode, hardwareMode: hw, tuning: tier, willEncode: !!encoder }, 'ytstream: hls-byterange resolved encoder decision (copy vs h264)');

  // deliverAsFile sessions read ffmpeg's startup log for each input's
  // Duration line (see noteFfmpegDuration), which needs info level; the
  // per-second progress stats it would add are switched off.
  const wantInputInfo = !!deliverAsFile && !resumeBaseCopy;
  // Matroska output (Container = MKV, Plain file only): one growing .mkv
  // written directly, no HLS muxer and no playlist. Unlike fMP4, ffprobe
  // trusts a Duration written in the Matroska header, so Jellyfin gets the
  // real length at once (see patchMkvHeaderDuration). Resumable by splicing
  // clusters (see mkvResume.js).
  streamDebug({ sessionKey, youtubeId, requestedContainer: container || null, deliverAsFile: !!deliverAsFile, isMkv }, 'ytstream: hls-byterange output container decision');
  const ffArgs = wantInputInfo
    ? ['-hide_banner', '-nostats', '-loglevel', 'info', '-fflags', '+genpts', '-analyzeduration', '10M', '-probesize', '5M']
    : ['-loglevel', 'error', '-fflags', '+genpts', '-analyzeduration', '10M', '-probesize', '5M'];
  // -copyts but deliberately NOT -start_at_zero (unlike hlsEngine.js): the
  // resume file's own timeline stays comparable to "seconds since the start
  // of the whole video", which the stitch step aligns the seam against.
  if (resumeFromSeconds !== null && !fullDownloadResume) ffArgs.push('-copyts');
  if (encoder && encoder.preInputArgs && encoder.preInputArgs.length) ffArgs.push(...encoder.preInputArgs);
  ffArgs.push(
    '-thread_queue_size', '4096', '-i', 'pipe:3',
    '-thread_queue_size', '4096', '-i', 'pipe:4',
    '-map', '0:v:0', '-map', '1:a:0?', '-sn', '-dn', '-max_muxing_queue_size', '4096'
  );
  if (encoder) {
    if (encoder.videoFilters && encoder.videoFilters.length) ffArgs.push('-vf', encoder.videoFilters.join(','));
    if (encoder.pixFmt) ffArgs.push('-pix_fmt', encoder.pixFmt);
    ffArgs.push(...encoder.encoderArgs, '-c:a', 'aac', '-ac', '2', '-b:a', '192k', '-ar', '48000');
  } else {
    ffArgs.push('-c', 'copy');
  }
  if (isMkv) {
    if (fullDownloadResume) {
      streamDebug({ sessionKey, youtubeId, seamSeconds: resumeBaseCopy.mkv.seamMs / 1000 }, 'ytstream: hls-byterange mkv resume downloads the whole stream at full speed like a fresh encode; clusters before the seam are skipped when joining');
    }
    ffArgs.push('-f', 'matroska', streamPath);
  } else ffArgs.push(
    '-f', 'hls',
    '-hls_time', String(SEGMENT_DURATION_SECONDS),
    '-hls_list_size', '0',
    '-hls_playlist_type', 'event',
    '-hls_flags', 'single_file+independent_segments',
    // fMP4 (not mpegts): a single_file fMP4 is a real, well-formed
    // fragmented MP4 on its own (init segment + moof/mdat fragments), which
    // is what makes deliverAsFile=true possible at all, and is also
    // Apple's currently-preferred segment shape for byte-range HLS. No
    // -hls_fmp4_init_filename: that option names a SEPARATE init-segment
    // file for the discrete-file case; in single_file mode the init
    // segment is embedded inline at the start of the same target file
    // automatically.
    '-hls_segment_type', 'fmp4',
    '-hls_segment_filename', streamPath,
    playlistPath
  );

  logger.info(
    { youtubeId, sessionKey, quality, transcode, hardwareMode: hw, dir, deliverAsFile, resumeFromSeconds, resumeBaseSizeBytes: resumeBaseCopy && resumeBaseCopy.size, resumeOverlapSeconds: RESUME_OVERLAP_SECONDS, ytVideoArgs, ytAudioArgs, ffArgs },
    isMkv
      ? 'ytstream: spawning hls-byterange encode pass (yt-dlp video + yt-dlp audio + ffmpeg matroska)'
      : 'ytstream: spawning hls-byterange encode pass (yt-dlp video + yt-dlp audio + ffmpeg single_file fmp4)'
  );

  const ytVideo = spawn('yt-dlp', ytVideoArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  const ytAudio = spawn('yt-dlp', ytAudioArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  registerChildProcess(ytVideo);
  registerChildProcess(ytAudio);
  const ff = spawn('ffmpeg', ffArgs, { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
  registerChildProcess(ff);
  streamDebug({ sessionKey, youtubeId, ytVideoPid: ytVideo.pid, ytAudioPid: ytAudio.pid, ffPid: ff.pid }, 'ytstream: hls-byterange child processes spawned');
  const ffVideoIn = ff.stdio[3];
  const ffAudioIn = ff.stdio[4];
  // Any of these pipe streams can see a write-after-close race during
  // teardown (killChildProcess kills all three together) - an unhandled
  // 'error' on any of them is an uncaught exception that crashes the
  // ENTIRE Node process (confirmed live: an ECONNRESET here took down the
  // whole container), so every stream gets a listener. Mirrors
  // hlsEngine.js's spawnHlsEncodePass, which hit this same class of crash
  // long before this mode existed.
  ytVideo.stdout.on('error', () => { /* pipe destination gone; session is being torn down */ });
  ytAudio.stdout.on('error', () => { /* pipe destination gone; session is being torn down */ });
  ffVideoIn.on('error', () => { /* upstream (yt-dlp video) already gone or being killed */ });
  ffAudioIn.on('error', () => { /* upstream (yt-dlp audio) already gone or being killed */ });
  ytVideo.stdout.pipe(ffVideoIn);
  ytAudio.stdout.pipe(ffAudioIn);

  let ytVideoErr = '';
  let ytAudioErr = '';
  let ffErr = '';
  ytVideo.stderr.on('data', (c) => {
    const text = c.toString();
    ytVideoErr = (ytVideoErr + text).slice(-2000);
    noteStreamSize(session, 'video', text);
  });
  ytAudio.stderr.on('data', (c) => {
    const text = c.toString();
    ytAudioErr = (ytAudioErr + text).slice(-2000);
    noteStreamSize(session, 'audio', text);
  });
  ff.stderr.on('data', (c) => {
    const text = c.toString();
    ffErr = (ffErr + text).slice(-2000);
    noteFfmpegDuration(session, text);
  });
  const session = {
    key: sessionKey,
    youtubeId,
    dir,
    streamPath,
    playlistPath,
    deliverAsFile: !!deliverAsFile,
    // True while streamPath is an in-progress `.partial-*` file inside
    // PERSISTENT_CACHE_DIR (see persistFreshEncode/destroySession).
    streamInCache,
    // Kept for persistFreshEncode, which needs to rebuild the exact
    // same cache key/path this session itself would use, from teardown
    // paths (destroySession) that don't otherwise have these on hand.
    cacheParams: { youtubeId, quality, qualityStrictness, transcode, hardwareMode, tuning, container },
    isMkv,
    contentType: isMkv ? 'video/x-matroska' : 'video/mp4',
    // Resume sessions only (null/absent for a fresh encode): the cached
    // head snapshot served ahead of this pass's own growing file, and where
    // this pass was told to start - see stitchResumeIntoCache.
    resumeBaseCopy,
    resumeFromSeconds,
    ytVideo,
    ytAudio,
    ff,
    startedAt: Date.now(),
    lastAccess: Date.now(),
    failed: false,
    failReason: null,
    willEncode: !!encoder,
    // deliverAsFile + plain remux only (see byteRangeDeclaredLength.js): the
    // exact stream sizes yt-dlp reported, the final file size advertised to
    // players from the first response, and whether that length is now real
    // (set once the encode has ended and any padding is applied).
    sourceBytes: { video: null, audio: null },
    declaredTotal: null,
    lengthFinal: false,
    // The video's real duration (cached yt-dlp metadata) and the lookup that
    // fetches it; it is written into the file header once known - see
    // applyHeaderDuration.
    durationSeconds: null,
    durationPromise: null,
    headerDurationDone: false,
    ffDurations: [],
    durationSource: null,
  };

  // Diagnostic helper: an encode pass that stops writing early (yt-dlp
  // erroring after a few seconds, a pipe hiccup) but still exits code 0
  // (or exits nonzero after a playlist already existed) was previously
  // logged as a normal close with NO visibility into why - the client
  // would then be served a small, "complete-looking" file (Content-Length
  // = whatever size it stopped at) and finish "very quickly", looking like
  // success. Always logs full state on ANY of the three processes closing,
  // not just on a classified failure.
  const logCloseDiagnostics = (which, code, signal) => {
    let currentSize = null;
    try { currentSize = fs.statSync(streamPath).size; } catch { /* not created yet */ }
    logger.info(
      {
        sessionKey, youtubeId, which, code, signal,
        elapsedMs: Date.now() - session.startedAt,
        currentStreamSizeBytes: currentSize,
        ytVideoExitCode: ytVideo.exitCode, ytAudioExitCode: ytAudio.exitCode, ffExitCode: ff.exitCode,
        ytVideoErr, ytAudioErr, ffErr,
      },
      `ytstream: hls-byterange ${which} closed`
    );
  };
  ytVideo.on('close', (code, signal) => logCloseDiagnostics('yt-dlp (video)', code, signal));
  ytAudio.on('close', (code, signal) => logCloseDiagnostics('yt-dlp (audio)', code, signal));

  const markFailed = (reason) => {
    if (session.failed) return;
    session.failed = true;
    session.failReason = reason;
    logger.error({ sessionKey, youtubeId, reason, ytVideoErr, ytAudioErr, ffErr }, 'ytstream: hls-byterange encode pass failed');
    failStreamThenUntrack(sessionKey, 'failed', reason);
  };
  ytVideo.on('error', (err) => markFailed(`yt-dlp (video) failed to start: ${err.message}`));
  ytAudio.on('error', (err) => markFailed(`yt-dlp (audio) failed to start: ${err.message}`));
  ff.on('error', (err) => markFailed(`ffmpeg failed to start: ${err.message}`));
  ff.on('close', (code, signal) => {
    const producedPlaylist = isMkv ? statSize(streamPath) > 0 : fs.existsSync(playlistPath);
    logCloseDiagnostics('ffmpeg', code, signal);
    finalizeDeclaredLength(session, code);
    session.lengthFinal = true;
    if (code !== 0 && !producedPlaylist) {
      markFailed(`ffmpeg exited with code ${code} before producing any output`);
      return;
    }
    if (code === 0) {
      // ffmpeg can close before Node has observed the yt-dlp children's
      // exits; isSessionComplete would read their still-null exitCodes and
      // record a finished encode as partial.
      Promise.all([waitForChildExit(ytVideo), waitForChildExit(ytAudio)]).then(() => {
        if (session.resumeBaseCopy) stitchResumeIntoCache(session);
        else persistFreshEncode(session);
      });
    }
  });

  if (session.deliverAsFile && !session.resumeBaseCopy) {
    // Cheap when cached (library DB / metadata cache); a cold video costs one
    // yt-dlp metadata call that then stays cached for every later play.
    session.durationPromise = getVideoDurationSeconds(youtubeId, config)
      .then((seconds) => {
        // ffmpeg's own reading of the inputs (noteFfmpegDuration) wins if it
        // got there first.
        if (session.durationSeconds === null) {
          session.durationSeconds = seconds;
          session.durationSource = 'metadata';
        }
        applyHeaderDuration(session);
      })
      .catch((err) => {
        logger.warn({ err: err.message, sessionKey, youtubeId }, 'ytstream: hls-byterange could not look up the video duration - header duration left unset');
      });
  }

  sessions.set(sessionKey, session);
  ensureReaper(session);
  ensureSizeHeartbeat(session);

  // Streaming-page / stream-history visibility, same as every other mode -
  // see activeStreams.js. container mirrors _resolveContainer's own choice
  // (strmMediaInfoCache.js): 'mp4' when a real flat file is being served
  // directly, null (this mode never uses the Container setting) otherwise.
  trackStream({
    streamId: sessionKey,
    mode: 'hls-byterange',
    youtubeId,
    quality,
    container: deliverAsFile ? (isMkv ? 'mkv' : 'mp4') : null,
    transcode,
    hardwareMode: hw,
    tuning: tier,
    clientIp,
    userAgent,
    state: 'active',
    startedAt: Date.now(),
    bytesTransferred: 0,
    bytesPerSecond: 0,
    lastActivityAt: Date.now(),
    // The Streaming page's Stop button (POST /api/ytstream/streams/:id/stop)
    // calls this. Without it the route only removed the row and left the
    // session - yt-dlp, ffmpeg and its file - running.
    stop: () => {
      destroySession(sessionKey, 'manual-stop').catch((err) => {
        logger.warn({ err, sessionKey, youtubeId }, 'ytstream: hls-byterange manual stop failed');
      });
    },
  });

  return session;
}

const MKV_READY_BYTES = 512 * 1024;

async function waitUntilFirstSegmentReady(session) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  const startedAt = Date.now();
  for (;;) {
    if (session.failed) return false;
    if (session.isMkv) {
      // No playlist to watch: ready once the growing .mkv holds its header
      // plus the first clusters (or the encode has ended with something written).
      const size = statSize(session.streamPath);
      if (size >= MKV_READY_BYTES || (session.ff.exitCode !== null && size > 0)) {
        streamDebug({ sessionKey: session.key, size, waitedMs: Date.now() - startedAt }, 'ytstream: hls-byterange mkv output ready to serve');
        return true;
      }
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
      continue;
    }
    try {
      const content = fs.readFileSync(session.playlistPath, 'utf8');
      if (content.includes('#EXTINF')) return true;
    } catch { /* not written yet */ }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
  }
}

function getOrCreateSession(params) {
  const sessionKey = buildSessionKey(params);
  const existing = sessions.get(sessionKey);
  if (existing && !existing.failed) {
    existing.lastAccess = Date.now();
    streamDebug({ sessionKey, youtubeId: params.youtubeId }, 'ytstream: hls-byterange reusing an existing session');
    return { sessionKey, session: existing, created: false };
  }
  if (existing && existing.failed) {
    streamDebug({ sessionKey, youtubeId: params.youtubeId, failReason: existing.failReason }, 'ytstream: hls-byterange existing session had failed - tearing it down before creating a fresh one');
    destroySession(sessionKey, 'failed');
  } else {
    streamDebug({ sessionKey, youtubeId: params.youtubeId }, 'ytstream: hls-byterange no existing session - creating a new one');
  }
  // Resume path: only with ytstream.byteRangeResumeCache on, for a
  // deliverAsFile request, and only when a PARTIAL cache entry exists.
  // Otherwise (including the toggle being off) this is today's fresh
  // from-zero encode.
  const resume = params.deliverAsFile && params.resumeCache
    ? findResumableCacheEntry({
      container: params.container,
      youtubeId: params.youtubeId,
      quality: params.quality,
      qualityStrictness: params.qualityStrictness,
      transcode: params.transcode,
      hardwareMode: params.hardwareMode,
      tuning: params.tuning,
    })
    : null;
  if (resume) {
    logger.info(
      { sessionKey, youtubeId: params.youtubeId, cachedDurationSeconds: resume.durationSeconds, resumeFromSeconds: resume.resumeFromSeconds },
      'ytstream: hls-byterange resuming from a partial stealth cache entry'
    );
  }
  const session = spawnSession(sessionKey, params, resume);
  return { sessionKey, session, created: true };
}

/**
 * Handles the top-level `mode=hls-byterange` request: gets/creates the
 * session, waits for at least one real fragment to exist, then either
 * serves `stream.mp4` directly (deliverAsFile=true) or returns the
 * rewritten manifest (deliverAsFile=false, default) - see the module doc
 * comment for the tradeoff.
 */
async function handleByteRangeHlsRequest(req, res, { youtubeId, config, quality, qualityStrictness, transcode, hardwareMode, tuning, playerClient, clientIp, userAgent, deliverAsFile, resumeCache, container }) {
  streamDebug({ youtubeId, quality, qualityStrictness, transcode, hardwareMode, tuning, clientIp, userAgent, deliverAsFile, resumeCache, range: req.headers.range || null }, 'ytstream: hls-byterange top-level request received');

  if (deliverAsFile) {
    const cacheParams = { youtubeId, quality, qualityStrictness, transcode, hardwareMode, tuning, container };
    const cachePath = getPersistentCachePath(cacheParams);
    if (fs.existsSync(cachePath)) {
      const meta = readCacheMeta(cacheParams);
      // No sidecar at all = a cache entry written before this metadata
      // existed - treated as complete (today's pre-existing assumption),
      // not as a reason to distrust every old entry. Only meta.complete
      // === false (a real, tracked partial) skips the instant-serve path.
      const isComplete = !meta || meta.complete !== false;
      if (!meta) {
        streamDebug({ youtubeId, cachePath }, 'ytstream: hls-byterange stealth cache entry has no metadata sidecar - assuming complete');
      }
      if (isComplete) {
        // Entries written before the sidecar carried `youtubeId` (or before
        // it existed) are invisible to the Library page's stealth-cache
        // indicators; a hit is the first chance to tag them.
        if (!meta || !meta.youtubeId) {
          try {
            writeCacheMetaAtomic(cacheParams, {
              complete: true,
              durationSeconds: (meta && meta.durationSeconds) || null,
              sizeBytes: statSize(cachePath),
              updatedAt: (meta && meta.updatedAt) || new Date().toISOString(),
            });
          } catch (err) {
            logger.warn({ err, youtubeId, cachePath }, 'ytstream: hls-byterange failed to backfill youtubeId into a cache sidecar');
          }
        }
        logger.info({ youtubeId, cachePath, durationSeconds: meta && meta.durationSeconds }, 'ytstream: hls-byterange stealth-cache hit - serving finished file directly, no live session');
        // No session is needed to serve this. A cache-hit row shows the
        // player reading the file and stays while any request is in flight
        // (see byteRangeCacheHitRow.js). The finished encode session's own
        // row is handed over to it: that session is freed after a minute
        // idle whatever the player is doing, which used to make the row
        // vanish mid-playback. A session still encoding keeps its row.
        const cacheKey = buildSessionKey(cacheParams);
        const cacheContentType = cachePath.endsWith('.mkv') || container === 'mkv' ? 'video/x-matroska' : 'video/mp4';
        const sessionRow = getActiveStream(cacheKey);
        const finishedSession = sessions.get(cacheKey);
        if (sessionRow && !(finishedSession && finishedSession.persistedComplete)) {
          serveFileWithRangeSupport(cachePath, req, res, cacheContentType, undefined, createBytesCounter(sessionRow));
        } else {
          if (sessionRow) {
            logger.info({ youtubeId, sessionKey: cacheKey }, 'ytstream: hls-byterange finished session row handed over to the cache-hit row');
            untrackStream(cacheKey, 'completed', null);
          }
          const hit = beginCacheHit({
            streamId: `cachehit-${cacheKey}`,
            youtubeId,
            quality,
            transcode,
            container: cachePath.endsWith('.mkv') || container === 'mkv' ? 'mkv' : 'mp4',
            clientIp,
            userAgent,
          }, res);
          serveFileWithRangeSupport(cachePath, req, res, cacheContentType, hit.onServed, hit.onBytesSent);
        }
        return;
      }
      // Partial cache entry: NOT safe to serve as-is (would truncate
      // playback while looking finished - the bug this metadata exists to
      // fix). Falls through to getOrCreateSession below, which resumes
      // from it (byteRangeResumeCache on) or starts a fresh from-zero
      // encode, same as a cache miss (off).
      logger.info(
        { youtubeId, cachePath, meta, resumeCache: !!resumeCache },
        'ytstream: hls-byterange stealth cache entry is only partial - not serving it as complete'
      );
    }
  }

  const { sessionKey, session } = getOrCreateSession({ youtubeId, quality, qualityStrictness, transcode, hardwareMode, tuning, config, playerClient, clientIp, userAgent, deliverAsFile, resumeCache, container });
  if (deliverAsFile) trackSessionRequest(session, res);
  // A resume session has real bytes to serve immediately (its cached base),
  // so it doesn't wait for the sectioned yt-dlp pass to produce its first
  // fragment - that would only re-add the cold-start delay resume exists
  // to avoid.
  const ready = session.resumeBaseCopy ? true : await waitUntilFirstSegmentReady(session);
  if (!ready) {
    logger.error({ youtubeId, sessionKey, failReason: session.failReason }, 'ytstream: hls-byterange session never became ready');
    res.status(502).send('hls-byterange stream failed to start');
    return;
  }
  session.lastAccess = Date.now();

  if (session.deliverAsFile) {
    // ffmpeg creates the growing file with mode 000; that only works while the
    // app runs as root. Opening it to serve would fail for any other user.
    try { fs.chmodSync(session.streamPath, 0o644); } catch { /* not created yet, or already gone */ }
    await waitForDeclaredTotal(session);
    await waitForHeaderDuration(session);
    let currentSize = null;
    try { currentSize = fs.statSync(session.streamPath).size; } catch { /* not created yet */ }
    logger.info(
      {
        youtubeId, sessionKey,
        elapsedMsSinceSpawn: Date.now() - session.startedAt,
        currentStreamSizeBytes: currentSize,
        ytVideoExitCode: session.ytVideo.exitCode, ytAudioExitCode: session.ytAudio.exitCode, ffExitCode: session.ff.exitCode,
      },
      'ytstream: hls-byterange first fragment ready - serving stream.mp4 directly (no manifest)'
    );
    // Which size this client is told: browsers get the declared final size
    // (so scrub-bar length is right and a forward seek just waits for the
    // data); Jellyfin's own ffmpeg gets the growing file's current size, as
    // before, because it reads to the end of whatever total it is given -
    // which for the full size means waiting out the whole download before
    // playback can start.
    const declaredView = session.declaredTotal !== null && !isFfmpegClient(req);
    await waitForSessionRange(session, req, declaredView ? session.declaredTotal : null);
    session.lastAccess = Date.now();
    const streamEntry = getActiveStream(sessionKey);
    const onServed = () => {
      session.lastAccess = Date.now();
      if (streamEntry) {
        streamEntry.lastActivityAt = Date.now();
        streamEntry.state = 'active';
      }
    };
    const onBytesSent = createBytesCounter(streamEntry);
    if (session.resumeBaseCopy) serveResumeAwareRange(session, req, res, onServed, onBytesSent, declaredView ? session.declaredTotal : null);
    else if (declaredView) serveDeclaredRange(session, req, res, onServed, onBytesSent);
    else serveFileWithRangeSupport(session.streamPath, req, res, session.contentType, onServed, onBytesSent);
    return;
  }

  streamDebug({ youtubeId, sessionKey }, 'ytstream: hls-byterange first fragment ready - serving manifest');
  let playlist;
  try {
    playlist = fs.readFileSync(session.playlistPath, 'utf8');
  } catch (err) {
    logger.error({ err, youtubeId, sessionKey }, 'ytstream: hls-byterange failed to read playlist after it was reported ready');
    res.status(502).send('hls-byterange stream failed to start');
    return;
  }

  // The filename appears both as a bare segment-reference line and inside
  // #EXT-X-MAP's quoted URI="..." attribute (the fMP4 init segment's own
  // byte-range reference) - a plain token replace (not line-anchored)
  // rewrites both to the same absolute asset URL correctly.
  const assetBaseUrl = `${req.protocol}://${req.get('host')}/api/ytstream/${encodeURIComponent(youtubeId)}/byterange-hls/${sessionKey}/`;
  const rewritten = playlist.split(STREAM_FILENAME).join(`${assetBaseUrl}${STREAM_FILENAME}`);
  streamDebug({ youtubeId, sessionKey, assetBaseUrl, playlistLength: rewritten.length }, 'ytstream: hls-byterange rewrote and is returning the media playlist');

  res.set({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
  res.status(200).send(rewritten);
}

/** Handles `GET /api/ytstream/:youtubeId/byterange-hls/:sessionKey/:filename` - only reachable for deliverAsFile=false sessions (the only case that ever hands out this URL). */
async function handleByteRangeHlsAsset(req, res) {
  const { sessionKey, filename } = req.params;
  if (!/^[a-f0-9]{20}$/.test(sessionKey)) {
    res.status(400).send('Invalid session key');
    return;
  }
  if (filename !== STREAM_FILENAME) {
    res.status(400).send('Invalid filename');
    return;
  }
  const session = sessions.get(sessionKey);
  if (!session) {
    logger.warn({ sessionKey }, 'ytstream: hls-byterange asset requested for unknown/expired session');
    res.status(404).send('hls-byterange session not found or expired');
    return;
  }
  session.lastAccess = Date.now();
  // debug: fires on every single byte-range request a player makes (once
  // per HTTP Range fetch into the growing stream.mp4) - same volume/
  // reasoning as hlsEngine.js's own "serving HLS asset" line.
  streamDebug({ sessionKey, youtubeId: session.youtubeId, range: req.headers.range || null }, 'ytstream: hls-byterange serving asset');
  await waitForSessionRange(session, req);
  session.lastAccess = Date.now();
  const streamEntry = getActiveStream(sessionKey);
  serveFileWithRangeSupport(session.streamPath, req, res, 'video/mp4', () => {
    if (streamEntry) {
      streamEntry.lastActivityAt = Date.now();
      streamEntry.state = 'active';
    }
  }, createBytesCounter(streamEntry));
}

/**
 * How many byte-range sessions this process is still holding - the Streaming
 * page shows it because a finished session keeps its (full-size) file and
 * table entry until the idle reaper or Stop releases it.
 * @returns {{total: number, encoding: number, finished: number}}
 */
function getSessionCounts() {
  let encoding = 0;
  for (const session of sessions.values()) {
    if (session.ff.exitCode === null && !session.failed) encoding += 1;
  }
  return { total: sessions.size, encoding, finished: sessions.size - encoding };
}

/**
 * Live progress snapshot for a session, keyed by its own streamId
 * (sessionKey) - used by the Streaming page's byte-range progress popup.
 * Returns null when the session is gone (finished-and-torn-down, or never
 * existed) - the popup treats that as "no longer live."
 */
function getSessionProgress(sessionKey) {
  const session = sessions.get(sessionKey);
  if (!session) return null;
  let currentSizeBytes = null;
  try { currentSizeBytes = fs.statSync(session.streamPath).size; } catch { /* not created yet */ }
  // An mkv resume's size is the cached base plus what continues it.
  if (session.isMkv && session.resumeBaseCopy) currentSizeBytes = sessionServableSize(session);
  return {
    container: session.isMkv ? 'mkv' : 'mp4',
    // The cluster map for the popup; absent for mp4, whose popup is unchanged.
    ...(session.isMkv ? { mkv: getMkvProgress(session) } : {}),
    sessionKey,
    youtubeId: session.youtubeId,
    deliverAsFile: session.deliverAsFile,
    currentSizeBytes,
    elapsedMs: Date.now() - session.startedAt,
    ytVideoExitCode: session.ytVideo.exitCode,
    ytAudioExitCode: session.ytAudio.exitCode,
    ffExitCode: session.ff.exitCode,
    failed: session.failed,
    failReason: session.failReason,
    complete: isSessionComplete(session),
  };
}

/**
 * Dry run for the simulate endpoint: what a request for these params would
 * do - serve the stealth cache, reuse a live session, resume a partial or
 * start a fresh encode - without starting or touching anything.
 * @returns {object}
 */
function describeByteRangeRun(params) {
  const { deliverAsFile, resumeCache } = params;
  const cacheParams = {
    youtubeId: params.youtubeId,
    quality: params.quality,
    qualityStrictness: params.qualityStrictness,
    transcode: params.transcode,
    hardwareMode: params.hardwareMode,
    tuning: params.tuning,
    container: params.container,
  };
  const sessionKey = buildSessionKey(cacheParams);
  const isMkv = !!deliverAsFile && params.container === 'mkv';
  const result = {
    sessionKey,
    delivery: deliverAsFile ? `plain file over HTTP Range requests (${isMkv ? 'Matroska' : 'fragmented MP4'})` : 'HLS manifest into one growing fMP4 file',
    settings: { quality: params.quality, qualityStrictness: params.qualityStrictness, transcode: params.transcode, hardwareMode: params.hardwareMode, tuning: params.tuning, container: isMkv ? 'mkv' : 'mp4', deliverAsFile: !!deliverAsFile, resumeCache: !!resumeCache },
  };
  const session = sessions.get(sessionKey);
  result.session = session
    ? { running: session.ff.exitCode === null, ffExitCode: session.ff.exitCode, failed: !!session.failed, persistedComplete: !!session.persistedComplete, openRequests: session.openRequests || 0 }
    : null;
  if (!deliverAsFile) {
    result.wouldCall = session && !session.failed ? 'reuse the running session, serve its manifest' : 'start a fresh encode session, serve its manifest';
    return result;
  }
  const cachePath = getPersistentCachePath(cacheParams);
  const meta = readCacheMeta(cacheParams);
  const exists = fs.existsSync(cachePath);
  result.cache = {
    path: path.basename(cachePath),
    exists,
    sizeBytes: exists ? statSize(cachePath) : null,
    complete: exists ? !meta || meta.complete !== false : null,
    durationSeconds: meta ? meta.durationSeconds : null,
    resumeFailedBefore: !!(meta && meta.mkvResumeFailed),
  };
  const isComplete = exists && (!meta || meta.complete !== false);
  if (isComplete) {
    result.wouldCall = 'stealth-cache hit: serve the finished file directly, no encode session';
  } else if (session && !session.failed) {
    result.wouldCall = 'reuse the running session and serve its growing file';
  } else if (exists && resumeCache) {
    const resumable = findResumableCacheEntry(cacheParams);
    result.cache.resumable = !!resumable;
    result.wouldCall = resumable ? 'resume from the cached partial (splice the new tail onto it)' : 'the cached partial cannot be resumed: start a fresh encode from the beginning';
  } else {
    result.wouldCall = exists ? 'ignore the cached partial (resume is off): start a fresh encode from the beginning' : 'start a fresh encode session and serve its growing file';
  }
  return result;
}

module.exports = { describeByteRangeRun, trackSessionRequest, CLIENT_CLOSE_GRACE_MS, handleByteRangeHlsRequest, handleByteRangeHlsAsset, buildSessionKey, isSessionComplete, getSessionProgress, waitForChildExit, computeIdleTimeoutMs, persistFreshEncode, getSessionCounts, waitForSessionRange, noteStreamSize, finalizeDeclaredLength, waitForDeclaredTotal, applyHeaderDuration, waitForHeaderDuration, noteFfmpegDuration };
