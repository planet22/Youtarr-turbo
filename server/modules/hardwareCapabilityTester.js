const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const configModule = require('./configModule');
const hardwareEncoderModule = require('./hardwareEncoderModule');
const hardwareDecodeModule = require('./hardwareDecodeModule');
const logger = require('../logger');

// Real encoder failures (missing device, unsupported codec on this GPU
// generation, driver not installed) surface almost immediately - this is
// just a backstop against a genuinely wedged process, not the expected path.
const TEST_TIMEOUT_MS = 8000;

// libsvtav1 prints this once per encoding thread, straight to stderr,
// bypassing ffmpeg's -loglevel entirely (a known libsvtav1 quirk, not an
// ffmpeg logging bug) - harmless in Docker (no CAP_SYS_NICE), but at 4K it
// spawns enough threads that a wall of these lines can fill an entire
// tail-truncated error buffer and hide whatever the real failure was.
const SVT_THREAD_PRIORITY_WARNING = /^Svt\[warn\]: Failed to set thread priority$/;

/**
 * Trims noisy-but-harmless SVT-AV1 warning spam out of a captured stderr
 * buffer before truncating to the last `maxLength` chars, so a real error
 * that would otherwise be crowded out by repeated warnings still surfaces.
 * @param {string} stderr
 * @param {number} [maxLength]
 * @returns {string}
 */
function summarizeStderr(stderr, maxLength = 800) {
  const lines = stderr.split('\n');
  const meaningful = lines.filter((line) => !SVT_THREAD_PRIORITY_WARNING.test(line.trim()));
  const suppressed = lines.length - meaningful.length;
  let summary = meaningful.join('\n').trim();
  if (suppressed > 0) {
    summary += `${summary ? ' ' : ''}(suppressed ${suppressed} benign "Svt[warn]: Failed to set thread priority" line${suppressed === 1 ? '' : 's'})`;
  }
  return summary.slice(-maxLength);
}

/**
 * A process killed by a signal (SIGKILL especially) often never gets the
 * chance to print an actual error line - stderr just stops mid-output
 * (e.g. mid-way through libsvtav1's own startup config dump), which reads
 * exactly like a harmless log if summarizeStderr's result is shown alone.
 * Prepending this note is what actually surfaces "this wasn't a normal
 * ffmpeg failure" - a 4K+ software AV1 encode's memory footprint is the
 * most common real-world trigger for a SIGKILL here (the Linux/cgroup OOM
 * killer), so that gets called out explicitly rather than left as a guess
 * the reader has to make themselves.
 * @param {NodeJS.Signals|null} signal
 * @returns {string} empty string when there's no signal to report
 */
function describeExitSignal(signal) {
  if (!signal) return '';
  const likelyOom = signal === 'SIGKILL' ? ' (likely killed by the OOM killer - out of memory)' : '';
  return `Process was killed by signal ${signal}${likelyOom}. `;
}

// generateDecodeSample's own timeout, deliberately separate from
// TEST_TIMEOUT_MS above: unlike the ~1s capability-check encodes, the
// tuning benchmark (streamTuningBenchmark.js) asks for a sample matching
// its real BENCHMARK_DURATION_SECONDS/resolution (up to 4K, several
// seconds) - a genuinely heavy one-time software VP9/AV1 encode that can
// legitimately take much longer than 8s on modest hardware. Bug history:
// this used to share TEST_TIMEOUT_MS and reliably timed out generating a
// 4K/4s VP9 sample (~8.25s observed, right at the 8s cutoff).
const SAMPLE_GENERATION_TIMEOUT_MS = 120000;

/**
 * Runs one ffmpeg invocation to completion (or timeout/spawn failure) and
 * resolves a uniform {ok, error?} result - shared by both the encoder and
 * decoder combo testers below, since both are "spawn ffmpeg with these args,
 * see if it exits 0" checks that only differ in how the args are built.
 * @param {string[]} ffArgs
 * @param {object} logContext - attached to the timeout-kill warning log only
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
function runCapabilityCheck(ffArgs, logContext) {
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
        logger.warn({ err, ...logContext }, 'Failed to kill hardware capability test process on timeout');
      }
      finish({ ok: false, error: `Timed out after ${TEST_TIMEOUT_MS / 1000}s (likely hung)` });
    }, TEST_TIMEOUT_MS);

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code, signal) => {
      if (code === 0) {
        finish({ ok: true });
      } else {
        finish({ ok: false, error: `${describeExitSignal(signal)}${summarizeStderr(stderr) || `ffmpeg exited with status ${code}`}` });
      }
    });

    proc.on('error', (err) => {
      finish({ ok: false, error: err.message || 'Failed to start ffmpeg' });
    });
  });
}

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

  return runCapabilityCheck(ffArgs, { hardwareMode, videoCodec });
}

// Real file extension per source codec - ffmpeg picks its muxer from this,
// and some decoders (notably libvpx-vp9) are pickier about being handed a
// properly-muxed container than others.
const SAMPLE_EXTENSION = { h264: 'mp4', vp9: 'webm', av1: 'mkv' };

/**
 * Software-encodes a tiny (1s, 1280x720) real sample in the given source
 * codec to a temp file, purely so a hardware DECODER has something genuine
 * to be tested against - decoding raw lavfi frames would prove nothing.
 * Caller is responsible for deleting the returned path when done (see
 * testAllCapabilities' finally block).
 * @param {string} sourceCodec - 'h264'|'vp9'|'av1'
 * @param {{width?: number, height?: number, durationSeconds?: number}} [opts]
 *   Defaults (1280x720, 1s) suit a quick "does this even work" capability
 *   check; streamTuningBenchmark.js overrides these to generate a longer,
 *   resolution-matched sample it can reuse across a whole timed run.
 * @returns {Promise<string>} absolute path to the generated sample
 */
