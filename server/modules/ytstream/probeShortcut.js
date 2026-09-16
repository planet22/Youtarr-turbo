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
// const { pipeline } = require('stream/promises'); // only used by the commented-out tryServeProbeClip below
const logger = require('../../logger');
const configModule = require('../configModule');
const streamEncoderTuning = require('../streamEncoderTuning');
const { normalizeHardwareMode, normalizeTuning, buildVideoEncoderArgs } = streamEncoderTuning;
const { VALID_TRANSCODE, VALID_CONTAINERS, createQueryOverrideResolver } = require('./configResolution');
const { YTSTREAM_CLIPS_DIR } = require('./paths');
const { streamDebug } = require('./streamDebug');
const { resolveVideoTargetResolution } = require('./videoResolution');
const { resolveQualityHeight, capResolutionToHeight } = require('./formatSelection');
const { buildHlsTopLevelPlaylistResponse } = require('./hlsMasterPlaylist');

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

// Must mirror what a real hls/hls-buffer session would actually serve for
// this `container` setting (see playbackPlan.js's own resolution and
// getHlsContainerInfo in hlsEngine.js) - Jellyfin decides direct-play
// eligibility from its own ffprobe pass against this exact URL, so the
// probe clip has to report the same container/codec info real playback
// would, or Jellyfin can never reconcile the two and keeps re-probing
// instead of ever starting real playback.
const PROBE_CLIP_CONTAINER_INFO = {
  mp4: { ext: 'mp4', muxer: 'mp4', contentType: 'video/mp4' },
  mkv: { ext: 'mkv', muxer: 'matroska', contentType: 'video/x-matroska' },
  ts: { ext: 'ts', muxer: 'mpegts', contentType: 'video/mp2t' },
};

// `ytstream.probeShortcutContainerOverride` (config.json only - not exposed
// in Settings UI, debug-only escape hatch): when set to a valid container,
// forces every probe clip to that container regardless of what the real
// session negotiated, so a specific container's duration-patch path
// (findMp4MvhdDurationInfo/findMatroskaDurationValueOffset et al) can be
// forced on/off for testing without editing code each time - see the mp4-
// duration investigation notes above getProbeClipDurationPatchInfo. null
// (default) uses the real session's own `container` setting, same as before
// this override existed.
function resolveProbeClipContainer(container) {
  const override = (configModule.getConfig().ytstream || {}).probeShortcutContainerOverride;
  if (override && VALID_CONTAINERS.includes(override) && PROBE_CLIP_CONTAINER_INFO[override]) {
    streamDebug({ requestedContainer: container, override }, 'ytstream: resolveProbeClipContainer using probeShortcutContainerOverride');
    return override;
  }
  const resolved = VALID_CONTAINERS.includes(container) && PROBE_CLIP_CONTAINER_INFO[container]
    ? container
    : 'mp4';
  streamDebug({ requestedContainer: container, resolved }, 'ytstream: resolveProbeClipContainer using the real session container (no override set)');
  return resolved;
}

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

// Jellyfin's own internal player uses the same bare Lavf UA both for its
// real ffprobe pass AND, at least in some flows, for the actual
// playback-compatibility check it does when it thinks direct play might not
// work - so a second (or third...) bare-Lavf request for the same video is
// not necessarily another probe to answer with the fake clip; it can be the
// player trying to actually play. Once we've served the synthetic clip once
// for a video, a repeat within this window falls through to normal handling
// instead of serving the fake clip again, so a real session gets a chance
// to start. Harmless if this fires spuriously (worst case: skips the fast
// path and pays for a real cold start instead) - once a real HLS session
// actually exists for the video, hasActiveHlsSessionForVideo's own check in
// the route already keeps this whole block from running at all, so this
// map only ever matters for the gap before that session exists.
const PROBE_SHORTCUT_RETRY_SUPPRESS_MS = 60_000;
const recentlyServedFakeClipAt = new Map();
function hasRecentlyServedFakeProbeClip(youtubeId) {
  const last = recentlyServedFakeClipAt.get(youtubeId);
  return !!last && Date.now() - last < PROBE_SHORTCUT_RETRY_SUPPRESS_MS;
}
// Only called by the commented-out tryServeProbeClip below.
// eslint-disable-next-line no-unused-vars
function markFakeProbeClipServed(youtubeId) {
  recentlyServedFakeClipAt.set(youtubeId, Date.now());
}

