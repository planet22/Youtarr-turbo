const { spawn } = require('child_process');
const configModule = require('./configModule');
const hardwareEncoderModule = require('./hardwareEncoderModule');
const logger = require('../logger');

// Real encoder failures (missing device, unsupported codec on this GPU
// generation, driver not installed) surface almost immediately - this is
// just a backstop against a genuinely wedged process, not the expected path.
const TEST_TIMEOUT_MS = 8000;

/**
 * Actually attempts to open and run the given hardware/codec combination
 * against a tiny synthetic input (1 second of ffmpeg's built-in "testsrc"
 * pattern, no real video file needed, output discarded via -f null) - this
 * is a real encode, not an argument/syntax check, so it genuinely proves
 * whether this host's GPU generation, drivers, and ffmpeg build can produce
 * that codec via that backend, the same way the actual download-time
 * transcode will invoke it (see hardwareEncoderModule.buildVideoEncoderArgs).
 * @param {string} hardwareMode - 'none'|'qsv'|'nvenc'|'vaapi'|'amf'
 * @param {string} videoCodec - 'h264'|'hevc'|'av1'
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
function testEncoderCombo(hardwareMode, videoCodec) {
  const encoder = hardwareEncoderModule.buildVideoEncoderArgs(hardwareMode, videoCodec, {});
  const ffArgs = [
    '-y', '-loglevel', 'error',
    ...encoder.preInputArgs,
    '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=5',
  ];
  if (encoder.videoFilters && encoder.videoFilters.length) {
    ffArgs.push('-vf', encoder.videoFilters.join(','));
  }
  if (encoder.pixFmt) {
    ffArgs.push('-pix_fmt', encoder.pixFmt);
  }
  ffArgs.push(...encoder.encoderArgs);
  ffArgs.push('-an', '-f', 'null', '-');

  return new Promise((resolve) => {
    let stderr = '';
    let resolved = false;

    const proc = spawn(configModule.ffmpegPath, ffArgs, {
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      resolve(result);
    };

    const timeoutId = setTimeout(() => {
      try {
        proc.kill();
      } catch (err) {
        logger.warn({ err, hardwareMode, videoCodec }, 'Failed to kill hardware capability test process on timeout');
      }
      finish({ ok: false, error: `Timed out after ${TEST_TIMEOUT_MS / 1000}s (encoder likely hung)` });
    }, TEST_TIMEOUT_MS);

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        finish({ ok: true });
      } else {
        finish({ ok: false, error: stderr.trim().slice(-800) || `ffmpeg exited with status ${code}` });
      }
    });

    proc.on('error', (err) => {
      finish({ ok: false, error: err.message || 'Failed to start ffmpeg' });
    });
  });
}

/**
 * Tests every hardware backend (including software/'none', to also confirm
 * this ffmpeg build actually has libx265/libsvtav1 compiled in) against
 * every video codec and returns a full support matrix. Run sequentially,
 * not in parallel - concurrent encode attempts against the same physical
 * GPU device can spuriously fail with "device busy"-type errors that don't
 * reflect real single-encode capability.
 * @returns {Promise<{[hardwareMode: string]: {[videoCodec: string]: {ok: boolean, error?: string}}}>}
 */
async function testAllCapabilities() {
  const matrix = {};
  for (const hardwareMode of hardwareEncoderModule.VALID_HARDWARE) {
    matrix[hardwareMode] = {};
    for (const videoCodec of hardwareEncoderModule.VALID_VIDEO_CODECS) {
      // eslint-disable-next-line no-await-in-loop -- deliberately sequential, see doc comment
      matrix[hardwareMode][videoCodec] = await testEncoderCombo(hardwareMode, videoCodec);
    }
  }
  return matrix;
}

module.exports = { testEncoderCombo, testAllCapabilities };
