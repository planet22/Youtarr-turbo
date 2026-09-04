/**
 * server/modules/streamTuningBenchmark.js
 *
 * "Test real-time tuning" — for every hardwareMode (including software/
 * 'none') x tuning tier (fast/balanced/quality) x resolution, runs a real,
 * timed ffmpeg encode of a few seconds of synthetic input through the exact
 * same buildVideoEncoderArgs() call ytstream.js's live playback path uses
 * (see streamEncoderTuning.js), and measures whether it ran fast enough to
 * be safe for a real-time HLS/live-pipe stream at that resolution.
 *
 * This is deliberately a different question from hardwareCapabilityTester's
 * "does this codec+backend combo work at all" — a combo can succeed there
 * and still be too slow to sustain real-time at a higher
 * resolution/quality-tier, which is exactly what this surfaces.
 */

const { spawn } = require('child_process');
const configModule = require('./configModule');
const streamEncoderTuning = require('./streamEncoderTuning');
const messageEmitter = require('./messageEmitter');
const logger = require('../logger');

// Encodes this many seconds of synthetic 30fps input per combination. Long
// enough that process-startup/hardware-init overhead doesn't dominate the
// timing (which would make everything look artificially slow), short
// enough that the full matrix (5 hardware modes x 3 tiers x N resolutions)
// finishes in a reasonable time.
const BENCHMARK_DURATION_SECONDS = 4;

// The very first ffmpeg invocation of a run pays one-time costs (VAAPI/QSV/
// NVENC device creation, driver JIT, etc.) that every later invocation
// skips - timed inside the benchmark, that overhead makes the first
// measured combo look artificially slow. So before the real matrix starts,
// throw away one short encode at the first height/tier purely to prime the
// hardware; its result is discarded and never enters `matrix`.
const WARMUP_DURATION_SECONDS = 1;

// A real live stream needs to encode faster than real time with headroom
// to spare (network jitter, other host load, audio muxing) - not just
// barely keep up. 1.3x means "encodes 4s of video in <=3.08s wall clock".
const REALTIME_SAFETY_MARGIN = 1.3;

const BENCHMARK_TIMEOUT_MS = 30000;

