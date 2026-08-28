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

  return router;
}

module.exports = createMaintenanceRoutes;
