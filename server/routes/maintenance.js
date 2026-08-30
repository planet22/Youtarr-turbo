const express = require('express');
const logger = require('../logger');

/**
 * Maintenance routes.
 * Hosts the manual "rescan files on disk" trigger and a status endpoint.
 *
 * @swagger
 * tags:
 *   name: Maintenance
 *   description: Filesystem reconciliation actions
 */
function createMaintenanceRoutes({ verifyToken, videosModule, configModule }) {
  const router = express.Router();

  /**
   * @swagger
   * /api/maintenance/rescan-files:
   *   post:
   *     summary: Kick off a manual filesystem rescan
   *     tags: [Maintenance]
   *     responses:
   *       202:
   *         description: Rescan started
   *       409:
   *         description: A rescan is already in progress
   */
  router.post('/api/maintenance/rescan-files', verifyToken, (req, res) => {
    try {
      const result = videosModule.tryStartBackfill({ trigger: 'manual' });
      if (!result.started) {
        return res.status(409).json({ error: 'Rescan already in progress' });
      }
      return res.status(202).json({ status: 'started', trigger: 'manual' });
    } catch (err) {
      logger.error({ err }, 'Failed to start manual rescan');
      return res.status(500).json({ error: 'Failed to start rescan' });
    }
  });

  /**
   * @swagger
   * /api/maintenance/rescan-status:
   *   get:
   *     summary: Get current rescan running state and last-run summary
   *     tags: [Maintenance]
   *     responses:
   *       200:
   *         description: Status object
   */
  router.get('/api/maintenance/rescan-status', verifyToken, (req, res) => {
    try {
      const running = videosModule.isBackfillRunning();
      const lastRun = configModule.getConfig().rescanLastRun ?? null;
      return res.status(200).json({ running, lastRun });
    } catch (err) {
      logger.error({ err }, 'Failed to read rescan status');
      return res.status(500).json({ error: 'Failed to read rescan status' });
    }
  });

  /**
   * @swagger
   * /api/maintenance/backfill-resolution-tags:
   *   post:
   *     summary: Kick off a manual pass adding the "Available: ..." resolution tag to existing .nfo files
   *     tags: [Maintenance]
   *     responses:
   *       202:
   *         description: Backfill started
   *       409:
   *         description: A resolution tag backfill is already in progress
   */
  router.post('/api/maintenance/backfill-resolution-tags', verifyToken, (req, res) => {
    try {
      const result = videosModule.tryStartResolutionTagBackfill({ trigger: 'manual' });
      if (!result.started) {
        return res.status(409).json({ error: 'Resolution tag backfill already in progress' });
      }
      return res.status(202).json({ status: 'started', trigger: 'manual' });
    } catch (err) {
      logger.error({ err }, 'Failed to start manual resolution tag backfill');
      return res.status(500).json({ error: 'Failed to start resolution tag backfill' });
    }
  });

  /**
   * @swagger
   * /api/maintenance/backfill-resolution-tags-status:
   *   get:
   *     summary: Get current resolution tag backfill running state and last-run summary
   *     tags: [Maintenance]
   *     responses:
   *       200:
   *         description: Status object
   */
  router.get('/api/maintenance/backfill-resolution-tags-status', verifyToken, (req, res) => {
    try {
      const running = videosModule.isResolutionTagBackfillRunning();
      const lastRun = configModule.getConfig().resolutionTagBackfillLastRun ?? null;
      return res.status(200).json({ running, lastRun });
    } catch (err) {
      logger.error({ err }, 'Failed to read resolution tag backfill status');
      return res.status(500).json({ error: 'Failed to read resolution tag backfill status' });
    }
  });

  /**
   * @swagger
   * /api/maintenance/regenerate-channel-images:
   *   post:
   *     summary: Force re-copy poster/logo/backdrop/banner images for every enabled channel (and its season folders), overwriting existing files; also fills in any missing video/episode thumbnails
   *     description: Unlike the automatic image backfill (which only fills in missing images), the channel/season images here always overwrite - use it to repair images that already exist on disk but are broken (e.g. wrong permissions from before a fix). Also regenerates each season folder's poster.jpg/logo.jpg for channels in TV Series library mode. Separately, fills in any video or episode's own missing library-adjacent thumbnail (what its NFO's <thumb> tag references) - "fill in if missing" semantics there, not force-overwrite, since a missing thumbnail means it was never written at all (see strmMaterializer.js's maxresdefault-404 fix), not a stale-permissions problem on an existing file.
   *     tags: [Maintenance]
   *     responses:
   *       202:
   *         description: Regeneration started
   *       409:
   *         description: A regeneration is already in progress
   */
  router.post('/api/maintenance/regenerate-channel-images', verifyToken, (req, res) => {
    try {
      const result = videosModule.tryStartImageRegen({ trigger: 'manual' });
      if (!result.started) {
        return res.status(409).json({ error: 'Channel image regeneration already in progress' });
      }
      return res.status(202).json({ status: 'started', trigger: 'manual' });
    } catch (err) {
      logger.error({ err }, 'Failed to start manual channel image regeneration');
      return res.status(500).json({ error: 'Failed to start channel image regeneration' });
    }
  });

  /**
   * @swagger
   * /api/maintenance/regenerate-channel-images-status:
   *   get:
   *     summary: Get current channel image regeneration running state and last-run summary
   *     tags: [Maintenance]
   *     responses:
   *       200:
   *         description: Status object
   */
  router.get('/api/maintenance/regenerate-channel-images-status', verifyToken, (req, res) => {
    try {
      const running = videosModule.isImageRegenRunning();
      const lastRun = configModule.getConfig().channelImageRegenLastRun ?? null;
      return res.status(200).json({ running, lastRun });
    } catch (err) {
      logger.error({ err }, 'Failed to read channel image regeneration status');
      return res.status(500).json({ error: 'Failed to read channel image regeneration status' });
    }
  });

  return router;
}

module.exports = createMaintenanceRoutes;
