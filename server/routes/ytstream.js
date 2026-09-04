/**
 * server/routes/ytstream.js
 *
 * YouTube playback endpoint used by `.strm` sidecar files (see strmGenerator.js).
 * Modeled on jellyfin-youtube-plugin's two modes: "Simple" (direct upstream URL,
 * no ffmpeg) and "Enhanced" (re-stream through local ffmpeg, falling back to
 * Simple on failure). Format selectors mirror YtDlpService.cs; hardware encoding
 * modes mirror ManagedTranscodeService.AddVideoEncoderArguments. Unlike the
 * plugin, reuses Youtarr's own cookie/proxy/IP-family/rate-limit conventions,
 * so age-restricted and members-only content works here too.
 *
 * Routes:
 *   GET /api/ytstream/:youtubeId            -> resolve + play (mode=direct|direct-pipe|ffmpeg|hls)
 *   GET /api/ytstream/history               -> paginated stream-history audit trail
 *   DELETE /api/ytstream/history            -> delete stream-history entries by streamId
 *   GET /api/ytstream/:youtubeId/formats     -> debug: list yt-dlp formats (auth required)
 *   GET /api/ytstream/:youtubeId/simulate    -> debug: dry-run the playback decision, no real playback (auth required)
 */

const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { Transform } = require('stream');
const { spawn, spawnSync } = require('child_process');
const logger = require('../logger');
const configModule = require('../modules/configModule');
const ytDlpRunner = require('../modules/ytDlpRunner');
const YtdlpCommandBuilder = require('../modules/download/ytdlpCommandBuilder');
const messageEmitter = require('../modules/messageEmitter');
const streamEncoderTuning = require('../modules/streamEncoderTuning');

const UPSTREAM_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Parse a Netscape cookie file into a Cookie header value for YouTube/
 * googlevideo requests. yt-dlp -g URLs often 403 in ffmpeg without the
 * same session cookies attached.
 * @param {string|null} cookiePath
 * @returns {string} e.g. "SID=...; HSID=..." or ""
 */
function loadYoutubeCookieHeader(cookiePath) {
  logger.debug({ cookiePath }, 'ytstream: loading cookie file for ffmpeg headers');
  if (!cookiePath) return '';
  try {
    if (!fs.existsSync(cookiePath)) return '';
    const lines = fs.readFileSync(cookiePath, 'utf8').split(/\r?\n/);
    const pairs = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      // Netscape: domain \t flag \t path \t secure \t expiry \t name \t value
      const parts = trimmed.split('\t');
      if (parts.length < 7) continue;
      const domain = parts[0].replace(/^\./, '').toLowerCase();
      if (
        !domain.includes('youtube.com') &&
        !domain.includes('google.com') &&
        !domain.includes('googlevideo.com') &&
        !domain.includes('youtu.be')
      ) {
        continue;
      }
      const name = parts[5];
      const value = parts[6];
      if (name) pairs.push(`${name}=${value}`);
    }
    return pairs.join('; ');
  } catch (err) {
    logger.warn({ err }, 'ytstream: failed to read cookie file for ffmpeg headers');
    return '';
  }
}

const VALID_MODES = ['direct', 'direct-pipe', 'direct-redirect', 'ffmpeg', 'hls', 'hls-buffer', 'raw-buffer'];
// mkv is ffmpeg-mode only; HLS segments must be fmp4/mpegts, so
// getHlsContainerInfo falls through to its fmp4 default for 'mkv' too.
const VALID_CONTAINERS = ['mp4', 'ts', 'mkv'];
const VALID_TRANSCODE = ['copy', 'h264'];

/** Matches ManagedTranscodeHardwareModes in the reference plugin. */
const { normalizeHardwareMode, normalizeTuning, buildVideoEncoderArgs } = streamEncoderTuning;

/**
 * Default yt-dlp player-client selection. The bare "tv" client frequently
 * returns YouTube's generic "The page needs to be reloaded." error once a
 * session/PO-token check fails, even when other clients would work; `-tv`
 * drops just that client while keeping normal multi-client fallback.
 */
const DEFAULT_PLAYER_CLIENT = 'default,-tv';

/**
 * Fallback client used for the single automatic retry when the first
 * attempt fails with a signature matching a client/session rejection.
 * "android" doesn't require the web session tokens that trip up "tv".
 */
const RETRY_PLAYER_CLIENT = 'android';

/**
 * Matches yt-dlp/YouTube errors that are usually fixed by switching
 * player client rather than being a real "video unavailable" — safe to
 * retry once with a different client.
 */
const RETRYABLE_ERROR_PATTERN =
  /page needs to be reloaded|sign in to confirm|not a bot|failed to extract any player response|unable to extract .*player/i;

function isRetryableExtractionError(message = '') {
  return RETRYABLE_ERROR_PATTERN.test(String(message));
}

// Active child processes for Enhanced mode (the video/audio yt-dlp feeders
// and the ffmpeg muxer on pipe:3/pipe:4), tracked so they're killed
// together on client disconnect and process exit.
const activeChildProcesses = new Set();

function registerChildProcess(proc) {
  activeChildProcesses.add(proc);
  const forget = () => activeChildProcesses.delete(proc);
  proc.once('exit', forget);
  proc.once('error', forget);
}

