/**
 * server/modules/ytstream/hlsEngine.js
 *
 * The HLS session lifecycle core for `mode=hls`/`mode=hls-buffer`: session
 * creation/lookup/teardown, the yt-dlp+ffmpeg encode-pass spawn/restart/
 * backfill/hot-swap machinery, and the HLS segment/playlist-serving route.
 * Extracted from server/routes/ytstream.js so it's a real importable
 * module instead of trapped in that file's private route-factory closure -
 * this is the single riskiest piece of that extraction (same territory as
 * the historical segment-mismatch/seek-desync bug hunts), so every line of
 * logic and every doc comment below is preserved verbatim from the
 * original; only requires, module boundaries, and the small set of
 * genuinely-external dependencies (`models`, `resolveClientIp`) changed
 * shape (now injected via `init()`/a small factory) since they used to be
 * ordinary closure variables from `createYtStreamRoutes`.
 *
 * `models` is injected via `init({ models })` (same reassign-is-harmless
 * pattern used by activeStreams.js/playbackPlan.js) - it also forwards to
 * activeStreams.js's own `init()` since that module needs this engine's
 * `hlsSessions` map and `destroyHlsSession` too, and previously ytstream.js
 * wired that up itself right after `hlsSessions` was declared.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const logger = require('../../logger');
const configModule = require('../configModule');
const youtubeMetadataCache = require('../youtubeMetadataCache');
const streamEncoderTuning = require('../streamEncoderTuning');
const { normalizeHardwareMode, normalizeTuning, buildVideoEncoderArgs } = streamEncoderTuning;
const { streamDebug } = require('./streamDebug');
const { maybeSaveDebugPlaylistCopy } = require('./debugPlaylistCopy');
const { buildBaseArgs } = require('./ytdlpArgs');
const { resolveQualityHeight, getDashFormatSelectors } = require('./formatSelection');
const { RETRY_PLAYER_CLIENT, isRetryableExtractionError } = require('./configResolution');
const { registerChildProcess, killChildProcess } = require('./processRegistry');
const { YTSTREAM_CACHE_DIR, HLS_UNTRACKED_BUFFER_CACHE_DIR } = require('./paths');
const { getUntrackedBufferCachePath, findWarmUntrackedBufferCache } = require('./untrackedBufferCache');
const { buildFfmpegUpstreamHeaders, redactFfArgsForLogging } = require('./directMode');
const { getVideoDurationSeconds } = require('./playbackPlan');
const {
  init: initActiveStreamsTracker,
  ensureHlsIdleReaper,
  ensureProcessExitHandlers,
  computeSegmentStatus,
  trackStream,
  untrackStream,
  failStreamThenUntrack,
  getStream: getActiveStream,
  createBytesCounter,
} = require('./activeStreams');
const { createCacheFinalize } = require('./cacheFinalize');

/**
 * `mode=hls`: real segmented HLS output (playlist.m3u8 + segment files) on
 * disk, instead of one single live-piped connection.
 *
 * A live pipe makes the *player* wait on our full pipeline startup latency
 * (two concurrent yt-dlp extractions + ffmpeg spin-up) on the same
 * connection it's reading from — some players/transcoders (Jellyfin's own
 * server-side ffmpeg being the motivating case) won't tolerate that and
 * just retry forever, producing an endless black-screen loop (the removed
 * mode=ffmpeg + calculatedLength combination hit exactly this, plus a
 * second failure mode: a player's own mid-stream Range probe restarting
 * the encode from a new timestamp mid-playback, discontinuous with
 * whatever it had already started decoding). Real segmented HLS moves the
 * wait to *our* side before we ever respond (see
 * waitForHlsSessionReady/getOrCreateHlsSession, modeled on the
 * readiness-gated approach in jellyfin-youtube-plugin's
 * ManagedTranscodeService.cs), and every segment served after that is an
 * ordinary complete static file — no unknown-length/non-seekable concerns,
 * and a seek is just "fetch a different segment," never a discontinuous
 * mid-stream restart.
 *
 * Tradeoff: writes real files to disk for the session's run (idle-reaped
 * after HLS_IDLE_TIMEOUT_MS), unlike a pure in-memory pipe.
 */
const HLS_SEGMENT_DURATION_SECONDS = 4;
// This nominal 4s is only exactly right for a 30fps source - the real
// segment cut point is driven by the encoder's fixed-frame-count GOP
// (`-g`/`-keyint_min`), not a real-seconds target. A per-source fps
// correction was tried here (deriving a real per-segment duration from
// yt-dlp's reported fps and applying it to session.segmentDurationSeconds/
// totalSegments/playlistSegmentDurationSeconds) and reverted: yt-dlp's
// reported fps can be a rounded figure (e.g. 30 for a true 29.97), and that
// small per-segment error compounds linearly with segment index, producing
// a real audio/video sync error on a seek late into a long video - worse
// than the display imprecision it was meant to fix. Every HLS-family
// session now just uses this flat constant everywhere (encode target,
// playlist, seek math, display), same as before that attempt.

// 45s, not 30s: observed real-world QSV startup (2 concurrent yt-dlp
// extractions + VAAPI/QSV device init + first segment encode) taking
// ~25s, leaving an uncomfortably thin margin before this would have
// failed the whole session outright rather than just being slow.
const HLS_READY_TIMEOUT_MS = 45000;
// The classic full-pipe seek-restart path re-feeds yt-dlp's output into
// ffmpeg via a non-seekable pipe, so ffmpeg's -ss on that input can't jump
// — it has to decode-and-discard every frame from 0:00 up to the seek
// target before the first real output frame appears (see
// docs/YTSTREAM_SEEK_FIX.md). That can take minutes for a seek late in a
// long video, far past a cold-start's ~45s startup budget. useSectionedPipe
// (yt-dlp --download-sections) normally avoids this by only fetching from
// the seek target onward, but isn't guaranteed for every yt-dlp/ffmpeg
// combo (see maybeFallbackToFullPipe) — this generous timeout covers a
// restart that falls back to the slow decode-and-discard path. Not used
// for the initial/cold-start pass — only ensureHlsSegmentAvailable's
// restart-triggered wait.
const HLS_SEEK_RESTART_READY_TIMEOUT_MS = 4 * 60 * 1000;
const HLS_READY_POLL_INTERVAL_MS = 300;
const HLS_IDLE_TIMEOUT_MS = 2 * 60 * 1000;
const HLS_IDLE_SWEEP_INTERVAL_MS = 60 * 1000;
// calculatedLength HLS: sequential playback naturally requests segment N+1
// shortly before the forward encode (currently writing segment N) finishes
// it — this grace window absorbs that ordinary case without treating it as
// a seek and restarting the encode pass unnecessarily.
const HLS_SEEK_GRACE_MS = 2500;

// After a seek-restart, once the target segment is ready, wait (briefly,
// best-effort) for this many segments right after it to also be ready
// before handing the target back to the player. A fast restart leaves the
// encode pass with little head start over real-time playback, so without
// this cushion the player catches up to the encoder's production rate
// almost immediately and stutters/rebuffers every few seconds until the
// pipe naturally pulls ahead again.
const HLS_POST_RESTART_LOOKAHEAD_SEGMENTS = 3;
// Hard cap on the extra wait above - never blocks the *target* segment
// (already confirmed ready by this point) waiting on a cushion that isn't
// materializing; just returns what's ready so far.
const HLS_POST_RESTART_LOOKAHEAD_TIMEOUT_MS = 10000;

// ytstream.hotSwapToCache: throttles how often the segment route checks the
// DB for "has STRM cache-on-play finished downloading this video yet" — a
// per-segment-request check would be needless load once a session has run
// for a while; segments arrive roughly every HLS_SEGMENT_DURATION_SECONDS
// anyway, so this just avoids re-checking on every single one.
const HOT_SWAP_CHECK_INTERVAL_MS = 5000;

// mode=hls-buffer: how far ahead of a target playback timestamp the
// independent buffer fetch (ytstreamBufferFetch.js) must have already
// written before an encode pass may read that region as a plain local file
// (waitForBufferedThrough) - a cushion against the encode pass catching up
// to the fetch's still-growing write frontier mid-segment, same purpose as
// HLS_POST_RESTART_LOOKAHEAD_SEGMENTS serves for the network-pipe path.
const BUFFER_SAFETY_MARGIN_SECONDS = 15;
// Bounded wait for the buffer to reach the safety margin past a target
// timestamp before falling back to the proven network-sourced path
// (sectioned pipe / direct-URL seek) for that one pass — the fetch keeps
// running in the background regardless.
const BUFFER_CATCHUP_TIMEOUT_MS = 45000;
// Video-seconds of buffered progress (not wall-clock) between debug-level
// "still fetching" log lines (startHlsBufferFetch's progress handler).
const BUFFER_PROGRESS_LOG_INTERVAL_SECONDS = 60;

// Deliberately NOT under tempPathManager's temp base: that gets wiped
// wholesale by cleanTempDirectory() on startup and before every download
// job, which would delete segments out from under an active HLS session.
const HLS_BASE_TEMP_DIR = path.join(os.tmpdir(), 'youtarr-ytstream-hls');
// ytstream.hlsStorageLocation: 'cache' alternative to the OS temp dir above,
// under the same persistent .youtarr_ytstream_cache folder the untracked-
// buffer cache and probe/placeholder clips already live in (YTSTREAM_CACHE_DIR).
// Read fresh on every session/fetch start (not cached at module load) so a
// config change takes effect on the next play without a server restart.
function resolveHlsBaseDir() {
  const location = (configModule.getConfig().ytstream || {}).hlsStorageLocation;
  return location === 'cache' ? path.join(YTSTREAM_CACHE_DIR, 'hls-sessions') : HLS_BASE_TEMP_DIR;
}

// Active HLS sessions, keyed by buildHlsSessionKey(...).
const hlsSessions = new Map();

// Single-flight guard for getOrCreateHlsSession: two requests for the same
// not-yet-existing sessionKey landing before createHlsSessionInternal
// finishes would otherwise both spawn their own yt-dlp/ffmpeg pipeline for
// the same key — a real race (a player's manifest fetch and its player
// engine's own fetch routinely land milliseconds apart). The second
// creation would silently overwrite the first in hlsSessions, leaking its
// processes/temp dir. Keyed the same as hlsSessions itself.
const hlsSessionCreationPromises = new Map();

/**
 * HLS segment container mapping for the `container` param. `ts` (MPEG-TS)
 * is the traditional, universally-compatible HLS segment format; `mp4`
 * maps to fragmented MP4 (.m4s + init segment), matching Jellyfin's own
 * HLS output.
 */
function getHlsContainerInfo(container) {
  if (container === 'ts') {
    return { segmentType: 'mpegts', segmentExt: 'ts' };
  }
  return { segmentType: 'fmp4', segmentExt: 'm4s' };
}

/** Identifies an HLS session across requests for the same effective params. */
function buildHlsSessionKey({ youtubeId, quality, qualityStrictness, transcode, hardwareMode, tuning, container, playerClient, calculatedLength, buffer }) {
  const raw = JSON.stringify({
    youtubeId, quality, transcode, hardwareMode, tuning, container,
    qualityStrictness: qualityStrictness || 'fallback',
    playerClient: playerClient || '',
    calculatedLength: !!calculatedLength,
    buffer: !!buffer,
  });
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 20);
}

/**
 * Pre-builds the ENTIRE VOD playlist for a calculatedLength HLS session
 * upfront — full #EXTINF/segment-name list from the video's real duration,
 * with #EXT-X-PLAYLIST-TYPE:VOD and #EXT-X-ENDLIST from the first response —
 * so players see a full seekable timeline before most segments exist on
 * disk. A segment not yet on disk is treated as a seek and produced on
 * demand (restartHlsEncodePassAtSegment).
 *
 * `segmentDurationSeconds` (always HLS_SEGMENT_DURATION_SECONDS today - see
 * its own comment) drives every #EXTINF entry here. Whatever value the
 * CALLER passes is what session.playlistSegmentDurationSeconds
 * gets frozen to for the rest of the session - effectiveSeek/targetSeconds
 * must keep using that same frozen value forever after, since this file is
 * never rewritten with a different one.
 */
function buildFullHlsPlaylist({ totalSegments, durationSeconds, segmentExt, segmentType, segmentDurationSeconds }) {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${Math.ceil(segmentDurationSeconds)}`,
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-MEDIA-SEQUENCE:0',
  ];
  if (segmentType === 'fmp4') {
    lines.push('#EXT-X-MAP:URI="init.mp4"');
  }
  for (let i = 0; i < totalSegments; i++) {
    const isLast = i === totalSegments - 1;
    const remaining = durationSeconds - i * segmentDurationSeconds;
    const segDuration = isLast ? Math.max(0.1, remaining) : segmentDurationSeconds;
    lines.push(`#EXTINF:${segDuration.toFixed(3)},`);
    lines.push(`segment${String(i).padStart(5, '0')}.${segmentExt}`);
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

/**
 * Rewrites every segment/init-segment reference in an ffmpeg-written HLS
 * playlist to an absolute URL under `baseUrl` — ffmpeg's own `-hls_base_url`
 * doesn't consistently apply to the `#EXT-X-MAP` line, only plain segment
 * lines, leaving the init segment resolved against the playlist's own URL
 * instead of ours.
 */
function rewriteHlsPlaylistUrls(content, baseUrl) {
  const isAbsolute = (uri) => /^https?:\/\//i.test(uri);
  return content
    .split('\n')
    .map((line) => {
      if (line.startsWith('#EXT-X-MAP:')) {
        return line.replace(/URI="([^"]+)"/, (match, uri) => (isAbsolute(uri) ? match : `URI="${baseUrl}${uri}"`));
      }
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && !isAbsolute(trimmed)) {
        return baseUrl + trimmed;
      }
      return line;
    })
    .join('\n');
}

const {
  trySafeDeleteFinalizedTs,
  promoteFinalizedTsToLibraryMp4,
  promoteHiddenMp4ToLibrary,
  swapHiddenCacheToMp4,
  resolveHlsBufferPromoteFn,
  maybeRetroactivelyRemuxReusedCache,
  maybeFinalizeTsToMp4,
} = createCacheFinalize({ hlsSessions });

// Set by init() (called once per createYtStreamRoutes invocation, same
// reassign-is-harmless pattern used elsewhere in this modularization).
let models = null;

/**
 * @param {object} params.models - Sequelize models (Video), needed by
 *   createHlsSessionInternal's hls-buffer STRM lookup.
 */
function init(params) {
  models = params.models;
  // activeStreams.js needs this engine's hlsSessions map (for
  // snapshotStream's per-segment status) and destroyHlsSession (for the
  // idle reaper) - previously wired up by ytstream.js itself right after
  // hlsSessions was declared; now that this module owns both, it does the
  // wiring instead.
  initActiveStreamsTracker({ models: params.models, hlsSessions, destroyHlsSession });
}

