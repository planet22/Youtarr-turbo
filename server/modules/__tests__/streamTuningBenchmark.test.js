/* eslint-env jest */
const EventEmitter = require('events');

jest.mock('child_process');
jest.mock('../configModule', () => ({ ffmpegPath: 'ffmpeg' }));
jest.mock('../messageEmitter', () => ({ emitMessage: jest.fn() }));
jest.mock('../../logger');
jest.mock('../hardwareCapabilityTester', () => ({
  generateDecodeSample: jest.fn(),
  // Real implementations (no ffmpeg/child_process involvement - pure string
  // logic) so runTimedFfmpegEncode's error-path tests exercise the same
  // stderr summarization/signal-description production code actually runs,
  // instead of a stub.
  summarizeStderr: jest.requireActual('../hardwareCapabilityTester').summarizeStderr,
  describeExitSignal: jest.requireActual('../hardwareCapabilityTester').describeExitSignal,
}));

const { spawn } = require('child_process');
const messageEmitter = require('../messageEmitter');
const logger = require('../../logger');
const hardwareCapabilityTester = require('../hardwareCapabilityTester');
const streamTuningBenchmark = require('../streamTuningBenchmark');

/** Builds a fake child process that resolves after `ms` with the given exit code/signal. */
function fakeProc({ ms = 0, code = 0, signal = null, stderrText } = {}) {
  const proc = new EventEmitter();
  proc.stderr = new EventEmitter();
  setTimeout(() => {
    if (stderrText) proc.stderr.emit('data', Buffer.from(stderrText));
    proc.emit('close', code, signal);
  }, ms);
  return proc;
}

// A tiny synthetic duration (see benchmarkOne's durationSeconds override) so
// the realtime/not-realtime boundary (duration / REALTIME_SAFETY_MARGIN)
// falls within a few milliseconds instead of multiple real seconds — keeps
// these tests fast without weakening what they verify.
const TEST_DURATION_SECONDS = 0.1;
const THRESHOLD_MS = (TEST_DURATION_SECONDS / streamTuningBenchmark.REALTIME_SAFETY_MARGIN) * 1000; // ~77ms

