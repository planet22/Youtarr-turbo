/**
 * server/routes/ytstream.js
 *
 * YouTube playback endpoint used by `.strm` sidecar files (see strmGenerator.js).
 * Modeled on jellyfin-youtube-plugin's two modes: "Simple" (direct upstream URL,
 * no ffmpeg) and "Enhanced" (re-stream through local ffmpeg, falling back to
 * Simple on failure). Format selectors mirror YtDlpService.cs; hardware encoding
 * modes mirror ManagedTranscodeService.AddVideoEncoderArguments. Unlike the
 * plugin, reuses Youtarr's own cookie/proxy/IP-family/rate-limit conventions,
 * so age-restricted and members-only content works here too.
 *
 * Routes:
 *   GET /api/ytstream/:youtubeId            -> resolve + play (mode=direct|ffmpeg|hls)
 *   GET /api/ytstream/history               -> paginated stream-history audit trail
 *   DELETE /api/ytstream/history            -> delete stream-history entries by streamId
 *   GET /api/ytstream/:youtubeId/formats     -> debug: list yt-dlp formats (auth required)
 *   GET /api/ytstream/:youtubeId/simulate    -> debug: dry-run the playback decision, no real playback (auth required)
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../logger');
const configModule = require('../modules/configModule');
const ytDlpRunner = require('../modules/ytDlpRunner');
const streamEncoderTuning = require('../modules/streamEncoderTuning');
const { streamDebug } = require('../modules/ytstream/streamDebug');
const { loadYoutubeCookieHeader, buildBaseArgs } = require('../modules/ytstream/ytdlpArgs');
const {
  VALID_TRANSCODE,
  parseBooleanQueryFlag,
  createQueryOverrideResolver,
  getModeFieldCompatibility,
} = require('../modules/ytstream/configResolution');
const {
  resolveQualityHeight,
  getDirectFormatSelector,
  getDashFormatSelectors,
  capResolutionToHeight,
} = require('../modules/ytstream/formatSelection');
const { HLS_UNTRACKED_BUFFER_CACHE_DIR } = require('../modules/ytstream/paths');
const {
  fillMissingTitlesFromMetadataCache,
  persistStreamHistoryStart,
  persistStreamHistoryEnd,
  snapshotStream,
  trackPendingRequest,
  updateStream,
  failStreamThenUntrack,
  untrackStream,
  getStream: getActiveStream,
  listStreams: listActiveStreams,
} = require('../modules/ytstream/activeStreams');
const {
  init: initPlaybackPlan,
  getVideoDurationSeconds,
  clearDurationCache,
  clearAllDurationCache,
  resolvePlaybackPlan,
} = require('../modules/ytstream/playbackPlan');
const {
  resolveDirectUrl,
  redactIncomingHeadersForLogging,
  proxyDirectStream,
  redirectToDirectUrl,
} = require('../modules/ytstream/directMode');
const {
  init: initHlsEngine,
  buildHlsSessionKey,
  rewriteHlsPlaylistUrls,
  getOrCreateHlsSession,
  hasActiveHlsSessionForVideo,
  isHlsSessionActive,
  createHlsAssetRouteHandler,
} = require('../modules/ytstream/hlsEngine');

/** Matches ManagedTranscodeHardwareModes in the reference plugin. */
const { normalizeHardwareMode, normalizeTuning } = streamEncoderTuning;

// fps/duration/formats metadata cache, shared with the download and
// STRM-materialization pipelines and with resolveMaxAvailableHeight
// (server/modules/ytstream/playbackPlan.js) - see
// server/modules/youtubeMetadataCache.js's own doc comment for why (and
// for what's safe vs. NOT safe to reuse out of a cached blob).
const youtubeMetadataCache = require('../modules/youtubeMetadataCache');
const { formatRelativeTimeAgo } = require('../modules/relativeTimeFormatter');

// Persistent (not os.tmpdir(), which most Docker setups wipe on restart) —
// generation is a one-time cost per {signature, resolution}, and a
// predictable path also lets a user drop in their own clip to be used as-is.
//
const {
  getUntrackedBufferCachePath,
  findWarmUntrackedBufferCache,
  sweepExpiredUntrackedBufferCache,
  getUntrackedBufferCacheStat,
  deleteUntrackedBufferCacheFile,
  listUntrackedBufferCacheEntries,
} = require('../modules/ytstream/untrackedBufferCache');

const { resolveVideoTargetResolution } = require('../modules/ytstream/videoResolution');
const { resolveActualServedFileInfo } = require('../modules/ytstream/cacheFinalize');

const {
  isLikelyMetadataProbeRequest,
  evaluateProbeShortcut,
  shouldLogQuickServeHistory,
  tryServeProbeClip,
} = require('../modules/ytstream/probeShortcut');

const {
  tryServeCachedVideoFile,
  findExistingCachedVideoFilePath,
} = require('../modules/ytstream/cacheFinalize');

