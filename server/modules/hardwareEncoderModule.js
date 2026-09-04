/**
 * Shared ffmpeg hardware-encoder arg builder. Originally lived only in
 * server/routes/ytstream.js (live STRM/HLS transcode); extracted so
 * videoDownloadPostProcessFiles.js can reuse the exact same encoder
 * selection/tuning for the optional post-download transcode (see
 * transcodeDownloadedVideo there) instead of duplicating it.
 */

const VALID_HARDWARE = ['none', 'qsv', 'nvenc', 'vaapi', 'amf'];
const VALID_VIDEO_CODECS = ['h264', 'hevc', 'av1'];
const VALID_AUDIO_CODECS = ['copy', 'aac', 'opus'];

function normalizeHardwareMode(mode) {
  const m = String(mode || 'none').toLowerCase().trim();
  return VALID_HARDWARE.includes(m) ? m : 'none';
}

function normalizeVideoCodec(codec) {
  const c = String(codec || 'h264').toLowerCase().trim();
  return VALID_VIDEO_CODECS.includes(c) ? c : 'h264';
}

function normalizeAudioCodec(codec) {
  const c = String(codec || 'copy').toLowerCase().trim();
  return VALID_AUDIO_CODECS.includes(c) ? c : 'copy';
}

// Per-hardware-backend encoder name for each codec. AV1 hardware encode is
// only present on recent generations (NVENC: RTX 40-series/Ada+; QSV: Arc /
// Meteor Lake+; VAAPI: mostly Intel Arc or AMD RDNA3 via Mesa; AMF: RDNA3+)
// - older hardware will simply fail to open these encoders, which is exactly
// why every hardware attempt in transcodeDownloadedVideo falls back to the
// matching software encoder below on failure rather than assuming success.
const ENCODER_NAME = {
  h264: { qsv: 'h264_qsv', nvenc: 'h264_nvenc', vaapi: 'h264_vaapi', amf: 'h264_amf', software: 'libx264' },
  hevc: { qsv: 'hevc_qsv', nvenc: 'hevc_nvenc', vaapi: 'hevc_vaapi', amf: 'hevc_amf', software: 'libx265' },
  av1: { qsv: 'av1_qsv', nvenc: 'av1_nvenc', vaapi: 'av1_vaapi', amf: 'av1_amf', software: 'libsvtav1' },
};

// Rough max-bitrate ceiling (kbps) per resolution tier, used for the
// hardware rate-controlled encoders (qsv/nvenc) when maxWidth isn't capped
// (library downloads) - keeps -maxrate proportional to the actual source
// instead of the streaming path's fixed 12M, which would starve a 4K encode
// and be wasteful for a 480p one. Streaming callers always pass an explicit
// maxWidth (1920) and get the original fixed 12M/24M unchanged.
const MAXRATE_KBPS_BY_HEIGHT = { 2160: 35000, 1440: 16000, 1080: 8000, 720: 5000, 480: 2500, 360: 1200 };
function maxrateKbpsForHeight(height) {
  if (!Number.isFinite(height) || height <= 0) return 12000;
  const tiers = Object.keys(MAXRATE_KBPS_BY_HEIGHT).map(Number).sort((a, b) => a - b);
  for (const t of tiers) {
    if (height <= t) return MAXRATE_KBPS_BY_HEIGHT[t];
  }
  return MAXRATE_KBPS_BY_HEIGHT[2160];
}

// Apple/QuickTime require an explicit mp4 codec tag for HEVC and AV1 -
// ffmpeg's own default tag for HEVC-in-mp4 ("hev1") isn't recognized by
// Apple's decoders, which expect "hvc1"; AV1-in-mp4 needs the "av01" tag
// for the same reason. H.264's default ("avc1") is already what Apple
// expects, so it needs no explicit tag.
const APPLE_CODEC_TAG = { h264: null, hevc: 'hvc1', av1: 'av01' };
function codecTagArgs(codec) {
  const tag = APPLE_CODEC_TAG[codec];
  return tag ? ['-tag:v', tag] : [];
}

// Per-codec software CRF defaults. HEVC/AV1 CRF scales don't line up with
// x264's - these are conventional "similar perceived quality to x264 crf
// 23" equivalents for libx265/libsvtav1.
const SOFTWARE_CRF = { h264: '23', hevc: '26', av1: '30' };
const SOFTWARE_PRESET = { h264: 'veryfast', hevc: 'veryfast', av1: '6' }; // libsvtav1 preset is numeric (0=slowest/best..13=fastest)

/**
 * Build ffmpeg video-encoder args for a given codec + hardware backend,
 * matching (for h264) the Jellyfin YouTube plugin's
 * ManagedTranscodeService.AddVideoEncoderArguments. Shared between
 * ytstream.js (live playback transcode, always maxWidth=1920 for bandwidth)
 * and videoDownloadPostProcessFiles.js (permanent library downloads,
 * maxWidth omitted - never silently downscale a 4K source).
 * @param {string} hardwareMode - 'none'|'qsv'|'nvenc'|'vaapi'|'amf'
 * @param {string} videoCodec - 'h264'|'hevc'|'av1'
 * @param {{maxWidth?: number|null, sourceHeight?: number|null}} [options]
 *   maxWidth: cap the encoded width (streaming). Omit/null for downloads.
 *   sourceHeight: actual probed source height, used to scale the hardware
 *     rate-control ceiling proportionally when maxWidth isn't set.
 * @returns {{preInputArgs: string[], videoFilters: string[], pixFmt: string|null, encoderArgs: string[]}}
 */