function generateDecodeSample(sourceCodec, { width = 1280, height = 720, durationSeconds = 1 } = {}) {
  const codec = hardwareDecodeModule.normalizeSourceCodec(sourceCodec);
  const samplePath = path.join(
    os.tmpdir(),
    `youtarr-decode-sample-${codec}-${crypto.randomBytes(6).toString('hex')}.${SAMPLE_EXTENSION[codec]}`
  );
  const args = hardwareDecodeModule.buildSampleGeneratorArgs(codec, { width, height, durationSeconds }, samplePath);
  logger.debug({ codec, width, height, durationSeconds, samplePath }, 'Generating a real decode-test sample (one-time software encode)');

  return new Promise((resolve, reject) => {
    const proc = spawn(configModule.ffmpegPath, args, { shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      fn();
    };

    const timeoutId = setTimeout(() => {
      try { proc.kill(); } catch (err) { logger.warn({ err, codec }, 'Failed to kill decode-sample generator on timeout'); }
      finish(() => reject(new Error(`Timed out after ${SAMPLE_GENERATION_TIMEOUT_MS / 1000}s generating a ${codec} decode-test sample`)));
    }, SAMPLE_GENERATION_TIMEOUT_MS);

    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('close', (code, signal) => {
      if (code === 0 && fs.existsSync(samplePath)) {
        finish(() => resolve(samplePath));
      } else {
        finish(() => reject(new Error(`${describeExitSignal(signal)}${summarizeStderr(stderr) || `Failed to generate ${codec} decode-test sample (exit ${code})`}`)));
      }
    });

    proc.on('error', (err) => {
      finish(() => reject(err));
    });
  });
}

/**
 * Actually attempts to hardware-decode a real compressed sample (see
 * generateDecodeSample) via the given decode backend - same "real test, not
 * just a syntax check" philosophy as testEncoderCombo.
 * @param {string} decodeMode - 'none'|'qsv'|'nvenc'|'vaapi'
 * @param {string} sourceCodec - 'h264'|'vp9'|'av1', for logging only
 * @param {string} sampleFilePath - from generateDecodeSample
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
function testDecoderCombo(decodeMode, sourceCodec, sampleFilePath) {
  const decode = hardwareDecodeModule.buildDecodeArgs(decodeMode);
  const ffArgs = [
    '-y', '-loglevel', 'error',
    ...decode.preInputArgs,
    '-i', sampleFilePath,
    '-f', 'null', '-',
  ];
  return runCapabilityCheck(ffArgs, { decodeMode, sourceCodec });
}

/**
 * Tests every hardware backend (including software/'none', to also confirm
 * this ffmpeg build actually has libx265/libsvtav1 compiled in) against
 * every video codec and returns a full support matrix. Run sequentially,
 * not in parallel - concurrent encode attempts against the same physical
 * GPU device can spuriously fail with "device busy"-type errors that don't
 * reflect real single-encode capability.
 *
 * Also builds the equivalent DECODE matrix (hardwareDecodeModule.
 * VALID_DECODE_HARDWARE x VALID_SOURCE_CODECS) - a genuinely separate axis
 * from encode (different hardware list, different codec meaning - source,
 * not target - see hardwareDecodeModule's doc comment), generating one real
 * compressed sample per source codec (reused across every decode backend for
 * that codec) and cleaning each sample up once its row of tests is done.
 * @returns {Promise<{matrix: object, decodeMatrix: object}>}
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

  const decodeMatrix = {};
  for (const decodeMode of hardwareDecodeModule.VALID_DECODE_HARDWARE) {
    decodeMatrix[decodeMode] = {};
  }
  for (const sourceCodec of hardwareDecodeModule.VALID_SOURCE_CODECS) {
    let samplePath = null;
    try {
      // eslint-disable-next-line no-await-in-loop -- deliberately sequential, see doc comment
      samplePath = await generateDecodeSample(sourceCodec);
      for (const decodeMode of hardwareDecodeModule.VALID_DECODE_HARDWARE) {
        // eslint-disable-next-line no-await-in-loop -- deliberately sequential, see doc comment
        decodeMatrix[decodeMode][sourceCodec] = await testDecoderCombo(decodeMode, sourceCodec, samplePath);
      }
    } catch (err) {
      // Sample generation itself failed (e.g. libvpx-vp9/libsvtav1 not
      // compiled into this ffmpeg build) - every decode backend for this
      // source codec is untestable, not merely unsupported; say so rather
      // than silently reporting them all as working or omitting the row.
      for (const decodeMode of hardwareDecodeModule.VALID_DECODE_HARDWARE) {
        decodeMatrix[decodeMode][sourceCodec] = { ok: false, error: `Could not generate a ${sourceCodec} test sample: ${err.message}` };
      }
    } finally {
      if (samplePath) {
        fs.promises.unlink(samplePath).catch(() => { /* best-effort cleanup */ });
      }
    }
  }

  return { matrix, decodeMatrix };
}

module.exports = { testEncoderCombo, testDecoderCombo, generateDecodeSample, testAllCapabilities, summarizeStderr, describeExitSignal };
