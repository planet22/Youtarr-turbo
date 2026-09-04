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
const fs = require('fs');
const os = require('os');
const path = require('path');
const configModule = require('./configModule');
const streamEncoderTuning = require('./streamEncoderTuning');
const hardwareDecodeModule = require('./hardwareDecodeModule');
const hardwareCapabilityTester = require('./hardwareCapabilityTester');
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

    proc.on('close', (code, signal) => {
      const wallSeconds = (Date.now() - startedAt) / 1000;
      if (code === 0) {
        finish({ ok: true, wallSeconds });
      } else {
        const summarized = hardwareCapabilityTester.summarizeStderr(stderr);
        finish({ ok: false, error: `${hardwareCapabilityTester.describeExitSignal(signal)}${summarized || `ffmpeg exited with status ${code}`}` });
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
 * @param {string} [decodeMode] - 'none' (default, software decode) | 'qsv' |
 *   'nvenc' | 'vaapi' (see hardwareDecodeModule.js - a separate axis from
 *   hardwareMode/encode). Whenever `sourceSamplePath` is given (regardless of
 *   decodeMode, 'none' included), the real compressed sample is fed as input
 *   instead of the synthetic lavfi source, with decodeMode's -hwaccel flags
 *   prepended if any ('none' contributes none, so ffmpeg decodes it in
 *   software - a real, measured cost, not a skipped one) - so the timed run
 *   genuinely includes decode+scale+encode cost together for every decode
 *   backend, software included. Decode is deliberately left to output
 *   default (system-memory) frames (no -hwaccel_output_format) - the
 *   existing encoder filter chain's own hwupload step already expects that,
 *   so hardware decode acceleration is "invisible" downstream: only the
 *   decode step itself moves to the GPU, no shared zero-copy device context
 *   needed between decode and encode.
 * @param {string|null} [sourceSamplePath] - from
 *   hardwareCapabilityTester.generateDecodeSample; when omitted/null, falls
 *   back to the synthetic lavfi source (test-only - production callers
 *   always generate one, see runBenchmark).
 * @param {string} [videoCodec] - 'h264' (default - the only one real
 *   ytstream playback ever targets) | 'hevc' | 'av1'. See
 *   streamEncoderTuning.buildVideoEncoderArgs' own doc comment.
 * @returns {Promise<{ok: boolean, wallSeconds?: number, realtimeFactor?: number, realtime?: boolean, error?: string}>}
 */
async function benchmarkOne(hardwareMode, tuning, height, durationSeconds = BENCHMARK_DURATION_SECONDS, vaapiQuality = null, decodeMode = 'none', sourceSamplePath = null, videoCodec = 'h264') {
  const width = Math.round((height * 16) / 9 / 2) * 2;
  const encoder = streamEncoderTuning.buildVideoEncoderArgs(hardwareMode, height, tuning, vaapiQuality, videoCodec);

  const args = ['-y', '-loglevel', 'error'];
  // decodeMode 'none' still counts as "real decode" here - it means
  // software decode (no -hwaccel flags added below), not "skip decode
  // entirely". Only an actually-missing sample (test-only) falls back to
  // the synthetic source.
  const usingRealDecode = !!sourceSamplePath;

  if (usingRealDecode) {
    // Explicit -hwaccel flags always come first, regardless of whatever
    // encoder.preInputArgs' own device-init args (e.g. vaapi's
    // -vaapi_device) might already imply - unambiguous is safer than
    // relying on backend-specific implicit behavior here.
    const decode = hardwareDecodeModule.buildDecodeArgs(decodeMode);
    if (decode.preInputArgs.length) args.push(...decode.preInputArgs);
    if (encoder.preInputArgs && encoder.preInputArgs.length) args.push(...encoder.preInputArgs);
    args.push('-i', sourceSamplePath, '-t', String(durationSeconds));
  } else {
    if (encoder.preInputArgs && encoder.preInputArgs.length) {
      args.push(...encoder.preInputArgs);
    }
    args.push(
      '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=30:duration=${durationSeconds}`,
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-t', String(durationSeconds),
    );
  }
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

// Deliberately non-30fps - the whole point of this test is catching the
// "segments only land at exactly N seconds for a 30fps source" bug (see
// ytstream.js's HLS_SEGMENT_DURATION_SECONDS comment and
// streamEncoderTuning.buildVideoEncoderArgs' useForceKeyframes param).
const SEGMENT_TIMING_TEST_FPS = 25;
const SEGMENT_TIMING_TEST_DURATION_SECONDS = 30;
// A real segment is "close enough" to the FORCE_KEYFRAMES_INTERVAL_SECONDS
// target if every one measured is within this many seconds of it - loose
// enough to tolerate ffmpeg's own muxer/rounding overhead, tight enough to
// still catch genuine drift (the original bug: a 25fps source landing at
// 4.8s instead of 4.0s is nowhere close to this).
const SEGMENT_TIMING_TOLERANCE_SECONDS = 0.15;

/**
 * Empirically verifies whether time-based forced keyframes
 * (streamEncoderTuning.buildVideoEncoderArgs' useForceKeyframes=true)
 * actually produce accurate HLS segments for `hardwareMode` on THIS host -
 * some hardware encoders are known to sometimes ignore or mishandle a
 * forced-keyframe expression. Unlike benchmarkOne (a speed check that
 * discards its output to `-f null`), this runs a real short HLS encode of a
 * deliberately non-30fps synthetic source and reads the real per-segment
 * durations straight out of the produced .m3u8's #EXTINF lines - a
 * correctness check, not a performance one. All output is written under
 * the OS temp directory and deleted before returning, regardless of outcome.
 * @param {string} hardwareMode
 * @param {number|string|null} [vaapiQuality] - see benchmarkOne; passed
 *   through so this measures exactly what a real vaapi stream would use.
 * @returns {Promise<{ok: boolean, measuredSeconds?: number[], averageSeconds?: number, maxDeviationSeconds?: number, error?: string}>}
 */
async function testSegmentTiming(hardwareMode, vaapiQuality = null) {
  const encoder = streamEncoderTuning.buildVideoEncoderArgs(hardwareMode, null, 'fast', vaapiQuality, 'h264', true);
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ytarr-segtiming-'));
  const playlistPath = path.join(dir, 'out.m3u8');
  const segmentPattern = path.join(dir, 'seg%05d.ts');
  try {
    const args = ['-y', '-loglevel', 'error'];
    if (encoder.preInputArgs && encoder.preInputArgs.length) args.push(...encoder.preInputArgs);
    args.push(
      '-f', 'lavfi', '-i', `testsrc2=size=640x480:rate=${SEGMENT_TIMING_TEST_FPS}:duration=${SEGMENT_TIMING_TEST_DURATION_SECONDS}`,
      '-f', 'lavfi', '-i', `sine=frequency=1000:duration=${SEGMENT_TIMING_TEST_DURATION_SECONDS}`,
    );
    if (encoder.videoFilters && encoder.videoFilters.length) args.push('-vf', encoder.videoFilters.join(','));
    if (encoder.pixFmt) args.push('-pix_fmt', encoder.pixFmt);
    args.push(...encoder.encoderArgs);
    args.push(
      '-c:a', 'aac', '-b:a', '128k',
      '-f', 'hls', '-hls_time', String(streamEncoderTuning.FORCE_KEYFRAMES_INTERVAL_SECONDS), '-hls_list_size', '0',
      '-hls_segment_filename', segmentPattern,
      playlistPath
    );

    const result = await runTimedFfmpegEncode(args);
    if (!result.ok) return { ok: false, error: result.error };

    const playlist = await fs.promises.readFile(playlistPath, 'utf8');
    const measuredSeconds = [...playlist.matchAll(/^#EXTINF:([\d.]+),/gm)].map((m) => Number(m[1]));
    if (!measuredSeconds.length) {
      return { ok: false, error: 'ffmpeg exited successfully but produced no segments to measure' };
    }
    // The LAST segment of ANY VOD HLS stream is normally shorter than the
    // target - it's just whatever's left over after the last full interval
    // (e.g. a 30s source at a 4s target naturally ends with a 2.000s tail
    // segment: 7*4 + 2 = 30) - completely expected, true of a real stream's
    // final segment too, and NOT evidence that force_key_frames misbehaved.
    // Judging accuracy only makes sense on segments that had a full target
    // interval to land on, so the last one is excluded from the pass/fail
    // math below (still reported in the raw measuredSeconds list, for
    // transparency).
    const judgedSeconds = measuredSeconds.length > 1 ? measuredSeconds.slice(0, -1) : measuredSeconds;
    const averageSeconds = judgedSeconds.reduce((a, b) => a + b, 0) / judgedSeconds.length;
    const maxDeviationSeconds = Math.max(...judgedSeconds.map((s) => Math.abs(s - streamEncoderTuning.FORCE_KEYFRAMES_INTERVAL_SECONDS)));
    return {
      ok: maxDeviationSeconds <= SEGMENT_TIMING_TOLERANCE_SECONDS,
      measuredSeconds,
      averageSeconds,
      maxDeviationSeconds,
    };
  } finally {
    fs.promises.rm(dir, { recursive: true, force: true }).catch(() => { /* best-effort cleanup */ });
  }
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
 * @param {string} [opts.decodeMode] - see benchmarkOne; 'none' (default) or
 *   a hardwareDecodeModule.VALID_DECODE_HARDWARE value. Independent of
 *   `hardwareMode` (encode) - e.g. software encode + hardware decode, or the
 *   reverse, are both valid combos and measured exactly as configured.
 * @param {string} [opts.sourceCodec] - which source codec to simulate
 *   decoding - always used, including when `decodeMode` is 'none' (software
 *   decode of this codec is measured too, not skipped).
 * @param {string} [opts.videoCodec] - see benchmarkOne; 'h264' (default) |
 *   'hevc' | 'av1' - the ENCODE target, independent of `sourceCodec` (decode
 *   input).
 * @param {number|null} [opts.decodeSourceHeight] - height to generate the
 *   decode sample at, overriding the default of `Math.max(...heights)`
 *   (worst-case: assumes the real cached source could be as large as the
 *   largest resolution this run tests). A real cached buffer/backfill source
 *   is actually capped at whatever Stream quality is configured (see
 *   ytstream.js's getDashFormatSelectors), so this lets a caller test a
 *   smaller, more realistic source size (e.g. "what if quality is capped at
 *   1080p") instead of always the conservative worst case.
 * @returns {Promise<{matrix: object, recommended: object}>}
 * @throws {Error} if a benchmark is already running (check isBenchmarkRunning first)
 */
async function runBenchmark(hardwareMode, heights, {
  durationSeconds = BENCHMARK_DURATION_SECONDS,
  vaapiQuality = null,
  decodeMode = 'none',
  sourceCodec = 'h264',
  videoCodec = 'h264',
  decodeSourceHeight = null,
} = {}) {
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
      running: true, hardwareMode, decodeMode, videoCodec, completed, total, ...extra,
    });
  };

  let sourceSamplePath = null;

  try {
    // One real compressed sample, generated once and reused across every
    // combo in this run (including the warmup) - at the highest requested
    // height by default (a worst-case stand-in for "the real cached source
    // could be this large"; see decodeSourceHeight's own doc comment for why
    // a caller might override it), since a real DASH fetch pulls one
    // highest-available source resolution once and ffmpeg scales down per
    // target height from there, same as real playback would. Long enough
    // (BENCHMARK_DURATION_SECONDS) that every combo's own `-t` trim still
    // has real decoded content to work with, including the (longer) real
    // combos, not just the short warmup. Generated inside this try so a
    // failure here still resets `running` via the finally below, same as
    // any other failure mode.
    //
    // Generated regardless of decodeMode, including 'none' - software decode
    // of a real source has a real, measurable cost too (that's the whole
    // point of also offering it here, not just the hardware backends), and
    // benchmarkOne only skips -hwaccel flags for 'none', not the real input.
    const sampleHeight = decodeSourceHeight || Math.max(...heights);
    {
      const sampleWidth = Math.round((sampleHeight * 16) / 9 / 2) * 2;
      sourceSamplePath = await hardwareCapabilityTester.generateDecodeSample(sourceCodec, {
        width: sampleWidth, height: sampleHeight, durationSeconds,
      });
    }

    // Warm up on the first height/tier so its real measurement (taken next,
    // as the first entry in the loop below) isn't skewed by one-time
    // hardware/driver init overhead. `completed`/`total` stay untouched -
    // this doesn't count as one of the matrix's measured combos.
    broadcastProgress({ current: { tuning: streamEncoderTuning.VALID_TUNING[0], height: heights[0], warmup: true } });
    await benchmarkOne(hardwareMode, streamEncoderTuning.VALID_TUNING[0], heights[0], WARMUP_DURATION_SECONDS, vaapiQuality, decodeMode, sourceSamplePath, videoCodec);

    for (const height of heights) {
      matrix[height] = {};

      // A capped decode source can't stand in for a resolution above it -
      // buildVideoEncoderArgs' scale filter is decrease-only, so decoding a
      // (say) 1080p sample for a "1440p" row would silently just re-measure
      // 1080p again under a misleading label instead of ever actually
      // testing 1440p. Mark it skipped instead of running (and mislabeling)
      // it.
      if (height > sampleHeight) {
        for (const tuning of streamEncoderTuning.VALID_TUNING) {
          matrix[height][tuning] = { ok: false, skipped: true, error: `Skipped - decode source capped at ${sampleHeight}p, below this resolution` };
        }
        recommended[height] = null;
        completed += streamEncoderTuning.VALID_TUNING.length;
        continue;
      }

      for (const tuning of streamEncoderTuning.VALID_TUNING) {
        broadcastProgress({ current: { tuning, height } });
        // eslint-disable-next-line no-await-in-loop -- deliberately sequential, see doc comment
        matrix[height][tuning] = await benchmarkOne(hardwareMode, tuning, height, durationSeconds, vaapiQuality, decodeMode, sourceSamplePath, videoCodec);
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
      { hardwareMode, decodeMode, sourceCodec, videoCodec, decodeSourceHeight: sampleHeight, matrix, recommended },
      `Tuning benchmark for ${hardwareMode} encoding ${videoCodec} (decode=${decodeMode}, source ${sampleHeight}p): ${formatBenchmarkSummaryLine(matrix, recommended, heights)}`
    );
    return { matrix, recommended, decodeMode, sourceCodec, videoCodec, decodeSourceHeight: sampleHeight };
  } finally {
    running = false;
    if (sourceSamplePath) {
      fs.promises.unlink(sourceSamplePath).catch(() => { /* best-effort cleanup */ });
    }
    messageEmitter.emitMessage('broadcast', null, 'server', 'tuningBenchmarkProgress', {
      running: false, hardwareMode, decodeMode, videoCodec, completed, total,
    });
  }
}

module.exports = {
  BENCHMARK_DURATION_SECONDS,
  WARMUP_DURATION_SECONDS,
  REALTIME_SAFETY_MARGIN,
  SEGMENT_TIMING_TOLERANCE_SECONDS,
  benchmarkOne,
  runBenchmark,
  isBenchmarkRunning,
  formatBenchmarkSummaryLine,
  testSegmentTiming,
};
