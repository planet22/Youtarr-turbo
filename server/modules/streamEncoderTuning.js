/**
 * server/modules/streamEncoderTuning.js
 *
 * Shared home for ytstream.js's real-time H.264 encoder argument builder
 * (extracted so server/modules/streamTuningBenchmark.js can drive it with a
 * synthetic input for the "Test real-time tuning" benchmark, without
 * requiring the route file itself). Building the actual live-playback
 * pipeline and benchmarking it against the exact same arg-construction code
 * is the whole point — a benchmark that used its own separate encoder-arg
 * logic could drift from what playback actually runs.
 *
 * Three tuning tiers trade encode speed for picture quality at a given
 * resolution:
 *   - 'fast'     - today's long-standing defaults (unchanged), chosen for
 *                  safety under real-time HLS/live-pipe constraints.
 *   - 'balanced' - a step up in quality (lower CRF/QP, slower preset,
 *                  look-ahead where available) for hosts with encode
 *                  headroom to spare.
 *   - 'quality'  - maximum picture quality this encoder backend reasonably
 *                  supports while still being attempted in real time; may
 *                  not keep up at high resolutions on modest hardware -
 *                  see streamTuningBenchmark.js.
 */

const VALID_HARDWARE = ['none', 'qsv', 'nvenc', 'vaapi', 'amf'];
const VALID_TUNING = ['fast', 'balanced', 'quality'];
const TUNING_LABELS = { fast: 'Fast (real-time safe)', balanced: 'Balanced', quality: 'Quality' };

function normalizeHardwareMode(mode) {
  const m = String(mode || 'none').toLowerCase().trim();
  return VALID_HARDWARE.includes(m) ? m : 'none';
}

function normalizeTuning(tuning) {
  const t = String(tuning || 'fast').toLowerCase().trim();
  return VALID_TUNING.includes(t) ? t : 'fast';
}

// ffmpeg's VAAPI encoders (h264_vaapi) expose a driver-level "-quality"
// (compression_level) knob separate from -qp - on Intel's iHD driver this
// actually trades real encode speed for quality (1=slowest/best, 7=fastest/
// worst); -qp alone barely affects a fixed-function hardware encoder's
// throughput, which is why the fast/balanced/quality tiers above measure
// almost identically for VAAPI without it. Left unset (null) by default -
// on drivers that don't support this attribute (e.g. AMD's Mesa radeonsi)
// ffmpeg logs a warning and ignores it, so this is safe to leave off unless
// the user opts in.
const VAAPI_QUALITY_MIN = 1;
const VAAPI_QUALITY_MAX = 7;

function normalizeVaapiQuality(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(VAAPI_QUALITY_MAX, Math.max(VAAPI_QUALITY_MIN, Math.round(n)));
}

/** Rough KB/s per resolution tier, video only (see resolveEncoderBitrateCaps). */
const RESOLUTION_BITRATE_KBPS = {
  2160: 20000,
  1440: 10000,
  1080: 5000,
  720: 2800,
  480: 1500,
  360: 800,
};

function lookupResolutionTierKbps(height) {
  const tiers = Object.keys(RESOLUTION_BITRATE_KBPS).map(Number).sort((a, b) => b - a);
  if (!height) return RESOLUTION_BITRATE_KBPS[tiers[0]];
  for (const tier of tiers) {
    if (height >= tier) return RESOLUTION_BITRATE_KBPS[tier];
  }
  return RESOLUTION_BITRATE_KBPS[tiers[tiers.length - 1]];
}

// The old flat cap this replaced, kept as a floor so this can only ever
// raise the ceiling relative to before, never lower it.
const LEGACY_FLAT_MAXRATE_KBPS = 12000;

/**
 * `-maxrate`/`-bufsize` for the qsv/nvenc/amf encoders, scaled to the
 * requested quality via RESOLUTION_BITRATE_KBPS. Bandwidth ceiling only —
 * NOT tuning-tier dependent; picture quality at a given bitrate is
 * controlled by CRF/QP/global_quality/cq below instead.
 */
function resolveEncoderBitrateCaps(targetHeight) {
  const avgKbps = lookupResolutionTierKbps(targetHeight);
  const maxrateKbps = Math.max(Math.round(avgKbps * 1.5), LEGACY_FLAT_MAXRATE_KBPS);
  const bufsizeKbps = maxrateKbps * 2;
  return { maxrate: `${maxrateKbps}k`, bufsize: `${bufsizeKbps}k` };
}