function killChildProcess(proc, reason) {
  if (!proc || proc.killed || proc.exitCode !== null) return false;
  try {
    logger.info({ pid: proc.pid, reason }, 'ytstream: killing child process');
    // Prefer SIGTERM so ffmpeg can release hardware encoder contexts (QSV/NVENC)
    proc.kill('SIGTERM');
    const forceTimer = setTimeout(() => {
      if (!proc.killed && proc.exitCode === null) {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }, 3000);
    // Don't keep the event loop alive solely for the force-kill timer
    if (typeof forceTimer.unref === 'function') forceTimer.unref();
    return true;
  } catch (err) {
    logger.warn({ err, pid: proc.pid }, 'ytstream: failed to kill child process');
    return false;
  }
}

function killAllChildProcesses(reason) {
  for (const proc of [...activeChildProcesses]) {
    killChildProcess(proc, reason);
  }
}

// hlsSessions is declared further below (with the other HLS constants).
function destroyHlsSession(session, reason) {
  hlsSessions.delete(session.key);
  // Checked by createHlsSessionInternal's process-exit handlers so a
  // deliberate teardown isn't logged as an unexpected crash.
  session.destroying = true;
  // This session may have been the one thing blocking trySafeDeleteFinalizedTs
  // (see maybeFinalizeTsToMp4) from reclaiming its cachedFilePath's .ts - now
  // that it's gone (removed from hlsSessions just above), retry: a no-op
  // unless finalizeToMp4 already produced a .mp4 for this exact file AND no
  // OTHER live session still references it.
  if (session.cachedFilePath && path.extname(session.cachedFilePath).toLowerCase() === '.ts'
    && (configModule.getConfig().ytstream || {}).finalizeToMp4 === true) {
    const mp4Path = require('../modules/tsRemuxCache').findExistingSeekableMp4(session.cachedFilePath);
    if (mp4Path) {
      trySafeDeleteFinalizedTs(session.cachedFilePath, { youtubeId: session.youtubeId, sourceLabel: 'session-teardown' });
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
  }, 3500);
  // Single choke-point for every HLS teardown path (idle reap, retry,
  // ready-failed, manual stop), so untracking is uniform. session.error
  // (set by spawnHlsEncodePass's markFailed) carries the failure text for
  // the 'ready-failed' case.
  untrackStream(session.key, reason, session.error || null);
}

/**
 * Streaming-page stream tracking — surfaces active mode=ffmpeg/mode=hls playback
 * (byte counters, client info, start/stop) via GET /api/ytstream/streams and
 * POST /api/ytstream/streams/:id/stop, broadcast over the same WebSocket
 * mechanism as download-job progress (messageEmitter.js). mode=direct is
 * stateless and excluded. Identity: an HLS "stream" is one shared encode
 * session (keyed by hlsSessions key); an ffmpeg "stream" is one HTTP request —
 * streamViaFfmpeg can retry before any byte reaches the client, so its
 * streamId is created once per request and threaded through every retry.
 */
const activeStreams = new Map(); // streamId -> entry
let statsTickTimer = null;
const STREAM_STATS_TICK_MS = 1500;
// HLS segments land as one instant whole-file burst per player request, not
// a steady trickle - a naive "since the last tick" rate would read 0 between
// bursts then spike on the tick that catches one, looking stalled even when
// healthy. This longer rolling window smooths bursts into a sustained rate.
const STREAM_THROUGHPUT_WINDOW_MS = 10000;
// Internal HLS session churn, not a real stream ending — suppresses the
// streamStopped broadcast.
const SILENT_UNTRACK_REASONS = new Set(['retry', 'stale-failed']);

// Set once by createYtStreamRoutes (server startup) so trackStream/untrackStream
// (module-level, defined before the factory receives `models`) can persist to
// StreamHistory without threading `models` through every call site. Stays
// null (persistence skipped) for any test harness bypassing the real factory.
let ytstreamModels = null;

// Stream History: persisted audit trail for ytstream playback sessions,
// backed by the `stream_history` table. Best-effort — failures are caught
// and logged, never allowed to affect the actual stream. Keyed by
// `stream_id` (upsert on start) so a silent HLS retry re-tracking the same
// streamId refreshes the row instead of erroring on the unique constraint.
async function persistStreamHistoryStart(entry) {
  if (!ytstreamModels || !ytstreamModels.StreamHistory) return;
  try {
    await ytstreamModels.StreamHistory.upsert({
      stream_id: entry.streamId,
      youtube_id: entry.youtubeId,
      mode: entry.mode,
      quality: entry.quality || null,
      container: entry.container || null,
      transcode: entry.transcode || null,
      hardware_mode: entry.hardwareMode || null,
      client_ip: entry.clientIp || null,
      user_agent: entry.userAgent || null,
      started_at: new Date(entry.startedAt),
      ended_at: null,
      bytes_transferred: 0,
      end_reason: null,
      error_message: null,
    });
  } catch (err) {
    logger.warn({ err, streamId: entry.streamId }, 'ytstream: failed to persist stream-history start row');
  }
}

async function persistStreamHistoryEnd(entry, reason, errorMessage) {
  if (!ytstreamModels || !ytstreamModels.StreamHistory) return;
  try {
    await ytstreamModels.StreamHistory.update(
      {
        ended_at: new Date(),
        bytes_transferred: entry.bytesTransferred || 0,
        end_reason: reason,
        error_message: errorMessage || null,
      },
      { where: { stream_id: entry.streamId } }
    );
  } catch (err) {
    logger.warn({ err, streamId: entry.streamId }, 'ytstream: failed to persist stream-history end row');
  }
}

// Only hls/hls-buffer produce discrete numbered segment files on disk at
// all (mode=ffmpeg is one continuous live pipe, direct* modes never touch
// ffmpeg, raw-buffer has a growing .ts remux but no segment/playlist
// concept) - snapshotStream below only computes/attaches this for those
// two, so streamProgress's periodic broadcast never does the readdir for
// a mode where it's meaningless.
const SEGMENT_STATUS_MODES = new Set(['hls', 'hls-buffer']);

/**
 * Per-segment on-disk status for the Streaming page's live segment-activity
 * grid. `encoded[i]` mirrors ensureHlsSegmentAvailable's fs.existsSync check
 * (one readdir per call instead of N stats). `bufferedThroughIndex` is a
 * separate, coarser signal: how far the independent hls-buffer raw fetch has
 * reached, converted to a segment index — a segment can be buffered without
 * being `encoded` yet (bytes present but not yet transcoded), so a seek into
 * that range is still fast (local -ss) even though the dot isn't green.
 */
function computeSegmentStatus(session) {
  if (!session || !session.totalSegments || !session.dir) return null;
  let files;
  try {
    files = fs.readdirSync(session.dir);
  } catch {
    return null;
  }
  const encoded = new Array(session.totalSegments).fill(false);
  let highestEncodedIndex = -1;
  for (const filename of files) {
    const match = filename.match(/^segment(\d{5})\.\w+$/);
    if (!match) continue;
    const index = Number(match[1]);
    if (index >= 0 && index < encoded.length) {
      encoded[index] = true;
      if (index > highestEncodedIndex) highestEncodedIndex = index;
    }
  }

  // session.totalSegments is only ever an ESTIMATE (yt-dlp's reported
  // duration, divided into fixed-length segments) - the real encode can
  // legitimately produce fewer segments than that if the estimate rounded
  // up or slightly overshot the actual encodable content. Once the encode
  // pass has genuinely finished (see encodeEnded above) and nothing is
  // still running that could add more, report the true final count instead
  // of the original estimate - otherwise the trailing slots the estimate
  // over-reserved would show as permanently "not yet available" even
  // though the stream played to completion with no seek ever involved.
  const totalSegments =
    session.encodeEnded && highestEncodedIndex >= 0 && highestEncodedIndex + 1 < session.totalSegments
      ? highestEncodedIndex + 1
      : session.totalSegments;
  const encodedForDisplay = totalSegments === encoded.length ? encoded : encoded.slice(0, totalSegments);

  const bufferedThroughIndex = session.bufferEnabled
    ? Math.min(totalSegments, Math.max(0, Math.floor((session.bufferedSeconds || 0) / HLS_SEGMENT_DURATION_SECONDS)))
    : 0;
  return {
    totalSegments,
    segmentDurationSeconds: HLS_SEGMENT_DURATION_SECONDS,
    encoded: encodedForDisplay,
    bufferedThroughIndex,
    bufferComplete: session.bufferFetchDone === true,
    // Set by the segment-serving route (see session.lastServedSegmentIndex)
    // every time the player actually fetches a .ts/.m4s segment - the
    // Streaming page's segment grid uses this to highlight which segment is
    // currently being delivered, not just which ones are encoded on disk.
    currentSegmentIndex: typeof session.lastServedSegmentIndex === 'number' ? session.lastServedSegmentIndex : null,
    // Only meaningful while session.backfillInProgress is true (see
    // maybeBackfillMissingSegments) - the next segment the backfill pass is
    // about to (re)produce, i.e. one past whatever it's already written.
    // Distinct from currentSegmentIndex above: backfill runs against a
    // local source in the background and never affects what's actually
    // being delivered to the viewer.
    backfillSegmentIndex: session.backfillInProgress ? highestEncodedIndex + 1 : null,
  };
}

function snapshotStream(entry) {
  const hlsSession = SEGMENT_STATUS_MODES.has(entry.mode) ? hlsSessions.get(entry.streamId) : null;
  return {
    streamId: entry.streamId,
    mode: entry.mode,
    youtubeId: entry.youtubeId,
    quality: entry.quality,
    container: entry.container,
    transcode: entry.transcode,
    hardwareMode: entry.hardwareMode,
    tuning: entry.tuning,
    clientIp: entry.clientIp,
    userAgent: entry.userAgent,
    viewerCount: entry.viewers ? entry.viewers.size : undefined,
    state: entry.state,
    startedAt: entry.startedAt,
    bytesTransferred: entry.bytesTransferred,
    bytesPerSecond: entry.bytesPerSecond,
    lastActivityAt: entry.lastActivityAt,
    segments: hlsSession ? computeSegmentStatus(hlsSession) : null,
  };
}

function tickStreamStats() {
  if (activeStreams.size === 0) {
    if (statsTickTimer) {
      clearInterval(statsTickTimer);
      statsTickTimer = null;
    }
    return;
  }
  const now = Date.now();
  const snapshots = [];
  for (const entry of activeStreams.values()) {
    if (!entry.history) entry.history = [];
    entry.history.push({ t: now, bytes: entry.bytesTransferred });
    // Keep one sample at/before the window edge as the rate calc's start
    // point, not just samples strictly inside it - otherwise the window
    // shrinks to nothing right after a burst, recreating the spike-then-zero
    // pattern this window exists to smooth out.
    while (entry.history.length > 2 && now - entry.history[1].t >= STREAM_THROUGHPUT_WINDOW_MS) {
      entry.history.shift();
    }
    const oldest = entry.history[0];
    const deltaBytes = entry.bytesTransferred - oldest.bytes;
    const deltaMs = now - oldest.t;
    entry.bytesPerSecond = deltaMs > 0 ? deltaBytes / (deltaMs / 1000) : 0;
    snapshots.push(snapshotStream(entry));
  }
  messageEmitter.emitMessage('broadcast', null, 'server', 'streamProgress', { streams: snapshots });
}

function ensureStatsTicker() {
  if (statsTickTimer) return;
  statsTickTimer = setInterval(tickStreamStats, STREAM_STATS_TICK_MS);
  if (typeof statsTickTimer.unref === 'function') statsTickTimer.unref();
}

function trackStream(entry) {
  activeStreams.set(entry.streamId, entry);
  messageEmitter.emitMessage('broadcast', null, 'server', 'streamStarted', snapshotStream(entry));
  ensureStatsTicker();
  persistStreamHistoryStart(entry);
}

function untrackStream(streamId, reason, errorMessage) {
  const entry = activeStreams.get(streamId);
  if (!entry) {
    logger.debug({ streamId, reason }, 'ytstream: untrackStream called for a streamId not in activeStreams - no-op (already removed, or never tracked)');
    return;
  }
  activeStreams.delete(streamId);
  logger.debug({ streamId, reason, remainingActiveStreams: activeStreams.size }, 'ytstream: untrackStream removed entry from activeStreams');
  if (!SILENT_UNTRACK_REASONS.has(reason)) {
    messageEmitter.emitMessage('broadcast', null, 'server', 'streamStopped', {
      streamId,
      mode: entry.mode,
      youtubeId: entry.youtubeId,
      reason,
    });
    persistStreamHistoryEnd(entry, reason, errorMessage);
  }
  if (activeStreams.size === 0 && statsTickTimer) {
    clearInterval(statsTickTimer);
    statsTickTimer = null;
  }
}

// Once-only idle-session reaper — mirrors ManagedTranscodeService.cs's
// idle-session cleanup in the reference plugin. unref()'d so the interval
// itself never keeps the Node process alive.
let hlsReaperInstalled = false;
function ensureHlsIdleReaper() {
  if (hlsReaperInstalled) return;
  hlsReaperInstalled = true;
  const timer = setInterval(() => {
    const now = Date.now();
    for (const session of [...hlsSessions.values()]) {
      if (now - session.lastAccess > HLS_IDLE_TIMEOUT_MS) {
        // A backfillMissingSegments pass runs entirely after playback has
        // gone idle by design - reaping the session (and deleting its
        // directory 3.5s later - see destroyHlsSession) out from under that
        // still-running ffmpeg would kill it mid-write and throw away the
        // work. Left alone for one more sweep interval; once that pass
        // either finishes or gets superseded, spawnHlsEncodePass/the clean-
        // finish handler always clears this flag (see their own comments),
        // so this can never wedge a session here permanently.
        if (session.backfillInProgress) {
          logger.debug({ sessionKey: session.key }, 'ytstream: idle HLS session has a backfill pass in progress; deferring reap');
          continue;
        }
        logger.info({ sessionKey: session.key }, 'ytstream: reaping idle HLS session');
        destroyHlsSession(session, 'idle-timeout');
      }
    }
  }, HLS_IDLE_SWEEP_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

// Once-only process-level cleanup so a Node shutdown does not leave orphaned yt-dlp/ffmpeg.
let processHandlersInstalled = false;
function ensureProcessExitHandlers() {
  if (processHandlersInstalled) return;
  processHandlersInstalled = true;
  const onExit = (signal) => {
    killAllChildProcesses(signal || 'process-exit');
    for (const session of [...hlsSessions.values()]) {
      try { fs.rmSync(session.dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  };
  process.once('exit', () => onExit('exit'));
  process.once('SIGTERM', () => onExit('SIGTERM'));
  process.once('SIGINT', () => onExit('SIGINT'));
}


/**
 * Format selectors from jellyfin-youtube-plugin YtDlpService.cs.
 */
const FORMAT_SELECTORS = {
  BroadCompatibility720p:
    'b[protocol!*=m3u8][ext=mp4][height=720]/b[protocol!*=m3u8][ext=mp4][height<=720]/b[height=720]/b[height<=720]',
  Balanced1080p:
    'b[height=1080]/b[height=720]/b[height<=1080]/b[height<=720]/b',
  MaximumQuality: 'b',
};

// Only ever holds `true` (once confirmed, ffmpeg isn't going to vanish from
// PATH mid-run) - a `false`/not-yet-determined result is deliberately NEVER
// cached, unlike almost every other cache in this file. Confirmed live
// 2026-09-02: a container that had just started could hit this check before
// ffmpeg was actually resolvable on PATH yet (an entrypoint/PATH-setup race
// at boot), and caching that transient `false` for the rest of the process's
// life meant every request for the container's entire uptime kept getting
// the "ffmpeg unavailable" fallback - the only way out was a full restart to
// get a fresh process (and a fresh roll of the same race, hopefully won this
// time). Re-checking on every call this returns false for is deliberately
// cheap insurance against that: `spawnSync('ffmpeg', ['-version'])` is a few
// ms, trivial next to the actual streaming work a false positive here breaks.
let ffmpegAvailableCache = null;

function isFfmpegAvailable() {
  if (ffmpegAvailableCache === true) return true;
  let available;
  try {
    const result = spawnSync('ffmpeg', ['-version'], { timeout: 5000 });
    available = !result.error && result.status === 0;
  } catch {
    available = false;
  }
  if (available) {
    ffmpegAvailableCache = true;
  } else {
    logger.warn(
      'ffmpeg was not found on PATH. YouTube ffmpeg-enhanced streaming ' +
        '(mode=ffmpeg) will automatically fall back to direct mode. ' +
        'See docs/YTSTREAM.md for install instructions.'
    );
  }
  return available;
}

/**
 * `strictness` ('fixed' | 'fallback' | 'best', see ytstream.qualityStrictness)
 * controls how the configured height gets turned into a selector:
 * 'best' always ignores it (bare 'b', whatever's actually best-available -
 * for direct mode that's the itag-18-only progressive ceiling); 'fixed'
 * matches only that exact height, no fallback clauses, so yt-dlp fails
 * cleanly (a real "requested format not available") rather than silently
 * substituting a different one; 'fallback' (default, matches this
 * function's long-standing behavior) chains from the exact height down to
 * best-available.
 */
function getDirectFormatSelector(quality, strictness = 'fallback') {
  if (strictness === 'best') return FORMAT_SELECTORS.MaximumQuality;

  const height = resolveQualityHeight(quality);
  if (!height) return FORMAT_SELECTORS.MaximumQuality; // quality itself was best/max/maximum

  if (strictness === 'fixed') {
    return `b[height=${height}]`;
  }

  if (height === 720) return FORMAT_SELECTORS.BroadCompatibility720p;
  if (height === 1080) return FORMAT_SELECTORS.Balanced1080p;
  return (
    `b[protocol!*=m3u8][ext=mp4][height=${height}]/` +
    `b[protocol!*=m3u8][ext=mp4][height<=${height}]/` +
    `b[height=${height}]/` +
    `b[height<=${height}]/` +
    'b'
  );
}

/**
 * Height cap for `mode=ffmpeg`'s DASH (video-only + audio-only) fetch.
 * Unlike `getDirectFormatSelector`, this doesn't need named-preset exact
 * strings — just the height ceiling — since resolution isn't limited to
 * whatever YouTube happens to serve progressively (see
 * getDashFormatSelectors below). Returns null for "no cap" (best).
 */
function resolveQualityHeight(quality) {
  const q = String(quality || '720').toLowerCase().trim();
  if (q === 'best' || q === 'max' || q === 'maximum') return null;
  if (q === '720' || q === 'broad' || q === 'compat') return 720;
  if (q === '1080' || q === 'balanced') return 1080;
  const height = Number.parseInt(q, 10);
  return Number.isFinite(height) && height > 0 ? height : 720;
}

/**
 * Video-only + audio-only selectors for `mode=ffmpeg`'s two-pipe pipeline
 * (see streamViaFfmpeg). YouTube only serves progressive (single-file,
 * already-muxed) formats up to 720p — DASH is required for 1080p+, which
 * is why this is a separate selector pair from getDirectFormatSelector.
 */
function getDashFormatSelectors(quality, strictness = 'fallback') {
  const height = resolveQualityHeight(quality);
  let heightFilter = '';
  if (height && strictness !== 'best') {
    heightFilter = strictness === 'fixed' ? `[height=${height}]` : `[height<=${height}]`;
  }
  return {
    videoFormat: `bv*${heightFilter}[vcodec^=avc1]/bv*${heightFilter}`,
    audioFormat: 'ba[acodec^=mp4a]/ba',
  };
}

/**
 * `vcodec` as yt-dlp reports it is a full codec tag (e.g. `avc1.640028`,
 * `vp9`, `av01.0.05M.08`) — only the `avc1`/`h264` prefix means H.264.
 */
function isH264Codec(codec) {
  return /^(avc1|h264)/i.test(String(codec || ''));
}

/**
 * `ytstream.calculatedLength` (opt-in, `mode=ffmpeg` only): reports a synthetic
 * `Content-Length`/`Accept-Ranges` for the transcoded output so players
 * that refuse to treat a chunked, unknown-duration stream as directly
 * playable (Jellyfin's HLS-transcode fallback being the motivating case)
 * see something that looks like an ordinary seekable file. A `Range`
 * request is translated into a `-ss <seconds>` restart of the pipeline
 * at the estimated matching timestamp — see streamViaFfmpeg's
 * `responseShaping` handling for the actual wiring.
 *
 * None of this can be exact: the real encoded size is only known once
 * the transcode finishes, and CRF/VBR encoding means bitrate (and so the
 * byte<->time mapping) isn't constant either. It's a best-effort
 * approximation, not a real seekable file.
 */

const AUDIO_BITRATE_KBPS = 192; // matches the AAC encode target / typical source audio
// Under-estimating the total size truncates real content (the response
// closes before all the promised bytes arrive — broken playback in any
// strict client). Over-estimating just means streamViaFfmpegFakeLength's
// length-capping transform pads the tail with zero bytes once ffmpeg's
// real output ends, which players tolerate fine. So bias deliberately
// high rather than trying to be precise.
const CALCULATED_LENGTH_PADDING_FACTOR = 1.2;

/**
 * @param {number|null} height - from resolveQualityHeight; null ("best") is
 *   treated as the top tier since the actual resolution yt-dlp picks isn't
 *   known ahead of time.
 * @returns {number} estimated encoded bytes/sec, padded high.
 *
 * Uses streamEncoderTuning's lookupResolutionTierKbps (same table the
 * encoder's own -maxrate/-bufsize is derived from — see
 * resolveEncoderBitrateCaps there) so this estimate and the real encoder
 * cap stay in sync off one shared table instead of drifting.
 */
function estimateBitrateBytesPerSecond(height) {
  const totalKbps = streamEncoderTuning.lookupResolutionTierKbps(height) + AUDIO_BITRATE_KBPS;
  return Math.ceil(((totalKbps * 1000) / 8) * CALCULATED_LENGTH_PADDING_FACTOR);
}

/**
 * Truncates/pads a byte stream to exactly `targetLength` bytes so the
 * response body always matches whatever Content-Length/Content-Range was
 * already promised in headers — necessary because the real transcoded
 * size can only be estimated in advance, and closing the response short
 * of a declared Content-Length is what triggers content-length-mismatch
 * errors in strict HTTP clients. Overflow is defensively dropped (should
 * be rare given the deliberately-padded-high estimate); underflow is
 * zero-padded once ffmpeg's real output ends.
 */
function createLengthCappingTransform(targetLength) {
  let written = 0;
  return new Transform({
    transform(chunk, _enc, callback) {
      const remaining = targetLength - written;
      if (remaining <= 0) {
        callback();
        return;
      }
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      written += slice.length;
      callback(null, slice);
    },
    flush(callback) {
      const remaining = targetLength - written;
      callback(null, remaining > 0 ? Buffer.alloc(remaining) : undefined);
    },
  });
}

/**
 * Parses a `Range: bytes=START-END` header against calculatedLength's synthetic
 * total length. Only the common `bytes=N-` / `bytes=N-M` forms (what
 * browsers/Jellyfin actually send for seeking) are handled — anything
 * else (suffix ranges, multi-range) returns `null`, which callers treat
 * as "serve the whole (estimated) body from the start".
 * @returns {null|{invalid: true}|{start: number, end: number}}
 */
function parseByteRange(rangeHeader, totalLength) {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(String(rangeHeader).trim());
  if (!match) return null;
  const start = Number.parseInt(match[1], 10);
  const end = match[2] ? Number.parseInt(match[2], 10) : totalLength - 1;
  if (!Number.isFinite(start) || start < 0 || start >= totalLength || end < start) {
    return { invalid: true };
  }
  return { start, end: Math.min(end, totalLength - 1) };
}

// In-memory cache of video durations for calculatedLength's Content-Length
// estimate. Durations don't change, so entries never expire.
const durationCache = new Map();

/**
 * mode=raw-buffer's own Content-Length estimate cache - see
 * combineRawBufferContentLength's doc comment for why this can't reuse
 * estimateBitrateBytesPerSecond (that table is tuned to Youtarr's OWN
 * encoder output, not a raw `-c copy` source mux). Keyed by
 * `youtubeId|formatSelector`, one entry per individual video+audio
 * component (not the combined total) so a quality change doesn't require
 * re-probing a format this video has already been probed at before.
 */
const rawBufferSizeCache = new Map();

// In-flight dedup for getVideoDurationSeconds's live yt-dlp fallback -
// without it, the instant-start warm-up and the real calculatedLength
// lookup moments later would each spawn their own yt-dlp process for the
// same video for no benefit.
const durationLookupPromises = new Map();

// In-memory cache of resolved video codecs, for transcode=copy's
// auto-upgrade-to-h264 check (resolveVideoCodec). Keyed by
// youtubeId|quality|playerClient since the DASH format yt-dlp selects (and
// so its codec) depends on both. Never expires within a process lifetime.
const codecCache = new Map();

// In-memory cache of each video's true best-available height (what a
// height-uncapped `-f bv*` would select), so resolveEffectiveQualityHeight
// never requests a height above a video's real max. Never expires within a
// process lifetime.
const maxAvailableHeightCache = new Map();

/**
 * `mode=hls`: real segmented HLS output (playlist.m3u8 + segment files) on
 * disk, instead of `mode=ffmpeg`'s single live-piped connection.
 *
 * A live pipe makes the *player* wait on our full pipeline startup latency
 * (two concurrent yt-dlp extractions + ffmpeg spin-up) on the same
 * connection it's reading from — some players/transcoders (Jellyfin's own
 * server-side ffmpeg being the motivating case) won't tolerate that and
 * just retry forever, producing an endless black-screen loop. Real
 * segmented HLS moves the wait to *our* side before we ever respond (see
 * waitForHlsSessionReady/getOrCreateHlsSession, modeled on the
 * readiness-gated approach in jellyfin-youtube-plugin's
 * ManagedTranscodeService.cs), and every segment served after that is an
 * ordinary complete static file — no unknown-length/non-seekable concerns,
 * no need for calculatedLength's estimation tricks.
 *
 * Tradeoff: writes real files to disk for the session's run (idle-reaped
 * after HLS_IDLE_TIMEOUT_MS), unlike mode=ffmpeg/calculatedLength's pure
 * in-memory pipes.
 */
const HLS_SEGMENT_DURATION_SECONDS = 4;
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

// mode=raw-buffer: max time a single Range response waits for bytes to
// appear on disk before giving up. Deliberately more generous than
// BUFFER_CATCHUP_TIMEOUT_MS — raw-buffer has no fallback, and a forward
// seek into a long video on a slow connection can legitimately need
// minutes to catch up. Last-resort safety net against a stuck fetch; a
// real error breaks the wait immediately via entry.status = 'failed'.
const RAW_BUFFER_WAIT_TIMEOUT_MS = 20 * 60 * 1000;

// Deliberately NOT under tempPathManager's temp base: that gets wiped
// wholesale by cleanTempDirectory() on startup and before every download
// job, which would delete segments out from under an active HLS session.
const HLS_BASE_TEMP_DIR = path.join(os.tmpdir(), 'youtarr-ytstream-hls');
// ytstream.hlsStorageLocation: 'cache' alternative to the OS temp dir above,
// under the same persistent .youtarr_ytstream_cache folder the untracked-
// buffer cache and probe/placeholder clips already live in (YTSTREAM_CACHE_DIR,
// defined further below with the rest of that group). Read fresh on every
// session/fetch start (not cached at module load) so a config change takes
// effect on the next play without a server restart.
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
 * `placeholder` (ytstream.instantStart) prepends one pre-made "loading"
 * segment ahead of the real ones, separated by #EXT-X-DISCONTINUITY (own
 * #EXT-X-MAP for fmp4) — never reuses a real segment index.
 *
 * DELIBERATELY always VOD+ENDLIST, even with a placeholder, listing the
 * full real segment range. Do NOT switch to an EVENT playlist without a
 * live Jellyfin test: two EVENT variants were tried and reverted — one made
 * the player treat the last (not-yet-on-disk) segment as the live edge and
 * skip straight to the next item; the other left playback stuck on the
 * placeholder because Jellyfin doesn't reliably re-poll an unchanged EVENT
 * playlist. Both were chasing a cosmetic scrubber/duration quirk not worth
 * trading working playback for.
 */
function buildFullHlsPlaylist({ totalSegments, durationSeconds, segmentExt, segmentType, placeholder }) {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${HLS_SEGMENT_DURATION_SECONDS}`,
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-MEDIA-SEQUENCE:0',
  ];
  if (placeholder) {
    if (segmentType === 'fmp4' && placeholder.initFilename) {
      lines.push(`#EXT-X-MAP:URI="${placeholder.initFilename}"`);
    }
    lines.push(`#EXTINF:${placeholder.durationSeconds.toFixed(3)},`);
    lines.push(placeholder.filename);
    lines.push('#EXT-X-DISCONTINUITY');
  }
  if (segmentType === 'fmp4') {
    lines.push('#EXT-X-MAP:URI="init.mp4"');
  }
  for (let i = 0; i < totalSegments; i++) {
    const isLast = i === totalSegments - 1;
    const remaining = durationSeconds - i * HLS_SEGMENT_DURATION_SECONDS;
    const segDuration = isLast ? Math.max(0.1, remaining) : HLS_SEGMENT_DURATION_SECONDS;
    lines.push(`#EXTINF:${segDuration.toFixed(3)},`);
    lines.push(`segment${String(i).padStart(5, '0')}.${segmentExt}`);
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

/**
 * `ytstream.instantStart`'s placeholder is written into the playlist file
 * ONCE at session creation and nothing rewrites it afterward — so a second
 * request on an already-running session (double-GET, reload) would replay
 * the placeholder even after the real encode has caught up, visibly
 * "restarting into another loading screen".
 *
 * Called from both playlist-serving sites before the file is read; a no-op
 * (fs.existsSync check) except for the first request that notices real
 * segment0 exists, which rewrites the file in place so every later request
 * sees the placeholder-free version.
 */
function maybeStripPlaceholderFromPlaylist(session) {
  if (!session.hasPlaceholder || session.placeholderStripped) return;
  const realFirstSegment = path.join(session.dir, `segment00000.${session.segmentExt}`);
  if (!fs.existsSync(realFirstSegment)) return;
  try {
    const fullPlaylist = buildFullHlsPlaylist({
      totalSegments: session.totalSegments,
      durationSeconds: session.durationSeconds,
      segmentExt: session.segmentExt,
      segmentType: session.segmentType,
      placeholder: null,
    });
    fs.writeFileSync(session.playlistPath, fullPlaylist);
    session.placeholderStripped = true;
    logger.info({ sessionKey: session.sessionKey }, 'ytstream: real first segment ready; stripped instant-start placeholder from playlist for future requests');
  } catch (err) {
    logger.warn({ err, sessionKey: session.sessionKey }, 'ytstream: failed to strip instant-start placeholder from playlist');
  }
}

/**
 * `ytstream.instantStart` (opt-in, calculatedLength HLS sessions only — see
 * buildFullHlsPlaylist's `placeholder` param and createHlsSessionInternal).
 *
 * getOrCreateHlsSession normally blocks the first response on
 * waitForHlsSessionReady until the real pipeline produces its first segment
 * (cold start commonly 10-25s, up to HLS_READY_TIMEOUT_MS=45s). This drops a
 * tiny pre-generated "loading" segment into the session dir under a
 * filename that never collides with the real `segment00000.*`, so the first
 * disk poll finds *something* and returns immediately — playback starts in
 * milliseconds, and by the time the ~3s placeholder finishes the real
 * encode usually has a head start on segment 0.
 *
 * Scoped to `transcode=h264` only: its output codec is fixed regardless of
 * source video, so one cached placeholder fits every video; `transcode=copy`
 * passes through each source's own codec, so no single placeholder could match.
 */
// Persistent (not os.tmpdir(), which most Docker setups wipe on restart) —
// generation is a one-time cost per {signature, resolution}, and a
// predictable path also lets a user drop in their own clip to be used as-is.
//
// Lives under configModule.directoryPath (the library volume), NOT the
// config volume — same precedent as nzb.js's .nzb_staging — since these
// caches (especially the untracked-buffer cache, a full copy of a video)
// belong on the volume sized for bulk media. NOT HLS_BASE_TEMP_DIR's local
// /tmp either: unlike these write-once caches, live per-session HLS segment
// dirs are written continuously for a stream's whole life, and routing that
// through NAS-backed storage instead of fast local disk regressed segment
// production from far-faster-than-realtime to barely realtime (see
// mode=hls-tap's tapTempPath doc). And NOT tempPathManager's '.youtarr_tmp'
// subfolder: that gets wiped wholesale by cleanTempDirectory() on startup
// and before every download job, which was silently deleting this cache's
// persistent contents each time a job ran in the background.
const YTSTREAM_CACHE_DIR = path.join(configModule.directoryPath, '.youtarr_ytstream_cache');
const YTSTREAM_CLIPS_DIR = path.join(YTSTREAM_CACHE_DIR, 'ytstream-clips');
const HLS_PLACEHOLDER_CACHE_DIR = path.join(YTSTREAM_CLIPS_DIR, 'hls-instant-start');
// mode=hls-buffer against a video with no `Video` row (untracked NZB
// `strm` grab, or later disowned via `importStrategy:'untracked'` — see
// bufferEnabled in createHlsSessionInternal) still gets buffer-fetched, but
// lands HERE keyed by youtubeId instead of a library location — no Video/Job
// row, invisible in the library/Download History, purely a same-video
// speed-up. Persistent so a later replay (even post-restart) can reuse it.
const HLS_UNTRACKED_BUFFER_CACHE_DIR = path.join(YTSTREAM_CLIPS_DIR, 'hls-buffer-untracked-cache');

function getUntrackedBufferCachePath(youtubeId) {
  return path.join(HLS_UNTRACKED_BUFFER_CACHE_DIR, `${youtubeId}.ts`);
}
const HLS_PLACEHOLDER_DURATION_SECONDS = 3; // must stay < HLS_SEGMENT_DURATION_SECONDS (the playlist's #EXT-X-TARGETDURATION)
const HLS_PLACEHOLDER_FPS = 30;
// Used only when a video's real resolution can't be resolved yet (see
// resolveVideoTargetResolution) - a plain 16:9 fallback, not a target.
const HLS_PLACEHOLDER_FALLBACK_WIDTH = 1280;
const HLS_PLACEHOLDER_FALLBACK_HEIGHT = 720;

/** In-flight generation promises, keyed by signature — two sessions racing
 * to create the same never-yet-cached placeholder share one ffmpeg run
 * instead of each spawning their own. */
const placeholderGenerationPromises = new Map();

function getPlaceholderSignature({ segmentType, hardwareMode, tuning, width, height }) {
  return `${segmentType}-${normalizeHardwareMode(hardwareMode)}-${normalizeTuning(tuning)}-${width}x${height}`;
}

/**
 * Resolves the {width, height} the real encode would actually use for this
 * video — a generic fixed resolution would misreport a video's true
 * dimensions to a probe, and looks visibly wrong (letterboxed/stretched) as
 * a "loading" placeholder for a genuinely portrait/unusual-aspect-ratio
 * source. Prefers Video.video_resolution (set from a real downloaded
 * file's own ffprobe); STRM-only videos have no downloaded file to probe,
 * so falls back to reading the .strmtool.json sidecar strmMediaInfoCache.js
 * already writes next to the .strm (same format-selection logic ytstream
 * itself would use to pick a format). Never throws — returns the plain
 * 16:9 fallback if neither source is available yet (e.g. before this
 * video's first STRM materialize has ever run).
 * @returns {Promise<{width: number, height: number}>}
 */
async function resolveVideoTargetResolution(youtubeId, models) {
  const fallback = { width: HLS_PLACEHOLDER_FALLBACK_WIDTH, height: HLS_PLACEHOLDER_FALLBACK_HEIGHT };
  if (!models || !models.Video) return fallback;
  try {
    const video = await models.Video.findOne({
      where: { youtubeId },
      attributes: ['filePath', 'video_resolution'],
    });
    if (!video) return fallback;

    if (video.video_resolution) {
      const match = /^(\d+)x(\d+)$/.exec(String(video.video_resolution).trim());
      if (match) {
        const width = Number(match[1]);
        const height = Number(match[2]);
        if (width > 0 && height > 0) return { width, height };
      }
    }

    if (video.filePath && video.filePath.toLowerCase().endsWith('.strm')) {
      const parsed = path.parse(video.filePath);
      const cachePath = path.format({ dir: parsed.dir, name: parsed.name, ext: '.strmtool.json' });
      if (fs.existsSync(cachePath)) {
        const cache = JSON.parse(await fs.promises.readFile(cachePath, 'utf8'));
        const videoStream = Array.isArray(cache.mediaStreams)
          ? cache.mediaStreams.find((s) => s.Type === 1) // MediaStreamType.Video
          : null;
        if (videoStream && videoStream.Width && videoStream.Height) {
          return { width: videoStream.Width, height: videoStream.Height };
        }
      }
    }
  } catch (err) {
    logger.warn({ err, youtubeId }, 'ytstream: failed to resolve target resolution for placeholder/probe clip; using fallback');
  }
  return fallback;
}

/**
 * Caps {width, height} at `heightCap` (decrease-only, even width — same
 * semantics as buildVideoEncoderArgs's scale filter), so a placeholder/probe
 * clip matches what the real encode produces when requested quality is
 * lower than the source. Without this a native-4K video at quality=1080 got
 * a 4K placeholder, visibly mismatched once playback handed off to the real
 * first segment.
 * @param {number|null} heightCap - from resolveQualityHeight; null ("best") leaves the source resolution untouched.
 */
function capResolutionToHeight(width, height, heightCap) {
  if (!heightCap || !height || height <= heightCap) return { width, height };
  const scale = heightCap / height;
  return { width: Math.max(2, Math.round((width * scale) / 2) * 2), height: heightCap };
}

function runFfmpegOnce(args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (c) => { stderr = (stderr + c.toString()).slice(-4000); });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`ffmpeg placeholder generation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

// drawtext's `fontfile=` bypasses fontconfig lookup - just needs this file
// present (Dockerfile's `fonts-dejavu-core` package). Checked with
// fs.existsSync first, so a missing package silently loses the text overlay
// instead of failing placeholder generation outright.
const PLACEHOLDER_FONT_PATH = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

/**
 * Resolves the on-disk path to a video's cached UI thumbnail (written by
 * strmMaterializer._writeThumbnail for every video, not a live fetch), for
 * use as ensurePlaceholderSegment's background. Returns null (never throws)
 * if not cached yet — callers fall back to the generic test-pattern
 * placeholder, same as any other placeholder-generation failure.
 */
function resolveLocalThumbnailPath(youtubeId) {
  try {
    const thumbPath = path.join(configModule.getImagePath(), `videothumb-${youtubeId}.jpg`);
    return fs.existsSync(thumbPath) ? thumbPath : null;
  } catch {
    return null;
  }
}

/**
 * Generates (or reuses a cached) tiny "loading" HLS segment matching a
 * `transcode=h264` session's actual encoder settings, so it splices cleanly
 * into the real encode's output. When `thumbnailPath` resolves, the segment
 * is this video's own thumbnail with a "Loading..." card drawn over it
 * (letterboxed to fit without distortion); otherwise falls back to a moving
 * lavfi test pattern + silence.
 *
 * Never throws — any failure logs a warning and returns null, and callers
 * fall back to the normal wait-for-the-real-segment behavior.
 * @param {string|null} [thumbnailPath] - background image; makes the segment
 *   video-specific, so it's cached per-video instead of shared.
 * @param {string} [youtubeId] - required with thumbnailPath, to keep this
 *   video's cache from colliding with another's.
 * @param {number} width - target resolution (see resolveVideoTargetResolution)
 * @param {number} height
 * @returns {Promise<{segmentPath: string, initPath: string|null}|null>}
 */
async function ensurePlaceholderSegment({ youtubeId, thumbnailPath, segmentType, segmentExt, hardwareMode, tuning, width, height }) {
  const signature = getPlaceholderSignature({ segmentType, hardwareMode, tuning, width, height });
  // A thumbnail-backed placeholder is per-video content, not the shared
  // generic pattern - keyed by youtubeId plus the thumbnail file's own
  // size+mtime, so a later-replaced thumbnail (e.g. a metadata refresh
  // finding a better maxresdefault) invalidates the cache instead of
  // serving a stale image forever.
  let cacheKey = signature;
  if (thumbnailPath) {
    try {
      const stat = fs.statSync(thumbnailPath);
      cacheKey = `${youtubeId}-${stat.size}-${Math.floor(stat.mtimeMs)}-${signature}`;
    } catch {
      thumbnailPath = null; // vanished between resolve and here - fall back to generic
    }
  }
  const dir = path.join(HLS_PLACEHOLDER_CACHE_DIR, cacheKey);
  const segmentPath = path.join(dir, `placeholder.${segmentExt}`);
  const initPath = segmentType === 'fmp4' ? path.join(dir, 'placeholder-init.mp4') : null;

  const isReady = () => fs.existsSync(segmentPath) && (!initPath || fs.existsSync(initPath));
  if (isReady()) return { segmentPath, initPath };

  if (placeholderGenerationPromises.has(cacheKey)) {
    await placeholderGenerationPromises.get(cacheKey).catch(() => {});
    return isReady() ? { segmentPath, initPath } : null;
  }

  const generate = (async () => {
    fs.mkdirSync(dir, { recursive: true });
    const vaapiQuality = (configModule.getConfig().ytstream || {}).vaapiQuality;
    const encoder = buildVideoEncoderArgs(hardwareMode, height, tuning, vaapiQuality);
    const args = ['-y', '-loglevel', 'error'];
    if (encoder.preInputArgs && encoder.preInputArgs.length) {
      args.push(...encoder.preInputArgs);
    }
    const videoFilters = [];
    if (thumbnailPath) {
      args.push('-loop', '1', '-framerate', String(HLS_PLACEHOLDER_FPS), '-i', thumbnailPath);
      args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
      args.push('-t', String(HLS_PLACEHOLDER_DURATION_SECONDS));
      // One frame held for the full duration (1-frame-per-duration output
      // framerate), not HLS_PLACEHOLDER_DURATION_SECONDS * FPS near-identical
      // frames of an unchanging image - cheaper, and a single sample's
      // presentation duration is exact by construction. The old multi-frame
      // looped-image version had no intrinsic length (unlike testsrc2, which
      // self-describes `duration=`), so `-t` cutting off an infinite loop
      // left the segment not landing precisely on 3.000s and the scrubber
      // stuck at 0.
      args.push('-r', `1/${HLS_PLACEHOLDER_DURATION_SECONDS}`);
      args.push('-frames:v', '1');
      // scale-to-fit + letterbox, not a bare scale - a locally-cached
      // thumbnail's aspect ratio (e.g. hqdefault.jpg's fixed 480x360) won't
      // generally match the real video's target aspect, and a plain scale
      // would visibly stretch/distort the image.
      videoFilters.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease`);
      videoFilters.push(`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`);
      if (fs.existsSync(PLACEHOLDER_FONT_PATH)) {
        const fontSize = Math.max(16, Math.round(height / 18));
        videoFilters.push(
          `drawtext=fontfile='${PLACEHOLDER_FONT_PATH}':text='Loading...':fontsize=${fontSize}:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=${Math.round(fontSize / 3)}:x=(w-text_w)/2:y=(h-text_h)/2`
        );
      }
    } else {
      args.push(
        '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${HLS_PLACEHOLDER_FPS}:duration=${HLS_PLACEHOLDER_DURATION_SECONDS}`,
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
        '-t', String(HLS_PLACEHOLDER_DURATION_SECONDS),
      );
    }
    if (encoder.videoFilters && encoder.videoFilters.length) {
      videoFilters.push(...encoder.videoFilters);
    }
    if (videoFilters.length) {
      args.push('-vf', videoFilters.join(','));
    }
    if (encoder.pixFmt) args.push('-pix_fmt', encoder.pixFmt);
    args.push(...encoder.encoderArgs);
    args.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k', '-ar', '48000');
    args.push(
      '-f', 'hls',
      '-hls_time', String(HLS_PLACEHOLDER_DURATION_SECONDS),
      '-hls_list_size', '1',
      '-hls_flags', 'independent_segments',
      '-hls_segment_type', segmentType,
    );
    if (segmentType === 'fmp4') {
      // Relative, like the real pass's -hls_fmp4_init_filename - ffmpeg
      // resolves it against -hls_segment_filename's own directory.
      args.push('-hls_fmp4_init_filename', 'placeholder-init.mp4');
    }
    const scratchPlaylist = path.join(dir, 'scratch.m3u8');
    args.push('-hls_segment_filename', path.join(dir, `placeholder-raw%d.${segmentExt}`), scratchPlaylist);

    logger.info({ cacheKey, thumbnailPath: thumbnailPath || null, args }, 'ytstream: generating HLS instant-start placeholder segment');
    await runFfmpegOnce(args);

    fs.renameSync(path.join(dir, `placeholder-raw0.${segmentExt}`), segmentPath);
    if (segmentType === 'fmp4') {
      fs.renameSync(path.join(dir, 'placeholder-init.mp4'), initPath);
    }
    try { fs.rmSync(scratchPlaylist, { force: true }); } catch { /* best-effort cleanup */ }
  })();

  placeholderGenerationPromises.set(cacheKey, generate);
  try {
    await generate;
    return isReady() ? { segmentPath, initPath } : null;
  } catch (err) {
    logger.warn({ err, cacheKey }, 'ytstream: failed to generate HLS instant-start placeholder; falling back to normal session startup');
    return null;
  } finally {
    placeholderGenerationPromises.delete(cacheKey);
  }
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

function isManifestUrl(url) {
  const u = String(url || '').toLowerCase();
  return (
    u.includes('://googlevideo.com') ||
    u.includes('.m3u8') ||
    u.includes('/api/manifest/')
  );
}

/**
 * `ytstream.probeShortcut` (opt-in). See strmGenerator.js for the
 * pipe-syntax User-Agent written into every .strm when this is on, and
 * ytstreamProbeShortcut.js for the shared marker value.
 *
 * jellyfin/jellyfin#10175: a real metadata probe (ffprobe or similar)
 * arrives with libavformat's bare default UA ("Lavf/x.y.z") regardless of
 * what the .strm's pipe-syntax asked for, while real playback (ffmpeg
 * honors the override; a browser/app sends its own UA) never looks like
 * that. isLikelyMetadataProbeRequest is the detector; when it fires (and
 * probeShortcut is on), the route returns a tiny cached clip immediately —
 * before the cache-on-play trigger, the transcode=copy codec probe, or
 * ever creating a real HLS/ffmpeg session against YouTube.
 *
 * Scoped to `transcode=h264` only: that's the one case where output codec
 * is fixed regardless of source video, so one cached clip stands in for
 * every video. transcode=copy passes through each source's own codec, so a
 * copy-mode probe just falls through to normal handling.
 *
 * Best-effort throughout: any ffmpeg generation failure falls back to
 * normal request handling rather than ever 500ing a real probe or real
 * playback.
 */
function isLikelyMetadataProbeRequest(req) {
  return /^Lavf\//i.test(String(req.headers['user-agent'] || ''));
}

/**
 * Single source of truth for whether the probeShortcut early-exit would
 * fire for a given request — used both by the real early-exit block in the
 * main route and by resolvePlaybackPlan's debug trace, so the two can never
 * drift apart (previously each re-implemented the same condition separately).
 */
function evaluateProbeShortcut(req, config) {
  const probeCfg = config.ytstream || {};
  const probeQueryOverride = (name) => (probeCfg.forceServerSettings === true ? undefined : req.query[name]);
  const isMetadataProbe = isLikelyMetadataProbeRequest(req);
  const transcode = VALID_TRANSCODE.includes(probeQueryOverride('transcode'))
    ? probeQueryOverride('transcode')
    : (probeCfg.transcode || 'copy');
  // Cheap mirror of the real route's mode resolution (same
  // forceServerSettings-aware precedence as resolvePlaybackPlan) - needed
  // because `transcode=h264` alone doesn't mean the real response IS h264:
  // mode=raw-buffer (and direct/direct-pipe/direct-redirect) never
  // transcode, always muxing the source's real codec via `-c copy`.
  // Without this check, a raw-buffer play with transcode=h264 left over
  // from switching modes got an h264 probe clip for its ffprobe, then a
  // real response in the source's actual codec (VP9/AV1/Opus) - Jellyfin
  // decoded based on the probe's wrong answer and playback never worked.
  const mode = String(probeQueryOverride('mode') || probeCfg.defaultMode || 'direct').toLowerCase();
  const transcodeIsHonoredByMode = mode === 'ffmpeg' || mode === 'hls' || mode === 'hls-tap' || mode === 'hls-buffer';

  if (probeCfg.probeShortcut !== true) {
    return { wouldFire: false, reason: 'probeShortcut is off', isMetadataProbe, transcode, mode };
  }
  if (!isMetadataProbe) {
    return {
      wouldFire: false,
      reason: 'probeShortcut is on, but this request does not look like a metadata-probe request (see isLikelyMetadataProbeRequest)',
      isMetadataProbe,
      transcode,
      mode,
    };
  }
  if (!transcodeIsHonoredByMode) {
    return {
      wouldFire: false,
      reason: `probeShortcut is on and this looks like a metadata-probe request, but mode="${mode}" never transcodes regardless of the Transcode setting - the h264 probe clip would misrepresent this mode's real output codec/container, so this bypass is skipped`,
      isMetadataProbe,
      transcode,
      mode,
    };
  }
  if (transcode !== 'h264') {
    return {
      wouldFire: false,
      reason: `probeShortcut is on and this looks like a metadata-probe request, but transcode="${transcode}" (not h264) so it does not apply`,
      isMetadataProbe,
      transcode,
      mode,
    };
  }
  return {
    wouldFire: true,
    reason: 'probeShortcut is on, this looks like a metadata-probe request, mode transcodes, and transcode=h264 - the real request short-circuits here (tryServeProbeClip) and never reaches the mode/quality logic below',
    isMetadataProbe,
    transcode,
    mode,
  };
}

/**
 * Single canonical source of truth for whether each ytstream config field
 * is 'forced' (used, but pinned to a specific value - control disabled and
 * shows that value), 'ignored' (no effect at all for this mode - control
 * hidden), or 'optional' (a real user-choosable setting) for a given mode —
 * and why. Three things must
 * never drift apart from each other: (1) resolvePlaybackPlan's forced-value
 * enforcement, (2) the /simulate dry-run's step explanations, (3) the
 * Configuration UI's disabled/chip rendering (via the
 * /api/ytstream/mode-compatibility endpoint — the client never hardcodes
 * this, it only asks the server). Consolidates facts that were previously
 * discovered one at a time as scattered client-side booleans with
 * duplicated tooltip text, so the next discovery only needs updating here.
 *
 * `transcode` is needed alongside `mode` because a few fields' relevance
 * depends on both (hardwareMode/tuning/instantStart only matter for an
 * actual h264 encode; probeShortcut's fake-clip mechanism is h264-only too,
 * independent of raw-buffer's separate need for it).
 * @param {{mode: string, transcode: string}} params
 * @returns {Record<string, {status: 'forced'|'ignored'|'optional', reason?: string}>}
 */
function getModeFieldCompatibility({ mode, transcode, container }) {
  const isHlsFamily = mode === 'hls' || mode === 'hls-tap' || mode === 'hls-buffer';
  const enhancedMode = mode === 'ffmpeg' || isHlsFamily;
  const forceH264 = transcode === 'h264';
  const fields = {};

  fields.calculatedLength = isHlsFamily
    ? {
        status: 'forced',
        reason: `${mode} builds a real .m3u8 playlist - without this, a player sees ffmpeg's own raw growing playlist instead of a pre-declared exact-duration one, and can "join near the live edge" on reconnect (a real forward jump, displayed position stuck behind it), regardless of how this setting is configured.`,
      }
    : mode === 'raw-buffer'
      ? {
          status: 'ignored',
          reason: 'Raw + Buffered always computes its own exact Content-Length from the real download in progress - this setting is never even read for this mode.',
        }
      : (mode === 'direct' || mode === 'direct-redirect')
        ? {
            status: 'ignored',
            reason: `${mode} mode uses the stream's own real length (whatever the upstream/player's own fetch reports), not an estimate.`,
          }
        : {
            status: 'optional',
            reason: 'A genuine trade-off: reports an estimated size/duration upfront and answers seeks faster (but only approximately) by restarting at the estimated timestamp.',
          };

  fields.probeShortcut = !enhancedMode
    ? {
        status: 'ignored',
        reason: 'This mode never transcodes, so the cached probe-shortcut clip (always H.264) could never stand in for its real output codec/container.',
      }
    : !forceH264
      ? {
          status: 'ignored',
          reason: 'Only applies when Transcode is set to Force re-encode (H.264/AAC) - the cached probe-shortcut clip is always H.264, so it can only stand in for a real response that would also be H.264.',
        }
      : {
          status: 'optional',
          reason: 'Skips a real yt-dlp/ffmpeg session for a detected metadata probe, serving a tiny cached clip in the right codec instead.',
        };

  const encodeFieldsIgnoredReason = 'This mode never runs an ffmpeg encode - there\'s nothing here for Container/Transcode/Hardware encoder/Encoding tuning to apply to.';
  fields.container = !enhancedMode
    ? { status: 'ignored', reason: encodeFieldsIgnoredReason }
    : { status: 'optional' };
  fields.transcode = !enhancedMode
    ? { status: 'ignored', reason: encodeFieldsIgnoredReason }
    : { status: 'optional' };

  const hwIgnoredReason = !enhancedMode
    ? encodeFieldsIgnoredReason
    : 'Only applies when Transcode is set to Force re-encode (H.264/AAC) - Copy (or Auto resolving to copy) never touches an encoder at all.';
  fields.hardwareMode = (!enhancedMode || !forceH264)
    ? { status: 'ignored', reason: hwIgnoredReason }
    : { status: 'optional' };
  fields.tuning = (!enhancedMode || !forceH264)
    ? { status: 'ignored', reason: hwIgnoredReason }
    : { status: 'optional' };

  fields.hotSwapToCache = mode === 'hls'
    ? {
        status: 'optional',
        reason: 'Hot-swaps a live HLS session onto a finished STRM cache-on-play download once it completes, without restarting playback.',
      }
    : {
        status: 'ignored',
        reason: (mode === 'hls-tap' || mode === 'hls-buffer')
          ? 'This mode replaces hot-swap-to-cache entirely with its own tap/buffer finalize mechanism - there\'s nothing session-swap-shaped for it to do here.'
          : 'Only mode=Enhanced HLS uses this - there\'s no live HLS session in this mode to hot-swap onto a finished download.',
      };

  // Mirrors the exact bufferWillAttempt condition the real cache-on-play
  // trigger checks (see maybeEnqueueCacheDownload's call site) - hls-buffer
  // and raw-buffer's own independent fetch already produces the same
  // permanent file cache-on-play would, unconditionally, so the STRM
  // background download is always skipped for them. hls-tap ONLY skips it
  // for an un-seeked t=0 request (a per-request fact this mode-level
  // function can't see), so it stays 'optional' here, not 'ignored'.
  fields.cacheOnPlay = (mode === 'hls-buffer' || mode === 'raw-buffer')
    ? {
        status: 'ignored',
        reason: `${mode === 'raw-buffer' ? 'Raw + Buffered' : 'Enhanced HLS + Buffered'}'s own fetch always finalizes into the same permanent file cache-on-play would have downloaded - the STRM background download is always skipped for this mode, regardless of this setting.`,
      }
    : {
        status: 'optional',
        reason: 'Enqueues a real background download of this video on play, so later plays use the cached file instead of live-proxying it again.',
      };

  fields.instantStart = (isHlsFamily && forceH264)
    ? {
        status: 'optional',
        reason: 'Serves a tiny pre-generated "loading" segment immediately while the real encode cold-starts, instead of the player waiting on the real first segment.',
      }
    : {
        status: 'ignored',
        reason: !isHlsFamily
          ? 'Only Enhanced HLS / + Tap / + Buffered have a cold-start placeholder segment to show at all.'
          : 'Only applies when Transcode is set to Force re-encode (H.264/AAC) - the placeholder is generated to match a real h264 encode\'s settings.',
      };

  // Only hls/hls-tap/hls-buffer produce real numbered segment files at all
  // (see SEGMENT_STATUS_MODES) - a forward seek in any of them can strand
  // segments between the old and new encode-pass targets, permanently
  // un-encoded. Genuinely "optional" rather than depending on more of this
  // session's state (a local source only shows up later, from STRM
  // cache-on-play's hot-swap or hls-buffer's own fetch) - when no local
  // source ever appears, this just never has anything to do, same as
  // disabled.
  fields.backfillMissingSegments = isHlsFamily
    ? {
        status: 'optional',
        reason: 'Once the live encode reaches the end of the video, fills in any segments a forward seek skipped over - using a local source only (STRM cache-on-play\'s hot-swap, or this mode\'s own buffer fetch), never a fresh network pull. No effect if no local source ever became available this session.',
      }
    : {
        status: 'ignored',
        reason: 'Only hls/hls-tap/hls-buffer write real numbered segment files that could ever have a gap to fill.',
      };

  // Only hls-buffer/raw-buffer always finalize a .ts (their whole mechanism
  // is a plain -c copy MPEG-TS remux); hls-tap only does when Container is
  // set to MPEG-TS - anything else it finalizes already lands as .mp4/.mkv,
  // nothing left to convert.
  fields.finalizeToMp4 = (mode === 'hls-buffer' || mode === 'raw-buffer')
    ? {
        status: 'optional',
        reason: `${mode === 'raw-buffer' ? 'Raw + Buffered' : 'Enhanced HLS + Buffered'} always finalizes as a .ts file - once complete, remux it (no re-encode) into a sibling .mp4 that plays natively and doesn't need Jellyfin (or any other player) to transcode it server-side.`,
      }
    : mode === 'hls-tap'
      ? (container === 'ts'
          ? {
              status: 'optional',
              reason: 'Tap-to-Download finalizes as a .ts file with Container set to MPEG-TS - once complete, remux it (no re-encode) into a sibling .mp4 that plays natively and doesn\'t need Jellyfin (or any other player) to transcode it server-side.',
            }
          : {
              status: 'ignored',
              reason: 'Tap-to-Download only finalizes as a .ts file when Container is set to MPEG-TS - with the current Container, its finalized file is already directly playable.',
            })
      : {
          status: 'ignored',
          reason: 'This mode never finalizes a permanent .ts file to convert.',
        };

  return fields;
}

// Persistent, same reasoning as HLS_PLACEHOLDER_CACHE_DIR above.
const PROBE_CLIP_CACHE_DIR = path.join(YTSTREAM_CLIPS_DIR, 'probe-shortcut');
const PROBE_CLIP_DURATION_SECONDS = 2;
const probeClipGenerationPromises = new Map();

// Jellyfin's prober sets a video's RunTimeTicks straight from ffprobe's
// `format.duration`, unconditionally overwriting whatever it already knew -
// so a short probe clip gets recorded as the video's real length. FFmpeg's
// matroska muxer always writes container duration as one fixed field: EBML
// ID 0x4489 (Segment Info "Duration"), a 0x88 size marker (8 bytes follow),
// then an 8-byte big-endian IEEE754 double in milliseconds (TimecodeScale
// default 1ms/unit). Jellyfin trusts that value outright without validating
// it against actual media length - so patching just those 8 bytes to the
// real known duration (see resolveDurationSeconds) makes the probe response
// accurate without encoding an extra frame.
// Scanned for by marker (not a hardcoded offset) for resilience across
// ffmpeg versions; if not found, patching is silently skipped and the clip
// is served as generated - same best-effort philosophy as the rest of this feature.
const MATROSKA_DURATION_MARKER = Buffer.from([0x44, 0x89, 0x88]);
const probeClipDurationOffsetCache = new Map(); // signature -> byte offset | null

function findMatroskaDurationValueOffset(buffer) {
  const markerOffset = buffer.indexOf(MATROSKA_DURATION_MARKER);
  if (markerOffset === -1) return -1;
  const valueOffset = markerOffset + MATROSKA_DURATION_MARKER.length;
  return valueOffset + 8 <= buffer.length ? valueOffset : -1;
}

async function getProbeClipDurationOffset(signature, filePath) {
  if (probeClipDurationOffsetCache.has(signature)) return probeClipDurationOffsetCache.get(signature);
  let offset = null;
  try {
    const fh = await fs.promises.open(filePath, 'r');
    try {
      const head = Buffer.alloc(65536);
      const { bytesRead } = await fh.read(head, 0, head.length, 0);
      const found = findMatroskaDurationValueOffset(head.subarray(0, bytesRead));
      if (found !== -1) offset = found;
    } finally {
      await fh.close();
    }
  } catch (err) {
    logger.warn({ err, signature }, 'ytstream: failed to scan probe-shortcut clip for its Matroska Duration field');
  }
  probeClipDurationOffsetCache.set(signature, offset);
  return offset;
}

/**
 * Generates (or reuses a cached) tiny standalone Matroska clip matching a
 * `transcode=h264` session's encoder settings. Matroska over MP4/WebM: its
 * muxer accepts any video/audio codec pair ffmpeg produces without MP4's
 * container-specific box signaling/moov-placement concerns, so one code
 * path works across every hardwareMode's output codec. Never throws;
 * returns null on failure.
 * @param {number} width - target resolution (see resolveVideoTargetResolution)
 * @param {number} height
 * @returns {Promise<{filePath: string, signature: string}|null>}
 */
async function ensureProbeClip({ hardwareMode, tuning, width, height }) {
  const signature = `${normalizeHardwareMode(hardwareMode)}-${normalizeTuning(tuning)}-${width}x${height}`;
  const dir = path.join(PROBE_CLIP_CACHE_DIR, signature);
  const filePath = path.join(dir, 'probe.mkv');
  if (fs.existsSync(filePath)) return { filePath, signature };

  if (probeClipGenerationPromises.has(signature)) {
    await probeClipGenerationPromises.get(signature).catch(() => {});
    return fs.existsSync(filePath) ? { filePath, signature } : null;
  }

  const generate = (async () => {
    fs.mkdirSync(dir, { recursive: true });
    const vaapiQuality = (configModule.getConfig().ytstream || {}).vaapiQuality;
    const encoder = buildVideoEncoderArgs(hardwareMode, height, tuning, vaapiQuality);
    const args = ['-y', '-loglevel', 'error'];
    if (encoder.preInputArgs && encoder.preInputArgs.length) {
      args.push(...encoder.preInputArgs);
    }
    args.push(
      '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${HLS_PLACEHOLDER_FPS}:duration=${PROBE_CLIP_DURATION_SECONDS}`,
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-t', String(PROBE_CLIP_DURATION_SECONDS),
    );
    if (encoder.videoFilters && encoder.videoFilters.length) {
      args.push('-vf', encoder.videoFilters.join(','));
    }
    if (encoder.pixFmt) args.push('-pix_fmt', encoder.pixFmt);
    args.push(...encoder.encoderArgs);
    args.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k', '-ar', '48000');
    args.push('-f', 'matroska', filePath);

    logger.info({ signature, args }, 'ytstream: generating probe-shortcut clip');
    await runFfmpegOnce(args);
  })();

  probeClipGenerationPromises.set(signature, generate);
  try {
    await generate;
    return fs.existsSync(filePath) ? { filePath, signature } : null;
  } catch (err) {
    logger.warn({ err, signature }, 'ytstream: failed to generate probe-shortcut clip');
    return null;
  } finally {
    probeClipGenerationPromises.delete(signature);
  }
}

/**
 * @returns {Promise<boolean>} true if a response was sent (caller must
 *   return immediately without falling through to normal handling).
 * @param {(youtubeId: string) => Promise<number>} resolveDurationSeconds -
 *   DB-first, yt-dlp-fallback-then-cached; a real network call happens at
 *   most once per not-yet-tracked video, then hits durationCache.
 */
async function tryServeProbeClip(req, res, { hardwareMode, tuning, width, height, youtubeId, resolveDurationSeconds }) {
  try {
    const clip = await ensureProbeClip({ hardwareMode, tuning, width, height });
    if (!clip) return false;

    // Best-effort duration patch - see MATROSKA_DURATION_MARKER's doc
    // comment above. Falls back to serving the clip unmodified (today's
    // behavior) whenever the real duration can't be resolved, or the
    // Duration field can't be located.
    let body = null;
    let knownDurationSeconds = null;
    try {
      knownDurationSeconds = await resolveDurationSeconds(youtubeId);
    } catch (err) {
      logger.warn({ err, youtubeId }, 'ytstream: could not resolve real duration for probe-shortcut clip; serving it unmodified');
    }
    if (knownDurationSeconds) {
      const offset = await getProbeClipDurationOffset(clip.signature, clip.filePath);
      if (offset !== null) {
        try {
          const buffer = await fs.promises.readFile(clip.filePath);
          buffer.writeDoubleBE(knownDurationSeconds * 1000, offset);
          body = buffer;
        } catch (err) {
          logger.warn({ err, youtubeId }, 'ytstream: failed to patch probe-shortcut clip duration; serving it unmodified');
        }
      }
    }

    const size = body ? body.length : (await fs.promises.stat(clip.filePath)).size;
    logger.info(
      { ua: req.headers['user-agent'], size, url: req.originalUrl, patchedDurationSeconds: body ? knownDurationSeconds : null },
      'ytstream: serving cached probe-shortcut clip to a detected metadata-probe request'
    );
    res.set({
      'Content-Type': 'video/x-matroska',
      'Content-Length': String(size),
      'Cache-Control': 'no-store',
      'Accept-Ranges': 'bytes',
    });
    if (body) {
      res.end(body);
    } else {
      await new Promise((resolve, reject) => {
        const stream = fs.createReadStream(clip.filePath);
        stream.on('error', reject);
        stream.on('close', resolve);
        stream.pipe(res);
      });
    }
    return true;
  } catch (err) {
    logger.warn({ err }, 'ytstream: failed to serve probe-shortcut clip; falling back to normal request handling');
    return false;
  }
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
async function tryServeCachedVideoFile(req, res, filePath) {
  // ytstream.finalizeToMp4: prefer an already-finalized .mp4 remux over the
  // raw .ts whenever one exists (never triggers ffmpeg here - only a peek;
  // see tsRemuxCache.js). Avoids ever handing a real player (or Jellyfin's
  // own probe/transcode) a container it can't direct-play, without adding
  // any latency to this request when no remux exists yet.
  if (path.extname(filePath).toLowerCase() === '.ts') {
    const remuxPath = require('../modules/tsRemuxCache').findExistingSeekableMp4(filePath);
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
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filePath);
      stream.on('error', reject);
      stream.on('close', resolve);
      stream.pipe(res);
    });
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
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { start, end });
    stream.on('error', reject);
    stream.on('close', resolve);
    stream.pipe(res);
  });
  return true;
}

