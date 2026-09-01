/**
 * server/routes/ytstream.js
 *
 * The YouTube playback endpoint used by `.strm` sidecar files (see
 * strmGenerator.js). Supersedes the older `server/routes/strm.js` proxy,
 * which has been removed.
 *
 * Design is modeled on the two playback modes exposed by the
 * jellyfin-youtube-plugin (https://github.com):
 *
 *   - "Simple"   -> hand the player a direct upstream URL (no ffmpeg needed)
 *   - "Enhanced" -> re-stream through a local ffmpeg process for more
 *                   consistent quality/compatibility, automatically
 *                   falling back to Simple if ffmpeg is missing or fails
 *
 * Format selectors mirror YtDlpService.cs from that plugin.
 * Hardware encoding modes (None / Qsv / Nvenc / Vaapi / Amf) mirror
 * ManagedTranscodeService.AddVideoEncoderArguments.
 *
 * Unlike the Jellyfin plugin, this route reuses Youtarr's existing
 * cookie support (configModule.getCookiesPath()) and yt-dlp command
 * conventions (proxy / IP family / rate limiting via
 * YtdlpCommandBuilder.buildCommonArgs), so age-restricted and
 * members-only content that the plugin can't play will work here too.
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
 * Parse a Netscape-format cookie file into a Cookie request header value
 * for YouTube / googlevideo requests. yt-dlp -g URLs often 403 in ffmpeg
 * unless the same session cookies are sent.
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

const VALID_MODES = ['direct', 'direct-pipe', 'direct-redirect', 'ffmpeg', 'hls', 'hls-tap', 'hls-buffer'];
// mkv is ffmpeg-mode only (see the ffmpeg output-format switch below) -
// hls mode's segments must be fmp4/mpegts, so getHlsContainerInfo simply
// never special-cases it (falls through to its fmp4 default, same as any
// other unrecognized value).
const VALID_CONTAINERS = ['mp4', 'ts', 'mkv'];
const VALID_TRANSCODE = ['copy', 'h264'];

/** Matches ManagedTranscodeHardwareModes in the reference plugin. */
const { normalizeHardwareMode, normalizeTuning, buildVideoEncoderArgs } = streamEncoderTuning;

/**
 * Default yt-dlp player-client selection for extraction.
 *
 * The bare "tv" client (part of yt-dlp's built-in default fallback chain)
 * frequently returns YouTube's generic
 * "The page needs to be reloaded." error once a session/PO-token check
 * fails, even though other clients would work fine for the same video.
 * Excluding it here (the `-tv` syntax removes one client from yt-dlp's
 * default list rather than replacing the whole list) avoids that failure
 * mode without giving up yt-dlp's normal multi-client fallback behavior.
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

/**
 * Active child processes for Enhanced mode — the two `yt-dlp` feeders
 * (video-only, audio-only) and the `ffmpeg` consumer that muxes them via
 * pipe:3/pipe:4 are all tracked here so they get killed together on
 * client disconnect and process exit.
 */
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

/** hlsSessions is declared further below (with the other HLS constants). */
function destroyHlsSession(session, reason) {
  hlsSessions.delete(session.key);
  // Checked by createHlsSessionInternal's process-exit handlers so a
  // deliberate teardown never gets logged/treated as an unexpected crash.
  session.destroying = true;
  killChildProcess(session.ytVideo, `hls-ytdlp-video:${reason}`);
  killChildProcess(session.ytAudio, `hls-ytdlp-audio:${reason}`);
  killChildProcess(session.ff, `hls-ffmpeg:${reason}`);
  killChildProcess(session.infoJsonProc, `hls-ytdlp-infojson:${reason}`);
  // Deliberately delayed past killChildProcess's SIGTERM->SIGKILL grace
  // window (3s): removing the directory concurrently with still-running
  // processes makes ffmpeg fail mid-write with confusing I/O errors
  // ("failed to rename ... No such file or directory") that look like a
  // real crash but are just us deleting the ground out from under it.
  setTimeout(() => {
    fs.rm(session.dir, { recursive: true, force: true }, (err) => {
      if (err) logger.warn({ err, dir: session.dir }, 'ytstream: failed to remove HLS session temp dir');
    });
  }, 3500);
  // This is the single choke-point for every HLS teardown path (idle
  // reap, 403/extraction-error retry, ready-failed, manual stop from the
  // Streaming page), so untracking here covers all of them uniformly —
  // see the Streaming-page stream-tracking block below for what this does.
  // session.error (set by spawnHlsEncodePass's markFailed) is the only
  // place the real failure text lives for the 'ready-failed' case.
  untrackStream(session.key, reason, session.error || null);
}

/**
 * Streaming-page stream tracking — surfaces currently-active mode=ffmpeg /
 * mode=hls playback (byte counters, client info, start/stop) via
 * GET /api/ytstream/streams and POST /api/ytstream/streams/:id/stop, with
 * live updates broadcast over the same WebSocket mechanism already used
 * for download-job progress (see server/modules/messageEmitter.js).
 * mode=direct is intentionally not tracked here — it's a stateless proxy
 * with no session concept to hook into.
 *
 * Identity: an HLS "stream" is one shared encode session, so its
 * streamId is just its existing hlsSessions key — no second ID to keep in
 * sync. An ffmpeg "stream" is one HTTP request; streamViaFfmpeg's
 * attempt()/runPipeline can retry (403/extraction-error, hw->software
 * fallback) before any byte reaches the client, so the streamId is
 * created once per request (in the router handler) and threaded through
 * every retry's runPipeline call rather than created per-attempt.
 */
const activeStreams = new Map(); // streamId -> entry
let statsTickTimer = null;
const STREAM_STATS_TICK_MS = 1500;
// HLS segments land as one instant whole-file burst per player request, not
// a steady trickle - a naive "since the last 1.5s tick" rate reads 0 on
// every tick between bursts, then spikes on the tick that catches one,
// which looks like the stream is stalled/dead most of the time even when
// it's healthy. Averaging bytes over this longer rolling window instead
// smooths those bursts into a representative sustained rate.
const STREAM_THROUGHPUT_WINDOW_MS = 10000;
// Internal HLS session churn, not a real stream ending from the
// Streaming page's point of view — suppresses the streamStopped broadcast.
const SILENT_UNTRACK_REASONS = new Set(['retry', 'stale-failed']);

// Set once by createYtStreamRoutes (called exactly once, at server startup —
// see server/routes/index.js) so trackStream/untrackStream below (module-level,
// defined before the factory that actually receives `models`) can persist to
// StreamHistory without threading `models` through every call site and
// through destroyHlsSession. Stays null (persistence silently skipped) for
// any test harness that exercises these functions without going through the
// real factory.
let ytstreamModels = null;

/**
 * docs: Stream History — persisted audit trail for ytstream playback
 * sessions, backed by the `stream_history` table (server/models/streamhistory.js).
 * Best-effort: every failure here is caught and logged, never allowed to
 * affect the actual stream. Keyed by `stream_id` (upsert on start) so a
 * silent HLS retry that re-tracks the same streamId refreshes the existing
 * row instead of erroring on the unique constraint — see SILENT_UNTRACK_REASONS.
 */
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

