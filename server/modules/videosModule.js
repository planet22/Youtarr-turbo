const { Sequelize, sequelize } = require('../db.js');
const { Video } = require('../models');
const fs = require('fs').promises;
const path = require('path');
const configModule = require('./configModule');
const fileCheckModule = require('./fileCheckModule');
const watchStatusQueries = require('./mediaServers/watchStatusQueries');
const logger = require('../logger');
const messageEmitter = require('./messageEmitter');
const m3uGenerator = require('./m3uGenerator');
const { AUDIO_EXTENSIONS, MEDIA_EXTENSIONS } = require('./filesystem/constants');
const { probeVideoDimensions } = require('./resolutionTier');
const createLimiter = require('./subscriptionImport/concurrencyLimiter');
const { formatRelativeTimeAgo } = require('./relativeTimeFormatter');

// Backfill row updates are applied in parameterized batches of this size,
// and flushed mid-chunk at the same cadence so completed work survives a
// time-limit abort.
const BACKFILL_UPDATE_BATCH_SIZE = 100;

// ffprobes are I/O-bound, so running 4 at once cuts backfill wall time
// ~4x without piling up subprocesses next to downloads and Plex.
const BACKFILL_PROBE_CONCURRENCY = 4;

// Safety cap on the "Show untracked" bucket (videos with no Videos row at
// all, surfaced only via youtube_metadata_cache / the untracked buffer
// cache dir) - this is a debugging/cache-management view, not meant to
// browse an unbounded history, so a huge cache just gets truncated to its
// most-recently-touched entries rather than paginating the whole thing.
const UNTRACKED_BUCKET_CAP = 2000;

/**
 * Absolute expiry timestamp for a cache row, or null if the cache type has
 * no configured TTL - the client only ever formats a countdown from this
 * fixed point, never computes one itself, so clock skew between the two
 * can't produce a wrong-looking countdown.
 * @param {string|Date|null} fromTimestamp
 * @param {number|null|undefined} ttlHours
 * @returns {string|null}
 */
function computeExpiresAt(fromTimestamp, ttlHours) {
  if (!fromTimestamp) return null;
  const hours = Number(ttlHours);
  if (!Number.isFinite(hours) || hours <= 0) return null;
  return new Date(new Date(fromTimestamp).getTime() + hours * 60 * 60 * 1000).toISOString();
}

class VideosModule {
  constructor() {
    this._backfillRunning = false;
    this._resolutionTagBackfillRunning = false;
    this._imageRegenRunning = false;
  }

