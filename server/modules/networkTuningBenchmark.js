/**
 * server/modules/networkTuningBenchmark.js
 *
 * "Test network tuning" - runs a real yt-dlp fetch of a user-supplied
 * YouTube video across a handful of --http-chunk-size/--concurrent-fragments
 * presets and measures actual sustained download throughput (MB/s) for
 * each, so a user can pick real-world values for Settings -> Streaming's
 * Network Tuning fields instead of guessing. Deliberately a separate,
 * simpler question from streamTuningBenchmark.js's encode-speed benchmark:
 * this never touches ffmpeg, and measures network/CDN behavior (including
 * YouTube's own mid-download throttling) rather than local CPU/GPU cost.
 *
 * Each preset's yt-dlp process pipes video-only bytes to a sink that just
 * counts them and discards - no disk write, no ffmpeg - for a fixed time
 * window (or until a byte cap, whichever comes first), so this is
 * comparable across presets and to server/routes/ytstream.js's own
 * buildBaseArgs (this module intentionally re-derives that small arg set
 * rather than importing it, since buildBaseArgs is still a closure private
 * to ytstream.js's route factory - see that file's own doc comment on why
 * it isn't exported yet).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const configModule = require('./configModule');
const YtdlpCommandBuilder = require('./download/ytdlpCommandBuilder');
const messageEmitter = require('./messageEmitter');
const logger = require('../logger');
const { DEFAULT_PLAYER_CLIENT } = require('./ytstream/configResolution');

// id/label pairs are shown as-is in the UI; httpChunkSizeMiB/concurrentFragments
// of 0 (and concurrentFragments of 1) mean "don't pass this flag" - same
// disabled-at-zero convention as the persisted Settings fields these presets
// exist to help choose.
const PRESETS = [
  { id: 'off', label: 'Off (yt-dlp default)', httpChunkSizeMiB: 0, concurrentFragments: 0 },
  { id: 'conservative', label: 'Conservative (5 MiB / 2)', httpChunkSizeMiB: 5, concurrentFragments: 2 },
  { id: 'aggressive', label: 'Aggressive (10 MiB / 4)', httpChunkSizeMiB: 10, concurrentFragments: 4 },
  { id: 'max', label: 'Max (20 MiB / 8)', httpChunkSizeMiB: 20, concurrentFragments: 8 },
];

// How long each preset is allowed to pull data for. Long enough to give
// YouTube's mid-download throttling (which the chunk-size/concurrent-
// fragments flags exist to work around) a real chance to kick in and show
// up in the measured throughput; short enough that the full 4-preset run
// finishes in about a minute.
const SAMPLE_WINDOW_MS = 15000;

// Safety cap so a single preset can't run away pulling an unbounded amount
// of a very high-bitrate source - whichever of this or SAMPLE_WINDOW_MS is
// hit first ends that preset's measurement.
const BYTE_CAP = 150 * 1024 * 1024;

// Hard kill well beyond SAMPLE_WINDOW_MS, in case yt-dlp itself hangs before
// ever producing a byte (extraction stall, network black hole, etc.) - the
// window timer above only fires once data has been flowing.
const PROCESS_TIMEOUT_MS = 30000;

let running = false;

function isBenchmarkRunning() {
  return running;
}

const VIDEO_ID_RE = /^[\w-]{11}$/;

/**
 * Accepts a bare 11-char YouTube video ID or a full URL (any yt-dlp-
 * recognized form) and returns something safe to pass as yt-dlp's URL
 * operand. A bare ID is turned into a canonical watch URL; anything else is
 * passed through as-is for yt-dlp itself to validate/reject, same as every
 * other URL this app hands yt-dlp.
 * @param {string} input
 * @returns {string}
 */
function normalizeUrl(input) {
  const trimmed = String(input || '').trim();
  if (!trimmed) {
    throw new Error('A YouTube URL or video ID is required');
  }
  if (VIDEO_ID_RE.test(trimmed)) {
    return `https://youtube.com/watch?v=${trimmed}`;
  }
  return trimmed;
}

/**
 * @param {object} config - configModule.getConfig()
 * @param {{httpChunkSizeMiB: number, concurrentFragments: number}} preset
 * @param {string} watchUrl
 * @returns {string[]}
 */
function buildArgsForPreset(config, preset, watchUrl) {
  const args = [...YtdlpCommandBuilder.buildCommonArgs(config, { skipSleepRequests: true })];

  const playerClient = (config.ytstream && config.ytstream.playerClient) || DEFAULT_PLAYER_CLIENT;
  args.push('--extractor-args', `youtube:player_client=${playerClient}`);

  if (preset.httpChunkSizeMiB > 0) {
    args.push('--http-chunk-size', `${preset.httpChunkSizeMiB}M`);
  }
  if (preset.concurrentFragments > 1) {
    args.push('--concurrent-fragments', String(preset.concurrentFragments));
  }

  // Capped at the configured Stream quality (falling back to 1080p) so this
  // measures the same rough bitrate a real stream would actually pull,
  // rather than always maxing out at whatever the highest available
  // resolution happens to be (which can be a very different, less
  // representative bitrate at 4K/8K).
  const configuredQuality = config.ytstream && config.ytstream.quality;
  const height = configuredQuality && configuredQuality !== 'best' ? configuredQuality : '1080';
  args.push('-f', `bestvideo[height<=${height}]`, '-o', '-', '--no-playlist', '--no-warnings', watchUrl);

  return args;
}

