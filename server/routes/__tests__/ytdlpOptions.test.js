/* eslint-env jest */
const express = require('express');
const supertest = require('supertest');

jest.mock('../../modules/download/ytdlpValidator', () => ({
  dryRun: jest.fn(),
}));
jest.mock('../../modules/streamTuningBenchmark', () => ({
  runBenchmark: jest.fn(),
  isBenchmarkRunning: jest.fn().mockReturnValue(false),
  testSegmentTiming: jest.fn(),
}));
jest.mock('../../modules/hardwareCapabilityTester', () => ({
  testAllCapabilities: jest.fn(),
}));
// Never let this route file's real configModule singleton load - its
// constructor eagerly calls fs.watch() on the real config.json path (see
// configModule.js's watchConfig), which this suite has no reason to
// exercise and which is unreliable over some filesystems.
jest.mock('../../modules/configModule', () => ({
  getConfig: jest.fn().mockReturnValue({ ytstream: {} }),
  updateConfig: jest.fn(),
}));

const ytdlpValidator = require('../../modules/download/ytdlpValidator');
const streamTuningBenchmark = require('../../modules/streamTuningBenchmark');
const hardwareCapabilityTester = require('../../modules/hardwareCapabilityTester');
const configModule = require('../../modules/configModule');
const createYtdlpOptionsRoutes = require('../ytdlpOptions');

function makeApp({ verifyToken } = {}) {
  const app = express();
  app.use(express.json());
  const verify = verifyToken || ((_req, _res, next) => next());
  const passthroughLimiter = (_req, _res, next) => next();
  app.use(createYtdlpOptionsRoutes({
    verifyToken: verify,
    ytdlpValidationRateLimiter: passthroughLimiter,
  }));
  return app;
}

describe('POST /api/ytdlp/validate-args', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns 401 when verifyToken rejects', async () => {
    const app = makeApp({
      verifyToken: (_req, res) => res.status(401).json({ error: 'unauthorized' }),
    });
    const res = await supertest(app).post('/api/ytdlp/validate-args').send({ args: '' });
    expect(res.status).toBe(401);
  });

  test('returns 400 when args is not a string', async () => {
    const app = makeApp();
    const res = await supertest(app).post('/api/ytdlp/validate-args').send({ args: 42 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/string/i);
  });

  test('returns 400 when args exceeds 2000 characters', async () => {
    const app = makeApp();
    const longArgs = '--no-mtime '.repeat(200);
    const res = await supertest(app).post('/api/ytdlp/validate-args').send({ args: longArgs });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/2000/);
  });

  test('returns 400 on parse error', async () => {
    const app = makeApp();
    const res = await supertest(app)
      .post('/api/ytdlp/validate-args')
      .send({ args: '--user-agent \'unterminated' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/parse error/i);
  });

  test('returns 400 with the offending flag on denylisted input', async () => {
    const app = makeApp();
    const res = await supertest(app)
      .post('/api/ytdlp/validate-args')
      .send({ args: '--exec rm' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('--exec');
  });

  test('returns 200 { ok: true } when dryRun succeeds', async () => {
    ytdlpValidator.dryRun.mockResolvedValueOnce({ ok: true, stderr: '' });
    const app = makeApp();
    const res = await supertest(app)
      .post('/api/ytdlp/validate-args')
      .send({ args: '--no-mtime' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, message: 'Arguments parsed successfully' });
    expect(ytdlpValidator.dryRun).toHaveBeenCalledWith(['--no-mtime']);
  });

  test('returns 200 { ok: false, stderr } when yt-dlp argparse fails', async () => {
    ytdlpValidator.dryRun.mockResolvedValueOnce({
      ok: false,
      stderr: 'yt-dlp: error: no such option: --bogus',
    });
    const app = makeApp();
    const res = await supertest(app)
      .post('/api/ytdlp/validate-args')
      .send({ args: '--bogus' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.stderr).toContain('--bogus');
  });
});

describe('POST /api/ytdlp/test-hardware-capabilities', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns 401 when verifyToken rejects', async () => {
    const app = makeApp({
      verifyToken: (_req, res) => res.status(401).json({ error: 'unauthorized' }),
    });
    const res = await supertest(app).post('/api/ytdlp/test-hardware-capabilities').send({});
    expect(res.status).toBe(401);
    expect(hardwareCapabilityTester.testAllCapabilities).not.toHaveBeenCalled();
  });

  test('returns 200 with both the encode matrix and the decode matrix', async () => {
    const matrix = { none: { h264: { ok: true } } };
    const decodeMatrix = { none: { h264: { ok: true } }, vaapi: { vp9: { ok: false, error: 'no device' } } };
    hardwareCapabilityTester.testAllCapabilities.mockResolvedValueOnce({ matrix, decodeMatrix });

    const app = makeApp();
    const res = await supertest(app).post('/api/ytdlp/test-hardware-capabilities').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, matrix, decodeMatrix });
  });

  test('returns 500 with an error message when the test throws', async () => {
    hardwareCapabilityTester.testAllCapabilities.mockRejectedValueOnce(new Error('ffmpeg not found'));
    const app = makeApp();
    const res = await supertest(app).post('/api/ytdlp/test-hardware-capabilities').send({});
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'ffmpeg not found' });
  });
});