// hlsSessions is declared above (with the other HLS constants).
function destroyHlsSession(session, reason) {
  hlsSessions.delete(session.key);
  // Checked by createHlsSessionInternal's process-exit handlers so a
  // deliberate teardown isn't logged as an unexpected crash.
  session.destroying = true;
  // This session may have been the one thing blocking
  // resolveHlsBufferPromoteFn's chosen strategy (see maybeFinalizeTsToMp4)
  // from reclaiming its cachedFilePath's .ts - now that it's gone (removed
  // from hlsSessions just above), retry: a no-op unless finalizeToMp4
  // already produced a .mp4 for this exact file AND no OTHER live session
  // still references it.
  if (session.cachedFilePath && path.extname(session.cachedFilePath).toLowerCase() === '.ts'
    && (configModule.getConfig().ytstream || {}).finalizeToMp4 === true) {
    const mp4Path = require('../tsRemuxCache').findExistingSeekableMp4(session.cachedFilePath);
    streamDebug(
      {
        sessionKey: session.key,
        youtubeId: session.youtubeId,
        cachedFilePath: session.cachedFilePath,
        bufferStealth: !!session.bufferStealth,
        bufferHybridPromote: !!session.bufferHybridPromote,
        bufferUntracked: !!session.bufferUntracked,
        mp4Found: !!mp4Path,
      },
      'ytstream: destroyHlsSession teardown-retry promotion check'
    );
    if (mp4Path) {
      const promoteFn = resolveHlsBufferPromoteFn(session);
      promoteFn(session.youtubeId, session.cachedFilePath, mp4Path, { youtubeId: session.youtubeId, sourceLabel: 'session-teardown' })
        .catch(() => { /* already logs internally */ });
    }
  }
  killChildProcess(session.ytVideo, `hls-ytdlp-video:${reason}`);
  killChildProcess(session.ytAudio, `hls-ytdlp-audio:${reason}`);
  killChildProcess(session.ff, `hls-ffmpeg:${reason}`);
  killChildProcess(session.infoJsonProc, `hls-ytdlp-infojson:${reason}`);
  // Delayed past killChildProcess's SIGTERM->SIGKILL grace window (3s):
  // removing the dir while processes are still exiting makes ffmpeg fail
  // mid-write with confusing I/O errors that look like a real crash.
  setTimeout(() => {
    fs.rm(session.dir, { recursive: true, force: true }, (err) => {
      if (err) logger.warn({ err, dir: session.dir }, 'ytstream: failed to remove HLS session temp dir');
    });
    // Same grace period, same reasoning, for the hls-buffer scratch dir -
    // see maybeCleanupBufferDir's doc comment for why this needs to wait
    // for both this AND the independent download-fetch to be done with it.
    session.hlsTornDown = true;
    maybeCleanupBufferDir(session);
  }, 3500);
  // Single choke-point for every HLS teardown path (idle reap, retry,
  // ready-failed, manual stop), so untracking is uniform. session.error
  // (set by spawnHlsEncodePass's markFailed) carries the failure text for
  // the 'ready-failed' case.
  //
  // 'ready-failed' alone gets the lingering 'failed'-state treatment: it's
  // the one reason that means this stream never really started at all -
  // worth showing on the Streaming page for a moment rather than having
  // the row just vanish (every other reason here is either a real, already-
  // visible stream ending, or internal churn already in SILENT_UNTRACK_REASONS).
  if (reason === 'ready-failed') {
    failStreamThenUntrack(session.key, reason, session.error || null);
  } else {
    untrackStream(session.key, reason, session.error || null);
  }
}

/**
 * mode=hls-buffer: deletes session.bufferDir (the scratch dir holding
 * bufferTempPath) only once BOTH the independent download-fetch
 * (startHlsBufferFetch's finish()) has settled AND this session's own live
 * encode side has been torn down (destroyHlsSession, above) - whichever of
 * the two happens second is the one that actually triggers the removal.
 *
 * Needed because a seek-restart pass can be spawned with
 * `-i bufferTempPath` (isBufferInProgressSource in startHlsBufferFetch)
 * at any point up until the session itself ends, and that pass may not
 * have actually opened the file yet (ffmpeg's own startup - extraction
 * args, hwupload/vaapi init - can take a few seconds). Deleting
 * bufferTempPath the instant the fetch finishes, independent of whether
 * the live session might still spawn/be spawning such a pass, produced a
 * real ENOENT confirmed live. Gating on the session's own teardown instead
 * of a fixed timer closes the race exactly, with no guessed duration.
 */
function maybeCleanupBufferDir(session) {
  if (!session.bufferDir) return;
  if (!session.bufferFetchSettled || !session.hlsTornDown) {
    streamDebug(
      { sessionKey: session.sessionKey, bufferFetchSettled: !!session.bufferFetchSettled, hlsTornDown: !!session.hlsTornDown },
      'ytstream: maybeCleanupBufferDir skipped - still waiting on the other side'
    );
    return;
  }
  streamDebug({ sessionKey: session.sessionKey, bufferDir: session.bufferDir }, 'ytstream: maybeCleanupBufferDir removing scratch dir - both fetch and session have settled');
  fs.rm(session.bufferDir, { recursive: true, force: true }, () => {});
}

/**
 * mode=hls-buffer: returns a path finalizeTapOutput can safely rename/
 * unlink, without ever touching session.bufferTempPath itself - see
 * maybeCleanupBufferDir's doc comment and the call site in
 * startHlsBufferFetch for the ENOENT race this prevents. A hard link (same
 * directory as bufferTempPath, so always the same filesystem) is
 * near-instant regardless of file size - both paths share the same inode,
 * so renaming/unlinking the handoff link elsewhere never affects
 * bufferTempPath's own data. Falls back to a real copy only if linking
 * itself fails (e.g. a filesystem without hard-link support), and to the
 * original path itself (reintroducing the small race window) only if both
 * fail.
 * @returns {Promise<string>} the path to hand finalizeTapOutput as `tempPath`
 */
async function createBufferFinalizeHandoff(session, logContext) {
  const handoffPath = path.join(session.bufferDir, 'buffer.finalize-src.ts');
  try {
    await fs.promises.link(session.bufferTempPath, handoffPath);
    streamDebug({ ...logContext, handoffPath, method: 'link' }, 'ytstream: createBufferFinalizeHandoff succeeded via hard link');
    return handoffPath;
  } catch (linkErr) {
    try {
      await fs.promises.copyFile(session.bufferTempPath, handoffPath);
      streamDebug({ ...logContext, handoffPath, method: 'copy', linkErr: linkErr.message }, 'ytstream: createBufferFinalizeHandoff fell back to a real copy (hard link failed)');
      return handoffPath;
    } catch (copyErr) {
      logger.warn({ linkErr, copyErr, ...logContext }, 'ytstream: failed to snapshot hls-buffer temp file before finalize; finalizing the original directly (small re-introduced race window)');
      return session.bufferTempPath;
    }
  }
}

/**
 * Spawns one HLS encode pass (yt-dlp video + yt-dlp audio + ffmpeg),
 * writing segments from `startSegmentIndex` onward into `session.dir`
 * instead of piping live.
 * Returns immediately with state 'starting' — callers go through
 * waitForHlsSessionReady before serving the playlist. Used for a
 * session's initial pass and, for calculatedLength sessions, to restart
 * the forward encode at a new segment boundary (restartHlsEncodePassAtSegment).
 *
 * `session.passGeneration` supersedes stale close/error handlers from a
 * killed-and-replaced pass: each call bumps it and captures its own
 * value, so a late 'close' from an outdated pass isn't treated as a
 * crash — same role `session.destroying` plays for a full teardown.
 *
 * @param {object} [source] - omitted for the normal network path (two
 *   yt-dlp pipes). `{ type: 'local', filePath }` switches to a single
 *   local-file input, no yt-dlp children — used by maybeHotSwapToCache
 *   once STRM cache-on-play finishes, and by mode=hls-buffer to read its
 *   own in-progress or finalized buffer-fetch file.
 * @param {object} [directUrls] - seek-restart fix: `{ videoUrl, audioUrl,
 *   cookieHeader }` from resolveDashUrlsForSeek. When present, ffmpeg
 *   fetches these DASH URLs itself with input-side `-ss` instead of
 *   piping yt-dlp's non-seekable output — only passed by
 *   restartHlsEncodePassAtSegment.
 * @param {boolean} [forceFullPipe] - skips the `--download-sections`
 *   optimization (useSectionedPipe), forcing the classic full-from-zero
 *   pipe with decode-and-discard `-ss`. Only passed by this function's
 *   own maybeFallbackToFullPipe retry.
 */
