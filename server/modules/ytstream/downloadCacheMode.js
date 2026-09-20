/**
 * server/modules/ytstream/downloadCacheMode.js
 *
 * `mode=download-cache` (experimental): no streaming/HLS at all - downloads
 * the whole video once (yt-dlp handles the video+audio merge itself, since
 * it's writing to a real seekable file rather than a pipe), optionally
 * re-encodes it, and caches the result as one real file on disk. Every
 * request (including the first) blocks until that file exists, then serves
 * it with plain HTTP Range support - no manifest, no live encode racing
 * ahead of playback, no synthetic metadata for a media server to guess at.
 * The tradeoff versus every other mode: no bytes reach the player until
 * the whole download/encode finishes.
 *
 * Deliberately standalone (own cache dir, own yt-dlp/ffmpeg invocations) -
 * does not call into hlsEngine.js/directMode.js/playbackPlan.js, so this
 * experimental mode can never regress any existing one. Reuses only
 * genuinely generic, stateless helpers (format selectors, encoder-arg
 * builder, the process registry, ytDlpRunner) already shared by every mode.
 *
 * `transcode=copy`: yt-dlp downloads+merges video+audio into one mp4 in a
 * single call (`-f "<video>+<audio>" --merge-output-format mp4`) - no
 * separate ffmpeg pass needed, yt-dlp shells out to ffmpeg for the merge
 * itself. `transcode=h264`: same download, then one extra ffmpeg pass reads
 * that finished local file (a real, seekable input - none of hlsEngine.js's
 * pipe/fd wiring is needed here) and re-encodes it into the final cached
 * file. The `container` setting is ignored - always mp4.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const logger = require('../../logger');
const ytDlpRunner = require('../ytDlpRunner');
const { normalizeHardwareMode, normalizeTuning, buildVideoEncoderArgs } = require('../streamEncoderTuning');
const { getDashFormatSelectors, resolveQualityHeight } = require('./formatSelection');
const { buildBaseArgs } = require('./ytdlpArgs');
const { isFfmpegAvailable, registerChildProcess } = require('./processRegistry');
const { serveFileWithRangeSupport } = require('./rangeFileServe');
const { streamDebug } = require('./streamDebug');
const { trackStream, untrackStream, failStreamThenUntrack, getStream: getActiveStream, createBytesCounter } = require('./activeStreams');
const { YTSTREAM_CACHE_DIR } = require('./paths');

// Dot-prefixed even though it's already nested under the hidden
// YTSTREAM_CACHE_DIR - kept consistent so this directory reads as hidden on
// its own too, not just by inheriting its parent's name.
const CACHE_DIR = path.join(YTSTREAM_CACHE_DIR, '.download-cache');
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const ENCODE_TIMEOUT_MS = 30 * 60 * 1000;
// How long a "serving" activeStreams row (see maybeStartServeTracking)
// stays visible with no requests before it's removed - mirrors
// byteRangeHlsMode.js's own idle reaper. Serving an already-cached file is
// just plain HTTP Range requests, not a live process to kill, so there's
// nothing to tear down here beyond the activeStreams entry itself.
const SERVE_IDLE_TIMEOUT_MS = 2 * 60 * 1000;
const SERVE_IDLE_SWEEP_INTERVAL_MS = 30 * 1000;

/** cacheKey -> in-flight Promise<string> (resolves to the finished cachePath) */
const inFlight = new Map();
/** cacheKey -> lastAccess timestamp, for currently-being-served (already cached) videos */
const activeServeSessions = new Map();
let serveReaperStarted = false;

function buildCacheKey({ youtubeId, quality, qualityStrictness, transcode, hardwareMode, tuning }) {
  const raw = JSON.stringify({ youtubeId, quality, qualityStrictness, transcode, hardwareMode, tuning });
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 24);
}

function ensureServeReaper() {
  if (serveReaperStarted) return;
  serveReaperStarted = true;
  streamDebug({ idleTimeoutMs: SERVE_IDLE_TIMEOUT_MS }, 'ytstream: download-cache serve-tracking idle reaper starting');
  const interval = setInterval(() => {
    const now = Date.now();
    for (const [cacheKey, lastAccess] of activeServeSessions) {
      if (now - lastAccess > SERVE_IDLE_TIMEOUT_MS) {
        streamDebug({ cacheKey, idleForMs: now - lastAccess }, 'ytstream: download-cache serve session idle timeout - untracking');
        activeServeSessions.delete(cacheKey);
        untrackStream(cacheKey, 'completed', null);
      }
    }
  }, SERVE_IDLE_SWEEP_INTERVAL_MS);
  interval.unref();
}