  async getVideosPaginated(options = {}) {
    const {
      page = 1,
      limit = 12,
      search = '',
      dateFrom = null,
      dateTo = null,
      sortBy = 'added',
      sortOrder = 'desc',
      channelFilter = '',
      protectedFilter = 'off',
      missingFilter = 'off',
      watchedFilter = 'off',
      strmFilter = 'off',
      metadataCacheFilter = 'off',
      cachedVideoFilter = 'off',
      showUntracked = false,
    } = options;

    try {
      const offset = (page - 1) * limit;

      // Build WHERE conditions
      const whereConditions = [];
      const replacements = {};

      if (search) {
        whereConditions.push('(Videos.youTubeVideoName LIKE :search OR Videos.youTubeChannelName LIKE :search)');
        replacements.search = `%${search}%`;
      }

      if (channelFilter) {
        whereConditions.push('Videos.youTubeChannelName = :channelFilter');
        replacements.channelFilter = channelFilter;
      }

      if (dateFrom) {
        whereConditions.push('Videos.originalDate >= :dateFrom');
        replacements.dateFrom = dateFrom.replace(/-/g, '');
      }

      if (dateTo) {
        whereConditions.push('Videos.originalDate <= :dateTo');
        replacements.dateTo = dateTo.replace(/-/g, '');
      }

      if (protectedFilter === 'only') {
        whereConditions.push('Videos.protected = 1');
      } else if (protectedFilter === 'exclude') {
        whereConditions.push('Videos.protected = 0');
      }

      if (missingFilter === 'only') {
        whereConditions.push('Videos.removed = 1');
      } else if (missingFilter === 'exclude') {
        whereConditions.push('Videos.removed = 0');
      }

      if (watchedFilter === 'only' || watchedFilter === 'exclude') {
        const watched = watchStatusQueries.buildWatchedExistsSql();
        whereConditions.push(watchedFilter === 'only' ? watched.sql : `NOT ${watched.sql}`);
        Object.assign(replacements, watched.replacements);
      }

      if (strmFilter === 'only') {
        whereConditions.push('Videos.is_strm = 1');
      } else if (strmFilter === 'exclude') {
        whereConditions.push('Videos.is_strm = 0');
      }

      if (metadataCacheFilter === 'only') {
        whereConditions.push('ymc.youtube_id IS NOT NULL');
      } else if (metadataCacheFilter === 'exclude') {
        whereConditions.push('ymc.youtube_id IS NULL');
      }

      // "Cached video" here means the opportunistic STRM cache-on-play
      // materialization (Videos.cached_at) - a genuine, permanently
      // downloaded (non-STRM) video never has cached_at set, so this never
      // matches those rows.
      if (cachedVideoFilter === 'only') {
        whereConditions.push('Videos.cached_at IS NOT NULL');
      } else if (cachedVideoFilter === 'exclude') {
        whereConditions.push('Videos.cached_at IS NULL');
      }

      const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

      // Build ORDER BY
      let orderByColumn;
      if (sortBy === 'published') {
        orderByColumn = 'Videos.originalDate';
      } else {
        orderByColumn = 'COALESCE(Videos.last_downloaded_at, Jobs.timeCreated, STR_TO_DATE(Videos.originalDate, \'%Y%m%d\'))';
      }
      const orderByClause = `ORDER BY ${orderByColumn} ${sortOrder.toUpperCase()}`;

      // Get total count
      const countQuery = `
        SELECT COUNT(DISTINCT Videos.id) as total
        FROM Videos
        LEFT JOIN JobVideos ON Videos.id = JobVideos.video_id
        LEFT JOIN Jobs ON Jobs.id = JobVideos.job_id
        LEFT JOIN youtube_metadata_cache ymc ON ymc.youtube_id = Videos.youtubeId
        ${whereClause}
      `;

      const countResult = await sequelize.query(countQuery, {
        replacements,
        type: Sequelize.QueryTypes.SELECT
      });

      // mysql2 returns COUNT() as a string in raw-query mode - a bare `+`
      // below (combining with untrackedTotal) would silently string-concat
      // instead of add without this coercion (e.g. "86" + 0 -> "860").
      const trackedTotal = Number(countResult[0].total);

      // "Show untracked" mixes videos with no Videos row at all (played but
      // never downloaded, or NZB grabs disowned via importStrategy:
      // 'untracked') - sourced from youtube_metadata_cache and the untracked
      // hls-buffer cache dir, a fundamentally different source with no FK to
      // Videos - into the SAME chronologically-sorted, paginated list as
      // tracked rows. search/dateFrom/dateTo/channelFilter still don't apply
      // to untracked candidates (would require parsing every candidate's
      // raw_info_json up front, defeating the point of the cheap-columns-
      // first pass in _getUntrackedCandidates).
      //
      // Like the STRM filter, metadataCacheFilter/cachedVideoFilter only
      // narrow whatever's already in scope - they never flip showUntracked
      // on by themselves. showUntracked defaults true client-side, so in
      // practice untracked rows are already there to be narrowed; a user
      // who explicitly turns showUntracked off is asking to not see
      // untracked rows at all, and a cache filter shouldn't override that.
      const untrackedCandidates = showUntracked
        ? (await this._getUntrackedCandidates({ sortOrder })).filter((c) => {
          if (metadataCacheFilter === 'only' && !c.hasCachedMetadata) return false;
          if (metadataCacheFilter === 'exclude' && c.hasCachedMetadata) return false;
          if (cachedVideoFilter === 'only' && !c.hasCachedVideo) return false;
          if (cachedVideoFilter === 'exclude' && c.hasCachedVideo) return false;
          return true;
        })
        : [];
      const untrackedTotal = untrackedCandidates.length;
      const total = trackedTotal + untrackedTotal;
      const sortDir = String(sortOrder).toLowerCase() === 'asc' ? 1 : -1;

      const videoColumnsSql = `
          Videos.id,
          Videos.youtubeId,
          Videos.youTubeChannelName,
          Videos.youTubeVideoName,
          Videos.duration,
          Videos.originalDate,
          Videos.description,
          Videos.channel_id,
          Videos.filePath,
          Videos.fileSize,
          Videos.audioFilePath,
          Videos.audioFileSize,
          Videos.removed,
          Videos.youtube_removed,
          Videos.youtube_removed_checked_at,
          Videos.media_type,
          Videos.normalized_rating,
          Videos.rating_source,
          Videos.protected,
          Videos.video_resolution,
          Videos.is_strm,
          Videos.cached_at AS cachedVideoAt,
          ymc.fetched_at AS cachedMetadataAt,
          ymc.last_accessed_at AS cachedMetadataLastAccessedAt,
          COALESCE(Videos.last_downloaded_at, Jobs.timeCreated, STR_TO_DATE(Videos.originalDate, '%Y%m%d')) AS timeCreated
      `;
      const videoJoinsSql = `
        FROM Videos
        LEFT JOIN JobVideos ON Videos.id = JobVideos.video_id
        LEFT JOIN Jobs ON Jobs.id = JobVideos.job_id
        LEFT JOIN youtube_metadata_cache ymc ON ymc.youtube_id = Videos.youtubeId
      `;

      // pageSlice/pageUntrackedCandidates are only populated on the
      // showUntracked path (see below) - the common path skips all of this
      // and keeps its original single LIMIT/OFFSET query, zero risk to the
      // unfiltered/untracked-off case.
      let videos;
      let pageSlice = null;
      let pageUntrackedCandidates = [];

      if (showUntracked) {
        // Two data sources can't share one SQL ORDER BY/LIMIT, so: cheaply
        // fetch every matching tracked id's sort key alone (two columns,
        // not full rows), merge-sort that against the already-sorted
        // untracked candidates, slice the requested page from the UNIFIED
        // order, then fetch full row data only for the tracked ids that
        // actually landed on this page. GROUP BY Videos.id here is safe
        // under ONLY_FULL_GROUP_BY (grouping by a table's primary key makes
        // every other column from THAT table single-valued per group) since
        // only an aggregate of the sort expression is selected alongside it.
        const sortKeyExpr = sortBy === 'published'
          ? 'STR_TO_DATE(Videos.originalDate, \'%Y%m%d\')'
          : 'COALESCE(Videos.last_downloaded_at, Jobs.timeCreated, STR_TO_DATE(Videos.originalDate, \'%Y%m%d\'))';
        const trackedIdRows = await sequelize.query(
          `SELECT Videos.id AS id, MAX(${sortKeyExpr}) AS sortKey ${videoJoinsSql} ${whereClause} GROUP BY Videos.id`,
          { replacements, type: Sequelize.QueryTypes.SELECT }
        );

        // Nulls (a row with no resolvable date at all) sort as "oldest"
        // regardless of direction, rather than crashing the comparator or
        // clumping unpredictably at whichever end Array.sort happens to
        // leave them.
        const combined = [
          ...trackedIdRows.map((r) => ({
            kind: 'tracked',
            id: r.id,
            sortKey: r.sortKey ? new Date(r.sortKey).getTime() : null,
          })),
          ...untrackedCandidates.map((c) => ({
            kind: 'untracked',
            id: c.youtubeId,
            sortKey: new Date(c.cachedMetadataAt || c.cachedVideoAt).getTime(),
            candidate: c,
          })),
        ];
        combined.sort((a, b) => sortDir * ((a.sortKey ?? -Infinity) - (b.sortKey ?? -Infinity)));

        pageSlice = combined.slice(offset, offset + limit);
        const pageTrackedIds = pageSlice.filter((x) => x.kind === 'tracked').map((x) => x.id);
        pageUntrackedCandidates = pageSlice.filter((x) => x.kind === 'untracked').map((x) => x.candidate);

        // No GROUP BY here (unlike the ids-only query above) - selecting
        // ymc.* alongside a GROUP BY Videos.id can trip ONLY_FULL_GROUP_BY
        // depending on sql_mode, since ymc isn't the grouped table. A
        // pre-existing, unrelated JobVideos/Jobs fan-out (a video
        // associated with multiple Jobs) can still duplicate rows here per
        // id, same as the common path below always could - deduped in JS
        // instead, right after the query.
        const rawTrackedRows = pageTrackedIds.length
          ? await sequelize.query(
            `SELECT ${videoColumnsSql} ${videoJoinsSql} WHERE Videos.id IN (:pageTrackedIds)`,
            {
              replacements: { pageTrackedIds },
              type: Sequelize.QueryTypes.SELECT,
              model: Video,
              mapToModel: true,
              raw: true
            }
          )
          : [];
        const dedupedById = new Map(rawTrackedRows.map((v) => [v.id, v]));
        videos = Array.from(dedupedById.values());
      } else {
        const query = `SELECT ${videoColumnsSql} ${videoJoinsSql} ${whereClause} ${orderByClause} LIMIT :limit OFFSET :offset`;
        replacements.limit = limit;
        replacements.offset = offset;
        videos = await sequelize.query(query, {
          replacements,
          type: Sequelize.QueryTypes.SELECT,
          model: Video,
          mapToModel: true,
          raw: true
        });
      }

      // Real-time file check for videos that have a known file path
      // Only check videos with an existing filePath to avoid incorrectly marking videos as removed
      // Videos without a filePath will be handled by the backfill process
      const { videos: checkedVideos, updates } = await fileCheckModule.checkVideoFiles(videos);

      // Update the videos array with the checked results
      for (let i = 0; i < videos.length; i++) {
        videos[i] = checkedVideos[i];
      }

      // Batch update the database if there are changes
      await fileCheckModule.applyVideoUpdates(sequelize, Sequelize, updates);

      // Check if videos still exist on YouTube and mark as removed if they don't
      const videoValidationModule = require('./videoValidationModule');
      const youtubeUpdates = [];
      const timestampUpdates = [];
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

      // Check all videos concurrently for better performance
      // Only check videos that haven't been checked in the last 24 hours
      const checkPromises = videos.map(async (video) => {
        const lastChecked = video.youtube_removed_checked_at ? new Date(video.youtube_removed_checked_at) : null;

        // Skip if already marked as removed or checked within last 24 hours
        if (video.youtube_removed || (lastChecked && lastChecked > twentyFourHoursAgo)) {
          return null;
        }

        if (video.youtubeId) {
          const exists = await videoValidationModule.checkVideoExistsOnYoutube(video.youtubeId);
          const now = new Date();

          if (!exists) {
            logger.info({ youtubeId: video.youtubeId }, 'Video no longer exists on YouTube, marking as removed');
            video.youtube_removed = true;
            video.youtube_removed_checked_at = now;
            return { id: video.id, removed: true, checked_at: now };
          } else {
            // Video exists, just update the timestamp
            video.youtube_removed_checked_at = now;
            return { id: video.id, removed: false, checked_at: now };
          }
        }
        return null;
      });

      const checkResults = await Promise.all(checkPromises);
      const validResults = checkResults.filter(result => result !== null);

      // Separate updates for removed videos and timestamp updates
      for (const result of validResults) {
        if (result.removed) {
          youtubeUpdates.push(result);
        } else {
          timestampUpdates.push(result);
        }
      }

      // Bulk update Videos table for removed videos
      if (youtubeUpdates.length > 0) {
        await Video.update(
          { youtube_removed: true, youtube_removed_checked_at: new Date() },
          { where: { id: youtubeUpdates.map(u => u.id) } }
        );
      }

      // Bulk update Videos table for timestamp-only updates
      if (timestampUpdates.length > 0) {
        await Video.update(
          { youtube_removed_checked_at: new Date() },
          { where: { id: timestampUpdates.map(u => u.id) } }
        );
      }

      // Watched-servers summary for the list UI, honoring the configured
      // watched rule; per-server detail lives behind /api/videos/:id/watch-status.
      const watchedByVideoId = await watchStatusQueries.getWatchedByMap(videos.map((v) => v.id));
      for (const video of videos) {
        video.watchedBy = watchedByVideoId.get(video.id) || [];
      }

      // Cache-state fields for the Library page's "Cached Metadata"/"Cached
      // Video" icons and Downloaded-column expiry tooltip. hasCachedVideo
      // is gated on !removed - fileCheckModule.checkVideoFiles above has
      // already flipped removed=true the instant a materialized cache file
      // goes missing, so this one guard is what keeps the icon from lying
      // about a file that's actually gone, with no separate reconciliation
      // needed for read-path correctness.
      const cacheOnPlayExpiryHours = configModule.getConfig().strm?.cacheOnPlayExpiryHours;
      const metadataRetentionHours = require('./youtubeMetadataCache').YOUTUBE_METADATA_CACHE_RETENTION_DAYS * 24;
      for (const video of videos) {
        video.isTracked = true;
        video.hasCachedMetadata = Boolean(video.cachedMetadataAt);
        video.cachedMetadataExpiresAt = computeExpiresAt(video.cachedMetadataLastAccessedAt, metadataRetentionHours);
        // Pre-formatted "5h 4m ago" text (relativeTimeFormatter.js) so the
        // Library page's per-row caption doesn't grow its own relative-time
        // math that could drift from the video modal's/cache dialog's.
        video.cachedMetadataAgo = formatRelativeTimeAgo(video.cachedMetadataAt);
        video.hasCachedVideo = Boolean(video.cachedVideoAt) && !video.removed;
        video.cachedVideoExpiresAt = computeExpiresAt(video.cachedVideoAt, cacheOnPlayExpiryHours);
        video.cachedVideoAgo = formatRelativeTimeAgo(video.cachedVideoAt);
      }

      // Hydrate only the untracked rows that will actually be returned on
      // this page - title/uploader require parsing raw_info_json, which is
      // deliberately never pulled for the whole capped candidate list.
      const untrackedRows = pageUntrackedCandidates.length
        ? await this._hydrateUntrackedRows(pageUntrackedCandidates, { cacheOnPlayExpiryHours, metadataRetentionHours })
        : [];

      // pageSlice (only set on the showUntracked path) carries the true
      // chronologically-unified order across both sources - rebuild the
      // final page in that exact order rather than concatenating tracked
      // then untracked as two separate blocks.
      const mergedVideos = pageSlice
        ? (() => {
          const trackedById = new Map(videos.map((v) => [v.id, v]));
          const untrackedByYoutubeId = new Map(untrackedRows.map((v) => [v.youtubeId, v]));
          return pageSlice
            .map((entry) => (entry.kind === 'tracked' ? trackedById.get(entry.id) : untrackedByYoutubeId.get(entry.id)))
            .filter(Boolean);
        })()
        : videos;

      // Get all unique channels for the filter dropdown
      const channels = await this.getAllUniqueChannels();

      // Get enabled channels with their channel_ids
      const Channel = require('../models/channel');
      const enabledChannels = await Channel.findAll({
        where: { enabled: true },
        attributes: ['channel_id', 'uploader']
      });

      return {
        videos: mergedVideos,
        total,
        page,
        totalPages: Math.ceil(total / limit),
        channels,
        enabledChannels: enabledChannels.map(ch => ({ channel_id: ch.channel_id, uploader: ch.uploader })),
        ...(showUntracked && { untrackedScopeLimited: untrackedTotal >= UNTRACKED_BUCKET_CAP })
      };
    } catch (err) {
      logger.error({ err }, 'Error in getVideosPaginated');
      throw err;
    }
  }