function createYtStreamRoutes({ verifyToken, getClientAddress, models }) {
  logger.info('Initializing YouTube direct/ffmpeg stream routes');
  initHlsEngine({ models });
  initPlaybackPlan({ models });
  // Any StreamHistory row still "open" (ended_at null) at this point can only
  // be from a server restart — activeStreams itself is in-memory and starts
  // empty every boot, so nothing could still legitimately be tracking it.
  // Close these out so a crash/restart mid-stream doesn't leave permanently
  // "still playing" rows in the history table.
  if (models && models.StreamHistory) {
    models.StreamHistory.update(
      { ended_at: new Date(), end_reason: 'server-restart' },
      { where: { ended_at: null } }
    ).then((result) => {
      const count = Array.isArray(result) ? result[0] : result;
      if (count) logger.info({ count }, 'ytstream: closed out stream-history rows left open by a previous server restart');
    }).catch((err) => {
      logger.warn({ err }, 'ytstream: failed to close out orphaned stream-history rows on startup');
    });
  }
  const authMiddleware = typeof verifyToken === 'function'
    ? verifyToken
    : (req, res, next) => next();
  // Falls back to the raw socket address if the caller (older wiring,
  // tests) doesn't pass getClientAddress — same default server.js's own
  // getDirectClientAddress would produce without an explicit TRUST_PROXY.
  const resolveRawClientIp = typeof getClientAddress === 'function'
    ? getClientAddress
    : (req) => req.socket?.remoteAddress || req.ip;
  // IPv4 connections on a dual-stack socket report as IPv4-mapped IPv6
  // ("::ffff:172.19.0.6") - strip that prefix so logs, the Streaming page,
  // and StreamHistory all show the plain IPv4 address instead.
  const resolveClientIp = (req) => {
    const raw = resolveRawClientIp(req);
    return typeof raw === 'string' ? raw.replace(/^::ffff:/i, '') : raw;
  };

  const router = express.Router();

  router.use(['/api/ytstream/:youtubeId', '/api/ytstream/:youtubeId/formats', '/api/ytstream/:youtubeId/hls/:sessionKey/:filename'], (req, res, next) => {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS, HEAD',
      'Access-Control-Allow-Headers': 'Range, Content-Type',
    });
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  /**
   * Streaming page — lists every currently-active mode=hls
   * stream tracked in activeStreams, with a best-effort title lookup (no
   * live yt-dlp fetch). REST source of truth for initial load/reconnects;
   * live deltas come from the streamProgress/streamStarted/streamStopped
   * WebSocket broadcasts.
   *
   * MUST be registered before '/api/ytstream/:youtubeId' below: Express
   * matches by registration order, and "streams" passes that route's own
   * youtubeId format check — without this ordering it gets hijacked as a
   * request for video id "streams".
   */
  router.get('/api/ytstream/streams', authMiddleware, async (req, res) => {
    const streams = listActiveStreams().map(snapshotStream);
    const youtubeIds = [...new Set(streams.map((s) => s.youtubeId))];
    let titleById = {};
    if (youtubeIds.length && models && models.Video) {
      try {
        const rows = await models.Video.findAll({
          where: { youtubeId: youtubeIds },
          attributes: ['youtubeId', 'youTubeVideoName'],
        });
        titleById = Object.fromEntries(rows.map((r) => [r.youtubeId, r.youTubeVideoName]));
      } catch (err) {
        logger.warn({ err }, 'ytstream: failed to resolve titles for /streams');
      }
    }
    await fillMissingTitlesFromMetadataCache(youtubeIds, titleById, models);
    res.json({ streams: streams.map((s) => ({ ...s, title: titleById[s.youtubeId] || null })) });
  });

  /**
   * Configuration UI's single source of truth for whether each ytstream
   * field is required/ignored/optional for a given mode - see
   * getModeFieldCompatibility. The client never hardcodes this logic; it
   * calls this on every mode/transcode change and drives its disabled
   * state + chips straight from the response.
   */
  router.get('/api/ytstream/mode-compatibility', authMiddleware, (req, res) => {
    const mode = String(req.query.mode || 'direct');
    const transcode = String(req.query.transcode || '');
    const container = String(req.query.container || '');
    res.json(getModeFieldCompatibility({ mode, transcode, container }));
  });

  /**
   * Stream History page — persisted audit trail of past playback sessions,
   * unlike /streams which only shows what's currently active. Server-side
   * paginated (unlike the Jobs/DownloadHistory precedent) since this table
   * only grows with normal use, no natural upper bound.
   *
   * MUST be registered before '/api/ytstream/:youtubeId' — same reasoning
   * as '/streams' above.
   */
  router.get('/api/ytstream/history', authMiddleware, async (req, res) => {
    if (!models || !models.StreamHistory) {
      return res.json({ rows: [], total: 0, page: 1, limit: 25 });
    }
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    // 128 (not 100) to match the client's shared ALLOWED_PAGE_SIZES ceiling
    // (see client/src/components/shared/VideoList/pageSizes.ts) - otherwise
    // picking the largest per-page option would silently return fewer rows
    // than the page-size math on the client expects.
    const limit = Math.min(128, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
    try {
      const { Op } = require('sequelize');
      const where = {};
      if (req.query.mode) where.mode = req.query.mode;
      // 'in-progress' isn't a real end_reason value - it's the client's label
      // for "ended_at IS NULL" (see StreamHistoryTable's resultChipFor).
      if (req.query.status === 'in-progress') {
        where.ended_at = null;
      } else if (req.query.status) {
        where.end_reason = req.query.status;
      }
      if (req.query.dateFrom || req.query.dateTo) {
        where.started_at = {};
        if (req.query.dateFrom) where.started_at[Op.gte] = new Date(`${req.query.dateFrom}T00:00:00`);
        if (req.query.dateTo) where.started_at[Op.lte] = new Date(`${req.query.dateTo}T23:59:59.999`);
      }
      const search = (req.query.search || '').trim();
      if (search) {
        // Title isn't a stream_history column (it's joined from Video below
        // for display) - resolve matching youtube_ids from Video first so a
        // title search can still be OR'd in against the other columns.
        const matchingVideoIds = models.Video
          ? (await models.Video.findAll({
              where: { youTubeVideoName: { [Op.like]: `%${search}%` } },
              attributes: ['youtubeId'],
              limit: 500,
            })).map((v) => v.youtubeId)
          : [];
        where[Op.or] = [
          { youtube_id: { [Op.like]: `%${search}%` } },
          { client_ip: { [Op.like]: `%${search}%` } },
          { user_agent: { [Op.like]: `%${search}%` } },
          ...(matchingVideoIds.length ? [{ youtube_id: { [Op.in]: matchingVideoIds } }] : []),
        ];
      }
      const { count, rows } = await models.StreamHistory.findAndCountAll({
        where,
        order: [['started_at', 'DESC']],
        limit,
        offset: (page - 1) * limit,
      });
      const youtubeIds = [...new Set(rows.map((r) => r.youtube_id))];
      let titleById = {};
      if (youtubeIds.length && models.Video) {
        try {
          const videoRows = await models.Video.findAll({
            where: { youtubeId: youtubeIds },
            attributes: ['youtubeId', 'youTubeVideoName'],
          });
          titleById = Object.fromEntries(videoRows.map((v) => [v.youtubeId, v.youTubeVideoName]));
        } catch (err) {
          logger.warn({ err }, 'ytstream: failed to resolve titles for /history');
        }
      }
      await fillMissingTitlesFromMetadataCache(youtubeIds, titleById, models);
      res.json({
        rows: rows.map((r) => ({
          streamId: r.stream_id,
          youtubeId: r.youtube_id,
          title: titleById[r.youtube_id] || null,
          mode: r.mode,
          quality: r.quality,
          container: r.container,
          transcode: r.transcode,
          hardwareMode: r.hardware_mode,
          clientIp: r.client_ip,
          userAgent: r.user_agent,
          startedAt: r.started_at,
          endedAt: r.ended_at,
          bytesTransferred: Number(r.bytes_transferred),
          endReason: r.end_reason,
          errorMessage: r.error_message,
        })),
        total: count,
        page,
        limit,
      });
    } catch (err) {
      logger.error({ err }, 'ytstream: failed to fetch stream history');
      res.status(500).json({ error: 'Failed to fetch stream history' });
    }
  });

  router.delete('/api/ytstream/history', authMiddleware, async (req, res) => {
    if (!models || !models.StreamHistory) {
      return res.json({ success: true, deleted: 0 });
    }
    const { streamIds } = req.body;
    if (!Array.isArray(streamIds) || streamIds.length === 0) {
      return res.status(400).json({ success: false, error: 'streamIds array is required' });
    }
    try {
      const { Op } = require('sequelize');
      const deleted = await models.StreamHistory.destroy({
        where: { stream_id: { [Op.in]: streamIds } },
      });
      res.json({ success: true, deleted });
    } catch (err) {
      logger.error({ err }, 'ytstream: failed to delete stream history entries');
      res.status(500).json({ success: false, error: 'Failed to delete stream history entries' });
    }
  });

  // Manual re-cache trigger for youtube_metadata_cache (duration_seconds/
  // raw_info_json - see the raw_info_json migration's doc comment).
  // Nothing here ever expires on its own (duration/fps are immutable facts
  // about the video, deliberately no TTL), so this is the only way to force
  // a stale-for-some-OTHER-reason row (e.g. it was written before a field
  // this table now also captures existed, or is just suspected wrong) to be
  // relearned - clears both the in-memory caches and the DB row; the next
  // play re-runs a live yt-dlp lookup and repopulates it, same as if this
  // video had never been cached at all.
  // Shared by the single- and bulk-clear routes below so both ways of
  // triggering a clear (one row from the Library page's cache icon, many
  // rows from its bulk-action toolbar) run identical logic.
  async function clearMetadataCacheEntry(youtubeId) {
    clearDurationCache(youtubeId);
    youtubeMetadataCache.clearCachedEntry(youtubeId);
    if (!models || !models.YoutubeMetadataCache) return 0;
    return models.YoutubeMetadataCache.destroy({ where: { youtube_id: youtubeId } });
  }

  router.delete('/api/ytstream/:youtubeId/metadata-cache', authMiddleware, async (req, res) => {
    const { youtubeId } = req.params;
    try {
      const deleted = await clearMetadataCacheEntry(youtubeId);
      res.json({ success: true, deleted });
    } catch (err) {
      logger.error({ err, youtubeId }, 'ytstream: failed to clear youtube_metadata_cache entry');
      res.status(500).json({ success: false, error: 'Failed to clear cached metadata' });
    }
  });

  // Bulk counterpart of the per-video route above, for the Library page's
  // multi-select "Clear Cached Metadata" bulk action.
  router.delete('/api/ytstream/metadata-cache/bulk', authMiddleware, async (req, res) => {
    const youtubeIds = Array.isArray(req.body?.youtubeIds) ? req.body.youtubeIds : [];
    let deleted = 0;
    const failed = [];
    for (const youtubeId of youtubeIds) {
      try {
        deleted += await clearMetadataCacheEntry(youtubeId);
      } catch (err) {
        logger.warn({ err, youtubeId }, 'ytstream: failed to clear one youtube_metadata_cache entry in bulk request');
        failed.push(youtubeId);
      }
    }
    res.json({ success: true, deleted, failed });
  });

  // Per-video detail for the Library page's "Cached Metadata" icon dialog -
  // slim fields by default (never the raw_info_json blob, which can be
  // large); ?raw=true is an explicit opt-in second round trip for the
  // dialog's "Show raw JSON" toggle only.
  router.get('/api/ytstream/:youtubeId/metadata-cache/detail', authMiddleware, async (req, res) => {
    const { youtubeId } = req.params;
    if (!models || !models.YoutubeMetadataCache) {
      return res.status(404).json({ error: 'Not cached' });
    }
    try {
      const row = await models.YoutubeMetadataCache.findByPk(youtubeId);
      if (!row) {
        return res.status(404).json({ error: 'Not cached' });
      }
      let info = null;
      if (row.raw_info_json) {
        try {
          info = JSON.parse(row.raw_info_json);
        } catch (err) {
          logger.warn({ err, youtubeId }, 'ytstream: failed to parse cached raw_info_json');
        }
      }
      const retentionDays = youtubeMetadataCache.YOUTUBE_METADATA_CACHE_RETENTION_DAYS;
      const expiresAt = row.last_accessed_at
        ? new Date(new Date(row.last_accessed_at).getTime() + retentionDays * 24 * 60 * 60 * 1000).toISOString()
        : null;
      const detail = {
        youtubeId,
        durationSeconds: row.duration_seconds,
        fetchedAt: row.fetched_at,
        fetchedAgo: formatRelativeTimeAgo(row.fetched_at),
        lastAccessedAt: row.last_accessed_at,
        lastAccessedAgo: formatRelativeTimeAgo(row.last_accessed_at),
        expiresAt,
        title: info?.title ?? null,
        uploader: info?.uploader ?? info?.channel ?? null,
        resolution: info && info.width && info.height ? `${info.width}x${info.height}` : null,
        fps: info?.fps ?? null,
        uploadDate: info?.upload_date ?? null,
        // False for a row written by the cheap calculatedLength duration-only
        // probe (ytstream.js's getVideoDurationSeconds) that this video has
        // never actually streamed/downloaded/materialized past - see
        // youtubeMetadataCache.js's cacheRawInfoJson doc comment. Lets the
        // client tell "nothing here yet" apart from "something broke"
        // without an extra raw=true round trip.
        hasRawInfoJson: Boolean(row.raw_info_json),
      };
      if (req.query.raw === 'true') {
        detail.rawInfoJson = info;
      }
      res.json(detail);
    } catch (err) {
      logger.error({ err, youtubeId }, 'ytstream: failed to read metadata cache detail');
      res.status(500).json({ error: 'Failed to read cached metadata' });
    }
  });

  // Bulk count/clear for the Settings UI - unlike the per-video route above
  // (a targeted "this one row is wrong" fix), this is the coarse "start
  // fresh" escape hatch: every video's fps/duration gets relearned lazily
  // (streaming warm-up) or proactively (next download/STRM materialize) -
  // never a functional requirement, purely a manual reset.
  router.get('/api/ytstream/metadata-cache', authMiddleware, async (req, res) => {
    try {
      const count = await youtubeMetadataCache.countCached();
      res.json({ count });
    } catch (err) {
      logger.error({ err }, 'ytstream: failed to count youtube_metadata_cache rows');
      res.status(500).json({ error: 'Failed to count cached metadata' });
    }
  });

  router.delete('/api/ytstream/metadata-cache', authMiddleware, async (req, res) => {
    clearAllDurationCache();
    try {
      await youtubeMetadataCache.clearAll();
      res.json({ success: true });
    } catch (err) {
      logger.error({ err }, 'ytstream: failed to clear youtube_metadata_cache');
      res.status(500).json({ success: false, error: 'Failed to clear cached metadata' });
    }
  });

  // Youtarr's own untracked-buffer cache (HLS_UNTRACKED_BUFFER_CACHE_DIR) -
  // mode=hls-buffer's finished download for a video with no
  // library Video row (an untracked NZB grab, or one disowned via
  // importStrategy:'untracked') - see getModeFieldCompatibility's cacheOnPlay
  // field and finalizeTapOutput's skipVideoUpsert doc comment. Every file in
  // this directory is always a COMPLETE finalized copy - active fetches
  // write to a separate temp dir under HLS_BASE_TEMP_DIR and only land here
  // via an atomic rename once finished - so there's no "mid-write" file to
  // worry about corrupting. The one real caveat: an active stream reading
  // directly off an already-cached file (session.cachedFilePath) will error
  // mid-playback if its underlying file is deleted out from under it - no
  // active-session check here, same as a user manually deleting a real
  // downloaded file while it's playing elsewhere in the app.
  router.get('/api/ytstream/untracked-cache', authMiddleware, async (req, res) => {
    try {
      let fileCount = 0;
      let totalBytes = 0;
      if (fs.existsSync(HLS_UNTRACKED_BUFFER_CACHE_DIR)) {
        const entries = await fs.promises.readdir(HLS_UNTRACKED_BUFFER_CACHE_DIR);
        for (const entry of entries) {
          try {
            const stat = await fs.promises.stat(path.join(HLS_UNTRACKED_BUFFER_CACHE_DIR, entry));
            if (stat.isFile()) {
              fileCount += 1;
              totalBytes += stat.size;
            }
          } catch (err) { /* removed mid-scan - ignore */ }
        }
      }
      res.json({ fileCount, totalBytes });
    } catch (err) {
      logger.error({ err }, 'ytstream: failed to read untracked buffer cache stats');
      res.status(500).json({ error: 'Failed to read untracked buffer cache' });
    }
  });

  router.delete('/api/ytstream/untracked-cache', authMiddleware, async (req, res) => {
    try {
      let deletedFiles = 0;
      let freedBytes = 0;
      if (fs.existsSync(HLS_UNTRACKED_BUFFER_CACHE_DIR)) {
        const entries = await fs.promises.readdir(HLS_UNTRACKED_BUFFER_CACHE_DIR);
        for (const entry of entries) {
          const filePath = path.join(HLS_UNTRACKED_BUFFER_CACHE_DIR, entry);
          try {
            const stat = await fs.promises.stat(filePath);
            if (!stat.isFile()) continue;
            await fs.promises.unlink(filePath);
            deletedFiles += 1;
            freedBytes += stat.size;
          } catch (err) {
            logger.warn({ err, filePath }, 'ytstream: failed to delete one untracked buffer cache file');
          }
        }
      }
      logger.info({ deletedFiles, freedBytes }, 'ytstream: untracked buffer cache cleared');
      res.json({ success: true, deletedFiles, freedBytes });
    } catch (err) {
      logger.error({ err }, 'ytstream: failed to clear untracked buffer cache');
      res.status(500).json({ success: false, error: 'Failed to clear untracked buffer cache' });
    }
  });

  // Per-video counterpart of the aggregate routes above, for the Library
  // page's "Cached Video" icon on an untracked row.
  router.get('/api/ytstream/:youtubeId/untracked-cache', authMiddleware, async (req, res) => {
    try {
      const stat = await getUntrackedBufferCacheStat(req.params.youtubeId);
      res.json(stat);
    } catch (err) {
      logger.error({ err, youtubeId: req.params.youtubeId }, 'ytstream: failed to read untracked buffer cache entry');
      res.status(500).json({ error: 'Failed to read untracked buffer cache entry' });
    }
  });

  router.delete('/api/ytstream/:youtubeId/untracked-cache', authMiddleware, async (req, res) => {
    try {
      const deleted = await deleteUntrackedBufferCacheFile(req.params.youtubeId);
      res.json({ success: true, deleted: deleted ? 1 : 0 });
    } catch (err) {
      logger.error({ err, youtubeId: req.params.youtubeId }, 'ytstream: failed to delete one untracked buffer cache file');
      res.status(500).json({ success: false, error: 'Failed to delete untracked buffer cache entry' });
    }
  });

  // Bulk counterpart, for the Library page's multi-select "Clear Cached
  // Video" bulk action against a selection of untracked rows.
  router.delete('/api/ytstream/untracked-cache/bulk', authMiddleware, async (req, res) => {
    const youtubeIds = Array.isArray(req.body?.youtubeIds) ? req.body.youtubeIds : [];
    let deletedFiles = 0;
    let freedBytes = 0;
    const failed = [];
    for (const youtubeId of youtubeIds) {
      // findWarmUntrackedBufferCache (not getUntrackedBufferCachePath, which
      // is always `.ts`) so this catches a finalizeToMp4'd `.mp4` too - same
      // both-extensions lookup the per-video delete route above already uses.
      const filePath = findWarmUntrackedBufferCache(youtubeId);
      if (!filePath) continue;
      try {
        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile()) continue;
        await fs.promises.unlink(filePath);
        deletedFiles += 1;
        freedBytes += stat.size;
      } catch (err) {
        if (err.code !== 'ENOENT') {
          logger.warn({ err, youtubeId }, 'ytstream: failed to delete one untracked buffer cache file in bulk request');
          failed.push(youtubeId);
        }
      }
    }
    res.json({ success: true, deletedFiles, freedBytes, failed });
  });

  router.get('/api/ytstream/:youtubeId', async (req, res) => {
    // debug (not info): fires on every single request to this route,
    // including every HLS.js/AVPlayer segment poll - see 'ytstream: serving
    // HLS asset' below for the same reasoning. Turn on ytstream.debugLogging
    // (or bump LOG_LEVEL/Settings log level to 'debug') to see these again
    // when actually diagnosing a request-level issue (client identity,
    // headers, probe detection).
    streamDebug(
      {
        url: req.originalUrl,
        query: req.query,
        method: req.method,
        clientIp: resolveClientIp(req),
        headers: redactIncomingHeadersForLogging(req.headers),
        likelyMetadataProbe: isLikelyMetadataProbeRequest(req),
      },
      'ytstream: incoming request'
    );
    const { youtubeId } = req.params;
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(youtubeId)) {
      return res.status(400).send('Invalid video id');
    }

    // Shared by every cached-file-direct-serve check below - see
    // serveCachedFile's own comment for why this only applies to a fresh
    // playback attempt, never mid-session: a calculatedLength session
    // negotiates Range/seek math against its own ESTIMATED length at
    // session start, and swapping in the real file's actual size mid-
    // session makes existing Range requests land at the wrong byte - a
    // bare-"Lavf" request with a large Range offset mid-session isn't a
    // real probe either (those want the file start), it's a genuine player
    // seek, and this same mismatch produced "skipped, then played from the
    // wrong location".
    const hasActiveSessionForVideo = hasActiveHlsSessionForVideo(youtubeId);

    // ytstream.probeShortcut - must run before EVERYTHING else in this
    // handler (cache-on-play trigger included): a detected metadata probe
    // must never cause real ffmpeg/HLS session work or a background
    // download. Only exception: one bare `yt-dlp --print duration` call the
    // first time an untracked video is probed - a few seconds, not the
    // 15-45s+ a real cold start costs, and cached (getVideoDurationSeconds)
    // so it's never repeated.
    {
      if (!hasActiveSessionForVideo && evaluateProbeShortcut(req, configModule.getConfig()).wouldFire) {
        const existingCachedFilePath = await findExistingCachedVideoFilePath(youtubeId, models);
        if (existingCachedFilePath) {
          logger.info(
            { youtubeId, servedAs: 'cache', filePath: existingCachedFilePath },
            'ytstream: probe-shortcut detected a likely metadata-probe request; served the real cached file instead of the synthetic clip'
          );
          // Not a live/trackable session (no HLS process, done before this
          // function returns) - just a StreamHistory audit row, same
          // reasoning as mode=direct below, so this quick cache-hit shows up
          // somewhere instead of being invisible to the Streaming page.
          // shouldLogQuickServeHistory collapses a burst of these (e.g.
          // Jellyfin's own ffprobe keyframe-extraction pass, which reads
          // scattered chunks across the whole file in a handful of requests
          // a few hundred ms apart) into a single row per youtubeId per
          // cooldown window, instead of one row per request.
          const historyEntry = shouldLogQuickServeHistory(youtubeId)
            ? {
                streamId: crypto.randomUUID(),
                mode: 'probe-cache-hit',
                youtubeId,
                ...(await resolveActualServedFileInfo(youtubeId, existingCachedFilePath, models)),
                clientIp: resolveClientIp(req),
                userAgent: req.headers['user-agent'] || null,
                startedAt: Date.now(),
              }
            : null;
          if (historyEntry) persistStreamHistoryStart(historyEntry);
          const servedReal = await tryServeCachedVideoFile(req, res, existingCachedFilePath);
          if (servedReal) {
            if (historyEntry) persistStreamHistoryEnd(historyEntry, 'completed', null);
            return;
          }
          if (historyEntry) persistStreamHistoryEnd(historyEntry, 'error', 'cached file vanished before serving');
          // Fell through (e.g. the file vanished between the check and the
          // stat) - fall back to the synthetic clip below rather than fail
          // the probe outright.
        }
        const sourceResolution = await resolveVideoTargetResolution(youtubeId, models);
        const probeCfg = configModule.getConfig().ytstream || {};
        const probeQueryOverride = createQueryOverrideResolver(req, probeCfg);
        const probeQuality = probeQueryOverride('quality') || probeCfg.quality || configModule.getConfig().preferredResolution || '720';
        const { width, height } = capResolutionToHeight(sourceResolution.width, sourceResolution.height, resolveQualityHeight(probeQuality));
        const served = await tryServeProbeClip(req, res, {
          hardwareMode: normalizeHardwareMode(probeQueryOverride('hardware') || probeCfg.hardwareMode || 'none'),
          tuning: normalizeTuning(probeQueryOverride('tuning') || probeCfg.tuning || 'fast'),
          width,
          height,
          youtubeId,
          resolveDurationSeconds: (id) => getVideoDurationSeconds(id, configModule.getConfig()),
        });
        if (served) return;
        logger.warn(
          { youtubeId, servedAs: 'none' },
          'ytstream: probe-shortcut detected a likely metadata-probe request but could not serve a cached file or the synthetic clip; falling through to normal handling'
        );
      }
    }

    // ytstream.serveCachedFile: if this video is already fully downloaded
    // (STRM cache-on-play, or any genuine download), serve that real local
    // file directly - see tryServeCachedVideoFile above. Checked before the
    // cache-on-play trigger and before any mode/quality resolution. Off by
    // default.
    //
    // Only for the FIRST request of a fresh playback attempt (no live HLS
    // session yet) - applying this mid-session breaks playback: a
    // calculatedLength session has negotiated Range/seek math against its
    // ESTIMATED length, and swapping in the real file's different size
    // mid-session made Range requests land at the wrong offset (the video
    // repeatedly jumped forward). An already-running mode=hls session
    // instead gets the real file via maybeHotSwapToCache, which preserves
    // segment/index continuity instead.
    if ((configModule.getConfig().ytstream || {}).serveCachedFile === true && models && models.Video) {
      if (!hasActiveSessionForVideo) {
        try {
          // Timed: this is the ONLY awaited call between 'incoming request'
          // and resolvePlaybackPlan's first probe, so a multi-second gap
          // between those log lines has to be spent here or in Node's event
          // loop. youtubeId is indexed, so a large elapsedMs here points at
          // DB contention or a slow query, not anything downstream.
          const serveCachedFileLookupStarted = Date.now();
          const cachedVideo = await models.Video.findOne({
            where: { youtubeId },
            attributes: ['is_strm', 'filePath'],
          });
          const serveCachedFileLookupMs = Date.now() - serveCachedFileLookupStarted;
          if (serveCachedFileLookupMs > 250) {
            logger.warn({ youtubeId, serveCachedFileLookupMs }, 'ytstream: serveCachedFile\'s Video lookup was unexpectedly slow');
          }
          if (cachedVideo && cachedVideo.is_strm === false && cachedVideo.filePath && fs.existsSync(cachedVideo.filePath)) {
            logger.info({ youtubeId, filePath: cachedVideo.filePath }, 'ytstream: serving already-downloaded local file directly (serveCachedFile)');
            // See shouldLogQuickServeHistory's comment above (probe-shortcut
            // branch) - same burst-collapsing, same reason.
            const historyEntry = shouldLogQuickServeHistory(youtubeId)
              ? {
                  streamId: crypto.randomUUID(),
                  mode: 'cached-file',
                  youtubeId,
                  ...(await resolveActualServedFileInfo(youtubeId, cachedVideo.filePath, models)),
                  clientIp: resolveClientIp(req),
                  userAgent: req.headers['user-agent'] || null,
                  startedAt: Date.now(),
                }
              : null;
            if (historyEntry) persistStreamHistoryStart(historyEntry);
            const served = await tryServeCachedVideoFile(req, res, cachedVideo.filePath);
            if (served) {
              if (historyEntry) persistStreamHistoryEnd(historyEntry, 'completed', null);
              return;
            }
            if (historyEntry) persistStreamHistoryEnd(historyEntry, 'error', 'cached file vanished before serving');
          }
        } catch (err) {
          logger.warn({ err, youtubeId }, 'ytstream: serveCachedFile lookup failed; falling back to normal handling');
        }
      }
    }

    // Fire-and-forget: every STRM play (browser redirect from videoDetail.js,
    // or a media server reading the raw ytstream URL baked into its .strm
    // file) passes through here, so this is the one place that sees every
    // play. Never awaited - must add zero latency to the response below.
    //
    // Cheap, synchronous, hand-maintained mirror of resolvePlaybackPlan's
    // mode/seek resolution (same trade-off/precedent as the probeShortcut
    // pre-check above it) - only used to decide whether mode=hls-buffer
    // will actually attempt its own fetch for THIS request, so
    // the cache-on-play trigger below can be skipped without adding a
    // DB/probe round trip to every single request just to make that call.
    const cheapCfg = configModule.getConfig().ytstream || {};
    const cheapQueryOverride = createQueryOverrideResolver(req, cheapCfg);
    const cheapMode = String(cheapQueryOverride('mode') || cheapCfg.defaultMode || 'direct').toLowerCase();

    // Streaming page live tracking - see activeStreams.js's
    // trackPendingRequest doc comment. Only for the two modes that page
    // actually visualizes (hls/hls-buffer): direct/direct-redirect are
    // still audit-only (StreamHistory), same as before - a single proxied
    // request there has no session/steps of its own to show progress
    // through. cheapMode (not the real plan.mode, not known for several
    // more lines) is deliberately used here so the row appears
    // before any of the slow yt-dlp probing below even starts; the rare
    // case where the real resolved plan.mode disagrees (an invalid mode
    // string falling back - see resolvePlaybackPlan) is cleaned up once
    // that's known, a little further down.
    let pendingCancelled = false;
    const requestStreamId = (cheapMode === 'hls' || cheapMode === 'hls-buffer') ? crypto.randomUUID() : null;
    if (requestStreamId) {
      trackPendingRequest({
        streamId: requestStreamId,
        mode: cheapMode,
        youtubeId,
        clientIp: resolveClientIp(req),
        userAgent: req.headers['user-agent'] || null,
        state: 'requested',
        startedAt: Date.now(),
        // Stopped from the Streaming page before a real session exists -
        // there's no in-flight yt-dlp probe/session to actually cancel yet,
        // but at least stop this request from silently turning into a live
        // stream right after the user told it to stop.
        stop: () => { pendingCancelled = true; untrackStream(requestStreamId, 'manual-stop'); },
      });
    }

    // mode=hls-buffer replaces cache-on-play entirely - its own
    // independent fetch does the same job, unconditionally, since the
    // buffer fetch doesn't depend on which segment is being played at all.
    const bufferWillAttempt = cheapMode === 'hls-buffer';
    require('../modules/strmCacheOnPlay').maybeEnqueueCacheDownload(youtubeId, { skip: bufferWillAttempt }).catch((err) =>
      logger.warn({ err, youtubeId }, 'ytstream: cache-on-play trigger failed')
    );

    // Cheap/nominal mirrors of resolvePlaybackPlan's own transcode/
    // calculatedLength resolution (same shared queryOverride precedence
    // helper resolvePlaybackPlan itself uses, just resolved eagerly here
    // instead of via that function's own closure) - used by the two
    // warm-ups below.
    const cheapTranscode = VALID_TRANSCODE.includes(cheapQueryOverride('transcode'))
      ? cheapQueryOverride('transcode')
      : (cheapCfg.transcode || 'copy');
    const cheapCalculatedLengthRaw = (cheapQueryOverride('calculatedLength') ?? cheapQueryOverride('fakeLength')) ?? cheapCfg.calculatedLength;
    const cheapIsHlsFamily = cheapMode === 'hls' || cheapMode === 'hls-buffer';
    // getModeFieldCompatibility is cheap/synchronous/pure itself - no need
    // for a separately-hand-maintained duplicate of its calculatedLength
    // rule here, unlike cheapIsHlsFamily above (a general mode-category
    // check the placeholder warm-up below also needs on its own, not
    // specific to any one field's compatibility).
    const cheapCalculatedLength = getModeFieldCompatibility({ mode: cheapMode, transcode: cheapTranscode }).calculatedLength.status === 'forced'
      ? true
      : parseBooleanQueryFlag(cheapCalculatedLengthRaw);

    // Duration warm-up: kicked off here too, since createHlsSessionInternal's
    // own getVideoDurationSeconds call only runs after resolvePlaybackPlan
    // (and its quality/codec probes) has already fully finished, so without
    // this the two were fully serial (probe, THEN duration lookup) rather
    // than overlapping. Observed live: a ~7s quality probe followed by a
    // further ~5s duration lookup (this video's duration wasn't cached in
    // the DB yet) - back to back, ~12s before anything reached the client at
    // all. Dedup'd against the real call via durationLookupPromises, so this
    // never spawns a second yt-dlp process for the same video.
    if (cheapCalculatedLength && cheapIsHlsFamily) {
      getVideoDurationSeconds(youtubeId, configModule.getConfig()).catch((err) =>
        logger.warn({ err, youtubeId }, 'ytstream: early calculatedLength duration warm-up failed')
      );
    }

    const config = configModule.getConfig();
    const ytCfg = config.ytstream || {};

    // Every playback setting (mode/container/transcode/hardwareMode/tuning/
    // quality/calculatedLength/hotSwapToCache), including the
    // forceServerSettings query-override gate and the ffmpeg-availability
    // mode fallback, is resolved by the shared resolvePlaybackPlan - see
    // its doc comment above. Also used (with probe:false) by the read-only
    // GET /api/ytstream/:youtubeId/simulate debug route below, so the two
    // can never drift out of sync.
    // The slow part - real yt-dlp quality/codec probes can take several
    // seconds each. This is the step a user watching the Streaming page
    // would otherwise see nothing at all for.
    if (requestStreamId) updateStream(requestStreamId, { state: 'resolving' });
    let plan;
    try {
      plan = await resolvePlaybackPlan(youtubeId, req, config, { probe: true });
    } catch (err) {
      if (requestStreamId) failStreamThenUntrack(requestStreamId, 'ready-failed', err.message);
      throw err;
    }
    if (requestStreamId && pendingCancelled) {
      // Stopped from the Streaming page while still resolving - nothing
      // left to actually cancel (the probe above already ran to
      // completion), but honor the stop rather than silently starting
      // playback right after the user asked for it to stop.
      if (!res.headersSent) res.status(503).send('Stream request cancelled');
      return;
    }
    const {
      mode,
      container,
      transcode,
      hardwareMode,
      tuning,
      quality,
      qualityStrictness,
      seekSeconds,
      calculatedLength,
      hotSwapToCache,
    } = plan;

    // mode=direct: resolves a URL and proxies it, no retry beyond
    // resolveDirectUrl's own extraction-error retry. On a 403 (a vprv=1
    // session-bound URL rejection) it fails cleanly, full stop - no
    // automatic switch to a different behavior.
    const serveDirect = async (playerClient) => {
      // Not a live/trackable session on the Streaming page (no process to
      // show a Stop button for) - just a StreamHistory
      // audit row, same reasoning as redirectToDirectUrl, so at least a
      // failed/succeeded request shows up somewhere instead of leaving
      // mode=direct completely unaccounted for.
      const streamId = crypto.randomUUID();
      const historyEntry = {
        streamId,
        mode: 'direct',
        youtubeId,
        quality,
        clientIp: resolveClientIp(req),
        userAgent: req.headers['user-agent'] || null,
        startedAt: Date.now(),
      };
      persistStreamHistoryStart(historyEntry);
      try {
        const url = await resolveDirectUrl(youtubeId, config, quality, playerClient, qualityStrictness);
        const cookiesPath = configModule.getCookiesPath && configModule.getCookiesPath();
        const cookieHeader = loadYoutubeCookieHeader(cookiesPath);
        logger.info({ youtubeId, quality }, 'ytstream: proxying direct upstream stream (Simple mode)');
        res.set({ 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' });
        await proxyDirectStream(url, req, res, cookieHeader);
        persistStreamHistoryEnd(historyEntry, 'completed', null);
      } catch (err) {
        persistStreamHistoryEnd(historyEntry, 'error', err.message);
        logger.error({ youtubeId, err: err.message }, 'ytstream: direct stream failed');
        if (!res.headersSent) {
          res.status(502).send(`Direct stream failed: ${err.message}`);
        } else if (!res.writableEnded) {
          try { res.end(); } catch { /* ignore */ }
        }
      }
    };

    try {
      if ((mode === 'hls' || mode === 'hls-buffer') && !plan.ffmpegAvailable) {
        // No fallback to direct - each mode does exactly what it says. If
        // ffmpeg genuinely isn't installed/working on this host,
        // mode=hls/hls-buffer just fails outright
        // instead of silently downgrading to a different mode's behavior.
        logger.error({ youtubeId, mode }, `ytstream: mode=${mode} requested but ffmpeg is unavailable on this host`);
        // A genuine failure to ever start - worth showing as 'failed' for a
        // moment rather than the pending row just disappearing.
        if (requestStreamId) failStreamThenUntrack(requestStreamId, 'ready-failed', `mode=${mode} requires ffmpeg, which is not available on this host`);
        res.status(502).send(`Stream failed: mode=${mode} requires ffmpeg, which is not available on this host`);
        return;
      }

      if (mode === 'direct-redirect') {
        // cheapMode resolved to hls/hls-buffer but the real plan landed on
        // direct-redirect instead (see the invalid-mode-string fallback
        // this file's pending-tracking comment mentions) - no session of
        // ours to hand off to, so just drop the placeholder silently.
        if (requestStreamId) untrackStream(requestStreamId, 'promoted');
        try {
          await redirectToDirectUrl(youtubeId, config, quality, qualityStrictness, ytCfg.playerClient, req, res, resolveClientIp);
        } catch (err) {
          logger.error({ youtubeId, err: err.message }, 'ytstream: direct-redirect resolve failed');
          if (!res.headersSent) {
            res.status(502).send(`Stream resolution failed: ${err.message}`);
          }
        }
        return;
      }

      if (mode === 'hls' || mode === 'hls-buffer') {
        const isBufferMode = mode === 'hls-buffer';
        const sessionKey = buildHlsSessionKey({ youtubeId, quality, qualityStrictness, transcode, hardwareMode, tuning, container, playerClient: ytCfg.playerClient, calculatedLength, buffer: isBufferMode });
        const baseUrl = `${req.protocol}://${req.get('host')}/api/ytstream/${encodeURIComponent(youtubeId)}/hls/${sessionKey}/`;

        // Session assigned - from here on, the real tracked entry (either
        // freshly created under sessionKey by trackStream inside
        // getOrCreateHlsSession, or an already-running session this
        // request is just joining) is the row that represents this
        // stream. Hand off silently so the Streaming page never shows two
        // rows for one request.
        if (requestStreamId) untrackStream(requestStreamId, 'promoted');

        let clientGoneWhileWaiting = false;
        const onClientGoneWhileWaiting = () => {
          clientGoneWhileWaiting = true;
          logger.warn(
            { youtubeId, sessionKey },
            'ytstream: client disconnected from mode=hls request while still waiting for the HLS session to become ready'
          );
        };
        req.once('aborted', onClientGoneWhileWaiting);
        req.once('close', onClientGoneWhileWaiting);

        const waitStarted = Date.now();
        try {
          const session = await getOrCreateHlsSession(sessionKey, {
            youtubeId, quality, qualityStrictness, transcode, hardwareMode, tuning, container, config, baseUrl, seekSeconds, calculatedLength,
            // mode=hls-buffer replaces hotSwapToCache/cache-on-play entirely
            // rather than layering on top of it - see startHlsBufferFetch.
            hotSwapToCache: isBufferMode ? false : hotSwapToCache,
            bufferEnabled: isBufferMode,
            clientIp: resolveClientIp(req),
            userAgent: req.headers['user-agent'] || null,
          });
          if (clientGoneWhileWaiting || res.writableEnded) {
            return;
          }
          const rawPlaylist = await fs.promises.readFile(session.playlistPath, 'utf8');
          const playlist = rewriteHlsPlaylistUrls(rawPlaylist, session.baseUrl);
          // debug: fires on every playlist request for an already-running
          // session (most of them - only the very first is a real cold
          // start), not just once per session. segmentCount counts the
          // REAL #EXTINF lines in what's actually being sent right now -
          // the ground truth for "how many segments does this
          // playlist currently declare", independent of session.totalSegments
          // (which segmentDurationSeconds/fps corrections above may have
          // since revised without ever rewriting this static file).
          streamDebug(
            {
              youtubeId, sessionKey, waitMs: Date.now() - waitStarted, clientGoneWhileWaiting,
              segmentCount: rawPlaylist.split('\n').filter((line) => line.startsWith('#EXTINF')).length,
              totalSegments: session.totalSegments,
              segmentDurationSeconds: session.segmentDurationSeconds,
            },
            'ytstream: HLS session ready; serving playlist'
          );
          res.set({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
          return res.status(200).send(playlist);
        } catch (err) {
          logger.error(
            { youtubeId, sessionKey, waitMs: Date.now() - waitStarted, clientGoneWhileWaiting, err: err.message },
            'ytstream: HLS session failed to become ready'
          );
          if (!res.headersSent && !clientGoneWhileWaiting) {
            res.status(502).send(`HLS stream failed to start: ${err.message}`);
          }
          return;
        } finally {
          req.removeListener('aborted', onClientGoneWhileWaiting);
          req.removeListener('close', onClientGoneWhileWaiting);
        }
      }

      // cheapMode resolved to hls/hls-buffer but the real plan landed on
      // direct instead (invalid-mode-string fallback) - no session to hand
      // off to.
      if (requestStreamId) untrackStream(requestStreamId, 'promoted');
      return await serveDirect();
    } catch (err) {
      logger.error({ err, youtubeId, msg: err.message }, 'ytstream: resolve failed');
      // Safety net - every branch above already cleans up requestStreamId
      // on its own path, so this is a no-op (entry already gone) unless
      // something threw from a spot that didn't.
      if (requestStreamId) failStreamThenUntrack(requestStreamId, 'ready-failed', err.message);
      if (!res.headersSent) {
        logger.error({ youtubeId, err: err.message }, 'ytstream: stream resolution failed');
        res.status(502).send(`Stream resolution failed: ${err.message}`);
      } else {
        logger.error({ youtubeId, err: err.message }, 'ytstream: stream resolution failed after headers sent; closing connection');
        res.end();
      }
    }
  });


  router.get('/api/ytstream/:youtubeId/formats', authMiddleware, async (req, res) => {
    const { youtubeId } = req.params;
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(youtubeId)) {
      return res.status(400).send('Invalid video id');
    }
    try {
      const config = configModule.getConfig();
      const args = [
        ...buildBaseArgs(config),
        '-F',
        '--no-playlist',
        '--no-warnings',
        `https://youtube.com/watch?v=${youtubeId}`,
      ];
      const stdout = await ytDlpRunner.run(args, { timeoutMs: 60000 });
      res.type('text/plain').send(stdout);
    } catch (err) {
      res.status(502).send(`Failed to list formats: ${err.message}`);
    }
  });

  /**
   * Dry-run for the main streaming route: accepts the exact same query
   * params a real .strm URL would (mode/quality/container/transcode/
   * hardware/tuning/calculatedLength|fakeLength/t), runs them through the
   * same resolvePlaybackPlan() the real route uses, and reports what would
   * happen - without ever resolving a real playback URL, spawning yt-dlp/
   * ffmpeg, creating an HLS session, proxying bytes, or triggering the
   * cache-on-play download. Safe to hit repeatedly.
   *
   * `?probe=true` additionally runs the two real yt-dlp lookups
   * resolvePlaybackPlan can optionally do (the best-available-height auto
   * cap and the transcode=copy codec check), so the trace matches exactly
   * what a real request against this video would decide - at the cost of
   * the same yt-dlp latency a real request would pay. Omit it (the
   * default) for an instant, no-network structural check of the decision
   * flow itself.
   */
  router.get('/api/ytstream/:youtubeId/simulate', authMiddleware, async (req, res) => {
    const { youtubeId } = req.params;
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(youtubeId)) {
      return res.status(400).send('Invalid video id');
    }
    try {
      const config = configModule.getConfig();
      const probe = /^(1|true|yes)$/i.test(String(req.query.probe || ''));
      const plan = await resolvePlaybackPlan(youtubeId, req, config, { probe });

      const isDirectFamilyMode = plan.mode === 'direct' || plan.mode === 'direct-redirect';
      const formatSelectors = isDirectFamilyMode
        ? { direct: getDirectFormatSelector(plan.quality, plan.qualityStrictness) }
        : getDashFormatSelectors(plan.quality, plan.qualityStrictness);

      let hls = null;
      let wouldCall;
      const ffmpegModeBlocked = (plan.mode === 'hls' || plan.mode === 'hls-buffer') && !plan.ffmpegAvailable;
      if (plan.probeShortcut.wouldFire) {
        wouldCall = 'tryServeProbeClip(...) [probeShortcut - real request never reaches the mode/quality logic above]';
      } else if (ffmpegModeBlocked) {
        wouldCall = `502 - mode=${plan.mode} requires ffmpeg, which is unavailable on this host (no fallback to a different mode)`;
      } else if (plan.mode === 'hls' || plan.mode === 'hls-buffer') {
        const sessionKey = buildHlsSessionKey({
          youtubeId,
          quality: plan.quality,
          qualityStrictness: plan.qualityStrictness,
          transcode: plan.transcode,
          hardwareMode: plan.hardwareMode,
          tuning: plan.tuning,
          container: plan.container,
          playerClient: (config.ytstream || {}).playerClient,
          calculatedLength: plan.calculatedLength,
          buffer: plan.mode === 'hls-buffer',
        });
        hls = { sessionKey, sessionAlreadyActive: isHlsSessionActive(sessionKey) };
        wouldCall = `getOrCreateHlsSession(sessionKey: "${sessionKey}")`;
      } else if (plan.mode === 'direct-redirect') {
        wouldCall = `redirectToDirectUrl(quality: "${plan.quality}") [302, no proxy]`;
      } else {
        wouldCall = `serveDirect(quality: "${plan.quality}")`;
      }

      res.json({ youtubeId, probed: probe, plan, formatSelectors, hls, wouldCall });
    } catch (err) {
      res.status(500).json({ error: `Simulation failed: ${err.message}` });
    }
  });

  /** Force-stops one active stream — the Streaming page's Stop button. */
  router.post('/api/ytstream/streams/:streamId/stop', authMiddleware, (req, res) => {
    const entry = getActiveStream(req.params.streamId);
    if (!entry) {
      return res.status(404).json({ error: 'Stream not found' });
    }
    try {
      if (typeof entry.stop === 'function') {
        entry.stop();
      } else {
        // stop() isn't wired up until the HLS session's encode pass exists —
        // narrow window right at request start. Untrack directly rather
        // than leaving the row stuck with a dead Stop button.
        untrackStream(req.params.streamId, 'manual-stop');
      }
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err, streamId: req.params.streamId }, 'ytstream: failed to stop stream');
      res.status(500).json({ error: 'Failed to stop stream' });
    }
  });

  // Serves an HLS session's playlist/init/segment files as ordinary static
  // files - see hlsEngine.js's createHlsAssetRouteHandler doc comment.
  router.get('/api/ytstream/:youtubeId/hls/:sessionKey/:filename', createHlsAssetRouteHandler({ resolveClientIp }));

  return router;
}

