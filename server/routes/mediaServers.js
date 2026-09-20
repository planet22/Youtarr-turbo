const express = require('express');

function createMediaServerRoutes({ verifyToken, configModule, mediaServers }) {
  const router = express.Router();
  const { JellyfinAdapter, EmbyAdapter, BaseAdapter } = mediaServers.adapters;
  const { describeHttpError } = BaseAdapter;

  router.get('/api/mediaservers/status', verifyToken, async (req, res) => {
    try {
      const cfg = configModule.getConfig();
      const enabled = mediaServers.serverRegistry.getEnabledAdapters(cfg);
      const out = { plex: false, jellyfin: false, emby: false };
      for (const a of enabled) {
        if (a.serverType in out) out[a.serverType] = true;
      }
      res.json(out);
    } catch (err) {
      req.log.error({ err }, 'media server status failed');
      res.status(500).json({ error: 'Failed to get media server status' });
    }
  });

  async function testAndRespond(AdapterClass, body, res, reqLog) {
    try {
      const adapter = new AdapterClass(body);
      const result = await adapter.testConnection();
      if (!result.ok) return res.status(502).json({ error: result.error || 'Connection failed' });
      res.json(result);
    } catch (err) {
      reqLog.error({ err }, 'test connection failed');
      res.status(500).json({ error: 'Test connection failed' });
    }
  }

  async function usersAndRespond(AdapterClass, body, res, reqLog) {
    try {
      const adapter = new AdapterClass(body);
      const users = await adapter.listUsers();
      res.json({ users });
    } catch (err) {
      const status = err.response?.status;
      if (status === 401 || status === 403) {
        return res.status(502).json({
          error: 'The server rejected the API key, so users could not be listed. Re-copy the key from the server dashboard (select only the key itself) and try again.',
        });
      }
      reqLog.error(describeHttpError(err), 'list users failed');
      if (err.isAxiosError) {
        return res.status(502).json({ error: `Could not reach the server: ${err.message}` });
      }
      res.status(500).json({ error: 'Failed to list users' });
    }
  }

  async function librariesAndRespond(AdapterClass, body, res, reqLog) {
    try {
      const adapter = new AdapterClass(body);
      const libraries = await adapter.listLibraries();
      res.json({ libraries });
    } catch (err) {
      const status = err.response?.status;
      if (status === 401 || status === 403) {
        return res.status(502).json({
          error: 'The server rejected the API key, so libraries could not be listed. Re-copy the key from the server dashboard (select only the key itself) and try again.',
        });
      }
      reqLog.error(describeHttpError(err), 'list libraries failed');
      if (err.isAxiosError) {
        return res.status(502).json({ error: `Could not reach the server: ${err.message}` });
      }
      res.status(500).json({ error: 'Failed to list libraries' });
    }
  }

  router.post('/api/mediaservers/jellyfin/test', verifyToken, (req, res) =>
    testAndRespond(JellyfinAdapter, req.body, res, req.log));
  router.post('/api/mediaservers/jellyfin/users', verifyToken, (req, res) =>
    usersAndRespond(JellyfinAdapter, req.body, res, req.log));
  router.post('/api/mediaservers/jellyfin/libraries', verifyToken, (req, res) =>
    librariesAndRespond(JellyfinAdapter, req.body, res, req.log));
  router.post('/api/mediaservers/emby/test', verifyToken, (req, res) =>
    testAndRespond(EmbyAdapter, req.body, res, req.log));
  router.post('/api/mediaservers/emby/users', verifyToken, (req, res) =>
    usersAndRespond(EmbyAdapter, req.body, res, req.log));

  // StrmToolTurbo plugin control. Unlike the test/users/libraries routes above,
  // these act on the SAVED Jellyfin connection rather than a request-body one.
  const { strmToolTurbo } = mediaServers;
  const STRMTOOLTURBO_PATH = '/api/mediaservers/jellyfin/strmtoolturbo';

  function getSavedJellyfinAdapter() {
    const cfg = configModule.getConfig();
    if (!cfg.jellyfinEnabled || !cfg.jellyfinUrl || !cfg.jellyfinApiKey) return null;
    return new JellyfinAdapter(cfg);
  }

  function respondStrmToolError(err, res, reqLog, action) {
    if (err && err.name === 'StrmToolTurboError') {
      return res.status(err.statusCode).json({ error: err.message });
    }
    const status = err.response?.status;
    if (status === 401 || status === 403) {
      return res.status(502).json({
        error: 'Jellyfin rejected the API key for plugin management. Plugin control needs an administrator API key.',
      });
    }
    reqLog.error(describeHttpError(err), `StrmToolTurbo ${action} failed`);
    if (err.isAxiosError) {
      return res.status(502).json({ error: `Could not reach Jellyfin: ${err.message}` });
    }
    res.status(500).json({ error: `Failed to ${action} StrmToolTurbo` });
  }

  async function withStrmToolTurbo(req, res, action, handler) {
    const adapter = getSavedJellyfinAdapter();
    if (!adapter) {
      return res.status(400).json({ error: 'Jellyfin is not enabled and saved in settings' });
    }
    try {
      await handler(adapter);
    } catch (err) {
      respondStrmToolError(err, res, req.log, action);
    }
  }

  /**
   * @swagger
   * /api/mediaservers/jellyfin/strmtoolturbo:
   *   get:
   *     summary: Get StrmToolTurbo plugin status, settings and extraction task state
   *     tags: [Media Servers]
   *     responses:
   *       200:
   *         description: "{ installed, version, pluginStatus, config, task }; only installed is set when the plugin is missing"
   *       400:
   *         description: Jellyfin is not enabled and saved
   *       502:
   *         description: Jellyfin unreachable or rejected the API key
   */
  router.get(STRMTOOLTURBO_PATH, verifyToken, (req, res) =>
    withStrmToolTurbo(req, res, 'read', async (adapter) => {
      res.json(await strmToolTurbo.getStatus(adapter));
    }));

  /**
   * @swagger
   * /api/mediaservers/jellyfin/strmtoolturbo/config:
   *   put:
   *     summary: Update StrmToolTurbo plugin settings on the Jellyfin server
   *     tags: [Media Servers]
   *     responses:
   *       200:
   *         description: The plugin's settings after the update
   *       400:
   *         description: Unknown setting or out-of-range value
   *       404:
   *         description: Plugin not installed
   *       409:
   *         description: Plugin not active
   */
  router.put(`${STRMTOOLTURBO_PATH}/config`, verifyToken, (req, res) =>
    withStrmToolTurbo(req, res, 'update', async (adapter) => {
      res.json({ config: await strmToolTurbo.saveConfiguration(adapter, req.body) });
    }));

  /**
   * @swagger
   * /api/mediaservers/jellyfin/strmtoolturbo/run:
   *   post:
   *     summary: Start the StrmToolTurbo media info extraction task now
   *     tags: [Media Servers]
   *     responses:
   *       202:
   *         description: Task started
   *       404:
   *         description: Plugin or task not found
   *       409:
   *         description: Task already running, or plugin not active
   */
  router.post(`${STRMTOOLTURBO_PATH}/run`, verifyToken, (req, res) =>
    withStrmToolTurbo(req, res, 'run', async (adapter) => {
      await strmToolTurbo.runExtraction(adapter);
      res.status(202).json({ started: true });
    }));

  /**
   * @swagger
   * /api/mediaservers/jellyfin/strmtoolturbo/stop:
   *   post:
   *     summary: Stop the running StrmToolTurbo media info extraction task
   *     tags: [Media Servers]
   *     responses:
   *       202:
   *         description: Cancellation requested
   *       404:
   *         description: Task not found
   *       409:
   *         description: Task is not running or is already stopping
   */
  router.post(`${STRMTOOLTURBO_PATH}/stop`, verifyToken, (req, res) =>
    withStrmToolTurbo(req, res, 'stop', async (adapter) => {
      await strmToolTurbo.stopExtraction(adapter);
      res.status(202).json({ stopping: true });
    }));

  /**
   * @swagger
   * /api/mediaservers/watch-status:
   *   get:
   *     summary: Get watch status sync state
   *     tags: [Media Servers]
   *     responses:
   *       200:
   *         description: Whether a sync is running and the last run's summary
   */
  router.get('/api/mediaservers/watch-status', verifyToken, (req, res) => {
    res.json(mediaServers.watchStatusSync.getStatus());
  });

  /**
   * @swagger
   * /api/mediaservers/watch-status/sync:
   *   post:
   *     summary: Trigger a watch status sync now
   *     tags: [Media Servers]
   *     responses:
   *       202:
   *         description: Sync started
   *       409:
   *         description: A sync is already running
   */
  router.post('/api/mediaservers/watch-status/sync', verifyToken, (req, res) => {
    if (mediaServers.watchStatusSync.getStatus().running) {
      return res.status(409).json({ error: 'Watch status sync is already running' });
    }
    // Fire-and-forget: syncAll never rejects for per-server failures; this
    // catch covers unexpected rejections so no unhandled rejection escapes.
    mediaServers.watchStatusSync.syncAll('manual').catch((err) => {
      req.log.error({ err }, 'Manual watch status sync failed');
    });
    res.status(202).json({ started: true });
  });

  return router;
}

module.exports = createMediaServerRoutes;
