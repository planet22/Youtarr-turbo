/**
 * server/modules/ytstream/probeShortcut.js
 *
 * `ytstream.probeShortcut` (opt-in): detects a metadata-probe request (e.g.
 * Jellyfin's ffprobe pass) and serves a tiny synthetic cached clip instead
 * of spinning up a real yt-dlp/ffmpeg session, plus the probe-clip cache
 * that backs it. Extracted from server/routes/ytstream.js so it's a real
 * importable module instead of trapped in that file's private route-
 * factory closure.
 *
 * See strmGenerator.js for the pipe-syntax User-Agent written into every
 * .strm when this is on, and ytstreamProbeShortcut.js for the shared marker
 * value used there (unrelated to this module's own UA-pattern detection
 * below, which keys off libavformat's own default UA, not that marker).
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
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const logger = require('../../logger');
const configModule = require('../configModule');
const streamEncoderTuning = require('../streamEncoderTuning');
const { normalizeHardwareMode, normalizeTuning, buildVideoEncoderArgs } = streamEncoderTuning;
const { VALID_TRANSCODE, createQueryOverrideResolver } = require('./configResolution');
const { YTSTREAM_CLIPS_DIR } = require('./paths');

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
  const probeQueryOverride = createQueryOverrideResolver(req, probeCfg);
  const isMetadataProbe = isLikelyMetadataProbeRequest(req);
  const transcode = VALID_TRANSCODE.includes(probeQueryOverride('transcode'))
    ? probeQueryOverride('transcode')
    : (probeCfg.transcode || 'copy');
  // Cheap mirror of the real route's mode resolution (same
  // forceServerSettings-aware precedence as resolvePlaybackPlan) - needed
  // because `transcode=h264` alone doesn't mean the real response IS h264:
  // mode=direct/direct-redirect never transcode, always
  // proxying the source's real codec as-is.
  // Without this check, a direct-family play with transcode=h264 left over
  // from switching modes got an h264 probe clip for its ffprobe, then a
  // real response in the source's actual codec (VP9/AV1/Opus) - Jellyfin
  // decoded based on the probe's wrong answer and playback never worked.
  const mode = String(probeQueryOverride('mode') || probeCfg.defaultMode || 'direct').toLowerCase();
  const transcodeIsHonoredByMode = mode === 'hls' || mode === 'hls-buffer';

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

// Only used by ensureProbeClip's synthetic testsrc2 clip generation below -
// not a real playback target resolution, so kept private to this module
// rather than shared with resolveVideoTargetResolution's own fallback
// dimensions (server/routes/ytstream.js).
const HLS_PLACEHOLDER_FPS = 30;

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

// Persistent, same reasoning as paths.js's YTSTREAM_CACHE_DIR doc comment.
const PROBE_CLIP_CACHE_DIR = path.join(YTSTREAM_CLIPS_DIR, 'probe-shortcut');
const PROBE_CLIP_DURATION_SECONDS = 2;
const probeClipGenerationPromises = new Map();

// Jellyfin's own ffprobe keyframe-extraction pass (for accurate seeking in
// transcoded HLS playback) reads scattered chunks across an entire cached
// file in one short burst - a handful of separate bare-Lavf requests a few
// hundred ms apart, all for the same youtubeId. Without this, quick-serve
// StreamHistory logging (added so these otherwise-invisible hits show up
// somewhere) turns one such burst into a handful of near-duplicate rows
// that look like repeated "sessions" for the same video. Keyed by
// youtubeId only (not per-request), so a burst logs exactly one row. Used
// by both this module's probe-clip serving and ytstream.js's cached-file
// serving path.
const recentQuickServeHistoryLogAt = new Map();
const QUICK_SERVE_HISTORY_LOG_COOLDOWN_MS = 60_000;
function shouldLogQuickServeHistory(youtubeId) {
  const now = Date.now();
  const last = recentQuickServeHistoryLogAt.get(youtubeId);
  if (last && now - last < QUICK_SERVE_HISTORY_LOG_COOLDOWN_MS) return false;
  recentQuickServeHistoryLogAt.set(youtubeId, now);
  return true;
}

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
      { youtubeId, servedAs: 'fake', ua: req.headers['user-agent'], size, url: req.originalUrl, patchedDurationSeconds: body ? knownDurationSeconds : null },
      'ytstream: probe-shortcut detected a likely metadata-probe request; served the synthetic clip'
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
      // pipeline(), not a bare .pipe() + manual Promise - a client that
      // disconnects before reading the whole clip otherwise leaves this
      // await (and the whole request/response) hanging forever.
      try {
        await pipeline(fs.createReadStream(clip.filePath), res);
      } catch (err) {
        if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw err;
      }
    }
    return true;
  } catch (err) {
    logger.warn({ err }, 'ytstream: failed to serve probe-shortcut clip; falling back to normal request handling');
    return false;
  }
}

module.exports = {
  isLikelyMetadataProbeRequest,
  evaluateProbeShortcut,
  shouldLogQuickServeHistory,
  ensureProbeClip,
  tryServeProbeClip,
};