describe('benchmarkOne', () => {
  beforeEach(() => jest.clearAllMocks());

  test('reports realtime:true when the encode finishes well within the safety margin', async () => {
    spawn.mockImplementation(() => fakeProc({ ms: 5, code: 0 }));
    const result = await streamTuningBenchmark.benchmarkOne('none', 'fast', 1080, TEST_DURATION_SECONDS);
    expect(result.ok).toBe(true);
    expect(result.realtime).toBe(true);
    expect(result.realtimeFactor).toBeGreaterThan(streamTuningBenchmark.REALTIME_SAFETY_MARGIN);
  });

  test('reports realtime:false when the encode is slower than the safety margin allows', async () => {
    spawn.mockImplementation(() => fakeProc({ ms: THRESHOLD_MS + 60, code: 0 }));
    const result = await streamTuningBenchmark.benchmarkOne('none', 'quality', 1080, TEST_DURATION_SECONDS);
    expect(result.ok).toBe(true);
    expect(result.realtime).toBe(false);
    expect(result.realtimeFactor).toBeLessThan(streamTuningBenchmark.REALTIME_SAFETY_MARGIN);
  });

  test('reports ok:false with the stderr tail when ffmpeg exits non-zero', async () => {
    spawn.mockImplementation(() => fakeProc({ ms: 5, code: 1, stderrText: 'Device creation failed' }));
    const result = await streamTuningBenchmark.benchmarkOne('vaapi', 'fast', 1080, TEST_DURATION_SECONDS);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Device creation failed');
  });

  test('a process killed by a signal (e.g. OOM-killed) says so up front, even when stderr alone looks benign', async () => {
    spawn.mockImplementation(() => fakeProc({
      ms: 5, code: null, signal: 'SIGKILL', stderrText: 'Svt[info]: SVT [config]: preset / tune / pred struct: 10 / PSNR / random access',
    }));
    const result = await streamTuningBenchmark.benchmarkOne('none', 'fast', 2160, TEST_DURATION_SECONDS);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('killed by signal SIGKILL');
    expect(result.error).toContain('out of memory');
  });

  test('reports ok:false when spawn itself errors (e.g. ffmpeg not on PATH)', async () => {
    spawn.mockImplementation(() => {
      const proc = new EventEmitter();
      proc.stderr = new EventEmitter();
      setTimeout(() => proc.emit('error', new Error('ENOENT')), 0);
      return proc;
    });
    const result = await streamTuningBenchmark.benchmarkOne('none', 'fast', 1080, TEST_DURATION_SECONDS);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('ENOENT');
  });

  test('passes buildVideoEncoderArgs\' actual encoder args to ffmpeg (benchmarks the real playback path)', async () => {
    spawn.mockImplementation((_bin, args) => {
      expect(args).toEqual(expect.arrayContaining(['-c:v', 'libx264', '-preset', 'medium', '-crf', '19']));
      return fakeProc({ ms: 1, code: 0 });
    });
    await streamTuningBenchmark.benchmarkOne('none', 'quality', 1080, TEST_DURATION_SECONDS);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test('decodeMode "none" with no sourceSamplePath keeps the synthetic lavfi source (test-only path)', async () => {
    spawn.mockImplementation((_bin, args) => {
      expect(args).toEqual(expect.arrayContaining(['-f', 'lavfi']));
      expect(args).not.toContain('-hwaccel');
      return fakeProc({ ms: 1, code: 0 });
    });
    await streamTuningBenchmark.benchmarkOne('none', 'fast', 1080, TEST_DURATION_SECONDS);
  });

  test('decodeMode "none" with a real sourceSamplePath decodes it in software (real file input, no -hwaccel flags)', async () => {
    spawn.mockImplementation((_bin, args) => {
      expect(args).toEqual(expect.arrayContaining(['-i', '/tmp/sample.mp4']));
      expect(args).not.toContain('-hwaccel');
      expect(args).not.toContain('lavfi');
      return fakeProc({ ms: 1, code: 0 });
    });
    await streamTuningBenchmark.benchmarkOne('none', 'fast', 1080, TEST_DURATION_SECONDS, null, 'none', '/tmp/sample.mp4');
  });

  test('a real decodeMode + sourceSamplePath feeds the real file as input with -hwaccel prepended, instead of the synthetic source', async () => {
    spawn.mockImplementation((_bin, args) => {
      expect(args).toEqual(expect.arrayContaining(['-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD128', '-i', '/tmp/sample.mp4']));
      expect(args).not.toContain('lavfi');
      return fakeProc({ ms: 1, code: 0 });
    });
    await streamTuningBenchmark.benchmarkOne('none', 'fast', 1080, TEST_DURATION_SECONDS, null, 'vaapi', '/tmp/sample.mp4');
  });

  test('a decodeMode without a sourceSamplePath falls back to the synthetic source (nothing to decode)', async () => {
    spawn.mockImplementation((_bin, args) => {
      expect(args).toEqual(expect.arrayContaining(['-f', 'lavfi']));
      return fakeProc({ ms: 1, code: 0 });
    });
    await streamTuningBenchmark.benchmarkOne('none', 'fast', 1080, TEST_DURATION_SECONDS, null, 'vaapi', null);
  });
});

describe('runBenchmark', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks doesn't reset a mockResolvedValue set by an earlier
    // test in this block (that needs mockReset, not mockClear) - default
    // back to "no real sample" every test so only the tests that
    // deliberately opt in (via their own mockResolvedValue) exercise the
    // real-decode-input branch of benchmarkOne.
    hardwareCapabilityTester.generateDecodeSample.mockResolvedValue(undefined);
  });

  test('scopes the matrix/recommended to just the given hardwareMode (height-keyed only)', async () => {
    spawn.mockImplementation(() => fakeProc({ ms: 1, code: 0 }));

    const { matrix, recommended } = await streamTuningBenchmark.runBenchmark('none', [1080], { durationSeconds: TEST_DURATION_SECONDS });

    // No hardwareMode layer - the caller already told us which encoder.
    expect(matrix[1080]).toBeDefined();
    expect(matrix[1080].fast).toBeDefined();
    expect(matrix.none).toBeUndefined();
    // All three tiers resolve equally fast here, so the best (highest-
    // quality) real-time-safe tier wins.
    expect(recommended[1080]).toBe('quality');
  });

  test('a decodeMode generates one real sample and reuses it (with -hwaccel) for every combo, including the warmup', async () => {
    hardwareCapabilityTester.generateDecodeSample.mockResolvedValue('/tmp/decode-sample.mp4');
    spawn.mockImplementation((_bin, args) => {
      expect(args).toEqual(expect.arrayContaining(['-hwaccel', 'qsv', '-i', '/tmp/decode-sample.mp4']));
      return fakeProc({ ms: 1, code: 0 });
    });

    await streamTuningBenchmark.runBenchmark('none', [1080], {
      durationSeconds: TEST_DURATION_SECONDS, decodeMode: 'qsv', sourceCodec: 'vp9',
    });

    expect(hardwareCapabilityTester.generateDecodeSample).toHaveBeenCalledTimes(1);
    expect(hardwareCapabilityTester.generateDecodeSample).toHaveBeenCalledWith('vp9', expect.objectContaining({ height: 1080 }));
    // 1 warmup + 3 tiers = 4 encodes, every one reusing the same sample.
    expect(spawn).toHaveBeenCalledTimes(4);
  });

  test('decodeMode "none" (default) still generates and uses a real sample - software decode is a real, measured cost', async () => {
    hardwareCapabilityTester.generateDecodeSample.mockResolvedValue('/tmp/decode-sample.mp4');
    spawn.mockImplementation((_bin, args) => {
      expect(args).toEqual(expect.arrayContaining(['-i', '/tmp/decode-sample.mp4']));
      expect(args).not.toContain('-hwaccel');
      return fakeProc({ ms: 1, code: 0 });
    });
    const { sourceCodec } = await streamTuningBenchmark.runBenchmark('none', [1080], { durationSeconds: TEST_DURATION_SECONDS });
    expect(hardwareCapabilityTester.generateDecodeSample).toHaveBeenCalledTimes(1);
    expect(sourceCodec).toBe('h264');
  });

  test('decodeSourceHeight defaults to the max of the requested heights when omitted', async () => {
    hardwareCapabilityTester.generateDecodeSample.mockResolvedValue('/tmp/decode-sample.mp4');
    spawn.mockImplementation(() => fakeProc({ ms: 1, code: 0 }));
    const { decodeSourceHeight } = await streamTuningBenchmark.runBenchmark('none', [720, 1080, 2160], { durationSeconds: TEST_DURATION_SECONDS });
    expect(hardwareCapabilityTester.generateDecodeSample).toHaveBeenCalledWith('h264', expect.objectContaining({ height: 2160 }));
    expect(decodeSourceHeight).toBe(2160);
  });

  test('an explicit decodeSourceHeight overrides the max-of-heights default, generating the sample at that height instead', async () => {
    hardwareCapabilityTester.generateDecodeSample.mockResolvedValue('/tmp/decode-sample.mp4');
    spawn.mockImplementation(() => fakeProc({ ms: 1, code: 0 }));
    const { decodeSourceHeight } = await streamTuningBenchmark.runBenchmark('none', [480, 720, 1080], {
      durationSeconds: TEST_DURATION_SECONDS, decodeSourceHeight: 720,
    });
    expect(hardwareCapabilityTester.generateDecodeSample).toHaveBeenCalledWith('h264', expect.objectContaining({ height: 720 }));
    expect(decodeSourceHeight).toBe(720);
  });

  test('a resolution above decodeSourceHeight is skipped entirely (never actually re-tested against a smaller source under its label)', async () => {
    hardwareCapabilityTester.generateDecodeSample.mockResolvedValue('/tmp/decode-sample.mp4');
    const spawnedHeights = [];
    spawn.mockImplementation((_bin, args) => {
      // Only real (non-skipped) rows should ever reach ffmpeg at all.
      const scaleFilter = args[args.indexOf('-vf') + 1] || '';
      spawnedHeights.push(scaleFilter);
      return fakeProc({ ms: 1, code: 0 });
    });

    const { matrix, recommended } = await streamTuningBenchmark.runBenchmark('none', [720, 1440], {
      durationSeconds: TEST_DURATION_SECONDS, decodeSourceHeight: 720,
    });

    // 720p is at the cap (still tested); 1440p is above it (skipped).
    expect(matrix[720].fast.ok).toBe(true);
    expect(matrix[1440].fast).toEqual(expect.objectContaining({ ok: false, skipped: true }));
    expect(matrix[1440].balanced).toEqual(expect.objectContaining({ ok: false, skipped: true }));
    expect(matrix[1440].quality).toEqual(expect.objectContaining({ ok: false, skipped: true }));
    expect(recommended[1440]).toBeNull();
    // 1 warmup + 3 tiers for the one unskipped height (720) = 4 spawns; the
    // skipped height's 3 tiers never touch ffmpeg at all.
    expect(spawn).toHaveBeenCalledTimes(4);
  });

  test('only ever spawns ffmpeg for the requested hardwareMode, never the others', async () => {
    spawn.mockImplementation((_bin, args) => {
      // qsv/nvenc/vaapi/amf all pass distinguishing flags 'fast' (none) doesn't.
      expect(args).not.toContain('-global_quality');
      expect(args).not.toContain('h264_nvenc');
      expect(args).not.toContain('h264_vaapi');
      expect(args).not.toContain('h264_amf');
      return fakeProc({ ms: 1, code: 0 });
    });

    await streamTuningBenchmark.runBenchmark('none', [720, 1080], { durationSeconds: TEST_DURATION_SECONDS });

    // 1 discarded warmup encode + 3 tiers x 2 heights = 7 encodes total, all for 'none'.
    expect(spawn).toHaveBeenCalledTimes(7);
  });

  test('recommends the highest tier that measured real-time-safe', async () => {
    spawn.mockImplementation((_bin, args) => {
      const isQuality = args.includes('-crf') && args[args.indexOf('-crf') + 1] === '19';
      return fakeProc({ ms: isQuality ? THRESHOLD_MS + 60 : 1, code: 0 });
    });

    const { matrix, recommended } = await streamTuningBenchmark.runBenchmark('none', [1080], { durationSeconds: TEST_DURATION_SECONDS });

    expect(matrix[1080].fast.realtime).toBe(true);
    expect(matrix[1080].balanced.realtime).toBe(true);
    expect(matrix[1080].quality.realtime).toBe(false);
    expect(recommended[1080]).toBe('balanced');
  });

  test('falls back to the successful tier with the best realtimeFactor when none qualify', async () => {
    // Every tier is too slow to be realtime-safe, but with distinct wall
    // times so the fallback's "best factor among successful attempts"
    // branch has a single unambiguous winner to pick (quality, the fastest
    // of the three failing attempts).
    spawn.mockImplementation((_bin, args) => {
      const crf = args[args.indexOf('-crf') + 1];
      const msByCrf = { '23': THRESHOLD_MS + 90, '21': THRESHOLD_MS + 60, '19': THRESHOLD_MS + 30 };
      return fakeProc({ ms: msByCrf[crf], code: 0 });
    });

    const { matrix, recommended } = await streamTuningBenchmark.runBenchmark('none', [720], { durationSeconds: TEST_DURATION_SECONDS });

    expect(matrix[720].fast.realtime).toBe(false);
    expect(matrix[720].balanced.realtime).toBe(false);
    expect(matrix[720].quality.realtime).toBe(false);
    expect(recommended[720]).toBe('quality');
  });

  test('recommends null for a height where every tier fails outright', async () => {
    spawn.mockImplementation(() => fakeProc({ ms: 1, code: 1, stderrText: 'no device' }));
    const { recommended } = await streamTuningBenchmark.runBenchmark('vaapi', [1080], { durationSeconds: TEST_DURATION_SECONDS });
    expect(recommended[1080]).toBeNull();
  });

  test('broadcasts progress before each combination and a final running:false on completion', async () => {
    spawn.mockImplementation(() => fakeProc({ ms: 1, code: 0 }));

    await streamTuningBenchmark.runBenchmark('qsv', [720, 1080], { durationSeconds: TEST_DURATION_SECONDS });

    const progressCalls = messageEmitter.emitMessage.mock.calls.filter((c) => c[3] === 'tuningBenchmarkProgress');
    // 1 warmup broadcast + 6 "starting combo N" broadcasts (3 tiers x 2 heights) + 1 final completion broadcast.
    expect(progressCalls).toHaveLength(8);
    expect(progressCalls[0][4]).toEqual(expect.objectContaining({
      running: true, hardwareMode: 'qsv', completed: 0, total: 6, current: { tuning: 'fast', height: 720, warmup: true }
    }));
    expect(progressCalls[1][4]).toEqual(expect.objectContaining({
      running: true, hardwareMode: 'qsv', completed: 0, total: 6, current: { tuning: 'fast', height: 720 }
    }));
    expect(progressCalls[progressCalls.length - 1][4]).toEqual({
      running: false, hardwareMode: 'qsv', decodeMode: 'none', videoCodec: 'h264', completed: 6, total: 6
    });
  });

  test('isBenchmarkRunning reflects true while a run is in progress and false once it settles', async () => {
    let releaseFirst;
    spawn.mockImplementationOnce(() => {
      const proc = new EventEmitter();
      proc.stderr = new EventEmitter();
      releaseFirst = () => proc.emit('close', 0);
      return proc;
    });
    spawn.mockImplementation(() => fakeProc({ ms: 0, code: 0 }));

    expect(streamTuningBenchmark.isBenchmarkRunning()).toBe(false);
    const promise = streamTuningBenchmark.runBenchmark('none', [1080], { durationSeconds: TEST_DURATION_SECONDS });
    await Promise.resolve(); // let the first spawn() call happen
    expect(streamTuningBenchmark.isBenchmarkRunning()).toBe(true);

    releaseFirst();
    await promise;
    expect(streamTuningBenchmark.isBenchmarkRunning()).toBe(false);
  });

  test('rejects if a benchmark is already running', async () => {
    let releaseFirst;
    spawn.mockImplementationOnce(() => {
      const proc = new EventEmitter();
      proc.stderr = new EventEmitter();
      releaseFirst = () => proc.emit('close', 0);
      return proc;
    });
    spawn.mockImplementation(() => fakeProc({ ms: 0, code: 0 }));

    const firstRun = streamTuningBenchmark.runBenchmark('none', [1080], { durationSeconds: TEST_DURATION_SECONDS });
    await Promise.resolve();

    await expect(streamTuningBenchmark.runBenchmark('none', [720], { durationSeconds: TEST_DURATION_SECONDS }))
      .rejects.toThrow('already running');

    releaseFirst();
    await firstRun;
  });

  test('logs a summary line with the matrix/recommended attached on completion', async () => {
    spawn.mockImplementation(() => fakeProc({ ms: 1, code: 0 }));

    await streamTuningBenchmark.runBenchmark('nvenc', [1080], { durationSeconds: TEST_DURATION_SECONDS });

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ hardwareMode: 'nvenc', decodeMode: 'none', videoCodec: 'h264', matrix: expect.any(Object), recommended: expect.any(Object) }),
      expect.stringContaining('Tuning benchmark for nvenc encoding h264 (decode=none, source 1080p):')
    );
  });

  test('does not log a summary when the run throws before completing', async () => {
    spawn.mockImplementation(() => fakeProc({ ms: 1, code: 1, stderrText: 'device busy' }));
    // Every combo fails outright here, which still completes normally (not
    // a throw) - assert the happy-path log call count stays isolated to
    // completed runs by checking a genuinely already-running rejection
    // never logs a summary at all.
    let releaseFirst;
    spawn.mockImplementationOnce(() => {
      const proc = new EventEmitter();
      proc.stderr = new EventEmitter();
      releaseFirst = () => proc.emit('close', 0);
      return proc;
    });
    const firstRun = streamTuningBenchmark.runBenchmark('none', [1080], { durationSeconds: TEST_DURATION_SECONDS });
    await Promise.resolve();

    logger.info.mockClear();
    await expect(streamTuningBenchmark.runBenchmark('none', [720], { durationSeconds: TEST_DURATION_SECONDS })).rejects.toThrow();
    expect(logger.info).not.toHaveBeenCalled();

    releaseFirst();
    await firstRun;
  });
});

