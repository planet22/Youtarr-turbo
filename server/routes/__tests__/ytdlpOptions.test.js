/* eslint-env jest */
const express = require('express');
const supertest = require('supertest');

jest.mock('../../modules/download/ytdlpValidator', () => ({
  dryRun: jest.fn(),
}));
jest.mock('../../modules/streamTuningBenchmark', () => ({
  runBenchmark: jest.fn(),
  isBenchmarkRunning: jest.fn().mockReturnValue(false),
}));

const ytdlpValidator = require('../../modules/download/ytdlpValidator');
const streamTuningBenchmark = require('../../modules/streamTuningBenchmark');
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
    streamTuningBenchmark.runBenchmark.mockResolvedValueOnce({ matrix, recommended });

    const app = makeApp();
    const res = await supertest(app).post('/api/ytdlp/test-tuning-benchmark').send({ hardwareMode: 'qsv' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, hardwareMode: 'qsv', matrix, recommended });
    expect(streamTuningBenchmark.runBenchmark).toHaveBeenCalledWith('qsv', [480, 720, 1080, 1440, 2160], { vaapiQuality: null });
  });

  test('returns 500 with an error message when the benchmark throws', async () => {
    streamTuningBenchmark.runBenchmark.mockRejectedValueOnce(new Error('ffmpeg not found'));
    const app = makeApp();
    const res = await supertest(app).post('/api/ytdlp/test-tuning-benchmark').send({ hardwareMode: 'none' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'ffmpeg not found' });
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