  /**
   * Every candidate for the "Show untracked" bucket: videos with NO Videos
   * row that still have a youtube_metadata_cache row and/or an untracked
   * hls-buffer cache file. Capped and sorted (most-recent-first by default,
   * flipped for 'asc') so the caller can slice a page out of it the same
   * way the tracked-row SQL query does. search/dateFrom/dateTo/channelFilter
   * are NOT applied here (see getVideosPaginated's doc comment) - only the
   * two cache-presence tri-states matter, and those two buckets ARE this
   * method's two data sources, so they're implicit rather than re-filtered.
   * @returns {Promise<Array<object>>}
   */
  async _getUntrackedCandidates({ sortOrder = 'desc' } = {}) {
    // Cheap columns only - never raw_info_json here, it can be large and
    // this pass may scan up to UNTRACKED_BUCKET_CAP rows just to know
    // what's out there. ORDER BY fetched_at DESC bounds an unbounded cache
    // to its most-recently-cached entries before any further sorting below.
    const metadataRows = await sequelize.query(
      `SELECT youtube_id, duration_seconds, fetched_at, last_accessed_at
       FROM youtube_metadata_cache
       WHERE youtube_id NOT IN (SELECT youtubeId FROM Videos WHERE youtubeId IS NOT NULL)
       ORDER BY fetched_at DESC
       LIMIT :cap`,
      { replacements: { cap: UNTRACKED_BUCKET_CAP }, type: Sequelize.QueryTypes.SELECT }
    );

    const ytstreamRoutes = require('../routes/ytstream');
    const bufferEntries = await ytstreamRoutes.listUntrackedBufferCacheEntries();

    const merged = new Map();
    for (const row of metadataRows) {
      merged.set(row.youtube_id, {
        youtubeId: row.youtube_id,
        durationSeconds: row.duration_seconds,
        hasCachedMetadata: true,
        cachedMetadataAt: row.fetched_at,
        cachedMetadataLastAccessedAt: row.last_accessed_at,
        hasCachedVideo: false,
        cachedVideoAt: null,
        cachedVideoFilePath: null,
        cachedVideoFileSize: null,
      });
    }

    // A buffer file may exist for a youtubeId this dir-listing alone can't
    // tell is actually tracked (e.g. the video was properly downloaded
    // after being cached) - only resolve that for entries not already known
    // untracked via the metadata-cache pass above.
    const unresolvedBufferIds = bufferEntries
      .map((e) => e.youtubeId)
      .filter((id) => !merged.has(id));
    let trackedIdSet = new Set();
    if (unresolvedBufferIds.length) {
      const trackedRows = await sequelize.query(
        'SELECT youtubeId FROM Videos WHERE youtubeId IN (:ids)',
        { replacements: { ids: unresolvedBufferIds }, type: Sequelize.QueryTypes.SELECT }
      );
      trackedIdSet = new Set(trackedRows.map((r) => r.youtubeId));
    }

    for (const entry of bufferEntries) {
      const existing = merged.get(entry.youtubeId);
      if (existing) {
        existing.hasCachedVideo = true;
        existing.cachedVideoAt = entry.mtime;
        existing.cachedVideoFilePath = entry.filePath;
        existing.cachedVideoFileSize = entry.size;
      } else if (!trackedIdSet.has(entry.youtubeId)) {
        merged.set(entry.youtubeId, {
          youtubeId: entry.youtubeId,
          durationSeconds: null,
          hasCachedMetadata: false,
          cachedMetadataAt: null,
          cachedMetadataLastAccessedAt: null,
          hasCachedVideo: true,
          cachedVideoAt: entry.mtime,
          cachedVideoFilePath: entry.filePath,
          cachedVideoFileSize: entry.size,
        });
      }
    }

    const candidates = Array.from(merged.values());
    if (candidates.length > UNTRACKED_BUCKET_CAP) {
      logger.warn(
        { count: candidates.length, cap: UNTRACKED_BUCKET_CAP },
        'videosModule: untracked bucket exceeded cap, truncating to most-recent entries'
      );
    }
    const dir = String(sortOrder).toLowerCase() === 'asc' ? 1 : -1;
    candidates.sort((a, b) => {
      const aTime = new Date(a.cachedMetadataAt || a.cachedVideoAt).getTime();
      const bTime = new Date(b.cachedMetadataAt || b.cachedVideoAt).getTime();
      return dir * (aTime - bTime);
    });
    return candidates.slice(0, UNTRACKED_BUCKET_CAP);
  }