describe('formatBenchmarkSummaryLine', () => {
  test('marks the recommended tier with * and a not-realtime tier with !', () => {
    const matrix = {
      1080: {
        fast: { ok: true, realtimeFactor: 8.234, realtime: true },
        balanced: { ok: true, realtimeFactor: 5.1, realtime: true },
        quality: { ok: true, realtimeFactor: 0.9, realtime: false },
      },
    };
    const recommended = { 1080: 'balanced' };

    const line = streamTuningBenchmark.formatBenchmarkSummaryLine(matrix, recommended, [1080]);

    expect(line).toBe('1080p[fast=8.2x balanced=5.1x* quality=0.9x!]');
  });

  test('renders FAIL for a tier that errored outright', () => {
    const matrix = { 720: {
      fast: { ok: false, error: 'no device' },
      balanced: { ok: false, error: 'no device' },
      quality: { ok: false, error: 'no device' },
    } };
    const recommended = { 720: null };

    const line = streamTuningBenchmark.formatBenchmarkSummaryLine(matrix, recommended, [720]);

    expect(line).toBe('720p[fast=FAIL balanced=FAIL quality=FAIL]');
  });

  test('joins multiple resolutions with a space', () => {
    const matrix = {
      480: { fast: { ok: true, realtimeFactor: 10, realtime: true }, balanced: { ok: true, realtimeFactor: 9, realtime: true }, quality: { ok: true, realtimeFactor: 8, realtime: true } },
      720: { fast: { ok: true, realtimeFactor: 5, realtime: true }, balanced: { ok: true, realtimeFactor: 4, realtime: true }, quality: { ok: true, realtimeFactor: 3, realtime: true } },
    };
    const recommended = { 480: 'quality', 720: 'quality' };

    const line = streamTuningBenchmark.formatBenchmarkSummaryLine(matrix, recommended, [480, 720]);

    expect(line).toBe('480p[fast=10.0x balanced=9.0x quality=8.0x*] 720p[fast=5.0x balanced=4.0x quality=3.0x*]');
  });
});
