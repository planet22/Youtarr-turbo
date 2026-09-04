/**
 * Shared ffmpeg hardware-DECODE arg builder - the counterpart to
 * hardwareEncoderModule.js, which only ever accelerates the encode side.
 * Kept as its own module (not folded into hardwareEncoderModule.js) because
 * decode's axes genuinely differ from encode's:
 *  - hardware list: no 'amf' here - AMD decode acceleration in ffmpeg is a
 *    Windows/D3D11 API; on Linux (this app's actual runtime - see the
 *    /dev/dri device passthrough in docker-compose.yaml), AMD GPU decode
 *    goes through VAAPI instead, so a separate "amf" decode option would
 *    just be a confusing alias for 'vaapi'.
 *  - codec list: this is the SOURCE codec (what YouTube actually served),
 *    not a target codec choice - h264/vp9/av1, never hevc (YouTube doesn't
 *    serve it as a DASH source).
 *  - -hwaccel names don't match the encode backend names 1:1 (nvenc's
 *    decode counterpart is ffmpeg's 'cuda' hwaccel, i.e. NVDEC).
 */

const VALID_DECODE_HARDWARE = ['none', 'qsv', 'nvenc', 'vaapi'];
const VALID_SOURCE_CODECS = ['h264', 'vp9', 'av1'];

function normalizeDecodeHardwareMode(mode) {
  const m = String(mode || 'none').toLowerCase().trim();
  return VALID_DECODE_HARDWARE.includes(m) ? m : 'none';
}

function normalizeSourceCodec(codec) {
  const c = String(codec || 'h264').toLowerCase().trim();
  return VALID_SOURCE_CODECS.includes(c) ? c : 'h264';
}

// ffmpeg's -hwaccel value per decode backend - deliberately not the same
// strings as VALID_HARDWARE's encode backend names (see module doc comment).
const DECODE_HWACCEL_NAME = { qsv: 'qsv', nvenc: 'cuda', vaapi: 'vaapi' };

/**
 * @param {string} decodeMode - 'none'|'qsv'|'nvenc'|'vaapi'
 * @returns {{preInputArgs: string[]}} args to place before the real input's
 *   `-i` (unlike hardwareEncoderModule's preInputArgs, decode's must be
 *   scoped to just the one input actually being decoded - never applied to
 *   every input in a multi-input ffmpeg invocation).
 */
function buildDecodeArgs(decodeMode) {
  const mode = normalizeDecodeHardwareMode(decodeMode);
  if (mode === 'none') return { preInputArgs: [] };
  if (mode === 'vaapi') {
    return { preInputArgs: ['-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD128'] };
  }
  // qsv/nvenc(cuda) auto-select their device; no explicit -hwaccel_device
  // needed the way vaapi's does (matches ffmpeg's own documented defaults).
  return { preInputArgs: ['-hwaccel', DECODE_HWACCEL_NAME[mode]] };
}

// Encoder name used to SOFTWARE-produce a tiny real sample in the given
// source codec - purely a test-input generator, never used for real
// encoding. libvpx-vp9/libsvtav1 are ffmpeg's standard software VP9/AV1
// encoders, already relied on elsewhere in this app for AV1 downloads (see
// hardwareEncoderModule.js's ENCODER_NAME.av1.software).
const SAMPLE_SOURCE_ENCODER = { h264: 'libx264', vp9: 'libvpx-vp9', av1: 'libsvtav1' };

/**
 * Builds full ffmpeg args to synthesize a tiny real (not synthetic-frame)
 * compressed sample in the given source codec, entirely from a generated
 * lavfi test pattern - no bundled video asset needed, matching this
 * codebase's existing testing philosophy (hardwareCapabilityTester.js,
 * streamTuningBenchmark.js). The caller supplies the output path; this is a
 * one-time SOFTWARE encode, cheap even at a few seconds duration, whose only
 * purpose is producing something real for a hardware DECODER to be tested
 * against - decoding raw lavfi frames would prove nothing about real decode
 * capability.
 * @param {string} sourceCodec - 'h264'|'vp9'|'av1'
 * @param {{width?: number, height?: number, durationSeconds?: number}} [opts]
 * @param {string} outputPath
 * @returns {string[]} full ffmpeg args (caller supplies '-y' already if wanted)
 */
function buildSampleGeneratorArgs(sourceCodec, { width = 1920, height = 1080, durationSeconds = 1 } = {}, outputPath) {
  const codec = normalizeSourceCodec(sourceCodec);
  const encoderName = SAMPLE_SOURCE_ENCODER[codec];
  const encoderArgs = codec === 'h264'
    ? ['-c:v', encoderName, '-preset', 'veryfast', '-crf', '28']
    // -deadline realtime (not just -cpu-used 8 alone) is libvpx-vp9's actual
    // fastest mode - cpu-used only trades further speed within whichever
    // deadline is picked, and the default deadline ("good") is much slower.
    // This is a throwaway test input, not a real encode - speed beats
    // efficiency here every time.
    : codec === 'vp9'
      ? ['-c:v', encoderName, '-crf', '32', '-b:v', '0', '-deadline', 'realtime', '-cpu-used', '8']
      : ['-c:v', encoderName, '-preset', '10', '-crf', '35']; // libsvtav1: numeric preset, 0=slowest..13=fastest
  return [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=30:duration=${durationSeconds}`,
    ...encoderArgs,
    '-pix_fmt', 'yuv420p',
    outputPath,
  ];
}

module.exports = {
  VALID_DECODE_HARDWARE,
  VALID_SOURCE_CODECS,
  DECODE_HWACCEL_NAME,
  normalizeDecodeHardwareMode,
  normalizeSourceCodec,
  buildDecodeArgs,
  buildSampleGeneratorArgs,
};
