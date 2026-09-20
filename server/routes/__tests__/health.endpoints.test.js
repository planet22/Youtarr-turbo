/* eslint-env jest */

jest.mock('../../logger');

const { EventEmitter } = require('events');

// health.js creates its express Router at module scope, so every test loads a
// fresh copy of the module (otherwise routes from earlier tests pile up on it).
describe('health routes', () => {
  let supertest;
  let express;
  let https;
  let logger;
  let databaseHealth;
  let ytdlpModule;
  let deps;
  let verifyToken;

  const makeApp = () => {
    const createHealthRoutes = require('../health');
    const app = express();
    app.use(express.json());
    app.use(createHealthRoutes(deps));
    return supertest(app);
  };

  // Scripts the GitHub request: get(url, options, cb) returns a request object.
  const githubReplies = ({ statusCode = 200, body = '', error = null, chunks = null }) => {
    https.get.mockImplementation((url, options, cb) => {
      const req = new EventEmitter();
      setImmediate(() => {
        if (error) {
          req.emit('error', error);
          return;
        }
        const resp = new EventEmitter();
        resp.statusCode = statusCode;
        cb(resp);
        (chunks || [body]).forEach((chunk) => resp.emit('data', chunk));
        resp.emit('end');
      });
      return req;
    });
  };

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    databaseHealth = { getStartupHealth: jest.fn() };
    ytdlpModule = {
      normalizeChannel: jest.fn((c) => c || 'stable'),
      getLatestVersion: jest.fn(),
      isUpdateAvailable: jest.fn(),
      performUpdate: jest.fn(),
    };
    https = { get: jest.fn() };
    verifyToken = jest.fn((_req, _res, next) => next());
    deps = {
      getCachedYtDlpVersion: jest.fn().mockReturnValue('2026.01.01'),
      refreshYtDlpVersionCache: jest.fn(),
      verifyToken,
      configModule: { getConfig: jest.fn().mockReturnValue({}), isElfhostedPlatform: jest.fn().mockReturnValue(false) },
    };

    jest.doMock('https', () => https);
    jest.doMock('../../modules/databaseHealthModule', () => databaseHealth);
    jest.doMock('../../modules/ytdlpModule', () => ytdlpModule);

    supertest = require('supertest');
    express = require('express');
    logger = require('../../logger');
  });

  describe('GET /api/health', () => {
    it('reports healthy', async () => {
      const res = await makeApp().get('/api/health');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'healthy' });
    });

    it('needs no authentication', async () => {
      await makeApp().get('/api/health');

      expect(verifyToken).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/db-status', () => {
    it('reports healthy when connected with a valid schema', async () => {
      databaseHealth.getStartupHealth.mockReturnValue({ database: { connected: true, schemaValid: true } });

      const res = await makeApp().get('/api/db-status');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'healthy', database: { connected: true, schemaValid: true } });
    });

    it.each([
      ['not connected', { connected: false, schemaValid: true }],
      ['the schema is invalid', { connected: true, schemaValid: false }],
    ])('answers 503 when %s', async (_label, database) => {
      databaseHealth.getStartupHealth.mockReturnValue({ database });

      const res = await makeApp().get('/api/db-status');

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ status: 'error', database });
    });
  });

  describe('GET /getCurrentReleaseVersion', () => {
    it('returns the latest release tag with the yt-dlp version', async () => {
      githubReplies({ body: JSON.stringify({ tag_name: 'v1.2.3' }) });

      const res = await makeApp().get('/getCurrentReleaseVersion');

      expect(res.body).toEqual({ version: 'v1.2.3', ytDlpVersion: '2026.01.01' });
    });

    it('asks GitHub with a user agent and the JSON accept header', async () => {
      githubReplies({ body: JSON.stringify({ tag_name: 'v1' }) });

      await makeApp().get('/getCurrentReleaseVersion');

      const [url, options] = https.get.mock.calls[0];
      expect(url).toBe('https://api.github.com/repos/planet22/Youtarr-turbo/releases/latest');
      expect(options.headers).toEqual({ 'User-Agent': 'Youtarr', Accept: 'application/vnd.github+json' });
    });

    it('leaves the yt-dlp version out when it is not known', async () => {
      deps.getCachedYtDlpVersion.mockReturnValue(null);
      githubReplies({ body: JSON.stringify({ tag_name: 'v1' }) });

      const res = await makeApp().get('/getCurrentReleaseVersion');

      expect(res.body).toEqual({ version: 'v1' });
    });

    it('reassembles a response that arrives in chunks', async () => {
      githubReplies({ chunks: ['{"tag_na', 'me":"v9"}'] });

      const res = await makeApp().get('/getCurrentReleaseVersion');

      expect(res.body.version).toBe('v9');
    });

    it('reports no version when the release has no tag', async () => {
      githubReplies({ body: '{}' });

      const res = await makeApp().get('/getCurrentReleaseVersion');

      expect(res.body.version).toBeNull();
    });

    it('treats "no releases yet" as a null version, not an error', async () => {
      githubReplies({ statusCode: 404, body: '{"message":"Not Found"}' });

      const res = await makeApp().get('/getCurrentReleaseVersion');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ version: null, ytDlpVersion: '2026.01.01' });
    });

    it('answers 404 without the yt-dlp version when it is unknown', async () => {
      deps.getCachedYtDlpVersion.mockReturnValue(undefined);
      githubReplies({ statusCode: 404, body: '' });

      const res = await makeApp().get('/getCurrentReleaseVersion');

      expect(res.body).toEqual({ version: null });
    });

    it('answers 502 and logs when GitHub returns another status', async () => {
      githubReplies({ statusCode: 403, body: 'rate limited' });

      const res = await makeApp().get('/getCurrentReleaseVersion');

      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: 'GitHub returned status 403' });
      expect(logger.warn).toHaveBeenCalledWith({ statusCode: 403, body: 'rate limited' }, expect.any(String));
    });

    it('answers 502 with the start of the body when it is not JSON', async () => {
      githubReplies({ body: 'x'.repeat(2000) });

      const res = await makeApp().get('/getCurrentReleaseVersion');

      expect(res.status).toBe(502);
      expect(res.body.error).toBe('Failed to parse GitHub release response');
      expect(res.body.details).toHaveLength(1024);
    });

    it('answers 500 with the reason when the request fails', async () => {
      githubReplies({ error: new Error('ENOTFOUND api.github.com') });

      const res = await makeApp().get('/getCurrentReleaseVersion');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'ENOTFOUND api.github.com' });
    });

    it('answers 500 when reading the yt-dlp version throws', async () => {
      deps.getCachedYtDlpVersion.mockImplementation(() => { throw new Error('boom'); });

      const res = await makeApp().get('/getCurrentReleaseVersion');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Failed to fetch version from GitHub' });
    });

    it('needs no authentication', async () => {
      githubReplies({ body: '{}' });

      await makeApp().get('/getCurrentReleaseVersion');

      expect(verifyToken).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/ytdlp/latest-version', () => {
    it('reports the current and latest versions for the configured channel', async () => {
      deps.configModule.getConfig.mockReturnValue({ ytdlpUpdateChannel: 'nightly' });
      ytdlpModule.getLatestVersion.mockResolvedValue('2026.02.02');
      ytdlpModule.isUpdateAvailable.mockReturnValue(true);

      const res = await makeApp().get('/api/ytdlp/latest-version');

      expect(res.body).toEqual({ currentVersion: '2026.01.01', latestVersion: '2026.02.02', updateAvailable: true, channel: 'nightly' });
      expect(ytdlpModule.getLatestVersion).toHaveBeenCalledWith('nightly');
      expect(ytdlpModule.isUpdateAvailable).toHaveBeenCalledWith('2026.01.01', '2026.02.02');
    });

    it('answers 500 with a generic message when the lookup fails', async () => {
      ytdlpModule.getLatestVersion.mockRejectedValue(new Error('github down'));

      const res = await makeApp().get('/api/ytdlp/latest-version');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Failed to get version information' });
    });

    it('requires authentication', async () => {
      verifyToken.mockImplementation((_req, r) => r.status(401).json({ error: 'no' }));

      const res = await makeApp().get('/api/ytdlp/latest-version');

      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/ytdlp/update', () => {
    it('updates yt-dlp on the configured channel and refreshes the cached version', async () => {
      deps.configModule.getConfig.mockReturnValue({ ytdlpUpdateChannel: 'nightly' });
      ytdlpModule.performUpdate.mockResolvedValue({ success: true, message: 'Updated' });

      const res = await makeApp().post('/api/ytdlp/update');

      expect(res.body).toEqual({ success: true, message: 'Updated' });
      expect(ytdlpModule.performUpdate).toHaveBeenCalledWith({ channel: 'nightly' });
      expect(deps.refreshYtDlpVersionCache).toHaveBeenCalled();
    });

    it('does not refresh the cached version when the update failed', async () => {
      ytdlpModule.performUpdate.mockResolvedValue({ success: false, message: 'nope' });

      const res = await makeApp().post('/api/ytdlp/update');

      expect(res.body).toEqual({ success: false, message: 'nope' });
      expect(deps.refreshYtDlpVersionCache).not.toHaveBeenCalled();
    });

    it('refuses on a platform-managed install', async () => {
      deps.configModule.isElfhostedPlatform.mockReturnValue(true);

      const res = await makeApp().post('/api/ytdlp/update');

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(ytdlpModule.performUpdate).not.toHaveBeenCalled();
    });

    it('answers 500 with a generic message when the update throws', async () => {
      ytdlpModule.performUpdate.mockRejectedValue(new Error('disk full'));

      const res = await makeApp().post('/api/ytdlp/update');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ success: false, message: 'Update failed due to an unexpected error' });
    });

    it('requires authentication', async () => {
      verifyToken.mockImplementation((_req, r) => r.status(401).json({ error: 'no' }));

      const res = await makeApp().post('/api/ytdlp/update');

      expect(res.status).toBe(401);
      expect(ytdlpModule.performUpdate).not.toHaveBeenCalled();
    });
  });
});