// Jellyfin's prober sets a video's RunTimeTicks straight from ffprobe's
// `format.duration`, unconditionally overwriting whatever it already knew -
// so a short probe clip gets recorded as the video's real length. Patching
// the container's own duration field to the real known duration (see
// resolveDurationSeconds) makes the probe response accurate without
// encoding an extra frame. Jellyfin trusts that value outright without
// validating it against actual media length.
//
// mkv: ffmpeg's matroska muxer always writes duration as one fixed field:
// EBML ID 0x4489 (Segment Info "Duration"), a 0x88 size marker (8 bytes
// follow), then an 8-byte big-endian IEEE754 double in milliseconds
// (TimecodeScale default 1ms/unit).
//
// mp4: ffmpeg's (faststart) mp4 muxer writes duration in three places, and
// which one a given ffprobe build's mov demuxer actually trusts for
// `format.duration` isn't guaranteed - so all three get patched, best-effort,
// for the best shot at Jellyfin picking up the real duration:
//
// - `moov`/`mvhd` (movie-level, one per file): 4-byte box-type marker
//   "mvhd", then 1 version byte + 3 flag bytes, then (version 0) 4+4+4+4-byte
//   creation/modification/timescale/duration fields or (version 1)
//   8+8+4+8-byte equivalents (timescale is always 32-bit either way).
// - `moov`/`trak`/`tkhd` (one per track - typically two here, video+audio):
//   same version+flags header, then creation/modification/track_ID/reserved
//   (4+4+4+4 for version 0, 8+8+4+4 for version 1), then a duration field
//   expressed in the file's MOVIE timescale (mvhd's) - tkhd has no
//   timescale field of its own.
// - `moov`/`trak`/`mdia`/`mdhd` (one per track): identical layout to mvhd
//   (creation/modification/timescale/duration), but each track's timescale
//   can differ from the movie's and from each other (e.g. video vs audio
//   sample rate).
//
// NOT patched: the per-track sample tables (`stts` et al) that some ffprobe
// builds derive `format.duration` from regardless of the header fields
// above - faking those would mean lying about how many samples exist
// without matching real encoded data, risking corruption for anything that
// tries to actually decode the file rather than just read its metadata.
// If Jellyfin's duration is still wrong after this fuller patch, that's the
// likely reason (see the memory/investigation notes for this feature).
//
// ts: mpegts has no container-level duration field to patch (duration is
// derived from PCR/timestamp range) - never patched, always served as
// generated.
//
// All scanned for by marker (not a hardcoded offset) for resilience across
// ffmpeg versions; if not found, patching is silently skipped and the clip
// is served as generated - same best-effort philosophy as the rest of this feature.
const MATROSKA_DURATION_MARKER = Buffer.from([0x44, 0x89, 0x88]);
const MP4_MVHD_MARKER = Buffer.from('mvhd', 'ascii');
const MP4_TKHD_MARKER = Buffer.from('tkhd', 'ascii');
const MP4_MDHD_MARKER = Buffer.from('mdhd', 'ascii');
const probeClipDurationPatchInfoCache = new Map(); // signature -> patch info | null

function findMatroskaDurationValueOffset(buffer) {
  const markerOffset = buffer.indexOf(MATROSKA_DURATION_MARKER);
  if (markerOffset === -1) return -1;
  const valueOffset = markerOffset + MATROSKA_DURATION_MARKER.length;
  return valueOffset + 8 <= buffer.length ? valueOffset : -1;
}