function runTimedFfmpegEncode(args) {
  return new Promise((resolve) => {
    let stderr = '';
    let resolved = false;
    const startedAt = Date.now();

    const proc = spawn(configModule.ffmpegPath, args, { shell: false, stdio: ['ignore', 'ignore', 'pipe'] });

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      resolve(result);
    };

    const timeoutId = setTimeout(() => {
      try { proc.kill(); } catch { /* best-effort */ }
      finish({ ok: false, error: `Timed out after ${BENCHMARK_TIMEOUT_MS / 1000}s (encoder likely hung)` });
    }, BENCHMARK_TIMEOUT_MS);

    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      const wallSeconds = (Date.now() - startedAt) / 1000;
      if (code === 0) {
        finish({ ok: true, wallSeconds });
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
 * @param {string} hardwareMode
 * @param {string} tuning
 * @param {number} height - target resolution height (matches the "Stream
 *   quality" dropdown's values, e.g. 480/720/1080/1440/2160).
 * @param {number} [durationSeconds] - overrides BENCHMARK_DURATION_SECONDS;
 *   test-only hook so unit tests can use a tiny synthetic duration instead
 *   of waiting out multi-second real encodes to exercise the realtime/
 *   not-realtime boundary. Production callers always omit this.
 * @param {number|string|null} [vaapiQuality] - passed straight through to
 *   buildVideoEncoderArgs (vaapi-only; ignored for every other
 *   hardwareMode) - the whole point is measuring the exact args a real
 *   stream would use, so this should always be whatever the caller has
 *   actually configured, not a synthetic default.
 * @returns {Promise<{ok: boolean, wallSeconds?: number, realtimeFactor?: number, realtime?: boolean, error?: string}>}
 */
async function benchmarkOne(hardwareMode, tuning, height, durationSeconds = BENCHMARK_DURATION_SECONDS, vaapiQuality = null) {
  const width = Math.round((height * 16) / 9 / 2) * 2;
  const encoder = streamEncoderTuning.buildVideoEncoderArgs(hardwareMode, height, tuning, vaapiQuality);

  const args = ['-y', '-loglevel', 'error'];
  if (encoder.preInputArgs && encoder.preInputArgs.length) {
    args.push(...encoder.preInputArgs);
  }
  args.push(
    '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=30:duration=${durationSeconds}`,
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-t', String(durationSeconds),
  );
  if (encoder.videoFilters && encoder.videoFilters.length) {
    args.push('-vf', encoder.videoFilters.join(','));
  }
  if (encoder.pixFmt) args.push('-pix_fmt', encoder.pixFmt);
  args.push(...encoder.encoderArgs);
  args.push('-c:a', 'aac', '-b:a', '192k', '-an', '-f', 'null', '-');

  const result = await runTimedFfmpegEncode(args);
  if (!result.ok) return result;

  const realtimeFactor = durationSeconds / result.wallSeconds;
  return {
    ok: true,
    wallSeconds: result.wallSeconds,
    realtimeFactor,
    realtime: realtimeFactor >= REALTIME_SAFETY_MARGIN,
  };
}

// Only one benchmark run at a time - concurrent ffmpeg encodes (especially
// against one physical GPU device) can spuriously fail/slow down in a way
// that doesn't reflect real single-stream capability (same reasoning as
// hardwareCapabilityTester.testAllCapabilities' sequential loop), and two
// browser tabs kicking off runs at once would also stomp each other's
// progress broadcasts.
let running = false;

function isBenchmarkRunning() {
  return running;
}

/**
 * One line per resolution, e.g. `480p[fast=8.2x* balanced=5.1x quality=2.9x!]`
 * - `*` marks the recommended tier, `!` marks a tier that measured slower
 * than the real-time safety margin. Built so a single log line lets you
 * compare every resolution/tier at a glance without reading the full JSON
 * matrix, and so successive runs for different encoders (see runBenchmark's
 * log call) can be diffed/grepped side by side in the server log.
 * @param {object} matrix - matrix[height][tuning] from runBenchmark
 * @param {object} recommended - recommended[height] from runBenchmark
 * @param {number[]} heights
 * @returns {string}
 */
function formatBenchmarkSummaryLine(matrix, recommended, heights) {
  return heights
    .map((height) => {
      const cells = streamEncoderTuning.VALID_TUNING.map((tuning) => {
        const result = matrix[height][tuning];
        const factor = result.ok ? `${result.realtimeFactor.toFixed(1)}x` : 'FAIL';
        const notRealtime = result.ok && !result.realtime ? '!' : '';
        const isRecommended = recommended[height] === tuning ? '*' : '';
        return `${tuning}=${factor}${notRealtime}${isRecommended}`;
      }).join(' ');
      return `${height}p[${cells}]`;
    })
    .join(' ');
}

/**
 * Runs the tuning x height matrix for ONE hardware encoder sequentially -
 * scoped to whichever encoder the caller actually has selected (see
 * server/routes/ytdlpOptions.js), not every possible one, so this only ever
 * spends time measuring an encoder the host will actually use. Broadcasts a
 * `tuningBenchmarkProgress` message (via messageEmitter, the same
 * mechanism used by streamProgress/channelImageRegenStatus elsewhere) before
 * each combination starts, so the UI can show real progress instead of a
 * static "this can take a while" message, and a final `running: false`
 * message on completion.
 *
 * Annotates each height with which tuning tier is `recommended` — the
 * highest-quality tier that still measured real-time-safe, falling back to
 * whichever tier had the best realtimeFactor if none qualified.
 *
 * Runs one discarded warmup encode (see WARMUP_DURATION_SECONDS) at
 * heights[0]/VALID_TUNING[0] before the real matrix starts, so process-spawn
 * and hardware/driver init overhead lands there instead of skewing the
 * first real measurement.
 * @param {string} hardwareMode
 * @param {number[]} heights
 * @param {object} [opts]
 * @param {number} [opts.durationSeconds] - see benchmarkOne; test-only.
 * @param {number|string|null} [opts.vaapiQuality] - see benchmarkOne; passed
 *   through to every combo (including the warmup) so a vaapi run measures
 *   exactly what real playback would use.
 * @returns {Promise<{matrix: object, recommended: object}>}
 * @throws {Error} if a benchmark is already running (check isBenchmarkRunning first)
 */
async function runBenchmark(hardwareMode, heights, { durationSeconds = BENCHMARK_DURATION_SECONDS, vaapiQuality = null } = {}) {
  if (running) {
    throw new Error('A tuning benchmark is already running');
  }
  running = true;

  const matrix = {};
  const recommended = {};
  // Quality tiers ordered worst->best so the recommendation pass below can
  // walk from best to worst and stop at the first real-time-safe one.
  const tiersBestFirst = [...streamEncoderTuning.VALID_TUNING].reverse();
  const total = heights.length * streamEncoderTuning.VALID_TUNING.length;
  let completed = 0;

  const broadcastProgress = (extra) => {
    messageEmitter.emitMessage('broadcast', null, 'server', 'tuningBenchmarkProgress', {
      running: true, hardwareMode, completed, total, ...extra,
    });
  };

  try {
    // Warm up on the first height/tier so its real measurement (taken next,
    // as the first entry in the loop below) isn't skewed by one-time
    // hardware/driver init overhead. `completed`/`total` stay untouched -
    // this doesn't count as one of the matrix's measured combos.
    broadcastProgress({ current: { tuning: streamEncoderTuning.VALID_TUNING[0], height: heights[0], warmup: true } });
    await benchmarkOne(hardwareMode, streamEncoderTuning.VALID_TUNING[0], heights[0], WARMUP_DURATION_SECONDS, vaapiQuality);

    for (const height of heights) {
      matrix[height] = {};
      for (const tuning of streamEncoderTuning.VALID_TUNING) {
        broadcastProgress({ current: { tuning, height } });
        // eslint-disable-next-line no-await-in-loop -- deliberately sequential, see doc comment
        matrix[height][tuning] = await benchmarkOne(hardwareMode, tuning, height, durationSeconds, vaapiQuality);
        completed++;
      }

      let best = null;
      for (const tuning of tiersBestFirst) {
        const result = matrix[height][tuning];
        if (result.ok && result.realtime) {
          best = tuning;
          break;
        }
      }
      if (!best) {
        // Nothing qualified as real-time-safe - fall back to whichever
        // successful tier had the highest realtimeFactor, so there's still
        // a usable recommendation even on an under-powered host.
        let bestFactor = -Infinity;
        for (const tuning of streamEncoderTuning.VALID_TUNING) {
          const result = matrix[height][tuning];
          if (result.ok && result.realtimeFactor > bestFactor) {
            bestFactor = result.realtimeFactor;
            best = tuning;
          }
        }
      }
      recommended[height] = best;
    }

    logger.info(
      { hardwareMode, matrix, recommended },
      `Tuning benchmark for ${hardwareMode}: ${formatBenchmarkSummaryLine(matrix, recommended, heights)}`
    );
    return { matrix, recommended };
  } finally {
    running = false;
    messageEmitter.emitMessage('broadcast', null, 'server', 'tuningBenchmarkProgress', {
      running: false, hardwareMode, completed, total,
    });
  }
}

module.exports = {
  BENCHMARK_DURATION_SECONDS,
  WARMUP_DURATION_SECONDS,
  REALTIME_SAFETY_MARGIN,
  benchmarkOne,
  runBenchmark,
  isBenchmarkRunning,
  formatBenchmarkSummaryLine,
};