function buildVideoEncoderArgs(hardwareMode, videoCodec = 'h264', options = {}) {
  const mode = normalizeHardwareMode(hardwareMode);
  const codec = normalizeVideoCodec(videoCodec);
  const { maxWidth = null, sourceHeight = null } = options;
  const cap = Number.isFinite(maxWidth) && maxWidth > 0 ? maxWidth : null;
  const common = ['-g', '120', '-keyint_min', '120', '-sc_threshold', '0'];
  const maxrateKbps = cap ? 12000 : maxrateKbpsForHeight(sourceHeight);
  const bufsizeKbps = maxrateKbps * 2;
  const encoderName = ENCODER_NAME[codec][mode] || ENCODER_NAME[codec].software;

  if (mode === 'vaapi') {
    const scaleFilter = cap
      ? `scale='min(${cap},iw)':-2:force_original_aspect_ratio=decrease,format=nv12,hwupload`
      : 'format=nv12,hwupload';
    return {
      preInputArgs: ['-vaapi_device', '/dev/dri/renderD128'],
      videoFilters: [scaleFilter],
      pixFmt: null,
      encoderArgs: ['-c:v', encoderName, '-qp', '21', ...common, ...codecTagArgs(codec)],
    };
  }
  if (mode === 'qsv') {
    const scaleQsv = cap
      ? `scale_qsv=w='min(${cap},iw)':h='trunc(ih*min(${cap},iw)/iw/2)*2':format=nv12`
      : 'scale_qsv=format=nv12';
    return {
      preInputArgs: ['-init_hw_device', 'vaapi=va:/dev/dri/renderD128', '-init_hw_device', 'qsv=qsv@va', '-filter_hw_device', 'qsv'],
      videoFilters: ['hwupload=extra_hw_frames=64', 'format=qsv', scaleQsv],
      pixFmt: '',
      encoderArgs: ['-c:v', encoderName, '-global_quality', '21', '-look_ahead', '0', '-maxrate', `${maxrateKbps}k`, '-bufsize', `${bufsizeKbps}k`, ...common, ...codecTagArgs(codec)],
    };
  }
  if (mode === 'nvenc') {
    const scaleFilter = cap
      ? `scale='min(${cap},iw)':-2:force_original_aspect_ratio=decrease,format=yuv420p`
      : 'format=yuv420p';
    return {
      preInputArgs: [],
      videoFilters: [scaleFilter],
      pixFmt: 'yuv420p',
      encoderArgs: ['-c:v', encoderName, '-preset', 'p5', '-cq', '21', '-rc', 'vbr', '-maxrate', `${maxrateKbps}k`, '-bufsize', `${bufsizeKbps}k`, ...common, ...codecTagArgs(codec)],
    };
  }
  if (mode === 'amf') {
    const scaleFilter = cap
      ? `scale='min(${cap},iw)':-2:force_original_aspect_ratio=decrease,format=yuv420p`
      : 'format=yuv420p';
    return {
      preInputArgs: [],
      videoFilters: [scaleFilter],
      pixFmt: 'yuv420p',
      encoderArgs: ['-c:v', encoderName, '-quality', 'quality', '-rc', 'qvbr', '-qvbr_quality_level', '21', ...common, ...codecTagArgs(codec)],
    };
  }

  // Software (none) - libx264/libx265/libsvtav1
  const scaleFilter = cap
    ? `scale='min(${cap},iw)':-2:force_original_aspect_ratio=decrease,format=yuv420p`
    : 'format=yuv420p';
  const softwareEncoderArgs = codec === 'av1'
    ? ['-c:v', ENCODER_NAME.av1.software, '-preset', SOFTWARE_PRESET.av1, '-crf', SOFTWARE_CRF.av1, ...codecTagArgs(codec)]
    : ['-c:v', ENCODER_NAME[codec].software, '-preset', SOFTWARE_PRESET[codec], '-crf', SOFTWARE_CRF[codec], ...common, ...codecTagArgs(codec)];
  return {
    preInputArgs: [],
    videoFilters: [scaleFilter],
    pixFmt: 'yuv420p',
    encoderArgs: softwareEncoderArgs,
  };
}

/**
 * The always-available software fallback for a codec, ignoring hardwareMode
 * entirely - used when a hardware encoder attempt fails to open (wrong
 * generation of GPU, missing driver, etc.) per the documented "retry with
 * software" behavior for both ytstream.js sessions and download transcodes.
 */
function buildSoftwareVideoEncoderArgs(videoCodec, options = {}) {
  return buildVideoEncoderArgs('none', videoCodec, options);
}

/**
 * Build the audio leg of the ffmpeg command for a chosen audio codec.
 * 'copy' passes the source audio through untouched (still requires the
 * video to be re-encoded, but avoids a needless audio re-encode).
 * @param {string} audioCodec - 'copy'|'aac'|'opus'
 * @returns {string[]} ffmpeg args, e.g. ['-c:a', 'aac', '-b:a', '192k']
 */
function buildAudioEncoderArgs(audioCodec) {
  const codec = normalizeAudioCodec(audioCodec);
  if (codec === 'copy') return ['-c:a', 'copy'];
  if (codec === 'opus') return ['-c:a', 'libopus', '-b:a', '160k', '-ar', '48000'];
  return ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000'];
}

module.exports = {
  VALID_HARDWARE,
  VALID_VIDEO_CODECS,
  VALID_AUDIO_CODECS,
  // Exported so other encoder-arg builders needing the same codec/backend ->
  // ffmpeg encoder name mapping (see streamEncoderTuning.js's own
  // buildVideoEncoderArgs) share this one canonical table instead of
  // duplicating it and risking drift.
  ENCODER_NAME,
  normalizeHardwareMode,
  normalizeVideoCodec,
  normalizeAudioCodec,
  buildVideoEncoderArgs,
  buildSoftwareVideoEncoderArgs,
  buildAudioEncoderArgs,
};