/**
 * Tracks (or refreshes) a "serving" activeStreams row for an already-
 * cached video - the phase downloadAndCache's own tracking above doesn't
 * cover, since that's untracked as soon as the file finishes downloading.
 * Keyed by cacheKey, same as the download phase, so every concurrent/
 * repeat viewer of the same cached file shares one row instead of one per
 * request. Reuses the SAME streamId as the (by now already untracked)
 * download-phase entry - safe, since that entry is guaranteed gone by the
 * time serving starts (downloadAndCache always untracks before returning).
 */
function maybeStartServeTracking({ cacheKey, youtubeId, quality, transcode, hardwareMode, tuning, clientIp, userAgent }) {
  if (activeServeSessions.has(cacheKey)) {
    activeServeSessions.set(cacheKey, Date.now());
    streamDebug({ cacheKey, youtubeId }, 'ytstream: download-cache - joining an already-tracked serving session for this cached video');
    return;
  }
  activeServeSessions.set(cacheKey, Date.now());
  streamDebug({ cacheKey, youtubeId }, 'ytstream: download-cache - starting serve-phase tracking for this cached video');
  trackStream({
    streamId: cacheKey,
    mode: 'download-cache',
    youtubeId,
    quality,
    container: 'mp4',
    transcode,
    hardwareMode,
    tuning,
    clientIp,
    userAgent,
    state: 'serving',
    startedAt: Date.now(),
    bytesTransferred: 0,
    bytesPerSecond: 0,
    lastActivityAt: Date.now(),
  });
  ensureServeReaper();
}

function runFfmpeg(args, { cacheKey, youtubeId }) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    registerChildProcess(ff);
    streamDebug({ cacheKey, youtubeId, ffPid: ff.pid, ffArgs: args }, 'ytstream: download-cache ffmpeg re-encode process spawned');
    let stderr = '';
    ff.stderr.on('data', (c) => { stderr = (stderr + c.toString()).slice(-4000); });
    const timer = setTimeout(() => {
      ff.kill('SIGKILL');
      reject(new Error(`ffmpeg encode timed out after ${ENCODE_TIMEOUT_MS}ms`));
    }, ENCODE_TIMEOUT_MS);
    ff.on('error', (err) => { clearTimeout(timer); reject(err); });
    ff.on('close', (code, signal) => {
      clearTimeout(timer);
      streamDebug({ cacheKey, youtubeId, code, signal }, 'ytstream: download-cache ffmpeg re-encode process closed');
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
    });
  });
}