function findAllMarkerOffsets(buffer, marker) {
  const offsets = [];
  let from = 0;
  for (;;) {
    const idx = buffer.indexOf(marker, from);
    if (idx === -1) break;
    offsets.push(idx);
    from = idx + 1;
  }
  return offsets;
}

// Shared by mvhd and mdhd - both are version(1)+flags(3), creation_time,
// modification_time, timescale, duration (32-bit fields for version 0,
// 64-bit creation/modification/duration for version 1; timescale is always
// 32-bit). tkhd's layout differs - see findMp4TkhdDurationInfos.
function findMp4TimescaleDurationBox(buffer, markerOffset, markerLength) {
  const versionOffset = markerOffset + markerLength;
  if (versionOffset >= buffer.length) return null;
  const version = buffer[versionOffset];
  const timescaleOffset = versionOffset + (version === 1 ? 1 + 3 + 8 + 8 : 1 + 3 + 4 + 4);
  const durationSize = version === 1 ? 8 : 4;
  const durationOffset = timescaleOffset + 4;
  return durationOffset + durationSize <= buffer.length ? { timescaleOffset, durationOffset, durationSize } : null;
}

function findMp4MvhdDurationInfo(buffer) {
  const markerOffset = buffer.indexOf(MP4_MVHD_MARKER);
  if (markerOffset === -1) return null;
  return findMp4TimescaleDurationBox(buffer, markerOffset, MP4_MVHD_MARKER.length);
}

function findMp4MdhdDurationInfos(buffer) {
  return findAllMarkerOffsets(buffer, MP4_MDHD_MARKER)
    .map((markerOffset) => findMp4TimescaleDurationBox(buffer, markerOffset, MP4_MDHD_MARKER.length))
    .filter(Boolean);
}

// tkhd: version(1)+flags(3), creation_time, modification_time, track_ID(4),
// reserved(4), then duration - no timescale field of its own (expressed in
// the movie's timescale, patched using patchInfo.mvhd.timescaleOffset).
function findMp4TkhdDurationInfos(buffer) {
  return findAllMarkerOffsets(buffer, MP4_TKHD_MARKER)
    .map((markerOffset) => {
      const versionOffset = markerOffset + MP4_TKHD_MARKER.length;
      if (versionOffset >= buffer.length) return null;
      const version = buffer[versionOffset];
      const durationOffset = versionOffset + (version === 1 ? 1 + 3 + 8 + 8 + 4 + 4 : 1 + 3 + 4 + 4 + 4 + 4);
      const durationSize = version === 1 ? 8 : 4;
      return durationOffset + durationSize <= buffer.length ? { durationOffset, durationSize } : null;
    })
    .filter(Boolean);
}

// writeMp4DurationField/getProbeClipDurationPatchInfo below are only called
// by the commented-out tryServeProbeClip below.
// eslint-disable-next-line no-unused-vars
function writeMp4DurationField(buffer, { durationOffset, durationSize }, durationUnits) {
  if (durationSize === 8) {
    buffer.writeBigUInt64BE(BigInt(durationUnits), durationOffset);
  } else {
    buffer.writeUInt32BE(durationUnits >>> 0, durationOffset);
  }
}

// eslint-disable-next-line no-unused-vars
async function getProbeClipDurationPatchInfo(signature, filePath, container) {
  if (probeClipDurationPatchInfoCache.has(signature)) return probeClipDurationPatchInfoCache.get(signature);
  let info = null;
  if (container === 'mkv' || container === 'mp4') {
    try {
      const fh = await fs.promises.open(filePath, 'r');
      try {
        const head = Buffer.alloc(65536);
        const { bytesRead } = await fh.read(head, 0, head.length, 0);
        const scanned = head.subarray(0, bytesRead);
        if (container === 'mkv') {
          const offset = findMatroskaDurationValueOffset(scanned);
          if (offset !== -1) info = { kind: 'mkv', offset };
        } else {
          const mvhd = findMp4MvhdDurationInfo(scanned);
          if (mvhd) {
            info = {
              kind: 'mp4',
              mvhd,
              tkhds: findMp4TkhdDurationInfos(scanned),
              mdhds: findMp4MdhdDurationInfos(scanned),
            };
          }
        }
      } finally {
        await fh.close();
      }
    } catch (err) {
      logger.warn({ err, signature, container }, 'ytstream: failed to scan probe-shortcut clip for its container duration field');
    }
  }
  probeClipDurationPatchInfoCache.set(signature, info);
  return info;
}