describe('POST /api/ytdlp/test-tuning-benchmark', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns 401 when verifyToken rejects', async () => {
    const app = makeApp({
      verifyToken: (_req, res) => res.status(401).json({ error: 'unauthorized' }),
    });
    const res = await supertest(app).post('/api/ytdlp/test-tuning-benchmark').send({ hardwareMode: 'none' });
    expect(res.status).toBe(401);
    expect(streamTuningBenchmark.runBenchmark).not.toHaveBeenCalled();
  });

  test('returns 400 when hardwareMode is missing or invalid', async () => {
    const app = makeApp();
    const missing = await supertest(app).post('/api/ytdlp/test-tuning-benchmark').send({});
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/hardwareMode/);

    const invalid = await supertest(app).post('/api/ytdlp/test-tuning-benchmark').send({ hardwareMode: 'bogus' });
    expect(invalid.status).toBe(400);
    expect(streamTuningBenchmark.runBenchmark).not.toHaveBeenCalled();
  });

  test('returns 409 when a benchmark is already running', async () => {
    streamTuningBenchmark.isBenchmarkRunning.mockReturnValueOnce(true);
    const app = makeApp();
    const res = await supertest(app).post('/api/ytdlp/test-tuning-benchmark').send({ hardwareMode: 'none' });
    expect(res.status).toBe(409);
    expect(streamTuningBenchmark.runBenchmark).not.toHaveBeenCalled();
  });

  test('returns 200 with the matrix and recommendation map, scoped to the requested hardwareMode', async () => {
    const matrix = { 1080: { fast: { ok: true, realtime: true } } };
    const recommended = { 1080: 'fast' };
    streamTuningBenchmark.runBenchmark.mockResolvedValueOnce({
      matrix, recommended, decodeMode: 'none', sourceCodec: null, videoCodec: 'h264', decodeSourceHeight: 2160,
    });

    const app = makeApp();
    const res = await supertest(app).post('/api/ytdlp/test-tuning-benchmark').send({ hardwareMode: 'qsv' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true, hardwareMode: 'qsv', matrix, recommended, vaapiQuality: null,
      decodeMode: 'none', sourceCodec: null, videoCodec: 'h264', decodeSourceHeight: 2160,
    });
    expect(streamTuningBenchmark.runBenchmark).toHaveBeenCalledWith('qsv', [480, 720, 1080, 1440, 2160], {
      vaapiQuality: null, decodeMode: 'none', sourceCodec: 'h264', videoCodec: 'h264', decodeSourceHeight: null,
    });
  });

  test('returns 400 when decodeMode is present but invalid', async () => {
    const app = makeApp();
    const res = await supertest(app).post('/api/ytdlp/test-tuning-benchmark').send({ hardwareMode: 'none', decodeMode: 'amf' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/decodeMode/);
    expect(streamTuningBenchmark.runBenchmark).not.toHaveBeenCalled();
  });

  test('returns 400 when videoCodec is present but invalid', async () => {
    const app = makeApp();
    const res = await supertest(app).post('/api/ytdlp/test-tuning-benchmark').send({ hardwareMode: 'none', videoCodec: 'vp9' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/videoCodec/);
    expect(streamTuningBenchmark.runBenchmark).not.toHaveBeenCalled();
  });

  test('returns 400 when decodeSourceHeight is present but not one of the tested resolutions', async () => {
    const app = makeApp();
    const res = await supertest(app).post('/api/ytdlp/test-tuning-benchmark').send({ hardwareMode: 'none', decodeSourceHeight: 900 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/decodeSourceHeight/);
    expect(streamTuningBenchmark.runBenchmark).not.toHaveBeenCalled();
  });

  test('passes decodeMode/sourceCodec/videoCodec/decodeSourceHeight through to runBenchmark, echoing them back in the response', async () => {
    const matrix = { 1080: { fast: { ok: true, realtime: true } } };
    const recommended = { 1080: 'fast' };
    streamTuningBenchmark.runBenchmark.mockResolvedValueOnce({
      matrix, recommended, decodeMode: 'vaapi', sourceCodec: 'vp9', videoCodec: 'hevc', decodeSourceHeight: 1080,
    });

    const app = makeApp();
    const res = await supertest(app)
      .post('/api/ytdlp/test-tuning-benchmark')
      .send({ hardwareMode: 'none', decodeMode: 'vaapi', sourceCodec: 'vp9', videoCodec: 'hevc', decodeSourceHeight: 1080 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ decodeMode: 'vaapi', sourceCodec: 'vp9', videoCodec: 'hevc', decodeSourceHeight: 1080 }));
    expect(streamTuningBenchmark.runBenchmark).toHaveBeenCalledWith('none', [480, 720, 1080, 1440, 2160], {
      vaapiQuality: null, decodeMode: 'vaapi', sourceCodec: 'vp9', videoCodec: 'hevc', decodeSourceHeight: 1080,
    });
  });

  test('returns 500 with an error message when the benchmark throws', async () => {
    streamTuningBenchmark.runBenchmark.mockRejectedValueOnce(new Error('ffmpeg not found'));
    const app = makeApp();
    const res = await supertest(app).post('/api/ytdlp/test-tuning-benchmark').send({ hardwareMode: 'none' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'ffmpeg not found' });
  });
});