/**
 * Deletes a permanently-finalized .ts file now that a seekable .mp4 remux
 * of it exists - but ONLY once no live (non-destroying) HLS session still
 * has this exact path as its cachedFilePath, since such a session could
 * still open a brand-new read of it later (a seek-restart, or another
 * backfill pass triggered by maybeBackfillMissingSegments) - deleting out
 * from under a FUTURE re-open would break it. This is deliberately not a
 * concern for reads already in progress right now: POSIX unlink-while-open
 * semantics mean an already-open read (a viewer's in-flight download,
 * mid-transfer) keeps working fine off its existing file handle even after
 * the directory entry is removed - only a NEW open of the now-missing path
 * would fail, which is exactly what the cachedFilePath check above guards
 * against. Best-effort and non-fatal either way - freeing this disk space
 * is a nice-to-have, never worth risking a live session over.
 * @param {string} finalPath - the .ts file's real on-disk path
 * @param {object} context - extra fields for the log lines only (e.g. youtubeId, sourceLabel)
 */
function trySafeDeleteFinalizedTs(finalPath, context) {
  const stillReferencedBy = [...hlsSessions.values()].find(
    (s) => !s.destroying && s.cachedFilePath === finalPath
  );
  if (stillReferencedBy) {
    logger.debug(
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
 * ytstream.finalizeToMp4: called after finalizeTapOutput (hls-tap/hls-buffer/
 * raw-buffer) successfully lands a session's permanent output file. Fires a
 * background (never awaited by any caller) tsRemuxCache.ensureSeekableMp4
 * run when that output is a .ts - purely eager pre-warming, so the FIRST
 * real playback/probe of it already finds the .mp4 via
 * tryServeCachedVideoFile's own findExistingSeekableMp4 check instead of
 * paying the remux cost live. No-op (and no ffmpeg run at all) unless the
 * config option is on and the file is actually .ts. Once the remux
 * succeeds, also tries to reclaim the now-redundant .ts (see
 * trySafeDeleteFinalizedTs) - safe to skip if something's still using it;
 * destroyHlsSession retries this once that session ends.
 */
function maybeFinalizeTsToMp4(youtubeId, finalPath, sourceLabel) {
  try {
    if ((configModule.getConfig().ytstream || {}).finalizeToMp4 !== true) return;
    if (!finalPath || path.extname(finalPath).toLowerCase() !== '.ts') return;
    logger.debug({ youtubeId, finalPath, sourceLabel }, 'ytstream: starting background .ts -> .mp4 finalize');
    require('../modules/tsRemuxCache').ensureSeekableMp4(finalPath)
      .then((mp4Path) => {
        if (mp4Path) {
          logger.info({ youtubeId, finalPath, mp4Path, sourceLabel }, 'ytstream: finalized .ts remuxed to .mp4 for direct playback');
          trySafeDeleteFinalizedTs(finalPath, { youtubeId, sourceLabel });
        }
      })
      .catch((err) => logger.warn({ err, youtubeId, finalPath, sourceLabel }, 'ytstream: post-finalize .ts -> .mp4 remux failed'));
  } catch (err) {
    logger.warn({ err, youtubeId, finalPath, sourceLabel }, 'ytstream: maybeFinalizeTsToMp4 failed');
  }
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
  const untrackedPath = getUntrackedBufferCachePath(youtubeId);
  if (fs.existsSync(untrackedPath)) return untrackedPath;
  if (models && models.Video) {
    try {
      const video = await models.Video.findOne({ where: { youtubeId }, attributes: ['is_strm', 'filePath'] });
      if (video && video.is_strm === false && video.filePath && fs.existsSync(video.filePath)) {
        return video.filePath;
      }
    } catch (err) {
      logger.warn({ err, youtubeId }, 'ytstream: findExistingCachedVideoFilePath DB lookup failed; treating as no cached file');
    }
  }
  return null;
}

function createYtStreamRoutes({ verifyToken, getClientAddress, models }) {
  logger.info('Initializing YouTube direct/ffmpeg stream routes');
  ytstreamModels = models;
  // Any StreamHistory row still "open" (ended_at null) at this point can only
  // be from a server restart — activeStreams itself is in-memory and starts
  // empty every boot, so nothing could still legitimately be tracking it.
  // Close these out so a crash/restart mid-stream doesn't leave permanently
  // "still playing" rows in the history table.
  if (models && models.StreamHistory) {
    models.StreamHistory.update(
      { ended_at: new Date(), end_reason: 'server-restart' },
      { where: { ended_at: null } }
    ).then((result) => {
      const count = Array.isArray(result) ? result[0] : result;
      if (count) logger.info({ count }, 'ytstream: closed out stream-history rows left open by a previous server restart');
    }).catch((err) => {
      logger.warn({ err }, 'ytstream: failed to close out orphaned stream-history rows on startup');
    });
  }
  const authMiddleware = typeof verifyToken === 'function'
    ? verifyToken
    : (req, res, next) => next();
  // Falls back to the raw socket address if the caller (older wiring,
  // tests) doesn't pass getClientAddress — same default server.js's own
  // getDirectClientAddress would produce without an explicit TRUST_PROXY.
  const resolveRawClientIp = typeof getClientAddress === 'function'
    ? getClientAddress
    : (req) => req.socket?.remoteAddress || req.ip;
  // IPv4 connections on a dual-stack socket report as IPv4-mapped IPv6
  // ("::ffff:172.19.0.6") - strip that prefix so logs, the Streaming page,
  // and StreamHistory all show the plain IPv4 address instead.
  const resolveClientIp = (req) => {
    const raw = resolveRawClientIp(req);
    return typeof raw === 'string' ? raw.replace(/^::ffff:/i, '') : raw;
  };

  const router = express.Router();

  router.use(['/api/ytstream/:youtubeId', '/api/ytstream/:youtubeId/formats', '/api/ytstream/:youtubeId/hls/:sessionKey/:filename'], (req, res, next) => {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS, HEAD',
      'Access-Control-Allow-Headers': 'Range, Content-Type',
    });
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  function buildBaseArgs(config, opts = {}) {
    // buildCommonArgs() already appends `--cookies <path>` via
    // configModule.getCookiesPath() internally - don't add it again here,
    // yt-dlp rejects a duplicate --cookies flag.
    const args = YtdlpCommandBuilder.buildCommonArgs(config, { skipSleepRequests: true });

    const ytCfg = config.ytstream || {};
    const playerClient = opts.playerClient || ytCfg.playerClient || DEFAULT_PLAYER_CLIENT;
    args.push('--extractor-args', `youtube:player_client=${playerClient}`);

    return args;
  }

  /**
   * Duration lookup for `ytstream.calculatedLength`'s synthetic Content-Length.
   * Checks the library DB first (skips a yt-dlp round trip in the common
   * case), then the persistent youtube_metadata_cache table (for untracked
   * videos - no Video row to read a duration from, but played at least
   * once before), falling back to a dedicated `--print duration` yt-dlp
   * call only when neither has it. The in-memory durationCache Map above
   * this still short-circuits all of that within one server process's
   * uptime; youtube_metadata_cache exists so an untracked video's duration
   * survives a server restart AND survives its own on-disk cache being
   * purged, rather than costing a fresh yt-dlp call on every first replay.
   */
  async function getVideoDurationSeconds(youtubeId, config) {
    if (durationCache.has(youtubeId)) return durationCache.get(youtubeId);
    if (durationLookupPromises.has(youtubeId)) {
      return durationLookupPromises.get(youtubeId);
    }

    const lookup = (async () => {
      if (models && models.Video) {
        try {
          const existing = await models.Video.findOne({
            where: { youtubeId },
            attributes: ['duration'],
          });
          const dbSeconds = existing ? Number(existing.duration) : NaN;
          if (Number.isFinite(dbSeconds) && dbSeconds > 0) {
            logger.info({ youtubeId, seconds: dbSeconds }, 'ytstream: resolved duration for calculatedLength from the database');
            durationCache.set(youtubeId, dbSeconds);
            return dbSeconds;
          }
        } catch (err) {
          logger.warn({ err, youtubeId }, 'ytstream: DB duration lookup failed for calculatedLength; falling back to yt-dlp');
        }
      }

      if (models && models.YoutubeMetadataCache) {
        try {
          const cached = await models.YoutubeMetadataCache.findByPk(youtubeId);
          if (cached && Number.isFinite(Number(cached.duration_seconds)) && cached.duration_seconds > 0) {
            logger.info({ youtubeId, seconds: cached.duration_seconds }, 'ytstream: resolved duration for calculatedLength from the persistent untracked-video metadata cache');
            durationCache.set(youtubeId, cached.duration_seconds);
            // Fire-and-forget - a stale last_accessed_at just means this row
            // might get swept a bit early, never a correctness issue.
            cached.update({ last_accessed_at: new Date() }).catch((err) => {
              logger.warn({ err, youtubeId }, 'ytstream: failed to bump youtube_metadata_cache last_accessed_at');
            });
            return cached.duration_seconds;
          }
        } catch (err) {
          logger.warn({ err, youtubeId }, 'ytstream: youtube_metadata_cache lookup failed for calculatedLength; falling back to yt-dlp');
        }
      }

      const args = [
        ...buildBaseArgs(config),
        '--skip-download',
        '--print', '%(duration)s',
        '--no-playlist',
        '--no-warnings',
        `https://youtube.com/watch?v=${youtubeId}`,
      ];
      logger.info({ youtubeId }, 'ytstream: resolving duration for calculatedLength Content-Length estimate via yt-dlp');
      const stdout = await ytDlpRunner.run(args, { timeoutMs: 30000 });
      const seconds = Number.parseFloat(String(stdout).trim());
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error(`Could not determine video duration for calculatedLength: ${String(stdout).slice(0, 200)}`);
      }
      durationCache.set(youtubeId, seconds);
      if (models && models.YoutubeMetadataCache) {
        const now = new Date();
        models.YoutubeMetadataCache.upsert({
          youtube_id: youtubeId,
          duration_seconds: Math.round(seconds),
          fetched_at: now,
          last_accessed_at: now,
        }).catch((err) => {
          logger.warn({ err, youtubeId }, 'ytstream: failed to persist duration into youtube_metadata_cache');
        });
      }
      return seconds;
    })();

    durationLookupPromises.set(youtubeId, lookup);
    try {
      return await lookup;
    } finally {
      durationLookupPromises.delete(youtubeId);
    }
  }

  /**
   * One component's real expected size in bytes, from yt-dlp's own format
   * metadata - `formatSelector` is always the exact same selector the real
   * fetch uses, never a guess at a different format. `filesize_approx` is
   * accepted as a fallback, still more accurate than assuming Youtarr's
   * encoder-tier table applies to an un-transcoded source. Never throws;
   * null on failure, and callers fall back to the duration*bitrate-table
   * heuristic.
   */
  async function probeRawFormatSizeBytes(youtubeId, config, formatSelector) {
    const cacheKey = `${youtubeId}|${formatSelector}`;
    if (rawBufferSizeCache.has(cacheKey)) return rawBufferSizeCache.get(cacheKey);
    try {
      const args = [
        ...buildBaseArgs(config),
        '-f', formatSelector,
        '--print', '%(filesize,filesize_approx)s',
        '--no-playlist',
        '--no-warnings',
        `https://youtube.com/watch?v=${youtubeId}`,
      ];
      const stdout = await ytDlpRunner.run(args, { timeoutMs: 20000 });
      const bytes = Number.parseInt(String(stdout).trim(), 10);
      const result = Number.isFinite(bytes) && bytes > 0 ? bytes : null;
      rawBufferSizeCache.set(cacheKey, result);
      return result;
    } catch (err) {
      logger.warn({ err, youtubeId, formatSelector }, 'ytstream: raw-buffer real-size probe failed; falling back to the bitrate-table estimate');
      rawBufferSizeCache.set(cacheKey, null);
      return null;
    }
  }

  /**
   * mode=raw-buffer's Content-Length estimate. DELIBERATELY does not reuse
   * estimateBitrateBytesPerSecond as its primary source - that table is
   * calibrated to Youtarr's OWN encoder output and assumes "best" is the
   * top bitrate tier (~24Mbps), an assumption that's wildly wrong for
   * raw-buffer's `-c copy` mux of whatever the source already is. A video
   * whose real output finished at 112MB once got a 4.36GB estimate (~39x
   * too high), causing two real failures: a client's end-of-file probe
   * landed far past the real file and 416'd, and the reported duration came
   * out wrong - see [[ytstream_raw_buffer_and_segment_bug]].
   *
   * Real per-format sizes (probeRawFormatSizeBytes, same selectors the
   * actual fetch uses) are summed and used whenever both succeed - accurate
   * since `-c copy` barely changes size from the source. Falls back to the
   * old duration*bitrate-table guess only when a real probe comes back
   * empty for either component - never no estimate at all (a null
   * Content-Length disables Range/seek support entirely).
   *
   * Pure combiner, not a fetcher - takes already-resolved probe results.
   * The three inputs (duration, video size, audio size) are independent
   * and run via one Promise.all by the caller, so this only pays for the
   * slowest of the three, not their sum (an earlier version awaited them
   * sequentially, adding ~10+s to time-to-first-byte).
   */
  function combineRawBufferContentLength(videoBytes, audioBytes, durationSeconds, height) {
    if (videoBytes !== null && audioBytes !== null) {
      return Math.ceil((videoBytes + audioBytes) * CALCULATED_LENGTH_PADDING_FACTOR);
    }
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
    return Math.ceil(durationSeconds * estimateBitrateBytesPerSecond(height));
  }

  /**
   * Resolves the video codec `getDashFormatSelectors` would actually select
   * at this quality — used to auto-upgrade `transcode=copy` to `h264` when
   * that format isn't H.264. The selector prefers avc1 but falls back to
   * whatever's available, commonly VP9/AV1 for videos with no H.264 track
   * that high; a `copy` remux of that isn't broadly player-compatible, and
   * can trigger Jellyfin's own server-side-transcode fallback which then
   * fails reading our stream as input.
   *
   * Uses `--print vcodec` against the same `-f` selector (not a full-format
   * parse), so the probed codec is exactly what will actually be used.
   */
  async function resolveVideoCodec(youtubeId, quality, config, playerClient, qualityStrictness) {
    const cacheKey = `${youtubeId}|${quality}|${playerClient || ''}|${qualityStrictness || 'fallback'}`;
    if (codecCache.has(cacheKey)) return codecCache.get(cacheKey);

    const { videoFormat } = getDashFormatSelectors(quality, qualityStrictness);
    const args = [
      ...buildBaseArgs(config, { playerClient }),
      '-f', videoFormat,
      '--print', '%(vcodec)s',
      '--skip-download',
      '--no-playlist',
      '--no-warnings',
      `https://youtube.com/watch?v=${youtubeId}`,
    ];
    logger.info({ youtubeId, quality, playerClient }, 'ytstream: probing selected format\'s video codec for transcode=copy compatibility check');
    const stdout = await ytDlpRunner.run(args, { timeoutMs: 30000 });
    const codec = String(stdout).trim().split(/\r?\n/)[0] || '';
    codecCache.set(cacheKey, codec);
    return codec;
  }

  /**
   * The height `-f bv*` (no height ceiling) would actually select — this
   * video's true best-available resolution. Best-effort: any failure
   * returns null ("unknown, don't cap") rather than blocking playback.
   */
  async function resolveMaxAvailableHeight(youtubeId, config, playerClient) {
    const cacheKey = `${youtubeId}|${playerClient || ''}`;
    if (maxAvailableHeightCache.has(cacheKey)) return maxAvailableHeightCache.get(cacheKey);

    try {
      const args = [
        ...buildBaseArgs(config, { playerClient }),
        '-f', 'bv*',
        '--print', '%(height)s',
        '--skip-download',
        '--no-playlist',
        '--no-warnings',
        `https://youtube.com/watch?v=${youtubeId}`,
      ];
      logger.info({ youtubeId, playerClient }, 'ytstream: resolving true best-available height for quality auto-cap');
      const stdout = await ytDlpRunner.run(args, { timeoutMs: 30000 });
      const height = Number.parseInt(String(stdout).trim().split(/\r?\n/)[0], 10);
      const result = Number.isFinite(height) && height > 0 ? height : null;
      maxAvailableHeightCache.set(cacheKey, result);
      return result;
    } catch (err) {
      logger.warn({ err, youtubeId }, 'ytstream: failed to resolve best-available height; skipping quality auto-cap for this request');
      return null;
    }
  }

  /**
   * resolveQualityHeight(quality), capped to this video's real
   * best-available height (resolveMaxAvailableHeight) - so requesting 2160
   * for a video that tops out at 1080p streams at 1080p, instead of leaving
   * yt-dlp to silently fall back while every downstream decision (encoder
   * scale/bitrate, placeholder/probe resolution) stays sized for the
   * nonexistent requested height. "best" (null) is left uncapped.
   */
  async function resolveEffectiveQualityHeight(youtubeId, quality, config, playerClient) {
    const requestedHeight = resolveQualityHeight(quality);
    if (!requestedHeight) return requestedHeight;
    const maxAvailable = await resolveMaxAvailableHeight(youtubeId, config, playerClient);
    return maxAvailable ? Math.min(requestedHeight, maxAvailable) : requestedHeight;
  }

  async function resolveDirectUrl(youtubeId, config, quality, forcedPlayerClient, qualityStrictness) {
    const format = getDirectFormatSelector(quality, qualityStrictness);
    const runOnce = async (playerClient) => {
      const args = [
        ...buildBaseArgs(config, { playerClient }),
        '-f', format,
        '-g',
        '--no-playlist',
        '--no-warnings',
        `https://youtube.com/watch?v=${youtubeId}`,
      ];
      logger.info({ youtubeId, format, quality, playerClient }, 'ytstream: resolving direct URL via yt-dlp');
      return ytDlpRunner.run(args, { timeoutMs: 90000 });
    };

    let stdout;
    try {
      stdout = await runOnce(forcedPlayerClient);
    } catch (err) {
      if (!forcedPlayerClient && isRetryableExtractionError(err.message)) {
        logger.warn(
          { youtubeId, err: err.message },
          `ytstream: direct resolve hit a client/session error, retrying once with player_client=${RETRY_PLAYER_CLIENT}`
        );
        stdout = await runOnce(RETRY_PLAYER_CLIENT);
      } else {
        throw err;
      }
    }

    const urls = String(stdout)
      .trim()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^https?:\/\//i.test(l));

    if (urls.length === 0) {
      throw new Error(`yt-dlp -g returned no URL: ${String(stdout).slice(0, 200)}`);
    }

    const manifest = urls.find(isManifestUrl);
    if (manifest) return manifest;

    if (urls.length > 1) {
      logger.warn(
        { youtubeId, count: urls.length },
        'ytstream: direct mode got multiple URLs without a manifest; using first URL only'
      );
    }

    return urls[0];
  }

  /**
   * Seek-restart fix (docs/YTSTREAM_SEEK_FIX.md): resolves video-only and
   * audio-only DASH URLs via a single `-g` call, for feeding ffmpeg as real
   * HTTP inputs with input-side `-ss` — a true Range-based seek, unlike the
   * pipe architecture's broken output-side `-ss`. NOT built on
   * `resolveDirectUrl`: its progressive/muxed selector usually caps at
   * 720p, which would silently cap every 1080p+/4K seek-restart too.
   *
   * Requests both formats in one call (`-f "video,audio"`) to avoid paying
   * extraction twice. Classifies the two URLs by their own `mime=video`/
   * `mime=audio` query param, not output order. Throws (no partial result)
   * if that doesn't yield exactly one of each — callers fall back to the
   * yt-dlp-pipe path rather than blocking a seek indefinitely.
   */
  async function resolveDashUrlsForSeek(youtubeId, config, quality, forcedPlayerClient, qualityStrictness) {
    const { videoFormat, audioFormat } = getDashFormatSelectors(quality, qualityStrictness);
    const runOnce = async (playerClient) => {
      const args = [
        ...buildBaseArgs(config, { playerClient }),
        '-f', `${videoFormat},${audioFormat}`,
        '-g',
        '--no-playlist',
        '--no-warnings',
        `https://youtube.com/watch?v=${youtubeId}`,
      ];
      logger.info(
        { youtubeId, videoFormat, audioFormat, quality, playerClient },
        'ytstream: resolving direct DASH URLs for seek-restart via yt-dlp'
      );
      return ytDlpRunner.run(args, { timeoutMs: 20000 });
    };

    let stdout;
    try {
      stdout = await runOnce(forcedPlayerClient);
    } catch (err) {
      if (!forcedPlayerClient && isRetryableExtractionError(err.message)) {
        logger.warn(
          { youtubeId, err: err.message },
          `ytstream: seek-restart DASH resolve hit a client/session error, retrying once with player_client=${RETRY_PLAYER_CLIENT}`
        );
        stdout = await runOnce(RETRY_PLAYER_CLIENT);
      } else {
        throw err;
      }
    }

    const urls = String(stdout)
      .trim()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^https?:\/\//i.test(l));

    const classify = (url) => {
      try {
        const mime = new URL(url).searchParams.get('mime') || '';
        if (mime.startsWith('video/')) return 'video';
        if (mime.startsWith('audio/')) return 'audio';
      } catch {
        /* fall through to null below */
      }
      return null;
    };

    const videoUrl = urls.find((u) => classify(u) === 'video');
    const audioUrl = urls.find((u) => classify(u) === 'audio');
    if (!videoUrl || !audioUrl) {
      throw new Error(
        `resolveDashUrlsForSeek: expected one video + one audio URL, got ${urls.length} ` +
        `(video=${!!videoUrl} audio=${!!audioUrl})`
      );
    }
    return { videoUrl, audioUrl };
  }

  /**
   * `-headers` value for ffmpeg fetching a resolved googlevideo URL
   * directly (seek-restart, mode=ffmpeg) — mirrors proxyDirectStream's
   * headers. See docs/YTSTREAM_SEEK_FIX.md for vprv=1 URL caveats.
   */
  function buildFfmpegUpstreamHeaders(cookieHeader) {
    let headers = `User-Agent: ${UPSTREAM_USER_AGENT}\r\nReferer: https://youtube.com\r\nOrigin: https://youtube.com\r\n`;
    if (cookieHeader) headers += `Cookie: ${cookieHeader}\r\n`;
    return headers;
  }

  // ffArgs for a direct-URL pass embeds the full YouTube auth cookie
  // (session tokens like __Secure-3PSID/LOGIN_INFO) inside a -headers blob -
  // logging ffArgs verbatim for debugging would leak live account
  // credentials into the log file. Only used for the logged copy; the real
  // ffArgs passed to spawn() must keep the actual cookie intact.
  function redactFfArgsForLogging(args) {
    return args.map((arg) => (
      typeof arg === 'string' && /Cookie:/i.test(arg)
        ? arg.replace(/Cookie:\s*[^\r\n]*/gi, 'Cookie: [REDACTED]')
        : arg
    ));
  }

  // Diagnostic-only: names of incoming request headers never worth logging
  // verbatim, in case a caller ever attaches one of these to a plain media
  // URL (unexpected for /api/ytstream, which is intentionally unauthenticated
  // - .strm files embed it as a bare URL - but redact defensively anyway).
  const SENSITIVE_INCOMING_HEADER_NAMES = new Set(['cookie', 'authorization', 'proxy-authorization', 'x-access-token']);

  /**
   * Redacts sensitive header values before the 'incoming request' log call
   * dumps every header a caller sent, alongside isLikelyMetadataProbeRequest's
   * verdict - lets a real playback request be told apart from other Jellyfin
   * traffic (a library scan/ffprobe, thumbnail preview) from the log alone.
   */
  function redactIncomingHeadersForLogging(headers) {
    const out = {};
    for (const [key, value] of Object.entries(headers || {})) {
      out[key] = SENSITIVE_INCOMING_HEADER_NAMES.has(key.toLowerCase()) ? '[REDACTED]' : value;
    }
    return out;
  }

  /**
   * Streams a resolved googlevideo.com URL back through this server rather
   * than a bare 302 redirect. A raw redirect would have the player fetch
   * googlevideo.com directly with none of the cookies/Referer/User-Agent
   * yt-dlp used to resolve the URL — age-restricted or members-only videos
   * get rejected. Proxying keeps this server in the loop, and forwards
   * Range so `mode=direct` stays seekable.
   */
  function proxyDirectStream(targetUrl, req, res, cookieHeader, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
      let parsed;
      try {
        parsed = new URL(targetUrl);
      } catch {
        reject(new Error('Invalid upstream URL'));
        return;
      }

      const mod = parsed.protocol === 'https:' ? https : http;
      const headers = {
        'User-Agent': UPSTREAM_USER_AGENT,
        Referer: 'https://youtube.com',
        Origin: 'https://youtube.com',
      };
      if (cookieHeader) headers.Cookie = cookieHeader;
      if (req.headers.range) headers.Range = req.headers.range;

      let isAbortedByClient = false;
      const upstreamReq = mod.get(parsed, { headers, timeout: 25000 }, (upstreamRes) => {
        const status = upstreamRes.statusCode || 502;

        if ([301, 302, 303, 307, 308].includes(status) && upstreamRes.headers.location && redirectsLeft > 0) {
          upstreamRes.resume();
          proxyDirectStream(new URL(upstreamRes.headers.location, parsed).href, req, res, cookieHeader, redirectsLeft - 1)
            .then(resolve)
            .catch(reject);
          return;
        }

        if (status >= 400) {
          upstreamRes.resume();
          const err = new Error(`Upstream returned HTTP ${status}`);
          err.status = status;
          reject(err);
          return;
        }

        res.status(status);
        ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'etag', 'last-modified']
          .forEach((h) => {
            if (upstreamRes.headers[h]) res.set(h, upstreamRes.headers[h]);
          });

        upstreamRes.pipe(res);
        upstreamRes.on('error', (err) => {
          if (isAbortedByClient || err.code === 'ECONNRESET' || err.message === 'aborted') {
            resolve();
          } else {
            reject(err);
          }
        });
        res.on('finish', resolve);
      });

      upstreamReq.on('error', (err) => {
        if (isAbortedByClient || err.code === 'ECONNRESET' || err.message === 'aborted') {
          resolve();
        } else {
          reject(err);
        }
      });

      upstreamReq.on('timeout', () => {
        upstreamReq.destroy();
        reject(new Error('Upstream request timed out'));
      });

      res.on('close', () => {
        if (!res.writableEnded) {
          isAbortedByClient = true;
          upstreamReq.destroy();
          resolve();
        }
      });
    });
  }

  /**
   * mode=direct-pipe: fetches the resolved format through yt-dlp's own
   * process instead of resolving a URL (-g) and proxying it separately.
   * Sidesteps googlevideo's vprv=1 session-bound URLs, which 403 when
   * fetched by a different process than the one that resolved them —
   * yt-dlp fetching within its own resolving process isn't subject to
   * that (same reason the DASH pipe modes never hit it).
   *
   * A separate, explicitly-selected mode, not an automatic fallback inside
   * mode=direct: plain direct's proxy fetch just fails on a 403; pick this
   * mode for the more resilient (but Range-incapable) behavior instead.
   * Not a retry with a different player_client either — android's format
   * list doesn't include the legacy progressive itag (18/360p), so it can
   * never satisfy a progressive-format request.
   *
   * Stays "direct" in spirit: one yt-dlp child process, zero ffmpeg. Trade-
   * off: a live sequential pipe, not byte-range seekable, so a real
   * mid-video seek forces a restart from 0.
   *
   * calculatedLength: a genuine `206` needs a real `Content-Range` with a
   * concrete end byte, which this unbounded pipe doesn't have. It CAN
   * honestly claim the opening request (no Range, or one starting at byte
   * 0) since that's the same full-body response this always sends anyway —
   * when calculatedLength is on, that case gets a real `Content-Length`
   * (plus 206/Content-Range if asked) from the same duration x bitrate
   * estimate mode=ffmpeg uses. A non-zero Range start (a real seek) isn't
   * representable this way and falls through to the unbounded response.
   */
  async function pipeDirectStreamViaYtDlp(youtubeId, config, quality, qualityStrictness, playerClient, calculatedLength, req, res, streamId) {
    let lengthEstimate = null;
    if (calculatedLength) {
      try {
        const height = resolveQualityHeight(quality);
        const durationSeconds = await getVideoDurationSeconds(youtubeId, config);
        lengthEstimate = Math.ceil(durationSeconds * estimateBitrateBytesPerSecond(height));
      } catch (err) {
        logger.warn({ err, youtubeId }, 'ytstream: direct-pipe calculatedLength estimate failed; falling back to an unbounded response');
      }
    }

    const rangeHeader = req.headers.range;
    const range = lengthEstimate && rangeHeader ? parseByteRange(rangeHeader, lengthEstimate) : null;
    // The only case an honest Content-Length/206 applies to - see doc
    // comment. Anything else (no estimate, or a real non-zero-start seek)
    // falls through to the plain unbounded response below unchanged.
    const isOpeningRequest = !!lengthEstimate && (!rangeHeader || (range && !range.invalid && range.start === 0));

    if (lengthEstimate && req.method === 'HEAD') {
      res.set({ 'Accept-Ranges': 'bytes', 'Content-Length': String(lengthEstimate) });
      res.status(200).end();
      if (streamId) untrackStream(streamId, 'completed');
      return;
    }

    return new Promise((resolve, reject) => {
      const format = getDirectFormatSelector(quality, qualityStrictness);
      const args = [
        ...buildBaseArgs(config, { playerClient }),
        '-f', format,
        '-o', '-',
        '--no-playlist',
        '--no-warnings',
        `https://youtube.com/watch?v=${youtubeId}`,
      ];
      logger.info(
        { youtubeId, format, quality, playerClient, calculatedLength: !!lengthEstimate, isOpeningRequest },
        'ytstream: piping direct stream via yt-dlp (mode=direct-pipe)'
      );

      const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      registerChildProcess(proc);

      let stderr = '';
      proc.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk.toString()).slice(-8000);
      });

      let settled = false;
      let headersSent = false;

      const onClientGone = () => {
        if (settled) return;
        settled = true;
        killChildProcess(proc, 'client-disconnected');
        if (streamId) untrackStream(streamId, 'client-disconnected');
        resolve();
      };
      res.once('close', onClientGone);

      // Wired up for the Streaming page's stop button - mirrors
      // streamViaFfmpeg's own entry.stop wiring.
      if (streamId) {
        const entry = activeStreams.get(streamId);
        if (entry) {
          entry.stop = () => {
            if (settled) return;
            settled = true;
            res.removeListener('close', onClientGone);
            killChildProcess(proc, 'manual-stop');
            untrackStream(streamId, 'manual-stop');
            try { if (!res.writableEnded) res.end(); } catch { /* ignore */ }
            resolve();
          };
        }
      }

      proc.stdout.once('data', () => {
        if (!res.headersSent) {
          headersSent = true;
          if (streamId) {
            const entry = activeStreams.get(streamId);
            if (entry) entry.state = 'active';
          }
          if (isOpeningRequest) {
            res.set({ 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes', 'Content-Length': String(lengthEstimate) });
            if (rangeHeader) {
              res.set('Content-Range', `bytes 0-${lengthEstimate - 1}/${lengthEstimate}`);
              res.status(206);
            } else {
              res.status(200);
            }
          } else {
            res.removeHeader('Accept-Ranges'); // no range/seek support on this path - see doc comment
            res.set({ 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' });
            res.status(200);
          }
        }
      });
      if (streamId) {
        proc.stdout.on('data', (chunk) => {
          const entry = activeStreams.get(streamId);
          if (entry) {
            entry.bytesTransferred += chunk.length;
            entry.lastActivityAt = Date.now();
          }
        });
      }
      proc.stdout.pipe(res);

      proc.once('error', (err) => {
        if (settled) return;
        settled = true;
        res.removeListener('close', onClientGone);
        if (streamId) untrackStream(streamId, 'error', err.message);
        reject(err);
      });

      proc.once('exit', (code) => {
        if (settled) return;
        settled = true;
        res.removeListener('close', onClientGone);
        if (code === 0 || headersSent) {
          if (streamId) untrackStream(streamId, 'completed');
          resolve();
        } else {
          const message = stderr.trim() || `yt-dlp exited with code ${code}`;
          if (streamId) untrackStream(streamId, 'error', message);
          reject(new Error(message));
        }
      });
    });
  }

  /**
   * mode=direct-redirect: resolves a playback URL via yt-dlp, same as
   * mode=direct, but sends the player a 302 straight to it instead of
   * Youtarr fetching/proxying the bytes - real bandwidth/CPU savings, at a
   * real reliability cost:
   *
   * - No cookies/Referer/User-Agent travel with the redirect - age-
   *   restricted or members-only videos fail outright for a player that
   *   can't supply them, where mode=direct's proxied fetch works.
   * - A vprv=1 session-bound URL is, if anything, more likely to 403 here:
   *   the fetch comes from the player's own client/network, a bigger
   *   mismatch from the resolving session than Youtarr's own proxy fetch.
   * - Whatever happens after the redirect is invisible to Youtarr - a
   *   failure there never reaches this server's logs.
   *
   * No fallback on any of the above - this either works as described or
   * the player's own request fails on its own.
   */
  async function redirectToDirectUrl(youtubeId, config, quality, qualityStrictness, playerClient, req, res) {
    // Not a live/trackable session (no bytes pass through Youtarr at all,
    // see doc comment) - just a StreamHistory audit row, so the request
    // and its result (redirected, or a resolve failure) at least show up
    // somewhere instead of this mode being completely unaccounted for.
    const streamId = crypto.randomUUID();
    const historyEntry = {
      streamId,
      mode: 'direct-redirect',
      youtubeId,
      quality,
      clientIp: resolveClientIp(req),
      userAgent: req.headers['user-agent'] || null,
      startedAt: Date.now(),
    };
    persistStreamHistoryStart(historyEntry);
    try {
      const url = await resolveDirectUrl(youtubeId, config, quality, playerClient, qualityStrictness);
      logger.info({ youtubeId, quality }, 'ytstream: redirecting player directly to resolved URL (mode=direct-redirect)');
      res.redirect(302, url);
      persistStreamHistoryEnd(historyEntry, 'redirected', null);
    } catch (err) {
      persistStreamHistoryEnd(historyEntry, 'error', err.message);
      throw err;
    }
  }

  /**
   * Spawns one HLS encode pass (yt-dlp video + yt-dlp audio + ffmpeg),
   * writing segments from `startSegmentIndex` onward into `session.dir`
   * instead of piping live (video/audio fetch mechanics mirror
   * streamViaFfmpeg's live pipeline; only the ffmpeg output stage differs).
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
    const effectiveSeek = (session.calculatedLength || isLocalSource)
      ? (startSegmentIndex > 0 ? startSegmentIndex * HLS_SEGMENT_DURATION_SECONDS : null)
      : (seekSeconds || null);

    // mode=hls-tap: only a genuine, un-seeked play from the session's very
    // start gets tapped - isInitialPass is only true on the original
    // network-sourced pass, never a hot-swapped/local-source one.
    // tapAttempted is claimed immediately so a same-pass fallback/retry
    // doesn't treat itself as a second tap - it just overwrites
    // tapTempPath, safe since no bytes have reached the client yet.
    const tapActive = session.tapEnabled && !session.tapAttempted && isInitialPass && startSegmentIndex === 0 && !effectiveSeek;
    if (tapActive) session.tapAttempted = true;

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

    const encoder = transcode === 'h264' ? buildVideoEncoderArgs(hw, resolveQualityHeight(quality), tier, (config.ytstream || {}).vaapiQuality) : null;

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

      if (tapActive) {
        // mode=hls-tap: a second, independent OUTPUT from the SAME yt-dlp
        // pipes - untouched (-c copy), no second network pull. Must be
        // declared as its own complete output BEFORE the primary HLS
        // output's -map/-vf/-c:v/-c:a block: an earlier version declared it
        // AFTER, which attached those options to the tap output instead and
        // produced a real ffmpeg error ("Filtering and streamcopy cannot be
        // used together") that killed the whole session, not just the tap.
        // Finalized/discarded by the dedicated close listener below.
        ffArgs.push('-map', '0:v:0', '-map', '1:a:0?', '-c', 'copy', session.tapTempPath);
      }

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
    ensureHlsIdleReaper();

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
      // Same write-after-close EPIPE hazard as streamViaFfmpeg's live pipe —
      // see the comment there for why every stream needs a listener.
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

    // mode=hls-tap finalization - a SEPARATE close listener from the main
    // one below: a superseded pass's incomplete tap file still needs
    // discarding even when the main handler's isCurrentPass() guard skips
    // everything else. Only treats the tap file as complete on a clean
    // close (code 0, no kill signal, not mid-teardown) for the pass that
    // owns it - anything else discards it rather than risk finalizing a
    // corrupt partial file (a -c copy MP4's moov atom only flushes clean).
    if (tapActive) {
      const tapOwnerGeneration = myGeneration;
      const tapTempPathForThisPass = session.tapTempPath;
      ff.on('close', (code, signal) => {
        const { finalizeTapOutput, discardTapOutput } = require('../modules/ytstreamTapFinalizer');
        const cleanCompletion = !session.destroying
          && session.passGeneration === tapOwnerGeneration
          && code === 0
          && !isKilledByUs(signal);
        if (cleanCompletion) {
          finalizeTapOutput({ youtubeId, tempPath: tapTempPathForThisPass, finalPath: session.tapFinalPath })
            .then((finalPath) => {
              if (finalPath) {
                session.usingCachedSource = true;
                session.cachedFilePath = finalPath;
                maybeFinalizeTsToMp4(youtubeId, finalPath, 'hls-tap');
              }
            })
            .catch((err) => logger.warn({ err, sessionKey, youtubeId }, 'ytstream: hls-tap finalize failed'));
        } else {
          discardTapOutput({ youtubeId, tempPath: tapTempPathForThisPass });
        }
      });
    }

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
      logger.debug(
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
   * ytstreamBufferFetch.js: mode=hls-tap's tap shares the live encode's
   * process and is bound by its throughput; this fetch has no such
   * ceiling). Fire-and-forget - callers poll session.bufferedSeconds via
   * waitForBufferedThrough before reading the growing file.
   */
  function startHlsBufferFetch(session) {
    const { isBufferFetchActive, markBufferFetchStarted, markBufferFetchFinished, parseBufferedSeconds } = require('../modules/ytstreamBufferFetch');
    const { finalizeTapOutput, discardTapOutput } = require('../modules/ytstreamTapFinalizer');
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

    const { videoFormat, audioFormat } = getDashFormatSelectors(quality, qualityStrictness);
    const watchUrl = `https://youtube.com/watch?v=${youtubeId}`;
    const commonYtArgs = [...buildBaseArgs(config, {}), '-o', '-', '--no-playlist', '--no-warnings'];
    const ytVideoArgs = [...commonYtArgs, '-f', videoFormat, watchUrl];
    const ytAudioArgs = [...commonYtArgs, '-f', audioFormat, watchUrl];

    logger.info(
      { sessionKey: session.sessionKey, youtubeId, quality, tempPath: session.bufferTempPath },
      'ytstream: starting independent hls-buffer fetch (network-bound, decoupled from the live HLS serve)'
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
        logger.debug({ sessionKey: session.sessionKey, youtubeId, bufferedSeconds: seconds }, 'ytstream: hls-buffer fetch progress');
      }
    });

    const isKilledByUs = (signal) => signal === 'SIGTERM' || signal === 'SIGKILL';
    // bufferDir holds only this one temp file (see the caller's doc comment
    // on why it's a dedicated directory, not session.dir) - safe to remove
    // wholesale once the file has been moved out (finalizeTapOutput's
    // rename/copy) or unlinked (discardTapOutput), whichever happened.
    const cleanupBufferDir = () => {
      if (session.bufferDir) fs.rm(session.bufferDir, { recursive: true, force: true }, () => {});
    };
    let settled = false;
    const finish = (ok, message) => {
      if (settled) return;
      settled = true;
      markBufferFetchFinished(youtubeId);
      if (!ok) {
        logger.warn({ sessionKey: session.sessionKey, youtubeId, message }, 'ytstream: hls-buffer fetch failed; discarding partial file');
        session.bufferFetchFailed = true;
        discardTapOutput({ youtubeId, tempPath: session.bufferTempPath, sourceLabel: 'hls-buffer' });
        cleanupBufferDir();
        return;
      }
      finalizeTapOutput({
        youtubeId,
        tempPath: session.bufferTempPath,
        finalPath: session.bufferFinalPath,
        sourceLabel: 'hls-buffer',
        skipVideoUpsert: session.bufferUntracked === true,
      })
        .then((finalPath) => {
          if (finalPath) {
            session.usingCachedSource = true;
            session.cachedFilePath = finalPath;
            session.bufferFetchDone = true;
            logger.info(
              { sessionKey: session.sessionKey, youtubeId, finalPath, untracked: session.bufferUntracked === true },
              session.bufferUntracked
                ? 'ytstream: hls-buffer fetch finalized into the untracked-video cache'
                : 'ytstream: hls-buffer fetch finalized as permanent download'
            );
            maybeFinalizeTsToMp4(youtubeId, finalPath, 'hls-buffer');
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
          cleanupBufferDir();
        })
        .catch((err) => {
          logger.warn({ err, sessionKey: session.sessionKey, youtubeId }, 'ytstream: hls-buffer finalize failed');
          session.bufferFetchFailed = true;
          cleanupBufferDir();
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
   * mode=raw-buffer: resolves the same tracked-vs-untracked final
   * destination mode=hls-buffer's bufferEnabled block computes -
   * deliberately duplicated, not shared, so nothing here regresses that
   * already-working path.
   * @returns {Promise<{finalPath: string, untracked: boolean}>}
   */
  async function resolveRawBufferDestination(youtubeId) {
    try {
      const video = await models.Video.findOne({
        where: { youtubeId },
        attributes: ['is_strm', 'filePath'],
      });
      if (video && video.is_strm === true && video.filePath) {
        const targetDir = path.dirname(video.filePath);
        const fileStem = path.basename(video.filePath, path.extname(video.filePath));
        return { finalPath: path.join(targetDir, `${fileStem}.ts`), untracked: false };
      }
    } catch (err) {
      logger.warn({ err, youtubeId }, 'ytstream: raw-buffer could not resolve STRM target; using the untracked cache instead');
    }
    fs.mkdirSync(HLS_UNTRACKED_BUFFER_CACHE_DIR, { recursive: true });
    return { finalPath: getUntrackedBufferCachePath(youtubeId), untracked: true };
  }

  /**
   * mode=raw-buffer: the same yt-dlp+ffmpeg(-c copy, mpegts) pipeline
   * startHlsBufferFetch uses, adapted to write onto a plain registry entry
   * (ytstreamRawBufferFetch.js) instead of a live HLS session object - this
   * mode never creates one. No `-progress` tracking either: this mode's
   * reader just polls the growing file's byte size directly
   * (pipeGrowingRawRange), one less moving part.
   *
   * Fire-and-forget; the caller immediately polls the returned entry via
   * tryServeGrowingRawFile.
   * @returns {object} the newly-registered entry
   */
  function startRawBufferFetch(youtubeId, { quality, qualityStrictness, config, finalPath, untracked, durationSeconds, lengthEstimate }) {
    const { finalizeTapOutput, discardTapOutput } = require('../modules/ytstreamTapFinalizer');
    const { registerRawBufferFetch, clearRawBufferFetch } = require('../modules/ytstreamRawBufferFetch');

    const bufferDir = path.join(resolveHlsBaseDir(), `raw-${youtubeId}-${crypto.randomBytes(4).toString('hex')}`);
    fs.mkdirSync(bufferDir, { recursive: true });
    const tempPath = path.join(bufferDir, 'buffer.ts');

    const entry = {
      youtubeId,
      tempPath,
      finalPath,
      bufferDir,
      durationSeconds,
      lengthEstimate,
      status: 'running',
      finalSize: null,
      error: null,
    };
    registerRawBufferFetch(youtubeId, entry);

    const { videoFormat, audioFormat } = getDashFormatSelectors(quality, qualityStrictness);
    const watchUrl = `https://youtube.com/watch?v=${youtubeId}`;
    const commonYtArgs = [...buildBaseArgs(config, {}), '-o', '-', '--no-playlist', '--no-warnings'];
    const ytVideoArgs = [...commonYtArgs, '-f', videoFormat, watchUrl];
    const ytAudioArgs = [...commonYtArgs, '-f', audioFormat, watchUrl];

    logger.info(
      { youtubeId, quality, tempPath, finalPath, untracked },
      'ytstream: starting raw-buffer fetch (raw copy-mux, no transcode, no HLS session)'
    );

    ensureProcessExitHandlers();

    const ytVideo = spawn('yt-dlp', ytVideoArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    const ytAudio = spawn('yt-dlp', ytAudioArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    const ffArgs = [
      '-loglevel', 'error',
      '-thread_queue_size', '4096', '-i', 'pipe:3',
      '-thread_queue_size', '4096', '-i', 'pipe:4',
      '-map', '0:v:0', '-map', '1:a:0?', '-sn', '-dn', '-c', 'copy',
      '-f', 'mpegts',
      tempPath,
    ];
    const ff = spawn('ffmpeg', ffArgs, { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
    registerChildProcess(ytVideo);
    registerChildProcess(ytAudio);
    registerChildProcess(ff);
    ff.stdout.resume(); // nothing writes here (no -progress) - just drain it

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

    const isKilledByUs = (signal) => signal === 'SIGTERM' || signal === 'SIGKILL';
    const cleanupBufferDir = () => { fs.rm(bufferDir, { recursive: true, force: true }, () => {}); };

    let settled = false;
    const finish = (ok, message) => {
      if (settled) return;
      settled = true;
      if (!ok) {
        logger.warn({ youtubeId, message }, 'ytstream: raw-buffer fetch failed; discarding partial file');
        entry.status = 'failed';
        entry.error = message;
        discardTapOutput({ youtubeId, tempPath, sourceLabel: 'raw-buffer' });
        cleanupBufferDir();
        clearRawBufferFetch(youtubeId);
        return;
      }
      finalizeTapOutput({ youtubeId, tempPath, finalPath, sourceLabel: 'raw-buffer', skipVideoUpsert: untracked })
        .then((resolvedFinalPath) => {
          if (resolvedFinalPath) {
            entry.finalPath = resolvedFinalPath;
            try {
              entry.finalSize = fs.statSync(resolvedFinalPath).size;
            } catch (err) {
              // stat failed - entry.finalSize stays null, waiters that
              // already committed to a Content-Length just keep using
              // lengthEstimate instead (see tryServeGrowingRawFile).
            }
            entry.status = 'done';
            // durationSeconds/lengthEstimate included so a truncated fetch
            // (ffmpeg exiting 0 - a "clean" EOF - after only one yt-dlp
            // pipe closed early, not a real end-of-video) is visible here:
            // compare finalSize's implied bitrate against lengthEstimate,
            // or eyeball whether durationSeconds looks far longer than
            // finalSize could plausibly hold. See
            // [[ytstream_raw_buffer_and_segment_bug]].
            logger.info(
              { youtubeId, finalPath: resolvedFinalPath, untracked, finalSize: entry.finalSize, durationSeconds: entry.durationSeconds, lengthEstimate: entry.lengthEstimate },
              'ytstream: raw-buffer fetch finalized'
            );
            maybeFinalizeTsToMp4(youtubeId, resolvedFinalPath, 'raw-buffer');
          } else {
            entry.status = 'failed';
            entry.error = 'finalize failed';
          }
          cleanupBufferDir();
          clearRawBufferFetch(youtubeId);
        })
        .catch((err) => {
          logger.warn({ err, youtubeId }, 'ytstream: raw-buffer finalize failed');
          entry.status = 'failed';
          entry.error = err.message;
          cleanupBufferDir();
          clearRawBufferFetch(youtubeId);
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
      if (code === 0 && !isKilledByUs(signal)) finish(true);
      else finish(false, ffErr || `ffmpeg exited with code ${code}, signal ${signal}`);
    });

    return entry;
  }

  // A single MPEG-TS "null" packet: sync byte 0x47, PID 0x1FFF (the
  // reserved stuffing PID every TS demuxer must recognize and discard),
  // adaptation_field_control "payload only", continuity_counter 0 (PID
  // 0x1FFF is excluded from continuity checking, so a fixed 0 repeats
  // safely). 188 bytes total, the fixed TS packet size.
  const TS_NULL_PACKET = Buffer.concat([Buffer.from([0x47, 0x1f, 0xff, 0x10]), Buffer.alloc(184, 0xff)]);

  /**
   * A `length`-byte buffer of repeated TS_NULL_PACKET, used to pad a
   * raw-buffer response out to its promised Content-Length when the real
   * file finishes shorter than the pre-fetch estimate. Plain zero bytes
   * (the previous behavior) are NOT safe for MPEG-TS specifically: a
   * demuxer reading raw zeros after real content ends sees no valid TS
   * sync bytes, not "safe to ignore" - suspected of corrupting a client's
   * in-stream duration detection (see [[ytstream_raw_buffer_and_segment_bug]]).
   * Real TS null packets ARE "safe to ignore" in this format, so this keeps
   * the byte count exactly correct while staying invisible to any
   * spec-compliant reader. The trailing remainder shorter than one full
   * 188-byte packet stays zero-filled - inconsequential at that size.
   */
  function buildTsPaddingBuffer(length) {
    const buf = Buffer.alloc(length);
    const fullPackets = Math.floor(length / TS_NULL_PACKET.length);
    for (let i = 0; i < fullPackets; i++) {
      TS_NULL_PACKET.copy(buf, i * TS_NULL_PACKET.length);
    }
    return buf;
  }

  /**
   * mode=raw-buffer: streams `[start, end]` (end === null means "unknown
   * total, follow the file's growth until the fetch finishes") off
   * `getSourcePath()`'s current target, waiting for bytes not yet written
   * instead of stopping at the file's size when the read began - the gap
   * tryServeCachedVideoFile deliberately doesn't cover. Re-resolves
   * getSourcePath() each iteration so a mid-stream flip from temp to
   * finalized path is picked up seamlessly.
   */
  async function pipeGrowingRawRange(res, getSourcePath, start, end, entry, streamId) {
    let aborted = false;
    res.on('close', () => { aborted = true; });

    let fd = null;
    let currentPath = null;
    let position = start;
    let frontierWaitMs = 0;
    let frontierHits = 0;
    let lastFrontierLogAt = 0;
    const pipeStarted = Date.now();
    const chunkSize = 1 << 20; // 1 MiB
    const buffer = Buffer.alloc(chunkSize);
    let outcome = 'unknown';
    try {
      while (!aborted && (end === null || position <= end)) {
        const targetPath = getSourcePath();
        if (fd === null || targetPath !== currentPath) {
          if (fd !== null) { await fd.close().catch(() => {}); fd = null; }
          try {
            fd = await fs.promises.open(targetPath, 'r');
            logger.debug({ youtubeId: entry.youtubeId, targetPath, position }, 'ytstream: raw-buffer pipe opened source file');
            currentPath = targetPath;
          } catch (err) {
            // Not created yet (first tick), or a transient race right as
            // finalize renames tempPath -> finalPath - keep retrying until
            // the fetch settles one way or the other.
            if (entry.status === 'failed') { outcome = 'fetch-failed-before-open'; break; }
            await new Promise((resolve) => setTimeout(resolve, HLS_READY_POLL_INTERVAL_MS));
            continue;
          }
        }
        const toRead = end === null ? chunkSize : Math.min(chunkSize, end - position + 1);
        const { bytesRead } = await fd.read(buffer, 0, toRead, position);
        if (bytesRead > 0) {
          position += bytesRead;
          if (streamId) {
            const streamEntry = activeStreams.get(streamId);
            if (streamEntry) {
              streamEntry.bytesTransferred += bytesRead;
              streamEntry.lastActivityAt = Date.now();
            }
          }
          if (!res.write(buffer.subarray(0, bytesRead))) {
            await new Promise((resolve) => res.once('drain', resolve));
          }
          continue;
        }
        // Hit the current write frontier - the local file has no more bytes
        // yet at this offset. Throttled (not per-poll-tick) debug logging so
        // a genuinely stuck/slow catch-up is visible without spamming once
        // per HLS_READY_POLL_INTERVAL_MS.
        frontierHits += 1;
        if (Date.now() - lastFrontierLogAt > 2000) {
          lastFrontierLogAt = Date.now();
          let frontierSize = null;
          try { frontierSize = (await fs.promises.stat(targetPath)).size; } catch (err) { /* ignore - just for the log */ }
          logger.debug(
            { youtubeId: entry.youtubeId, position, end, frontierSize, entryStatus: entry.status, frontierHits, waitingMs: Date.now() - pipeStarted },
            'ytstream: raw-buffer pipe caught up to the write frontier; waiting for more bytes'
          );
        }
        if (entry.status === 'done') {
          if (end !== null && position <= end) {
            // The real finished file is shorter than the duration x bitrate
            // estimate this response already promised via Content-Length -
            // pad with valid MPEG-TS null packets (see buildTsPaddingBuffer's
            // doc comment for why NOT plain zero bytes) so the byte count
            // still matches what was promised, without confusing a TS
            // demuxer reading past the real content.
            logger.debug({ youtubeId: entry.youtubeId, position, end, padBytes: end - position + 1 }, 'ytstream: raw-buffer padding response with TS null packets - real file ended shorter than the length estimate');
            res.write(buildTsPaddingBuffer(end - position + 1));
            position = end + 1;
          }
          outcome = 'fetch-done';
          break;
        }
        if (entry.status === 'failed') { outcome = 'fetch-failed-mid-stream'; break; } // die mid-stream; end early, no clean error signal possible once headers are sent
        const waitTickStart = Date.now();
        await new Promise((resolve) => setTimeout(resolve, HLS_READY_POLL_INTERVAL_MS));
        frontierWaitMs += Date.now() - waitTickStart;
      }
      if (aborted) outcome = 'client-aborted';
      else if (end !== null && position > end && outcome === 'unknown') outcome = 'reached-requested-end';
    } finally {
      if (fd !== null) await fd.close().catch(() => {});
      if (!aborted) res.end();
      logger.debug(
        { youtubeId: entry.youtubeId, outcome, bytesSent: position - start, totalDurationMs: Date.now() - pipeStarted, frontierWaitMs, frontierHits, finalEntryStatus: entry.status },
        'ytstream: raw-buffer pipe finished'
      );
    }
  }

  /**
   * mode=raw-buffer: serves a Range request against a still-growing (or
   * finished) raw download, waiting for bytes not yet on disk instead of
   * erroring - tryServeCachedVideoFile can't be reused as-is (it trusts a
   * single upfront fs.stat as the final size forever, no wait logic).
   * @returns {Promise<boolean>} true if a response was sent.
   */
  async function tryServeGrowingRawFile(req, res, entry, streamId) {
    const totalHint = entry.finalSize ?? entry.lengthEstimate ?? null;
    const rangeHeader = req.headers.range;
    const range = totalHint ? parseByteRange(rangeHeader, totalHint) : null;

    logger.debug(
      { youtubeId: entry.youtubeId, method: req.method, rangeHeader: rangeHeader || null, totalHint, entryStatus: entry.status, tempPath: entry.tempPath },
      'ytstream: raw-buffer serving request'
    );

    if (range && range.invalid) {
      logger.warn({ youtubeId: entry.youtubeId, rangeHeader, totalHint }, 'ytstream: raw-buffer Range unsatisfiable against the length estimate (416)');
      res.status(416).set('Content-Range', `bytes */${totalHint}`).end();
      return true;
    }

    const start = range ? range.start : 0;
    // null means "unknown total - stream until the fetch finishes", only
    // reachable when totalHint itself is null (duration lookup failed).
    const end = range ? range.end : (totalHint ? totalHint - 1 : null);

    // Wait for the first byte this response needs to exist (or the fetch to
    // fail) before committing to any status code/headers below - once bytes
    // start flowing, those can no longer change.
    const sourcePath = () => (entry.status === 'done' ? entry.finalPath : entry.tempPath);
    const waitStarted = Date.now();
    const deadline = waitStarted + RAW_BUFFER_WAIT_TIMEOUT_MS;
    for (;;) {
      if (entry.status === 'failed') {
        logger.warn({ youtubeId: entry.youtubeId, start, end, error: entry.error }, 'ytstream: raw-buffer fetch failed while a response was waiting for its first byte');
        res.status(502).end();
        return true;
      }
      try {
        const stat = await fs.promises.stat(sourcePath());
        if (stat.size > start || entry.status === 'done') break;
      } catch (err) {
        // Not created yet - keep waiting.
      }
      if (Date.now() > deadline) {
        logger.warn({ youtubeId: entry.youtubeId, tempPath: entry.tempPath, start, end, waitedMs: Date.now() - waitStarted }, 'ytstream: raw-buffer wait for first byte timed out');
        res.status(504).end();
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, HLS_READY_POLL_INTERVAL_MS));
    }
    const firstByteWaitMs = Date.now() - waitStarted;
    if (firstByteWaitMs > 500) {
      logger.debug({ youtubeId: entry.youtubeId, start, end, firstByteWaitMs, entryStatus: entry.status }, 'ytstream: raw-buffer first byte became available');
    }

    // The fetch already finished by the time we got here (a fully-cached
    // replay, or a very fast fetch) - if this Range asked for bytes past the
    // real final size (the length estimate overshot), that's a real 416,
    // same as tryServeCachedVideoFile's own out-of-range handling.
    if (entry.status === 'done') {
      let finalSize;
      try {
        finalSize = (await fs.promises.stat(sourcePath())).size;
      } catch (err) {
        logger.warn({ err, youtubeId: entry.youtubeId, finalPath: entry.finalPath }, 'ytstream: raw-buffer stat of finished file failed');
        res.status(502).end();
        return true;
      }
      if (start >= finalSize) {
        logger.warn({ youtubeId: entry.youtubeId, start, finalSize, lengthEstimate: entry.lengthEstimate }, 'ytstream: raw-buffer Range start is past the real final size (length estimate overshot) - 416');
        res.status(416).set('Content-Range', `bytes */${finalSize}`).end();
        return true;
      }
    }

    res.status(range ? 206 : 200).set({
      'Content-Type': 'video/mp2t',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    });
    if (end !== null) {
      res.set('Content-Length', String(end - start + 1));
      if (range) res.set('Content-Range', `bytes ${start}-${end}/${totalHint}`);
    }
    logger.debug(
      { youtubeId: entry.youtubeId, status: range ? 206 : 200, start, end, contentLength: end !== null ? end - start + 1 : null, entryStatus: entry.status },
      'ytstream: raw-buffer response headers committed'
    );
    if (req.method === 'HEAD') { res.end(); return true; }

    await pipeGrowingRawRange(res, sourcePath, start, end, entry, streamId);
    return true;
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
   * direct-URL resolve+fetch attempt (still used by mode=ffmpeg's seek
   * path) - googlevideo's vprv=1 URLs 403 when fetched by a bare ffmpeg
   * HTTP client, so that attempt would only add a guaranteed-to-fail
   * round trip before falling through to useSectionedPipe anyway.
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
    logger.debug(
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
    logger.debug(
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
      const targetSeconds = segmentIndex * HLS_SEGMENT_DURATION_SECONDS;
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
      const Video = require('../models/video');
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
   * calculatedLength only: the playlist declares every segment upfront, but
   * only a forward-encoding window exists on disk at any moment. Called
   * when a requested segment is missing — gives the running pass a brief
   * grace window to reach it naturally (common sequential playback), then
   * restarts the forward encode at that segment's boundary.
   */
  async function ensureHlsSegmentAvailable(session, targetIndex, filePath) {
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

    // The pass currently running is already working toward this exact
    // segment - most commonly targetIndex 0 while the session's initial
    // pass hasn't produced its first segment yet (VAAPI/GPU init + yt-dlp
    // resolve often exceeds HLS_SEEK_GRACE_MS). Not a real seek, so
    // restarting would just kill/respawn an identical pass for nothing -
    // keep waiting on the SAME pass with a full cold-start budget instead.
    if (session.activePassStartIndex === targetIndex) {
      logger.debug(
        { sessionKey: session.key, targetIndex },
        'ytstream: grace wait expired but the active pass is already targeting this exact index - waiting longer on the same pass instead of restarting'
      );
      const coldStartDeadline = Date.now() + HLS_READY_TIMEOUT_MS;
      while (Date.now() < coldStartDeadline) {
        if (fs.existsSync(filePath)) return true;
        if (session.destroying) return false;
        await new Promise((resolve) => setTimeout(resolve, HLS_READY_POLL_INTERVAL_MS));
      }
      return fs.existsSync(filePath);
    }

    logger.debug(
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
   * Seek-latency fix: resolves yt-dlp's webpage + player-API extraction
   * for this video exactly once, fire-and-forget, in parallel with the
   * session's first encode pass - never awaited, can't delay first
   * playback. If it finishes before a seek, subsequent yt-dlp children use
   * `--load-info-json` against the cached result instead of re-extracting.
   * If a seek races it (e.g. an immediate Jellyfin resume-from-middle),
   * that seek falls back to full extraction - only session.infoJsonPath
   * being non-null unlocks the fast path.
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
    proc.on('error', (err) => {
      if (session.infoJsonProc === proc) session.infoJsonProc = null;
      logger.warn({ sessionKey, err: err.message }, 'ytstream: yt-dlp info-json warm-up failed to spawn; seek-restarts will keep re-extracting');
    });
    proc.on('close', (code, signal) => {
      if (session.infoJsonProc === proc) session.infoJsonProc = null;
      if (session.destroying) return;
      if (code === 0) {
        session.infoJsonPath = infoJsonPath;
        logger.info({ sessionKey }, 'ytstream: cached yt-dlp extraction info for faster seek-restarts');
      } else if (signal !== 'SIGTERM' && signal !== 'SIGKILL') {
        logger.warn({ sessionKey, code, signal, stderr: stderr.slice(-800) }, 'ytstream: yt-dlp info-json warm-up exited non-zero; seek-restarts will keep re-extracting');
      }
    });
  }

  async function createHlsSessionInternal(sessionKey, { youtubeId, quality, qualityStrictness, transcode, hardwareMode, tuning, container, config, baseUrl, seekSeconds, clientIp, userAgent, calculatedLength, hotSwapToCache, tapEnabled, bufferEnabled }, playerClientOverride) {
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
      // ytstream.instantStart - see maybeStripPlaceholderFromPlaylist. Set
      // true only once the placeholder is actually staged into `dir` below;
      // placeholderStripped flips true the first time a playlist re-fetch
      // (after the real segment0 exists) rewrites it out.
      hasPlaceholder: false,
      placeholderStripped: false,
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
      // mode=hls-tap - see spawnHlsEncodePass's tapActive logic. tapEnabled
      // only ends up true if this video is genuinely still STRM right now -
      // nothing to tap into otherwise. tapAttempted guards against a
      // same-pass fallback/retry claiming a second tap slot.
      tapEnabled: false,
      tapAttempted: false,
      tapTempPath: null,
      tapFinalPath: null,
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
    };

    if (tapEnabled) {
      try {
        const video = await models.Video.findOne({
          where: { youtubeId },
          attributes: ['is_strm', 'filePath'],
        });
        if (video && video.is_strm === true && video.filePath) {
          const targetDir = path.dirname(video.filePath);
          const fileStem = path.basename(video.filePath, path.extname(video.filePath));
          const ext = container === 'ts' ? '.ts' : '.mp4';
          session.tapEnabled = true;
          // Staged under the session's fast local HLS temp dir, NOT the
          // video's library folder - writing the tap continuously to that
          // (likely NAS-backed) location drags the whole shared ffmpeg
          // pipeline down with it, throttling the LIVE stream too
          // (HLS segment production dropped from far-faster-than-realtime
          // to barely realtime). The one-time move to the real library path
          // happens once, in ytstreamTapFinalizer, after encoding finishes.
          // Bonus: an abandoned tap (a hard kill) gets swept up for free by
          // destroyHlsSession's delayed session.dir removal instead of
          // orphaning a file in the library folder.
          session.tapTempPath = path.join(dir, `tap${ext}`);
          session.tapFinalPath = path.join(targetDir, `${fileStem}${ext}`);
        } else {
          // Silent no-op otherwise - this is the ONE log line that explains
          // it, since a session that never sets tapEnabled looks identical
          // in the Streams/History UI to a plain mode=hls session.
          logger.info(
            { sessionKey, youtubeId, videoFound: !!video, isStrm: video ? video.is_strm : null, hasFilePath: video ? !!video.filePath : null },
            'ytstream: hls-tap requested but this video is not currently STRM (or has no filePath) - nothing to tap, session behaves as plain mode=hls'
          );
        }
      } catch (err) {
        logger.warn({ err, sessionKey, youtubeId }, 'ytstream: hls-tap could not resolve STRM target; tap disabled for this session');
      }
    }

    if (bufferEnabled) {
      try {
        const video = await models.Video.findOne({
          where: { youtubeId },
          attributes: ['is_strm', 'filePath'],
        });
        if (video && video.is_strm === true && video.filePath) {
          const targetDir = path.dirname(video.filePath);
          const fileStem = path.basename(video.filePath, path.extname(video.filePath));
          session.bufferEnabled = true;
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
          // Kicked off immediately, fire-and-forget - not awaited - so it
          // gets every bit of this function's remaining setup time
          // (duration lookup, placeholder generation, trackStream) as a
          // free head start before the initial pass's waitForBufferedThrough
          // wait even begins below.
          startHlsBufferFetch(session);
        } else {
          // This video isn't something Youtarr's own library currently owns
          // (no Video row - an untracked NZB `strm` grab, or one disowned
          // via `importStrategy:'untracked'`). No library destination to
          // finalize into, so falls back to Youtarr's own untracked-buffer
          // cache keyed by youtubeId alone: not a library entry, never shows
          // up in Download History - purely a same-video-again speed-up.
          const untrackedCachePath = getUntrackedBufferCachePath(youtubeId);
          const alreadyCached = fs.existsSync(untrackedCachePath);
          session.bufferEnabled = true;
          if (alreadyCached) {
            // A previous play of this same untracked video already finished
            // buffering it. Safe to use from the very first pass too -
            // unlike a fresh fetch (see the initial-pass call site's own
            // comment on why THAT deliberately stays network-sourced), this
            // file is already complete, nothing to wait for.
            session.usingCachedSource = true;
            session.cachedFilePath = untrackedCachePath;
            session.bufferFetchDone = true;
          } else {
            fs.mkdirSync(HLS_UNTRACKED_BUFFER_CACHE_DIR, { recursive: true });
            const bufferDir = path.join(resolveHlsBaseDir(), `buffer-${youtubeId}-${crypto.randomBytes(4).toString('hex')}`);
            fs.mkdirSync(bufferDir, { recursive: true });
            session.bufferDir = bufferDir;
            session.bufferTempPath = path.join(bufferDir, 'buffer.ts');
            session.bufferFinalPath = untrackedCachePath;
            session.bufferUntracked = true;
            startHlsBufferFetch(session);
          }
          logger.info(
            {
              sessionKey,
              youtubeId,
              videoFound: !!video,
              isStrm: video ? video.is_strm : null,
              hasFilePath: video ? !!video.filePath : null,
              untrackedCachePath,
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
      //
      // Duration and the instant-start placeholder are resolved
      // CONCURRENTLY (Promise.all, not a straight-line await chain): a
      // cache-miss duration lookup can take 6-7s via a live yt-dlp call,
      // and used to fully block placeholder generation - defeating
      // instant-start's whole purpose for exactly the videos where it
      // mattered most.
      const ytCfgForSession = config.ytstream || {};
      const wantsPlaceholder = ytCfgForSession.instantStart === true && transcode === 'h264';

      const [durationSeconds, generated] = await Promise.all([
        getVideoDurationSeconds(youtubeId, config),
        wantsPlaceholder
          ? (async () => {
              const sourceResolution = await resolveVideoTargetResolution(youtubeId, models);
              const { width, height } = capResolutionToHeight(sourceResolution.width, sourceResolution.height, resolveQualityHeight(quality));
              const thumbnailPath = resolveLocalThumbnailPath(youtubeId);
              return ensurePlaceholderSegment({ youtubeId, thumbnailPath, segmentType, segmentExt, hardwareMode: hw, tuning: tier, width, height });
            })()
          : Promise.resolve(null),
      ]);
      session.durationSeconds = durationSeconds;
      session.totalSegments = Math.max(1, Math.ceil(durationSeconds / HLS_SEGMENT_DURATION_SECONDS));
      // Diagnostic (temporary) - the resolved value was never actually
      // logged anywhere before, so "scrubber shows 0" reports had nothing
      // to confirm/rule out against. instantStart is irrelevant to this -
      // wantsPlaceholder only affects the second Promise.all branch above.
      logger.info({ sessionKey, youtubeId, durationSeconds, totalSegments: session.totalSegments, instantStart: wantsPlaceholder }, 'ytstream: calculatedLength duration resolved for this session');

      // ytstream.instantStart - see ensurePlaceholderSegment's doc comment.
      // Staged into session.dir under its own filename (never a real
      // segment index), so nothing else in the HLS pipeline needs to know
      // it exists - only the playlist's leading entries reference it.
      let placeholder = null;
      if (generated) {
        try {
          fs.copyFileSync(generated.segmentPath, path.join(dir, `placeholder.${segmentExt}`));
          if (generated.initPath) {
            fs.copyFileSync(generated.initPath, path.join(dir, 'placeholder-init.mp4'));
          }
          placeholder = {
            filename: `placeholder.${segmentExt}`,
            initFilename: generated.initPath ? 'placeholder-init.mp4' : null,
            durationSeconds: HLS_PLACEHOLDER_DURATION_SECONDS,
          };
          session.hasPlaceholder = true;
          logger.info({ sessionKey }, 'ytstream: HLS session starting with instant-start placeholder segment');
        } catch (err) {
          logger.warn({ err, sessionKey }, 'ytstream: failed to stage instant-start placeholder into session dir; falling back to normal startup');
        }
      }

      const fullPlaylist = buildFullHlsPlaylist({
        totalSegments: session.totalSegments,
        durationSeconds,
        segmentExt,
        segmentType,
        placeholder,
      });
      fs.writeFileSync(playlistPath, fullPlaylist);
    }

    trackStream({
      streamId: sessionKey,
      // session.tapEnabled/bufferEnabled reflect whether the tap/buffer
      // actually resolved (video was genuinely still STRM), not just
      // whether it was requested - a plain hls fallback still reads as
      // 'hls' correctly.
      mode: session.tapEnabled ? 'hls-tap' : (session.bufferEnabled ? 'hls-buffer' : 'hls'),
      youtubeId,
      quality,
      container,
      transcode,
      hardwareMode: hw,
      tuning: tier,
      clientIp,
      userAgent,
      state: 'starting',
      startedAt: Date.now(),
      bytesTransferred: 0,
      bytesPerSecond: 0,
      lastActivityAt: Date.now(),
      viewers: new Map([[clientIp, { userAgent, lastSeen: Date.now() }]]),
      stop: () => destroyHlsSession(session, 'manual-stop'),
    });

    // Fired alongside (not before) the initial pass, not awaited - see
    // warmHlsInfoJsonCache's own doc comment for why this needs to start
    // as early as possible to have any chance of beating an immediate
    // Jellyfin resume-from-middle seek.
    warmHlsInfoJsonCache(session, playerClientOverride);
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
   * client on the same 403/extraction-error signature streamViaFfmpeg
   * handles). Throws if it never becomes ready.
   */
  async function getOrCreateHlsSession(sessionKey, params) {
    const existing = hlsSessions.get(sessionKey);
    if (existing) {
      if (existing.state !== 'failed') {
        existing.lastAccess = Date.now();
        // A different client joining an already-running session — record
        // it for the Streaming page's viewer count, same session/stream.
        const entry = activeStreams.get(sessionKey);
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
        // Mirrors runPipeline's allowHwFallback for the DASH/direct-pipe
        // path; a broken/missing QSV/VAAPI/NVENC/AMF device otherwise
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

  function streamViaFfmpeg({
    youtubeId,
    quality,
    qualityStrictness,
    container,
    transcode,
    hardwareMode,
    tuning,
    seekSeconds,
    config,
    res,
    req,
    // Optional — only set by the calculatedLength path (see the router handler
    // below). { status, headers, targetLength }. Every other caller omits
    // this, and every branch below that reads it is conditional on it
    // being present, so the non-calculatedLength behavior is unchanged.
    responseShaping,
    // Streaming-page tracking entry id — created once per HTTP request by
    // the router handler (see there for why), threaded through every
    // runPipeline attempt/retry so they all update the same entry.
    streamId,
  }) {
    const tier = normalizeTuning(tuning);
    const sharedState = { retried: false, finalized: false, directFallbackDone: false };

    function attempt(attemptNumber) {
      // On the retry pass, force the "android" client — the "web"/"tv"
      // client family (yt-dlp's default) returns visitor-private
      // (vprv=1) googlevideo URLs tied to a PO token/session fingerprint
      // that can fail even for yt-dlp's own downloader on some videos.
      // "android" doesn't have that requirement.
      const playerClient = attemptNumber > 1 ? RETRY_PLAYER_CLIENT : undefined;
      return runPipeline(playerClient, normalizeHardwareMode(hardwareMode), {
        allowHwFallback: true,
        allowClientRetry: attemptNumber === 1,
      });
    }

    /**
     * Seek-restart fix: resolves direct DASH URLs for a nonzero-offset
     * request — covers both the calculatedLength Range-restart path and,
     * opportunistically, the cold-start `?t=` case. Returns null (never
     * throws) on failure so callers unconditionally fall back to the
     * yt-dlp-pipe path.
     */
    async function tryResolveDirectUrlsForSeek(playerClient) {
      if (!seekSeconds) return null;
      try {
        const { videoUrl, audioUrl } = await resolveDashUrlsForSeek(youtubeId, config, quality, playerClient, qualityStrictness);
        const cookiesPath = configModule.getCookiesPath && configModule.getCookiesPath();
        return { videoUrl, audioUrl, cookieHeader: loadYoutubeCookieHeader(cookiesPath) };
      } catch (err) {
        logger.warn(
          { youtubeId, err: err.message },
          'ytstream: direct DASH URL resolution for seek-restart failed; falling back to yt-dlp pipe'
        );
        return null;
      }
    }

    /**
     * Spawns two `yt-dlp -o -` processes — video-only and audio-only DASH
     * formats — each piped into its own extra ffmpeg fd (`pipe:3`/`pipe:4`),
     * which muxes them. yt-dlp does the actual fetching from googlevideo;
     * ffmpeg never makes an HTTP request itself.
     *
     * Two-pipe split, not one `-f bv*+ba -o -` process: yt-dlp can't stream
     * a merged selector to stdout progressively — it downloads and muxes
     * both tracks with its own ffmpeg first, which on a long video looks
     * like the request hanging before any bytes arrive. Two independent
     * streams sidestep that: each starts flowing as soon as its own track
     * starts downloading, and *our* ffmpeg muxes as bytes arrive on both.
     *
     * Also avoids handing ffmpeg a bare `-g`-resolved googlevideo URL to
     * fetch itself, which reliably 403s: many URLs are "visitor-private"
     * (`vprv=1`) and rejected unless the request comes from the same
     * client/session that resolved them — cookies alone don't satisfy that.
     *
     * If the requested hardware encoder fails to initialize (no working
     * VAAPI/QSV driver, no GPU), ffmpeg exits non-zero before writing a
     * byte. That used to be a hard 502 even when software encoding would
     * have worked fine; now, as long as nothing has reached the client yet,
     * it retries once in software before giving up.
     */
    async function runPipeline(playerClient, hw, { allowHwFallback, allowClientRetry, forcePipeMode = false }) {
      // Resolved before building yt-dlp args or sending headers, so a
      // failed resolution transparently falls through to the unchanged
      // yt-dlp-pipe path. forcePipeMode skips this - set only by this
      // function's own fallback re-invocation after a direct-URL attempt
      // already failed once (see handleFailure below).
      const directUrls = forcePipeMode ? null : await tryResolveDirectUrlsForSeek(playerClient);

      let videoFormat = null;
      let audioFormat = null;
      let ytVideoArgs = null;
      let ytAudioArgs = null;
      if (!directUrls) {
        ({ videoFormat, audioFormat } = getDashFormatSelectors(quality, qualityStrictness));
        const watchUrl = `https://youtube.com/watch?v=${youtubeId}`;
        const commonYtArgs = [...buildBaseArgs(config, { playerClient }), '-o', '-', '--no-playlist', '--no-warnings'];
        ytVideoArgs = [...commonYtArgs, '-f', videoFormat, watchUrl];
        ytAudioArgs = [...commonYtArgs, '-f', audioFormat, watchUrl];
      }

      const encoder = transcode === 'h264' ? buildVideoEncoderArgs(hw, resolveQualityHeight(quality), tier, (config.ytstream || {}).vaapiQuality) : null;

      const ffArgs = [
        // 'warning' (not the usual 'error') for a direct-URL seek-restart
        // attempt — see the matching comment in spawnHlsEncodePass for why.
        '-loglevel', directUrls ? 'warning' : 'error',
        '-fflags', '+genpts',
        '-analyzeduration', '10M',
        '-probesize', '5M',
      ];

      if (encoder && encoder.preInputArgs && encoder.preInputArgs.length) {
        ffArgs.push(...encoder.preInputArgs);
      }

      if (directUrls) {
        // ffmpeg fetches these DASH URLs itself over real HTTP, so -ss here
        // is an INPUT seek (Range-based) instead of the pipe branch's
        // broken output-side -ss on a non-seekable pipe - see the doc's
        // "Spike results" for the empirical proof this is a true seek.
        const headers = buildFfmpegUpstreamHeaders(directUrls.cookieHeader);
        if (seekSeconds) ffArgs.push('-ss', String(seekSeconds));
        ffArgs.push('-headers', headers, '-i', directUrls.videoUrl);
        if (seekSeconds) ffArgs.push('-ss', String(seekSeconds));
        ffArgs.push('-headers', headers, '-i', directUrls.audioUrl);
      } else {
        // -thread_queue_size: the video/audio pipes are two independent,
        // asynchronously-filling sources (separate yt-dlp downloads) rather
        // than one demuxed file — without headroom here ffmpeg's demuxer
        // thread can block/drop when one pipe delivers data faster than
        // the other gets consumed, unlike the single-pipe.0 case before.
        if (seekSeconds) ffArgs.push('-ss', String(seekSeconds));
        ffArgs.push('-thread_queue_size', '4096', '-i', 'pipe:3');
        if (seekSeconds) ffArgs.push('-ss', String(seekSeconds));
        ffArgs.push('-thread_queue_size', '4096', '-i', 'pipe:4');
      }

      // Two inputs now (0 = video, 1 = audio) instead of one.
      ffArgs.push('-map', '0:v:0', '-map', '1:a:0?', '-sn', '-dn');
      ffArgs.push('-max_muxing_queue_size', '4096');

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

      if (container === 'ts') {
        ffArgs.push('-f', 'mpegts');
      } else if (container === 'mkv') {
        // Matroska - unlike mp4/mpegts, accepts essentially any video/audio
        // codec pair ffmpeg can produce without container-specific
        // box-signaling concerns (same reasoning ensureProbeClip already
        // relies on for its own probe-shortcut clips) - useful for
        // transcode=copy when the source track isn't H.264.
        ffArgs.push('-f', 'matroska');
      } else {
        ffArgs.push('-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof');
      }
      ffArgs.push('pipe:1');

      logger.info(
        { youtubeId, quality, playerClient, hardwareMode: hw, videoFormat, audioFormat, ffArgs: redactFfArgsForLogging(ffArgs), source: directUrls ? 'direct-url' : 'network' },
        directUrls
          ? 'ytstream: spawning ffmpeg pipeline from directly-resolved DASH URLs (seek-restart fix)'
          : 'ytstream: spawning yt-dlp(video) + yt-dlp(audio) | ffmpeg pipeline'
      );

      ensureProcessExitHandlers();

      return new Promise((resolvePipeline) => {
        // calculatedLength: apply the synthetic status/Content-Length/Content-Range
        // before any bytes flow. Absent for every other caller, so this is a
        // no-op for the normal ffmpeg-mode path.
        if (responseShaping && !res.headersSent) {
          res.status(responseShaping.status);
          res.set(responseShaping.headers);
        }

        const needsYtDlpChildren = !directUrls;
        let ytVideo = null;
        let ytAudio = null;
        if (needsYtDlpChildren) {
          ytVideo = spawn('yt-dlp', ytVideoArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
          ytAudio = spawn('yt-dlp', ytAudioArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
          registerChildProcess(ytVideo);
          registerChildProcess(ytAudio);
        }
        // stdin ('ignore') is unused now — in pipe mode, video/audio arrive
        // on the extra fds 3/4 instead of stdin/pipe:0; in direct-URL mode
        // ffmpeg fetches both over HTTP itself, no extra fds needed at all.
        const ff = spawn('ffmpeg', ffArgs, { stdio: needsYtDlpChildren ? ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'] });
        registerChildProcess(ff);

        let ytVideoErr = '';
        let ytAudioErr = '';
        let ffErr = '';
        const state = { cleaned: false };

        if (needsYtDlpChildren) {
          ytVideo.stderr.on('data', (c) => {
            ytVideoErr = (ytVideoErr + c.toString()).slice(-4000);
          });
          ytAudio.stderr.on('data', (c) => {
            ytAudioErr = (ytAudioErr + c.toString()).slice(-4000);
          });
        }
        ff.stderr.on('data', (c) => {
          ffErr = (ffErr + c.toString()).slice(-4000);
        });

        const ffVideoIn = needsYtDlpChildren ? ff.stdio[3] : null;
        const ffAudioIn = needsYtDlpChildren ? ff.stdio[4] : null;

        // Any of these pipe streams can see a write-after-close race
        // during teardown - an unhandled 'error' on any of them is an
        // uncaught exception that crashes the ENTIRE Node process, not
        // just this request, so every stream gets a listener.
        ff.stdout.on('error', () => { /* response already closing */ });
        if (needsYtDlpChildren) {
          ytVideo.stdout.on('error', () => { /* pipe destination gone; cleanup() is already tearing this down */ });
          ytAudio.stdout.on('error', () => { /* pipe destination gone; cleanup() is already tearing this down */ });
          ffVideoIn.on('error', () => { /* upstream (yt-dlp video) already gone or being killed */ });
          ffAudioIn.on('error', () => { /* upstream (yt-dlp audio) already gone or being killed */ });

          // yt-dlp's stdout feeds ffmpeg's extra fds directly — no
          // googlevideo URL is ever handed to ffmpeg's own HTTP demuxer.
          ytVideo.stdout.pipe(ffVideoIn);
          ytAudio.stdout.pipe(ffAudioIn);
        }

        // calculatedLength routes ff.stdout through a length-capping/padding
        // transform first so the body always matches the synthetic
        // Content-Length already sent in headers; every other caller
        // leaves this null and pipes ff.stdout to res exactly as before.
        const cappingTransform = responseShaping
          ? createLengthCappingTransform(responseShaping.targetLength)
          : null;
        if (cappingTransform) {
          cappingTransform.on('error', () => { /* response already closing */ });
          ff.stdout.pipe(cappingTransform);
        }
        const outputToClient = cappingTransform || ff.stdout;

        // Streaming-page byte counter — counts exactly what the client
        // receives (post-calculatedLength capping, if active). A plain listener
        // alongside the existing .pipe() below; doesn't touch backpressure.
        if (streamId) {
          outputToClient.on('data', (chunk) => {
            const entry = activeStreams.get(streamId);
            if (entry) {
              entry.bytesTransferred += chunk.length;
              entry.lastActivityAt = Date.now();
              if (entry.state === 'starting') entry.state = 'active';
            }
          });
        }

        // { end: false } is required: Readable.pipe() otherwise calls
        // res.end() the instant ff.stdout closes, whether ffmpeg exited 0
        // or not. Without it, a hardware encoder that fails instantly
        // silently finalizes the response as "200 OK" empty-bodied before
        // handleFailure runs, masking the failure and defeating the
        // software fallback. res.end() is now only called explicitly.
        outputToClient.pipe(res, { end: false });

        const cleanup = (reason) => {
          if (state.cleaned) return;
          state.cleaned = true;
          try { outputToClient.unpipe(res); } catch { /* ignore */ }
          try { outputToClient.destroy(); } catch { /* ignore */ }
          if (cappingTransform) {
            try { ff.stdout.unpipe(cappingTransform); } catch { /* ignore */ }
            try { ff.stdout.destroy(); } catch { /* ignore */ }
          }
          if (needsYtDlpChildren) {
            try { ytVideo.stdout.unpipe(ffVideoIn); } catch { /* ignore */ }
            try { ytAudio.stdout.unpipe(ffAudioIn); } catch { /* ignore */ }
            // unpipe() only stops *future* writes; it doesn't cancel one
            // already queued. Destroying the sources and ending the
            // destinations closes the gap before killChildProcess's
            // SIGTERM (which is async) gets a chance to.
            try { ytVideo.stdout.destroy(); } catch { /* ignore */ }
            try { ytAudio.stdout.destroy(); } catch { /* ignore */ }
            try { ffVideoIn.end(); } catch { /* ignore */ }
            try { ffAudioIn.end(); } catch { /* ignore */ }
          }
          killChildProcess(ytVideo, `ytdlp-video:${reason}`);
          killChildProcess(ytAudio, `ytdlp-audio:${reason}`);
          killChildProcess(ff, `ffmpeg:${reason}`);
        };

        // Wired up for the Streaming page's stop button. Guarded by
        // sharedState.finalized so a manual stop can't race a retry that's
        // already in flight — same guard handleFailure/onClientGone use.
        if (streamId) {
          const entry = activeStreams.get(streamId);
          if (entry) {
            entry.stop = () => {
              if (sharedState.finalized) return;
              sharedState.finalized = true;
              cleanup('manual-stop');
              untrackStream(streamId, 'manual-stop');
              resolvePipeline();
            };
          }
        }

        function handleFailure(reason, message) {
          if (sharedState.finalized) {
            cleanup(reason);
            resolvePipeline();
            return;
          }

          // Seek-restart's direct-URL attempt failed (403, network blip,
          // etc) - falls back to the yt-dlp-pipe path exactly once, ahead
          // of the client/hw-fallback checks below (which don't apply
          // here). Never let a seek regress below "eventually
          // decode-and-discards" just because the faster path didn't pan out.
          if (directUrls && !sharedState.directFallbackDone && !res.headersSent) {
            sharedState.directFallbackDone = true;
            cleanup(reason);
            logger.warn(
              { youtubeId, reason, message },
              'ytstream: direct-URL seek-restart attempt failed; falling back to yt-dlp pipe'
            );
            resolvePipeline(runPipeline(playerClient, hw, { allowHwFallback, allowClientRetry, forcePipeMode: true }));
            return;
          }

          // yt-dlp couldn't fetch the video or audio track — a
          // session/client extraction error, or (defense-in-depth) a 403
          // from googlevideo itself. Re-run the whole pipeline with the
          // android client.
          const isFetchFailure =
            isRetryableExtractionError(message) || /\b403\b|forbidden/i.test(String(message));
          if (isFetchFailure && allowClientRetry && !sharedState.retried && !res.headersSent) {
            sharedState.retried = true;
            cleanup(reason);
            logger.warn(
              { youtubeId, reason, message },
              `ytstream: yt-dlp fetch failed; retrying with player_client=${RETRY_PLAYER_CLIENT}`
            );
            resolvePipeline(attempt(2));
            return;
          }

          // Nothing has reached the client yet — safe to retry in software
          // if this attempt was using a hardware encoder.
          if (allowHwFallback && hw !== 'none' && !res.headersSent) {
            cleanup(reason);
            logger.warn(
              { youtubeId, hardwareMode: hw, reason, message },
              'ytstream: hardware encoder failed before any bytes were sent; retrying with hardwareMode=none (software libx264)'
            );
            resolvePipeline(runPipeline(playerClient, 'none', { allowHwFallback: false, allowClientRetry }));
            return;
          }

          sharedState.finalized = true;
          if (streamId) untrackStream(streamId, 'error', message);
          cleanup(reason);
          if (!res.headersSent) {
            logger.error({ youtubeId, reason, message }, 'ytstream: stream failed to start or exited with error');
            res.status(502).send(`Stream failed: ${String(message).slice(0, 300)}`);
          } else if (!res.writableEnded) {
            try { res.end(); } catch { /* ignore */ }
          }
          resolvePipeline();
        }

        const onClientGone = (reason) => () => {
          sharedState.finalized = true;
          if (streamId) untrackStream(streamId, 'client-disconnected');
          cleanup(reason);
          resolvePipeline();
        };
        res.on('close', onClientGone('res-close'));
        res.on('error', onClientGone('res-error'));
        req.on('aborted', onClientGone('req-aborted'));
        req.on('close', onClientGone('req-close'));

        if (needsYtDlpChildren) {
          ytVideo.on('error', (err) => {
            logger.error({ err }, 'ytstream: yt-dlp (video) failed to start');
            handleFailure('ytdlp-video-spawn-error', err.message);
          });
          ytAudio.on('error', (err) => {
            logger.error({ err }, 'ytstream: yt-dlp (audio) failed to start');
            handleFailure('ytdlp-audio-spawn-error', err.message);
          });
        }

        ff.on('error', (err) => {
          logger.error({ err }, 'ytstream: ffmpeg failed to start');
          handleFailure('ffmpeg-spawn-error', err.message);
        });

        if (needsYtDlpChildren) {
          ytVideo.on('close', (code, signal) => {
            const killedByUs = state.cleaned || signal === 'SIGTERM' || signal === 'SIGKILL';
            if (code !== 0 && code !== null && !killedByUs) {
              logger.error({ code, signal, ytVideoErr: ytVideoErr.slice(-800) }, 'ytstream: yt-dlp (video) exited non-zero');
              handleFailure('ytdlp-video-exit', ytVideoErr || `yt-dlp (video) exited with code ${code}`);
            }
          });

          ytAudio.on('close', (code, signal) => {
            const killedByUs = state.cleaned || signal === 'SIGTERM' || signal === 'SIGKILL';
            if (code !== 0 && code !== null && !killedByUs) {
              logger.error({ code, signal, ytAudioErr: ytAudioErr.slice(-800) }, 'ytstream: yt-dlp (audio) exited non-zero');
              handleFailure('ytdlp-audio-exit', ytAudioErr || `yt-dlp (audio) exited with code ${code}`);
            }
          });
        }

        ff.on('close', (code, signal) => {
          const killedByUs = state.cleaned || signal === 'SIGTERM' || signal === 'SIGKILL';
          if (code !== 0 && code !== null && !killedByUs) {
            // Prefer yt-dlp's own error text when available — it's far
            // more diagnostic ("403 Forbidden", "page needs to be
            // reloaded", etc.) than ffmpeg's generic "Invalid data found"
            // complaint about an empty/truncated pipe.
            logger.error(
              { code, signal, ffErr: ffErr.slice(-800), ytVideoErr: ytVideoErr.slice(-800), ytAudioErr: ytAudioErr.slice(-800) },
              'ytstream: ffmpeg exited non-zero'
            );
            handleFailure('ffmpeg-exit', ytVideoErr || ytAudioErr || ffErr || `ffmpeg exited with code ${code}`);
            return;
          }
          if (sharedState.finalized) return;
          logger.info(
            { code, signal, pid: ff.pid, cleaned: state.cleaned, ffErrTail: ffErr ? ffErr.slice(-300) : '' },
            'ytstream: ffmpeg exited cleanly'
          );
          sharedState.finalized = true;
          if (streamId) untrackStream(streamId, 'completed');
          if (!res.writableEnded) {
            try { res.end(); } catch { /* ignore */ }
          }
          cleanup('ffmpeg-close');
          resolvePipeline();
        });
      });
    }

    // Return the promise chain so the caller's `await streamViaFfmpeg(...)`
    // actually holds the request open until the pipeline (including any
    // hardware->software fallback) finishes, instead of resolving
    // immediately and leaving ffmpeg to stream into an already-"finished"
    // handler.
    return attempt(1);
  }

  /**
   * Streaming page — lists every currently-active mode=ffmpeg/mode=hls
   * stream tracked in activeStreams, with a best-effort title lookup (no
   * live yt-dlp fetch). REST source of truth for initial load/reconnects;
   * live deltas come from the streamProgress/streamStarted/streamStopped
   * WebSocket broadcasts.
   *
   * MUST be registered before '/api/ytstream/:youtubeId' below: Express
   * matches by registration order, and "streams" passes that route's own
   * youtubeId format check — without this ordering it gets hijacked as a
   * request for video id "streams".
   */
  router.get('/api/ytstream/streams', authMiddleware, async (req, res) => {
    const streams = [...activeStreams.values()].map(snapshotStream);
    const youtubeIds = [...new Set(streams.map((s) => s.youtubeId))];
    let titleById = {};
    if (youtubeIds.length && models && models.Video) {
      try {
        const rows = await models.Video.findAll({
          where: { youtubeId: youtubeIds },
          attributes: ['youtubeId', 'youTubeVideoName'],
        });
        titleById = Object.fromEntries(rows.map((r) => [r.youtubeId, r.youTubeVideoName]));
      } catch (err) {
        logger.warn({ err }, 'ytstream: failed to resolve titles for /streams');
      }
    }
    res.json({ streams: streams.map((s) => ({ ...s, title: titleById[s.youtubeId] || null })) });
  });

  /**
   * Configuration UI's single source of truth for whether each ytstream
   * field is required/ignored/optional for a given mode - see
   * getModeFieldCompatibility. The client never hardcodes this logic; it
   * calls this on every mode/transcode change and drives its disabled
   * state + chips straight from the response.
   */
  router.get('/api/ytstream/mode-compatibility', authMiddleware, (req, res) => {
    const mode = String(req.query.mode || 'direct');
    const transcode = String(req.query.transcode || '');
    const container = String(req.query.container || '');
    res.json(getModeFieldCompatibility({ mode, transcode, container }));
  });

  /**
   * Stream History page — persisted audit trail of past playback sessions,
   * unlike /streams which only shows what's currently active. Server-side
   * paginated (unlike the Jobs/DownloadHistory precedent) since this table
   * only grows with normal use, no natural upper bound.
   *
   * MUST be registered before '/api/ytstream/:youtubeId' — same reasoning
   * as '/streams' above.
   */
  router.get('/api/ytstream/history', authMiddleware, async (req, res) => {
    if (!models || !models.StreamHistory) {
      return res.json({ rows: [], total: 0, page: 1, limit: 25 });
    }
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    // 128 (not 100) to match the client's shared ALLOWED_PAGE_SIZES ceiling
    // (see client/src/components/shared/VideoList/pageSizes.ts) - otherwise
    // picking the largest per-page option would silently return fewer rows
    // than the page-size math on the client expects.
    const limit = Math.min(128, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
    try {
      const { count, rows } = await models.StreamHistory.findAndCountAll({
        order: [['started_at', 'DESC']],
        limit,
        offset: (page - 1) * limit,
      });
      const youtubeIds = [...new Set(rows.map((r) => r.youtube_id))];
      let titleById = {};
      if (youtubeIds.length && models.Video) {
        try {
          const videoRows = await models.Video.findAll({
            where: { youtubeId: youtubeIds },
            attributes: ['youtubeId', 'youTubeVideoName'],
          });
          titleById = Object.fromEntries(videoRows.map((v) => [v.youtubeId, v.youTubeVideoName]));
        } catch (err) {
          logger.warn({ err }, 'ytstream: failed to resolve titles for /history');
        }
      }
      res.json({
        rows: rows.map((r) => ({
          streamId: r.stream_id,
          youtubeId: r.youtube_id,
          title: titleById[r.youtube_id] || null,
          mode: r.mode,
          quality: r.quality,
          container: r.container,
          transcode: r.transcode,
          hardwareMode: r.hardware_mode,
          clientIp: r.client_ip,
          userAgent: r.user_agent,
          startedAt: r.started_at,
          endedAt: r.ended_at,
          bytesTransferred: Number(r.bytes_transferred),
          endReason: r.end_reason,
          errorMessage: r.error_message,
        })),
        total: count,
        page,
        limit,
      });
    } catch (err) {
      logger.error({ err }, 'ytstream: failed to fetch stream history');
      res.status(500).json({ error: 'Failed to fetch stream history' });
    }
  });

  router.delete('/api/ytstream/history', authMiddleware, async (req, res) => {
    if (!models || !models.StreamHistory) {
      return res.json({ success: true, deleted: 0 });
    }
    const { streamIds } = req.body;
    if (!Array.isArray(streamIds) || streamIds.length === 0) {
      return res.status(400).json({ success: false, error: 'streamIds array is required' });
    }
    try {
      const { Op } = require('sequelize');
      const deleted = await models.StreamHistory.destroy({
        where: { stream_id: { [Op.in]: streamIds } },
      });
      res.json({ success: true, deleted });
    } catch (err) {
      logger.error({ err }, 'ytstream: failed to delete stream history entries');
      res.status(500).json({ success: false, error: 'Failed to delete stream history entries' });
    }
  });

  // Youtarr's own untracked-buffer cache (HLS_UNTRACKED_BUFFER_CACHE_DIR) -
  // mode=hls-buffer/raw-buffer's finished download for a video with no
  // library Video row (an untracked NZB grab, or one disowned via
  // importStrategy:'untracked') - see getModeFieldCompatibility's cacheOnPlay
  // field and finalizeTapOutput's skipVideoUpsert doc comment. Every file in
  // this directory is always a COMPLETE finalized copy - active fetches
  // write to a separate temp dir under HLS_BASE_TEMP_DIR and only land here
  // via an atomic rename once finished - so there's no "mid-write" file to
  // worry about corrupting. The one real caveat: an active stream reading
  // directly off an already-cached file (session.cachedFilePath) will error
  // mid-playback if its underlying file is deleted out from under it - no
  // active-session check here, same as a user manually deleting a real
  // downloaded file while it's playing elsewhere in the app.
  router.get('/api/ytstream/untracked-cache', authMiddleware, async (req, res) => {
    try {
      let fileCount = 0;
      let totalBytes = 0;
      if (fs.existsSync(HLS_UNTRACKED_BUFFER_CACHE_DIR)) {
        const entries = await fs.promises.readdir(HLS_UNTRACKED_BUFFER_CACHE_DIR);
        for (const entry of entries) {
          try {
            const stat = await fs.promises.stat(path.join(HLS_UNTRACKED_BUFFER_CACHE_DIR, entry));
            if (stat.isFile()) {
              fileCount += 1;
              totalBytes += stat.size;
            }
          } catch (err) { /* removed mid-scan - ignore */ }
        }
      }
      res.json({ fileCount, totalBytes });
    } catch (err) {
      logger.error({ err }, 'ytstream: failed to read untracked buffer cache stats');
      res.status(500).json({ error: 'Failed to read untracked buffer cache' });
    }
  });

  router.delete('/api/ytstream/untracked-cache', authMiddleware, async (req, res) => {
    try {
      let deletedFiles = 0;
      let freedBytes = 0;
      if (fs.existsSync(HLS_UNTRACKED_BUFFER_CACHE_DIR)) {
        const entries = await fs.promises.readdir(HLS_UNTRACKED_BUFFER_CACHE_DIR);
        for (const entry of entries) {
          const filePath = path.join(HLS_UNTRACKED_BUFFER_CACHE_DIR, entry);
          try {
            const stat = await fs.promises.stat(filePath);
            if (!stat.isFile()) continue;
            await fs.promises.unlink(filePath);
            deletedFiles += 1;
            freedBytes += stat.size;
          } catch (err) {
            logger.warn({ err, filePath }, 'ytstream: failed to delete one untracked buffer cache file');
          }
        }
      }
      logger.info({ deletedFiles, freedBytes }, 'ytstream: untracked buffer cache cleared');
      res.json({ success: true, deletedFiles, freedBytes });
    } catch (err) {
      logger.error({ err }, 'ytstream: failed to clear untracked buffer cache');
      res.status(500).json({ success: false, error: 'Failed to clear untracked buffer cache' });
    }
  });

  /**
   * Resolves every playback setting the same way for both the real
   * streaming route and the read-only `/simulate` debug route - a single
   * source of truth so the debug trace can never drift from what a real
   * request would do. Each mode is self-contained: mode=ffmpeg/hls fails
   * outright (`ffmpegAvailable: false`) rather than substituting a
   * different mode's behavior when ffmpeg isn't available.
   *
   * `probe: true` (the real route) runs the two real yt-dlp lookups this
   * depends on for accuracy - the best-available-height auto-cap and the
   * transcode=copy->h264 codec auto-upgrade check. `probe: false`
   * (/simulate's default) skips both and reports pre-probe values, so a
   * debug call is instant and never touches yt-dlp/YouTube.
   * isFfmpegAvailable() and probeShortcut are always evaluated for real
   * either way - both cheap, pure/cached reads.
   */
  /**
   * strmGenerator.buildStrmContent appends .strm pipe-syntax
   * (`url|User-Agent=value`) directly onto the FULL url including its query
   * string, relying on the player to strip everything from the first `|`
   * before requesting it. Jellyfin's browser htmlVideoPlayer does NOT do
   * this - it requests the raw line, so the suffix glues onto the last
   * query param (e.g. `calculatedLength=1` becomes
   * `calculatedLength=1|User-Agent=Youtarr-Playback%2F1.0` on the wire). A
   * strict `/^(1|true|yes)$/i` match against that silently evaluates to
   * false, taking the whole session down a different, buggy code path with
   * no error. Splitting on `|` first makes boolean flags tolerant of that
   * suffix regardless of which consumer failed to strip it.
   */
  function parseBooleanQueryFlag(raw) {
    if (raw === true) return true;
    const firstToken = String(raw ?? '').split('|', 1)[0];
    return /^(1|true|yes)$/i.test(firstToken);
  }

  async function resolvePlaybackPlan(youtubeId, req, config, { probe }) {
    const ytCfg = config.ytstream || {};
    const steps = [];

    // probeShortcut - evaluateProbeShortcut is the same function the real
    // early-exit block above this route calls, so this can never drift
    // from what actually decides whether a real request short-circuits
    // there. A real request that matches this never reaches any of the
    // logic below at all - this is computed here purely for the trace.
    const probeShortcut = evaluateProbeShortcut(req, config);
    steps.push({ step: 'probeShortcut', detail: probeShortcut.reason, probed: false });

    const forceServerSettings = ytCfg.forceServerSettings === true;
    const queryOverride = (name) => (forceServerSettings ? undefined : req.query[name]);
    const ignoredQueryParams = forceServerSettings
      ? ['mode', 'container', 'transcode', 'hardware', 'tuning', 'quality', 'qualityStrictness', 'calculatedLength', 'fakeLength'].filter(
        (name) => req.query[name] !== undefined
      )
      : [];
    steps.push({
      step: 'forceServerSettings',
      detail: forceServerSettings
        ? `on - every setting below comes from Settings→Streaming only; ignoring query params present on this request: ${
          ignoredQueryParams.length ? ignoredQueryParams.join(', ') : '(none present on this request)'
        }`
        : 'off - query-string overrides are honored',
      probed: false,
    });

    const requestedMode = String(queryOverride('mode') || ytCfg.defaultMode || 'direct').toLowerCase();
    const requestedModeValid = VALID_MODES.includes(requestedMode);
    let mode = requestedModeValid ? requestedMode : 'direct';
    if (!requestedModeValid) {
      steps.push({ step: 'mode', detail: `requested mode "${requestedMode}" isn't one of ${VALID_MODES.join('/')}; falling back to direct`, probed: false });
    }

    const ffmpegAvailable = isFfmpegAvailable();
    if ((mode === 'ffmpeg' || mode === 'hls' || mode === 'hls-tap' || mode === 'hls-buffer' || mode === 'raw-buffer') && !ffmpegAvailable) {
      // No fallback to a different mode - mode=ffmpeg/hls/hls-tap/hls-buffer/
      // raw-buffer requires ffmpeg (raw-buffer only as a copy-only muxer for
      // yt-dlp's separate video/audio streams, never as an encoder), full
      // stop. The real route responds 502 for this rather than silently
      // serving direct/direct-pipe instead.
      steps.push({ step: 'mode', detail: `mode=${mode} requested but ffmpeg is unavailable on this host; fails outright (502), no fallback to a different mode`, probed: false });
    } else {
      steps.push({ step: 'mode', detail: `resolved to ${mode}`, probed: false });
    }

    const container = VALID_CONTAINERS.includes(queryOverride('container'))
      ? queryOverride('container')
      : (ytCfg.container || 'mp4');

    let transcode = VALID_TRANSCODE.includes(queryOverride('transcode'))
      ? queryOverride('transcode')
      : (ytCfg.transcode || 'copy');

    const hardwareMode = normalizeHardwareMode(queryOverride('hardware') || ytCfg.hardwareMode || 'none');
    const tuning = normalizeTuning(queryOverride('tuning') || ytCfg.tuning || 'fast');

    const isDirectFamily = mode === 'direct' || mode === 'direct-pipe' || mode === 'direct-redirect';

    if (isDirectFamily) {
      steps.push({
        step: 'container/transcode/hardwareMode/tuning',
        detail: `ignored - ${mode} mode always fetches the raw progressive YouTube stream as-is (no remux/transcode)`,
        probed: false,
      });
    }

    const requestedQualityStrictnessRaw = String(queryOverride('qualityStrictness') || ytCfg.qualityStrictness || 'fallback').toLowerCase();
    const qualityStrictness = ['fixed', 'fallback', 'best'].includes(requestedQualityStrictnessRaw) ? requestedQualityStrictnessRaw : 'fallback';
    if (!['fixed', 'fallback', 'best'].includes(requestedQualityStrictnessRaw)) {
      steps.push({ step: 'qualityStrictness', detail: `requested "${requestedQualityStrictnessRaw}" isn't fixed/fallback/best; using fallback`, probed: false });
    }

    const requestedQuality = String(queryOverride('quality') || ytCfg.quality || config.preferredResolution || '720');

    let quality = requestedQuality;
    let qualityCapped = false;
    if (isDirectFamily) {
      steps.push({
        step: 'quality',
        detail: `requested "${requestedQuality}" (strictness: ${qualityStrictness}) used as-is - ${mode} mode's format selector already self-limits to whatever's actually available, so it is never auto-capped`,
        probed: false,
      });
    } else if (qualityStrictness === 'best') {
      steps.push({
        step: 'quality',
        detail: 'quality strictness is "best" - ignoring the configured quality entirely, always uses this video\'s true best-available DASH format (uncapped bv*), no auto-cap probe needed',
        probed: false,
      });
    } else if (qualityStrictness === 'fixed') {
      steps.push({
        step: 'quality',
        detail: `quality strictness is "fixed" - requested "${requestedQuality}" used exactly as configured, no auto-cap; if this video's real best-available height is lower, the request fails rather than silently substituting a lower one`,
        probed: false,
      });
    } else if (!probe) {
      steps.push({
        step: 'quality',
        detail: `requested "${requestedQuality}"; not probed - pass probe=true for this video's real auto-capped value (resolveEffectiveQualityHeight)`,
        probed: false,
      });
    } else {
      const cappedQualityHeight = await resolveEffectiveQualityHeight(youtubeId, requestedQuality, config, ytCfg.playerClient);
      if (cappedQualityHeight) {
        quality = String(cappedQualityHeight);
        qualityCapped = quality !== requestedQuality;
      }
      steps.push({
        step: 'quality',
        detail: qualityCapped
          ? `checked this video's real best-available height via yt-dlp (-f bv*) - requested "${requestedQuality}" auto-capped to "${quality}"`
          : `checked this video's real best-available height via yt-dlp (-f bv*) - requested "${requestedQuality}" used as-is (not capped - already within range, or "best")`,
        probed: true,
      });
    }

    const seekSeconds = req.query.t ? Number(req.query.t) : null;

    // getModeFieldCompatibility is the single canonical source for all of
    // this - both the forced-value ENFORCEMENT below and the dry-run TEXT
    // explaining it derive from the same status+reason, so they can't drift
    // apart the way three independently hand-written versions once did.
    const modeCompat = getModeFieldCompatibility({ mode, transcode, container });

    const calculatedLengthRaw = queryOverride('calculatedLength') ?? queryOverride('fakeLength') ?? ytCfg.calculatedLength;
    const calculatedLengthCompat = modeCompat.calculatedLength;
    const calculatedLength = calculatedLengthCompat.status === 'forced' ? true : parseBooleanQueryFlag(calculatedLengthRaw);
    if (calculatedLengthCompat.status === 'forced' && !parseBooleanQueryFlag(calculatedLengthRaw)) {
      steps.push({ step: 'calculatedLength', detail: `forced on - ${calculatedLengthCompat.reason}`, probed: false });
    } else if (calculatedLengthCompat.status === 'ignored' && calculatedLength) {
      steps.push({ step: 'calculatedLength', detail: `on, but ignored - ${calculatedLengthCompat.reason}`, probed: false });
    } else if (calculatedLengthCompat.status === 'optional' && calculatedLength) {
      steps.push({ step: 'calculatedLength', detail: `on - ${calculatedLengthCompat.reason}`, probed: false });
    }

    const hotSwapToCache = ytCfg.hotSwapToCache === true;
    const hotSwapToCacheCompat = modeCompat.hotSwapToCache;
    if (hotSwapToCache && hotSwapToCacheCompat.status === 'ignored') {
      steps.push({ step: 'hotSwapToCache', detail: `on, but ignored - ${hotSwapToCacheCompat.reason}`, probed: false });
    }

    const backfillMissingSegments = ytCfg.backfillMissingSegments === true;
    const backfillMissingSegmentsCompat = modeCompat.backfillMissingSegments;
    if (backfillMissingSegments && backfillMissingSegmentsCompat.status === 'ignored') {
      steps.push({ step: 'backfillMissingSegments', detail: `on, but ignored - ${backfillMissingSegmentsCompat.reason}`, probed: false });
    } else if (backfillMissingSegments && backfillMissingSegmentsCompat.status === 'optional') {
      steps.push({ step: 'backfillMissingSegments', detail: `on - ${backfillMissingSegmentsCompat.reason}`, probed: false });
    }

    const finalizeToMp4 = ytCfg.finalizeToMp4 === true;
    const finalizeToMp4Compat = modeCompat.finalizeToMp4;
    if (finalizeToMp4 && finalizeToMp4Compat.status === 'ignored') {
      steps.push({ step: 'finalizeToMp4', detail: `on, but ignored - ${finalizeToMp4Compat.reason}`, probed: false });
    } else if (finalizeToMp4 && finalizeToMp4Compat.status === 'optional') {
      steps.push({ step: 'finalizeToMp4', detail: `on - ${finalizeToMp4Compat.reason}`, probed: false });
    }

    if (transcode === 'copy' && (mode === 'ffmpeg' || mode === 'hls' || mode === 'hls-tap' || mode === 'hls-buffer')) {
      if (!probe) {
        steps.push({
          step: 'transcode',
          detail: 'copy requested; not probed - pass probe=true to check whether this video\'s selected format is actually H.264 (resolveVideoCodec auto-upgrade)',
          probed: false,
        });
      } else {
        try {
          const selectedCodec = await resolveVideoCodec(youtubeId, quality, config, ytCfg.playerClient, qualityStrictness);
          if (selectedCodec && !isH264Codec(selectedCodec)) {
            steps.push({
              step: 'transcode',
              detail: `probed selected format's codec via yt-dlp (--print vcodec) - copy requested but codec is "${selectedCodec}" (not H.264); auto-upgraded to h264`,
              probed: true,
            });
            transcode = 'h264';
          } else {
            steps.push({
              step: 'transcode',
              detail: `probed selected format's codec via yt-dlp (--print vcodec) - copy requested and codec is "${selectedCodec}" (H.264); kept as copy`,
              probed: true,
            });
          }
        } catch (err) {
          steps.push({
            step: 'transcode',
            detail: `probed selected format's codec via yt-dlp (--print vcodec) - probe failed (${err.message}); falling back to proceeding with copy as requested, same as the real route does on this same failure`,
            probed: true,
          });
        }
      }
    }

    // Execution/fallback narrative - describes what happens once the
    // resolved mode/quality/transcode is handed to the real serve function,
    // including retry chains (serveDirect/resolveDirectUrl,
    // streamViaFfmpeg/runPipeline, getOrCreateHlsSession). Static/
    // descriptive, kept in sync by hand rather than derived; skipped
    // entirely when probeShortcut would fire.
    const ffmpegModeBlocked = (mode === 'ffmpeg' || mode === 'hls' || mode === 'hls-tap' || mode === 'hls-buffer' || mode === 'raw-buffer') && !ffmpegAvailable;
    if (!probeShortcut.wouldFire && !ffmpegModeBlocked) {
      if (mode === 'direct') {
        steps.push({ step: 'execution', detail: 'resolve a direct playback URL via yt-dlp (-g)', probed: false });
        steps.push({ step: 'execution', detail: 'if that yt-dlp call fails with a client/session extraction error, retry once with player_client=android', probed: false });
        steps.push({
          step: 'execution',
          detail: 'once a URL is resolved, fetch it; if that fetch is rejected (e.g. HTTP 403 - a session-bound URL), respond 502 - no fallback (mode=direct-pipe is the explicit alternative for this case)',
          probed: false,
        });
      } else if (mode === 'direct-pipe') {
        steps.push({ step: 'execution', detail: 'fetch the resolved format directly through yt-dlp\'s own process (yt-dlp -f <selector> -o -), piped straight to the response - immune to the session-bound-URL 403 plain direct mode can hit', probed: false });
        steps.push({ step: 'execution', detail: 'no Range/seek support - this is a live sequential pipe, not a byte-range fetch; a seek restarts playback from 0', probed: false });
        steps.push({ step: 'execution', detail: 'if yt-dlp fails, respond 502 - no further fallback', probed: false });
      } else if (mode === 'direct-redirect') {
        steps.push({ step: 'execution', detail: 'resolve a direct playback URL via yt-dlp (-g), same as plain direct mode', probed: false });
        steps.push({ step: 'execution', detail: 'if that yt-dlp call fails with a client/session extraction error, retry once with player_client=android', probed: false });
        steps.push({
          step: 'execution',
          detail: 'once resolved, respond with a 302 redirect straight to that URL - Youtarr never fetches the bytes itself, so no cookies/Referer/User-Agent travel with it, and whatever happens next (success or a vprv=1 403) happens entirely between the player and googlevideo, invisible to Youtarr\'s own logs',
          probed: false,
        });
      } else if (mode === 'raw-buffer') {
        steps.push({
          step: 'execution',
          detail: 'if this video is already fully cached (a previous raw-buffer or hls-buffer play finished it): serve it directly as a real Range-backed file, no fetch, no ffmpeg - identical to hls-buffer\'s own already-cached fast path',
          probed: false,
        });
        steps.push({
          step: 'execution',
          detail: 'container/transcode/hardwareMode/tuning are ignored - this mode never re-encodes, only muxes (yt-dlp video+audio piped into one ffmpeg -c copy process, no VAAPI/libx264 involved) - always the source\'s own codec/resolution/bitrate',
          probed: false,
        });
        steps.push({
          step: 'execution',
          detail: 'otherwise: starts (or attaches to an already-running) independent yt-dlp+yt-dlp+ffmpeg(-c copy) fetch for this video - a second concurrent request for the same not-yet-cached video shares this one fetch rather than starting a duplicate',
          probed: false,
        });
        steps.push({
          step: 'execution',
          detail: 'the response streams directly off the growing local file via HTTP Range as it downloads, no HLS session/playlist/segments involved - a forward seek past what\'s downloaded so far just waits for the sequential download to catch up rather than restarting anything',
          probed: false,
        });
        steps.push({
          step: 'execution',
          detail: 'once the fetch finishes: same finalize-into-library (or Youtarr\'s own untracked-video cache, if this video has no Video row) as mode=hls-buffer',
          probed: false,
        });
        steps.push({ step: 'execution', detail: 'if the fetch fails before any bytes are sent, respond 502; a timed-out wait for bytes responds 504 - no fallback', probed: false });
      } else {
        const pipelineDesc = (mode === 'hls' || mode === 'hls-tap' || mode === 'hls-buffer')
          ? 'fetch video+audio via yt-dlp (DASH format selectors) piped into ffmpeg, writing real HLS segment files'
          : 'fetch video+audio via yt-dlp (DASH format selectors) piped into a single live ffmpeg connection';
        steps.push({ step: 'execution', detail: pipelineDesc, probed: false });
        steps.push({
          step: 'execution',
          detail: 'if yt-dlp fails to fetch (a client/session extraction error, or a 403) and nothing has reached the client yet, retry once with player_client=android',
          probed: false,
        });
        if (transcode === 'h264' && hardwareMode !== 'none') {
          steps.push({
            step: 'execution',
            detail: `if the hardware encoder (${hardwareMode}) fails to initialize before any bytes are sent, retry once in software (libx264)`,
            probed: false,
          });
        }
        if (mode === 'hls-tap') {
          steps.push({
            step: 'execution',
            detail: 'only on the session\'s first pass, if it starts at t=0 with no seek: the same ffmpeg process also writes a second, untouched -c copy output (same yt-dlp pipes, before any scale/transcode filter) to a temp file; on that pass completing cleanly, the temp file is moved into the video\'s library folder, the Video row is flipped off STRM (is_strm=false), and the old .strm/.strmtool.json are archived to .cached - this fully replaces strmCacheOnPlay\'s separate download job for this play',
            probed: false,
          });
          steps.push({
            step: 'execution',
            detail: 'a seek before the tap completes (or a first request that already starts mid-video) abandons/never-attempts the tap - its temp file is discarded, never treated as complete',
            probed: false,
          });
        }
        if (mode === 'hls-buffer') {
          steps.push({
            step: 'execution',
            detail: 'a separate, independent yt-dlp+yt-dlp+ffmpeg pipeline (its own network pull, not shared with the HLS encode above) starts immediately and pulls the whole video once, unthrottled, remuxing (-c copy) into a local MPEG-TS buffer file - not tied to this session\'s encode pass, so it keeps running even across seeks or if the viewer stops watching',
            probed: false,
          });
          steps.push({
            step: 'execution',
            detail: 'the cold-start/first pass never waits on a FRESH buffer fetch to catch up - it starts network-sourced immediately, identically to plain mode=hls (so instant-start\'s placeholder segment, if enabled, behaves exactly the same as it does for mode=hls too). The one exception: if this exact video was already fully buffered by a previous play (see the untracked-video case below), that complete local file is used from the very first pass instead, since there\'s nothing left to wait for',
            probed: false,
          });
          steps.push({
            step: 'execution',
            detail: 'every later pass (a seek restart, or a calculatedLength missing-segment restart) waits up to 45s for the buffer to have safely written past its target timestamp, then reads that local file directly instead of pulling from the network; on timeout, that one pass falls back to the same network-sourced path plain mode=hls uses (the buffer fetch itself is unaffected and keeps running)',
            probed: false,
          });
          steps.push({
            step: 'execution',
            detail: 'if this video has a Video row in Youtarr\'s own library and is currently STRM: once the buffer fetch finishes cleanly, its file is moved into the video\'s library folder, the Video row is flipped off STRM (is_strm=false), and every subsequent pass (this session and any other) reads from that finished file - same as hotSwapToCache/mode=hls-tap\'s finalized output',
            probed: false,
          });
          steps.push({
            step: 'execution',
            detail: 'if this video has NO Video row (an NZB mediaMode:\'strm\' grab Youtarr never catalogued, or one it later disowned via importStrategy:\'untracked\'): the buffer-fetch still runs (there\'s nothing library-specific about the fetch itself), but the finished file lands in Youtarr\'s own untracked-buffer cache instead, keyed by youtube id alone - no Video/Job row, not a library entry, never shows up in Download History. A later play of this same untracked video reuses that cached file directly (no network fetch, used from the very first pass) instead of buffering again',
            probed: false,
          });
        }
        steps.push({
          step: 'execution',
          detail: (mode === 'hls' || mode === 'hls-tap' || mode === 'hls-buffer')
            ? 'if it still fails, respond 502 (HLS stream failed to start)'
            : 'if it still fails, respond 502 (Stream failed)',
          probed: false,
        });
      }
    }

    return {
      mode,
      requestedMode,
      ffmpegAvailable,
      container,
      transcode,
      hardwareMode,
      tuning,
      requestedQuality,
      quality,
      qualityStrictness,
      qualityCapped,
      seekSeconds,
      calculatedLength,
      hotSwapToCache,
      backfillMissingSegments,
      finalizeToMp4,
      forceServerSettings,
      ignoredQueryParams,
      probeShortcut,
      steps,
    };
  }

    router.get('/api/ytstream/:youtubeId', async (req, res) => {
    // debug (not info): fires on every single request to this route,
    // including every HLS.js/AVPlayer segment poll - see 'ytstream: serving
    // HLS asset' below for the same reasoning. Bump LOG_LEVEL/Settings log
    // level to 'debug' to see these again when actually diagnosing a
    // request-level issue (client identity, headers, probe detection).
    logger.debug(
      {
        url: req.originalUrl,
        query: req.query,
        method: req.method,
        clientIp: resolveClientIp(req),
        headers: redactIncomingHeadersForLogging(req.headers),
        likelyMetadataProbe: isLikelyMetadataProbeRequest(req),
      },
      'ytstream: incoming request'
    );
    const { youtubeId } = req.params;
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(youtubeId)) {
      return res.status(400).send('Invalid video id');
    }

    // Shared by every cached-file-direct-serve check below - see
    // serveCachedFile's own comment for why this only applies to a fresh
    // playback attempt, never mid-session: a calculatedLength session
    // negotiates Range/seek math against its own ESTIMATED length at
    // session start, and swapping in the real file's actual size mid-
    // session makes existing Range requests land at the wrong byte - a
    // bare-"Lavf" request with a large Range offset mid-session isn't a
    // real probe either (those want the file start), it's a genuine player
    // seek, and this same mismatch produced "skipped, then played from the
    // wrong location".
    const hasActiveSessionForVideo = [...hlsSessions.values()].some((s) => s.youtubeId === youtubeId && !s.destroying);

    // ytstream.probeShortcut - must run before EVERYTHING else in this
    // handler (cache-on-play trigger included): a detected metadata probe
    // must never cause real ffmpeg/HLS session work or a background
    // download. Only exception: one bare `yt-dlp --print duration` call the
    // first time an untracked video is probed - a few seconds, not the
    // 15-45s+ a real cold start costs, and cached (getVideoDurationSeconds)
    // so it's never repeated.
    {
      const probeCfg = (configModule.getConfig().ytstream) || {};
      const probeQueryOverride = (name) => (probeCfg.forceServerSettings === true ? undefined : req.query[name]);
      if (evaluateProbeShortcut(req, configModule.getConfig()).wouldFire) {
        const existingCachedFilePath = hasActiveSessionForVideo ? null : await findExistingCachedVideoFilePath(youtubeId, models);
        if (existingCachedFilePath) {
          logger.info(
            { youtubeId, filePath: existingCachedFilePath },
            'ytstream: probe-shortcut - a real cached copy of this video already exists; serving it directly instead of the synthetic clip'
          );
          const servedReal = await tryServeCachedVideoFile(req, res, existingCachedFilePath);
          if (servedReal) return;
          // Fell through (e.g. the file vanished between the check and the
          // stat) - fall back to the synthetic clip below rather than fail
          // the probe outright.
        }
        const sourceResolution = await resolveVideoTargetResolution(youtubeId, models);
        const probeQuality = probeQueryOverride('quality') || probeCfg.quality || configModule.getConfig().preferredResolution || '720';
        const { width, height } = capResolutionToHeight(sourceResolution.width, sourceResolution.height, resolveQualityHeight(probeQuality));
        const served = await tryServeProbeClip(req, res, {
          hardwareMode: normalizeHardwareMode(probeQueryOverride('hardware') || probeCfg.hardwareMode || 'none'),
          tuning: normalizeTuning(probeQueryOverride('tuning') || probeCfg.tuning || 'fast'),
          width,
          height,
          youtubeId,
          resolveDurationSeconds: (id) => getVideoDurationSeconds(id, configModule.getConfig()),
        });
        if (served) return;
        // Generation failed - fall through to normal handling below.
      }
    }

    // ytstream.serveCachedFile: if this video is already fully downloaded
    // (STRM cache-on-play, or any genuine download), serve that real local
    // file directly - see tryServeCachedVideoFile above. Checked before the
    // cache-on-play trigger and before any mode/quality resolution. Off by
    // default.
    //
    // Only for the FIRST request of a fresh playback attempt (no live HLS
    // session yet) - applying this mid-session breaks playback: a
    // calculatedLength session has negotiated Range/seek math against its
    // ESTIMATED length, and swapping in the real file's different size
    // mid-session made Range requests land at the wrong offset (the video
    // repeatedly jumped forward). An already-running mode=hls session
    // instead gets the real file via maybeHotSwapToCache, which preserves
    // segment/index continuity instead.
    if ((configModule.getConfig().ytstream || {}).serveCachedFile === true && models && models.Video) {
      if (!hasActiveSessionForVideo) {
        try {
          // Timed: this is the ONLY awaited call between 'incoming request'
          // and resolvePlaybackPlan's first probe, so a multi-second gap
          // between those log lines has to be spent here or in Node's event
          // loop. youtubeId is indexed, so a large elapsedMs here points at
          // DB contention or a slow query, not anything downstream.
          const serveCachedFileLookupStarted = Date.now();
          const cachedVideo = await models.Video.findOne({
            where: { youtubeId },
            attributes: ['is_strm', 'filePath'],
          });
          const serveCachedFileLookupMs = Date.now() - serveCachedFileLookupStarted;
          if (serveCachedFileLookupMs > 250) {
            logger.warn({ youtubeId, serveCachedFileLookupMs }, 'ytstream: serveCachedFile\'s Video lookup was unexpectedly slow');
          }
          if (cachedVideo && cachedVideo.is_strm === false && cachedVideo.filePath && fs.existsSync(cachedVideo.filePath)) {
            logger.info({ youtubeId, filePath: cachedVideo.filePath }, 'ytstream: serving already-downloaded local file directly (serveCachedFile)');
            const served = await tryServeCachedVideoFile(req, res, cachedVideo.filePath);
            if (served) return;
          }
        } catch (err) {
          logger.warn({ err, youtubeId }, 'ytstream: serveCachedFile lookup failed; falling back to normal handling');
        }
      }
    }

    // Fire-and-forget: every STRM play (browser redirect from videoDetail.js,
    // or a media server reading the raw ytstream URL baked into its .strm
    // file) passes through here, so this is the one place that sees every
    // play. Never awaited - must add zero latency to the response below.
    //
    // Cheap, synchronous, hand-maintained mirror of resolvePlaybackPlan's
    // mode/seek resolution (same trade-off/precedent as the probeShortcut
    // pre-check above it) - only used to decide whether mode=hls-tap will
    // actually attempt its own tap for THIS request, so the cache-on-play
    // trigger below can be skipped without adding a DB/probe round trip to
    // every single request just to make that call.
    const cheapCfg = configModule.getConfig().ytstream || {};
    const cheapForced = cheapCfg.forceServerSettings === true;
    const cheapMode = String((cheapForced ? undefined : req.query.mode) || cheapCfg.defaultMode || 'direct').toLowerCase();
    // mode=hls-buffer/raw-buffer also replace cache-on-play entirely (their
    // own independent fetch does the same job, without hls-tap's "only a
    // perfect uninterrupted play-through" limitation) - unlike tap, neither
    // is restricted to an un-seeked t=0 request, since the buffer fetch
    // doesn't depend on which segment is being played at all.
    const tapWillAttempt = cheapMode === 'hls-tap' && !req.query.t;
    const bufferWillAttempt = cheapMode === 'hls-buffer' || cheapMode === 'raw-buffer';
    require('../modules/strmCacheOnPlay').maybeEnqueueCacheDownload(youtubeId, { skip: tapWillAttempt || bufferWillAttempt }).catch((err) =>
      logger.warn({ err, youtubeId }, 'ytstream: cache-on-play trigger failed')
    );

    // Cheap/nominal mirrors of resolvePlaybackPlan's own transcode/
    // calculatedLength resolution (same forceServerSettings-aware
    // precedence, just inlined instead of using its closure-scoped
    // queryOverride helper) - used by the two warm-ups below.
    const cheapTranscode = VALID_TRANSCODE.includes(cheapForced ? undefined : req.query.transcode)
      ? req.query.transcode
      : (cheapCfg.transcode || 'copy');
    const cheapCalculatedLengthRaw = (cheapForced ? undefined : (req.query.calculatedLength ?? req.query.fakeLength)) ?? cheapCfg.calculatedLength;
    const cheapIsHlsFamily = cheapMode === 'hls' || cheapMode === 'hls-tap' || cheapMode === 'hls-buffer';
    // getModeFieldCompatibility is cheap/synchronous/pure itself - no need
    // for a separately-hand-maintained duplicate of its calculatedLength
    // rule here, unlike cheapIsHlsFamily above (a general mode-category
    // check the placeholder warm-up below also needs on its own, not
    // specific to any one field's compatibility).
    const cheapCalculatedLength = getModeFieldCompatibility({ mode: cheapMode, transcode: cheapTranscode }).calculatedLength.status === 'forced'
      ? true
      : parseBooleanQueryFlag(cheapCalculatedLengthRaw);

    // Duration warm-up: kicked off here too, for the SAME reason as the
    // placeholder warm-up below - createHlsSessionInternal's own
    // getVideoDurationSeconds call only runs after resolvePlaybackPlan (and
    // its quality/codec probes) has already fully finished, so without this
    // the two were fully serial (probe, THEN duration lookup) rather than
    // overlapping. Observed live: a ~7s quality probe followed by a further
    // ~5s duration lookup (this video's duration wasn't cached in the DB
    // yet) - back to back, ~12s before anything reached the client at all,
    // even with the placeholder fix below in place. Broader gate than the
    // placeholder's (no instantStart/transcode requirement) since duration
    // is needed for every calculatedLength session, not just instant-start
    // ones. Dedup'd against the real call via durationLookupPromises, so
    // this never spawns a second yt-dlp process for the same video.
    if (cheapCalculatedLength && cheapIsHlsFamily) {
      getVideoDurationSeconds(youtubeId, configModule.getConfig()).catch((err) =>
        logger.warn({ err, youtubeId }, 'ytstream: early calculatedLength duration warm-up failed')
      );
    }

    // ytstream.instantStart placeholder warm-up: fire-and-forget, started
    // this early (concurrently with resolvePlaybackPlan's own yt-dlp probes
    // below - resolveEffectiveQualityHeight/resolveVideoCodec, either of
    // which can take several seconds on a cache miss) rather than waiting
    // for the real plan to resolve first. Uses the REQUESTED/configured
    // quality directly - not the probe's auto-capped value - because
    // resolveVideoTargetResolution already reflects this video's real known
    // resolution independent of that probe, so capResolutionToHeight
    // produces the same effective placeholder height either way in the
    // overwhelming common case (the probe only ever lowers a request that's
    // higher than the source truly has, and resolveVideoTargetResolution's
    // cached value already reflects that same ceiling). ensurePlaceholderSegment's
    // own cache/dedup (keyed by youtubeId + these resolved dimensions) means
    // this is never wasted: createHlsSessionInternal's own placeholder call
    // later either finds this already done or joins the same in-flight
    // generation - and on the rare disagreement, that later call just
    // generates its own instead, no worse than not warming up at all.
    if (
      cheapCfg.instantStart === true &&
      cheapCalculatedLength &&
      cheapTranscode === 'h264' &&
      cheapIsHlsFamily
    ) {
      const cheapHardwareMode = normalizeHardwareMode((cheapForced ? undefined : req.query.hardware) || cheapCfg.hardwareMode || 'none');
      const cheapTuning = normalizeTuning((cheapForced ? undefined : req.query.tuning) || cheapCfg.tuning || 'fast');
      const cheapQuality = String((cheapForced ? undefined : req.query.quality) || cheapCfg.quality || configModule.getConfig().preferredResolution || '720');
      const { segmentType: cheapSegmentType, segmentExt: cheapSegmentExt } = getHlsContainerInfo(cheapCfg.container || 'mp4');
      (async () => {
        const sourceResolution = await resolveVideoTargetResolution(youtubeId, models);
        const { width, height } = capResolutionToHeight(sourceResolution.width, sourceResolution.height, resolveQualityHeight(cheapQuality));
        const thumbnailPath = resolveLocalThumbnailPath(youtubeId);
        await ensurePlaceholderSegment({
          youtubeId,
          thumbnailPath,
          segmentType: cheapSegmentType,
          segmentExt: cheapSegmentExt,
          hardwareMode: cheapHardwareMode,
          tuning: cheapTuning,
          width,
          height,
        });
      })().catch((err) => logger.warn({ err, youtubeId }, 'ytstream: early instant-start placeholder warm-up failed'));
    }

    const config = configModule.getConfig();
    const ytCfg = config.ytstream || {};

    // Every playback setting (mode/container/transcode/hardwareMode/tuning/
    // quality/calculatedLength/hotSwapToCache), including the
    // forceServerSettings query-override gate and the ffmpeg-availability
    // mode fallback, is resolved by the shared resolvePlaybackPlan - see
    // its doc comment above. Also used (with probe:false) by the read-only
    // GET /api/ytstream/:youtubeId/simulate debug route below, so the two
    // can never drift out of sync.
    const plan = await resolvePlaybackPlan(youtubeId, req, config, { probe: true });
    const {
      mode,
      container,
      transcode,
      hardwareMode,
      tuning,
      quality,
      qualityStrictness,
      seekSeconds,
      calculatedLength,
      hotSwapToCache,
    } = plan;

    // mode=direct: resolves a URL and proxies it, no retry beyond
    // resolveDirectUrl's own extraction-error retry. On a 403 (a vprv=1
    // session-bound URL rejection) it fails cleanly, full stop - no
    // automatic switch to a different behavior. mode=direct-pipe (see
    // pipeDirectStreamViaYtDlp, below) is the explicit, separately-selected
    // mode for when that resilience is wanted instead.
    const serveDirect = async (playerClient) => {
      // Not a live/trackable session on the Streaming page (no process to
      // show a Stop button for, unlike direct-pipe) - just a StreamHistory
      // audit row, same reasoning as redirectToDirectUrl, so at least a
      // failed/succeeded request shows up somewhere instead of leaving
      // mode=direct completely unaccounted for.
      const streamId = crypto.randomUUID();
      const historyEntry = {
        streamId,
        mode: 'direct',
        youtubeId,
        quality,
        clientIp: resolveClientIp(req),
        userAgent: req.headers['user-agent'] || null,
        startedAt: Date.now(),
      };
      persistStreamHistoryStart(historyEntry);
      try {
        const url = await resolveDirectUrl(youtubeId, config, quality, playerClient, qualityStrictness);
        const cookiesPath = configModule.getCookiesPath && configModule.getCookiesPath();
        const cookieHeader = loadYoutubeCookieHeader(cookiesPath);
        logger.info({ youtubeId, quality }, 'ytstream: proxying direct upstream stream (Simple mode)');
        res.set({ 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' });
        await proxyDirectStream(url, req, res, cookieHeader);
        persistStreamHistoryEnd(historyEntry, 'completed', null);
      } catch (err) {
        persistStreamHistoryEnd(historyEntry, 'error', err.message);
        logger.error({ youtubeId, err: err.message }, 'ytstream: direct stream failed');
        if (!res.headersSent) {
          res.status(502).send(`Direct stream failed: ${err.message}`);
        } else if (!res.writableEnded) {
          try { res.end(); } catch { /* ignore */ }
        }
      }
    };

    try {
      if ((mode === 'ffmpeg' || mode === 'hls' || mode === 'hls-tap' || mode === 'hls-buffer' || mode === 'raw-buffer') && !plan.ffmpegAvailable) {
        // No fallback to direct - each mode does exactly what it says. If
        // ffmpeg genuinely isn't installed/working on this host,
        // mode=ffmpeg/hls/hls-tap/hls-buffer/raw-buffer just fails outright
        // instead of silently downgrading to a different mode's behavior.
        logger.error({ youtubeId, mode }, `ytstream: mode=${mode} requested but ffmpeg is unavailable on this host`);
        res.status(502).send(`Stream failed: mode=${mode} requires ffmpeg, which is not available on this host`);
        return;
      }

      if (mode === 'direct-pipe') {
        // Live-trackable, unlike direct/direct-redirect: a real yt-dlp
        // child process for the life of the stream, same shape as
        // mode=ffmpeg's tracked sessions - visible + stoppable on the
        // Streaming page, not just a history row.
        const streamId = crypto.randomUUID();
        trackStream({
          streamId,
          mode: 'direct-pipe',
          youtubeId,
          quality,
          clientIp: resolveClientIp(req),
          userAgent: req.headers['user-agent'] || null,
          state: 'starting',
          startedAt: Date.now(),
          bytesTransferred: 0,
          bytesPerSecond: 0,
          lastActivityAt: Date.now(),
          stop: null, // wired inside pipeDirectStreamViaYtDlp once the process exists
        });
        try {
          await pipeDirectStreamViaYtDlp(youtubeId, config, quality, qualityStrictness, ytCfg.playerClient, calculatedLength, req, res, streamId);
        } catch (err) {
          logger.error({ youtubeId, err: err.message }, 'ytstream: direct-pipe stream failed');
          if (!res.headersSent) {
            res.status(502).send(`Direct-pipe stream failed: ${err.message}`);
          } else if (!res.writableEnded) {
            try { res.end(); } catch { /* ignore */ }
          }
        }
        return;
      }

      if (mode === 'direct-redirect') {
        try {
          await redirectToDirectUrl(youtubeId, config, quality, qualityStrictness, ytCfg.playerClient, req, res);
        } catch (err) {
          logger.error({ youtubeId, err: err.message }, 'ytstream: direct-redirect resolve failed');
          if (!res.headersSent) {
            res.status(502).send(`Stream resolution failed: ${err.message}`);
          }
        }
        return;
      }

      if (mode === 'ffmpeg') {
        const containerContentType = container === 'ts' ? 'video/mp2t' : container === 'mkv' ? 'video/x-matroska' : 'video/mp4';
        res.set({
          'Content-Type': containerContentType,
          'Cache-Control': 'no-store',
        });

        let effectiveSeekSeconds = seekSeconds;
        let responseShaping;

        if (calculatedLength) {
          try {
            const height = resolveQualityHeight(quality);
            const durationSeconds = await getVideoDurationSeconds(youtubeId, config);
            const bytesPerSecond = estimateBitrateBytesPerSecond(height);
            const estimatedTotalBytes = Math.ceil(durationSeconds * bytesPerSecond);
            logger.info(
              { youtubeId, method: req.method, rangeHeader: req.headers.range || null, durationSeconds, bytesPerSecond, estimatedTotalBytes },
              'ytstream: calculatedLength estimate computed'
            );

            if (req.method === 'HEAD') {
              res.set({ 'Accept-Ranges': 'bytes', 'Content-Length': String(estimatedTotalBytes) });
              return res.status(200).end();
            }

            const range = parseByteRange(req.headers.range, estimatedTotalBytes);
            if (range && range.invalid) {
              logger.warn({ youtubeId, rangeHeader: req.headers.range, estimatedTotalBytes }, 'ytstream: calculatedLength Range unsatisfiable (416)');
              res.set('Content-Range', `bytes */${estimatedTotalBytes}`);
              return res.status(416).end();
            }

            if (range) {
              const targetLength = range.end - range.start + 1;
              effectiveSeekSeconds = range.start / bytesPerSecond;
              responseShaping = {
                status: 206,
                targetLength,
                headers: {
                  'Accept-Ranges': 'bytes',
                  'Content-Length': String(targetLength),
                  'Content-Range': `bytes ${range.start}-${range.end}/${estimatedTotalBytes}`,
                },
              };
            } else {
              responseShaping = {
                status: 200,
                targetLength: estimatedTotalBytes,
                headers: {
                  'Accept-Ranges': 'bytes',
                  'Content-Length': String(estimatedTotalBytes),
                },
              };
            }
          } catch (err) {
            // Duration lookup failed (unavailable video, transient yt-dlp
            // error, etc.) — fall back to the normal chunked/unknown-length
            // ffmpeg response rather than failing the whole request over a
            // feature that's opt-in and inherently approximate anyway.
            logger.warn(
              { youtubeId, err: err.message },
              'ytstream: calculatedLength duration lookup failed; falling back to normal chunked response'
            );
          }
        }

        if (calculatedLength) {
          logger.info(
            { youtubeId, effectiveSeekSeconds, responseShaping },
            'ytstream: dispatching ffmpeg mode with calculatedLength responseShaping'
          );
        }

        // Streaming-page tracking entry — created once per HTTP request
        // (not per runPipeline attempt) so it survives streamViaFfmpeg's
        // internal retries (403/extraction-error, hw->software fallback),
        // which only ever happen before any byte reaches the client.
        const streamId = crypto.randomUUID();
        trackStream({
          streamId,
          mode: 'ffmpeg',
          youtubeId,
          quality,
          container,
          transcode,
          hardwareMode,
          tuning,
          clientIp: resolveClientIp(req),
          userAgent: req.headers['user-agent'] || null,
          state: 'starting',
          startedAt: Date.now(),
          bytesTransferred: 0,
          bytesPerSecond: 0,
          lastActivityAt: Date.now(),
          stop: null, // wired inside runPipeline once cleanup() exists
        });

        // Await so Express holds the connection open until streamViaFfmpeg's
        // response finishes, rather than returning control (and letting the
        // route handler's outer try/catch fall through) while it's still streaming.
        return await streamViaFfmpeg({
          youtubeId,
          quality,
          qualityStrictness,
          container,
          transcode,
          hardwareMode,
          tuning,
          seekSeconds: effectiveSeekSeconds,
          config,
          res,
          req,
          responseShaping,
          streamId,
        });
      }

      if (mode === 'hls' || mode === 'hls-tap' || mode === 'hls-buffer') {
        const isTapMode = mode === 'hls-tap';
        const isBufferMode = mode === 'hls-buffer';
        const sessionKey = buildHlsSessionKey({ youtubeId, quality, qualityStrictness, transcode, hardwareMode, tuning, container, playerClient: ytCfg.playerClient, calculatedLength, tap: isTapMode, buffer: isBufferMode });
        const baseUrl = `${req.protocol}://${req.get('host')}/api/ytstream/${encodeURIComponent(youtubeId)}/hls/${sessionKey}/`;

        let clientGoneWhileWaiting = false;
        const onClientGoneWhileWaiting = () => {
          clientGoneWhileWaiting = true;
          logger.warn(
            { youtubeId, sessionKey },
            'ytstream: client disconnected from mode=hls request while still waiting for the HLS session to become ready'
          );
        };
        req.once('aborted', onClientGoneWhileWaiting);
        req.once('close', onClientGoneWhileWaiting);

        const waitStarted = Date.now();
        try {
          const session = await getOrCreateHlsSession(sessionKey, {
            youtubeId, quality, qualityStrictness, transcode, hardwareMode, tuning, container, config, baseUrl, seekSeconds, calculatedLength,
            // mode=hls-tap/hls-buffer both replace hotSwapToCache/cache-on-play
            // entirely rather than layering on top of it - see spawnHlsEncodePass's
            // tap logic and startHlsBufferFetch respectively.
            hotSwapToCache: (isTapMode || isBufferMode) ? false : hotSwapToCache,
            tapEnabled: isTapMode,
            bufferEnabled: isBufferMode,
            clientIp: resolveClientIp(req),
            userAgent: req.headers['user-agent'] || null,
          });
          // debug: fires on every playlist request for an already-running
          // session (most of them - only the very first is a real cold
          // start), not just once per session.
          logger.debug(
            { youtubeId, sessionKey, waitMs: Date.now() - waitStarted, clientGoneWhileWaiting },
            'ytstream: HLS session ready; serving playlist'
          );
          if (clientGoneWhileWaiting || res.writableEnded) {
            return;
          }
          maybeStripPlaceholderFromPlaylist(session);
          const rawPlaylist = await fs.promises.readFile(session.playlistPath, 'utf8');
          const playlist = rewriteHlsPlaylistUrls(rawPlaylist, session.baseUrl);
          res.set({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
          return res.status(200).send(playlist);
        } catch (err) {
          logger.error(
            { youtubeId, sessionKey, waitMs: Date.now() - waitStarted, clientGoneWhileWaiting, err: err.message },
            'ytstream: HLS session failed to become ready'
          );
          if (!res.headersSent && !clientGoneWhileWaiting) {
            res.status(502).send(`HLS stream failed to start: ${err.message}`);
          }
          return;
        } finally {
          req.removeListener('aborted', onClientGoneWhileWaiting);
          req.removeListener('close', onClientGoneWhileWaiting);
        }
      }

      if (mode === 'raw-buffer') {
        const { getRawBufferFetch } = require('../modules/ytstreamRawBufferFetch');
        const isProbeRequest = isLikelyMetadataProbeRequest(req);

        // REVERTED 2026-09-02 (same day): this used to reject any
        // additional concurrent probe for a video with a 502 while an
        // earlier one was still in flight, on the theory that they were
        // redundant retries. Confirmed live that theory was wrong and this
        // broke real playback outright: the actual request pattern
        // alternates `bytes=0-` and a tail range across many requests in
        // one burst - not repeats of the same request, but sequential
        // steps of a single real probing operation (read the header, seek
        // to the end for trailer/duration info, repeat) that a prober
        // genuinely needs to complete. Rejecting the later steps with a 502
        // broke the probe's own multi-request sequence and playback failed.
        // Every probe request is served on its own merits again now - no
        // gate, no shared/deduped tracking, plain trackStream/untrackStream
        // with its own streamId like real playback gets. This does bring
        // back the earlier cosmetic issue (Active Streams can show more
        // than one row for a burst of overlapping probes) - accepted
        // deliberately: correctness of real playback matters far more than
        // that. See [[ytstream_raw_buffer_and_segment_bug]] for the fuller
        // history here (ref-counted sharing was tried before this and also
        // had a real, never-fully-root-caused leak).

        {
          // Already fully cached (a previous raw-buffer or hls-buffer play
          // finished it) - identical fast path to hls-buffer's own
          // already-cached case, no fetch/registry involved at all.
          const cachedFilePath = await findExistingCachedVideoFilePath(youtubeId, models);
          if (cachedFilePath) {
            // 'cached', not 'active', for a probe specifically -
            // tryServeCachedVideoFile is a plain fs.createReadStream against
            // an already-complete file (its own doc comment: "no yt-dlp, no
            // ffmpeg, just an ordinary static-file HTTP serve") - nothing is
            // being fetched or encoded right now, unlike the 'active' state
            // used below for an in-progress fetch. Real playback keeps
            // 'active' either way - a human watching is "active" regardless
            // of whether the bytes happen to already be on disk.
            const streamId = crypto.randomUUID();
            trackStream({
              streamId, mode: 'raw-buffer', youtubeId, quality,
              clientIp: resolveClientIp(req), userAgent: req.headers['user-agent'] || null,
              state: isProbeRequest ? 'cached' : 'active', startedAt: Date.now(), bytesTransferred: 0, bytesPerSecond: 0,
              lastActivityAt: Date.now(), stop: null,
            });
            const served = await tryServeCachedVideoFile(req, res, cachedFilePath);
            untrackStream(streamId, served ? 'completed' : 'error');
            if (served) return;
            // Stat/read failed unexpectedly - fall through to a fresh fetch below.
          }

          let entry = getRawBufferFetch(youtubeId);
          if (!entry) {
            const { finalPath, untracked } = await resolveRawBufferDestination(youtubeId);
            const { videoFormat, audioFormat } = getDashFormatSelectors(quality, qualityStrictness);
            let durationSeconds = null;
            let lengthEstimate = null;
            try {
              // All three independent yt-dlp lookups run concurrently - see
              // combineRawBufferContentLength's doc comment on why this used
              // to serialize them (duration, then both size probes) and add
              // real time-to-first-byte latency for no benefit.
              const [duration, videoBytes, audioBytes] = await Promise.all([
                getVideoDurationSeconds(youtubeId, config),
                probeRawFormatSizeBytes(youtubeId, config, videoFormat),
                probeRawFormatSizeBytes(youtubeId, config, audioFormat),
              ]);
              durationSeconds = duration;
              lengthEstimate = combineRawBufferContentLength(videoBytes, audioBytes, durationSeconds, resolveQualityHeight(quality));
            } catch (err) {
              logger.warn({ err, youtubeId }, 'ytstream: raw-buffer duration/length estimate failed; proceeding without a Content-Length');
            }
            entry = startRawBufferFetch(youtubeId, { quality, qualityStrictness, config, finalPath, untracked, durationSeconds, lengthEstimate });
          }

          // A metadata-probe request (Lavf/ffprobe - see
          // isLikelyMetadataProbeRequest) is exactly what determines the
          // duration/length a player later trusts - confirmed live
          // 2026-09-02: this is genuinely how Jellyfin learns the file's
          // real length for an untracked (no Video row, so no
          // .strmtool.json sidecar - see writeMediaInfoCacheFile/
          // strmMaterializer.js, which only ever runs for tracked videos)
          // STRM item, not a formality it ignores. Serving a probe the
          // live, still-growing file - an ESTIMATED Content-Length, real
          // natural stalls waiting for bytes not downloaded yet, possibly
          // ending in TS-null-packet padding - was suspected (and, after
          // fixing the padding specifically without resolving the symptom,
          // effectively confirmed) to be exactly what was corrupting the
          // reported duration, regardless of how accurate the length
          // ESTIMATE itself was made. A probe has no need for instant
          // playback the way real playback does, so there's no real cost
          // to making ONLY probe requests wait here for the fetch to
          // actually finish (bounded, same budget as an HLS cold start) -
          // once `entry.status` is 'done', tryServeGrowingRawFile below
          // already prefers `entry.finalSize` over `entry.lengthEstimate`
          // for its Content-Length with zero further changes needed,
          // giving the probe an exact size, no stalls, and no padding at
          // all. Real playback (a real player's UA, not Lavf) is
          // completely unaffected - still gets the fast progressive path
          // immediately.
          // Also requires a genuine tail/trailer read (Range start > 0), not
          // just the UA-based isProbeRequest flag alone: isLikelyMetadataProbeRequest
          // is a heuristic (a bare "Lavf/x.y.z" User-Agent) that assumes real
          // playback always carries the .strm's embedded custom-UA marker
          // instead - true for direct play, but NOT provably true the moment
          // this mode forces a server-side transcode (raw-buffer's .ts often
          // isn't direct-playable), since a transcoding player's own internal
          // ffmpeg invocation may not propagate that marker at all. If that
          // ever misfires on a genuine playback request, this wait must NOT
          // be the thing that catches it - a `bytes=0-`/headerless request is
          // exactly what real playback needs immediately to start at all, and
          // is indistinguishable from a probe's own leading request (see the
          // comment above on the alternating bytes=0-/tail-range pattern), so
          // waiting on it risks stalling real playback for the entire
          // download instead of just the probe. A nonzero start offset (the
          // trailer/duration read) is what actually benefits from an exact
          // final size and is never something real progressive playback
          // sends this early, so gating on it here is a safe second signal
          // even if the UA check alone is wrong.
          const rangeMatch = typeof req.headers.range === 'string' ? /^bytes=(\d+)-/.exec(req.headers.range) : null;
          const looksLikeTailRead = !!rangeMatch && Number(rangeMatch[1]) > 0;
          if (entry.status === 'running' && isProbeRequest && looksLikeTailRead) {
            const probeWaitStart = Date.now();
            const probeWaitDeadline = probeWaitStart + HLS_READY_TIMEOUT_MS;
            while (entry.status === 'running' && Date.now() < probeWaitDeadline) {
              await new Promise((resolve) => setTimeout(resolve, HLS_READY_POLL_INTERVAL_MS));
            }
            logger.debug(
              { youtubeId, entryStatus: entry.status, waitedMs: Date.now() - probeWaitStart },
              'ytstream: raw-buffer metadata probe waited for the fetch to finish before serving - exact Content-Length, no stalls, no padding'
            );
          }

          const streamId = crypto.randomUUID();
          trackStream({
            streamId, mode: 'raw-buffer', youtubeId, quality,
            clientIp: resolveClientIp(req), userAgent: req.headers['user-agent'] || null,
            state: 'active', startedAt: Date.now(), bytesTransferred: 0, bytesPerSecond: 0,
            lastActivityAt: Date.now(), stop: null,
          });
          try {
            await tryServeGrowingRawFile(req, res, entry, streamId);
            untrackStream(streamId, 'completed');
          } catch (err) {
            logger.error({ err, youtubeId }, 'ytstream: raw-buffer serve failed');
            untrackStream(streamId, 'error', err.message);
            if (!res.headersSent) res.status(502).send(`Stream failed: ${err.message}`);
            else if (!res.writableEnded) { try { res.end(); } catch { /* ignore */ } }
          }
          return;
        }
      }

      return await serveDirect();
    } catch (err) {
      logger.error({ err, youtubeId, msg: err.message }, 'ytstream: resolve failed');
      if (!res.headersSent) {
        logger.error({ youtubeId, err: err.message }, 'ytstream: stream resolution failed');
        res.status(502).send(`Stream resolution failed: ${err.message}`);
      } else {
        logger.error({ youtubeId, err: err.message }, 'ytstream: stream resolution failed after headers sent; closing connection');
        res.end();
      }
    }
  });


  router.get('/api/ytstream/:youtubeId/formats', authMiddleware, async (req, res) => {
    const { youtubeId } = req.params;
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(youtubeId)) {
      return res.status(400).send('Invalid video id');
    }
    try {
      const config = configModule.getConfig();
      const args = [
        ...buildBaseArgs(config),
        '-F',
        '--no-playlist',
        '--no-warnings',
        `https://youtube.com/watch?v=${youtubeId}`,
      ];
      const stdout = await ytDlpRunner.run(args, { timeoutMs: 60000 });
      res.type('text/plain').send(stdout);
    } catch (err) {
      res.status(502).send(`Failed to list formats: ${err.message}`);
    }
  });

  /**
   * Dry-run for the main streaming route: accepts the exact same query
   * params a real .strm URL would (mode/quality/container/transcode/
   * hardware/tuning/calculatedLength|fakeLength/t), runs them through the
   * same resolvePlaybackPlan() the real route uses, and reports what would
   * happen - without ever resolving a real playback URL, spawning yt-dlp/
   * ffmpeg, creating an HLS session, proxying bytes, or triggering the
   * cache-on-play download. Safe to hit repeatedly.
   *
   * `?probe=true` additionally runs the two real yt-dlp lookups
   * resolvePlaybackPlan can optionally do (the best-available-height auto
   * cap and the transcode=copy codec check), so the trace matches exactly
   * what a real request against this video would decide - at the cost of
   * the same yt-dlp latency a real request would pay. Omit it (the
   * default) for an instant, no-network structural check of the decision
   * flow itself.
   */
  router.get('/api/ytstream/:youtubeId/simulate', authMiddleware, async (req, res) => {
    const { youtubeId } = req.params;
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(youtubeId)) {
      return res.status(400).send('Invalid video id');
    }
    try {
      const config = configModule.getConfig();
      const probe = /^(1|true|yes)$/i.test(String(req.query.probe || ''));
      const plan = await resolvePlaybackPlan(youtubeId, req, config, { probe });

      const isDirectFamilyMode = plan.mode === 'direct' || plan.mode === 'direct-pipe' || plan.mode === 'direct-redirect';
      const formatSelectors = isDirectFamilyMode
        ? { direct: getDirectFormatSelector(plan.quality, plan.qualityStrictness) }
        : getDashFormatSelectors(plan.quality, plan.qualityStrictness);

      let hls = null;
      let wouldCall;
      const ffmpegModeBlocked = (plan.mode === 'ffmpeg' || plan.mode === 'hls' || plan.mode === 'hls-tap' || plan.mode === 'hls-buffer' || plan.mode === 'raw-buffer') && !plan.ffmpegAvailable;
      if (plan.probeShortcut.wouldFire) {
        wouldCall = 'tryServeProbeClip(...) [probeShortcut - real request never reaches the mode/quality logic above]';
      } else if (ffmpegModeBlocked) {
        wouldCall = `502 - mode=${plan.mode} requires ffmpeg, which is unavailable on this host (no fallback to a different mode)`;
      } else if (plan.mode === 'ffmpeg') {
        wouldCall = `streamViaFfmpeg({ quality: "${plan.quality}", container: "${plan.container}", transcode: "${plan.transcode}", hardwareMode: "${plan.hardwareMode}", tuning: "${plan.tuning}" })`;
      } else if (plan.mode === 'raw-buffer') {
        wouldCall = 'findExistingCachedVideoFilePath(...) -> tryServeCachedVideoFile(...) if already cached, else startRawBufferFetch(...) + tryServeGrowingRawFile(...) [no HLS session, no re-encode - container/transcode/hardwareMode/tuning are ignored]';
      } else if (plan.mode === 'hls' || plan.mode === 'hls-tap' || plan.mode === 'hls-buffer') {
        const sessionKey = buildHlsSessionKey({
          youtubeId,
          quality: plan.quality,
          qualityStrictness: plan.qualityStrictness,
          transcode: plan.transcode,
          hardwareMode: plan.hardwareMode,
          tuning: plan.tuning,
          container: plan.container,
          playerClient: (config.ytstream || {}).playerClient,
          calculatedLength: plan.calculatedLength,
          tap: plan.mode === 'hls-tap',
          buffer: plan.mode === 'hls-buffer',
        });
        hls = { sessionKey, sessionAlreadyActive: hlsSessions.has(sessionKey) };
        wouldCall = `getOrCreateHlsSession(sessionKey: "${sessionKey}")`;
      } else if (plan.mode === 'direct-pipe') {
        wouldCall = `pipeDirectStreamViaYtDlp(quality: "${plan.quality}")`;
      } else if (plan.mode === 'direct-redirect') {
        wouldCall = `redirectToDirectUrl(quality: "${plan.quality}") [302, no proxy]`;
      } else {
        wouldCall = `serveDirect(quality: "${plan.quality}")`;
      }

      res.json({ youtubeId, probed: probe, plan, formatSelectors, hls, wouldCall });
    } catch (err) {
      res.status(500).json({ error: `Simulation failed: ${err.message}` });
    }
  });

  /** Force-stops one active stream — the Streaming page's Stop button. */
  router.post('/api/ytstream/streams/:streamId/stop', authMiddleware, (req, res) => {
    const entry = activeStreams.get(req.params.streamId);
    if (!entry) {
      return res.status(404).json({ error: 'Stream not found' });
    }
    try {
      if (typeof entry.stop === 'function') {
        entry.stop();
      } else {
        // stop() isn't wired up until runPipeline's cleanup() exists —
        // narrow window right at request start. Untrack directly rather
        // than leaving the row stuck with a dead Stop button.
        untrackStream(req.params.streamId, 'manual-stop');
      }
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err, streamId: req.params.streamId }, 'ytstream: failed to stop stream');
      res.status(500).json({ error: 'Failed to stop stream' });
    }
  });

  /**
   * Serves an HLS session's playlist/init/segment files as ordinary
   * static files — no live-pipe/estimation concerns at all, since by the
   * time a URL for one of these exists in a playlist, ffmpeg has already
   * finished writing it to disk. Segments are immutable once written, so
   * they're cacheable indefinitely; the playlist itself isn't (it keeps
   * growing while the session is active).
   */
  router.get('/api/ytstream/:youtubeId/hls/:sessionKey/:filename', async (req, res) => {
    const { sessionKey, filename } = req.params;
    if (!/^[a-f0-9]{20}$/.test(sessionKey)) {
      return res.status(400).send('Invalid session key');
    }
    if (!/^(playlist\.m3u8|init\.mp4|placeholder-init\.mp4|placeholder\.(ts|m4s)|segment\d{5}\.(ts|m4s))$/.test(filename)) {
      return res.status(400).send('Invalid filename');
    }
    const session = hlsSessions.get(sessionKey);
    if (!session) {
      logger.warn({ sessionKey, filename }, 'ytstream: HLS asset requested for unknown/expired session');
      return res.status(404).send('HLS session not found or expired');
    }
    session.lastAccess = Date.now();

    const filePath = path.join(session.dir, filename);

    // See maybeStripPlaceholderFromPlaylist's doc comment - a direct fetch
    // of playlist.m3u8 (as opposed to the entry route's own read, which has
    // the same call) is exactly the kind of re-fetch that can otherwise
    // hand back a stale, placeholder-still-included playlist well after the
    // real content caught up.
    if (filename === 'playlist.m3u8') {
      maybeStripPlaceholderFromPlaylist(session);
    }

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
        logger.debug(
          {
            sessionKey,
            filename,
            size: stat.size,
            range: req.headers.range || null,
            mtimeMs: stat.mtimeMs,
            expectedStartSeconds: segmentIndex !== null ? segmentIndex * HLS_SEGMENT_DURATION_SECONDS : null,
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
            logger.debug(
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

      // Streaming-page byte counter — the route never sends a partial
      // Range response for segments (always the full file), so stat.size
      // is the true transferred size on every request.
      const streamEntry = activeStreams.get(sessionKey);
      if (streamEntry) {
        streamEntry.bytesTransferred += stat.size;
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
      fileStream.pipe(res);
    });
  });

  return router;
}

module.exports = createYtStreamRoutes;
                      