/**
 * Generates (or reuses a cached) tiny standalone clip matching a
 * `transcode=h264` session's encoder settings, muxed into the same
 * container a real session would use (see resolveProbeClipContainer) so
 * Jellyfin's own ffprobe pass against this URL learns the right
 * container/codec info instead of one that a real playback response will
 * later contradict. Never throws; returns null on failure.
 * @param {number} width - target resolution (see resolveVideoTargetResolution)
 * @param {number} height
 * @param {string} container - 'mp4' | 'mkv' | 'ts' (falls back to 'mp4')
 * @returns {Promise<{filePath: string, signature: string, container: string}|null>}
 */
async function ensureProbeClip({ hardwareMode, tuning, width, height, container }) {
  const resolvedContainer = resolveProbeClipContainer(container);
  const containerInfo = PROBE_CLIP_CONTAINER_INFO[resolvedContainer];
  const signature = `${normalizeHardwareMode(hardwareMode)}-${normalizeTuning(tuning)}-${width}x${height}-${resolvedContainer}`;
  const dir = path.join(PROBE_CLIP_CACHE_DIR, signature);
  const filePath = path.join(dir, `probe.${containerInfo.ext}`);
  if (fs.existsSync(filePath)) return { filePath, signature, container: resolvedContainer };

  if (probeClipGenerationPromises.has(signature)) {
    await probeClipGenerationPromises.get(signature).catch(() => {});
    return fs.existsSync(filePath) ? { filePath, signature, container: resolvedContainer } : null;
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
    // +faststart moves moov ahead of mdat so the small file we write to
    // disk once (not streamed) is still a well-formed progressive-download
    // mp4 - matches what a real fmp4/mp4 session would produce.
    if (resolvedContainer === 'mp4') args.push('-movflags', '+faststart');
    args.push('-f', containerInfo.muxer, filePath);

    logger.info({ signature, args }, 'ytstream: generating probe-shortcut clip');
    await runFfmpegOnce(args);
  })();

  probeClipGenerationPromises.set(signature, generate);
  try {
    await generate;
    return fs.existsSync(filePath) ? { filePath, signature, container: resolvedContainer } : null;
  } catch (err) {
    logger.warn({ err, signature }, 'ytstream: failed to generate probe-shortcut clip');
    return null;
  } finally {
    probeClipGenerationPromises.delete(signature);
  }
}

/**
 * SUPERSEDED 2026-09-14 - kept commented out, not deleted, per the
 * investigation in the probeShortcut project memory (search
 * "MAJOR CORRECTION"): this fake flat-file clip lies about container SHAPE
 * to Jellyfin (a standalone mp4/mkv file), not just duration/codec, and
 * Jellyfin caches that shape at the library-item level. Later, when
 * Jellyfin does a non-Direct-Play transcode, it opens the real (genuinely
 * HLS-shaped) ytstream URL with the wrong demuxer and fails outright - this
 * is what broke Apple clients. See tryServeInstantHlsPlaylist below for the
 * replacement, which serves a real playlist instead so Jellyfin's probe
 * learns the correct Container:hls.
 *
 * @returns {Promise<boolean>} true if a response was sent (caller must
 *   return immediately without falling through to normal handling).
 * @param {(youtubeId: string) => Promise<number>} resolveDurationSeconds -
 *   DB-first, yt-dlp-fallback-then-cached; a real network call happens at
 *   most once per not-yet-tracked video, then hits durationCache.
 */