/**
 * Runs one preset's yt-dlp fetch, discarding every byte it produces after
 * counting it, for up to SAMPLE_WINDOW_MS (or BYTE_CAP, whichever comes
 * first), then kills the process and reports throughput.
 * @param {object} config
 * @param {object} preset
 * @param {string} watchUrl
 * @returns {Promise<{ok: boolean, bytes?: number, elapsedSeconds?: number, throughputMBps?: number, error?: string}>}
 */
function runOnePreset(config, preset, watchUrl) {
  return new Promise((resolve) => {
    const args = buildArgsForPreset(config, preset, watchUrl);
    let bytes = 0;
    let stderr = '';
    let finished = false;
    const startedAt = Date.now();

    // yt-dlp's fragment downloader buffers fragments to disk (named
    // "<outtmpl>-FragN") before concatenating them to stdout whenever
    // --concurrent-fragments is in play, even though the final output goes
    // to "-" (stdout). Giving it a scratch cwd keeps those transient files
    // out of the app's own working directory instead of leaving them
    // scattered (and gitignore-invisible, since they're outside the repo)
    // wherever the server happened to be running from.
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytstream-netbench-'));
    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: scratchDir });

    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(windowTimer);
      clearTimeout(hardTimer);
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      fs.rm(scratchDir, { recursive: true, force: true }, () => {});
      resolve(result);
    };

    // Kept on every ok:true result, not just failures - a low-throughput
    // result (e.g. YouTube rate-limiting a too-aggressive preset) is
    // otherwise indistinguishable from "the network was just slow": yt-dlp
    // prints retry/HTTP-error lines to stderr by default (not gated behind
    // --verbose), so this is often the only signal explaining *why* a
    // preset measured badly, not just that it did.
    const measure = () => {
      const elapsedSeconds = (Date.now() - startedAt) / 1000;
      return {
        bytes,
        elapsedSeconds,
        throughputMBps: elapsedSeconds > 0 ? bytes / 1024 / 1024 / elapsedSeconds : 0,
        stderrTail: stderr.slice(-800) || null,
      };
    };

    const windowTimer = setTimeout(() => {
      const m = measure();
      finish(bytes > 0
        ? { ok: true, ...m }
        : { ok: false, error: stderr.slice(-500) || 'No data received before the sample window closed' });
    }, SAMPLE_WINDOW_MS);

    const hardTimer = setTimeout(() => {
      finish({ ok: false, error: `Timed out after ${PROCESS_TIMEOUT_MS / 1000}s (yt-dlp likely hung before producing data)` });
    }, PROCESS_TIMEOUT_MS);

    proc.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes >= BYTE_CAP) {
        finish({ ok: true, ...measure() });
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      finish({ ok: false, error: err.message || 'Failed to start yt-dlp' });
    });

    proc.on('close', (code) => {
      if (finished) return;
      const m = measure();
      if (bytes > 0) {
        finish({ ok: true, ...m });
      } else {
        finish({ ok: false, error: stderr.slice(-500) || `yt-dlp exited with code ${code} before producing data` });
      }
    });
  });
}

/**
 * Runs every preset in PRESETS sequentially against `urlOrId` and reports
 * measured throughput for each, plus which preset measured fastest.
 * Broadcasts a `networkTuningBenchmarkProgress` message (same mechanism as
 * streamTuningBenchmark.js's tuningBenchmarkProgress) before each preset
 * starts and a final `running: false` message on completion.
 * @param {string} urlOrId - full YouTube URL or bare 11-char video ID
 * @returns {Promise<{results: object, recommended: string|null, presets: object[]}>}
 * @throws {Error} if a benchmark is already running (check isBenchmarkRunning first) or the URL is invalid
 */
async function runBenchmark(urlOrId) {
  if (running) {
    throw new Error('A network tuning benchmark is already running');
  }
  const watchUrl = normalizeUrl(urlOrId);

  running = true;
  const config = configModule.getConfig();
  const results = {};
  const total = PRESETS.length;
  let completed = 0;

  const broadcastProgress = (extra) => {
    messageEmitter.emitMessage('broadcast', null, 'server', 'networkTuningBenchmarkProgress', {
      running: true, completed, total, ...extra,
    });
  };

  try {
    for (const preset of PRESETS) {
      broadcastProgress({ current: { presetId: preset.id } });
      // eslint-disable-next-line no-await-in-loop -- deliberately sequential: concurrent presets would contend for the same bandwidth and invalidate each other's measurement
      results[preset.id] = await runOnePreset(config, preset, watchUrl);
      completed++;
    }

    let recommended = null;
    let bestThroughput = -Infinity;
    for (const preset of PRESETS) {
      const result = results[preset.id];
      if (result.ok && result.throughputMBps > bestThroughput) {
        bestThroughput = result.throughputMBps;
        recommended = preset.id;
      }
    }

    logger.info({ watchUrl, results, recommended }, 'Network tuning benchmark complete');
    return { results, recommended, presets: PRESETS };
  } finally {
    running = false;
    messageEmitter.emitMessage('broadcast', null, 'server', 'networkTuningBenchmarkProgress', {
      running: false, completed, total,
    });
  }
}

module.exports = {
  PRESETS,
  SAMPLE_WINDOW_MS,
  isBenchmarkRunning,
  runBenchmark,
  normalizeUrl,
};