  /**
   * Builds Library-page row objects (matching the tracked-row shape) for a
   * slice of _getUntrackedCandidates' output - only fetches raw_info_json
   * (for title/uploader) for the ids actually being returned this page.
   * @returns {Promise<Array<object>>}
   */
  async _hydrateUntrackedRows(slice, { cacheOnPlayExpiryHours, metadataRetentionHours }) {
    const idsNeedingInfo = slice.filter((c) => c.hasCachedMetadata).map((c) => c.youtubeId);
    const infoById = new Map();
    if (idsNeedingInfo.length) {
      const rows = await sequelize.query(
        'SELECT youtube_id, raw_info_json FROM youtube_metadata_cache WHERE youtube_id IN (:ids)',
        { replacements: { ids: idsNeedingInfo }, type: Sequelize.QueryTypes.SELECT }
      );
      for (const row of rows) {
        if (!row.raw_info_json) continue;
        try {
          infoById.set(row.youtube_id, JSON.parse(row.raw_info_json));
        } catch (err) {
          logger.warn({ err, youtubeId: row.youtube_id }, 'videosModule: failed to parse cached raw_info_json for untracked row');
        }
      }
    }

    return slice.map((candidate) => {
      const info = infoById.get(candidate.youtubeId);
      return {
        id: null,
        youtubeId: candidate.youtubeId,
        youTubeChannelName: info?.uploader ?? info?.channel ?? '',
        youTubeVideoName: info?.title ?? candidate.youtubeId,
        duration: candidate.durationSeconds ?? info?.duration ?? null,
        originalDate: info?.upload_date ?? null,
        description: info?.description ?? null,
        channel_id: null,
        filePath: candidate.cachedVideoFilePath ?? null,
        fileSize: candidate.cachedVideoFileSize ?? null,
        audioFilePath: null,
        audioFileSize: null,
        removed: false,
        youtube_removed: false,
        youtube_removed_checked_at: null,
        media_type: null,
        normalized_rating: null,
        rating_source: null,
        protected: false,
        video_resolution: null,
        is_strm: false,
        watchedBy: [],
        isTracked: false,
        timeCreated: candidate.cachedMetadataAt || candidate.cachedVideoAt,
        hasCachedMetadata: candidate.hasCachedMetadata,
        cachedMetadataAt: candidate.cachedMetadataAt,
        cachedMetadataAgo: formatRelativeTimeAgo(candidate.cachedMetadataAt),
        cachedMetadataExpiresAt: computeExpiresAt(candidate.cachedMetadataLastAccessedAt, metadataRetentionHours),
        hasCachedVideo: candidate.hasCachedVideo,
        cachedVideoAt: candidate.cachedVideoAt,
        cachedVideoAgo: formatRelativeTimeAgo(candidate.cachedVideoAt),
        cachedVideoExpiresAt: computeExpiresAt(candidate.cachedVideoAt, cacheOnPlayExpiryHours),
      };
    });
  }

  /**
   * Bulk update video ratings
   * @param {number[]} videoIds - List of database IDs
   * @param {string|null} rating - The new rating value
   * @returns {Promise<{success:number[], warnings:Array<{id:number, warning:string}>, failed:Array<{id:number, error:string}>}>}
   */
  async bulkUpdateVideoRatings(videoIds, rating) {
    const results = {
      success: [],
      warnings: [],
      failed: []
    };

    const nfoGenerator = require('./nfoGenerator');

    for (const id of videoIds) {
      try {
        const video = await Video.findByPk(id);
        if (!video) {
          results.failed.push({ id, error: 'Video not found' });
          continue;
        }

        await video.update({
          normalized_rating: rating,
          rating_source: 'Manual Override'
        });

        if (video.filePath) {
          const parsedPath = path.parse(video.filePath);
          const jsonPath = path.format({
            dir: parsedPath.dir,
            name: parsedPath.name,
            ext: '.info.json'
          });

          const jsonExists = await fs.access(jsonPath).then(() => true).catch(() => false);
          if (jsonExists) {
            const content = await fs.readFile(jsonPath, 'utf8');
            let jsonData;
            try {
              jsonData = JSON.parse(content);
            } catch (parseErr) {
              logger.warn({ parseErr, jsonPath }, 'Failed to parse .info.json for rating update');
              results.warnings.push({ id, warning: 'Database updated but NFO not regenerated (corrupt .info.json)' });
              continue;
            }

            jsonData.normalized_rating = rating;
            jsonData.rating_source = 'Manual Override';

            await fs.writeFile(jsonPath, JSON.stringify(jsonData, null, 2), 'utf8');
            nfoGenerator.writeVideoNfoFile(video.filePath, jsonData);
          }
        }

        results.success.push(id);
      } catch (err) {
        logger.error({ err, videoId: id }, 'Failed to update video rating');
        results.failed.push({ id, error: err.message });
      }
    }

    return results;
  }