describe('POST /api/ytdlp/test-segment-timing', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns 401 when verifyToken rejects', async () => {
    const app = makeApp({
      verifyToken: (_req, res) => res.status(401).json({ error: 'unauthorized' }),
    });
    const res = await supertest(app).post('/api/ytdlp/test-segment-timing').send({ hardwareMode: 'none' });
    expect(res.status).toBe(401);
    expect(streamTuningBenchmark.testSegmentTiming).not.toHaveBeenCalled();
  });

  test('returns 400 when hardwareMode is missing or invalid', async () => {
    const app = makeApp();
    const missing = await supertest(app).post('/api/ytdlp/test-segment-timing').send({});
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/hardwareMode/);
    expect(streamTuningBenchmark.testSegmentTiming).not.toHaveBeenCalled();
  });

  test('returns 409 when a benchmark is already running', async () => {
    streamTuningBenchmark.isBenchmarkRunning.mockReturnValueOnce(true);
    const app = makeApp();
    const res = await supertest(app).post('/api/ytdlp/test-segment-timing').send({ hardwareMode: 'none' });
    expect(res.status).toBe(409);
    expect(streamTuningBenchmark.testSegmentTiming).not.toHaveBeenCalled();
  });

  test('on a passing result, persists forceKeyframesByHardwareMode[hardwareMode]=true and returns enabled:true', async () => {
    streamTuningBenchmark.testSegmentTiming.mockResolvedValueOnce({
      ok: true, measuredSeconds: [4.01, 3.99, 4.0], averageSeconds: 4.0, maxDeviationSeconds: 0.01,
    });
    configModule.getConfig.mockReturnValueOnce({ someOtherField: 1, ytstream: { existingField: true, forceKeyframesByHardwareMode: { qsv: false } } });

    const app = makeApp();
    const res = await supertest(app).post('/api/ytdlp/test-segment-timing').send({ hardwareMode: 'vaapi' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true, hardwareMode: 'vaapi', enabled: true,
      measuredSeconds: [4.01, 3.99, 4.0], averageSeconds: 4.0, maxDeviationSeconds: 0.01, error: undefined,
    });
    expect(configModule.updateConfig).toHaveBeenCalledWith({
      someOtherField: 1,
      ytstream: { existingField: true, forceKeyframesByHardwareMode: { qsv: false, vaapi: true } },
    });
  });

  test('on a failing result, persists forceKeyframesByHardwareMode[hardwareMode]=false and returns enabled:false with the error', async () => {
    streamTuningBenchmark.testSegmentTiming.mockResolvedValueOnce({
      ok: false, measuredSeconds: [4.8, 4.79], averageSeconds: 4.8, maxDeviationSeconds: 0.8,
    });

    const app = makeApp();
    const res = await supertest(app).post('/api/ytdlp/test-segment-timing').send({ hardwareMode: 'none' });

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(configModule.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ ytstream: expect.objectContaining({ forceKeyframesByHardwareMode: { none: false } }) })
    );
  });

  test('returns 500 with an error message when the test throws', async () => {
    streamTuningBenchmark.testSegmentTiming.mockRejectedValueOnce(new Error('ffmpeg not found'));
    const app = makeApp();
    const res = await supertest(app).post('/api/ytdlp/test-segment-timing').send({ hardwareMode: 'none' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'ffmpeg not found' });
    expect(configModule.updateConfig).not.toHaveBeenCalled();
  });
});

describe('POST /api/ytdlp/validate-args — rate limiter wiring', () => {
  test('invokes the provided rate limiter middleware before the handler', async () => {
    const limiter = jest.fn((_req, res) =>
      res.status(429).json({ error: 'too many' })
    );
    const app = express();
    app.use(express.json());
    app.use(createYtdlpOptionsRoutes({
      verifyToken: (_req, _res, next) => next(),
      ytdlpValidationRateLimiter: limiter,
    }));
    const res = await supertest(app)
      .post('/api/ytdlp/validate-args')
      .send({ args: '--no-mtime' });
    expect(res.status).toBe(429);
    expect(limiter).toHaveBeenCalled();
  });
});