// async function tryServeProbeClip(req, res, { hardwareMode, tuning, width, height, container, youtubeId, resolveDurationSeconds }) {
//   try {
//     const clip = await ensureProbeClip({ hardwareMode, tuning, width, height, container });
//     if (!clip) return false;
//
//     // Best-effort duration patch - see the duration-marker doc comment
//     // above. Falls back to serving the clip unmodified (today's behavior)
//     // whenever the real duration can't be resolved, or the container's
//     // duration field can't be located/patched (always true for ts).
//     let body = null;
//     let knownDurationSeconds = null;
//     try {
//       knownDurationSeconds = await resolveDurationSeconds(youtubeId);
//     } catch (err) {
//       logger.warn({ err, youtubeId }, 'ytstream: could not resolve real duration for probe-shortcut clip; serving it unmodified');
//     }
//     if (knownDurationSeconds) {
//       const patchInfo = await getProbeClipDurationPatchInfo(clip.signature, clip.filePath, clip.container);
//       if (patchInfo) {
//         try {
//           const buffer = await fs.promises.readFile(clip.filePath);
//           if (patchInfo.kind === 'mkv') {
//             buffer.writeDoubleBE(knownDurationSeconds * 1000, patchInfo.offset);
//             streamDebug({ youtubeId, knownDurationSeconds }, 'ytstream: probe-shortcut patched mkv Segment Info Duration');
//           } else {
//             // mp4: patch mvhd (movie-level), every track's tkhd (movie
//             // timescale), and every track's mdhd (its own timescale) - see
//             // the doc comment above findMp4TimescaleDurationBox for why all
//             // three, and what's deliberately NOT patched (sample tables).
//             const movieTimescale = buffer.readUInt32BE(patchInfo.mvhd.timescaleOffset);
//             const movieDurationUnits = Math.round(knownDurationSeconds * movieTimescale);
//             writeMp4DurationField(buffer, patchInfo.mvhd, movieDurationUnits);
//             for (const tkhd of patchInfo.tkhds) {
//               writeMp4DurationField(buffer, tkhd, movieDurationUnits);
//             }
//             for (const mdhd of patchInfo.mdhds) {
//               const trackTimescale = buffer.readUInt32BE(mdhd.timescaleOffset);
//               writeMp4DurationField(buffer, mdhd, Math.round(knownDurationSeconds * trackTimescale));
//             }
//             streamDebug(
//               { youtubeId, knownDurationSeconds, movieTimescale, tkhdCount: patchInfo.tkhds.length, mdhdCount: patchInfo.mdhds.length },
//               'ytstream: probe-shortcut patched mp4 mvhd/tkhd/mdhd duration fields'
//             );
//           }
//           body = buffer;
//         } catch (err) {
//           logger.warn({ err, youtubeId }, 'ytstream: failed to patch probe-shortcut clip duration; serving it unmodified');
//         }
//       }
//     }
//
//     const size = body ? body.length : (await fs.promises.stat(clip.filePath)).size;
//     markFakeProbeClipServed(youtubeId);
//     logger.info(
//       { youtubeId, servedAs: 'fake', container: clip.container, ua: req.headers['user-agent'], size, url: req.originalUrl, patchedDurationSeconds: body ? knownDurationSeconds : null },
//       'ytstream: probe-shortcut detected a likely metadata-probe request; served the synthetic clip'
//     );
//     res.set({
//       'Content-Type': PROBE_CLIP_CONTAINER_INFO[clip.container].contentType,
//       'Content-Length': String(size),
//       'Cache-Control': 'no-store',
//       'Accept-Ranges': 'bytes',
//     });
//     if (body) {
//       res.end(body);
//     } else {
//       // pipeline(), not a bare .pipe() + manual Promise - a client that
//       // disconnects before reading the whole clip otherwise leaves this
//       // await (and the whole request/response) hanging forever.
//       try {
//         await pipeline(fs.createReadStream(clip.filePath), res);
//       } catch (err) {
//         if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw err;
//       }
//     }
//     return true;
//   } catch (err) {
//     logger.warn({ err }, 'ytstream: failed to serve probe-shortcut clip; falling back to normal request handling');
//     return false;
//   }
// }