  async getAllUniqueChannels() {
    try {
      // Get all channels from the channels table
      const Channel = require('../models/channel');
      const allChannels = await Channel.findAll({
        attributes: ['title'],
        order: [['title', 'ASC']]
      });

      // Get all unique channel names from videos table
      const videoChannelsQuery = `
        SELECT DISTINCT youTubeChannelName
        FROM Videos
        WHERE youTubeChannelName IS NOT NULL
        ORDER BY youTubeChannelName
      `;

      const videoChannels = await sequelize.query(videoChannelsQuery, {
        type: Sequelize.QueryTypes.SELECT
      });

      // Combine both sets and deduplicate
      const channelSet = new Set();

      // Add channels from channels table
      allChannels.forEach(channel => {
        if (channel.uploader) {
          channelSet.add(channel.uploader);
        }
      });

      // Add channels from videos table
      videoChannels.forEach(row => {
        if (row.youTubeChannelName) {
          channelSet.add(row.youTubeChannelName);
        }
      });

      // Convert to sorted array
      return Array.from(channelSet).sort();
    } catch (err) {
      logger.error({ err }, 'Error in getAllUniqueChannels');
      return [];
    }
  }

  async scanForVideoFiles(dir, fileMap = new Map(), duplicates = new Map()) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          await this.scanForVideoFiles(fullPath, fileMap, duplicates);
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        const ext = path.extname(entry.name).toLowerCase();
        if (!MEDIA_EXTENSIONS.includes(ext)) {
          continue;
        }

        // Match files ending with [<id>].<ext>; <id> is whatever yt-dlp wrote
        // between the brackets at the end of the filename.
        const match = entry.name.match(/\[([^[\]]+)\]\.[a-z0-9]+$/i);
        if (!match) {
          continue;
        }

        const youtubeId = match[1];
        const isAudio = AUDIO_EXTENSIONS.includes(ext);
        const stats = await fs.stat(fullPath);

        if (!fileMap.has(youtubeId)) {
          fileMap.set(youtubeId, {
            videoFilePath: null,
            videoFileSize: null,
            audioFilePath: null,
            audioFileSize: null
          });
        }

        const existing = fileMap.get(youtubeId);
        const pathKey = isAudio ? 'audioFilePath' : 'videoFilePath';
        const sizeKey = isAudio ? 'audioFileSize' : 'videoFileSize';

