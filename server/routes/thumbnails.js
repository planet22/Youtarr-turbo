const express = require('express');

// /images/videothumb-<id>.jpg - every UI video thumbnail. Public like the rest
// of /images (an <img> tag cannot send the auth header). Mounted ahead of the
// /images static handler (see server.js) so each view refreshes the file's
// last-viewed time for videoThumbnailCache.pruneUnused.
//
// ?cache=0 ("no-cache"): local copy if there is one, otherwise a redirect to
// YouTube's still - for long lists of videos that may never be downloaded
// (channel/playlist listings, search results), which are not worth keeping.
function createThumbnailRoutes({ videoThumbnailCache, logger }) {
  const router = express.Router();

  /**
   * @swagger
   * /images/videothumb-{youtubeId}.jpg:
   *   get:
   *     summary: Video thumbnail
   *     description: Serves the stored thumbnail, fetching and keeping YouTube's still when missing. Public (no auth).
   *     tags: [Videos]
   *     parameters:
   *       - in: path
   *         name: youtubeId
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: cache
   *         schema:
   *           type: string
   *           enum: ['0']
   *         description: 0 = do not keep a copy; redirect to YouTube when there is no local file
   *     responses:
   *       200:
   *         description: JPEG image
   *       302:
   *         description: Redirect to YouTube's thumbnail (cache=0 only)
   *       404:
   *         description: No thumbnail available
   */
  router.get(/^\/images\/videothumb-([A-Za-z0-9_-]{11})\.jpg$/, async (req, res) => {
    const youtubeId = req.params[0];
    const noCache = req.query.cache === '0';
    try {
      const filePath = noCache
        ? videoThumbnailCache.existingLocalPath(youtubeId)
        : await videoThumbnailCache.ensureLocal(youtubeId);
      if (filePath) {
        return res.sendFile(filePath);
      }
      if (noCache) {
        return res.redirect(302, videoThumbnailCache.youtubeUrl(youtubeId));
      }
      return res.status(404).json({ error: 'Thumbnail not found' });
    } catch (err) {
      logger.error({ err, youtubeId }, 'Failed to serve video thumbnail');
      return res.status(500).json({ error: 'Failed to load thumbnail' });
    }
  });

  return router;
}

module.exports = createThumbnailRoutes;