/**
 * Per-backend, per-tuning-tier encode parameters. 'fast' matches this
 * module's pre-tuning-tier defaults exactly (see git history of
 * ytstream.js's old inline buildVideoEncoderArgs) so a config with no
 * explicit `tuning` set behaves identically to before this was added.
 */
const TUNING_TIERS = {
  none: {
    fast: { preset: 'veryfast', crf: 23 },
    balanced: { preset: 'faster', crf: 21 },
    quality: { preset: 'medium', crf: 19 },
  },
  qsv: {
    // needsFastPresetMinHeight: null source height (uncapped "best") or any
    // height >= this value forces -preset veryfast, matching the original
    // "only worth the speed/quality tradeoff at 1440p+" reasoning.
    fast: { globalQuality: 21, lookAhead: false, needsFastPresetMinHeight: 1440 },
    balanced: { globalQuality: 19, lookAhead: false, needsFastPresetMinHeight: 2160 },
    quality: { globalQuality: 17, lookAhead: true, needsFastPresetMinHeight: null },
  },
  nvenc: {
    fast: { preset: 'p5', cq: 21 },
    balanced: { preset: 'p6', cq: 19 },
    quality: { preset: 'p7', cq: 17 },
  },
  // compressionLevel is h264_vaapi's own -quality (compression_level, 1-7) -
  // a separate driver-level speed/quality knob from qp (see
  // normalizeVaapiQuality's comment: qp alone barely affects a fixed-
  // function hardware encoder's throughput, which is why fast/balanced/
  // quality otherwise measure almost identically for VAAPI). Baked into the
  // tier itself so picking a tuning tier is enough on its own - Settings'
  // VAAPI compression level field is an optional manual override on top of
  // this, not a second control most users ever need to touch.
  vaapi: {
    fast: { qp: 21, compressionLevel: 7 },
    balanced: { qp: 18, compressionLevel: 4 },
    quality: { qp: 15, compressionLevel: 1 },
  },
  amf: {
    fast: { quality: 'speed', qvbr: 21 },
    balanced: { quality: 'balanced', qvbr: 19 },
    quality: { quality: 'quality', qvbr: 17 },
  },
};

function tuningParams(hardwareMode, tuning) {
  const byMode = TUNING_TIERS[hardwareMode] || TUNING_TIERS.none;
  return byMode[tuning] || byMode.fast;
}

/**
 * Build video encoder args for transcode=h264, matching the reference
 * jellyfin-youtube-plugin's ManagedTranscodeService.AddVideoEncoderArguments,
 * now parameterized by tuning tier (see TUNING_TIERS above).
 * @param {string} hardwareMode
 * @param {number|null} [targetHeight] - caps the encode at this height
 *   (matching yt-dlp's own `height<=X` source selection elsewhere - see
 *   resolveQualityHeight in ytstream.js), decrease-only so a source already
 *   smaller than this is never upscaled. null ("best", or an unresolvable
 *   value) skips scaling entirely - the source's own resolution passes
 *   through untouched.
 * @param {string} [tuning] - 'fast' (default) | 'balanced' | 'quality'
 * @param {number|string|null} [vaapiQuality] - VAAPI-only manual override
 *   for -quality (compression_level), 1-7; ignored for every other
 *   hardwareMode. Optional - each tuning tier already bakes in its own
 *   sensible compressionLevel (see TUNING_TIERS.vaapi), so most callers can
 *   omit this and get a sane value just from the tuning tier alone. This
 *   only matters when a caller explicitly wants to override that default.
 * @returns {{preInputArgs: string[], videoFilters: string[], pixFmt: string|null, encoderArgs: string[]}}
 */
