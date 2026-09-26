/* eslint-env jest */

jest.mock('../../modules/filenamePreview', () => ({ previewTemplate: jest.fn(), validateTemplate: jest.fn() }));
jest.mock('../../modules/subscriptionImport/cookiesFetcher', () => ({ runYtdlp: jest.fn(), parseChannelEntries: jest.fn() }));
jest.mock('../../modules/videoSearchModule', () => ({ getNzbStats: jest.fn(), deleteCacheEntries: jest.fn() }));
jest.mock('../nzb', () => ({ getRecentSearchTraces: jest.fn(), getRecentFailedGrabs: jest.fn(), getNzbJobsSnapshot: jest.fn() }));
jest.mock('../../modules/nzbDiagnosticLog', () => ({
  countAllDiagnosticEvents: jest.fn(),
  clearAllDiagnosticEvents: jest.fn(),
  clearDiagnosticEvents: jest.fn(),
}));
jest.mock('../../modules/nzbThumbnailProbe', () => ({ countResolutionCache: jest.fn(), clearResolutionCache: jest.fn() }));
jest.mock('../../modules/notificationModule', () => ({ sendTestNotification: jest.fn(), sendTestNotificationToSingle: jest.fn() }));

const express = require('express');
const supertest = require('supertest');

const createConfigRoutes = require('../config');
const cookiesFetcher = require('../../modules/subscriptionImport/cookiesFetcher');
const videoSearchModule = require('../../modules/videoSearchModule');
const nzbRoutes = require('../nzb');
const nzbDiagnosticLog = require('../../modules/nzbDiagnosticLog');
const nzbThumbnailProbe = require('../../modules/nzbThumbnailProbe');
const notificationModule = require('../../modules/notificationModule');

const COOKIE_HEADER = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tabc\n';

function makeApp({ config = {}, envAuth = false, wsl = false, elfhosted = false } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    next();
  });
  const configModule = {
    _config: { passwordHash: 'hash', username: 'user', plexApiKey: 'key', ...config },
    getConfig: jest.fn(function () { return this._config; }),
    updateConfig: jest.fn(function (next) { this._config = next; }),
    getCookiesStatus: jest.fn().mockReturnValue({ hasCustom: false }),
    getCookiesPath: jest.fn(),
    isElfhostedPlatform: jest.fn(() => elfhosted),
    writeCustomCookiesFile: jest.fn(),
    deleteCustomCookiesFile: jest.fn(),
    getStorageStatus: jest.fn(),
  };
  app.use(createConfigRoutes({
    verifyToken: (req, _res, next) => next(),
    configModule,
    validateEnvAuthCredentials: () => envAuth,
    isWslEnvironment: wsl,
    filenamePreviewRateLimiter: (_req, _res, next) => next(),
  }));
  // eslint-disable-next-line no-unused-vars -- Express identifies error handlers by 4-arg arity.
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: err.message });
  });
  return { app, configModule };
}

