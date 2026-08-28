const express = require('express');
const router = express.Router();
const https = require('https');
const logger = require('../logger');
const databaseHealth = require('../modules/databaseHealthModule');
const ytdlpModule = require('../modules/ytdlpModule');

/**
 * Creates health routes
 * @param {Object} deps - Dependencies
 * @param {Function} deps.getCachedYtDlpVersion - Function to get cached yt-dlp version
 * @param {Function} deps.refreshYtDlpVersionCache - Function to refresh yt-dlp version cache
 * @param {Function} deps.verifyToken - Authentication middleware
 * @param {Object} deps.configModule - Configuration module
 * @returns {express.Router}
 */
module.exports = function createHealthRoutes({ getCachedYtDlpVersion, refreshYtDlpVersionCache, verifyToken, configModule }) {
  /**
   * @swagger
   * /api/health:
   *   get:
   *     summary: Health check endpoint
   *     description: Returns the health status of the server. Unauthenticated for Docker health checks.
   *     tags: [Health]
   *     security: []
   *     responses:
   *       200:
   *         description: Server is healthy
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 status:
   *                   type: string
   *                   example: healthy
   */
  router.get('/api/health', (req, res) => {
    res.status(200).json({ status: 'healthy' });
  });

  /**
   * @swagger
   * /api/db-status:
   *   get:
   *     summary: Database status endpoint
   *     description: Returns the database health status including connection and schema validity.
   *     tags: [Health]
   *     security: []
   *     responses:
   *       200:
   *         description: Database is healthy
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 status:
   *                   type: string
   *                   example: healthy
   *                 database:
   *                   type: object
   *                   properties:
   *                     connected:
   *                       type: boolean
   *                     schemaValid:
   *                       type: boolean
   *       503:
   *         description: Database is unhealthy
   */
  router.get('/api/db-status', (req, res) => {
    const health = databaseHealth.getStartupHealth();
    const isHealthy = health.database.connected && health.database.schemaValid;

    res.status(isHealthy ? 200 : 503).json({
      status: isHealthy ? 'healthy' : 'error',
      database: health.database
    });
  });

  /**
   * @swagger
   * /getCurrentReleaseVersion:
   *   get:
   *     summary: Get current release version
   *     description: Fetches the latest Youtarr version from GitHub Releases and the installed yt-dlp version.
   *     tags: [Health]
   *     security: []
   *     responses:
   *       200:
   *         description: Version information
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 version:
   *                   type: string
   *                   description: Latest Youtarr version from GitHub Releases
   *                 ytDlpVersion:
   *                   type: string
   *                   description: Installed yt-dlp version
   *       500:
   *         description: Failed to fetch version
   */
  router.get('/getCurrentReleaseVersion', async (req, res) => {
    try {
      const ytDlpVersion = getCachedYtDlpVersion();

      https
        .get(
          'https://api.github.com/repos/planet22/Youtarr-turbo/releases/latest',
          { headers: { 'User-Agent': 'Youtarr', Accept: 'application/vnd.github+json' } },
          (resp) => {
            let data = '';

            resp.on('data', (chunk) => {
              data += chunk;
            });

            resp.on('end', () => {
              // No releases published yet is not an error condition
              if (resp.statusCode === 404) {
                const response = { version: null };
                if (ytDlpVersion) {
                  response.ytDlpVersion = ytDlpVersion;
                }
                return res.json(response);
              }

              if (resp.statusCode !== 200) {
                logger.warn({ statusCode: resp.statusCode, body: data }, 'Non-200 response from GitHub when fetching latest release');
                return res.status(502).json({ error: `GitHub returned status ${resp.statusCode}` });
              }

              let releaseData;
              try {
                releaseData = JSON.parse(data);
              } catch (parseErr) {
                logger.error({ err: parseErr, body: data }, 'Failed to parse GitHub release response as JSON');
                return res.status(502).json({ error: 'Failed to parse GitHub release response', details: data.slice(0, 1024) });
              }

              const response = { version: releaseData.tag_name || null };
              if (ytDlpVersion) {
                response.ytDlpVersion = ytDlpVersion;
              }
              res.json(response);
            });
          }
        )
        .on('error', (err) => {
          logger.error({ err }, 'Failed to fetch GitHub release version');
          res.status(500).json({ error: err.message });
        });
    } catch (error) {
      logger.error({ err: error }, 'Failed to fetch version from GitHub');
      res.status(500).json({ error: 'Failed to fetch version from GitHub' });
    }
  });

  /**
   * @swagger
   * /api/ytdlp/latest-version:
   *   get:
   *     summary: Get yt-dlp version information
   *     description: Returns the current installed yt-dlp version and the latest available version from GitHub for the configured update channel (stable or nightly).
   *     tags: [Health]
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       200:
   *         description: Version information
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 currentVersion:
   *                   type: string
   *                   description: Currently installed yt-dlp version
   *                 latestVersion:
   *                   type: string
   *                   description: Latest yt-dlp version from GitHub
   *                 updateAvailable:
   *                   type: boolean
   *                   description: Whether an update is available
   *                 channel:
   *                   type: string
   *                   enum: [stable, nightly]
   *                   description: Configured yt-dlp update channel
   *       401:
   *         description: Unauthorized
   *       500:
   *         description: Failed to fetch version information
   */
  router.get('/api/ytdlp/latest-version', verifyToken, async (req, res) => {
    try {
      const channel = ytdlpModule.normalizeChannel(configModule.getConfig().ytdlpUpdateChannel);
      const currentVersion = getCachedYtDlpVersion();
      const latestVersion = await ytdlpModule.getLatestVersion(channel);
      const updateAvailable = ytdlpModule.isUpdateAvailable(currentVersion, latestVersion);

      res.json({
        currentVersion,
        latestVersion,
        updateAvailable,
        channel,
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to get yt-dlp version information');
      res.status(500).json({ error: 'Failed to get version information' });
    }
  });

  /**
   * @swagger
   * /api/ytdlp/update:
   *   post:
   *     summary: Update yt-dlp
   *     description: Updates yt-dlp to the latest release of the configured update channel (stable or nightly) via --update-to.
   *     tags: [Health]
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       200:
   *         description: Update result
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                   description: Whether the update succeeded
   *                 message:
   *                   type: string
   *                   description: Status message
   *                 newVersion:
   *                   type: string
   *                   description: New version after update (if applicable)
   *       401:
   *         description: Unauthorized
   *       500:
   *         description: Update failed
   */
  router.post('/api/ytdlp/update', verifyToken, async (req, res) => {
    try {
      if (configModule.isElfhostedPlatform()) {
        return res.status(403).json({
          success: false,
          message: 'yt-dlp is managed by the platform and cannot be updated from Youtarr.',
        });
      }

      const channel = ytdlpModule.normalizeChannel(configModule.getConfig().ytdlpUpdateChannel);
      const result = await ytdlpModule.performUpdate({ channel });

      // Refresh the cached version after update
      if (result.success) {
        refreshYtDlpVersionCache();
      }

      res.json(result);
    } catch (error) {
      logger.error({ err: error }, 'Failed to update yt-dlp');
      res.status(500).json({
        success: false,
        message: 'Update failed due to an unexpected error',
      });
    }
  });

  return router;
};