function spawnHlsEncodePass(session, { startSegmentIndex, seekSeconds, isInitialPass, playerClientOverride, source, directUrls, forceFullPipe, isBackfillPass }) {
  // Tracks which segment the CURRENTLY RUNNING pass is already working
  // toward (see ensureHlsSegmentAvailable) - a request for this exact
  // index isn't a real seek, so it must never trigger a same-target
  // restart. Set unconditionally so it always reflects the live pass.
  session.activePassStartIndex = startSegmentIndex;
  // A fresh pass might still add segments - only a clean ff exit (see
  // this function's ff.on('close') below) sets this back to true.
  session.encodeEnded = false;
  // Whatever superseded a running backfill pass (a genuine seek, another
  // hot-swap) already killed it via killChildProcess - it is no longer
  // "in progress" the instant a new pass takes over session.ff, regardless
  // of whether the old pass's own close handler ever gets to run (its
  // isCurrentPass() guard skips its cleanup once passGeneration moves on).
  // Set unconditionally (true only for the pass maybeBackfillMissingSegments
  // itself started) so a backfill pass killed by a real seek never leaves
  // this stuck true forever, which would permanently block the idle-sweep
  // from ever reclaiming this session's directory (see the sweep's own
  // check on this flag).
  session.backfillInProgress = isBackfillPass === true;
  const { youtubeId, quality, qualityStrictness, transcode, hardwareMode, tuning, config, sessionKey, segmentType, segmentExt } = session;
  const hw = normalizeHardwareMode(hardwareMode);
  const tier = normalizeTuning(tuning);
  const isLocalSource = !!(source && source.type === 'local');
  const isDirectSource = !isLocalSource && !!directUrls;

  // calculatedLength restarts and cached-source hot-swaps always seek to
  // the exact segment-boundary timestamp (never mid-segment) so ffmpeg's
  // segment counting stays aligned with -start_number's absolute indices.
  // A plain non-calculatedLength session never restarts here.
  // session.playlistSegmentDurationSeconds, NOT the live
  // session.segmentDurationSeconds: the static playlist (buildFullHlsPlaylist,
  // written once at session start with whatever value was frozen at that
  // moment) is what the PLAYER's own seek math is based on, since it only
  // ever reads that file - segment N means playlistSegmentDurationSeconds*N
  // to the player forever, however that froze. Using the LIVE
  // (still-improving) value here instead would desync the server's idea
  // of "segment N" from the player's, sending seeks to the wrong real
  // position.
  const effectiveSeek = (session.calculatedLength || isLocalSource)
    ? (startSegmentIndex > 0 ? startSegmentIndex * (session.playlistSegmentDurationSeconds || HLS_SEGMENT_DURATION_SECONDS) : null)
    : (seekSeconds || null);

  // The yt-dlp-pipe path's `-ss` on the non-seekable pipe:3/pipe:4 inputs
  // can't actually seek — ffmpeg decode-and-discards every frame from 0:00
  // to the target, which can take minutes deep into a long video (see
  // HLS_SEEK_RESTART_READY_TIMEOUT_MS). When there's a real seek target
  // and we're not on the direct-URL/local paths, ask yt-dlp to only
  // download from roughly that point via --download-sections instead.
  //
  // --download-sections alone isn't enough on fragmented DASH formats:
  // yt-dlp's internal extraction defaults to a non-fragmented MP4 ('ipod'
  // muxer), which requires seekable output and fails 100% of the time
  // piped to `-o -` ("muxer does not support non seekable output").
  // Forcing that internal extraction to Matroska (--downloader-args
  // "ffmpeg:-f matroska") avoids the seekable-output requirement — our
  // own ffmpeg auto-detects the container from the pipe's bytes, so it
  // doesn't care that it's Matroska instead of raw MP4/DASH.
  //
  // Still approximate (byte/keyframe-estimated, not frame-exact), hence
  // maybeFallbackToFullPipe below as a safety net if it ever errors.
  const useSectionedPipe = !isLocalSource && !isDirectSource && !!effectiveSeek && !forceFullPipe;

  // Seek-latency fix: yt-dlp's webpage + player-API extraction (resolving
  // the format list/DASH URLs) is identical on every seek-restart in a
  // session - only the --download-sections target changes - yet gets
  // redone from scratch each time, a big chunk of the ~10-15s before
  // ffmpeg sees its first byte after a seek. warmHlsInfoJsonCache
  // resolves it once, fire-and-forget, at session start, so most seeks
  // can skip straight to --load-info-json. Falls back to a bare watch URL
  // whenever the cache isn't ready yet; see maybeFallbackFromInfoJson for
  // the case where a *stale* cache (signed URLs valid a few hours) causes
  // an actual failure instead.
  const useInfoJson = !isLocalSource && !isDirectSource && !!session.infoJsonPath;

  let videoFormat = null;
  let audioFormat = null;
  let ytVideoArgs = null;
  let ytAudioArgs = null;
  if (!isLocalSource && !isDirectSource) {
    ({ videoFormat, audioFormat } = getDashFormatSelectors(quality, qualityStrictness));
    const watchUrl = `https://youtube.com/watch?v=${youtubeId}`;
    const commonYtArgs = [...buildBaseArgs(config, { playerClient: playerClientOverride }), '-o', '-', '--no-playlist', '--no-warnings'];
    // -copyts: without it, yt-dlp's internal section-extraction ffmpeg
    // resets each piped stream's timestamps to start near 0 independently.
    // Video can only cut on a keyframe so it typically starts a bit
    // *after* effectiveSeek; audio lands almost exactly on it. Re-zeroing
    // both separately throws away that gap, so our ffmpeg muxes them back
    // together as if they started at the same instant - the actual A/V
    // desync bug. -copyts preserves each pipe's real timestamp so the gap
    // survives into our own ffmpeg's -copyts (below) for correct realignment.
    const sectionArgs = useSectionedPipe
      ? ['--download-sections', `*${effectiveSeek}-inf`, '--downloader-args', 'ffmpeg:-f matroska -copyts']
      : [];
    // --load-info-json replaces the bare watch URL entirely (yt-dlp takes
    // no URL argument in that mode) - see useInfoJson above.
    const sourceArgs = useInfoJson ? ['--load-info-json', session.infoJsonPath] : [watchUrl];
    ytVideoArgs = [...commonYtArgs, ...sectionArgs, '-f', videoFormat, ...sourceArgs];
    ytAudioArgs = [...commonYtArgs, ...sectionArgs, '-f', audioFormat, ...sourceArgs];
  }

  // forceKeyframesByHardwareMode[hw] is only ever true once a user has
  // explicitly run the "Test HLS segment timing" check for THIS hardware
  // mode on THIS host and it passed (see streamTuningBenchmark.
  // testSegmentTiming and its route) - never a blanket default, since some
  // hardware encoders are known to sometimes mishandle a forced-keyframe
  // expression.
  const useForceKeyframes = ((config.ytstream || {}).forceKeyframesByHardwareMode || {})[hw] === true;
  const encoder = transcode === 'h264' ? buildVideoEncoderArgs(hw, resolveQualityHeight(quality), tier, (config.ytstream || {}).vaapiQuality, 'h264', useForceKeyframes) : null;

  const ffArgs = [
    // 'warning' (not 'error') for a direct-URL seek-restart: this path is
    // newer/less proven (see docs/YTSTREAM_SEEK_FIX.md's vprv caveat), and
    // a real failure once showed up as a bare exit code with empty stderr
    // at 'error' level - 'warning' costs nothing and surfaces what
    // actually went wrong next time.
    //
    // 'info' for useSectionedPipe: needed to get ffmpeg's per-input
    // startup banner ("Input #0 ... start: X.XXXXXX"), the only way to
    // see where the -copyts video/audio sections actually landed relative
    // to each other - see the stderr scan below.
    '-loglevel', isDirectSource ? 'warning' : (useSectionedPipe ? 'info' : 'error'),
    '-fflags', '+genpts',
    '-analyzeduration', '10M',
    '-probesize', '5M',
  ];
  if (useSectionedPipe) {
    // Mirrors sectionArgs' -copyts above: without it, ffmpeg would
    // independently re-zero pipe:3/pipe:4's timestamps, discarding the
    // real video/audio start-time gap a second time. -copyts preserves
    // both pipes' true timestamps; -start_at_zero then shifts the aligned
    // pair down together so segment/hls_time math still starts near 0.
    ffArgs.push('-copyts', '-start_at_zero');
  }
  if (encoder && encoder.preInputArgs && encoder.preInputArgs.length) {
    ffArgs.push(...encoder.preInputArgs);
  }
  if (isLocalSource) {
    // Cached-file hot-swap: the file is already fully downloaded and
    // muxed, so ffmpeg reads it directly — one local input, no yt-dlp
    // children, no pipe wiring.
    if (effectiveSeek) ffArgs.push('-ss', String(effectiveSeek));
    ffArgs.push('-i', source.filePath);
    ffArgs.push('-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-max_muxing_queue_size', '4096');
  } else if (isDirectSource) {
    // Seek-restart fix (docs/YTSTREAM_SEEK_FIX.md): ffmpeg fetches the
    // already-resolved DASH URLs itself over real HTTP, so -ss here is
    // an INPUT seek (a Range-based jump) rather than the yt-dlp-pipe
    // branch's broken output-side -ss on a non-seekable pipe — see the
    // doc's "Spike results" for the empirical proof this is a true seek.
    const headers = buildFfmpegUpstreamHeaders(directUrls.cookieHeader);
    if (effectiveSeek) ffArgs.push('-ss', String(effectiveSeek));
    ffArgs.push('-headers', headers, '-i', directUrls.videoUrl);
    if (effectiveSeek) ffArgs.push('-ss', String(effectiveSeek));
    ffArgs.push('-headers', headers, '-i', directUrls.audioUrl);
    ffArgs.push('-map', '0:v:0', '-map', '1:a:0?', '-sn', '-dn', '-max_muxing_queue_size', '4096');
  } else {
    // useSectionedPipe: yt-dlp's --download-sections already starts the
    // pipe near effectiveSeek, so an additional ffmpeg -ss would skip
    // past real content or land arbitrarily - leave input un-seeked and
    // accept whatever offset yt-dlp landed on (the video/audio pipes'
    // relative offset is preserved via -copyts/-start_at_zero above).
    const pipeSeek = useSectionedPipe ? null : effectiveSeek;
    if (pipeSeek) ffArgs.push('-ss', String(pipeSeek));
    ffArgs.push('-thread_queue_size', '4096', '-i', 'pipe:3');
    if (pipeSeek) ffArgs.push('-ss', String(pipeSeek));
    ffArgs.push('-thread_queue_size', '4096', '-i', 'pipe:4');

    ffArgs.push('-map', '0:v:0', '-map', '1:a:0?', '-sn', '-dn', '-max_muxing_queue_size', '4096');
  }

  if (encoder) {
    if (encoder.videoFilters && encoder.videoFilters.length) {
      ffArgs.push('-vf', encoder.videoFilters.join(','));
    }
    if (encoder.pixFmt) {
      ffArgs.push('-pix_fmt', encoder.pixFmt);
    }
    ffArgs.push(...encoder.encoderArgs);
    ffArgs.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k', '-ar', '48000');
  } else {
    ffArgs.push('-c', 'copy');
  }

  ffArgs.push(
    '-f', 'hls',
    '-hls_time', String(HLS_SEGMENT_DURATION_SECONDS),
    '-hls_list_size', '0', // keep the full history — VOD-style seekable playlist, not a sliding live window
    // Without an explicit playlist type, ffmpeg's growing/unbounded
    // playlist is indistinguishable from a live broadcast — the player
    // starts at the live edge and jumps forward, skipping segments
    // already encoded. 'event' tells it this is progressively-available-
    // but-eventually-complete, so it plays sequentially from segment 0.
    // ffmpeg still appends #EXT-X-ENDLIST on a clean finish either way.
    '-hls_playlist_type', 'event',
    '-hls_flags', 'temp_file+independent_segments',
    '-hls_segment_type', segmentType,
  );
  if (segmentType === 'fmp4') {
    ffArgs.push('-hls_fmp4_init_filename', 'init.mp4');
  }
  if ((session.calculatedLength || isLocalSource) && startSegmentIndex > 0) {
    ffArgs.push('-start_number', String(startSegmentIndex));
  }
  // No -hls_base_url: ffmpeg doesn't consistently apply it to the
  // #EXT-X-MAP (init segment) line for fmp4 output, only segment lines -
  // rewriteHlsPlaylistUrls handles that rewrite ourselves instead.
  //
  // calculatedLength sessions pre-declare the entire VOD playlist
  // themselves (buildFullHlsPlaylist) — ffmpeg's own playlist output here
  // is a disposable byproduct, never the one actually served.
  const ffmpegPlaylistPath = session.calculatedLength ? path.join(session.dir, 'scratch.m3u8') : session.playlistPath;
  ffArgs.push(
    '-hls_segment_filename', path.join(session.dir, `segment%05d.${segmentExt}`),
    ffmpegPlaylistPath
  );

  // mode=hls-buffer's still-growing buffer.ts and a genuinely finished
  // file both take the isLocalSource branch above - worth distinguishing
  // in the log, since only the growing-file case risks the encode pass
  // catching up to the write frontier (see waitForBufferedThrough).
  const isBufferInProgressSource = isLocalSource && session.bufferEnabled && !session.usingCachedSource
    && source.filePath === session.bufferTempPath;
  logger.info(
    {
      youtubeId, sessionKey, quality, playerClient: playerClientOverride, hardwareMode: hw, startSegmentIndex, videoFormat, audioFormat, dir: session.dir, ffArgs: redactFfArgsForLogging(ffArgs),
      source: isLocalSource ? (isBufferInProgressSource ? 'buffer-in-progress' : 'cache') : (isDirectSource ? 'direct-url' : (useSectionedPipe ? 'sectioned-pipe' : 'network')),
      usedCachedInfoJson: useInfoJson,
    },
    isLocalSource
      ? (isBufferInProgressSource
        ? 'ytstream: spawning HLS encode pass from the still-in-progress hls-buffer file'
        : 'ytstream: spawning HLS encode pass from cached local file')
      : isDirectSource
        ? 'ytstream: spawning HLS encode pass from directly-resolved DASH URLs (seek-restart fix)'
        : useSectionedPipe
          ? 'ytstream: spawning HLS encode pass (yt-dlp --download-sections + matroska + ffmpeg, sectioned seek)'
          : 'ytstream: spawning HLS encode pass (yt-dlp video + yt-dlp audio + ffmpeg)'
  );

  ensureProcessExitHandlers();
  ensureHlsIdleReaper(HLS_IDLE_TIMEOUT_MS, HLS_IDLE_SWEEP_INTERVAL_MS);

  const needsYtDlpChildren = !isLocalSource && !isDirectSource;
  let ytVideo = null;
  let ytAudio = null;
  if (needsYtDlpChildren) {
    ytVideo = spawn('yt-dlp', ytVideoArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    ytAudio = spawn('yt-dlp', ytAudioArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    registerChildProcess(ytVideo);
    registerChildProcess(ytAudio);
  }
  const ff = spawn('ffmpeg', ffArgs, { stdio: needsYtDlpChildren ? ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'] });
  registerChildProcess(ff);

  session.passGeneration = (session.passGeneration || 0) + 1;
  const myGeneration = session.passGeneration;
  session.ytVideo = ytVideo;
  session.ytAudio = ytAudio;
  session.ff = ff;

  logger.info(
    {
      sessionKey, youtubeId, passGeneration: myGeneration,
      isBackfillPass: isBackfillPass === true, isInitialPass: isInitialPass === true,
      startSegmentIndex, effectiveSeek,
      hardwareMode: hw, tuning: tier,
      sourceType: isLocalSource ? 'local' : isDirectSource ? 'direct-url' : (useSectionedPipe ? 'sectioned-pipe' : 'network'),
    },
    `ytstream: starting ${isBackfillPass ? 'backfill' : 'HLS'} encode pass at segment ${startSegmentIndex}`
  );

  let ytVideoErr = '';
  let ytAudioErr = '';
  let ffErr = '';
  ff.stderr.on('data', (c) => { ffErr = (ffErr + c.toString()).slice(-4000); });

  if (useSectionedPipe) {
    // Verification aid for the -copyts alignment fix: pipe:3/pipe:4 each
    // print a startup banner ("start: 305.233000") whose "start" is the
    // section's real landing point under -copyts - diffing the two shows
    // how far video's keyframe-snap drifted from audio's near-exact cut.
    // Scans the rolling ffErr tail; stops once both are found.
    let loggedInputTimestamps = false;
    ff.stderr.on('data', () => {
      if (loggedInputTimestamps) return;
      const videoStart = ffErr.match(/Input #0,[^\n]*\n(?:[^\n]*\n)*?\s*Duration:[^\n]*start:\s*(-?[\d.]+)/);
      const audioStart = ffErr.match(/Input #1,[^\n]*\n(?:[^\n]*\n)*?\s*Duration:[^\n]*start:\s*(-?[\d.]+)/);
      if (videoStart && audioStart) {
        loggedInputTimestamps = true;
        const videoStartSeconds = Number(videoStart[1]);
        const audioStartSeconds = Number(audioStart[1]);
        logger.info(
          {
            sessionKey, startSegmentIndex, effectiveSeek,
            videoStartSeconds, audioStartSeconds,
            driftSeconds: videoStartSeconds - audioStartSeconds,
          },
          'ytstream: sectioned seek pipe input timestamps (video vs audio, post -copyts)'
        );
      }
    });
  }

  if (needsYtDlpChildren) {
    ytVideo.stderr.on('data', (c) => { ytVideoErr = (ytVideoErr + c.toString()).slice(-4000); });
    ytAudio.stderr.on('data', (c) => { ytAudioErr = (ytAudioErr + c.toString()).slice(-4000); });

    const ffVideoIn = ff.stdio[3];
    const ffAudioIn = ff.stdio[4];
    // Any of these pipe streams can see a write-after-close race during
    // teardown - an unhandled 'error' on any of them is an uncaught
    // exception that crashes the ENTIRE Node process, so every stream
    // gets a listener.
    ytVideo.stdout.on('error', () => { /* pipe destination gone; pass is being torn down */ });
    ytAudio.stdout.on('error', () => { /* pipe destination gone; pass is being torn down */ });
    ffVideoIn.on('error', () => { /* upstream (yt-dlp video) already gone or being killed */ });
    ffAudioIn.on('error', () => { /* upstream (yt-dlp audio) already gone or being killed */ });
    ytVideo.stdout.pipe(ffVideoIn);
    ytAudio.stdout.pipe(ffAudioIn);
  }

  // A pass is "current" only while nothing has since destroyed the whole
  // session or superseded this specific pass with a newer one (a seek
  // restart, or a cache hot-swap). A superseded pass's exit is expected,
  // not a crash.
  const isCurrentPass = () => !session.destroying && session.passGeneration === myGeneration;

  // Only meaningful for the session's very first pass — that's the only
  // one waitForHlsSessionReady's starting/ready/failed lifecycle cares
  // about. A later (seek-triggered or hot-swap) pass failing shouldn't
  // retroactively fail a session other viewers may already be watching
  // earlier segments of; it just means that particular seek target won't
  // appear (the segment route's readiness poll times out and 404s).
  const markFailed = (message) => {
    if (!isCurrentPass()) return;
    if (isInitialPass) {
      if (session.state === 'starting') {
        session.state = 'failed';
        session.error = message;
      }
    } else {
      logger.warn({ sessionKey, startSegmentIndex, message }, 'ytstream: HLS seek-restart encode pass failed');
    }
  };
  const isKilledByUs = (signal) => signal === 'SIGTERM' || signal === 'SIGKILL';

  // Safety net for useInfoJson: cached info-json's signed URLs are
  // typically valid a few hours but could expire or go bad. On failure,
  // permanently drops the cache for the rest of THIS session (not just
  // this retry), then retries once with normal watch-URL extraction -
  // the always-correct, if slower, path used before the cache was ready.
  let fallbackFromInfoJsonAttempted = false;
  const maybeFallbackFromInfoJson = (reason, message) => {
    if (!useInfoJson || fallbackFromInfoJsonAttempted || !isCurrentPass()) return false;
    fallbackFromInfoJsonAttempted = true;
    logger.warn(
      { sessionKey, startSegmentIndex, reason, message },
      'ytstream: cached info-json seek-restart pass failed; dropping the cache and falling back to full yt-dlp extraction'
    );
    session.infoJsonPath = null;
    spawnHlsEncodePass(session, { startSegmentIndex, seekSeconds, isInitialPass, playerClientOverride, source });
    return true;
  };

  // Seek-restart's direct-URL attempt gets exactly one automatic fallback
  // to the yt-dlp-pipe path on any ffmpeg failure (403, network blip,
  // etc) - never let a seek regress below "eventually decode-and-
  // discards". Scoped to this pass's closure, not session state.
  let fallbackToPipeAttempted = false;
  const maybeFallbackToPipe = (reason, message) => {
    if (!isDirectSource || fallbackToPipeAttempted || !isCurrentPass()) return false;
    fallbackToPipeAttempted = true;
    logger.warn(
      { sessionKey, startSegmentIndex, reason, message },
      'ytstream: direct-URL seek-restart pass failed; falling back to yt-dlp pipe'
    );
    spawnHlsEncodePass(session, { startSegmentIndex, isInitialPass: false, source });
    return true;
  };

  // Safety net for useSectionedPipe: the matroska downloader override
  // isn't guaranteed for every yt-dlp/video combo - on failure, fall
  // back exactly once to the classic full-pipe decode-and-discard path
  // (forceFullPipe), slower but always works.
  let fallbackToFullPipeAttempted = false;
  const maybeFallbackToFullPipe = (reason, message) => {
    if (!useSectionedPipe || fallbackToFullPipeAttempted || !isCurrentPass()) return false;
    fallbackToFullPipeAttempted = true;
    logger.warn(
      { sessionKey, startSegmentIndex, reason, message },
      'ytstream: sectioned yt-dlp seek-restart pass failed; falling back to full yt-dlp pipe (slow decode-and-discard)'
    );
    spawnHlsEncodePass(session, { startSegmentIndex, isInitialPass: false, source, forceFullPipe: true });
    return true;
  };

  if (needsYtDlpChildren) {
    ytVideo.on('error', (err) => {
      if (maybeFallbackFromInfoJson('ytdlp-video-spawn-error', err.message)) return;
      if (maybeFallbackToFullPipe('ytdlp-video-spawn-error', err.message)) return;
      markFailed(err.message);
    });
    ytAudio.on('error', (err) => {
      if (maybeFallbackFromInfoJson('ytdlp-audio-spawn-error', err.message)) return;
      if (maybeFallbackToFullPipe('ytdlp-audio-spawn-error', err.message)) return;
      markFailed(err.message);
    });
  }
  ff.on('error', (err) => {
    if (maybeFallbackFromInfoJson('ffmpeg-spawn-error', err.message)) return;
    if (maybeFallbackToPipe('ffmpeg-spawn-error', err.message)) return;
    if (maybeFallbackToFullPipe('ffmpeg-spawn-error', err.message)) return;
    markFailed(err.message);
  });

  if (needsYtDlpChildren) {
    ytVideo.on('close', (code, signal) => {
      if (!isCurrentPass()) return;
      if (code !== 0 && code !== null && !isKilledByUs(signal)) {
        logger.error({ sessionKey, code, signal, ytVideoErr: ytVideoErr.slice(-800) }, 'ytstream: HLS yt-dlp (video) exited non-zero');
        if (maybeFallbackFromInfoJson('ytdlp-video-exit', ytVideoErr || `yt-dlp (video) exited with code ${code}`)) return;
        if (maybeFallbackToFullPipe('ytdlp-video-exit', ytVideoErr || `yt-dlp (video) exited with code ${code}`)) return;
        markFailed(ytVideoErr || `yt-dlp (video) exited with code ${code}`);
      }
    });
    ytAudio.on('close', (code, signal) => {
      if (!isCurrentPass()) return;
      if (code !== 0 && code !== null && !isKilledByUs(signal)) {
        logger.error({ sessionKey, code, signal, ytAudioErr: ytAudioErr.slice(-800) }, 'ytstream: HLS yt-dlp (audio) exited non-zero');
        if (maybeFallbackFromInfoJson('ytdlp-audio-exit', ytAudioErr || `yt-dlp (audio) exited with code ${code}`)) return;
        if (maybeFallbackToFullPipe('ytdlp-audio-exit', ytAudioErr || `yt-dlp (audio) exited with code ${code}`)) return;
        markFailed(ytAudioErr || `yt-dlp (audio) exited with code ${code}`);
      }
    });
  }
  ff.on('close', (code, signal) => {
    // Always logged, even for a superseded pass - the only way to see how
    // long a retired pass's ffmpeg kept running (and writing segments)
    // after passGeneration was bumped. Cross-check against this exit time
    // if a served segment ever looks like it came from the wrong pass.
    streamDebug(
      { sessionKey, pid: ff.pid, code, signal, myGeneration, currentPassGeneration: session.passGeneration, wasCurrentPass: isCurrentPass(), startSegmentIndex },
      'ytstream: HLS ffmpeg process closed'
    );
    if (!isCurrentPass()) return;
    if (code !== 0 && code !== null && !isKilledByUs(signal)) {
      // Mirrors the clean-finish branch's own reset below - without it, a
      // backfill pass that crashes (rather than reaching a clean EOF)
      // leaves this stuck true forever: the UI shows "backfilling segment
      // N" frozen at whatever it last reached, and maybeBackfillMissingSegments's
      // own backfillInProgress guard permanently blocks every future retry,
      // even ones triggered by a later, unrelated pass finishing cleanly.
      session.backfillInProgress = false;
      logger.error({ sessionKey, code, signal, ffErr: ffErr.slice(-800) }, 'ytstream: HLS ffmpeg exited non-zero');
      if (maybeFallbackFromInfoJson('ffmpeg-exit', ffErr || `ffmpeg exited with code ${code}`)) return;
      if (maybeFallbackToPipe('ffmpeg-exit', ffErr || `ffmpeg exited with code ${code}`)) return;
      if (maybeFallbackToFullPipe('ffmpeg-exit', ffErr || `ffmpeg exited with code ${code}`)) return;
      markFailed(ytVideoErr || ytAudioErr || ffErr || `ffmpeg exited with code ${code}`);
      // A clean finish gets #EXT-X-ENDLIST from ffmpeg itself; a crash
      // doesn't - without it a player hangs forever waiting for the next
      // segment instead of ending cleanly. calculatedLength sessions
      // already have a static playlist with ENDLIST, nothing to append.
      if (!session.calculatedLength && session.state === 'ready') {
        fs.appendFile(session.playlistPath, '\n#EXT-X-ENDLIST\n', (err) => {
          if (err) logger.warn({ err, sessionKey }, 'ytstream: failed to append #EXT-X-ENDLIST after HLS ffmpeg crash');
        });
      }
    } else if (code === 0) {
      // Clean finish: this pass reached the real end of the source and
      // nothing will ever produce another segment for it. The
      // calculatedLength playlist pre-declares session.totalSegments from
      // an ESTIMATED duration (yt-dlp metadata, which can round up or
      // slightly overshoot the actual encodable content) - computeSegmentStatus
      // reads this flag to stop reporting those never-coming trailing
      // slots as "not yet available" once there's no longer a running
      // pass that could fill them.
      session.encodeEnded = true;
      session.backfillInProgress = false;
      logger.info(
        { sessionKey, totalSegments: session.totalSegments, passGeneration: myGeneration, wasBackfillPass: isBackfillPass === true },
        `ytstream: ${isBackfillPass ? 'backfill' : 'HLS'} encode pass finished cleanly`
      );
      maybeBackfillMissingSegments(session);
    }
  });
}

/**
 * ytstream.backfillMissingSegments: called right after a clean encode-pass
 * finish (session.encodeEnded=true, see spawnHlsEncodePass's own
 * ff.on('close') above). A forward seek during playback restarts the live
 * encode at the seek target (restartHlsEncodePassAtSegment), permanently
 * stranding any segment between the abandoned pass's progress and the new
 * target - once the live pass has reached the real end of the video with
 * nothing left to produce, this finds the earliest such gap and, ONLY if a
 * real local source is already available this session (STRM cache-on-play's
 * hot-swap, or this mode's own tap/buffer finalize - never a fresh network
 * pull), spawns another pass there via the exact same spawnHlsEncodePass
 * every other restart uses - reusing its hardware-encoder/tuning/HLS
 * segment handling and generation-based cancellation (a real seek arriving
 * mid-backfill kills and supersedes it exactly like it would any other
 * pass) rather than reimplementing any of that. That reused pass naturally
 * sweeps forward from the gap to the true end in one go - cheaper to let
 * run than to bound/stop it exactly at the gap's end, and it only
 * re-writes (not reprocesses) whatever segments after the gap already
 * existed.
 *
 * Deliberately best-effort and fully decoupled from live playback: never
 * awaited by any caller, no effect at all unless
 * ytstream.backfillMissingSegments is on, and if no local source ever
 * became available this session, this simply never has anything to do.
 */
function maybeBackfillMissingSegments(session) {
  try {
    const sessionKey = session.key;
    if ((configModule.getConfig().ytstream || {}).backfillMissingSegments !== true) {
      logger.debug({ sessionKey }, 'ytstream: backfillMissingSegments - skipped, setting is off');
      return;
    }
    if (session.destroying || session.backfillInProgress) {
      logger.debug({ sessionKey, destroying: session.destroying === true, backfillInProgress: session.backfillInProgress === true }, 'ytstream: backfillMissingSegments - skipped, session destroying or a backfill already in progress');
      return;
    }
    if (!(session.usingCachedSource && session.cachedFilePath)) {
      logger.debug({ sessionKey, usingCachedSource: session.usingCachedSource === true }, 'ytstream: backfillMissingSegments - skipped, no local cached source available yet for this session');
      return;
    }

    const status = computeSegmentStatus(session);
    if (!status) {
      logger.debug({ sessionKey }, 'ytstream: backfillMissingSegments - skipped, could not compute segment status (session directory unreadable?)');
      return;
    }
    const gapIndex = status.encoded.indexOf(false);
    if (gapIndex === -1) {
      logger.debug({ sessionKey, totalSegments: status.totalSegments }, 'ytstream: backfillMissingSegments - no gaps found, every segment already encoded');
      return;
    }

    logger.info(
      { sessionKey: session.key, youtubeId: session.youtubeId, gapIndex, totalSegments: status.totalSegments },
      'ytstream: backfilling missing HLS segments from a local source'
    );
    spawnHlsEncodePass(session, {
      startSegmentIndex: gapIndex,
      isInitialPass: false,
      isBackfillPass: true,
      source: { type: 'local', filePath: session.cachedFilePath },
    });
  } catch (err) {
    logger.warn({ err, sessionKey: session.key }, 'ytstream: maybeBackfillMissingSegments failed');
  }
}

/**
 * mode=hls-buffer: an independent, one-shot yt-dlp+ffmpeg pipeline that
 * pulls this session's video once, at full network speed, remuxing
 * (-c copy, no HLS segmenting) into a single local MPEG-TS file - same
 * DASH pipes spawnHlsEncodePass's network branch uses, but never killed
 * or restarted by a seek/teardown the way the session's own `ff` is (see
 * ytstreamBufferFetch.js) - this fetch has no throughput ceiling shared
 * with the live encode. Fire-and-forget - callers poll session.bufferedSeconds via
 * waitForBufferedThrough before reading the growing file.
 */
function startHlsBufferFetch(session) {
  const { isBufferFetchActive, markBufferFetchStarted, markBufferFetchFinished, parseBufferedSeconds } = require('../ytstreamBufferFetch');
  const { finalizeTapOutput } = require('../ytstreamTapFinalizer');
  const { youtubeId, quality, qualityStrictness, config } = session;

  if (isBufferFetchActive(youtubeId)) {
    // Another session is already fetching this same still-STRM video (a
    // second device, or a different quality/transcode combo) - rather
    // than tracking/sharing progress across sessions, this session just
    // falls back to the network path for every pass, same as a failed
    // fetch would (below). Rare enough in practice not to warrant it.
    logger.info({ sessionKey: session.sessionKey, youtubeId }, 'ytstream: hls-buffer fetch already in flight for this video; this session will use the network path');
    session.bufferFetchFailed = true;
    // This session's own bufferDir was created (by createHlsSessionInternal,
    // before calling this function) but will never be used - nothing else
    // ever cleans it up otherwise, since finish() (which does) never runs.
    if (session.bufferDir) fs.rm(session.bufferDir, { recursive: true, force: true }, () => {});
    return;
  }
  markBufferFetchStarted(youtubeId);
  // Wall-clock start of this fetch - threaded through to finalizeTapOutput
  // below purely so a successful finish can record downloadDurationSeconds/
  // avgDownloadMBps for Download History, same as any other download.
  // Doesn't affect the fetch/pipeline itself in any way.
  const fetchStartedAt = Date.now();

  const { videoFormat, audioFormat } = getDashFormatSelectors(quality, qualityStrictness);
  const watchUrl = `https://youtube.com/watch?v=${youtubeId}`;
  const commonYtArgs = [...buildBaseArgs(config, {}), '-o', '-', '--no-playlist', '--no-warnings'];
  const ytVideoArgs = [...commonYtArgs, '-f', videoFormat, watchUrl];
  const ytAudioArgs = [...commonYtArgs, '-f', audioFormat, watchUrl];

  logger.info(
    { sessionKey: session.sessionKey, youtubeId, quality, tempPath: session.bufferTempPath },
    'ytstream: starting independent hls-buffer fetch (network-bound, decoupled from the live HLS serve)'
  );
  // Ground truth for any future "why is this fetch slower than that one"
  // question - the actual resolved network-tuning flags (chunk size,
  // concurrent fragments, throttle/socket timeout - see
  // ytstream.httpChunkSizeMiB/concurrentFragments/throttledRateKBps/
  // socketTimeoutSeconds) baked into THIS fetch's real yt-dlp args, not
  // just what Settings currently shows (which may have changed since).
  streamDebug(
    { sessionKey: session.sessionKey, youtubeId, videoFormat, audioFormat, ytVideoArgs, ytAudioArgs },
    'ytstream: hls-buffer fetch resolved yt-dlp args (network tuning baked in)'
  );

  ensureProcessExitHandlers();

  const ytVideo = spawn('yt-dlp', ytVideoArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  const ytAudio = spawn('yt-dlp', ytAudioArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  const ffArgs = [
    '-loglevel', 'error',
    '-progress', 'pipe:1',
    '-thread_queue_size', '4096', '-i', 'pipe:3',
    '-thread_queue_size', '4096', '-i', 'pipe:4',
    '-map', '0:v:0', '-map', '1:a:0?', '-sn', '-dn', '-c', 'copy',
    '-f', 'mpegts',
    session.bufferTempPath,
  ];
  const ff = spawn('ffmpeg', ffArgs, { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
  registerChildProcess(ytVideo);
  registerChildProcess(ytAudio);
  registerChildProcess(ff);
  session.bufferYtVideo = ytVideo;
  session.bufferYtAudio = ytAudio;
  session.bufferFf = ff;

  const ffVideoIn = ff.stdio[3];
  const ffAudioIn = ff.stdio[4];
  ytVideo.stdout.on('error', () => { /* pipe destination gone; fetch is being torn down */ });
  ytAudio.stdout.on('error', () => { /* pipe destination gone; fetch is being torn down */ });
  ffVideoIn.on('error', () => { /* upstream (yt-dlp video) already gone or being killed */ });
  ffAudioIn.on('error', () => { /* upstream (yt-dlp audio) already gone or being killed */ });
  ytVideo.stdout.pipe(ffVideoIn);
  ytAudio.stdout.pipe(ffAudioIn);

  let ytVideoErr = '';
  let ytAudioErr = '';
  let ffErr = '';
  ytVideo.stderr.on('data', (c) => { ytVideoErr = (ytVideoErr + c.toString()).slice(-2000); });
  ytAudio.stderr.on('data', (c) => { ytAudioErr = (ytAudioErr + c.toString()).slice(-2000); });
  ff.stderr.on('data', (c) => { ffErr = (ffErr + c.toString()).slice(-2000); });
  // -progress pipe:1 arrives on ffmpeg's stdout, not stderr. Logged
  // (throttled to once per BUFFER_PROGRESS_LOG_INTERVAL_SECONDS of
  // buffered video) so a stalled fetch is visible instead of going
  // silent between start/finish - without this, hung vs healthy-but-slow
  // look identical.
  let lastLoggedBufferedSeconds = 0;
  ff.stdout.on('data', (c) => {
    const seconds = parseBufferedSeconds(c.toString());
    if (seconds === null) return;
    session.bufferedSeconds = seconds;
    if (seconds - lastLoggedBufferedSeconds >= BUFFER_PROGRESS_LOG_INTERVAL_SECONDS) {
      lastLoggedBufferedSeconds = seconds;
      streamDebug({ sessionKey: session.sessionKey, youtubeId, bufferedSeconds: seconds }, 'ytstream: hls-buffer fetch progress');
    }
  });

  const isKilledByUs = (signal) => signal === 'SIGTERM' || signal === 'SIGKILL';
  let settled = false;
  const finish = async (ok, message) => {
    if (settled) return;
    settled = true;
    markBufferFetchFinished(youtubeId);
    streamDebug({ sessionKey: session.sessionKey, youtubeId, ok, message }, 'ytstream: hls-buffer fetch finish() called');
    if (!ok) {
      logger.warn({ sessionKey: session.sessionKey, youtubeId, message }, 'ytstream: hls-buffer fetch failed; discarding partial file');
      session.bufferFetchFailed = true;
      // Not unlinked directly here (discardTapOutput would do that
      // immediately) - a seek-restart pass may already be spawned with
      // `-i bufferTempPath` (isBufferInProgressSource above) but not yet
      // have actually opened it. maybeCleanupBufferDir (below) removes the
      // whole bufferDir - abandoned partial file included - but only once
      // this AND the session itself (destroyHlsSession) have both finished
      // with it, so nothing ever unlinks the file out from under an
      // in-flight open() - see that function's doc comment.
      session.bufferFetchSettled = true;
      maybeCleanupBufferDir(session);
      return;
    }
    // finalizeTapOutput renames/unlinks its `tempPath` argument immediately
    // and unconditionally - handing it session.bufferTempPath directly
    // would risk yanking that file out from under a seek-restart pass this
    // session's live encode side may have already spawned with
    // `-i bufferTempPath` (isBufferInProgressSource above) but not yet
    // actually opened (ffmpeg's own startup - extraction args, hwupload/
    // vaapi init - can take a few seconds). Confirmed live: an ENOENT on
    // buffer.ts mid-seek-restart, timed exactly to a finalize racing a
    // just-spawned pass. createBufferFinalizeHandoff hands finalize a
    // private handoff path instead, leaving the original untouched until
    // maybeCleanupBufferDir (below) decides it's actually safe to remove.
    const handoffPath = await createBufferFinalizeHandoff(session, { sessionKey: session.sessionKey, youtubeId });
    streamDebug({ sessionKey: session.sessionKey, youtubeId, handoffPath, bufferTempPath: session.bufferTempPath, finalPath: session.bufferFinalPath }, 'ytstream: hls-buffer finish() calling finalizeTapOutput with the handoff path');
    finalizeTapOutput({
      youtubeId,
      tempPath: handoffPath,
      finalPath: session.bufferFinalPath,
      sourceLabel: 'hls-buffer',
      skipVideoUpsert: session.bufferUntracked === true,
      startedAt: fetchStartedAt,
      // Video and audio pull the same watch URL/args, differing only in
      // -f <format> - the video invocation is the more useful one to keep
      // for debugging (it's what typically fails/gets throttled first).
      ytdlpCommand: ytVideoArgs.join(' '),
    })
      .then((finalPath) => {
        if (finalPath) {
          session.usingCachedSource = true;
          session.cachedFilePath = finalPath;
          session.bufferFetchDone = true;
          logger.info(
            {
              sessionKey: session.sessionKey,
              youtubeId,
              finalPath,
              untracked: session.bufferUntracked === true,
              stealth: session.bufferStealth === true,
              hybridPromote: session.bufferHybridPromote === true,
            },
            session.bufferStealth
              ? 'ytstream: hls-buffer fetch finalized into the hidden stealth cache (Video row untouched)'
              : session.bufferHybridPromote
                ? 'ytstream: hls-buffer fetch finalized into the hidden cache, pending .mp4 promotion to library'
                : session.bufferUntracked
                  ? 'ytstream: hls-buffer fetch finalized into the untracked-video cache'
                  : 'ytstream: hls-buffer fetch finalized as permanent download'
          );
          // resolveHlsBufferPromoteFn picks the right "what to do once
          // this .ts is remuxed to .mp4" strategy - swap the hidden cache
          // in place (stealthCache on, or genuinely untracked), promote
          // to the library (the hybrid case), or the original
          // library-.ts promotion (finalizeToMp4 off entirely makes this
          // whole call a no-op anyway - maybeFinalizeTsToMp4 checks that
          // config itself before ever touching ffmpeg).
          {
            const promoteFn = resolveHlsBufferPromoteFn(session);
            maybeFinalizeTsToMp4(youtubeId, finalPath, 'hls-buffer', {
              promote: (mp4Path) => promoteFn(youtubeId, finalPath, mp4Path, { youtubeId, sourceLabel: 'hls-buffer' }),
            });
          }
          // An already-running hls-buffer session just keeps transcoding
          // until it ends - a mid-session switch to serving this finished
          // file directly was attempted and reverted: it requires splicing
          // two independently-extracted media streams together via an HLS
          // discontinuity, which depends on player-specific discontinuity
          // handling that couldn't be made reliable - confirmed live,
          // twice, as "Parsed buffers not in DTS sequence" MSE errors when
          // a player sought directly into the spliced region.
        } else {
          session.bufferFetchFailed = true;
        }
        session.bufferFetchSettled = true;
        maybeCleanupBufferDir(session);
      })
      .catch((err) => {
        logger.warn({ err, sessionKey: session.sessionKey, youtubeId }, 'ytstream: hls-buffer finalize failed');
        session.bufferFetchFailed = true;
        session.bufferFetchSettled = true;
        maybeCleanupBufferDir(session);
      });
  };

  ytVideo.once('error', (err) => finish(false, err.message));
  ytAudio.once('error', (err) => finish(false, err.message));
  ff.once('error', (err) => finish(false, err.message));
  ytVideo.once('exit', (code, signal) => {
    if (code !== 0 && !isKilledByUs(signal)) finish(false, ytVideoErr || `yt-dlp (video) exited with code ${code}`);
  });
  ytAudio.once('exit', (code, signal) => {
    if (code !== 0 && !isKilledByUs(signal)) finish(false, ytAudioErr || `yt-dlp (audio) exited with code ${code}`);
  });
  ff.once('close', (code, signal) => {
    if (code === 0 && !isKilledByUs(signal)) {
      finish(true);
    } else {
      finish(false, ffErr || `ffmpeg exited with code ${code}, signal ${signal}`);
    }
  });
}

/**
 * mode=hls-buffer: waits (bounded) for startHlsBufferFetch's fetch to
 * have written at least BUFFER_SAFETY_MARGIN_SECONDS past `targetSeconds`
 * before an encode pass reads that region as a plain local file.
 * @returns {Promise<'buffer'|'network'>} 'buffer': safe to read
 *   session.cachedFilePath/bufferTempPath as a local source. 'network':
 *   give up, fall back to the network-sourced path for this pass (the
 *   fetch itself keeps running regardless).
 */
async function waitForBufferedThrough(session, targetSeconds) {
  if (session.usingCachedSource) return 'buffer';
  if (session.bufferFetchFailed) return 'network';
  const deadline = Date.now() + BUFFER_CATCHUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (session.usingCachedSource) return 'buffer';
    if (session.bufferFetchFailed) return 'network';
    if (session.bufferedSeconds >= targetSeconds + BUFFER_SAFETY_MARGIN_SECONDS) return 'buffer';
    if (session.destroying) return 'network';
    await new Promise((resolve) => setTimeout(resolve, HLS_READY_POLL_INTERVAL_MS));
  }
  logger.warn(
    { sessionKey: session.sessionKey, youtubeId: session.youtubeId, targetSeconds, bufferedSeconds: session.bufferedSeconds },
    'ytstream: hls-buffer catch-up wait timed out; falling back to network path for this pass'
  );
  return 'network';
}

/**
 * calculatedLength only: kills the currently-running encode pass and
 * starts a new one at `segmentIndex`'s boundary, without touching the
 * session's hlsSessions/activeStreams entry or directory - much lighter
 * than destroyHlsSession. Deduplicates concurrent requests for the same
 * target within HLS_SEEK_GRACE_MS (e.g. several HLS.js retries for the
 * same seek) into a single restart.
 *
 * Goes straight to spawnHlsEncodePass with no directUrls, skipping a
 * direct-URL resolve+fetch attempt entirely - googlevideo's vprv=1 URLs
 * 403 when fetched by a bare ffmpeg HTTP client, so that attempt would
 * only add a guaranteed-to-fail round trip before falling through to
 * useSectionedPipe anyway.
 */
async function restartHlsEncodePassAtSegment(session, segmentIndex) {
  const now = Date.now();
  if (session.lastRestartIndex === segmentIndex && now - session.lastRestartAt < HLS_SEEK_GRACE_MS) {
    logger.debug(
      { sessionKey: session.key, segmentIndex, lastRestartIndex: session.lastRestartIndex, msSinceLastRestart: now - session.lastRestartAt },
      'ytstream: restart request suppressed - same segment index within the seek-grace window'
    );
    return;
  }
  logger.info(
    {
      sessionKey: session.key,
      segmentIndex,
      priorLastRestartIndex: session.lastRestartIndex,
      priorPassGeneration: session.passGeneration || 0,
      activePassStartIndexBeforeRestart: session.activePassStartIndex,
      usingCachedSourceBeforeRestart: session.usingCachedSource === true,
      bufferEnabled: session.bufferEnabled === true,
    },
    'ytstream: restart requested for a genuinely new segment index'
  );
  session.lastRestartIndex = segmentIndex;
  session.lastRestartAt = now;
  logger.info({ sessionKey: session.key, segmentIndex }, 'ytstream: seek past encoded HLS segments; restarting encode pass at boundary');
  // Bumped HERE, not left for spawnHlsEncodePass to do on its own for the
  // new pass (an extra bump is harmless). The gap before the new pass
  // spawns can be up to BUFFER_CATCHUP_TIMEOUT_MS (45s) when
  // waitForBufferedThrough is in play - without bumping early, the
  // just-killed process's close handler still sees itself as "current"
  // for that window, so if it dies from its broken pipe rather than
  // SIGTERM (a real race: `code:1, signal:null`, "Invalid data found
  // when processing input") it logs a scary but expected teardown as a
  // real ERROR.
  const retiredPassGeneration = session.passGeneration || 0;
  session.passGeneration = retiredPassGeneration + 1;
  logger.info(
    { sessionKey: session.key, segmentIndex, retiredPassGeneration, newPassGeneration: session.passGeneration },
    'ytstream: bumped passGeneration and sending kill signals to the retired pass - not awaited, the retired process may still be alive/writing for a moment after this'
  );
  killChildProcess(session.ytVideo, 'hls-fakelength-restart');
  killChildProcess(session.ytAudio, 'hls-fakelength-restart');
  killChildProcess(session.ff, 'hls-fakelength-restart');
  // Once a session has hot-swapped to the cached file, every subsequent
  // restart (including a calculatedLength seek past what's encoded) must keep
  // reading from that same local file - omitting `source` here would
  // silently fall back to spawning yt-dlp against the network again.
  let source = session.usingCachedSource && session.cachedFilePath
    ? { type: 'local', filePath: session.cachedFilePath }
    : undefined;
  if (!source && session.bufferEnabled) {
    // mode=hls-buffer: wait (bounded) for startHlsBufferFetch to have
    // safely written past this seek target before reading it as a local
    // file (waitForBufferedThrough/BUFFER_SAFETY_MARGIN_SECONDS). Falls
    // through to the network-sourced restart if the wait times out (the
    // fetch keeps running regardless).
    //
    // Only worth waiting if the live encode has already produced real
    // content (segment00000 exists) - otherwise the buffer has no head
    // start to speak of, and waiting is a pure gamble: a real case saw an
    // 11.9s buffer-wait followed by a further 10.8s to seek+encode from
    // the finalized local file (-ss deep into a large MPEG-TS file isn't
    // free), 25.4s total - past HLS.js's ~20s fragment-load timeout, so
    // the video never played. Network-direct-seek starts AT the target
    // time via yt-dlp instead, avoiding that second cost.
    // session.playlistSegmentDurationSeconds, not the live
    // session.segmentDurationSeconds - see effectiveSeek's comment in
    // spawnHlsEncodePass for why: this must match what the
    // (never-touched-after-start) playlist declares.
    const targetSeconds = segmentIndex * (session.playlistSegmentDurationSeconds || HLS_SEGMENT_DURATION_SECONDS);
    const everProducedRealSegment = fs.existsSync(path.join(session.dir, `segment00000.${session.segmentExt}`));
    if (everProducedRealSegment) {
      const ready = await waitForBufferedThrough(session, targetSeconds);
      if (ready === 'buffer') {
        source = { type: 'local', filePath: session.usingCachedSource ? session.cachedFilePath : session.bufferTempPath };
        let bufferFileSizeAtDecision = null;
        try { bufferFileSizeAtDecision = fs.statSync(source.filePath).size; } catch (err) { /* stat failed - just for the log */ }
        logger.debug(
          {
            sessionKey: session.key,
            segmentIndex,
            targetSeconds,
            chosenFilePath: source.filePath,
            bufferFileSizeAtDecision,
            sessionBufferedSecondsAtDecision: session.bufferedSeconds,
            usingCachedSource: session.usingCachedSource === true,
          },
          'ytstream: seek-restart will read from the local buffer/cached file - if the served segment content ever looks wrong for its declared position, this is the log to check against the eventual -ss seek result'
        );
      }
    } else {
      logger.info(
        { sessionKey: session.key, youtubeId: session.youtubeId, targetSeconds },
        'ytstream: seek-restart before any real segment ever existed (likely a resume-from-position on cold start) - skipping the buffer-wait, going straight to a network-sourced seek instead'
      );
    }
  }

  spawnHlsEncodePass(session, { startSegmentIndex: segmentIndex, isInitialPass: false, source });
}

/**
 * ytstream.hotSwapToCache: if STRM cache-on-play has finished downloading
 * this session's video since it started, kills the live network encode
 * pass and restarts it from the local cached file - same picture, no
 * player-visible restart, just faster/more reliable for the rest of the
 * video. Throttled via HOT_SWAP_CHECK_INTERVAL_MS, switches only once.
 * @param {object} session
 * @returns {Promise<boolean>} true only if this call just triggered the switch
 */
async function maybeHotSwapToCache(session) {
  const now = Date.now();
  if (session.lastHotSwapCheckAt && now - session.lastHotSwapCheckAt < HOT_SWAP_CHECK_INTERVAL_MS) {
    return false;
  }
  session.lastHotSwapCheckAt = now;

  try {
    const Video = require('../../models/video');
    const video = await Video.findOne({
      where: { youtubeId: session.youtubeId },
      attributes: ['is_strm', 'filePath'],
    });
    if (!video || video.is_strm !== false || !video.filePath || !fs.existsSync(video.filePath)) {
      return false;
    }

    // Set before the restart, not after — a concurrent segment request
    // must not also trigger a second switch while this one is in flight.
    // cachedFilePath is read by restartHlsEncodePassAtSegment so a LATER
    // seek-restart keeps reading from the cached file, not the network.
    session.usingCachedSource = true;
    session.cachedFilePath = video.filePath;

    // Resume numbering one past the highest segment the (about to be
    // killed) live pass actually finished writing - not the segment this
    // particular request asked for, since other viewers/requests may be
    // further ahead or behind in the same shared session.
    let nextIndex = 0;
    try {
      const files = fs.readdirSync(session.dir);
      const indices = files
        .map((f) => f.match(/^segment(\d{5})\.\w+$/))
        .filter(Boolean)
        .map((m) => Number(m[1]));
      if (indices.length > 0) nextIndex = Math.max(...indices) + 1;
    } catch {
      // dir mid-write race; fall back to 0 - a full re-encode from the
      // start is safe, just briefly wasteful, and still correct.
    }

    logger.info(
      { sessionKey: session.key, youtubeId: session.youtubeId, cachedFilePath: video.filePath, nextIndex },
      'ytstream: STRM cache-on-play file now available; hot-swapping HLS session to local cached source'
    );
    killChildProcess(session.ytVideo, 'hls-hotswap-to-cache');
    killChildProcess(session.ytAudio, 'hls-hotswap-to-cache');
    killChildProcess(session.ff, 'hls-hotswap-to-cache');
    spawnHlsEncodePass(session, {
      startSegmentIndex: nextIndex,
      isInitialPass: false,
      source: { type: 'local', filePath: video.filePath },
    });
    return true;
  } catch (err) {
    logger.warn({ err, sessionKey: session.key }, 'ytstream: hot-swap-to-cache check failed');
    return false;
  }
}

/**
 * ytstream.bufferStartAfterSegments support: the 3 fresh-fetch call sites
 * in createHlsSessionInternal call this instead of startHlsBufferFetch
 * directly. threshold<=0 keeps the original immediate-start behavior
 * exactly as it was; threshold>0 defers to maybeStartDeferredBufferFetch
 * below, triggered from ensureHlsSegmentAvailable as real segment requests
 * come in.
 */
function maybeDeferBufferFetch(session) {
  if (session.bufferStartAfterSegments > 0) {
    session.bufferFetchPending = true;
  } else {
    startHlsBufferFetch(session);
  }
}

/**
 * ytstream.bufferStartAfterSegments support (see the `if (bufferEnabled)`
 * setup in createHlsSessionInternal for the config resolution/doc comment):
 * called on every segment request for a session whose hls-buffer fetch was
 * deferred (session.bufferFetchPending true), tracks distinct segment
 * indices seen, and starts the real fetch once the threshold is reached.
 * A no-op for every other session (bufferFetchPending falsy - buffer
 * disabled, threshold 0, or already started).
 */
function maybeStartDeferredBufferFetch(session, targetIndex) {
  if (!session.bufferFetchPending) return;
  if (!session.requestedSegmentIndexes) session.requestedSegmentIndexes = new Set();
  session.requestedSegmentIndexes.add(targetIndex);
  if (session.requestedSegmentIndexes.size >= session.bufferStartAfterSegments) {
    session.bufferFetchPending = false;
    logger.info(
      {
        sessionKey: session.key,
        youtubeId: session.youtubeId,
        requestedSegments: session.requestedSegmentIndexes.size,
        threshold: session.bufferStartAfterSegments,
      },
      'ytstream: deferred hls-buffer fetch threshold reached - starting now'
    );
    startHlsBufferFetch(session);
  }
}

/**
 * calculatedLength only: the playlist declares every segment upfront, but
 * only a forward-encoding window exists on disk at any moment. Called
 * when a requested segment is missing — gives the running pass a brief
 * grace window to reach it naturally (common sequential playback), then
 * restarts the forward encode at that segment's boundary.
 */
async function ensureHlsSegmentAvailable(session, targetIndex, filePath) {
  maybeStartDeferredBufferFetch(session, targetIndex);
  if (fs.existsSync(filePath)) return true;
  logger.debug(
    { sessionKey: session.key, targetIndex, activePassStartIndex: session.activePassStartIndex, passGeneration: session.passGeneration || 0 },
    'ytstream: requested segment missing on disk - starting grace wait'
  );
  const graceDeadline = Date.now() + HLS_SEEK_GRACE_MS;
  while (Date.now() < graceDeadline) {
    if (fs.existsSync(filePath)) return true;
    await new Promise((resolve) => setTimeout(resolve, HLS_READY_POLL_INTERVAL_MS));
  }
  if (fs.existsSync(filePath)) return true;

  // Concurrent requests for DIFFERENT not-yet-encoded segments (e.g. a
  // player prefetching several segments in parallel, which a VOD+ENDLIST
  // calculatedLength playlist invites) can each reach this point before
  // any of them has actually redirected the pass. Only one target can win
  // - record which one THIS call is waiting for, synchronously, before any
  // async work below, so a later concurrent call for a different index is
  // detectable by every earlier waiter's poll loop, however far along it
  // is. Confirmed live: without this, a losing waiter polled
  // fs.existsSync for the full HLS_SEEK_RESTART_READY_TIMEOUT_MS (4
  // minutes) for a file the pass had already been redirected away from
  // and would never produce - far past any real client's read timeout,
  // so it looked like the request had simply hung forever.
  session.latestSeekTargetIndex = targetIndex;

  // The pass currently running is already working toward this exact
  // segment - most commonly targetIndex 0 while the session's initial
  // pass hasn't produced its first segment yet (VAAPI/GPU init + yt-dlp
  // resolve often exceeds HLS_SEEK_GRACE_MS). Not a real seek, so
  // restarting would just kill/respawn an identical pass for nothing -
  // keep waiting on the SAME pass with a full cold-start budget instead.
  if (session.activePassStartIndex === targetIndex) {
    logger.info(
      { sessionKey: session.key, targetIndex },
      'ytstream: grace wait expired but the active pass is already targeting this exact index - waiting longer on the same pass instead of restarting'
    );
    const coldStartDeadline = Date.now() + HLS_READY_TIMEOUT_MS;
    while (Date.now() < coldStartDeadline) {
      if (fs.existsSync(filePath)) return true;
      if (session.destroying) return false;
      if (session.latestSeekTargetIndex !== targetIndex) {
        logger.info(
          { sessionKey: session.key, targetIndex, latestSeekTargetIndex: session.latestSeekTargetIndex },
          'ytstream: seek wait abandoned - a concurrent request for a different segment claimed the encode pass'
        );
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, HLS_READY_POLL_INTERVAL_MS));
    }
    return fs.existsSync(filePath);
  }

  logger.info(
    { sessionKey: session.key, targetIndex, activePassStartIndex: session.activePassStartIndex },
    'ytstream: genuine seek (different index than the active pass is targeting) - triggering restartHlsEncodePassAtSegment'
  );
  // Not awaited: restartHlsEncodePassAtSegment's DASH-URL resolution runs
  // in the background while this loop polls the filesystem for the
  // target segment, up to HLS_SEEK_RESTART_READY_TIMEOUT_MS. .catch only
  // guards an unhandled rejection - failures are already logged inside.
  restartHlsEncodePassAtSegment(session, targetIndex).catch((err) => {
    logger.error({ err, sessionKey: session.key, targetIndex }, 'ytstream: seek-restart threw unexpectedly');
  });
  const readyDeadline = Date.now() + HLS_SEEK_RESTART_READY_TIMEOUT_MS;
  let targetReady = false;
  while (Date.now() < readyDeadline) {
    if (fs.existsSync(filePath)) { targetReady = true; break; }
    if (session.destroying) return false;
    if (session.latestSeekTargetIndex !== targetIndex) {
      logger.info(
        { sessionKey: session.key, targetIndex, latestSeekTargetIndex: session.latestSeekTargetIndex },
        'ytstream: seek-restart wait abandoned - a concurrent request for a different segment superseded this target before it was produced'
      );
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, HLS_READY_POLL_INTERVAL_MS));
  }
  if (!targetReady) targetReady = fs.existsSync(filePath);
  if (!targetReady) return false;

  // This restart's target is confirmed ready - see
  // HLS_POST_RESTART_LOOKAHEAD_SEGMENTS's comment for why it's worth a
  // short additional wait for a few segments right behind it too, rather
  // than handing the target back the instant it alone exists.
  await waitForPostRestartLookahead(session, targetIndex);
  return true;
}

async function waitForPostRestartLookahead(session, targetIndex) {
  const cushionDeadline = Date.now() + HLS_POST_RESTART_LOOKAHEAD_TIMEOUT_MS;
  for (let i = 1; i <= HLS_POST_RESTART_LOOKAHEAD_SEGMENTS; i++) {
    const cushionPath = path.join(session.dir, `segment${String(targetIndex + i).padStart(5, '0')}.${session.segmentExt}`);
    while (!fs.existsSync(cushionPath)) {
      if (session.destroying || Date.now() >= cushionDeadline) return;
      await new Promise((resolve) => setTimeout(resolve, HLS_READY_POLL_INTERVAL_MS));
    }
  }
}

/**
 * Seek-latency fix: resolves yt-dlp's webpage + player-API extraction for
 * this video exactly once, in parallel with the session's first encode
 * pass - all its SIDE EFFECTS (session.infoJsonPath for seek-restart's
 * `--load-info-json` fast path) happen regardless of whether the returned
 * promise is awaited or ignored, so existing fire-and-forget callers are
 * unaffected. If a seek races it (e.g. an immediate Jellyfin
 * resume-from-middle), that seek falls back to full extraction - only
 * session.infoJsonPath being non-null unlocks the fast path.
 *
 * Also resolves the fps/formats piggybacked out of this same call -
 * resolveVideoFpsForSession is what actually persists it into
 * youtubeMetadataCache; this function just reports what it found (or null
 * on any failure) and never throws.
 * @returns {Promise<{fps: number, info: object}|null>}
 */
function warmHlsInfoJsonCache(session, playerClientOverride) {
  const { youtubeId, config, sessionKey, dir } = session;
  const watchUrl = `https://youtube.com/watch?v=${youtubeId}`;
  const args = [...buildBaseArgs(config, { playerClient: playerClientOverride }), '--no-playlist', '--no-warnings', '-j', watchUrl];
  ensureProcessExitHandlers();
  const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  registerChildProcess(proc);
  session.infoJsonProc = proc;
  const infoJsonPath = path.join(dir, 'info.json');
  const out = fs.createWriteStream(infoJsonPath);
  out.on('error', () => { /* best-effort cache; a write failure just means no cache this session */ });
  proc.stdout.pipe(out);
  let stderr = '';
  proc.stderr.on('data', (c) => { stderr = (stderr + c.toString()).slice(-2000); });
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result) => { if (!settled) { settled = true; resolve(result); } };
    proc.on('error', (err) => {
      if (session.infoJsonProc === proc) session.infoJsonProc = null;
      logger.warn({ sessionKey, err: err.message }, 'ytstream: yt-dlp info-json warm-up failed to spawn; seek-restarts will keep re-extracting');
      settle(null);
    });
    proc.on('close', (code, signal) => {
      if (session.infoJsonProc === proc) session.infoJsonProc = null;
      if (session.destroying) { settle(null); return; }
      if (code === 0) {
        session.infoJsonPath = infoJsonPath;
        logger.info({ sessionKey }, 'ytstream: cached yt-dlp extraction info for faster seek-restarts');
        try {
          const info = JSON.parse(fs.readFileSync(infoJsonPath, 'utf8'));
          const fps = Number(info && info.fps);
          settle(Number.isFinite(fps) && fps > 0 ? { fps, info } : null);
        } catch (err) {
          logger.debug({ err, sessionKey }, 'ytstream: could not read fps from cached info-json');
          settle(null);
        }
      } else {
        if (signal !== 'SIGTERM' && signal !== 'SIGKILL') {
          logger.warn({ sessionKey, code, signal, stderr: stderr.slice(-800) }, 'ytstream: yt-dlp info-json warm-up exited non-zero; seek-restarts will keep re-extracting');
        }
        settle(null);
      }
    });
  });
}

/**
 * Fire-and-forget cache warm-up for a session's video: on a cache miss,
 * runs the same yt-dlp -j extraction warmHlsInfoJsonCache already does for
 * seek-restart purposes and persists its fps/duration/formats into
 * youtubeMetadataCache (server/modules/youtubeMetadataCache.js) - so a
 * later stream, download, or STRM generation of this same video (and this
 * session's own resolveMaxAvailableHeight call) never needs its own live
 * yt-dlp call. Never awaited by its caller and never throws - purely a
 * side effect. (Previously also applied a per-source fps correction to
 * session.segmentDurationSeconds/totalSegments; reverted - see
 * HLS_SEGMENT_DURATION_SECONDS's comment for why.)
 * @returns {Promise<void>}
 */
async function resolveVideoFpsForSession(session, playerClientOverride) {
  const cachedFps = await youtubeMetadataCache.getCachedFps(session.youtubeId);
  const warmupPromise = warmHlsInfoJsonCache(session, playerClientOverride);
  if (cachedFps) return;
  const result = await warmupPromise;
  if (!result) return;
  if (Number.isFinite(session.durationSeconds) && session.durationSeconds > 0) {
    youtubeMetadataCache.cacheRawInfoJson(session.youtubeId, session.durationSeconds, result.info);
  }
}

async function createHlsSessionInternal(sessionKey, { youtubeId, quality, qualityStrictness, transcode, hardwareMode, tuning, container, config, baseUrl, seekSeconds, clientIp, userAgent, calculatedLength, hotSwapToCache, bufferEnabled, viaProbe }, playerClientOverride) {
  const hw = normalizeHardwareMode(hardwareMode);
  const tier = normalizeTuning(tuning);
  const { segmentType, segmentExt } = getHlsContainerInfo(container);

  // Unique per spawn attempt, not just per sessionKey: the retry path
  // destroys a session and immediately creates a new one under the same
  // sessionKey, but destroyHlsSession's directory removal is deliberately
  // delayed - reusing the same directory would let that delayed cleanup
  // delete the new attempt's freshly-written segments. The asset route
  // resolves files via session.dir, not a recomputed sessionKey path, so
  // this is safe to vary independently.
  const dir = path.join(resolveHlsBaseDir(), `${sessionKey}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  const playlistPath = path.join(dir, 'playlist.m3u8');

  const session = {
    key: sessionKey,
    sessionKey,
    dir,
    playlistPath,
    segmentExt,
    segmentType,
    baseUrl,
    youtubeId,
    quality,
    qualityStrictness: qualityStrictness || 'fallback',
    transcode,
    hardwareMode: hw,
    tuning: tier,
    container,
    config,
    calculatedLength: !!calculatedLength,
    // getOrCreateHlsSessionForProbe only - see its own doc comment and the
    // trackStream call below. Never flipped back to false: once real
    // segment activity happens (whether the probe's own codec-detection
    // fetch, or genuine playback), the per-asset-serve state='active' write
    // in createHlsAssetRouteHandler already overwrites the Streaming
    // page's displayed state regardless of this flag - it only matters for
    // what trackStream seeds the INITIAL state to below.
    viaProbe: !!viaProbe,
    passGeneration: 0,
    ytVideo: null,
    ytAudio: null,
    ff: null,
    state: 'starting',
    error: null,
    // Set by destroyHlsSession before it kills anything — lets the
    // close handlers in spawnHlsEncodePass tell "we did this on
    // purpose" apart from an actual crash, including the file-I/O
    // errors ffmpeg throws when its working directory gets removed out
    // from under it mid-write.
    destroying: false,
    lastAccess: Date.now(),
    createdAt: Date.now(),
    lastRestartIndex: null,
    lastRestartAt: 0,
    // ytstream.hotSwapToCache - see maybeHotSwapToCache. usingCachedSource
    // flips true (permanently, for this session) once the switch happens;
    // lastHotSwapCheckAt throttles how often the DB gets checked.
    hotSwapToCache: !!hotSwapToCache,
    usingCachedSource: false,
    cachedFilePath: null,
    lastHotSwapCheckAt: 0,
    // Seek-latency fix - see warmHlsInfoJsonCache/useInfoJson in
    // spawnHlsEncodePass. infoJsonPath flips non-null once the
    // background warm-up finishes; infoJsonProc tracks the in-flight
    // warm-up process so destroyHlsSession can kill it if the session
    // ends before it completes.
    infoJsonPath: null,
    infoJsonProc: null,
    // Always the nominal constant - see HLS_SEGMENT_DURATION_SECONDS's
    // comment for the per-source fps correction this used to apply here,
    // and why it was reverted.
    segmentDurationSeconds: HLS_SEGMENT_DURATION_SECONDS,
    // Copied from segmentDurationSeconds once, at playlist-build time (see
    // createHlsSessionInternal) - kept as a separate field (rather than
    // reading segmentDurationSeconds directly) since effectiveSeek/
    // ensureHlsSegmentAvailable's targetSeconds must stay consistent with
    // whatever the static (never-rewritten) playlist file declared, not
    // necessarily whatever this field's source might read as later.
    playlistSegmentDurationSeconds: null,
    // mode=hls-buffer - see startHlsBufferFetch/waitForBufferedThrough.
    // bufferEnabled only ends up true if this video is genuinely still
    // STRM right now. bufferedSeconds is updated by the fetch's
    // -progress output; bufferFetchFailed short-circuits any in-progress
    // wait so a dead fetch doesn't make every pass wait out the timeout.
    bufferEnabled: false,
    bufferDir: null,
    bufferTempPath: null,
    bufferFinalPath: null,
    bufferedSeconds: 0,
    bufferFetchFailed: false,
    bufferFetchDone: false,
    // Set true once startHlsBufferFetch's finish() has done its own work
    // (finalize-or-discard), regardless of outcome, and hlsTornDown once
    // destroyHlsSession has torn down this session - see
    // maybeCleanupBufferDir for why bufferDir's actual deletion needs both
    // before it's safe.
    bufferFetchSettled: false,
    hlsTornDown: false,
  };

  if (bufferEnabled) {
    // ytstream.bufferStartAfterSegments (default 3, 0 = old behavior):
    // delays the network-bound hls-buffer fetch (startHlsBufferFetch) until
    // this many DISTINCT segments have actually been requested, instead of
    // starting the instant the session exists - a metadata probe (Jellyfin/
    // StrmTool) only ever requests segment 0 (occasionally 1), so this
    // skips a full background download for every probe that never becomes
    // real playback. See maybeStartDeferredBufferFetch, the 3 call sites
    // below that now go through it, and ensureHlsSegmentAvailable's hook.
    session.bufferStartAfterSegments = (config.ytstream && config.ytstream.bufferStartAfterSegments != null)
      ? Number(config.ytstream.bufferStartAfterSegments)
      : 3;
    try {
      const video = await models.Video.findOne({
        where: { youtubeId },
        attributes: ['is_strm', 'filePath'],
      });
      if (video && video.is_strm === true && video.filePath) {
        session.bufferEnabled = true;
        const ytCfg = configModule.getConfig().ytstream || {};
        const stealthCache = ytCfg.stealthCache === true;
        const finalizeToMp4Enabled = ytCfg.finalizeToMp4 === true;
        // ytstream.stealthCache (or finalizeToMp4 alone) - route the
        // fetch's .ts into the SAME hidden cache the untracked path above
        // uses (getUntrackedBufferCachePath), instead of writing it into
        // the visible library folder, so Jellyfin's scanner never has a
        // file to discover mid-flight:
        //  - stealthCache on: stays hidden forever, Video row (and its
        //    .strm) never touched - see session.bufferStealth below.
        //  - stealthCache off, finalizeToMp4 on ("hybrid"): stays hidden
        //    until the background remux finishes, then promotes the
        //    REMUXED .mp4 straight into the library (promoteHiddenMp4ToLibrary)
        //    - Jellyfin only ever sees the .strm replaced by a finished
        //    .mp4, never the intermediate .ts. See session.bufferHybridPromote.
        //  - both off: unchanged, today's behavior - .ts written directly
        //    into the library folder, is_strm flips immediately.
        const useHiddenStaging = stealthCache || finalizeToMp4Enabled;
        streamDebug(
          { sessionKey, youtubeId, stealthCache, finalizeToMp4Enabled, useHiddenStaging },
          'ytstream: bufferEnabled tracked-video routing decision'
        );
        if (useHiddenStaging) {
          session.bufferStealth = stealthCache;
          session.bufferHybridPromote = !stealthCache && finalizeToMp4Enabled;
          // findWarmUntrackedBufferCache (not a raw .ts existsSync) since a
          // previously-finalized fetch may have already been swapped over
          // to .mp4 by swapHiddenCacheToMp4 - that's just as warm/reusable.
          const existingHiddenCache = findWarmUntrackedBufferCache(youtubeId);
          if (existingHiddenCache) {
            // Already warm from an earlier play (or from being genuinely
            // untracked before this video was added to the library) -
            // reuse it immediately, same as the untracked branch below.
            // destroyHlsSession's teardown-retry hook still gets a chance
            // to (re)attempt promotion for the hybrid case once this
            // session ends, using whatever tsRemuxCache state exists.
            streamDebug(
              { sessionKey, youtubeId, existingHiddenCache, bufferStealth: session.bufferStealth, bufferHybridPromote: session.bufferHybridPromote },
              'ytstream: reusing already-warm hidden hls-buffer cache, skipping fetch'
            );
            session.usingCachedSource = true;
            session.cachedFilePath = existingHiddenCache;
            session.bufferFetchDone = true;
            session.bufferUntracked = true;
            session.bufferFinalPath = existingHiddenCache;
            maybeRetroactivelyRemuxReusedCache(youtubeId, existingHiddenCache, session);
          } else {
            // A fresh fetch always lands as .ts first (see the comment
            // below on why) - never .mp4 directly, so this is the one spot
            // that still needs the plain .ts-only path, not the
            // either-extension lookup above.
            const hiddenCachePath = getUntrackedBufferCachePath(youtubeId);
            const bufferDir = path.join(resolveHlsBaseDir(), `buffer-${youtubeId}-${crypto.randomBytes(4).toString('hex')}`);
            fs.mkdirSync(bufferDir, { recursive: true });
            fs.mkdirSync(HLS_UNTRACKED_BUFFER_CACHE_DIR, { recursive: true });
            session.bufferDir = bufferDir;
            session.bufferTempPath = path.join(bufferDir, 'buffer.ts');
            session.bufferFinalPath = hiddenCachePath;
            // Reuses the untracked finalize path (skipVideoUpsert) - the
            // Video row must stay exactly as-is (still STRM) while the
            // file lives in the hidden cache, same requirement whether
            // this video genuinely has no Video row or has one that's
            // deliberately not being touched yet.
            session.bufferUntracked = true;
            streamDebug(
              { sessionKey, youtubeId, hiddenCachePath, bufferStealth: session.bufferStealth, bufferHybridPromote: session.bufferHybridPromote },
              'ytstream: starting hidden hls-buffer fetch (stealth/hybrid staging)'
            );
            maybeDeferBufferFetch(session);
          }
        } else {
          const targetDir = path.dirname(video.filePath);
          const fileStem = path.basename(video.filePath, path.extname(video.filePath));
          // Deliberately its OWN directory, NOT session.dir: this fetch
          // keeps running and finalizes even after the HLS session is torn
          // down (idle reap, retry, manual stop), so it must not live where
          // destroyHlsSession schedules deletion on teardown.
          // Always .ts regardless of the session's `container` setting -
          // MPEG-TS is the hard requirement for a file safely readable
          // while still being appended to (no moov-atom-style trailing
          // index the way MP4 has).
          const bufferDir = path.join(resolveHlsBaseDir(), `buffer-${youtubeId}-${crypto.randomBytes(4).toString('hex')}`);
          fs.mkdirSync(bufferDir, { recursive: true });
          session.bufferDir = bufferDir;
          session.bufferTempPath = path.join(bufferDir, 'buffer.ts');
          session.bufferFinalPath = path.join(targetDir, `${fileStem}.ts`);
          maybeDeferBufferFetch(session);
        }
        // Both startHlsBufferFetch calls above are fire-and-forget - not
        // awaited - so a fresh fetch gets every bit of this function's
        // remaining setup time (duration lookup, placeholder generation,
        // trackStream) as a free head start before the initial pass's
        // waitForBufferedThrough wait even begins below.
      } else {
        // This video isn't something Youtarr's own library currently owns
        // (no Video row - an untracked NZB `strm` grab, or one disowned
        // via `importStrategy:'untracked'`). No library destination to
        // finalize into, so falls back to Youtarr's own untracked-buffer
        // cache keyed by youtubeId alone: not a library entry, never shows
        // up in Download History - purely a same-video-again speed-up.
        // findWarmUntrackedBufferCache (not a raw .ts existsSync) since a
        // previous fetch may have already been swapped to .mp4 by
        // swapHiddenCacheToMp4 once finalizeToMp4 remuxed it.
        const existingUntrackedCache = findWarmUntrackedBufferCache(youtubeId);
        const alreadyCached = !!existingUntrackedCache;
        session.bufferEnabled = true;
        if (alreadyCached) {
          // A previous play of this same untracked video already finished
          // buffering it. Safe to use from the very first pass too -
          // unlike a fresh fetch (see the initial-pass call site's own
          // comment on why THAT deliberately stays network-sourced), this
          // file is already complete, nothing to wait for.
          session.usingCachedSource = true;
          session.cachedFilePath = existingUntrackedCache;
          session.bufferFetchDone = true;
          // Needed so resolveHlsBufferPromoteFn (called just below) picks
          // swapHiddenCacheToMp4 rather than falling through to the
          // library-.ts promote function - this session never sets
          // bufferStealth/bufferHybridPromote (this whole branch is only
          // reached when there's no Video row at all), so bufferUntracked
          // is the only signal it has.
          session.bufferUntracked = true;
          maybeRetroactivelyRemuxReusedCache(youtubeId, existingUntrackedCache, session);
        } else {
          // A fresh fetch always lands as .ts first, never .mp4 directly -
          // see startHlsBufferFetch/the comment a few lines above.
          const untrackedCachePath = getUntrackedBufferCachePath(youtubeId);
          fs.mkdirSync(HLS_UNTRACKED_BUFFER_CACHE_DIR, { recursive: true });
          const bufferDir = path.join(resolveHlsBaseDir(), `buffer-${youtubeId}-${crypto.randomBytes(4).toString('hex')}`);
          fs.mkdirSync(bufferDir, { recursive: true });
          session.bufferDir = bufferDir;
          session.bufferTempPath = path.join(bufferDir, 'buffer.ts');
          session.bufferFinalPath = untrackedCachePath;
          session.bufferUntracked = true;
          maybeDeferBufferFetch(session);
        }
        logger.info(
          {
            sessionKey,
            youtubeId,
            videoFound: !!video,
            isStrm: video ? video.is_strm : null,
            hasFilePath: video ? !!video.filePath : null,
            existingUntrackedCache,
            alreadyCached,
          },
          alreadyCached
            ? 'ytstream: hls-buffer requested for an untracked video - reusing its own cached copy from a previous play, no network fetch needed'
            : 'ytstream: hls-buffer requested for an untracked video - buffering into Youtarr\'s own untracked cache (keyed by youtube id) instead of the library, since there\'s no Video row to attach a permanent download to'
        );
      }
    } catch (err) {
      logger.warn({ err, sessionKey, youtubeId }, 'ytstream: hls-buffer could not resolve STRM target; buffer disabled for this session');
    }
  }

  if (session.calculatedLength) {
    // Pre-declare the whole playlist (real duration, VOD, ENDLIST) up
    // front - see buildFullHlsPlaylist - so the player sees a full
    // seekable timeline before almost any segment exists. Ignores
    // `seekSeconds`: segment 0 must always correspond to video time 0 for
    // the pre-declared absolute segment indices to stay correct.
    const durationSeconds = await getVideoDurationSeconds(youtubeId, config);
    session.durationSeconds = durationSeconds;
    session.totalSegments = Math.max(1, Math.ceil(durationSeconds / HLS_SEGMENT_DURATION_SECONDS));
    // Diagnostic (temporary) - the resolved value was never actually
    // logged anywhere before, so "scrubber shows 0" reports had nothing
    // to confirm/rule out against.
    logger.info({ sessionKey, youtubeId, durationSeconds, totalSegments: session.totalSegments }, 'ytstream: calculatedLength duration resolved for this session');

    // Fire-and-forget - never delays playlist creation below. Fires the
    // SAME warmHlsInfoJsonCache this session needs anyway for seek-restart
    // caching (session.infoJsonPath) and persists fps/duration/formats
    // into youtubeMetadataCache for next time - no separate/duplicate
    // yt-dlp call either way.
    resolveVideoFpsForSession(session, playerClientOverride).catch(() => { /* never throws; defensive only */ });
    // Always the nominal constant now - see HLS_SEGMENT_DURATION_SECONDS's
    // comment for why this session no longer tries to correct it.
    session.playlistSegmentDurationSeconds = session.segmentDurationSeconds;

    const fullPlaylist = buildFullHlsPlaylist({
      totalSegments: session.totalSegments,
      durationSeconds,
      segmentExt,
      segmentType,
      segmentDurationSeconds: session.playlistSegmentDurationSeconds,
    });
    fs.writeFileSync(playlistPath, fullPlaylist);
    maybeSaveDebugPlaylistCopy({ youtubeId, kind: 'media', content: fullPlaylist });
  }

  trackStream({
    streamId: sessionKey,
    // session.bufferEnabled reflects whether the buffer fetch actually
    // resolved (video was genuinely still STRM), not just whether it was
    // requested - a plain hls fallback still reads as 'hls' correctly.
    mode: session.bufferEnabled ? 'hls-buffer' : 'hls',
    youtubeId,
    quality,
    container,
    transcode,
    hardwareMode: hw,
    tuning: tier,
    clientIp,
    userAgent,
    // 'probe' takes priority: this session was created by
    // getOrCreateHlsSessionForProbe answering a detected metadata probe,
    // not a real playback request - see probeShortcut.js's
    // tryServeInstantHlsPlaylist. Distinguishes "Jellyfin (or similar) just
    // asked for this, no one may actually be watching" from a genuine
    // stream on the Streaming page, since this session is otherwise
    // indistinguishable from real playback (same real yt-dlp/ffmpeg
    // pipeline). Never rewritten back once real activity starts - the
    // per-asset-serve state='active' write in createHlsAssetRouteHandler
    // overwrites it the moment any segment is actually served, same as it
    // would overwrite 'starting'/'cached' below for a real request.
    //
    // 'cached' (not the generic 'starting') when this session is already
    // sourcing from a warm local file (a hls-buffer reuse hit - see
    // bufferEnabled's tracked/untracked reuse branches, both stealth and
    // otherwise) rather than genuinely fetching over the network - the
    // Streaming page's state chip otherwise looked identical to a live
    // network fetch during the several seconds ffmpeg still needs to spin
    // up the HLS encode, even though there's nothing to wait on the
    // network for. A fresh fetch still in progress correctly stays
    // 'starting' here (usingCachedSource only flips true once its own
    // finish() callback resolves, later than this trackStream call).
    state: session.viaProbe ? 'probe' : (session.usingCachedSource ? 'cached' : 'starting'),
    startedAt: Date.now(),
    bytesTransferred: 0,
    bytesPerSecond: 0,
    lastActivityAt: Date.now(),
    viewers: new Map([[clientIp, { userAgent, lastSeen: Date.now() }]]),
    stop: () => destroyHlsSession(session, 'manual-stop'),
  });

  // calculatedLength sessions already fired this above (via
  // resolveVideoFpsForSession, fire-and-forget before the playlist was
  // built) - session.infoJsonPath is already set or on its way. calculatedLength is forced true for every
  // HLS-family session today (see getModeFieldCompatibility), so this
  // branch is defensive/currently unreachable rather than a real gap -
  // kept so a non-calculatedLength session (if one is ever possible
  // again) still gets its own seek-restart info-json warm-up.
  if (!session.calculatedLength) {
    warmHlsInfoJsonCache(session, playerClientOverride);
  }
  // mode=hls-buffer: the cold-start/initial pass deliberately does NOT
  // wait for a fresh buffer fetch to catch up - it starts network-sourced,
  // like plain mode=hls. An earlier version awaited waitForBufferedThrough
  // here, blocking the whole HTTP response (including the instant-start
  // placeholder) on the buffer catching up - defeating instant-start's
  // purpose entirely. The buffer still gets used for everything after
  // this first pass (restartHlsEncodePassAtSegment already routes seeks
  // through waitForBufferedThrough, after the response has gone out).
  //
  // The one exception: session.usingCachedSource can already be true
  // RIGHT HERE - a previous play of this same untracked video already
  // finished buffering it. That's a complete local file already on disk,
  // nothing to wait for, so reading it immediately for the initial pass
  // is strictly better than a fresh network fetch.
  spawnHlsEncodePass(session, {
    startSegmentIndex: 0,
    seekSeconds,
    isInitialPass: true,
    playerClientOverride,
    source: session.usingCachedSource ? { type: 'local', filePath: session.cachedFilePath } : undefined,
  });

  return session;
}

/** Polls the filesystem until at least one real segment exists, or fails/times out. */
async function waitForHlsSessionReady(session, timeoutMs) {
  if (session.state === 'ready') return;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (session.state === 'failed') {
      throw new Error(session.error || 'HLS session failed to start');
    }
    if (fs.existsSync(session.playlistPath)) {
      let files = [];
      try { files = fs.readdirSync(session.dir); } catch { /* dir mid-write race; retry next poll */ }
      if (files.some((f) => f.endsWith(`.${session.segmentExt}`))) {
        session.state = 'ready';
        return;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`HLS session did not produce a segment within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, HLS_READY_POLL_INTERVAL_MS));
  }
}

/**
 * Returns an existing ready/starting session for this key, or creates one
 * and waits for it to become ready (retrying once with the android player
 * client on a 403/extraction-error signature). Throws if it never becomes
 * ready.
 */
async function getOrCreateHlsSession(sessionKey, params) {
  const existing = hlsSessions.get(sessionKey);
  if (existing) {
    if (existing.state !== 'failed') {
      existing.lastAccess = Date.now();
      // A different client joining an already-running session — record
      // it for the Streaming page's viewer count, same session/stream.
      const entry = getActiveStream(sessionKey);
      if (entry && entry.viewers && params.clientIp) {
        entry.viewers.set(params.clientIp, { userAgent: params.userAgent, lastSeen: Date.now() });
      }
      if (existing.state === 'starting') {
        await waitForHlsSessionReady(existing, HLS_READY_TIMEOUT_MS);
      }
      return existing;
    }
    destroyHlsSession(existing, 'stale-failed');
  }

  // Single-flight: a concurrent second call for the same not-yet-existing
  // sessionKey (see hlsSessionCreationPromises' doc comment) joins this
  // in-flight creation instead of starting its own.
  const inFlight = hlsSessionCreationPromises.get(sessionKey);
  if (inFlight) {
    return inFlight;
  }

  const creationPromise = (async () => {
    const session = await createHlsSessionInternal(sessionKey, params, undefined);
    hlsSessions.set(sessionKey, session);
    try {
      await waitForHlsSessionReady(session, HLS_READY_TIMEOUT_MS);
      return session;
    } catch (err) {
      const isFetchFailure = isRetryableExtractionError(err.message) || /\b403\b|forbidden/i.test(String(err.message));
      if (isFetchFailure) {
        logger.warn(
          { sessionKey, err: err.message },
          `ytstream: HLS session failed to start; retrying with player_client=${RETRY_PLAYER_CLIENT}`
        );
        destroyHlsSession(session, 'retry');
        const retrySession = await createHlsSessionInternal(sessionKey, params, RETRY_PLAYER_CLIENT);
        hlsSessions.set(sessionKey, retrySession);
        await waitForHlsSessionReady(retrySession, HLS_READY_TIMEOUT_MS);
        return retrySession;
      }

      // Nothing has reached a client yet - if this attempt used a
      // hardware encoder, retry once in software before giving up.
      // A broken/missing QSV/VAAPI/NVENC/AMF device otherwise
      // hard-failed every mode=hls request instead of falling back.
      const hw = normalizeHardwareMode(params.hardwareMode);
      if (hw !== 'none') {
        logger.warn(
          { sessionKey, hardwareMode: hw, err: err.message },
          'ytstream: HLS session failed to start with hardware encoder; retrying with hardwareMode=none (software libx264)'
        );
        destroyHlsSession(session, 'hw-fallback-retry');
        const softwareParams = { ...params, hardwareMode: 'none' };
        const retrySession = await createHlsSessionInternal(sessionKey, softwareParams, undefined);
        hlsSessions.set(sessionKey, retrySession);
        await waitForHlsSessionReady(retrySession, HLS_READY_TIMEOUT_MS);
        return retrySession;
      }

      destroyHlsSession(session, 'ready-failed');
      throw err;
    }
  })();

  hlsSessionCreationPromises.set(sessionKey, creationPromise);
  try {
    return await creationPromise;
  } finally {
    hlsSessionCreationPromises.delete(sessionKey);
  }
}

/**
 * Probe-shortcut fast path (see probeShortcut.js's tryServeInstantHlsPlaylist):
 * reuse an existing session for this key immediately in ANY state (even
 * 'starting' - unlike getOrCreateHlsSession, which would block here), or
 * create a fresh one and return as soon as its playlist.m3u8 is written,
 * WITHOUT waiting for waitForHlsSessionReady (a real segment to exist on
 * disk). Safe because calculatedLength - forced on for every HLS session,
 * see createHlsSessionInternal - writes the complete VOD playlist
 * synchronously from just the video's known duration, before ffmpeg is even
 * spawned, so the playlist is already correct and complete the moment this
 * returns.
 *
 * Deliberately skips getOrCreateHlsSession's retry-on-failure logic
 * (403/extraction-error player-client retry, hardware-encoder fallback):
 * this serves a metadata probe, not real playback, so a failed encode
 * attempt just leaves the session in 'failed' state here - the next real
 * playback request through getOrCreateHlsSession destroys it and retries
 * properly. Can still join (and therefore block on) an in-flight
 * getOrCreateHlsSession creation promise for the same sessionKey in the
 * rare case both race for the same not-yet-existing session - acceptable
 * since that only affects an already-contended key.
 */
async function getOrCreateHlsSessionForProbe(sessionKey, params) {
  const existing = hlsSessions.get(sessionKey);
  if (existing) {
    if (existing.state !== 'failed') {
      existing.lastAccess = Date.now();
      streamDebug(
        { sessionKey, youtubeId: params.youtubeId, existingState: existing.state, existingViaProbe: !!existing.viaProbe },
        'ytstream: getOrCreateHlsSessionForProbe reusing an existing session (not creating a second one)'
      );
      return existing;
    }
    destroyHlsSession(existing, 'stale-failed');
  }

  const inFlight = hlsSessionCreationPromises.get(sessionKey);
  if (inFlight) {
    streamDebug(
      { sessionKey, youtubeId: params.youtubeId },
      'ytstream: getOrCreateHlsSessionForProbe joining an in-flight real-path session creation for this exact key'
    );
    return inFlight;
  }

  streamDebug(
    { sessionKey, youtubeId: params.youtubeId, mode: params.bufferEnabled ? 'hls-buffer' : 'hls', quality: params.quality, transcode: params.transcode },
    'ytstream: getOrCreateHlsSessionForProbe creating a fresh session'
  );
  const session = await createHlsSessionInternal(sessionKey, { ...params, viaProbe: true }, undefined);
  hlsSessions.set(sessionKey, session);
  return session;
}

/** True if any non-destroying HLS session currently exists for this video. */
function hasActiveHlsSessionForVideo(youtubeId) {
  return [...hlsSessions.values()].some((s) => s.youtubeId === youtubeId && !s.destroying);
}

/** True if a session already exists (any state) for this exact sessionKey. */
function isHlsSessionActive(sessionKey) {
  return hlsSessions.has(sessionKey);
}

/**
 * Builds the Express handler for the HLS asset-serving route
 * (`GET /api/ytstream/:youtubeId/hls/:sessionKey/:filename`). Serves an
 * HLS session's playlist/init/segment files as ordinary static files — no
 * live-pipe/estimation concerns at all, since by the time a URL for one of
 * these exists in a playlist, ffmpeg has already finished writing it to
 * disk. Segments are immutable once written, so they're cacheable
 * indefinitely; the playlist itself isn't (it keeps growing while the
 * session is active).
 * @param {{ resolveClientIp: (req: import('express').Request) => string }} deps
 */
function createHlsAssetRouteHandler({ resolveClientIp }) {
  return async function handleHlsAssetRequest(req, res) {
    const { sessionKey, filename } = req.params;
    if (!/^[a-f0-9]{20}$/.test(sessionKey)) {
      return res.status(400).send('Invalid session key');
    }
    if (!/^(playlist\.m3u8|init\.mp4|segment\d{5}\.(ts|m4s))$/.test(filename)) {
      return res.status(400).send('Invalid filename');
    }
    const session = hlsSessions.get(sessionKey);
    if (!session) {
      logger.warn({ sessionKey, filename }, 'ytstream: HLS asset requested for unknown/expired session');
      return res.status(404).send('HLS session not found or expired');
    }
    session.lastAccess = Date.now();

    const filePath = path.join(session.dir, filename);

    // ytstream.hotSwapToCache: check (throttled) whether STRM cache-on-play
    // has finished downloading this video since the session started, and if
    // so switch the encode source to it. Before the calculatedLength/existence
    // check below so a segment produced by the pass we just killed is
    // correctly treated as "not there yet, wait for the new pass" rather
    // than served stale or 404ed immediately.
    let justHotSwapped = false;
    if (session.hotSwapToCache && !session.usingCachedSource) {
      justHotSwapped = await maybeHotSwapToCache(session);
    }

    // calculatedLength: the playlist declares every segment upfront, but only a
    // forward-encoding window of them exists on disk at any moment. A
    // request for one that isn't there yet is a seek — produce it on
    // demand rather than 404ing outright.
    if (session.calculatedLength) {
      const segmentMatch = filename.match(/^segment(\d{5})\.\w+$/);
      if (segmentMatch) {
        const targetIndex = Number(segmentMatch[1]);
        const available = await ensureHlsSegmentAvailable(session, targetIndex, filePath);
        if (!available) {
          logger.warn({ sessionKey, filename, targetIndex }, 'ytstream: calculatedLength HLS segment never became available after seek restart');
          return res.status(404).send('Segment not found');
        }
      }
    } else if (justHotSwapped && !fs.existsSync(filePath)) {
      // Non-calculatedLength hot-swap: the pass producing this exact segment was
      // just killed and restarted from the cached file. Give the new pass a
      // brief window to reach it before giving up — mirrors calculatedLength's
      // grace window above, but without a restart loop since we already
      // just triggered one.
      const deadline = Date.now() + HLS_SEEK_GRACE_MS;
      let available = fs.existsSync(filePath);
      while (!available && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, HLS_READY_POLL_INTERVAL_MS));
        available = fs.existsSync(filePath);
      }
      if (!available) {
        logger.warn({ sessionKey, filename }, 'ytstream: HLS segment not available shortly after cache hot-swap');
        return res.status(404).send('Segment not found');
      }
    }

    // The real encode pass's fMP4 init segment (`init.mp4`) is written
    // once, early in its run - but with instant-start, the session can
    // report "ready" (and the playlist gets served) the moment the
    // PLACEHOLDER exists, well before the real pass has produced its own
    // init.mp4. This filename never matches the `segment#####.ext` pattern
    // the calculatedLength wait above looks for, so without this it 404s
    // immediately on a miss - a client with no retry backoff of its own
    // (e.g. Moonfin/AVPlayer) can flood the log with failed requests every
    // few milliseconds until the encode catches up.
    //
    // Existence alone isn't enough, unlike numbered segments: those are
    // protected by ffmpeg's `-hls_flags temp_file`, which writes each one
    // to a temp path and atomically renames it into place only once
    // complete - that protection does NOT extend to `-hls_fmp4_init_filename`,
    // which ffmpeg writes directly. Polling fs.existsSync alone can catch
    // it the instant it's created (open/truncate) but before its content is
    // flushed, handing the client a 0-byte init segment that breaks fMP4
    // parsing client-side. Waiting for the size to be non-zero AND
    // unchanged across one full poll interval confirms the write has
    // actually finished.
    if (filename === 'init.mp4') {
      const deadline = Date.now() + HLS_READY_TIMEOUT_MS;
      let lastSize = -1;
      for (;;) {
        let size = -1;
        try { size = fs.statSync(filePath).size; } catch { /* not created yet */ }
        if (size > 0 && size === lastSize) break;
        if (size > 0) lastSize = size;
        if (session.destroying || Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, HLS_READY_POLL_INTERVAL_MS));
      }
    }

    fs.stat(filePath, (statErr, stat) => {
      if (statErr) {
        logger.warn({ sessionKey, filename, err: statErr.message }, 'ytstream: HLS asset not found on disk');
        return res.status(404).send('Segment not found');
      }
      // debug: by far the highest-volume line in this file - one per
      // segment/init/playlist fetch, so once per ~HLS_SEGMENT_DURATION_SECONDS
      // for the entire length of every video played. 'ytstream: seek past
      // encoded HLS segments...' and 'spawning HLS encode pass' (both still
      // info) already cover every state change worth seeing by default.
      //
      // expectedStartSeconds/mtimeMs/passGenerationAtServe are here
      // specifically to trace a declared-position-vs-actual-content
      // mismatch (a segment whose playlist position doesn't match what's
      // really inside it) - if a segment's mtime is suspiciously LATER than
      // a higher-numbered segment's, or passGenerationAtServe doesn't match
      // whichever pass "should" have produced it, that's the smoking gun.
      // Not proven to explain any specific incident yet - added purely to
      // trace one live if it recurs.
      {
        const segmentIndexMatch = filename.match(/^segment(\d{5})\.\w+$/);
        const segmentIndex = segmentIndexMatch ? Number(segmentIndexMatch[1]) : null;
        streamDebug(
          {
            sessionKey,
            filename,
            size: stat.size,
            range: req.headers.range || null,
            mtimeMs: stat.mtimeMs,
            expectedStartSeconds: segmentIndex !== null ? segmentIndex * session.segmentDurationSeconds : null,
            passGenerationAtServe: session.passGeneration,
            activePassStartIndex: session.activePassStartIndex,
            usingCachedSource: session.usingCachedSource === true,
          },
          'ytstream: serving HLS asset'
        );
        // Catches a CLIENT-driven forward jump that a restart-triggered
        // seek wouldn't: restartHlsEncodePassAtSegment only fires when a
        // requested segment is past what's been encoded so far, but the
        // live encode pass isn't paced to real-time (no -re) - it can race
        // dozens of segments ahead of any real playback position within
        // seconds, same as the hls-buffer fetch does. A player jumping
        // (seek, or hls.js's own gap-jump) to an already-produced segment
        // is therefore invisible to the restart path and its logging
        // entirely - this is the only place left that can flag it, by
        // comparing consecutive REQUESTS within one session regardless of
        // whether a restart happened. See [[ytstream_raw_buffer_and_segment_bug]].
        // Debug, not warn - jumping straight to an already-encoded segment
        // (an instant local seek, e.g. into buffered/cached content) is the
        // whole point of instant-start/hot-swap/backfill working correctly,
        // not a problem to flag.
        if (segmentIndex !== null) {
          const lastIndex = session.lastServedSegmentIndex;
          if (typeof lastIndex === 'number' && segmentIndex !== lastIndex + 1) {
            streamDebug(
              {
                sessionKey,
                youtubeId: session.youtubeId,
                fromSegmentIndex: lastIndex,
                toSegmentIndex: segmentIndex,
                gap: segmentIndex - lastIndex,
                passGenerationAtServe: session.passGeneration,
                usingCachedSource: session.usingCachedSource === true,
              },
              'ytstream: non-contiguous segment request within one session (client jumped forward/backward without a restart)'
            );
          }
          session.lastServedSegmentIndex = segmentIndex;
        }
      }

      // Streaming-page byte counter - bytes are added per chunk as the file
      // is actually read for the response (see the pipe below), not stat.size
      // up front: a player aborting a segment fetch part way would otherwise
      // still be charged the whole segment.
      const streamEntry = getActiveStream(sessionKey);
      if (streamEntry) {
        streamEntry.lastActivityAt = Date.now();
        streamEntry.state = 'active';
        if (streamEntry.viewers) {
          streamEntry.viewers.set(resolveClientIp(req), { userAgent: req.headers['user-agent'] || null, lastSeen: Date.now() });
        }
      }

      let contentType = 'application/octet-stream';
      if (filename.endsWith('.m3u8')) contentType = 'application/vnd.apple.mpegurl';
      else if (filename.endsWith('.ts')) contentType = 'video/mp2t';
      else if (filename.endsWith('.mp4') || filename.endsWith('.m4s')) contentType = 'video/mp4';

      res.set({
        'Content-Type': contentType,
        'Content-Length': String(stat.size),
        'Cache-Control': filename.endsWith('.m3u8') ? 'no-store' : 'public, max-age=31536000, immutable',
      });

      const fileStream = fs.createReadStream(filePath);
      fileStream.on('error', (err) => {
        logger.warn({ err, filePath }, 'ytstream: error reading HLS asset');
        if (!res.headersSent) {
          res.status(500).end();
        } else {
          res.end();
        }
      });
      const countBytes = createBytesCounter(streamEntry);
      fileStream.on('data', (chunk) => countBytes(chunk.length));
      res.on('close', () => fileStream.destroy());
      fileStream.pipe(res);
    });
  };
}

module.exports = {
  init,
  buildHlsSessionKey,
  rewriteHlsPlaylistUrls,
  getOrCreateHlsSession,
  getOrCreateHlsSessionForProbe,
  hasActiveHlsSessionForVideo,
  isHlsSessionActive,
  createHlsAssetRouteHandler,
  // Exported for unit testing only (the hls-buffer finalize/teardown race
  // fix - see each function's own doc comment) - not part of the public
  // route-facing API surface.
  maybeCleanupBufferDir,
  createBufferFinalizeHandoff,
};