module.exports = createYtStreamRoutes;
// Attached rather than exported separately - a function is an object in JS,
// so this doesn't change what any existing require('../routes/ytstream')
// call site sees (they only ever call the export directly). Lets
// cronJobs.js's nightly sweep reach the untracked-cache cleanup without a
// second module or duplicating HLS_UNTRACKED_BUFFER_CACHE_DIR's path.
module.exports.sweepExpiredUntrackedBufferCache = sweepExpiredUntrackedBufferCache;
// Same reasoning - videosModule.js's unified Library query reaches these to
// merge untracked-buffer-cache state into its "Show untracked" rows without
// duplicating HLS_UNTRACKED_BUFFER_CACHE_DIR's path or scanning logic.
module.exports.getUntrackedBufferCacheStat = getUntrackedBufferCacheStat;
module.exports.deleteUntrackedBufferCacheFile = deleteUntrackedBufferCacheFile;
module.exports.listUntrackedBufferCacheEntries = listUntrackedBufferCacheEntries;
// videoMetadataModule.js's getVideoStreamInfo reaches this to serve an
// untracked video's cache file through the normal /api/videos/:id/stream
// endpoint (in-app player) when there's no Videos table row to read a
// filePath from.
module.exports.getUntrackedBufferCachePath = getUntrackedBufferCachePath;