        if (existing[pathKey]) {
          if (!duplicates.has(youtubeId)) {
            duplicates.set(youtubeId, []);
          }
          duplicates.get(youtubeId).push(fullPath);

          if (stats.size > existing[sizeKey]) {
            logger.warn(
              { youtubeId, filePath: fullPath, size: stats.size, type: ext },
              'Duplicate found: keeping larger file'
            );
            existing[pathKey] = fullPath;
            existing[sizeKey] = stats.size;
          }
        } else {
          existing[pathKey] = fullPath;
          existing[sizeKey] = stats.size;
        }
      }
    } catch (err) {
      logger.error({ err, dir }, 'Error scanning directory');
    }

    return { fileMap, duplicates };
  }

  /**
   * Apply backfill row updates in small parameterized batches. Deliberately
   * does not check the run's time limit: once a flush starts it completes,
   * so the expensive work already done (ffprobes, file stats) is never
   * discarded. A flush of <= 1000 plain UPDATEs overruns the limit by
   * seconds at most.
   */
  async _flushBackfillUpdates(updates) {
    for (let i = 0; i < updates.length; i += BACKFILL_UPDATE_BATCH_SIZE) {
      await new Promise(resolve => setImmediate(resolve)); // Yield control

      const batch = updates.slice(i, i + BACKFILL_UPDATE_BATCH_SIZE);

      // Use individual parameterized updates to handle special characters properly
      let batchSuccess = 0;
      let batchFailed = 0;

      for (const update of batch) {
        const setClauses = [];
        const replacements = [];

        if (update.filePath !== undefined) {
          setClauses.push('filePath = ?');
          replacements.push(update.filePath);
        }
        if (update.fileSize !== undefined) {
          setClauses.push('fileSize = ?');
          replacements.push(update.fileSize);
        }
        if (update.audioFilePath !== undefined) {
          setClauses.push('audioFilePath = ?');
          replacements.push(update.audioFilePath);
        }
        if (update.audioFileSize !== undefined) {
          setClauses.push('audioFileSize = ?');
          replacements.push(update.audioFileSize);
        }
        if (update.video_resolution !== undefined) {
          setClauses.push('video_resolution = ?');
          replacements.push(update.video_resolution);
        }
        if (update.removed !== undefined) {
          setClauses.push('removed = ?');
          replacements.push(update.removed ? 1 : 0);
        }

        if (setClauses.length > 0) {
          replacements.push(update.id);
          const query = `UPDATE Videos SET ${setClauses.join(', ')} WHERE id = ?`;

          try {
            await sequelize.query(query, {
              replacements: replacements,
              type: Sequelize.QueryTypes.UPDATE
            });
            batchSuccess++;
          } catch (err) {
            batchFailed++;
            logger.error({ err, videoId: update.id }, 'Failed to update video');
          }
        }
      }

      if (batchFailed > 0) {
        logger.info({ batchSuccess, batchFailed }, 'Batch update results');
      }
    }
  }

  async backfillVideoMetadata(arg = {}) {
    const opts = typeof arg === 'number' ? { timeLimit: arg } : arg;
    const timeLimit = opts.timeLimit ?? 5 * 60 * 1000;
    const trigger = opts.trigger ?? 'scheduled';

    if (this._backfillRunning) {
      logger.info({ trigger }, 'Backfill already running, skipping');
      return { skipped: true, reason: 'already-running' };
    }
    this._backfillRunning = true;

    const startTime = Date.now();
    const startedAtIso = new Date(startTime).toISOString();
    const logProgress = (message) => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      logger.info({ elapsed, context: 'backfill' }, message);
    };

    let totalProcessed = 0;
    let totalUpdated = 0;
    let totalRemoved = 0;
    let fileMapSize = 0;
    let result;

    try {
      // Emit inside the try so a synchronous emit failure still triggers the
      // finally block and clears the lock.
      messageEmitter.emitMessage('broadcast', null, 'server', 'rescanStatus', {
        running: true,
        trigger
      });

      logProgress('Starting video metadata backfill...');
      const outputDir = configModule.directoryPath;

      if (!outputDir) {
        logger.info('No YouTube output directory configured, skipping backfill');
        return;
      }

      // Check time limit before expensive operations
      const checkTimeLimit = () => {
        if (Date.now() - startTime > timeLimit) {
          throw new Error(`Time limit exceeded (${timeLimit / 1000}s)`);
        }
      };

      // First, scan filesystem for all video files
      logProgress('Scanning filesystem for video files...');
      const { fileMap, duplicates } = await this.scanForVideoFiles(outputDir);
      fileMapSize = fileMap.size;
      logProgress(`Found ${fileMap.size} video files on disk`);


      if (duplicates.size > 0) {
        logger.warn({ duplicateCount: duplicates.size }, 'Found videos with duplicate files');
        for (const [youtubeId, paths] of duplicates.entries()) {
          logger.warn({ youtubeId, fileCount: paths.length, paths }, 'Duplicate video files found');
        }
      }

      checkTimeLimit();

      // Process videos in chunks to avoid memory issues
      const VIDEO_CHUNK_SIZE = 1000; // Process 1000 videos at a time
      const probeLimit = createLimiter(BACKFILL_PROBE_CONCURRENCY);
      let offset = 0;

      // Get total count first
      const totalCount = await Video.count();
      logProgress(`Processing ${totalCount} videos from database...`);

      while (offset < totalCount) {
        checkTimeLimit();

        // Fetch a chunk of videos
        const videos = await Video.findAll({
          attributes: ['id', 'youtubeId', 'filePath', 'fileSize', 'audioFilePath', 'audioFileSize', 'removed', 'video_resolution'],
          limit: VIDEO_CHUNK_SIZE,
          offset: offset,
          raw: true
        });

        if (videos.length === 0) break;

        const bulkUpdates = [];
        let chunkUpdated = 0;
        let chunkRemoved = 0;

        // Process the chunk in 100-row slices: probe, apply the row logic, flush.
        for (let sliceStart = 0; sliceStart < videos.length; sliceStart += BACKFILL_UPDATE_BATCH_SIZE) {
          checkTimeLimit();
          await new Promise(resolve => setImmediate(resolve)); // Yield control

          const slice = videos.slice(sliceStart, sliceStart + BACKFILL_UPDATE_BATCH_SIZE);

          // Backfill dimensions for rows that predate the video_resolution
          // column. ffprobe on the actual file is ground truth; only probed
          // while the column is NULL. "0x0" = probed but undeterminable,
          // which stops failed rows from being re-probed every night (the
          // file may sit on a network share); a later re-download re-stamps
          // at download time regardless.
          //
          // .strm is in VIDEO_EXTENSIONS (scanForVideoFiles treats it as this
          // video's "file" for STRM-library entries), but its contents are
          // just a URL pointer, never real media bytes - ffprobing one is
          // guaranteed to fail every time ("Invalid data found when
          // processing input"), so skip straight to the same "0x0"
          // undeterminable marker other unprobeable files get, instead of
          // wasting a subprocess spawn on a call that can never succeed.
          const probeResults = new Map();
          await Promise.all(slice.map((video) => {
            const fileInfo = fileMap.get(video.youtubeId);
            if (!fileInfo || !fileInfo.videoFilePath || video.video_resolution != null) {
              return null;
            }
            if (path.extname(fileInfo.videoFilePath).toLowerCase() === '.strm') {
              probeResults.set(video.youtubeId, '0x0');
              return null;
            }
            return probeLimit(async () => {
              const probed = await probeVideoDimensions(fileInfo.videoFilePath);
              probeResults.set(video.youtubeId, probed === null ? '0x0' : probed);
            });
          }).filter(Boolean));

          for (const video of slice) {
            const fileInfo = fileMap.get(video.youtubeId);

            if (fileInfo) {
              // Check if any file exists (video or audio)
              const hasVideoFile = !!fileInfo.videoFilePath;
              const hasAudioFile = !!fileInfo.audioFilePath;
              const hasAnyFile = hasVideoFile || hasAudioFile;

              if (hasAnyFile) {
                // Check if update needed for video file
                const videoPathChanged = hasVideoFile && video.filePath !== fileInfo.videoFilePath;
                const videoSizeChanged = hasVideoFile && (!video.fileSize || video.fileSize !== fileInfo.videoFileSize.toString());

                // Check if update needed for audio file
                const audioPathChanged = hasAudioFile && video.audioFilePath !== fileInfo.audioFilePath;
                const audioSizeChanged = hasAudioFile && (!video.audioFileSize || video.audioFileSize !== fileInfo.audioFileSize.toString());

                // Check if we need to clear audio fields (audio file was deleted)
                const audioFileRemoved = !hasAudioFile && (video.audioFilePath || video.audioFileSize);

                // Check if we need to clear video fields (video file was deleted but audio exists)
                const videoFileRemoved = !hasVideoFile && hasAudioFile && (video.filePath || video.fileSize);

                const probedResolution = probeResults.get(video.youtubeId) ?? null;

                // Sequelize BOOLEAN columns come back as 0/1 in raw mode, so use a
                // truthy check; `=== true` would never match the raw integer.
                if (videoPathChanged || videoSizeChanged || audioPathChanged || audioSizeChanged ||
                    audioFileRemoved || videoFileRemoved || video.removed || probedResolution !== null) {
                  const update = {
                    id: video.id,
                    removed: false
                  };

                  // Update video file info
                  if (hasVideoFile) {
                    update.filePath = fileInfo.videoFilePath;
                    update.fileSize = fileInfo.videoFileSize;
                  } else if (videoFileRemoved) {
                    update.filePath = null;
                    update.fileSize = null;
                    // The stored dimensions belong to the deleted file; clearing
                    // them lets a reappearing file be re-probed instead of
                    // keeping a stale label.
                    update.video_resolution = null;
                  }

                  // Update audio file info
                  if (hasAudioFile) {
                    update.audioFilePath = fileInfo.audioFilePath;
                    update.audioFileSize = fileInfo.audioFileSize;
                  } else if (audioFileRemoved) {
                    update.audioFilePath = null;
                    update.audioFileSize = null;
                  }

                  if (probedResolution !== null) {
                    update.video_resolution = probedResolution;
                  }

                  bulkUpdates.push(update);
                  chunkUpdated++;
                }
              }
            } else {
              // No files exist in fileMap for this video
              if (!video.removed) {
                // Only mark as removed, don't touch filePath or fileSize
                // They might still be valid even if we can't find the file right now
                bulkUpdates.push({
                  id: video.id,
                  removed: true
                  // DO NOT include filePath or fileSize here - leave them unchanged
                });
                chunkRemoved++;
              }
            }
          }

          // Flush each slice's updates right away: on a slow network share the
          // probes can outlast the whole time budget, and work lost to an abort
          // would get re-probed next run and never converge.
          if (bulkUpdates.length > 0) {
            logProgress(`Updating ${bulkUpdates.length} records (chunk ${Math.floor(offset / VIDEO_CHUNK_SIZE) + 1})...`);
            await this._flushBackfillUpdates(bulkUpdates.splice(0));
          }
        }

        totalProcessed += videos.length;
        totalUpdated += chunkUpdated;
        totalRemoved += chunkRemoved;
        offset += VIDEO_CHUNK_SIZE;

        // Log progress every few chunks
        if (offset % (VIDEO_CHUNK_SIZE * 5) === 0) {
          logProgress(`Progress: ${totalProcessed}/${totalCount} videos processed, ${totalUpdated} updated, ${totalRemoved} removed`);
        }
      }

      // Best-effort reconciliation for cache state that can go stale when a
      // file is deleted outside the app: rows whose STRM cache-on-play
      // materialization went missing (removed=true, cached_at still set -
      // the loop above already caught the missing file and set removed on
      // its own, this just tries to recover the row back to STRM playback
      // where possible). Never lets a failure here abort the rest of the
      // backfill result.
      try {
        const { Op } = require('sequelize');
        const staleCached = await Video.findAll({
          where: { cached_at: { [Op.ne]: null }, removed: true },
        });
        if (staleCached.length) {
          const videoDeletionModule = require('./videoDeletionModule');
          let reconciled = 0;
          for (const video of staleCached) {
            try {
              const result = await videoDeletionModule.reconcileRemovedCachedVideo(video);
              if (result && result.success) reconciled += 1;
            } catch (err) {
              logger.warn({ err, videoId: video.id }, 'Failed to reconcile one stale cached-video row during backfill');
            }
          }
          if (reconciled) {
            logProgress(`Reconciled ${reconciled} stale cached-video row(s) back to STRM`);
          }
        }
      } catch (err) {
        logger.warn({ err }, 'Failed to reconcile stale cached-video state during backfill');
      }

      // Redundant safety net for the untracked hls-buffer cache's own TTL
      // sweep, in case the nightly 2:10 AM cron was disabled or missed.
      try {
        const ytstreamRoutes = require('../routes/ytstream');
        await ytstreamRoutes.sweepExpiredUntrackedBufferCache();
      } catch (err) {
        logger.warn({ err }, 'Failed to sweep untracked buffer cache during backfill');
      }

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      logger.info({
        elapsed,
        totalProcessed,
        filesOnDisk: fileMapSize,
        updated: totalUpdated,
        removed: totalRemoved
      }, 'Video metadata backfill completed');

      result = {
        processed: totalProcessed,
        filesOnDisk: fileMapSize,
        updated: totalUpdated,
        removed: totalRemoved,
        timeElapsed: elapsed,
        trigger,
        startedAt: startedAtIso,
        completedAt: new Date().toISOString(),
        status: 'completed'
      };
      return result;
    } catch (err) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      if (err.message && err.message.includes('Time limit exceeded')) {
        logger.info({ elapsed }, 'Video metadata backfill stopped (time limit reached), will continue at next scheduled run');
        result = {
          timedOut: true,
          timeElapsed: elapsed,
          trigger,
          startedAt: startedAtIso,
          completedAt: new Date().toISOString(),
          status: 'timed-out',
          processed: totalProcessed,
          filesOnDisk: fileMapSize,
          updated: totalUpdated,
          removed: totalRemoved
        };
        return result;
      }
      logger.error({ err }, 'Error during video metadata backfill');
      result = {
        trigger,
        startedAt: startedAtIso,
        completedAt: new Date().toISOString(),
        status: 'error',
        errorMessage: err.message || 'Unknown error',
        processed: totalProcessed,
        filesOnDisk: fileMapSize,
        updated: totalUpdated,
        removed: totalRemoved
      };
      throw err;
    } finally {
      let lastRun = null;

      if (result) {
        lastRun = {
          startedAt: result.startedAt,
          completedAt: result.completedAt,
          trigger: result.trigger,
          status: result.status,
          videosUpdated: result.updated || 0,
          videosMarkedMissing: result.removed || 0,
          videosScanned: result.processed || 0,
          filesFoundOnDisk: result.filesOnDisk || 0,
          errorMessage: result.errorMessage || null
        };

        try {
          const currentConfig = configModule.getConfig();
          configModule.updateConfig({ ...currentConfig, rescanLastRun: lastRun });
        } catch (persistErr) {
          logger.error({ err: persistErr }, 'Failed to persist rescanLastRun');
        }
      }

      this._backfillRunning = false;

      try {
        messageEmitter.emitMessage('broadcast', null, 'server', 'rescanStatus', {
          running: false,
          lastRun
        });
      } catch (emitErr) {
        logger.error({ err: emitErr }, 'Failed to emit rescanStatus completion');
      }

      if (result) {
        // Reconcile channel .m3u files with what the rescan found on disk.
        m3uGenerator.regenerateAllChannelM3Us().catch((err) => {
          logger.error({ err }, 'Failed to refresh channel M3Us after rescan');
        });
      }
    }
  }

  /**
   * Atomically check the lock and kick off a backfill. Returns synchronously
   * with `started: true` (caller should respond 202) or `started: false`
   * (caller should respond 409). The actual backfill runs as a fire-and-forget
   * task; errors are logged inside `backfillVideoMetadata` itself.
   */
  tryStartBackfill({ trigger = 'manual' } = {}) {
    if (this._backfillRunning) {
      return { started: false, reason: 'already-running' };
    }
    // backfillVideoMetadata sets the flag synchronously before its first await,
    // so launching it here is race-free for in-process callers.
    this.backfillVideoMetadata({ trigger }).catch((err) => {
      logger.error({ err }, 'Manual backfill run failed');
    });
    return { started: true };
  }

  isBackfillRunning() {
    return this._backfillRunning;
  }

  /**
   * One-time maintenance pass: adds the "Available: ..." resolution tag
   * (see nfoGenerator.js's buildAvailableResolutionsTag) to every already-
   * downloaded/STRM'd video's existing .nfo file, for libraries that
   * predate that feature. Only touches videos whose raw yt-dlp metadata is
   * already cached at getJobsPath()/info/<youtubeId>.info.json (the same
   * cache videoMetadataModule.js's video-detail-modal fetch reads/writes) -
   * deliberately does NOT fetch fresh metadata for uncached videos, to
   * avoid a full-library yt-dlp fetch spree. Uncached videos (older
   * entries, or STRM entries never opened in the detail modal) are picked
   * up naturally whenever something else populates that cache, and a later
   * re-run of this pass will then catch them.
   *
   * Patches each .nfo surgically (see patchExistingNfoWithResolutionTag) -
   * never regenerates it - so nothing else in the file is touched.
   */
  async backfillResolutionTags(arg = {}) {
    const opts = typeof arg === 'number' ? { timeLimit: arg } : arg;
    const timeLimit = opts.timeLimit ?? 10 * 60 * 1000;
    const trigger = opts.trigger ?? 'manual';

    if (this._resolutionTagBackfillRunning) {
      logger.info({ trigger }, 'Resolution tag backfill already running, skipping');
      return { skipped: true, reason: 'already-running' };
    }
    this._resolutionTagBackfillRunning = true;

    const nfoGenerator = require('./nfoGenerator');
    const startTime = Date.now();
    const startedAtIso = new Date(startTime).toISOString();
    const logProgress = (message) => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      logger.info({ elapsed, context: 'resolutionTagBackfill' }, message);
    };
    const checkTimeLimit = () => {
      if (Date.now() - startTime > timeLimit) {
        throw new Error(`Time limit exceeded (${timeLimit / 1000}s)`);
      }
    };

    let totalScanned = 0;
    let totalTagged = 0;
    let totalSkippedNoCache = 0;
    let totalSkippedNoNfo = 0;
    let totalErrors = 0;
    let result;

    try {
      messageEmitter.emitMessage('broadcast', null, 'server', 'resolutionTagBackfillStatus', { running: true, trigger });
      logProgress('Starting resolution tag backfill...');

      const infoDir = path.join(configModule.getJobsPath(), 'info');
      const CHUNK_SIZE = 500;
      let offset = 0;
      const totalCount = await Video.count();
      logProgress(`Scanning ${totalCount} videos...`);

      while (offset < totalCount) {
        checkTimeLimit();
        const videos = await Video.findAll({
          attributes: ['id', 'youtubeId', 'filePath'],
          limit: CHUNK_SIZE,
          offset,
          raw: true,
        });
        if (videos.length === 0) break;

        for (const video of videos) {
          checkTimeLimit();
          totalScanned++;

          if (!video.filePath) continue; // no downloaded/materialized file to attach an .nfo to

          let jsonData;
          try {
            const infoPath = path.join(infoDir, `${video.youtubeId}.info.json`);
            const content = await fs.readFile(infoPath, 'utf8');
            jsonData = JSON.parse(content);
          } catch {
            totalSkippedNoCache++;
            continue;
          }

          try {
            const parsedPath = path.parse(video.filePath);
            const nfoPath = path.format({ dir: parsedPath.dir, name: parsedPath.name, ext: '.nfo' });
            const modified = await nfoGenerator.patchExistingNfoWithResolutionTag(nfoPath, jsonData);
            if (modified) {
              totalTagged++;
            } else {
              totalSkippedNoNfo++;
            }
          } catch (err) {
            totalErrors++;
            logger.warn({ err, youtubeId: video.youtubeId }, 'Failed to patch resolution tag into existing NFO');
          }
        }

        offset += CHUNK_SIZE;
        if (offset % (CHUNK_SIZE * 4) === 0) {
          logProgress(`Progress: ${totalScanned}/${totalCount} scanned, ${totalTagged} tagged`);
        }
      }

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      logger.info({
        elapsed, totalScanned, totalTagged, totalSkippedNoCache, totalSkippedNoNfo, totalErrors,
      }, 'Resolution tag backfill completed');

      result = {
        scanned: totalScanned,
        tagged: totalTagged,
        skippedNoCache: totalSkippedNoCache,
        skippedNoNfo: totalSkippedNoNfo,
        errors: totalErrors,
        timeElapsed: elapsed,
        trigger,
        startedAt: startedAtIso,
        completedAt: new Date().toISOString(),
        status: 'completed',
      };
      return result;
    } catch (err) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      if (err.message && err.message.includes('Time limit exceeded')) {
        logger.info({ elapsed }, 'Resolution tag backfill stopped (time limit reached)');
        result = {
          scanned: totalScanned,
          tagged: totalTagged,
          skippedNoCache: totalSkippedNoCache,
          skippedNoNfo: totalSkippedNoNfo,
          errors: totalErrors,
          timeElapsed: elapsed,
          trigger,
          startedAt: startedAtIso,
          completedAt: new Date().toISOString(),
          status: 'timed-out',
        };
        return result;
      }
      logger.error({ err }, 'Error during resolution tag backfill');
      result = {
        scanned: totalScanned,
        tagged: totalTagged,
        skippedNoCache: totalSkippedNoCache,
        skippedNoNfo: totalSkippedNoNfo,
        errors: totalErrors,
        timeElapsed: elapsed,
        trigger,
        startedAt: startedAtIso,
        completedAt: new Date().toISOString(),
        status: 'error',
        errorMessage: err.message || 'Unknown error',
      };
      throw err;
    } finally {
      this._resolutionTagBackfillRunning = false;

      if (result) {
        try {
          const currentConfig = configModule.getConfig();
          configModule.updateConfig({ ...currentConfig, resolutionTagBackfillLastRun: result });
        } catch (persistErr) {
          logger.error({ err: persistErr }, 'Failed to persist resolutionTagBackfillLastRun');
        }
      }

      try {
        messageEmitter.emitMessage('broadcast', null, 'server', 'resolutionTagBackfillStatus', {
          running: false,
          lastRun: result || null,
        });
      } catch (emitErr) {
        logger.error({ err: emitErr }, 'Failed to emit resolutionTagBackfillStatus completion');
      }
    }
  }

  /**
   * Atomically check the lock and kick off a resolution-tag backfill.
   * Mirrors tryStartBackfill.
   */
  tryStartResolutionTagBackfill({ trigger = 'manual' } = {}) {
    if (this._resolutionTagBackfillRunning) {
      return { started: false, reason: 'already-running' };
    }
    this.backfillResolutionTags({ trigger }).catch((err) => {
      logger.error({ err }, 'Manual resolution tag backfill run failed');
    });
    return { started: true };
  }

  /**
   * One-time maintenance pass: force re-copies every enabled channel's
   * poster.jpg/logo.jpg/backdrop.jpg/banner.jpg from this app's own cached
   * channel images, overwriting whatever's already on disk - see
   * channelThumbnails.regenerateChannelImages for why this is a separate
   * action from the normal (skip-if-existing) backfill that runs
   * automatically on channel add/download-complete: that path can never
   * repair an image that already exists but is broken (e.g. permissions
   * from before copySyncWithFallback started normalizing them).
   */
  async regenerateChannelImages(arg = {}) {
    const trigger = arg.trigger ?? 'manual';

    if (this._imageRegenRunning) {
      logger.info({ trigger }, 'Channel image regeneration already running, skipping');
      return { skipped: true, reason: 'already-running' };
    }
    this._imageRegenRunning = true;

    const { Channel } = require('../models');
    const channelThumbnails = require('./channel/channelThumbnails');
    const startTime = Date.now();
    const startedAtIso = new Date(startTime).toISOString();
    let result;

    try {
      messageEmitter.emitMessage('broadcast', null, 'server', 'channelImageRegenStatus', { running: true, trigger });
      logger.info({ trigger }, 'Starting channel image regeneration...');

      const channels = await Channel.findAll({ where: { enabled: true }, raw: true });
      const counts = await channelThumbnails.regenerateChannelImages(channels);

      result = {
        channelsScanned: channels.length,
        ...counts,
        trigger,
        startedAt: startedAtIso,
        completedAt: new Date().toISOString(),
        status: 'completed',
      };
      logger.info(result, 'Channel image regeneration completed');
      return result;
    } catch (err) {
      logger.error({ err }, 'Error during channel image regeneration');
      result = {
        trigger,
        startedAt: startedAtIso,
        completedAt: new Date().toISOString(),
        status: 'error',
        errorMessage: err.message || 'Unknown error',
      };
      throw err;
    } finally {
      this._imageRegenRunning = false;

      if (result) {
        try {
          const currentConfig = configModule.getConfig();
          configModule.updateConfig({ ...currentConfig, channelImageRegenLastRun: result });
        } catch (persistErr) {
          logger.error({ err: persistErr }, 'Failed to persist channelImageRegenLastRun');
        }
      }

      try {
        messageEmitter.emitMessage('broadcast', null, 'server', 'channelImageRegenStatus', {
          running: false,
          lastRun: result || null,
        });
      } catch (emitErr) {
        logger.error({ err: emitErr }, 'Failed to emit channelImageRegenStatus completion');
      }
    }
  }

  /**
   * Atomically check the lock and kick off a channel image regeneration.
   * Mirrors tryStartBackfill/tryStartResolutionTagBackfill.
   */
  tryStartImageRegen({ trigger = 'manual' } = {}) {
    if (this._imageRegenRunning) {
      return { started: false, reason: 'already-running' };
    }
    this.regenerateChannelImages({ trigger }).catch((err) => {
      logger.error({ err }, 'Manual channel image regeneration run failed');
    });
    return { started: true };
  }

  isImageRegenRunning() {
    return this._imageRegenRunning;
  }

  isResolutionTagBackfillRunning() {
    return this._resolutionTagBackfillRunning;
  }

  async setVideoProtection(id, protectedState) {
    const video = await Video.findByPk(id);
    if (!video) {
      throw new Error('Video not found');
    }
    await video.update({ protected: protectedState });
    return { id: video.id, protected: protectedState };
  }
}

module.exports = new VideosModule();