async function downloadAndCache(cacheKey, { youtubeId, quality, qualityStrictness, transcode, hardwareMode, tuning, config, playerClient, clientIp, userAgent }) {
  // Streaming-page / stream-history visibility for the one shared
  // download/encode effort backing every concurrent request for this video
  // (see ensureCachedFile's inFlight dedup) - same activeStreams.js every
  // other mode uses. Untracked once this resolves/rejects below; the
  // file-serve phase that follows (this same video, already cached - a
  // repeat play, or every viewer once a fresh download finishes) gets its
  // OWN separate tracked row - see maybeStartServeTracking.
  trackStream({
    streamId: cacheKey,
    mode: 'download-cache',
    youtubeId,
    quality,
    container: 'mp4',
    transcode,
    hardwareMode,
    tuning,
    clientIp,
    userAgent,
    state: 'downloading',
    startedAt: Date.now(),
    bytesTransferred: 0,
    bytesPerSecond: 0,
    lastActivityAt: Date.now(),
  });

  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const finalPath = path.join(CACHE_DIR, `${cacheKey}.mp4`);
    const tempDownloadPath = path.join(CACHE_DIR, `tmp-${cacheKey}-${crypto.randomBytes(4).toString('hex')}.mp4`);

    const { videoFormat, audioFormat } = getDashFormatSelectors(quality, qualityStrictness);
    streamDebug({ youtubeId, cacheKey, quality, qualityStrictness, videoFormat, audioFormat }, 'ytstream: download-cache resolved yt-dlp format selectors');
    const args = [
      ...buildBaseArgs(config, { playerClient }),
      '-f', `${videoFormat}+${audioFormat}`,
      '--merge-output-format', 'mp4',
      '--no-playlist', '--no-warnings',
      '-o', tempDownloadPath,
      `https://youtube.com/watch?v=${youtubeId}`,
    ];
    logger.info({ youtubeId, cacheKey, quality, transcode, tempDownloadPath }, 'ytstream: download-cache - downloading+merging via yt-dlp');
    await ytDlpRunner.run(args, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
    streamDebug({ youtubeId, cacheKey }, 'ytstream: download-cache yt-dlp download+merge finished');

    if (!fs.existsSync(tempDownloadPath)) {
      throw new Error('yt-dlp reported success but the merged file is missing');
    }

    if (transcode !== 'h264') {
      fs.renameSync(tempDownloadPath, finalPath);
      logger.info({ youtubeId, cacheKey, finalPath }, 'ytstream: download-cache - copy mode, merged download cached as-is');
      untrackStream(cacheKey, 'completed', null);
      return finalPath;
    }

    const hw = normalizeHardwareMode(hardwareMode);
    const tier = normalizeTuning(tuning);
    const encoder = buildVideoEncoderArgs(hw, resolveQualityHeight(quality), tier, (config.ytstream || {}).vaapiQuality, 'h264', false);
    const ffArgs = ['-y', '-loglevel', 'error'];
    if (encoder.preInputArgs && encoder.preInputArgs.length) ffArgs.push(...encoder.preInputArgs);
    ffArgs.push('-i', tempDownloadPath, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn');
    if (encoder.videoFilters && encoder.videoFilters.length) ffArgs.push('-vf', encoder.videoFilters.join(','));
    if (encoder.pixFmt) ffArgs.push('-pix_fmt', encoder.pixFmt);
    ffArgs.push(...encoder.encoderArgs, '-c:a', 'aac', '-ac', '2', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', finalPath);

    logger.info({ youtubeId, cacheKey, hardwareMode: hw, tuning: tier }, 'ytstream: download-cache - re-encoding merged download to h264/aac');
    try {
      await runFfmpeg(ffArgs, { cacheKey, youtubeId });
    } finally {
      fs.unlink(tempDownloadPath, () => {});
    }
    logger.info({ youtubeId, cacheKey, finalPath }, 'ytstream: download-cache - re-encode finished, video cached');
    untrackStream(cacheKey, 'completed', null);
    return finalPath;
  } catch (err) {
    failStreamThenUntrack(cacheKey, 'failed', err.message);
    throw err;
  }
}

/**
 * Resolves the cached file path for these params, downloading (and
 * optionally re-encoding) it first if it isn't cached yet. Concurrent
 * requests for the same not-yet-cached video share one in-flight download
 * instead of racing separate yt-dlp/ffmpeg runs.
 */
async function ensureCachedFile(params) {
  const cacheKey = buildCacheKey(params);
  const finalPath = path.join(CACHE_DIR, `${cacheKey}.mp4`);
  if (fs.existsSync(finalPath)) {
    streamDebug({ cacheKey, finalPath }, 'ytstream: download-cache - cache hit, returning existing file immediately');
    return finalPath;
  }

  if (inFlight.has(cacheKey)) {
    streamDebug({ cacheKey }, 'ytstream: download-cache - joining an already in-flight download for this video');
    return inFlight.get(cacheKey);
  }

  streamDebug({ cacheKey }, 'ytstream: download-cache - no cache hit and nothing in-flight, starting a fresh download');
  const promise = downloadAndCache(cacheKey, params).finally(() => inFlight.delete(cacheKey));
  inFlight.set(cacheKey, promise);
  return promise;
}

/** Handles the top-level `mode=download-cache` request. */
async function handleDownloadCacheRequest(req, res, params) {
  const { youtubeId, quality, qualityStrictness, transcode, hardwareMode, tuning, clientIp, userAgent } = params;
  streamDebug({ youtubeId, quality, qualityStrictness, transcode, hardwareMode, tuning, clientIp, userAgent }, 'ytstream: download-cache top-level request received');
  if (!isFfmpegAvailable()) {
    logger.warn({ youtubeId }, 'ytstream: download-cache mode requested but ffmpeg is unavailable on this host');
    res.status(502).send('download-cache mode requires ffmpeg, which is unavailable on this host');
    return;
  }
  const cacheKey = buildCacheKey(params);
  const alreadyCached = fs.existsSync(path.join(CACHE_DIR, `${cacheKey}.mp4`));
  streamDebug({ youtubeId, cacheKey, alreadyCached }, 'ytstream: download-cache resolved cache key');
  try {
    const filePath = await ensureCachedFile(params);
    streamDebug({ youtubeId, cacheKey, filePath }, 'ytstream: download-cache serving the cached file');
    maybeStartServeTracking({ cacheKey, youtubeId, quality, transcode, hardwareMode, tuning, clientIp, userAgent });
    const streamEntry = getActiveStream(cacheKey);
    serveFileWithRangeSupport(filePath, req, res, 'video/mp4', () => {
      activeServeSessions.set(cacheKey, Date.now());
      if (streamEntry) {
        streamEntry.lastActivityAt = Date.now();
        streamEntry.state = 'serving';
      }
    }, createBytesCounter(streamEntry));
  } catch (err) {
    logger.error({ err, youtubeId, cacheKey }, 'ytstream: download-cache mode failed to produce a cached file');
    res.status(502).send('download-cache mode failed to download/encode this video');
  }
}

module.exports = { handleDownloadCacheRequest, ensureCachedFile, buildCacheKey };
