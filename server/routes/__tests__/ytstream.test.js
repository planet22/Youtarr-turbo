const path = require('path');
const os = require('os');
const fs = require('fs');
const express = require('express');
const { findRouteHandler } = require('../../__tests__/testUtils');

// ytstream.js requires child_process at the top for ffmpeg/yt-dlp process
// management. Only isFfmpegAvailable() (via spawnSync) is reachable from the
// cheap/metadata-only endpoints under test here - spawn() (real streaming)
// never fires. IMPORTANT: isFfmpegAvailable() caches a `true` result forever
// in a module-level variable (never caches `false`) - see the ordering note
// on the /simulate describe block below.
jest.mock('child_process', () => ({
  spawn: jest.fn(),
  spawnSync: jest.fn(),
}));
const { spawnSync } = require('child_process');

jest.mock('../../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// directoryPath is read once at module-load time (below) to build the
// on-disk untracked-cache directory constants, so it must be set on the
// mock before requiring routes/ytstream.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ytstream-test-'));
jest.mock('../../modules/configModule', () => ({
  getConfig: jest.fn(),
  getCookiesPath: jest.fn().mockReturnValue(null),
  directoryPath: '',
}));
const configModule = require('../../modules/configModule');
configModule.directoryPath = TEST_DATA_DIR;

jest.mock('../../modules/ytDlpRunner', () => ({ run: jest.fn() }));
const ytDlpRunner = require('../../modules/ytDlpRunner');

jest.mock('../../modules/download/ytdlpCommandBuilder', () => ({
  buildCommonArgs: jest.fn().mockReturnValue([]),
}));

jest.mock('../../modules/youtubeMetadataCache', () => ({
  deleteEntry: jest.fn(),
  getCacheDetail: jest.fn(),
  countCached: jest.fn(),
  clearAll: jest.fn(),
}));
const youtubeMetadataCache = require('../../modules/youtubeMetadataCache');

const createYtStreamRoutes = require('../../routes/ytstream');

// Mirrors YTSTREAM_CACHE_DIR/YTSTREAM_CLIPS_DIR/HLS_UNTRACKED_BUFFER_CACHE_DIR
// in routes/ytstream.js - not exported, so the test rebuilds the same path
// from the same configModule.directoryPath to exercise it as a real
// directory on disk instead of mocking `fs`.
const UNTRACKED_CACHE_DIR = path.join(
  TEST_DATA_DIR,
  '.youtarr_ytstream_cache',
  'ytstream-clips',
  'hls-buffer-untracked-cache'
);

function buildModels(overrides = {}) {
  return {
    Video: { findAll: jest.fn().mockResolvedValue([]), findOne: jest.fn().mockResolvedValue(null) },
    StreamHistory: {
      update: jest.fn().mockResolvedValue([0]),
      findAndCountAll: jest.fn().mockResolvedValue({ count: 0, rows: [] }),
      destroy: jest.fn().mockResolvedValue(0),
    },
    YoutubeMetadataCache: {
      findAll: jest.fn().mockResolvedValue([]),
      findByPk: jest.fn().mockResolvedValue(null),
      destroy: jest.fn().mockResolvedValue(0),
    },
    ...overrides,
  };
}

function getHandler(method, routePath, models = buildModels()) {
  const router = createYtStreamRoutes({
    verifyToken: (req, res, next) => next(),
    getClientAddress: (req) => req.socket?.remoteAddress || '127.0.0.1',
    models,
  });
  const app = express();
  app.use(router);
  return findRouteHandler(app, method, routePath);
}

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  res.send = jest.fn(() => res);
  res.type = jest.fn(() => res);
  res.set = jest.fn(() => res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  configModule.getConfig.mockReturnValue({ ytstream: {} });
  fs.rmSync(UNTRACKED_CACHE_DIR, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('GET /api/ytstream/mode-compatibility', () => {
  const call = (query) => {
    const handler = getHandler('get', '/api/ytstream/mode-compatibility');
    const req = { query };
    const res = mockRes();
    handler(req, res);
    return res;
  };

  test('mode=direct: encode-only fields are ignored, calculatedLength is ignored', () => {
    const res = call({ mode: 'direct' });
    const body = res.json.mock.calls[0][0];
    expect(body.calculatedLength.status).toBe('ignored');
    expect(body.container.status).toBe('ignored');
    expect(body.transcode.status).toBe('ignored');
    expect(body.hardwareMode.status).toBe('ignored');
    expect(body.tuning.status).toBe('ignored');
    expect(body.probeShortcut.status).toBe('ignored');
  });

  test('mode=hls, transcode=copy: calculatedLength forced, encoder fields ignored (copy never encodes)', () => {
    const res = call({ mode: 'hls', transcode: 'copy' });
    const body = res.json.mock.calls[0][0];
    expect(body.calculatedLength.status).toBe('forced');
    expect(body.container.status).toBe('optional');
    expect(body.transcode.status).toBe('optional');
    expect(body.hardwareMode.status).toBe('ignored');
    expect(body.tuning.status).toBe('ignored');
    expect(body.hotSwapToCache.status).toBe('optional');
    expect(body.cacheOnPlay.status).toBe('optional');
  });

  test('mode=hls, transcode=h264: hardware/tuning become optional, probeShortcut becomes optional', () => {
    const res = call({ mode: 'hls', transcode: 'h264' });
    const body = res.json.mock.calls[0][0];
    expect(body.hardwareMode.status).toBe('optional');
    expect(body.tuning.status).toBe('optional');
    expect(body.probeShortcut.status).toBe('optional');
  });

  test('mode=hls-buffer: hotSwapToCache and cacheOnPlay are ignored, finalizeToMp4/stealthCache are optional', () => {
    const res = call({ mode: 'hls-buffer', transcode: 'copy' });
    const body = res.json.mock.calls[0][0];
    expect(body.hotSwapToCache.status).toBe('ignored');
    expect(body.cacheOnPlay.status).toBe('ignored');
    expect(body.finalizeToMp4.status).toBe('optional');
    expect(body.stealthCache.status).toBe('optional');
    expect(body.backfillMissingSegments.status).toBe('optional');
  });

  test('mode=youtube-hls: every encode-related field is ignored (nothing is encoded or wrapped locally)', () => {
    const res = call({ mode: 'youtube-hls', transcode: 'h264' });
    const body = res.json.mock.calls[0][0];
    expect(body.container.status).toBe('ignored');
    expect(body.transcode.status).toBe('ignored');
    expect(body.hardwareMode.status).toBe('ignored');
    expect(body.tuning.status).toBe('ignored');
    expect(body.calculatedLength.status).toBe('ignored');
    expect(body.hlsMasterPlaylist.status).toBe('ignored');
  });

  test.each(['hls-byterange', 'download-cache', 'youtube-hls'])('mode=%s: cacheOnPlay is ignored (experimental modes are intercepted before cache-on-play runs)', (mode) => {
    const res = call({ mode, transcode: 'copy' });
    const body = res.json.mock.calls[0][0];
    expect(body.cacheOnPlay.status).toBe('ignored');
  });

  test('defaults to mode=direct when no query params are given', () => {
    const res = call({});
    const body = res.json.mock.calls[0][0];
    expect(body.calculatedLength.status).toBe('ignored');
    expect(body.container.status).toBe('ignored');
  });
});

describe('youtube-hls proxy routes (playlists and segment redirects)', () => {
  const runHandler = (routePath, params) => {
    const handler = getHandler('get', routePath);
    const res = mockRes();
    res.redirect = jest.fn();
    res.send = res.send || jest.fn();
    handler({ params, headers: {} }, res);
    return res;
  };

  test('registers a public playlist route', () => {
    expect(() => getHandler('get', '/api/ytstream/:youtubeId/yth/:key/:file')).not.toThrow();
  });

  test('registers a public segment route', () => {
    expect(() => getHandler('get', '/api/ytstream/:youtubeId/yth/:key/:kind/:file')).not.toThrow();
  });

  test('answers 404 for a playlist that was never registered', () => {
    const res = runHandler('/api/ytstream/:youtubeId/yth/:key/:file', { youtubeId: 'abc123XYZ_', key: 'ythp-00000000000000000000', file: 'video.m3u8' });
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('rejects a malformed key with 400', () => {
    const res = runHandler('/api/ytstream/:youtubeId/yth/:key/:file', { youtubeId: 'abc123XYZ_', key: '../secret', file: 'video.m3u8' });
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('never redirects a segment request for an unregistered playlist', () => {
    const res = runHandler('/api/ytstream/:youtubeId/yth/:key/:kind/:file', { youtubeId: 'abc123XYZ_', key: 'ythp-00000000000000000000', kind: 'video', file: 's0.ts' });
    expect(res.redirect).not.toHaveBeenCalled();
  });
});

describe('GET /api/ytstream/:youtubeId/simulate', () => {
  const VALID_ID = 'abc123XYZ_';

  const call = async (query, { headers = {} } = {}) => {
    const handler = getHandler('get', '/api/ytstream/:youtubeId/simulate');
    const req = { params: { youtubeId: VALID_ID }, query, headers };
    const res = mockRes();
    await handler(req, res);
    return res;
  };

  // Runs first and deliberately does NOT let isFfmpegAvailable() cache
  // `true` - see the module-mock comment at the top of this file. Every
  // later test in this describe block assumes ffmpeg IS available.
  test('mode=hls blocked outright (502-equivalent) when ffmpeg is unavailable, no fallback to another mode', async () => {
    spawnSync.mockReturnValue({ error: new Error('ENOENT'), status: null });
    configModule.getConfig.mockReturnValue({ ytstream: { mode: 'hls', defaultMode: 'hls' } });
    const res = await call({ mode: 'hls' });
    const body = res.json.mock.calls[0][0];
    expect(body.plan.ffmpegAvailable).toBe(false);
    expect(body.wouldCall).toMatch(/requires ffmpeg/i);
  });

  test('rejects a malformed youtubeId before touching config', async () => {
    spawnSync.mockReturnValue({ error: null, status: 0 });
    const handler = getHandler('get', '/api/ytstream/:youtubeId/simulate');
    const req = { params: { youtubeId: '!!' }, query: {}, headers: {} };
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('default config (mode unset) resolves to mode=direct, ignoring container/transcode', async () => {
    spawnSync.mockReturnValue({ error: null, status: 0 });
    configModule.getConfig.mockReturnValue({ ytstream: {}, preferredResolution: '720' });
    const res = await call({});
    const body = res.json.mock.calls[0][0];
    expect(body.plan.mode).toBe('direct');
    expect(body.plan.container).toBe('mp4');
    expect(body.plan.transcode).toBe('copy');
    expect(body.plan.quality).toBe('720');
    expect(body.wouldCall).toMatch(/serveDirect/);
  });

  describe('experimental modes (their own dry run, never resolvePlaybackPlan)', () => {
    const configFor = (ytstream) => configModule.getConfig.mockReturnValue({ ytstream, preferredResolution: '720' });

    test('mode=youtube-hls reports itself as experimental with what it would call', async () => {
      configFor({ defaultMode: 'youtube-hls', quality: '1080', audioLanguage: 'de' });
      const res = await call({});
      const body = res.json.mock.calls[0][0];
      expect([body.experimental, body.mode]).toEqual([true, 'youtube-hls']);
      expect(body.wouldCall).toMatch(/getPlaylist/);
    });

    test('mode=youtube-hls shows the configured routing mode', async () => {
      configFor({ defaultMode: 'youtube-hls', quality: '1080', youtubeHlsProxy: 'serve' });
      const body = (await call({})).json.mock.calls[0][0];
      expect(body.settings.hlsProxy).toBe('serve');
      expect(body.wouldCall).toMatch(/redirects \(302\)/);
    });

    test('mode=youtube-hls treats an unknown routing value as off', async () => {
      configFor({ defaultMode: 'youtube-hls', quality: '1080', youtubeHlsProxy: 'bogus' });
      expect((await call({})).json.mock.calls[0][0].settings.hlsProxy).toBe('off');
    });

    test('mode=youtube-hls shows the configured audio language and the settings it ignores', async () => {
      configFor({ defaultMode: 'youtube-hls', quality: '1080', audioLanguage: 'de' });
      const body = (await call({})).json.mock.calls[0][0];
      expect(body.settings.audioLanguage).toBe('de');
      expect(body.ignoredSettings).toEqual(expect.arrayContaining(['container', 'transcode']));
    });

    test('mode=youtube-hls without probe does no network work and says the playlist is not cached yet', async () => {
      configFor({ defaultMode: 'youtube-hls', quality: '480' });
      const body = (await call({ probe: undefined })).json.mock.calls[0][0];
      expect([body.playlistCached, body.choice]).toEqual([false, undefined]);
    });

    test('mode=hls-byterange reports the session key and starting a fresh encode when nothing is cached', async () => {
      configFor({ defaultMode: 'hls-byterange', quality: '1080', byteRangeDeliverAsFile: true });
      const body = (await call({})).json.mock.calls[0][0];
      expect(body.sessionKey).toMatch(/^[a-f0-9]{20}$/);
      expect(body.wouldCall).toMatch(/fresh encode/);
    });

    test('mode=hls-byterange reflects Matroska when the container is mkv', async () => {
      configFor({ defaultMode: 'hls-byterange', quality: '1080', byteRangeDeliverAsFile: true, container: 'mkv' });
      const body = (await call({})).json.mock.calls[0][0];
      expect(body.settings.container).toBe('mkv');
    });

    test('the response never includes the full config or the caller identity', async () => {
      configFor({ defaultMode: 'hls-byterange', quality: '1080', byteRangeDeliverAsFile: true });
      const body = (await call({})).json.mock.calls[0][0];
      expect(Object.keys(body.requested)).not.toEqual(expect.arrayContaining(['config']));
      expect(Object.keys(body.requested)).not.toEqual(expect.arrayContaining(['clientIp']));
    });

    test('a normal mode still gets the plan-based dry run', async () => {
      configFor({ defaultMode: 'hls' });
      spawnSync.mockReturnValue({ error: null, status: 0 });
      const body = (await call({})).json.mock.calls[0][0];
      expect(body.plan.mode).toBe('hls');
      expect(body.experimental).toBeUndefined();
    });
  });

  test('an invalid requested mode falls back to the currently configured default, not hardcoded direct', async () => {
    configModule.getConfig.mockReturnValue({ ytstream: { defaultMode: 'hls' } });
    const res = await call({ mode: 'not-a-real-mode' });
    const body = res.json.mock.calls[0][0];
    expect(body.plan.mode).toBe('hls');
    expect(body.plan.requestedMode).toBe('not-a-real-mode');
  });

  test('an invalid requested mode falls back to hardcoded direct when the configured default is also invalid', async () => {
    configModule.getConfig.mockReturnValue({ ytstream: { defaultMode: 'not-real-either' } });
    const res = await call({ mode: 'still-not-real' });
    const body = res.json.mock.calls[0][0];
    expect(body.plan.mode).toBe('direct');
  });

  test('forceServerSettings=true ignores every query override and reports which ones were ignored', async () => {
    configModule.getConfig.mockReturnValue({
      ytstream: { forceServerSettings: true, defaultMode: 'direct-redirect', quality: '480' },
    });
    const res = await call({ mode: 'hls', quality: '1080' });
    const body = res.json.mock.calls[0][0];
    expect(body.plan.mode).toBe('direct-redirect');
    expect(body.plan.quality).toBe('480');
    expect(body.plan.forceServerSettings).toBe(true);
    expect(body.plan.ignoredQueryParams).toEqual(expect.arrayContaining(['mode', 'quality']));
  });

  test('forceServerSettings=false (default) honors query overrides', async () => {
    configModule.getConfig.mockReturnValue({ ytstream: { mode: 'direct', quality: '480' } });
    const res = await call({ quality: '1080' });
    const body = res.json.mock.calls[0][0];
    expect(body.plan.quality).toBe('1080');
    expect(body.plan.forceServerSettings).toBe(false);
    expect(body.plan.ignoredQueryParams).toEqual([]);
  });

  test('an invalid qualityStrictness falls back to the configured value instead of hardcoded "fallback"', async () => {
    configModule.getConfig.mockReturnValue({ ytstream: { mode: 'hls', qualityStrictness: 'fixed' } });
    const res = await call({ qualityStrictness: 'bogus' });
    const body = res.json.mock.calls[0][0];
    expect(body.plan.qualityStrictness).toBe('fixed');
  });

  test('direct-family modes report container/transcode/hardware/tuning as ignored', async () => {
    configModule.getConfig.mockReturnValue({ ytstream: { mode: 'direct' } });
    const res = await call({});
    const body = res.json.mock.calls[0][0];
    const step = body.plan.steps.find((s) => s.step === 'container/transcode/hardwareMode/tuning');
    expect(step.detail).toMatch(/ignored/i);
  });

  test('mode=hls resolves a deterministic session key and reports getOrCreateHlsSession as the call it would make', async () => {
    configModule.getConfig.mockReturnValue({ ytstream: { defaultMode: 'hls', transcode: 'copy' } });
    const res = await call({});
    const body = res.json.mock.calls[0][0];
    expect(body.hls).toEqual(expect.objectContaining({ sessionAlreadyActive: false }));
    expect(typeof body.hls.sessionKey).toBe('string');
    expect(body.wouldCall).toMatch(/getOrCreateHlsSession/);
  });

  test('mode=direct-redirect reports a 302 redirect with no proxying', async () => {
    configModule.getConfig.mockReturnValue({ ytstream: { defaultMode: 'direct-redirect' } });
    const res = await call({});
    const body = res.json.mock.calls[0][0];
    expect(body.wouldCall).toMatch(/redirectToDirectUrl/);
  });

  test('probeShortcut fires only when enabled, request looks like a metadata probe, mode transcodes, and transcode=h264', async () => {
    configModule.getConfig.mockReturnValue({
      ytstream: { probeShortcut: true, defaultMode: 'hls', transcode: 'h264' },
    });
    const res = await call({}, { headers: { 'user-agent': 'Lavf/60.16.100' } });
    const body = res.json.mock.calls[0][0];
    expect(body.plan.probeShortcut.wouldFire).toBe(true);
    expect(body.wouldCall).toMatch(/probeShortcut/);
  });

  test('probeShortcut does not fire for mode=direct even with a matching UA and transcode=h264 leftover', async () => {
    configModule.getConfig.mockReturnValue({
      ytstream: { probeShortcut: true, defaultMode: 'direct', transcode: 'h264' },
    });
    const res = await call({}, { headers: { 'user-agent': 'Lavf/60.16.100' } });
    const body = res.json.mock.calls[0][0];
    expect(body.plan.probeShortcut.wouldFire).toBe(false);
    expect(body.plan.probeShortcut.reason).toMatch(/never transcodes/);
  });

  test('probeShortcut does not fire for a normal (non-Lavf) user agent', async () => {
    configModule.getConfig.mockReturnValue({
      ytstream: { probeShortcut: true, defaultMode: 'hls', transcode: 'h264' },
    });
    const res = await call({}, { headers: { 'user-agent': 'Mozilla/5.0' } });
    const body = res.json.mock.calls[0][0];
    expect(body.plan.probeShortcut.wouldFire).toBe(false);
  });
});

describe('GET /api/ytstream/streams', () => {
  test('returns an empty list when nothing is actively streaming', async () => {
    const models = buildModels();
    const handler = getHandler('get', '/api/ytstream/streams', models);
    const req = {};
    const res = mockRes();
    await handler(req, res);
    expect(res.json).toHaveBeenCalledWith({ streams: [], byteRangeSessions: { total: 0, encoding: 0, finished: 0 } });
    expect(models.Video.findAll).not.toHaveBeenCalled();
  });
});

describe('POST /api/ytstream/streams/:streamId/stop', () => {
  test('404s for a stream that is not (or is no longer) active', () => {
    const handler = getHandler('post', '/api/ytstream/streams/:streamId/stop');
    const req = { params: { streamId: 'does-not-exist' } };
    const res = mockRes();
    handler(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Stream not found' });
  });
});

describe('GET /api/ytstream/history', () => {
  test('returns an empty page when StreamHistory is unavailable', async () => {
    const models = buildModels({ StreamHistory: undefined });
    const handler = getHandler('get', '/api/ytstream/history', models);
    const req = { query: {} };
    const res = mockRes();
    await handler(req, res);
    expect(res.json).toHaveBeenCalledWith({ rows: [], total: 0, page: 1, limit: 25 });
  });

  test('maps rows, resolves titles from Video, and clamps limit to 128', async () => {
    const models = buildModels();
    models.StreamHistory.findAndCountAll.mockResolvedValue({
      count: 1,
      rows: [{
        stream_id: 's1', youtube_id: 'vid1', mode: 'hls', quality: '1080', container: 'mp4',
        transcode: 'copy', hardware_mode: 'none', client_ip: '1.2.3.4', user_agent: 'UA',
        started_at: new Date('2026-01-01'), ended_at: null, bytes_transferred: 123n,
        end_reason: null, error_message: null,
      }],
    });
    models.Video.findAll.mockResolvedValue([{ youtubeId: 'vid1', youTubeVideoName: 'My Video' }]);

    const handler = getHandler('get', '/api/ytstream/history', models);
    const req = { query: { limit: '9999', page: '1' } };
    const res = mockRes();
    await handler(req, res);

    expect(models.StreamHistory.findAndCountAll).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 128 })
    );
    const body = res.json.mock.calls[0][0];
    expect(body.rows[0]).toEqual(expect.objectContaining({ youtubeId: 'vid1', title: 'My Video', bytesTransferred: 123 }));
  });

  test('"in-progress" status filters on ended_at IS NULL rather than a literal end_reason', async () => {
    const models = buildModels();
    const handler = getHandler('get', '/api/ytstream/history', models);
    const req = { query: { status: 'in-progress' } };
    const res = mockRes();
    await handler(req, res);
    expect(models.StreamHistory.findAndCountAll).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ ended_at: null }) })
    );
  });

  test('responds 500 when the query fails', async () => {
    const models = buildModels();
    models.StreamHistory.findAndCountAll.mockRejectedValue(new Error('db down'));
    const handler = getHandler('get', '/api/ytstream/history', models);
    const req = { query: {} };
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('DELETE /api/ytstream/history', () => {
  test('requires a non-empty streamIds array', async () => {
    const handler = getHandler('delete', '/api/ytstream/history');
    const req = { body: {} };
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('deletes the given stream ids', async () => {
    const models = buildModels();
    models.StreamHistory.destroy.mockResolvedValue(2);
    const handler = getHandler('delete', '/api/ytstream/history', models);
    const req = { body: { streamIds: ['a', 'b'] } };
    const res = mockRes();
    await handler(req, res);
    expect(res.json).toHaveBeenCalledWith({ success: true, deleted: 2 });
  });
});

describe('metadata-cache routes', () => {
  test('DELETE /:youtubeId/metadata-cache clears the in-memory cache and the DB row', async () => {
    youtubeMetadataCache.deleteEntry.mockResolvedValue(1);
    const handler = getHandler('delete', '/api/ytstream/:youtubeId/metadata-cache', buildModels());
    const req = { params: { youtubeId: 'vid1' } };
    const res = mockRes();
    await handler(req, res);
    expect(youtubeMetadataCache.deleteEntry).toHaveBeenCalledWith('vid1');
    expect(res.json).toHaveBeenCalledWith({ success: true, deleted: 1 });
  });

  test('DELETE /metadata-cache/bulk clears every id and reports partial failures', async () => {
    youtubeMetadataCache.deleteEntry
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new Error('boom'));
    const handler = getHandler('delete', '/api/ytstream/metadata-cache/bulk', buildModels());
    const req = { body: { youtubeIds: ['ok-id', 'bad-id'] } };
    const res = mockRes();
    await handler(req, res);
    expect(res.json).toHaveBeenCalledWith({ success: true, deleted: 1, failed: ['bad-id'] });
  });

  test('GET /:youtubeId/metadata-cache/detail 404s when nothing is cached', async () => {
    youtubeMetadataCache.getCacheDetail.mockResolvedValue(null);
    const handler = getHandler('get', '/api/ytstream/:youtubeId/metadata-cache/detail', buildModels());
    const req = { params: { youtubeId: 'vid1' }, query: {} };
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('GET /:youtubeId/metadata-cache/detail parses raw_info_json and omits it unless raw=true', async () => {
    youtubeMetadataCache.getCacheDetail.mockResolvedValue({
      durationSeconds: 600,
      fetchedAt: new Date('2026-01-01'),
      lastAccessedAt: new Date('2026-01-02'),
      expiresAt: null,
      title: 'Hello',
      uploader: 'Chan',
      resolution: '1920x1080',
      fps: 30,
      uploadDate: null,
      hasRawInfoJson: true,
      rawInfoJson: { title: 'Hello', uploader: 'Chan', width: 1920, height: 1080, fps: 30 },
    });
    const handler = getHandler('get', '/api/ytstream/:youtubeId/metadata-cache/detail', buildModels());
    const req = { params: { youtubeId: 'vid1' }, query: {} };
    const res = mockRes();
    await handler(req, res);
    const body = res.json.mock.calls[0][0];
    expect(body.title).toBe('Hello');
    expect(body.resolution).toBe('1920x1080');
    expect(body.hasRawInfoJson).toBe(true);
    expect(body.rawInfoJson).toBeUndefined();
  });

  test('GET /:youtubeId/metadata-cache/detail includes rawInfoJson when raw=true', async () => {
    youtubeMetadataCache.getCacheDetail.mockResolvedValue({
      durationSeconds: 600,
      rawInfoJson: { title: 'Hello' },
    });
    const handler = getHandler('get', '/api/ytstream/:youtubeId/metadata-cache/detail', buildModels());
    const req = { params: { youtubeId: 'vid1' }, query: { raw: 'true' } };
    const res = mockRes();
    await handler(req, res);
    const body = res.json.mock.calls[0][0];
    expect(body.rawInfoJson).toEqual({ title: 'Hello' });
  });

  test('GET /metadata-cache returns the cached-row count', async () => {
    youtubeMetadataCache.countCached.mockResolvedValue(42);
    const handler = getHandler('get', '/api/ytstream/metadata-cache');
    const req = {};
    const res = mockRes();
    await handler(req, res);
    expect(res.json).toHaveBeenCalledWith({ count: 42 });
  });

  test('DELETE /metadata-cache clears everything', async () => {
    const handler = getHandler('delete', '/api/ytstream/metadata-cache');
    const req = {};
    const res = mockRes();
    await handler(req, res);
    expect(youtubeMetadataCache.clearAll).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });
});

describe('untracked-cache routes (real filesystem, temp dir)', () => {
  const writeFile = (relativePath, size = 10) => {
    const full = path.join(UNTRACKED_CACHE_DIR, relativePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.alloc(size));
    return full;
  };

  test('GET /untracked-cache reports 0/0 when the cache directory does not exist yet', async () => {
    const handler = getHandler('get', '/api/ytstream/untracked-cache');
    const req = {};
    const res = mockRes();
    await handler(req, res);
    expect(res.json).toHaveBeenCalledWith({ fileCount: 0, totalBytes: 0 });
  });

  test('GET /untracked-cache sums file count/bytes across the directory', async () => {
    writeFile('vid1.ts', 100);
    writeFile('vid2.mp4', 50);
    const handler = getHandler('get', '/api/ytstream/untracked-cache');
    const req = {};
    const res = mockRes();
    await handler(req, res);
    expect(res.json).toHaveBeenCalledWith({ fileCount: 2, totalBytes: 150 });
  });

  test('DELETE /untracked-cache removes every file and reports bytes freed', async () => {
    writeFile('vid1.ts', 100);
    writeFile('vid2.mp4', 50);
    const handler = getHandler('delete', '/api/ytstream/untracked-cache');
    const req = {};
    const res = mockRes();
    await handler(req, res);
    expect(res.json).toHaveBeenCalledWith({ success: true, deletedFiles: 2, freedBytes: 150 });
    expect(fs.readdirSync(UNTRACKED_CACHE_DIR)).toHaveLength(0);
  });

  test('GET /:youtubeId/untracked-cache prefers an .mp4 over a .ts for the same id', async () => {
    writeFile('vid1.ts', 999);
    writeFile('vid1.mp4', 42);
    const handler = getHandler('get', '/api/ytstream/:youtubeId/untracked-cache');
    const req = { params: { youtubeId: 'vid1' } };
    const res = mockRes();
    await handler(req, res);
    const body = res.json.mock.calls[0][0];
    expect(body.exists).toBe(true);
    expect(body.size).toBe(42);
  });

  test('GET /:youtubeId/untracked-cache reports not-exists when nothing is cached for this id', async () => {
    const handler = getHandler('get', '/api/ytstream/:youtubeId/untracked-cache');
    const req = { params: { youtubeId: 'missing' } };
    const res = mockRes();
    await handler(req, res);
    expect(res.json).toHaveBeenCalledWith({ exists: false, size: null, mtime: null });
  });

  test('DELETE /:youtubeId/untracked-cache deletes the file for that id (whichever extension it has)', async () => {
    writeFile('vid1.mp4', 5);
    const handler = getHandler('delete', '/api/ytstream/:youtubeId/untracked-cache');
    const req = { params: { youtubeId: 'vid1' } };
    const res = mockRes();
    await handler(req, res);
    expect(res.json).toHaveBeenCalledWith({ success: true, deleted: 1 });
    expect(fs.existsSync(path.join(UNTRACKED_CACHE_DIR, 'vid1.mp4'))).toBe(false);
  });

  test('DELETE /:youtubeId/untracked-cache reports deleted:0 when there was nothing to delete', async () => {
    const handler = getHandler('delete', '/api/ytstream/:youtubeId/untracked-cache');
    const req = { params: { youtubeId: 'missing' } };
    const res = mockRes();
    await handler(req, res);
    expect(res.json).toHaveBeenCalledWith({ success: true, deleted: 0 });
  });

  test('DELETE /untracked-cache/bulk deletes whichever extension (.ts or .mp4) each id actually has', async () => {
    writeFile('has-ts.ts', 10);
    writeFile('mp4-only.mp4', 20);
    const handler = getHandler('delete', '/api/ytstream/untracked-cache/bulk');
    const req = { body: { youtubeIds: ['has-ts', 'mp4-only'] } };
    const res = mockRes();
    await handler(req, res);
    const body = res.json.mock.calls[0][0];
    expect(body.deletedFiles).toBe(2);
    expect(body.freedBytes).toBe(30);
    expect(fs.existsSync(path.join(UNTRACKED_CACHE_DIR, 'has-ts.ts'))).toBe(false);
    expect(fs.existsSync(path.join(UNTRACKED_CACHE_DIR, 'mp4-only.mp4'))).toBe(false);
  });

  test('DELETE /untracked-cache/bulk prefers .mp4 over a sibling .ts for the same id, same as the per-video route', async () => {
    writeFile('both.ts', 999);
    writeFile('both.mp4', 5);
    const handler = getHandler('delete', '/api/ytstream/untracked-cache/bulk');
    const req = { body: { youtubeIds: ['both'] } };
    const res = mockRes();
    await handler(req, res);
    const body = res.json.mock.calls[0][0];
    expect(body.deletedFiles).toBe(1);
    expect(body.freedBytes).toBe(5);
    expect(fs.existsSync(path.join(UNTRACKED_CACHE_DIR, 'both.mp4'))).toBe(false);
    expect(fs.existsSync(path.join(UNTRACKED_CACHE_DIR, 'both.ts'))).toBe(true);
  });
});

describe('GET /api/ytstream/:youtubeId/formats', () => {
  test('rejects a malformed youtubeId', async () => {
    const handler = getHandler('get', '/api/ytstream/:youtubeId/formats');
    const req = { params: { youtubeId: '!!' } };
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('returns yt-dlp -F output as plain text', async () => {
    ytDlpRunner.run.mockResolvedValue('format list output');
    const handler = getHandler('get', '/api/ytstream/:youtubeId/formats');
    const req = { params: { youtubeId: 'abc123XYZ_' } };
    const res = mockRes();
    await handler(req, res);
    expect(res.type).toHaveBeenCalledWith('text/plain');
    expect(res.send).toHaveBeenCalledWith('format list output');
  });

  test('responds 502 when yt-dlp fails', async () => {
    ytDlpRunner.run.mockRejectedValue(new Error('yt-dlp exploded'));
    const handler = getHandler('get', '/api/ytstream/:youtubeId/formats');
    const req = { params: { youtubeId: 'abc123XYZ_' } };
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(502);
  });
});

describe('GET /api/ytstream/:youtubeId/byterange-hls/:sessionKey/progress', () => {
  let server;
  let baseUrl;

  beforeAll(async () => {
    const router = createYtStreamRoutes({
      verifyToken: (req, res, next) => next(),
      getClientAddress: (req) => req.socket?.remoteAddress || '127.0.0.1',
      models: buildModels(),
    });
    const app = express();
    app.use(router);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  test('is reached instead of being swallowed by the :filename asset route (unknown session is a 404 with a JSON error, not a 400)', async () => {
    const response = await fetch(`${baseUrl}/api/ytstream/abc123XYZ_/byterange-hls/${'a'.repeat(20)}/progress`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Session not found or expired' });
  });

  test('rejects a malformed session key with a JSON 400', async () => {
    const response = await fetch(`${baseUrl}/api/ytstream/abc123XYZ_/byterange-hls/not-a-key/progress`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid session key' });
  });
});