function buildVideoEncoderArgs(hardwareMode, targetHeight, tuning, vaapiQuality) {
  const mode = normalizeHardwareMode(hardwareMode);
  const tier = normalizeTuning(tuning);
  const params = tuningParams(mode, tier);
  const heightCap = Number.isFinite(targetHeight) && targetHeight > 0 ? targetHeight : null;
  const { maxrate, bufsize } = resolveEncoderBitrateCaps(heightCap);

  // Common GOP / threshold settings from the plugin
  const common = ['-g', '120', '-keyint_min', '120', '-sc_threshold', '0'];

  if (mode === 'vaapi') {
    // VAAPI replaces the software scale filter with nv12+hwupload
    const scaleFilter = heightCap
      ? `scale=-2:'min(${heightCap},ih)':force_original_aspect_ratio=decrease,format=nv12,hwupload`
      : 'format=nv12,hwupload';
    // An explicit override wins; otherwise fall back to the tuning tier's
    // own compressionLevel default (see TUNING_TIERS.vaapi) rather than
    // omitting -quality entirely.
    const compressionLevel = normalizeVaapiQuality(vaapiQuality) ?? params.compressionLevel;
    return {
      preInputArgs: ['-vaapi_device', '/dev/dri/renderD128'],
      videoFilters: [scaleFilter],
      pixFmt: null,
      encoderArgs: [
        '-c:v', 'h264_vaapi', '-qp', String(params.qp),
        ...(compressionLevel != null ? ['-quality', String(compressionLevel)] : []),
        ...common,
      ],
    };
  }
  if (mode === 'qsv') {
    const scaleFilter = heightCap
      ? `scale_qsv=h='min(${heightCap},ih)':w='trunc(iw*min(${heightCap},ih)/ih/2)*2':format=nv12`
      : 'scale_qsv=w=iw:h=ih:format=nv12';
    // preset: no default was set before, leaving ffmpeg/the driver to pick
    // its own (a slower, higher-quality target usage). 'veryfast' trades
    // some compression efficiency for encode speed - only worth that
    // tradeoff where real-time encoding genuinely struggles (see
    // needsFastPresetMinHeight per tier above). At lower resolutions/higher
    // tiers, real-time was never the problem, so the driver's own (higher-
    // quality) default preset is left alone.
    const minHeight = params.needsFastPresetMinHeight;
    const needsFastPreset = minHeight != null && (!heightCap || heightCap >= minHeight);
    const presetArgs = needsFastPreset ? ['-preset', 'veryfast'] : [];
    return {
      preInputArgs: ['-init_hw_device', 'vaapi=va:/dev/dri/renderD128', '-init_hw_device', 'qsv=qsv@va', '-filter_hw_device', 'qsv'],
      videoFilters: ['hwupload=extra_hw_frames=64', 'format=qsv', scaleFilter],
      pixFmt: '',
      encoderArgs: [
        '-c:v', 'h264_qsv', ...presetArgs,
        '-global_quality', String(params.globalQuality),
        '-look_ahead', params.lookAhead ? '1' : '0',
        '-maxrate', maxrate, '-bufsize', bufsize,
        ...common,
      ],
    };
  }
  if (mode === 'nvenc') {
    const scaleFilter = heightCap
      ? `scale=-2:'min(${heightCap},ih)':force_original_aspect_ratio=decrease,format=yuv420p`
      : 'format=yuv420p';
    return {
      preInputArgs: [],
      videoFilters: [scaleFilter],
      pixFmt: 'yuv420p',
      encoderArgs: [
        '-c:v', 'h264_nvenc', '-preset', params.preset, '-cq', String(params.cq), '-rc', 'vbr',
        '-maxrate', maxrate, '-bufsize', bufsize,
        ...common,
      ],
    };
  }
  if (mode === 'amf') {
    const scaleFilter = heightCap
      ? `scale=-2:'min(${heightCap},ih)':force_original_aspect_ratio=decrease,format=yuv420p`
      : 'format=yuv420p';
    return {
      preInputArgs: [],
      videoFilters: [scaleFilter],
      pixFmt: 'yuv420p',
      encoderArgs: [
        '-c:v', 'h264_amf', '-quality', params.quality, '-rc', 'qvbr',
        '-qvbr_quality_level', String(params.qvbr),
        ...common,
      ],
    };
  }
  // Software (None) — libx264
  const scaleFilter = heightCap
    ? `scale=-2:'min(${heightCap},ih)':force_original_aspect_ratio=decrease,format=yuv420p`
    : 'format=yuv420p';
  return {
    preInputArgs: [],
    videoFilters: [scaleFilter],
    pixFmt: 'yuv420p',
    encoderArgs: ['-c:v', 'libx264', '-preset', params.preset, '-crf', String(params.crf), ...common],
  };
}

module.exports = {
  VALID_HARDWARE,
  VALID_TUNING,
  TUNING_LABELS,
  VAAPI_QUALITY_MIN,
  VAAPI_QUALITY_MAX,
  normalizeHardwareMode,
  normalizeTuning,
  normalizeVaapiQuality,
  RESOLUTION_BITRATE_KBPS,
  lookupResolutionTierKbps,
  resolveEncoderBitrateCaps,
  buildVideoEncoderArgs,
};