describe('config routes: remaining endpoints', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    jest.resetAllMocks();
    delete process.env.DATA_PATH;
    delete process.env.PLEX_URL;
    delete process.env.AUTH_ENABLED;
    delete process.env.PLATFORM;
    delete process.env.YOUTUBE_OUTPUT_DIR;
  });

  afterAll(() => {
    process.env = savedEnv;
  });

  describe('GET /getconfig', () => {
    it('returns the config without credentials', async () => {
      const { app } = makeApp();

      const res = await supertest(app).get('/getconfig');

      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('passwordHash');
      expect(res.body).not.toHaveProperty('username');
      expect(res.body.plexApiKey).toBe('key');
    });

    it('does not mutate the stored config', async () => {
      const { app, configModule } = makeApp();

      await supertest(app).get('/getconfig');

      expect(configModule._config).toHaveProperty('passwordHash', 'hash');
    });

    it('flags nothing platform-managed by default', async () => {
      const { app } = makeApp();

      const res = await supertest(app).get('/getconfig');

      expect(res.body.isPlatformManaged).toEqual({
        youtubeOutputDirectory: false,
        plexUrl: false,
        authEnabled: true,
        useTmpForDownloads: false,
        ytdlpUpdates: false,
      });
    });

    it('flags settings managed by environment variables', async () => {
      process.env.DATA_PATH = '/data';
      process.env.PLEX_URL = 'http://plex';
      process.env.AUTH_ENABLED = 'false';
      const { app } = makeApp();

      const res = await supertest(app).get('/getconfig');

      expect(res.body.isPlatformManaged).toMatchObject({ youtubeOutputDirectory: true, plexUrl: true, authEnabled: false });
    });

    it('treats any other AUTH_ENABLED value as enabled', async () => {
      process.env.AUTH_ENABLED = 'true';
      const { app } = makeApp();

      const res = await supertest(app).get('/getconfig');

      expect(res.body.isPlatformManaged.authEnabled).toBe(true);
    });

    it('marks tmp downloads and yt-dlp updates managed on Elfhosted', async () => {
      const { app } = makeApp({ elfhosted: true });

      const res = await supertest(app).get('/getconfig');

      expect(res.body.isPlatformManaged).toMatchObject({ useTmpForDownloads: true, ytdlpUpdates: true });
    });

    it('reports the deployment platform and WSL flag', async () => {
      process.env.PLATFORM = 'synology';
      const { app } = makeApp({ wsl: true });

      const res = await supertest(app).get('/getconfig');

      expect(res.body.deploymentEnvironment).toEqual({ platform: 'synology', isWsl: true });
    });

    it('reports no platform when none is set', async () => {
      const { app } = makeApp();

      const res = await supertest(app).get('/getconfig');

      expect(res.body.deploymentEnvironment).toEqual({ platform: null, isWsl: false });
    });

    it('reports whether credentials came from the environment', async () => {
      const { app } = makeApp({ envAuth: true });

      const res = await supertest(app).get('/getconfig');

      expect(res.body.envAuthApplied).toBe(true);
    });

    it.each([
      [{ YOUTUBE_OUTPUT_DIR: '/out', DATA_PATH: '/data' }, '/out'],
      [{ DATA_PATH: '/data' }, '/data'],
      [{}, null],
    ])('resolves the output directory from %j as %p', async (env, expected) => {
      Object.assign(process.env, env);
      const { app } = makeApp();

      const res = await supertest(app).get('/getconfig');

      expect(res.body.youtubeOutputDirectory).toBe(expected);
    });
  });

  describe('POST /api/nzb/regenerate-key', () => {
    it('returns a new 64 character hex key', async () => {
      const { app } = makeApp();

      const res = await supertest(app).post('/api/nzb/regenerate-key');

      expect(res.body.apiKey).toMatch(/^[0-9a-f]{64}$/);
    });

    it('saves the key while keeping other nzb settings and the rest of the config', async () => {
      const { app, configModule } = makeApp({ config: { nzb: { enabled: true, apiKey: 'old' } } });

      const res = await supertest(app).post('/api/nzb/regenerate-key');

      expect(configModule.updateConfig).toHaveBeenCalledWith(expect.objectContaining({
        plexApiKey: 'key',
        nzb: { enabled: true, apiKey: res.body.apiKey },
      }));
    });

    it('works when there is no nzb section yet', async () => {
      const { app, configModule } = makeApp();

      const res = await supertest(app).post('/api/nzb/regenerate-key');

      expect(configModule.updateConfig.mock.calls[0][0].nzb).toEqual({ apiKey: res.body.apiKey });
    });

    it('generates a different key each time', async () => {
      const { app } = makeApp();

      const a = await supertest(app).post('/api/nzb/regenerate-key');
      const b = await supertest(app).post('/api/nzb/regenerate-key');

      expect(a.body.apiKey).not.toBe(b.body.apiKey);
    });
  });

  describe('GET /api/nzb/stats', () => {
    it('combines search stats, traces, failed grabs and jobs', async () => {
      videoSearchModule.getNzbStats.mockResolvedValue({ totalQueries: 4 });
      nzbRoutes.getRecentSearchTraces.mockResolvedValue([{ q: 'a' }]);
      nzbRoutes.getRecentFailedGrabs.mockResolvedValue([{ id: 1 }]);
      nzbRoutes.getNzbJobsSnapshot.mockResolvedValue({ active: [], history: [] });
      const { app } = makeApp();

      const res = await supertest(app).get('/api/nzb/stats');

      expect(res.body).toEqual({ totalQueries: 4, searchTraces: [{ q: 'a' }], failedGrabs: [{ id: 1 }], jobs: { active: [], history: [] } });
    });

    it('answers 500 when any source fails', async () => {
      videoSearchModule.getNzbStats.mockResolvedValue({});
      nzbRoutes.getRecentSearchTraces.mockRejectedValue(new Error('db down'));
      nzbRoutes.getRecentFailedGrabs.mockResolvedValue([]);
      nzbRoutes.getNzbJobsSnapshot.mockResolvedValue({});
      const { app } = makeApp();

      const res = await supertest(app).get('/api/nzb/stats');

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('db down');
    });
  });

  describe('DELETE /api/nzb/cache', () => {
    it('removes the given cache keys', async () => {
      videoSearchModule.deleteCacheEntries.mockReturnValue(2);
      const { app } = makeApp();

      const res = await supertest(app).delete('/api/nzb/cache').send({ keys: ['a', 'b'] });

      expect(res.body).toEqual({ removed: 2 });
      expect(videoSearchModule.deleteCacheEntries).toHaveBeenCalledWith(['a', 'b']);
    });

    it('ignores keys that are not strings', async () => {
      videoSearchModule.deleteCacheEntries.mockReturnValue(1);
      const { app } = makeApp();

      await supertest(app).delete('/api/nzb/cache').send({ keys: ['a', 5, null, { x: 1 }] });

      expect(videoSearchModule.deleteCacheEntries).toHaveBeenCalledWith(['a']);
    });

    it.each([
      ['no body', undefined],
      ['no keys', {}],
      ['an empty list', { keys: [] }],
      ['keys that are not an array', { keys: 'a' }],
      ['only non-string keys', { keys: [1, 2] }],
    ])('rejects %s with 400', async (_label, body) => {
      const { app } = makeApp();

      const res = await supertest(app).delete('/api/nzb/cache').send(body);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'keys must be a non-empty array of strings' });
      expect(videoSearchModule.deleteCacheEntries).not.toHaveBeenCalled();
    });
  });

  describe('NZB diagnostic logs', () => {
    it('counts stored rows', async () => {
      nzbDiagnosticLog.countAllDiagnosticEvents.mockResolvedValue(42);
      const { app } = makeApp();

      const res = await supertest(app).get('/api/nzb/diagnostic-logs');

      expect(res.body).toEqual({ count: 42 });
    });

    it('clears every row', async () => {
      nzbDiagnosticLog.clearAllDiagnosticEvents.mockResolvedValue(undefined);
      const { app } = makeApp();

      const res = await supertest(app).delete('/api/nzb/diagnostic-logs');

      expect(res.body).toEqual({ success: true });
    });

    it('clears only failed grabs and reports how many', async () => {
      nzbDiagnosticLog.clearDiagnosticEvents.mockResolvedValue(3);
      const { app } = makeApp();

      const res = await supertest(app).delete('/api/nzb/failed-grabs');

      expect(res.body).toEqual({ removed: 3 });
      expect(nzbDiagnosticLog.clearDiagnosticEvents).toHaveBeenCalledWith('failedGrab');
    });

    it.each([
      ['get', '/api/nzb/diagnostic-logs', () => nzbDiagnosticLog.countAllDiagnosticEvents],
      ['delete', '/api/nzb/diagnostic-logs', () => nzbDiagnosticLog.clearAllDiagnosticEvents],
      ['delete', '/api/nzb/failed-grabs', () => nzbDiagnosticLog.clearDiagnosticEvents],
    ])('answers 500 when %s %s fails', async (method, path, target) => {
      target().mockRejectedValue(new Error('db down'));
      const { app } = makeApp();

      const res = await supertest(app)[method](path);

      expect(res.status).toBe(500);
    });
  });

  describe('NZB resolution cache', () => {
    it('counts cached videos', async () => {
      nzbThumbnailProbe.countResolutionCache.mockResolvedValue(9);
      const { app } = makeApp();

      const res = await supertest(app).get('/api/nzb/resolution-cache');

      expect(res.body).toEqual({ count: 9 });
    });

    it('clears the cache', async () => {
      nzbThumbnailProbe.clearResolutionCache.mockResolvedValue(undefined);
      const { app } = makeApp();

      const res = await supertest(app).delete('/api/nzb/resolution-cache');

      expect(res.body).toEqual({ success: true });
    });

    it.each([
      ['get', () => nzbThumbnailProbe.countResolutionCache],
      ['delete', () => nzbThumbnailProbe.clearResolutionCache],
    ])('answers 500 when %s fails', async (method, target) => {
      target().mockRejectedValue(new Error('db down'));
      const { app } = makeApp();

      const res = await supertest(app)[method]('/api/nzb/resolution-cache');

      expect(res.status).toBe(500);
    });
  });

  describe('cookies', () => {
    describe('GET /api/cookies/status', () => {
      it('returns the cookie status', async () => {
        const { app, configModule } = makeApp();
        configModule.getCookiesStatus.mockReturnValue({ hasCustom: true });

        const res = await supertest(app).get('/api/cookies/status');

        expect(res.body).toEqual({ hasCustom: true });
      });

      it('answers 500 when reading the status throws', async () => {
        const { app, configModule } = makeApp();
        configModule.getCookiesStatus.mockImplementation(() => { throw new Error('io'); });

        const res = await supertest(app).get('/api/cookies/status');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Failed to get cookie status' });
      });
    });

    describe('POST /api/cookies/upload', () => {
      it('rejects a request with no file', async () => {
        const { app } = makeApp();

        const res = await supertest(app).post('/api/cookies/upload');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'No file uploaded' });
      });

      it('saves a Netscape format cookie file', async () => {
        const { app, configModule } = makeApp();
        configModule.getCookiesStatus.mockReturnValue({ hasCustom: true });

        const res = await supertest(app).post('/api/cookies/upload').attach('cookieFile', Buffer.from(COOKIE_HEADER), 'cookies.txt');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: 'success', message: 'Cookie file uploaded successfully', cookieStatus: { hasCustom: true } });
        expect(configModule.writeCustomCookiesFile.mock.calls[0][0].toString()).toBe(COOKIE_HEADER);
      });

      it('accepts a yt-dlp generated cookie file', async () => {
        const { app, configModule } = makeApp();

        const res = await supertest(app).post('/api/cookies/upload').attach('cookieFile', Buffer.from('# This file is generated by yt-dlp\n'), 'cookies.txt');

        expect(res.status).toBe(200);
        expect(configModule.writeCustomCookiesFile).toHaveBeenCalled();
      });

      it('rejects text that is not a cookie file', async () => {
        const { app, configModule } = makeApp();

        const res = await supertest(app).post('/api/cookies/upload').attach('cookieFile', Buffer.from('hello world'), 'cookies.txt');

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('Invalid cookie file format');
        expect(configModule.writeCustomCookiesFile).not.toHaveBeenCalled();
      });

      it('rejects a file that is not text', async () => {
        const { app, configModule } = makeApp();

        const res = await supertest(app).post('/api/cookies/upload').attach('cookieFile', Buffer.from(COOKIE_HEADER), { filename: 'cookies.bin', contentType: 'application/octet-stream' });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Only text files are allowed' });
        expect(configModule.writeCustomCookiesFile).not.toHaveBeenCalled();
      });

      it('accepts a .txt file whatever its content type', async () => {
        const { app } = makeApp();

        const res = await supertest(app).post('/api/cookies/upload').attach('cookieFile', Buffer.from(COOKIE_HEADER), { filename: 'cookies.txt', contentType: 'application/octet-stream' });

        expect(res.status).toBe(200);
      });

      it('rejects a file over 1MB', async () => {
        const { app } = makeApp();
        const big = Buffer.concat([Buffer.from(COOKIE_HEADER), Buffer.alloc(1024 * 1024 + 10, 'a')]);

        const res = await supertest(app).post('/api/cookies/upload').attach('cookieFile', big, 'cookies.txt');

        expect(res.status).toBe(413);
        expect(res.body).toEqual({ error: 'File exceeds maximum allowed size.' });
      });

      it('answers 400 when the file is sent under the wrong field name', async () => {
        const { app, configModule } = makeApp();

        const res = await supertest(app).post('/api/cookies/upload').attach('wrongField', Buffer.from(COOKIE_HEADER), 'cookies.txt');

        expect(res.status).toBe(400);
        expect(configModule.writeCustomCookiesFile).not.toHaveBeenCalled();
      });

      it('answers 500 when saving the file fails', async () => {
        const { app, configModule } = makeApp();
        configModule.writeCustomCookiesFile.mockImplementation(() => { throw new Error('disk full'); });

        const res = await supertest(app).post('/api/cookies/upload').attach('cookieFile', Buffer.from(COOKIE_HEADER), 'cookies.txt');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Failed to upload cookie file' });
      });
    });

    describe('DELETE /api/cookies', () => {
      it('deletes the custom cookie file and returns the status', async () => {
        const { app, configModule } = makeApp();
        configModule.getCookiesStatus.mockReturnValue({ hasCustom: false });

        const res = await supertest(app).delete('/api/cookies');

        expect(configModule.deleteCustomCookiesFile).toHaveBeenCalled();
        expect(res.body).toEqual({ status: 'success', message: 'Custom cookie file deleted', cookieStatus: { hasCustom: false } });
      });

      it('answers 500 when deleting fails', async () => {
        const { app, configModule } = makeApp();
        configModule.deleteCustomCookiesFile.mockImplementation(() => { throw new Error('busy'); });

        const res = await supertest(app).delete('/api/cookies');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Failed to delete cookie file' });
      });
    });

    describe('POST /api/cookies/test', () => {
      it('uses the singular for a single channel', async () => {
        const { app, configModule } = makeApp();
        configModule.getCookiesPath.mockReturnValue('/cookies.txt');
        cookiesFetcher.runYtdlp.mockResolvedValue({ stdout: 'x' });
        cookiesFetcher.parseChannelEntries.mockReturnValue([{}]);

        const res = await supertest(app).post('/api/cookies/test');

        expect(res.body.message).toBe('Cookies are working (found 1 subscribed channel).');
      });

      it('falls back to a generic message when the failure has none', async () => {
        const { app, configModule } = makeApp();
        configModule.getCookiesPath.mockReturnValue('/cookies.txt');
        cookiesFetcher.runYtdlp.mockRejectedValue(new Error('boom'));

        const res = await supertest(app).post('/api/cookies/test');

        expect(res.body).toMatchObject({ success: false, error: 'Cookie test failed.' });
      });
    });
  });

  describe('notifications', () => {
    describe('POST /api/notifications/test', () => {
      it('sends a test notification', async () => {
        notificationModule.sendTestNotification.mockResolvedValue(undefined);
        const { app } = makeApp();

        const res = await supertest(app).post('/api/notifications/test');

        expect(res.body).toEqual({ status: 'success', message: 'Test notification sent successfully' });
      });

      it('answers 500 with the reason when sending fails', async () => {
        notificationModule.sendTestNotification.mockRejectedValue(new Error('Apprise is not installed'));
        const { app } = makeApp();

        const res = await supertest(app).post('/api/notifications/test');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Failed to send test notification', message: 'Apprise is not installed' });
      });
    });

    describe('POST /api/notifications/test-single', () => {
      it.each([
        ['missing', {}],
        ['empty', { url: '' }],
        ['blank', { url: '   ' }],
        ['not a string', { url: 5 }],
      ])('rejects a %s url with 400', async (_label, body) => {
        const { app } = makeApp();

        const res = await supertest(app).post('/api/notifications/test-single').send(body);

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Invalid request', message: 'Notification URL is required' });
        expect(notificationModule.sendTestNotificationToSingle).not.toHaveBeenCalled();
      });

      it('sends to the trimmed url with defaults', async () => {
        notificationModule.sendTestNotificationToSingle.mockResolvedValue(undefined);
        const { app } = makeApp();

        const res = await supertest(app).post('/api/notifications/test-single').send({ url: '  discord://a/b  ' });

        expect(res.body).toEqual({ status: 'success', message: 'Test notification sent successfully' });
        expect(notificationModule.sendTestNotificationToSingle).toHaveBeenCalledWith({ url: 'discord://a/b', name: 'Test Notification', richFormatting: true });
      });

      it('passes the name and turns rich formatting off only when explicitly false', async () => {
        notificationModule.sendTestNotificationToSingle.mockResolvedValue(undefined);
        const { app } = makeApp();

        await supertest(app).post('/api/notifications/test-single').send({ url: 'x://y', name: 'My Hook', richFormatting: false });

        expect(notificationModule.sendTestNotificationToSingle).toHaveBeenCalledWith({ url: 'x://y', name: 'My Hook', richFormatting: false });
      });

      it('keeps rich formatting on for any other value', async () => {
        notificationModule.sendTestNotificationToSingle.mockResolvedValue(undefined);
        const { app } = makeApp();

        await supertest(app).post('/api/notifications/test-single').send({ url: 'x://y', richFormatting: 0 });

        expect(notificationModule.sendTestNotificationToSingle.mock.calls[0][0].richFormatting).toBe(true);
      });

      it('answers 500 with the reason when sending fails', async () => {
        notificationModule.sendTestNotificationToSingle.mockRejectedValue(new Error('Unauthorized'));
        const { app } = makeApp();

        const res = await supertest(app).post('/api/notifications/test-single').send({ url: 'x://y' });

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Failed to send test notification', message: 'Unauthorized' });
      });
    });
  });

  describe('GET /storage-status', () => {
    it('returns the storage status', async () => {
      const { app, configModule } = makeApp();
      configModule.getStorageStatus.mockResolvedValue({ availableGB: 12 });

      const res = await supertest(app).get('/storage-status');

      expect(res.body).toEqual({ availableGB: 12 });
    });

    it('answers 500 when no status is available', async () => {
      const { app, configModule } = makeApp();
      configModule.getStorageStatus.mockResolvedValue(null);

      const res = await supertest(app).get('/storage-status');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Could not retrieve storage status' });
    });

    it('answers 500 with the reason when reading throws', async () => {
      const { app, configModule } = makeApp();
      configModule.getStorageStatus.mockRejectedValue(new Error('statfs failed'));

      const res = await supertest(app).get('/storage-status');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'statfs failed' });
    });
  });
});