function snapshotStream(entry) {
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
    // shrinks to nothing right after a burst (the oldest kept sample would
    // be the one from *this* burst), which is exactly the spike-then-zero
    // pattern this window is meant to smooth out.
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
  if (!entry) return;
  activeStreams.delete(streamId);
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

let ffmpegAvailableCache = null;

function isFfmpegAvailable() {
  if (ffmpegAvailableCache !== null) return ffmpegAvailableCache;
  try {
    const result = spawnSync('ffmpeg', ['-version'], { timeout: 5000 });
    ffmpegAvailableCache = !result.error && result.status === 0;
  } catch {
    ffmpegAvailableCache = false;
  }
  if (!ffmpegAvailableCache) {
    logger.warn(
      'ffmpeg was not found on PATH. YouTube ffmpeg-enhanced streaming ' +
        '(mode=ffmpeg) will automatically fall back to direct mode. ' +
        'See docs/YTSTREAM.md for install instructions.'
    );
  }
  return ffmpegAvailableCache;
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

/**
 * In-memory cache of video durations for calculatedLength's Content-Length
 * estimate. Durations don't change, so entries never expire within a
 * process lifetime — footprint is one number per video id, negligible.
 */
const durationCache = new Map();

/**
 * In-memory cache of resolved video codecs, for transcode=copy's
 * auto-upgrade-to-h264 check (see resolveVideoCodec below). Keyed by
 * youtubeId|quality|playerClient since the DASH format yt-dlp selects — and
 * so its codec — depends on both. A video's available formats don't change
 * within a process lifetime, so entries never expire.
 */
const codecCache = new Map();

/**
 * In-memory cache of each video's true best-available height (the height
 * of whatever `-f bv*` - no height ceiling - would actually select), for
 * auto-capping the requested/configured quality (see resolveEffectiveQualityHeight
 * below) so a video whose real max is e.g. 1080p never requests a height
 * above that. A video's available formats don't change within a process
 * lifetime, so entries never expire.
 */
const maxAvailableHeightCache = new Map();

/**
 * `mode=hls`: real segmented HLS output (playlist.m3u8 + segment files)
 * on disk, instead of `mode=ffmpeg`'s single live-piped connection.
 *
 * This exists because a live pipe makes the *player* wait on our full
 * pipeline startup latency (two concurrent yt-dlp extractions + ffmpeg
 * spin-up) on the same connection it's trying to read from — some
 * players/transcoders (Jellyfin's own server-side ffmpeg being the
 * motivating case) won't tolerate that wait and just retry forever,
 * producing an endless black-screen loop. Real segmented HLS sidesteps
 * this entirely: the wait happens on *our* side before we ever respond
 * (see waitForHlsSessionReady/getOrCreateHlsSession — modeled directly
 * on the readiness-gated approach in the reference jellyfin-youtube-plugin's
 * ManagedTranscodeService.cs), and every segment served afterward is an
 * ordinary complete static file — no unknown-length/non-seekable
 * concerns at all, and no need for calculatedLength's estimation tricks.
 *
 * Tradeoff: this writes real files to disk for the run of a session
 * (idle-reaped after HLS_IDLE_TIMEOUT_MS — see ensureHlsIdleReaper),
 * unlike mode=ffmpeg/calculatedLength which are pure in-memory pipes.
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
// independent buffer fetch (server/modules/ytstreamBufferFetch.js) must have
// already written before an encode pass is allowed to read that region as a
// plain local file (see waitForBufferedThrough) - a cushion against the
// encode pass catching up to the fetch's still-growing write frontier mid-
// segment, same purpose as HLS_POST_RESTART_LOOKAHEAD_SEGMENTS serves for
// the network-pipe path.
const BUFFER_SAFETY_MARGIN_SECONDS = 15;
// Bounded wait for the buffer to reach BUFFER_SAFETY_MARGIN_SECONDS past a
// target timestamp before giving up and falling back to today's proven
// network-sourced path (sectioned pipe / direct-URL seek) for that one pass
// - the fetch keeps running in the background regardless, so a timeout here
// only affects this one pass's source, not whether the video still finishes
// downloading.
const BUFFER_CATCHUP_TIMEOUT_MS = 45000;
// How much buffered-video progress (in video seconds, not wall-clock) must
// pass between debug-level "still fetching" log lines - see startHlsBufferFetch's
// ff.stdout progress handler. 60 video-seconds of progress happens almost
// instantly on a healthy connection (one or two log lines for a typical
// video) but keeps ticking visibly, at a bounded rate, if the fetch is slow.
const BUFFER_PROGRESS_LOG_INTERVAL_SECONDS = 60;

// Deliberately NOT under tempPathManager's temp base: that directory gets
// wiped wholesale by cleanTempDirectory() on server startup and before
// every download job — which would delete segments out from under an
// actively-playing HLS session. A dedicated OS-temp subdirectory keeps
// this fully isolated from the download pipeline's temp lifecycle.
const HLS_BASE_TEMP_DIR = path.join(os.tmpdir(), 'youtarr-ytstream-hls');

/** Active HLS sessions, keyed by buildHlsSessionKey(...). */
const hlsSessions = new Map();

/**
 * Single-flight guard for getOrCreateHlsSession: two requests for the same
 * not-yet-existing sessionKey landing before the first one's
 * createHlsSessionInternal call finishes would otherwise both see no
 * existing entry in hlsSessions and both spawn their own yt-dlp/ffmpeg
 * pipeline for the same key - a real race, not theoretical (a player's own
 * two initial requests, e.g. an app-level manifest fetch and its player
 * engine's own fetch, routinely land within single-digit milliseconds of
 * each other). The second creation would silently overwrite the first in
 * hlsSessions, leaking the first's processes/temp dir while leaving
 * whichever survives to race the client's own retries for segments it
 * hasn't produced yet. Keyed the same as hlsSessions itself.
 */
const hlsSessionCreationPromises = new Map();

/**
 * HLS segment container mapping for the existing `container` param.
 * `ts` (MPEG-TS) is the traditional, most universally compatible HLS
 * segment format; `mp4` maps to fragmented MP4 (.m4s + an init segment),
 * matching what Jellyfin's own HLS output uses.
 */
function getHlsContainerInfo(container) {
  if (container === 'ts') {
    return { segmentType: 'mpegts', segmentExt: 'ts' };
  }
  return { segmentType: 'fmp4', segmentExt: 'm4s' };
}

/** Identifies an HLS session across requests for the same effective params. */
function buildHlsSessionKey({ youtubeId, quality, qualityStrictness, transcode, hardwareMode, tuning, container, playerClient, calculatedLength, tap, buffer }) {
  const raw = JSON.stringify({
    youtubeId, quality, transcode, hardwareMode, tuning, container,
    qualityStrictness: qualityStrictness || 'fallback',
    playerClient: playerClient || '',
    calculatedLength: !!calculatedLength,
    tap: !!tap,
    buffer: !!buffer,
  });
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 20);
}

/**
 * Pre-builds the ENTIRE VOD playlist for a calculatedLength HLS session upfront —
 * every #EXTINF/segment-name pair computed from the video's real duration,
 * with #EXT-X-PLAYLIST-TYPE:VOD and #EXT-X-ENDLIST present from the very
 * first response — so players see a full, seekable timeline immediately,
 * well before most of those segments actually exist on disk. A request for
 * a segment that isn't there yet is treated as a seek and produces it on
 * demand (see restartHlsEncodePassAtSegment) rather than the encode ever
 * being asked to produce the whole video upfront.
 *
 * `placeholder` (ytstream.instantStart — see ensurePlaceholderSegment)
 * prepends one already-on-disk "loading" segment ahead of the real ones,
 * separated by #EXT-X-DISCONTINUITY (and its own #EXT-X-MAP for fmp4,
 * since it has different encoder init data than the real segments) — it
 * never reuses a real segment index, so nothing below needs to know it
 * exists.
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
 * `ytstream.instantStart` (opt-in, calculatedLength HLS sessions only — see
 * buildFullHlsPlaylist's `placeholder` param and createHlsSessionInternal).
 *
 * getOrCreateHlsSession normally blocks the *entire first response* on
 * waitForHlsSessionReady until the real yt-dlp+ffmpeg pipeline produces its
 * first segment — a real cold start commonly takes 10-25s (up to
 * HLS_READY_TIMEOUT_MS=45s). This drops a tiny pre-generated "loading"
 * segment into a new session's directory under a dedicated filename that
 * never collides with the real encode's own `segment00000.*` numbering, so
 * waitForHlsSessionReady's very first disk poll finds *something* and
 * returns immediately — playback starts within milliseconds instead of
 * waiting on the real cold start, and by the time the placeholder's own
 * ~3s has played out the real encode usually has a genuine head start on
 * its own segment 0.
 *
 * Deliberately narrow scope: only `transcode=h264` sessions, where the
 * output codec is a fixed, video-independent choice
 * (buildVideoEncoderArgs(hardwareMode) never varies by source video) — a
 * `transcode=copy` session passes through whatever codec each video's own
 * source happens to have, so no single cached placeholder could match
 * every video.
 */
// Persistent (not os.tmpdir(), which most Docker setups wipe on container
// restart) - generation is a one-time cost per {signature, resolution}, and
// a persistent, predictably-named path also means a user can drop in their
// own clip (a branded loading bumper, etc.) at the exact path a signature
// resolves to and it's used as-is forever after - ensurePlaceholderSegment/
// ensureProbeClip only ever generate when nothing already exists there.
const YTSTREAM_CLIPS_DIR = path.join(path.dirname(configModule.configPath), 'ytstream-clips');
const HLS_PLACEHOLDER_CACHE_DIR = path.join(YTSTREAM_CLIPS_DIR, 'hls-instant-start');
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
 * Caps {width, height} at `heightCap` (decrease-only, even width - same
 * semantics as buildVideoEncoderArgs's own scale filter), so a placeholder/
 * probe clip generated from the source video's native resolution actually
 * matches what the real encode will produce when the requested quality is
 * lower than the source. Without this, e.g. a native-4K video requested at
 * quality=1080 got an instant-start placeholder still rendered at 4K -
 * visibly mismatched (different apparent resolution/bitrate) the moment
 * playback handed off from the placeholder to the real first segment.
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

/**
 * Generates (or reuses an already-cached) tiny "loading" HLS segment
 * matching a `transcode=h264` session's actual encoder settings (same
 * buildVideoEncoderArgs(hardwareMode) the real pass uses), so it splices
 * cleanly into the real encode's output. A moving lavfi test pattern +
 * silence — not a "Loading..." text card — deliberately avoids depending
 * on fontconfig/freetype being compiled into this ffmpeg build.
 *
 * Never throws — any failure (ffmpeg missing a filter/encoder, hardware
 * device unavailable, timeout, ...) logs a warning and returns null, and
 * callers fall back to today's normal wait-for-the-real-segment behavior.
 * @param {number} width - target resolution (see resolveVideoTargetResolution)
 * @param {number} height
 * @returns {Promise<{segmentPath: string, initPath: string|null}|null>}
 */
async function ensurePlaceholderSegment({ segmentType, segmentExt, hardwareMode, tuning, width, height }) {
  const signature = getPlaceholderSignature({ segmentType, hardwareMode, tuning, width, height });
  const dir = path.join(HLS_PLACEHOLDER_CACHE_DIR, signature);
  const segmentPath = path.join(dir, `placeholder.${segmentExt}`);
  const initPath = segmentType === 'fmp4' ? path.join(dir, 'placeholder-init.mp4') : null;

  const isReady = () => fs.existsSync(segmentPath) && (!initPath || fs.existsSync(initPath));
  if (isReady()) return { segmentPath, initPath };

  if (placeholderGenerationPromises.has(signature)) {
    await placeholderGenerationPromises.get(signature).catch(() => {});
    return isReady() ? { segmentPath, initPath } : null;
  }

  const generate = (async () => {
    fs.mkdirSync(dir, { recursive: true });
    const encoder = buildVideoEncoderArgs(hardwareMode, height, tuning);
    const args = ['-y', '-loglevel', 'error'];
    if (encoder.preInputArgs && encoder.preInputArgs.length) {
      args.push(...encoder.preInputArgs);
    }
    args.push(
      '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${HLS_PLACEHOLDER_FPS}:duration=${HLS_PLACEHOLDER_DURATION_SECONDS}`,
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-t', String(HLS_PLACEHOLDER_DURATION_SECONDS),
    );
    if (encoder.videoFilters && encoder.videoFilters.length) {
      args.push('-vf', encoder.videoFilters.join(','));
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

    logger.info({ signature, args }, 'ytstream: generating HLS instant-start placeholder segment');
    await runFfmpegOnce(args);

    fs.renameSync(path.join(dir, `placeholder-raw0.${segmentExt}`), segmentPath);
    if (segmentType === 'fmp4') {
      fs.renameSync(path.join(dir, 'placeholder-init.mp4'), initPath);
    }
    try { fs.rmSync(scratchPlaylist, { force: true }); } catch { /* best-effort cleanup */ }
  })();

  placeholderGenerationPromises.set(signature, generate);
  try {
    await generate;
    return isReady() ? { segmentPath, initPath } : null;
  } catch (err) {
    logger.warn({ err, signature }, 'ytstream: failed to generate HLS instant-start placeholder; falling back to normal session startup');
    return null;
  } finally {
    placeholderGenerationPromises.delete(signature);
  }
}

/**
 * Rewrites every segment/init-segment reference in an ffmpeg-written HLS
 * playlist to an absolute URL under `baseUrl`, rather than relying on
 * ffmpeg's own `-hls_base_url` — which doesn't consistently apply to the
 * `#EXT-X-MAP` (fmp4 init segment) line, only to plain segment lines,
 * leaving the init segment referenced by a bare relative filename that
 * resolves against the *playlist's* URL instead of ours.
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
 * `ytstream.probeShortcut` (opt-in). See strmGenerator.js's doc comment on
 * the pipe-syntax User-Agent it writes into every .strm when this is on,
 * and ytstreamProbeShortcut.js for the shared marker value.
 *
 * jellyfin/jellyfin#10175 means a real metadata probe (Jellyfin's own
 * ffprobe, or any other tool's) arrives with libavformat's bare default
 * User-Agent ("Lavf/x.y.z") regardless of what a .strm's pipe-syntax
 * asked for, while real playback/transcode (ffmpeg honors the override,
 * and a browser/app direct-playing the URL sends its own UA) never looks
 * like that. isLikelyMetadataProbeRequest below is the detector; when it
 * fires (and probeShortcut is on), the route hands back a tiny cached
 * standalone clip and returns immediately — *before* the cache-on-play
 * trigger, the transcode=copy codec probe, or (this is the actual point)
 * ever creating a real HLS/ffmpeg session against YouTube. Scoped to
 * `transcode=h264` sessions only, same reasoning as the HLS instant-start
 * placeholder above: that's the one case where the output codec is a
 * fixed, video-independent choice (buildVideoEncoderArgs(hardwareMode)),
 * so a single cached clip can stand in for every video. transcode=copy
 * passes through whatever codec each video's own source has, so no single
 * clip could represent them all — a copy-mode probe just falls through to
 * normal handling (today's behavior, unchanged).
 *
 * Genuinely opt-in and best-effort throughout: if ffmpeg generation fails
 * for any reason, this silently falls back to normal request handling
 * rather than ever 500ing a real probe or (worse) real playback.
 */
function isLikelyMetadataProbeRequest(req) {
  return /^Lavf\//i.test(String(req.headers['user-agent'] || ''));
}

/**
 * Single source of truth for whether the ytstream.probeShortcut early-exit
 * (see tryServeProbeClip's doc comment) would fire for a given request -
 * used both by the real early-exit block in the main route (which does the
 * actual work: resolveVideoTargetResolution/capResolutionToHeight/
 * tryServeProbeClip once this says wouldFire) and by resolvePlaybackPlan's
 * debug trace, so the two can never drift apart the way they used to
 * (each independently re-implementing the same condition).
 */
function evaluateProbeShortcut(req, config) {
  const probeCfg = config.ytstream || {};
  const probeQueryOverride = (name) => (probeCfg.forceServerSettings === true ? undefined : req.query[name]);
  const isMetadataProbe = isLikelyMetadataProbeRequest(req);
  const transcode = VALID_TRANSCODE.includes(probeQueryOverride('transcode'))
    ? probeQueryOverride('transcode')
    : (probeCfg.transcode || 'copy');

  if (probeCfg.probeShortcut !== true) {
    return { wouldFire: false, reason: 'probeShortcut is off', isMetadataProbe, transcode };
  }
  if (!isMetadataProbe) {
    return {
      wouldFire: false,
      reason: 'probeShortcut is on, but this request does not look like a metadata-probe request (see isLikelyMetadataProbeRequest)',
      isMetadataProbe,
      transcode,
    };
  }
  if (transcode !== 'h264') {
    return {
      wouldFire: false,
      reason: `probeShortcut is on and this looks like a metadata-probe request, but transcode="${transcode}" (not h264) so it does not apply`,
      isMetadataProbe,
      transcode,
    };
  }
  return {
    wouldFire: true,
    reason: 'probeShortcut is on, this looks like a metadata-probe request, and transcode=h264 - the real request short-circuits here (tryServeProbeClip) and never reaches the mode/quality logic below',
    isMetadataProbe,
    transcode,
  };
}

// Persistent, same reasoning as HLS_PLACEHOLDER_CACHE_DIR above.
const PROBE_CLIP_CACHE_DIR = path.join(YTSTREAM_CLIPS_DIR, 'probe-shortcut');
const PROBE_CLIP_DURATION_SECONDS = 2;
const probeClipGenerationPromises = new Map();

/**
 * Generates (or reuses an already-cached) tiny standalone Matroska clip
 * matching a `transcode=h264` session's actual encoder settings. Matroska
 * rather than MP4/WebM: its muxer accepts essentially any video/audio
 * codec pair ffmpeg can produce without the container-specific box
 * signaling or moov-placement (`+faststart`) concerns MP4 has, so one
 * code path here works unchanged across every hardwareMode's actual
 * output codec — never throws; returns null on any failure.
 * @param {number} width - target resolution (see resolveVideoTargetResolution)
 * @param {number} height
 * @returns {Promise<{filePath: string}|null>}
 */
async function ensureProbeClip({ hardwareMode, tuning, width, height }) {
  const signature = `${normalizeHardwareMode(hardwareMode)}-${normalizeTuning(tuning)}-${width}x${height}`;
  const dir = path.join(PROBE_CLIP_CACHE_DIR, signature);
  const filePath = path.join(dir, 'probe.mkv');
  if (fs.existsSync(filePath)) return { filePath };

  if (probeClipGenerationPromises.has(signature)) {
    await probeClipGenerationPromises.get(signature).catch(() => {});
    return fs.existsSync(filePath) ? { filePath } : null;
  }

  const generate = (async () => {
    fs.mkdirSync(dir, { recursive: true });
    const encoder = buildVideoEncoderArgs(hardwareMode, height, tuning);
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
    return fs.existsSync(filePath) ? { filePath } : null;
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
 */
async function tryServeProbeClip(req, res, { hardwareMode, tuning, width, height }) {
  try {
    const clip = await ensureProbeClip({ hardwareMode, tuning, width, height });
    if (!clip) return false;
    const stat = await fs.promises.stat(clip.filePath);
    logger.info(
      { ua: req.headers['user-agent'], size: stat.size, url: req.originalUrl },
      'ytstream: serving cached probe-shortcut clip to a detected metadata-probe request'
    );
    res.set({
      'Content-Type': 'video/x-matroska',
      'Content-Length': String(stat.size),
      'Cache-Control': 'no-store',
      'Accept-Ranges': 'bytes',
    });
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(clip.filePath);
      stream.on('error', reject);
      stream.on('close', resolve);
      stream.pipe(res);
    });
    return true;
  } catch (err) {
    logger.warn({ err }, 'ytstream: failed to serve probe-shortcut clip; falling back to normal request handling');
    return false;
  }
}

/**
 * ytstream.serveCachedFile: once a video is fully downloaded (STRM
 * cache-on-play, or any genuine download), this serves the real local file
 * directly - no yt-dlp, no ffmpeg, just an ordinary static-file HTTP serve.
 * Unlike the HLS-asset route and tryServeProbeClip above (both of which
 * advertise `Accept-Ranges: bytes` but always send the whole file regardless
 * of any Range header - fine for small segments/probe clips, never checked
 * for real seeking), this is a genuine RFC 7233 partial-content
 * implementation, since a full video needs real seek performance in the
 * player, not just a header claiming range support with nothing behind it.
 * @returns {Promise<boolean>} true if a response was sent (caller must
 *   return immediately without falling through to normal handling).
 */
async function tryServeCachedVideoFile(req, res, filePath) {
  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (err) {
    logger.warn({ err, filePath }, 'ytstream: serveCachedFile stat failed; falling back to normal handling');
    return false;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = ext === '.mkv' ? 'video/x-matroska' : ext === '.webm' ? 'video/webm' : 'video/mp4';
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
   * Duration lookup for `ytstream.calculatedLength`'s synthetic Content-Length
   * (see estimateBitrateBytesPerSecond / durationCache above). Checks the
   * library's own DB record first — calculatedLength is almost always used to
   * stream a video Youtarr already knows about, so this skips a yt-dlp
   * network round trip entirely in the common case. Falls back to a
   * dedicated `--print duration` yt-dlp call (the two-pipe DASH pipeline in
   * streamViaFfmpeg has no upfront metadata fetch of its own to reuse) when
   * the video isn't in the DB yet or has no recorded duration.
   */
  async function getVideoDurationSeconds(youtubeId, config) {
    if (durationCache.has(youtubeId)) return durationCache.get(youtubeId);

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
    return seconds;
  }

  /**
   * Resolves the video codec of the DASH format `getDashFormatSelectors`
   * would actually select at this quality — used to auto-upgrade
   * `transcode=copy` to `transcode=h264` when that format isn't H.264 (see
   * the router handler below). The selector prefers `avc1` (H.264) but
   * falls back to whatever's available at that height, which for videos
   * with no H.264 track that high is commonly VP9/AV1 — a `copy` remux of
   * that into an MP4/HLS container isn't broadly compatible with players
   * expecting H.264, and (Jellyfin specifically) can trigger a
   * server-side-transcode fallback on the player's own end that then fails
   * trying to read our stream as its input.
   *
   * Uses `--print vcodec` against the same `-f` selector rather than a
   * `-F`/full-format-list parse, so the probed codec is exactly the one
   * that will actually be used, not just "some avc1 format exists".
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
   * The height of whatever `-f bv*` (best video-only, no height ceiling)
   * would actually select for this video - i.e. its true best-available
   * resolution. Best-effort: on any failure (network hiccup, extraction
   * error, timeout), returns null ("unknown, don't cap") rather than ever
   * blocking playback over this check.
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
   * resolveQualityHeight(quality), further capped to this specific video's
   * real best-available height (see resolveMaxAvailableHeight) - so
   * requesting/configuring e.g. 2160 for a video that only actually has up
   * to 1080p available streams at 1080p instead of handing that height
   * ceiling to yt-dlp's own selector, which would otherwise silently fall
   * back to whatever's available anyway but leaves every downstream
   * decision (encoder scale/bitrate caps, the placeholder/probe clip
   * resolution) still sized for the requested-but-nonexistent height.
   * "best" (null from resolveQualityHeight) is left uncapped - the point of
   * "best" is "whatever's actually available", so there's nothing to cap.
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
   * Seek-restart fix (docs/YTSTREAM_SEEK_FIX.md): resolves the video-only
   * and audio-only DASH URLs (the same `getDashFormatSelectors` selectors
   * `spawnHlsEncodePass`/`runPipeline`'s yt-dlp-pipe inputs already use) via
   * a single `-g` call, for feeding directly to ffmpeg as real HTTP inputs
   * with input-side `-ss` — a true Range-based seek, unlike the pipe
   * architecture's broken output-side `-ss`. Deliberately NOT built on
   * `resolveDirectUrl`: that resolves `getDirectFormatSelector`'s
   * progressive/muxed selector, which YouTube usually only serves up to
   * 720p (see its own comment) and which `-g` can only print as a single
   * URL in the first place — reusing it here would silently cap every
   * 1080p+/4K seek-restart at ≤720p.
   *
   * Requests both formats in one yt-dlp call (`-f "video,audio"`) rather
   * than two separate calls, to avoid paying webpage/player-API extraction
   * twice. Classifies the two returned URLs by their own `mime=video`/
   * `mime=audio` query param instead of trusting yt-dlp's output order.
   * Throws (never returns a partial result) if that classification doesn't
   * yield exactly one of each — callers are expected to catch this and
   * fall back to the yt-dlp-pipe path, never to block a seek indefinitely
   * on it.
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
   * header set for the same kind of request. See docs/YTSTREAM_SEEK_FIX.md
   * for this approach's vprv=1 URL caveats.
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
   * Redacts sensitive header values (see SENSITIVE_INCOMING_HEADER_NAMES)
   * before the 'ytstream: incoming request' log call below dumps every
   * header a caller (Jellyfin, a browser, curl, ...) sent on a request to
   * this route, alongside isLikelyMetadataProbeRequest's verdict for it -
   * lets a real playback request and other Jellyfin traffic against the
   * same URL (a library scan/ffprobe, "Refresh metadata", a thumbnail
   * preview) be told apart from the log alone, without packet capture.
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
   * than handing the client a bare 302 redirect.
   *
   * A raw redirect means the *player* (browser/Jellyfin/VLC) makes the
   * final request to googlevideo.com directly, with none of the cookies,
   * Referer, or User-Agent yt-dlp used to resolve the URL in the first
   * place — for anything that actually needed those (age-restricted,
   * members-only, or just a fussier client) that request gets rejected.
   * Proxying keeps this server in the loop for the whole response instead
   * of handing the client a bare redirect. It also forwards Range so
   * `mode=direct` stays properly seekable.
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
   * process instead of resolving a URL (-g) and proxying it separately the
   * way plain mode=direct does. This sidesteps googlevideo's vprv=1
   * session-bound URLs, which 403 when fetched by a process other than the
   * one that resolved them - yt-dlp fetching within the same process it
   * resolved the format in isn't subject to that, the same reason the DASH
   * pipe modes (streamViaFfmpeg/spawnHlsEncodePass) never hit it either.
   *
   * A separate, explicitly-selected mode rather than an automatic fallback
   * inside mode=direct - each mode does exactly what it says and nothing
   * else. Plain direct's proxy fetch just fails on a 403; pick this mode
   * directly for the more resilient (but Range-incapable, see below)
   * behavior instead.
   *
   * Deliberately not a retry with a different player_client: android's own
   * format list doesn't include the legacy progressive itag (18/360p)
   * that's effectively the only muxed format any video has left, so
   * re-resolving with android can never satisfy a progressive-format
   * request.
   *
   * Stays "direct" in spirit - one yt-dlp child process, zero ffmpeg, zero
   * re-encode, just a different way of getting the same bytes onto the
   * wire. Trade-off: this is a live sequential pipe, not a seekable
   * byte-range fetch, so it can't honor a real mid-video seek (a non-zero
   * Range start) - a player has to restart from 0 for that, same as when
   * calculatedLength (below) is off entirely.
   *
   * calculatedLength support: a genuine `206` needs a real
   * `Content-Range` with a concrete end byte, which this pipe doesn't
   * have (unbounded, unknown total). What it *can* honestly claim is the
   * opening request - no Range header, or one starting at byte 0 - since
   * that's the exact same full-body response this function always sends
   * anyway; the only thing missing was telling the client its size
   * upfront. When ytstream.calculatedLength is on, that case gets a real
   * `Content-Length` (plus `206`/`Content-Range` if a Range header asked
   * for it) built from the same duration x bitrate estimate mode=ffmpeg's
   * own calculatedLength already uses. A non-zero Range start (a real
   * seek) isn't representable this way and falls through to the same
   * unbounded response as when calculatedLength is off.
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
   * mode=direct-redirect: resolves a playback URL via yt-dlp, same as plain
   * mode=direct, but sends the player a 302 straight to it instead of
   * Youtarr's own server fetching and proxying the bytes. Youtarr never
   * touches the video bytes at all in this mode - real bandwidth/CPU
   * savings over every other mode - at a real reliability cost:
   *
   * - No cookies/Referer/User-Agent travel with the redirect (the player
   *   makes its own bare request) - age-restricted or members-only videos,
   *   which need those, will fail outright for a player that can't supply
   *   them, where mode=direct's proxied fetch sends them along and works.
   * - A vprv=1 session-bound URL (see pipeDirectStreamViaYtDlp's doc
   *   comment) is, if anything, *more* likely to 403 here than under
   *   mode=direct: the fetch now comes from the player's own client/network
   *   entirely, a bigger mismatch from "the session that resolved it" than
   *   Youtarr's own server-side proxy fetch already is.
   * - Whatever happens after the redirect is invisible to Youtarr - the
   *   player fetches googlevideo directly, so a failure there never reaches
   *   this server's logs at all. Troubleshooting a failed play in this mode
   *   has nothing to go on beyond "the player couldn't play it."
   *
   * No fallback on any of the above - same as every other mode, this either
   * works as described or the player's own request fails on its own.
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
   * Spawns one HLS session's yt-dlp(video) + yt-dlp(audio) + ffmpeg
   * pipeline, writing segments to `dir` instead of piping live. Returns
   * immediately with state 'starting' — callers must go through
   * waitForHlsSessionReady before serving the playlist.
   *
   * The video/audio fetch mechanics (two-pipe DASH via pipe:3/pipe:4) are
   * identical to streamViaFfmpeg's live-pipe pipeline; only the ffmpeg
   * *output* stage differs (`-f hls` segments on disk instead of a single
   * `pipe:1` stream). See the HLS block comment above hlsSessions for why.
   */
  /**
   * Spawns one encode pass (yt-dlp video + yt-dlp audio + ffmpeg) writing
   * segments from `startSegmentIndex` onward into `session.dir`. Used both
   * for a session's initial pass and — for calculatedLength sessions — to
   * restart the forward encode at a new segment boundary when a client
   * requests a segment that isn't on disk yet (see
   * restartHlsEncodePassAtSegment).
   *
   * `session.passGeneration` supersedes stale close/error handlers from a
   * pass that's since been killed and replaced: each call bumps it and
   * captures its own value, so a late 'close' event from an outdated pass
   * is recognized as intentional rather than logged/treated as a crash —
   * the same role `session.destroying` plays for a full teardown.
   *
   * @param {object} [source] - omitted for the normal network path
   *   (default: two yt-dlp pipes, unchanged behavior). `{ type: 'local',
   *   filePath }` switches to a single local-file input with no yt-dlp
   *   children at all — used by maybeHotSwapToCache once STRM cache-on-play
   *   has finished downloading this video, so the rest of the session reads
   *   from disk instead of pulling from YouTube. Also used by mode=hls-buffer
   *   (see startHlsBufferFetch/waitForBufferedThrough) to read from its
   *   independent buffer-fetch file — either mid-fetch (session.bufferTempPath)
   *   once enough has been safely written, or the finalized file
   *   (session.cachedFilePath) once the fetch has completed and flipped
   *   session.usingCachedSource, same as a hot-swap.
   * @param {object} [directUrls] - seek-restart fix (docs/YTSTREAM_SEEK_FIX.md):
   *   `{ videoUrl, audioUrl, cookieHeader }` from resolveDashUrlsForSeek.
   *   When present (and `source` isn't), ffmpeg fetches these two DASH URLs
   *   itself as real HTTP inputs with input-side `-ss` instead of piping
   *   yt-dlp's output through a non-seekable pipe — only ever passed by
   *   restartHlsEncodePassAtSegment. Omitted (the default) for every other
   *   caller/path, and internally for this call's own fallback re-attempt
   *   if the direct fetch fails.
   * @param {boolean} [forceFullPipe] - skips the yt-dlp `--download-sections`
   *   optimization (see useSectionedPipe) and always does the classic
   *   full-from-zero pipe with ffmpeg's decode-and-discard `-ss`. Only ever
   *   passed by this function's own maybeFallbackToFullPipe retry.
   */
  function spawnHlsEncodePass(session, { startSegmentIndex, seekSeconds, isInitialPass, playerClientOverride, source, directUrls, forceFullPipe }) {
    // Tracks which segment the CURRENTLY RUNNING pass is already working
    // toward - see ensureHlsSegmentAvailable's use of this: a request for
    // this exact index isn't a real seek (the running pass will produce it
    // on its own, just needs more time), so it must never trigger a
    // same-target restart. Set unconditionally, including on a genuine
    // restart, so it always reflects whatever pass is live right now.
    session.activePassStartIndex = startSegmentIndex;
    const { youtubeId, quality, qualityStrictness, transcode, hardwareMode, tuning, config, sessionKey, segmentType, segmentExt } = session;
    const hw = normalizeHardwareMode(hardwareMode);
    const tier = normalizeTuning(tuning);
    const isLocalSource = !!(source && source.type === 'local');
    const isDirectSource = !isLocalSource && !!directUrls;

    // calculatedLength restarts and cached-source hot-swaps both always seek to
    // the exact segment-boundary timestamp (never mid-segment) so ffmpeg's
    // own segment counting (relative to wherever -ss lands) stays aligned
    // with -start_number's absolute indices. A plain non-calculatedLength network
    // session never restarts — this is just the original one-time "?t="
    // cold-start seek, unchanged.
    const effectiveSeek = (session.calculatedLength || isLocalSource)
      ? (startSegmentIndex > 0 ? startSegmentIndex * HLS_SEGMENT_DURATION_SECONDS : null)
      : (seekSeconds || null);

    // mode=hls-tap: only a genuine, un-seeked play from the very start of
    // the session gets tapped - isInitialPass is only ever true on the
    // session's original network-sourced pass (no caller passes
    // source/directUrls alongside isInitialPass: true), so this can never
    // fire against a hot-swapped or local-source pass. tapAttempted is
    // claimed immediately so a same-pass fallback/retry (info-json-cache
    // fallback, sectioned-pipe fallback) doesn't treat itself as a second,
    // independent tap - it just overwrites tapTempPath from scratch, safe
    // since no bytes have reached the client yet at that point.
    const tapActive = session.tapEnabled && !session.tapAttempted && isInitialPass && startSegmentIndex === 0 && !effectiveSeek;
    if (tapActive) session.tapAttempted = true;

    // The yt-dlp-pipe path's `-ss` (below, on the non-seekable pipe:3/pipe:4
    // inputs) can't actually seek — ffmpeg has to decode-and-discard every
    // frame from 0:00 up to the target, which for a seek deep into a long
    // video can take minutes (see HLS_SEEK_RESTART_READY_TIMEOUT_MS's own
    // comment). When there's a real seek target and we're not already on
    // the direct-URL/local (genuinely seekable) paths, ask yt-dlp itself to
    // only download from roughly that point via --download-sections, so the
    // pipe never carries the discarded prefix.
    //
    // --download-sections alone isn't enough on these fragmented DASH
    // formats: yt-dlp's internal ffmpeg extraction for it defaults to a
    // non-fragmented MP4 ('ipod' muxer), which requires a seekable output -
    // piped to `-o -` it's not, so it fails 100% of the time with "muxer
    // does not support non seekable output" (confirmed live). Forcing that
    // internal extraction to Matroska instead (--downloader-args
    // "ffmpeg:-f matroska") avoids the seekable-output requirement entirely
    // - verified live for both the video (itag 137) and audio (itag 140-3)
    // halves independently. Our own ffmpeg below auto-detects the container
    // from the pipe's actual bytes (via -analyzeduration/-probesize), so it
    // doesn't care that this is Matroska instead of the usual raw MP4/DASH
    // stream - no change needed on that side.
    //
    // Still approximate (byte/keyframe-estimated, not frame-exact) and only
    // verified against this one yt-dlp version/video, hence
    // maybeFallbackToFullPipe below as a safety net if it ever errors.
    const useSectionedPipe = !isLocalSource && !isDirectSource && !!effectiveSeek && !forceFullPipe;

    // Seek-latency fix: yt-dlp's own webpage + player-API extraction (the
    // part that resolves the format list/DASH URLs from a bare watch URL)
    // is identical on every seek-restart within a session - only the
    // --download-sections target changes - yet gets redone from scratch
    // each time, and is a big chunk of the ~10-15s it takes ffmpeg to see
    // its first byte after a seek (confirmed live via the sectioned-seek
    // input-timestamps log above). warmHlsInfoJsonCache resolves it once,
    // fire-and-forget, right when the session starts, so most seeks
    // (everything after whichever one happens to race the warm-up, e.g. an
    // immediate Jellyfin resume-from-middle) can skip straight to
    // --load-info-json instead of re-extracting. Falls back to a bare
    // watch URL - the previous, always-correct behavior - whenever the
    // cache isn't ready yet; see maybeFallbackFromInfoJson below for what
    // happens if a *stale* cache (signed URLs are typically valid a few
    // hours) causes an actual failure instead.
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
      // Video can only cut on a keyframe (lossless copy) so it typically
      // starts a bit *after* effectiveSeek; audio has no such constraint and
      // lands almost exactly on it. Re-zeroing both separately throws away
      // that gap entirely, so our own ffmpeg below muxes them back together
      // as if they started at the same instant - the actual A/V desync bug.
      // -copyts keeps each pipe's real source-relative timestamp instead, so
      // the true gap survives into our own ffmpeg's -copyts (below), which
      // can then realign them correctly on mux.
      const sectionArgs = useSectionedPipe
        ? ['--download-sections', `*${effectiveSeek}-inf`, '--downloader-args', 'ffmpeg:-f matroska -copyts']
        : [];
      // --load-info-json replaces the bare watch URL entirely (yt-dlp takes
      // no URL argument in that mode) - see useInfoJson above.
      const sourceArgs = useInfoJson ? ['--load-info-json', session.infoJsonPath] : [watchUrl];
      ytVideoArgs = [...commonYtArgs, ...sectionArgs, '-f', videoFormat, ...sourceArgs];
      ytAudioArgs = [...commonYtArgs, ...sectionArgs, '-f', audioFormat, ...sourceArgs];
    }

    const encoder = transcode === 'h264' ? buildVideoEncoderArgs(hw, resolveQualityHeight(quality), tier) : null;

    const ffArgs = [
      // 'warning' (not the usual 'error') for a direct-URL seek-restart
      // attempt: this path is new and less proven than the yt-dlp-pipe one
      // (see docs/YTSTREAM_SEEK_FIX.md's vprv caveat), and a real production
      // failure already showed up as a bare exit code with empty stderr at
      // 'error' level — 'warning' costs nothing (this ffmpeg only ever runs
      // for a few seconds either way) and should surface what actually went
      // wrong next time instead of just a code.
      //
      // 'info' for useSectionedPipe (instead of the usual 'error'): needed
      // to get ffmpeg's per-input startup banner ("Input #0 ... start:
      // X.XXXXXX"), which is the only way to see, with -copyts now in play,
      // where the video and audio pipes' sections actually landed relative
      // to each other - see the stderr scan below.
      '-loglevel', isDirectSource ? 'warning' : (useSectionedPipe ? 'info' : 'error'),
      '-fflags', '+genpts',
      '-analyzeduration', '10M',
      '-probesize', '5M',
    ];
    if (useSectionedPipe) {
      // Mirrors sectionArgs' -copyts above: without this, ffmpeg would
      // independently re-zero pipe:3 and pipe:4's timestamps on the way in,
      // throwing away the real video/audio start-time gap a second time.
      // -copyts keeps both pipes' true source-relative timestamps so the
      // gap is preserved (and correctly reflected in the mux); -start_at_zero
      // then shifts the aligned pair down together so segment/hls_time math
      // still starts near 0, same as every other path.
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
      // pipe near effectiveSeek, so an additional ffmpeg -ss here would
      // either skip past more real content or land somewhere arbitrary
      // (the pipe's own timestamps start near, not at, effectiveSeek) -
      // leave ffmpeg's input un-seeked and accept whatever offset yt-dlp
      // actually landed on. The video/audio pipes' offsets from each other
      // are no longer discarded, though - see the -copyts/-start_at_zero
      // above.
      const pipeSeek = useSectionedPipe ? null : effectiveSeek;
      if (pipeSeek) ffArgs.push('-ss', String(pipeSeek));
      ffArgs.push('-thread_queue_size', '4096', '-i', 'pipe:3');
      if (pipeSeek) ffArgs.push('-ss', String(pipeSeek));
      ffArgs.push('-thread_queue_size', '4096', '-i', 'pipe:4');

      if (tapActive) {
        // mode=hls-tap: a second, fully independent OUTPUT from the SAME
        // yt-dlp video/audio pipes - untouched (-c copy, no re-encode), no
        // second network pull. Must be declared as its own complete output
        // (own -map pair, own -c) BEFORE the primary HLS output's -map/-vf/
        // -c:v/-c:a block below - ffmpeg's per-output options apply to
        // whichever output TARGET comes next, so nothing carries between
        // outputs either way, but placing this one first keeps the primary
        // output's -vf/encoder args from ever being associated with it (an
        // earlier version of this code declared the tap's target AFTER
        // those options, which attached them to the tap output instead of
        // HLS and produced a real, reproduced-live ffmpeg error: "Filtering
        // and streamcopy cannot be used together" - killing the whole
        // session, not just the tap). Finalized/discarded by the dedicated
        // close listener below.
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
      // playlist (hls_list_size 0, no ENDLIST yet) is indistinguishable
      // from a genuine live broadcast to the player — hls.js/Jellyfin
      // then start at the *live edge* and jump forward as new segments
      // appear, skipping whatever was already encoded, instead of playing
      // sequentially from the start. 'event' tells the player this is a
      // progressively-available-but-eventually-complete stream, so it
      // starts from segment 0 and follows it in order as it grows.
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
    // #EXT-X-MAP (init segment) line for fmp4 output — only to segment
    // lines — so a player fetches the init segment from a bare relative
    // "init.mp4" instead of our actual URL. Rewriting every reference to
    // an absolute URL ourselves (see rewriteHlsPlaylistUrls, applied when
    // serving the playlist below) is deterministic regardless of ffmpeg
    // version/behavior here.
    //
    // calculatedLength sessions pre-declare the entire VOD playlist themselves
    // (see buildFullHlsPlaylist) — ffmpeg's own playlist output here is
    // just a disposable byproduct of running in -f hls mode at all, never
    // the one actually served.
    const ffmpegPlaylistPath = session.calculatedLength ? path.join(session.dir, 'scratch.m3u8') : session.playlistPath;
    ffArgs.push(
      '-hls_segment_filename', path.join(session.dir, `segment%05d.${segmentExt}`),
      ffmpegPlaylistPath
    );

    // mode=hls-buffer's still-growing buffer.ts (read directly, ahead of
    // finalization) and a genuinely finished file (hotSwapToCache, or
    // hls-buffer/hls-tap post-finalize) both take the isLocalSource branch
    // above - worth distinguishing in the log, since only the growing-file
    // case has any theoretical exposure to the encode pass catching up to
    // the write frontier (see waitForBufferedThrough's safety margin).
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

    let ytVideoErr = '';
    let ytAudioErr = '';
    let ffErr = '';
    ff.stderr.on('data', (c) => { ffErr = (ffErr + c.toString()).slice(-4000); });

    if (useSectionedPipe) {
      // Verification aid for the -copyts alignment fix above: pipe:3
      // (video, Input #0) and pipe:4 (audio, Input #1) each get their own
      // startup banner from ffmpeg's 'info' loglevel, e.g. "Duration: N/A,
      // start: 305.233000, bitrate: N/A" - with -copyts that "start" is the
      // section's real source-relative landing point, so diffing the two
      // shows exactly how far video's keyframe-snap drifted from audio's
      // near-exact cut for this seek. Scans the rolling ffErr tail on every
      // chunk since both banners print early, well within the 4000-char
      // window; stops once both are found so it only logs once per pass.
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

    // mode=hls-tap finalization - deliberately a SEPARATE close listener
    // from the main one below, not folded into it, because a superseded/
    // torn-down pass's incomplete tap file still needs discarding even
    // when the main handler's `if (!isCurrentPass()) return;` guard skips
    // everything else. Only ever treats the tap file as complete on a
    // clean close (exit code 0, not one of our own kill signals, session
    // not mid-teardown) for the pass that actually owns it - anything
    // else (a crash, a seek-triggered restart, a session stop) discards
    // it rather than risk finalizing a corrupt partial file (a -c copy
    // MP4's moov atom only gets flushed on a clean finish).
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
              }
            })
            .catch((err) => logger.warn({ err, sessionKey, youtubeId }, 'ytstream: hls-tap finalize failed'));
        } else {
          discardTapOutput({ youtubeId, tempPath: tapTempPathForThisPass });
        }
      });
    }

    // Safety net for useInfoJson (see warmHlsInfoJsonCache): the cached
    // info-json's signed URLs are typically valid for a few hours, but
    // could in principle have expired (a very long-paused session) or
    // otherwise gone bad. On any failure, permanently drop the cache for
    // the rest of THIS session (not just this one retry) so a stale cache
    // can't keep failing every subsequent seek too, then retry once with a
    // normal watch-URL extraction - the always-correct, if slower, path
    // this session used before the cache was ready.
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
    // to the yt-dlp-pipe path if ffmpeg fails for any reason — an unproven
    // 403 for this video/client/session (see docs/YTSTREAM_SEEK_FIX.md's
    // vprv caveat), a transient network blip, anything. Never let a seek
    // regress below "eventually decode-and-discards" just because the
    // faster path didn't pan out this time. Scoped to this one pass's
    // closure (not session state) so it can't interfere with a later,
    // unrelated restart.
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

    // Safety net for useSectionedPipe: --download-sections + the matroska
    // downloader override is verified against this one yt-dlp version/video
    // combo, not guaranteed for every one - if yt-dlp or ffmpeg chokes on
    // it, fall back exactly once to the classic full-pipe decode-and-discard
    // path (forceFullPipe), which is slower but has always worked. Mutually
    // exclusive with maybeFallbackToPipe in practice (useSectionedPipe never
    // true alongside isDirectSource), so trying both below is safe either way.
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
      if (!isCurrentPass()) return;
      if (code !== 0 && code !== null && !isKilledByUs(signal)) {
        logger.error({ sessionKey, code, signal, ffErr: ffErr.slice(-800) }, 'ytstream: HLS ffmpeg exited non-zero');
        if (maybeFallbackFromInfoJson('ffmpeg-exit', ffErr || `ffmpeg exited with code ${code}`)) return;
        if (maybeFallbackToPipe('ffmpeg-exit', ffErr || `ffmpeg exited with code ${code}`)) return;
        if (maybeFallbackToFullPipe('ffmpeg-exit', ffErr || `ffmpeg exited with code ${code}`)) return;
        markFailed(ytVideoErr || ytAudioErr || ffErr || `ffmpeg exited with code ${code}`);
        // A clean finish already gets #EXT-X-ENDLIST from ffmpeg itself
        // for the non-calculatedLength case. A crash mid-transcode doesn't —
        // without it, a player that already started playing the segments
        // we did produce would just hang forever waiting for the next one
        // instead of ending playback cleanly. calculatedLength sessions already
        // have a static, complete playlist with ENDLIST from the start,
        // so there's nothing to append here.
        if (!session.calculatedLength && session.state === 'ready') {
          fs.appendFile(session.playlistPath, '\n#EXT-X-ENDLIST\n', (err) => {
            if (err) logger.warn({ err, sessionKey }, 'ytstream: failed to append #EXT-X-ENDLIST after HLS ffmpeg crash');
          });
        }
      }
    });
  }

  /**
   * mode=hls-buffer: an independent, one-shot yt-dlp(video)+yt-dlp(audio)+
   * ffmpeg pipeline that pulls this session's video once, at full network
   * speed, remuxing (-c copy, no re-encode, no HLS segmenting) into a single
   * local MPEG-TS file - the same DASH video/audio pipes spawnHlsEncodePass's
   * network branch uses, but run entirely on its own, never killed or
   * restarted by a seek or session teardown the way the session's own `ff`
   * is (see ytstreamBufferFetch.js's module doc comment for why that
   * decoupling is the whole point of this mode: mode=hls-tap's tap shares
   * the live encode's process, so it's bound by the live encode's own
   * throughput for the entire session - this fetch has no such ceiling).
   * Fire-and-forget - the caller does not await this; every encode pass
   * instead polls session.bufferedSeconds via waitForBufferedThrough before
   * reading the growing file.
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
    // -progress pipe:1 output arrives on ffmpeg's stdout, not stderr.
    // Logged (debug, throttled to once per BUFFER_PROGRESS_LOG_INTERVAL_SECONDS
    // of buffered video, not per progress tick - those can arrive many times
    // a second) so a stalled/slow fetch is visible in the logs instead of
    // going completely silent between the start and finish/fail lines -
    // without this, a hung fetch and a slow-but-healthy one look identical.
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
      finalizeTapOutput({ youtubeId, tempPath: session.bufferTempPath, finalPath: session.bufferFinalPath, sourceLabel: 'hls-buffer' })
        .then((finalPath) => {
          if (finalPath) {
            session.usingCachedSource = true;
            session.cachedFilePath = finalPath;
            session.bufferFetchDone = true;
            logger.info({ sessionKey: session.sessionKey, youtubeId, finalPath }, 'ytstream: hls-buffer fetch finalized as permanent download');
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
   * mode=hls-buffer: waits (bounded) for startHlsBufferFetch's independent
   * fetch to have written at least BUFFER_SAFETY_MARGIN_SECONDS past
   * `targetSeconds` before letting an encode pass read that region as a
   * plain local file - see BUFFER_SAFETY_MARGIN_SECONDS's doc comment for
   * why the margin exists.
   * @returns {Promise<'buffer'|'network'>} 'buffer': safe to read
   *   session.cachedFilePath (if usingCachedSource, i.e. the fetch already
   *   finished) or session.bufferTempPath directly as a local source.
   *   'network': give up - fall back to today's proven network-sourced path
   *   for this one pass. The fetch itself keeps running regardless.
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
   * calculatedLength only: kills the currently-running encode pass and starts a
   * new one at `segmentIndex`'s boundary, without touching the session's
   * entry in hlsSessions/activeStreams or its directory — this is much
   * lighter than destroyHlsSession, which tears the whole session down.
   * Deduplicates concurrent requests for the same target landing within
   * HLS_SEEK_GRACE_MS of each other (e.g. several HLS.js byte-range
   * retries for the same seek) into a single restart.
   *
   * Goes straight to spawnHlsEncodePass with no directUrls (see
   * docs/YTSTREAM_SEEK_FIX.md), skipping a direct-URL resolve+fetch
   * attempt (resolveDashUrlsForSeek/spawnHlsEncodePass's isDirectSource
   * branch, still used by mode=ffmpeg's own seek path) - googlevideo's
   * vprv=1 URLs 403 when fetched by a bare ffmpeg HTTP client, so that
   * attempt would only add a guaranteed-to-fail network round trip before
   * falling through to spawnHlsEncodePass's own useSectionedPipe logic
   * (yt-dlp `--download-sections` + a matroska downloader override) anyway.
   */
  async function restartHlsEncodePassAtSegment(session, segmentIndex) {
    const now = Date.now();
    if (session.lastRestartIndex === segmentIndex && now - session.lastRestartAt < HLS_SEEK_GRACE_MS) {
      return;
    }
    session.lastRestartIndex = segmentIndex;
    session.lastRestartAt = now;
    logger.info({ sessionKey: session.key, segmentIndex }, 'ytstream: seek past encoded HLS segments; restarting encode pass at boundary');
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
      // mode=hls-buffer: wait (bounded) for the independent buffer fetch
      // (startHlsBufferFetch) to have safely written past this seek target
      // before reading it as a plain local file - see
      // waitForBufferedThrough/BUFFER_SAFETY_MARGIN_SECONDS. Falls through
      // to the normal network-sourced restart below (source stays
      // undefined) if the wait times out - the fetch itself keeps running
      // in the background regardless of whether this pass used it.
      const targetSeconds = segmentIndex * HLS_SEGMENT_DURATION_SECONDS;
      const ready = await waitForBufferedThrough(session, targetSeconds);
      if (ready === 'buffer') {
        source = { type: 'local', filePath: session.usingCachedSource ? session.cachedFilePath : session.bufferTempPath };
      }
    }

    spawnHlsEncodePass(session, { startSegmentIndex: segmentIndex, isInitialPass: false, source });
  }

  /**
   * ytstream.hotSwapToCache: if STRM cache-on-play (see strmCacheOnPlay.js)
   * has finished downloading this session's video since it started, kills
   * the live network encode pass and restarts it sourced from the local
   * cached file instead — same picture, no player-visible restart, just
   * faster/more reliable for the rest of the video. Throttled to at most
   * once every HOT_SWAP_CHECK_INTERVAL_MS via session.lastHotSwapCheckAt,
   * and only ever switches once (session.usingCachedSource).
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
      // for this same session must not also trigger a second switch while
      // this one is in flight. cachedFilePath is read by
      // restartHlsEncodePassAtSegment so a LATER calculatedLength seek-restart
      // (after this hot-swap) keeps reading from the cached file instead of
      // silently reverting to the network source.
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
   * calculatedLength only: the playlist declares every segment upfront, but only
   * a forward-encoding window of them exists on disk at any moment. Called
   * by the segment route when a requested segment is missing — gives the
   * currently-running pass a brief grace window to reach it naturally (the
   * common sequential-playback case, just ahead of the encode), then
   * restarts the forward encode at that segment's boundary and waits for
   * it to appear.
   */
  async function ensureHlsSegmentAvailable(session, targetIndex, filePath) {
    if (fs.existsSync(filePath)) return true;
    const graceDeadline = Date.now() + HLS_SEEK_GRACE_MS;
    while (Date.now() < graceDeadline) {
      if (fs.existsSync(filePath)) return true;
      await new Promise((resolve) => setTimeout(resolve, HLS_READY_POLL_INTERVAL_MS));
    }
    if (fs.existsSync(filePath)) return true;

    // The pass currently running is already working toward this exact
    // segment - most commonly targetIndex 0 requested while the session's
    // own initial pass hasn't produced its first segment yet (VAAPI/GPU
    // init + yt-dlp resolve routinely takes longer than HLS_SEEK_GRACE_MS's
    // short window). This isn't a seek at all, so restarting here would
    // just kill and respawn an identical pass, throwing away whatever
    // progress it already made for nothing. Keep waiting on the SAME pass
    // instead, using the same budget a genuine cold start gets.
    if (session.activePassStartIndex === targetIndex) {
      const coldStartDeadline = Date.now() + HLS_READY_TIMEOUT_MS;
      while (Date.now() < coldStartDeadline) {
        if (fs.existsSync(filePath)) return true;
        if (session.destroying) return false;
        await new Promise((resolve) => setTimeout(resolve, HLS_READY_POLL_INTERVAL_MS));
      }
      return fs.existsSync(filePath);
    }

    // Not awaited: restartHlsEncodePassAtSegment's own DASH-URL resolution
    // step happens in the background while this loop below polls the
    // filesystem for the target segment - that's the whole point of
    // giving it up to HLS_SEEK_RESTART_READY_TIMEOUT_MS to appear. .catch
    // only guards against an unhandled rejection; failures are already
    // logged/handled inside restartHlsEncodePassAtSegment/spawnHlsEncodePass.
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
   * Seek-latency fix (see useInfoJson in spawnHlsEncodePass): resolves
   * yt-dlp's webpage + player-API extraction for this video exactly once,
   * fire-and-forget, in parallel with the session's first encode pass -
   * never awaited, so it can't delay first playback. If it finishes before
   * a seek happens, every subsequent yt-dlp child spawned for that seek
   * uses `--load-info-json` against the cached result instead of
   * re-extracting from a bare watch URL. If a seek races it (most likely
   * an immediate Jellyfin resume-from-middle, which restarts right away
   * rather than after some idle playback at segment 0), that one seek just
   * falls back to the old, always-correct full-extraction path - only
   * session.infoJsonPath being non-null unlocks the fast path anywhere.
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

    // Unique per spawn attempt, not just per sessionKey: the 403/
    // extraction-error retry path destroys a session and immediately
    // creates a new one under the *same* sessionKey (map key + URL
    // segment are meant to be reused), but destroyHlsSession's directory
    // removal is deliberately delayed (see its comment) — reusing the
    // same directory here would let that delayed cleanup delete the new
    // attempt's freshly-written segments out from under it. The asset
    // route resolves files via session.dir, not by recomputing a path
    // from sessionKey, so this is safe to vary independently.
    const dir = path.join(HLS_BASE_TEMP_DIR, `${sessionKey}-${crypto.randomBytes(4).toString('hex')}`);
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
      // mode=hls-tap - see spawnHlsEncodePass's tapActive logic and
      // server/modules/ytstreamTapFinalizer.js. tapEnabled only ends up
      // true below if this video is genuinely still STRM right now -
      // nothing to tap into otherwise (same "skip already-done work"
      // precedent as ytstream.serveCachedFile). tapAttempted guards
      // against a same-pass fallback/retry (info-json-cache fallback,
      // sectioned-pipe fallback) claiming a second tap slot.
      tapEnabled: false,
      tapAttempted: false,
      tapTempPath: null,
      tapFinalPath: null,
      // mode=hls-buffer - see startHlsBufferFetch/waitForBufferedThrough.
      // bufferEnabled only ends up true below if this video is genuinely
      // still STRM right now (same "skip already-done work" precedent as
      // tapEnabled above). bufferedSeconds is updated by the independent
      // fetch's -progress output; bufferFetchFailed short-circuits any
      // in-progress waitForBufferedThrough wait so a dead fetch doesn't
      // make every pass wait out the full timeout individually.
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
          // Staged under the session's own fast local HLS temp dir (same
          // place segments already go), NOT inside the video's own library
          // folder - confirmed live that writing the tap continuously to
          // that (likely NAS/network-backed) location drags the whole
          // shared ffmpeg pipeline down to it, throttling the LIVE stream
          // too (observed: HLS segment production dropped from far faster
          // than real-time to barely real-time once the tap was writing to
          // the library path). Local /tmp has no such bottleneck. The
          // one-time move to the real library path happens once, in
          // ytstreamTapFinalizer, after encoding finishes - see its
          // rename/cross-device-copy fallback. This also means an
          // abandoned tap (a hard kill that bypasses the close listener)
          // gets swept up for free by destroyHlsSession's existing
          // delayed session.dir removal, instead of being an orphaned file
          // sitting in the library folder forever.
          session.tapTempPath = path.join(dir, `tap${ext}`);
          session.tapFinalPath = path.join(targetDir, `${fileStem}${ext}`);
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
          // Deliberately its OWN directory, NOT session.dir - unlike the
          // session's HLS segments/hls-tap's tapTempPath, this fetch is
          // designed to keep running and finalize even after the HLS
          // session itself is torn down (idle reap, a 403/extraction-error
          // retry, manual stop - see startHlsBufferFetch's doc comment), so
          // it must not live inside a directory destroyHlsSession schedules
          // for deletion on teardown - that would delete the buffer file
          // out from under the still-running independent ffmpeg process.
          // Always .ts regardless of the session's own `container` setting
          // (which only governs the LIVE HLS segments) - MPEG-TS is the
          // hard technical requirement for a file that's safely readable
          // while still being appended to (no moov-atom-style trailing
          // index the way MP4 has).
          const bufferDir = path.join(HLS_BASE_TEMP_DIR, `buffer-${youtubeId}-${crypto.randomBytes(4).toString('hex')}`);
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
        }
      } catch (err) {
        logger.warn({ err, sessionKey, youtubeId }, 'ytstream: hls-buffer could not resolve STRM target; buffer disabled for this session');
      }
    }

    if (session.calculatedLength) {
      // Pre-declare the whole playlist (real duration, VOD, ENDLIST) up
      // front — see buildFullHlsPlaylist — so the player sees a full,
      // seekable timeline immediately, before almost any of those
      // segments actually exist. Ignores `seekSeconds` (the cold-start "?t="
      // offset): segment 0 must always correspond to video time 0
      // for the pre-declared absolute segment indices to stay correct.
      const durationSeconds = await getVideoDurationSeconds(youtubeId, config);
      session.durationSeconds = durationSeconds;
      session.totalSegments = Math.max(1, Math.ceil(durationSeconds / HLS_SEGMENT_DURATION_SECONDS));

      // ytstream.instantStart - see ensurePlaceholderSegment's doc comment.
      // Staged into session.dir under its own filename (never a real
      // segment index), so nothing else in the HLS pipeline needs to know
      // it exists - only the playlist's leading entries reference it.
      let placeholder = null;
      const ytCfgForSession = config.ytstream || {};
      if (ytCfgForSession.instantStart === true && transcode === 'h264') {
        const sourceResolution = await resolveVideoTargetResolution(youtubeId, models);
        const { width, height } = capResolutionToHeight(sourceResolution.width, sourceResolution.height, resolveQualityHeight(quality));
        const generated = await ensurePlaceholderSegment({ segmentType, segmentExt, hardwareMode: hw, tuning: tier, width, height });
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
            logger.info({ sessionKey }, 'ytstream: HLS session starting with instant-start placeholder segment');
          } catch (err) {
            logger.warn({ err, sessionKey }, 'ytstream: failed to stage instant-start placeholder into session dir; falling back to normal startup');
          }
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
    // wait for the buffer fetch (see startHlsBufferFetch above) - it always
    // starts network-sourced, exactly like plain mode=hls. An earlier
    // version awaited waitForBufferedThrough here, which blocked this whole
    // function (and therefore the HTTP response carrying the playlist -
    // including the ytstream.instantStart placeholder segment written into
    // playlistPath above) on the buffer catching up: up to
    // BUFFER_SAFETY_MARGIN_SECONDS + real cold-start wait, which defeated
    // instant-start's entire purpose (serve *something* immediately while
    // the real pipeline is still spinning up) - the client got no response
    // at all until the buffer had already produced almost enough data for
    // the real segment anyway. The buffer still gets used for anything
    // after this first pass - see restartHlsEncodePassAtSegment, which
    // seeks (and, for calculatedLength sessions, missing-segment restarts)
    // already route through waitForBufferedThrough, and that happens after
    // the response has already gone out and playback has already started -
    // a brief wait there doesn't block anything the way it would have here.
    spawnHlsEncodePass(session, { startSegmentIndex: 0, seekSeconds, isInitialPass: true, playerClientOverride });

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
   * Returns an existing ready/starting session for this key, or creates
   * one and waits for it to become ready (retrying once with the android
   * player client on the same 403/extraction-error signature streamViaFfmpeg
   * handles) before returning. Throws if it never becomes ready.
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

        // Nothing has reached a client yet (session never became ready) - if
        // this attempt used a hardware encoder, retry once in software before
        // giving up. Mirrors runPipeline's allowHwFallback behavior for the
        // DASH/direct-pipe path; the HLS session path never had an equivalent,
        // so a broken/missing QSV/VAAPI/NVENC/AMF device hard-failed every
        // mode=hls request instead of falling back to libx264.
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
     * Seek-restart fix (docs/YTSTREAM_SEEK_FIX.md): resolves the direct
     * DASH URLs for a nonzero-offset request — covers both the
     * calculatedLength Range-restart path (a fresh HTTP request per
     * seek, so this just runs once for that request) and, opportunistically
     * at no extra cost, the cold-start `?t=` case the doc scoped as
     * low-priority/"fix if it comes along for free". Returns null (never
     * throws) on any failure, so callers can unconditionally fall back to
     * the yt-dlp-pipe path.
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
     * Spawns two `yt-dlp -o -` processes — one for a video-only DASH
     * format, one for audio-only — each piped into its own extra file
     * descriptor on ffmpeg (`pipe:3` / `pipe:4`), which muxes them.
     * yt-dlp does all the actual fetching from googlevideo (with the
     * same cookies/session it used to resolve the formats); ffmpeg never
     * makes an HTTP request itself.
     *
     * This two-pipe split (rather than one `yt-dlp -f bv*+ba -o -`
     * process) exists because yt-dlp can't stream a merged bv*+ba
     * selector to stdout progressively — it has to download both tracks
     * and mux them with its own ffmpeg call first, which on a long video
     * looks like the request hanging before any bytes arrive. Fetching
     * video and audio as two independent streams sidesteps that: each
     * pipe starts flowing as soon as its own track starts downloading,
     * and *our* ffmpeg does the muxing as bytes arrive on both.
     *
     * It also avoids the alternative failure mode: handing ffmpeg a bare
     * `-g`-resolved googlevideo URL to fetch on its own reliably 403s,
     * since many of those URLs are "visitor-private" (`vprv=1`) and get
     * rejected unless the request comes from the same client/session
     * that resolved them — cookies alone don't satisfy that check.
     *
     * If the requested hardware encoder (qsv/nvenc/vaapi/amf) fails to
     * initialize — e.g. the host/container doesn't actually have a working
     * VAAPI/QSV driver for /dev/dri, or no GPU at all — ffmpeg exits
     * non-zero before it ever writes a byte to the response. Previously
     * that was a hard 502 any time hardwareMode was misconfigured, even
     * though software encoding (libx264) would have worked fine. Now, as
     * long as nothing has reached the client yet, it retries once in
     * software before giving up.
     */
    async function runPipeline(playerClient, hw, { allowHwFallback, allowClientRetry, forcePipeMode = false }) {
      // Seek-restart fix (docs/YTSTREAM_SEEK_FIX.md): resolved before
      // building any yt-dlp args below, and before any response headers go
      // out further down, so a failed resolution can transparently fall
      // through to the unchanged yt-dlp-pipe path with nothing observable
      // to the caller. forcePipeMode skips this - set only by this same
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

      const encoder = transcode === 'h264' ? buildVideoEncoderArgs(hw, resolveQualityHeight(quality), tier) : null;

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
        // during teardown (client disconnect, hw fallback, retry) — one
        // side gets torn down while the other still has a write in
        // flight. An unhandled 'error' on any of them is an uncaught
        // exception that crashes the *entire* Node process, not just
        // this request, so every stream on both sides gets a listener.
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
        // or not. Without this, a hardware encoder that fails instantly
        // (no bytes ever written) silently finalizes the HTTP response as
        // "200 OK" with an empty body *before* handleFailure/ff.on('close')
        // below get a chance to run — masking the failure entirely and
        // defeating the software fallback below. res.end() is now only
        // ever called explicitly, from the close handler.
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

          // Seek-restart's direct-URL attempt failed - an unproven 403 for
          // this video/client/session (see docs/YTSTREAM_SEEK_FIX.md's vprv
          // caveat), a transient network blip, anything. Falls back to the
          // yt-dlp-pipe path exactly once, ahead of the client/hw-fallback
          // checks below (which don't apply here - this isn't a yt-dlp
          // fetch failure or a hardware-encoder failure). Never let a seek
          // regress below "eventually decode-and-discards" just because the
          // faster path didn't pan out this time.
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
   * Streaming page (client/src/components/StreamingPage) — lists every
   * currently-active mode=ffmpeg/mode=hls stream tracked in activeStreams,
   * with a best-effort title lookup for videos already known to Youtarr's
   * library (no live yt-dlp fetch — this is a stats endpoint, not another
   * extraction call). REST source of truth for the page's initial load and
   * for reconnects; live deltas come from the streamProgress/streamStarted/
   * streamStopped WebSocket broadcasts (see trackStream/untrackStream/
   * tickStreamStats above).
   *
   * MUST be registered before the '/api/ytstream/:youtubeId' route below:
   * Express matches by registration order, not specificity, and "streams"
   * (7 lowercase letters) passes that route's own youtubeId format check —
   * without this ordering, GET /api/ytstream/streams would get silently
   * hijacked as a request to "stream video id streams".
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
   * Stream History page — persisted audit trail of past ytstream playback
   * sessions (server/models/streamhistory.js), unlike /streams above which
   * only ever shows what's currently active. Server-side paginated (unlike
   * the Jobs/DownloadHistory precedent, which fetches everything and
   * paginates client-side) since this table only grows with normal use and
   * has no natural upper bound the way the job list does.
   *
   * MUST be registered before '/api/ytstream/:youtubeId' below — same
   * reasoning as '/streams' above.
   */
  router.get('/api/ytstream/history', authMiddleware, async (req, res) => {
    if (!models || !models.StreamHistory) {
      return res.json({ rows: [], total: 0, page: 1, limit: 25 });
    }
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
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

  /**
   * Resolves every playback setting (mode/container/transcode/hardwareMode/
   * tuning/quality/qualityStrictness/calculatedLength/hotSwapToCache/
   * forceServerSettings) the same way for both the real streaming route
   * below and the read-only `/simulate` debug route - a single source of
   * truth so the debug trace can never silently drift from what a real
   * request would actually do. Each mode is self-contained: mode=ffmpeg/hls
   * fails outright (`ffmpegAvailable: false` in the returned plan) rather
   * than substituting a different mode's behavior when ffmpeg isn't
   * available on the host.
   *
   * `probe: true` (what the real route always passes) runs the two real
   * yt-dlp lookups this logic depends on for full accuracy - the DASH-based
   * best-available-height auto-cap (resolveEffectiveQualityHeight) and the
   * transcode=copy->h264 codec auto-upgrade check (resolveVideoCodec).
   * `probe: false` (the /simulate route's default) skips both and reports
   * the pre-probe values instead, so a debug call is instant and never
   * touches yt-dlp/YouTube. isFfmpegAvailable() and the probeShortcut check
   * are always evaluated for real either way - both are cheap, pure/cached,
   * side-effect-free reads.
   */
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
    if ((mode === 'ffmpeg' || mode === 'hls' || mode === 'hls-tap' || mode === 'hls-buffer') && !ffmpegAvailable) {
      // No fallback to a different mode - mode=ffmpeg/hls/hls-tap/hls-buffer
      // requires ffmpeg, full stop. The real route responds 502 for this
      // rather than silently serving direct/direct-pipe instead.
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

    const calculatedLengthRaw = queryOverride('calculatedLength') ?? queryOverride('fakeLength') ?? ytCfg.calculatedLength;
    const calculatedLength = calculatedLengthRaw === true || /^(1|true|yes)$/i.test(String(calculatedLengthRaw ?? ''));
    if (calculatedLength && (mode === 'direct' || mode === 'direct-redirect')) {
      steps.push({
        step: 'calculatedLength',
        detail: `on, but ignored - ${mode} mode uses the stream's own real length (whatever the upstream/player's own fetch reports), not an estimate`,
        probed: false,
      });
    } else if (calculatedLength && mode === 'direct-pipe') {
      steps.push({
        step: 'calculatedLength',
        detail: 'on - used for the opening request only (no Range header, or one starting at byte 0): reports a real estimated Content-Length (and 206/Content-Range if a Range header asked for it), built from this video\'s duration x bitrate estimate. A real mid-video seek (non-zero Range start) still isn\'t supported - falls through to the same unbounded response as if this were off',
        probed: false,
      });
    }

    const hotSwapToCache = ytCfg.hotSwapToCache === true;
    if (hotSwapToCache && mode !== 'hls') {
      // mode=hls-tap/hls-buffer intentionally fall into this same "ignored"
      // branch - both replace hotSwapToCache/cache-on-play entirely (via
      // the tap or the independent buffer fetch, respectively) rather than
      // layering on top of it, so there's nothing session-swap-shaped for
      // either to use here.
      steps.push({ step: 'hotSwapToCache', detail: 'on, but ignored - only mode=hls uses it', probed: false });
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

    // Execution/fallback narrative - describes what actually happens once
    // the resolved mode/quality/transcode above is handed off to the real
    // serve function, including the retry chains those functions run on
    // failure (see serveDirect/resolveDirectUrl for direct,
    // streamViaFfmpeg/runPipeline's handleFailure for ffmpeg,
    // getOrCreateHlsSession's retry block for hls). Static/descriptive -
    // this never actually executes any of it - so it's kept in sync by
    // hand with those functions rather than derived from them; skipped
    // entirely when probeShortcut would fire, since the real request never
    // reaches any of this.
    const ffmpegModeBlocked = (mode === 'ffmpeg' || mode === 'hls' || mode === 'hls-tap' || mode === 'hls-buffer') && !ffmpegAvailable;
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
            detail: 'the cold-start/first pass never waits on the buffer - it starts network-sourced immediately, identically to plain mode=hls (so instant-start\'s placeholder segment, if enabled, behaves exactly the same as it does for mode=hls too)',
            probed: false,
          });
          steps.push({
            step: 'execution',
            detail: 'every later pass (a seek restart, or a calculatedLength missing-segment restart) waits up to 45s for the buffer to have safely written past its target timestamp, then reads that local file directly instead of pulling from the network; on timeout, that one pass falls back to the same network-sourced path plain mode=hls uses (the buffer fetch itself is unaffected and keeps running)',
            probed: false,
          });
          steps.push({
            step: 'execution',
            detail: 'once the buffer fetch finishes cleanly, its file is moved into the video\'s library folder, the Video row is flipped off STRM (is_strm=false), and every subsequent pass (this session and any other) reads from that finished file - same as hotSwapToCache/mode=hls-tap\'s finalized output',
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

    // ytstream.probeShortcut - see tryServeProbeClip/isLikelyMetadataProbeRequest's
    // doc comment. Must run before EVERYTHING else in this handler (the
    // cache-on-play trigger below included) - the entire point is that a
    // detected metadata probe never causes any real yt-dlp/ffmpeg work or
    // background download against YouTube.
    {
      const probeCfg = (configModule.getConfig().ytstream) || {};
      const probeQueryOverride = (name) => (probeCfg.forceServerSettings === true ? undefined : req.query[name]);
      if (evaluateProbeShortcut(req, configModule.getConfig()).wouldFire) {
        const sourceResolution = await resolveVideoTargetResolution(youtubeId, models);
        const probeQuality = probeQueryOverride('quality') || probeCfg.quality || configModule.getConfig().preferredResolution || '720';
        const { width, height } = capResolutionToHeight(sourceResolution.width, sourceResolution.height, resolveQualityHeight(probeQuality));
        const served = await tryServeProbeClip(req, res, {
          hardwareMode: normalizeHardwareMode(probeQueryOverride('hardware') || probeCfg.hardwareMode || 'none'),
          tuning: normalizeTuning(probeQueryOverride('tuning') || probeCfg.tuning || 'fast'),
          width,
          height,
        });
        if (served) return;
        // Generation failed - fall through to normal handling below.
      }
    }

    // ytstream.serveCachedFile: if this video is already fully downloaded
    // (most commonly via STRM cache-on-play, but any genuine download
    // works too), serve that real local file directly - see
    // tryServeCachedVideoFile above. Checked before the cache-on-play
    // trigger below (nothing to enqueue for an already-cached video) and
    // before any mode/quality resolution, none of which is relevant once a
    // real file already exists. Off by default - existing STRM playback is
    // unaffected unless explicitly opted in.
    //
    // Only for the FIRST request of a fresh playback attempt (no live HLS
    // session for this video yet) - confirmed live that applying this
    // mid-session breaks playback: a calculatedLength/HLS session already
    // in progress has negotiated Range/seek math against the ESTIMATED
    // length from session start, and swapping in the real file's actual
    // (different) size out from under it made the player's existing Range
    // requests land at the wrong offset - observed as the video repeatedly
    // jumping forward. An already-running mode=hls session instead gets the
    // real file via maybeHotSwapToCache, which is safe because it preserves
    // segment/index continuity instead of changing the resource's length
    // underneath an in-flight request.
    if ((configModule.getConfig().ytstream || {}).serveCachedFile === true && models && models.Video) {
      const hasActiveSessionForVideo = [...hlsSessions.values()].some((s) => s.youtubeId === youtubeId && !s.destroying);
      if (!hasActiveSessionForVideo) {
        try {
          const cachedVideo = await models.Video.findOne({
            where: { youtubeId },
            attributes: ['is_strm', 'filePath'],
          });
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
    // mode=hls-buffer also replaces cache-on-play entirely (its own
    // independent fetch does the same job, without hls-tap's "only a
    // perfect uninterrupted play-through" limitation) - unlike tap, it
    // isn't restricted to an un-seeked t=0 request, since the buffer fetch
    // doesn't depend on which segment is being played at all.
    const tapWillAttempt = cheapMode === 'hls-tap' && !req.query.t;
    const bufferWillAttempt = cheapMode === 'hls-buffer';
    require('../modules/strmCacheOnPlay').maybeEnqueueCacheDownload(youtubeId, { skip: tapWillAttempt || bufferWillAttempt }).catch((err) =>
      logger.warn({ err, youtubeId }, 'ytstream: cache-on-play trigger failed')
    );

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
      if ((mode === 'ffmpeg' || mode === 'hls' || mode === 'hls-tap' || mode === 'hls-buffer') && !plan.ffmpegAvailable) {
        // No fallback to direct - each mode does exactly what it says. If
        // ffmpeg genuinely isn't installed/working on this host,
        // mode=ffmpeg/hls/hls-tap/hls-buffer just fails outright instead of
        // silently downgrading to a different mode's behavior.
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
      const ffmpegModeBlocked = (plan.mode === 'ffmpeg' || plan.mode === 'hls' || plan.mode === 'hls-tap' || plan.mode === 'hls-buffer') && !plan.ffmpegAvailable;
      if (plan.probeShortcut.wouldFire) {
        wouldCall = 'tryServeProbeClip(...) [probeShortcut - real request never reaches the mode/quality logic above]';
      } else if (ffmpegModeBlocked) {
        wouldCall = `502 - mode=${plan.mode} requires ffmpeg, which is unavailable on this host (no fallback to a different mode)`;
      } else if (plan.mode === 'ffmpeg') {
        wouldCall = `streamViaFfmpeg({ quality: "${plan.quality}", container: "${plan.container}", transcode: "${plan.transcode}", hardwareMode: "${plan.hardwareMode}", tuning: "${plan.tuning}" })`;
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
      logger.debug({ sessionKey, filename, size: stat.size, range: req.headers.range || null }, 'ytstream: serving HLS asset');

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