/**
 * Replacement for tryServeProbeClip above: instead of faking a flat-file
 * clip, gets/creates the SAME real hls/hls-buffer session a genuine
 * playback request for these exact params would use (buildSessionKey
 * mirrors the route's own sessionKey math) and serves its already-written
 * VOD playlist immediately, via getOrCreateSession (see
 * getOrCreateHlsSessionForProbe in hlsEngine.js), without waiting for a
 * real segment to exist. Since calculatedLength is forced on for every HLS
 * session, that playlist is already the complete, real, correctly-typed
 * (Container:hls) response - no synthetic clip, no duration patching
 * needed. The encode this kicks off keeps running in the background and is
 * reused by a real playback request for the same params (or reaped idle if
 * nothing ever fetches a segment).
 *
 * hlsEngine.js's session helpers are passed in (buildSessionKey,
 * getOrCreateSession, rewritePlaylistUrls) rather than required directly,
 * to avoid a circular require - hlsEngine.js already requires playbackPlan.js,
 * which requires this module for evaluateProbeShortcut.
 *
 * @returns {Promise<boolean>} true if a response was sent.
 */
async function tryServeInstantHlsPlaylist(req, res, {
  youtubeId, mode, quality, qualityStrictness, transcode, hardwareMode, tuning, container, playerClient, config, models,
  clientIp, userAgent, buildSessionKey, getOrCreateSession, rewritePlaylistUrls,
}) {
  try {
    const isBufferMode = mode === 'hls-buffer';
    const sessionKey = buildSessionKey({
      youtubeId, quality, qualityStrictness, transcode, hardwareMode, tuning, container,
      playerClient, calculatedLength: true, buffer: isBufferMode,
    });
    const baseUrl = `${req.protocol}://${req.get('host')}/api/ytstream/${encodeURIComponent(youtubeId)}/hls/${sessionKey}/`;

    const session = await getOrCreateSession(sessionKey, {
      youtubeId, quality, qualityStrictness, transcode, hardwareMode, tuning, container, config, baseUrl,
      seekSeconds: null, calculatedLength: true, hotSwapToCache: false, bufferEnabled: isBufferMode, clientIp, userAgent,
    });

    const rawPlaylist = await fs.promises.readFile(session.playlistPath, 'utf8');
    const playlist = rewritePlaylistUrls(rawPlaylist, session.baseUrl);
    logger.info(
      { youtubeId, sessionKey, ua: req.headers['user-agent'], url: req.originalUrl },
      'ytstream: probe-shortcut detected a likely metadata-probe request; served the real HLS playlist instantly (session encode continues in the background)'
    );
    // ytstream.hlsMasterPlaylist (default on) - see hlsMasterPlaylist.js's
    // own doc comment; same decision point the real playback path uses
    // (server/routes/ytstream.js), so a probe and the real play that
    // follows it always get the same top-level response shape.
    const topLevelPlaylist = await buildHlsTopLevelPlaylistResponse({
      enabled: (config.ytstream || {}).hlsMasterPlaylist !== false,
      youtubeId,
      quality,
      transcode,
      hardwareMode,
      models,
      mediaPlaylistUrl: `${session.baseUrl}playlist.m3u8`,
      rewrittenMediaPlaylist: playlist,
      resolveVideoTargetResolution,
      capResolutionToHeight,
      resolveQualityHeight,
    });
    res.set({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
    streamDebug({ youtubeId, sessionKey, topLevelPlaylist }, 'ytstream: probe-shortcut - top-level playlist content being served');
    res.send(topLevelPlaylist);
    return true;
  } catch (err) {
    logger.warn({ err, youtubeId }, 'ytstream: failed to serve instant HLS playlist for probe; falling back to normal request handling');
    return false;
  }
}

module.exports = {
  isLikelyMetadataProbeRequest,
  evaluateProbeShortcut,
  shouldLogQuickServeHistory,
  hasRecentlyServedFakeProbeClip,
  ensureProbeClip,
  tryServeInstantHlsPlaylist,
};
