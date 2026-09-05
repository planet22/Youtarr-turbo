const { Video } = require('../models');
const fs = require('fs').promises;
const path = require('path');
const logger = require('../logger');
const { isVideoDirectory, cleanupEmptyChannelDirectory, cleanupEmptyParents, isSubfolderDir, listSubdirectories, removeDirectoryResilient } = require('./filesystem');
const m3uGenerator = require('./m3uGenerator');

class VideoDeletionModule {
  constructor() {}

  /**
   * Determine if a video's file path indicates flat structure (no video subfolder)
   * In nested mode, the parent directory name ends with " - <youtubeId>"
   * In flat mode, the video file sits directly in the channel folder
   * @param {string} filePath - Full path to the video file
   * @returns {boolean} - True if flat structure
   */
  isFlat(filePath) {
    const parentDir = path.dirname(filePath);
    // If the parent directory looks like a video directory (ends with " - youtubeId"),
    // then this is nested mode. Otherwise, it's flat mode.
    return !isVideoDirectory(parentDir);
  }

  /**
   * Prepare minimal video metadata for dry-run responses
   * @param {object} video
   * @returns {{id:number,youtubeId:string,title:string,channel:string,fileSize:number,timeCreated:Date}}
   */
  formatVideoForPlan(video) {
    return {
      id: video.id,
      youtubeId: video.youtubeId,
      title: video.youTubeVideoName,
      channel: video.youTubeChannelName,
      fileSize: parseInt(video.fileSize) || 0,
      timeCreated: video.timeCreated
    };
  }

  /**
   * Parse a config value as a positive integer, treating anything absent or
   * invalid (older configs won't have the newer auto-removal fields) as 0.
   * @param {*} value
   * @returns {number}
   */
  _parsePositiveInt(value) {
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) || parsed <= 0 ? 0 : parsed;
  }

  /**
   * Attempt to clean up an empty channel directory after video deletion
   * Best-effort: errors are logged as warnings and do not propagate
   * @param {string} filePath - The deleted video's file path
   * @param {boolean} flat - Whether the video used flat directory structure
   * @private
   */
  async _tryCleanupChannelDirectory(filePath, flat) {
    try {
      const configModule = require('./configModule');
      const baseDir = configModule.directoryPath;

      // Derive channel directory:
      //   Nested: grandparent of filePath (filePath -> videoDir -> channelDir)
      //   Flat: parent of filePath (filePath -> channelDir)
      const channelDir = flat
        ? path.dirname(filePath)
        : path.dirname(path.dirname(filePath));

      const removed = await cleanupEmptyChannelDirectory(channelDir, baseDir, {
        includeIgnorableFiles: true
      });

      if (removed) {
        // Clean up empty subfolder parent (e.g., /base/__subfolder/ now empty)
        await cleanupEmptyParents(path.dirname(channelDir), baseDir);
      }
    } catch (error) {
      logger.warn({ err: error, filePath }, 'Error during channel directory cleanup (non-fatal)');
    }
  }

  /**
   * Delete a single video by ID
   * Deletes the video directory from disk and marks the video as removed in the database
   * @param {number} videoId - The database ID of the video to delete
   * @returns {Promise<{success: boolean, videoId: number, error?: string}>}
   */
  async deleteVideoById(videoId) {
    try {
      // Fetch video from database
      const video = await Video.findByPk(videoId);

      if (!video) {
        return {
          success: false,
          videoId,
          error: 'Video not found in database'
        };
      }

      // Check if video is already marked as removed
      if (video.removed) {
        return {
          success: false,
          videoId,
          error: 'Video is already marked as removed'
        };
      }

      // Check if we have a file path
      if (!video.filePath) {
        // No file path, just mark as removed in database
        await video.update({ removed: true });
        return {
          success: true,
          videoId,
          channelId: video.channel_id,
          message: 'Video marked as removed (no file path)'
        };
      }

      // Get the video directory path
      // Nested: filePath = /path/to/channel/channel - title - id/video.mp4
      // Flat:   filePath = /path/to/channel/video.mp4
      const videoDirectory = path.dirname(video.filePath);
      const flat = this.isFlat(video.filePath);

      // Safety check: ensure the path contains the youtube ID
      // This prevents accidentally deleting the wrong files
      if (!video.filePath.includes(video.youtubeId)) {
        logger.error({ videoId, filePath: video.filePath, youtubeId: video.youtubeId }, 'Safety check failed: file path doesn\'t contain youtube ID');
        return {
          success: false,
          videoId,
          error: 'Safety check failed: invalid file path'
        };
      }

      // Revert-to-STRM: if this video was cached via STRM cache-on-play (an
      // archived .strm.cached/.strmtool.json.cached backup pair sits next to
      // the real file, written by videoPersistence._archiveStaleStrmSidecars),
      // remove only the big media file and restore the STRM sidecars instead
      // of deleting the whole library entry. Falls through to normal
      // deletion below if no backup exists or the revert itself fails.
      const configModule = require('./configModule');
      if (configModule.getConfig().autoRemovalPreserveStrmFallback !== false) {
        const reverted = await this._tryRevertToStrm(video);
        if (reverted) {
          return reverted;
        }
      }

      // Delete the video files
      try {
        if (flat) {
          // Flat structure: delete only files matching this video's youtube ID
          // NEVER delete the directory itself (it's the channel folder containing other videos)
          logger.info({ videoId, videoDirectory, youtubeId: video.youtubeId }, 'Flat structure detected, deleting individual files');
          const files = await fs.readdir(videoDirectory);
          for (const file of files) {
            // Match files by YouTube ID: bracketed form [ID] is the yt-dlp default;
            // dash form " - ID" is a fallback for non-standard naming patterns
            if (file.includes(`[${video.youtubeId}]`) || file.includes(` - ${video.youtubeId}`)) {
              const fullPath = path.join(videoDirectory, file);
              try {
                await fs.unlink(fullPath);
                logger.info({ videoId, file }, 'Deleted video file (flat mode)');
              } catch (unlinkErr) {
                if (unlinkErr.code !== 'ENOENT') {
                  logger.error({ videoId, file, err: unlinkErr }, 'Failed to delete file (flat mode)');
                }
              }
            }
          }
        } else {
          // Nested structure: delete the entire video directory.
          // Uses the resilient remover so SMB AppleDouble race conditions
          // don't strand the directory with an ENOTEMPTY error (issue #370).
          await removeDirectoryResilient(videoDirectory);
          logger.info({ videoId, videoDirectory }, 'Deleted video directory');
        }
      } catch (fsError) {
        if (fsError.code === 'ENOENT') {
          // Directory/files already gone; treat as success but still mark removed in DB
          logger.info({ videoId, videoDirectory, error: fsError.message }, 'Files already removed');
        } else {
          logger.error({ videoId, videoDirectory, err: fsError }, 'Failed to delete video files');
          return {
            success: false,
            videoId,
            error: 'Failed to delete video files from disk. Please check filesystem permissions.'
          };
        }
      }

      // Mark video as removed in database
      await video.update({ removed: true });

      // Best-effort cleanup of empty channel directory
      await this._tryCleanupChannelDirectory(video.filePath, flat);

      return {
        success: true,
        videoId,
        channelId: video.channel_id,
        message: 'Video deleted successfully'
      };
    } catch (error) {
      logger.error({ videoId, err: error }, 'Error deleting video');
      return {
        success: false,
        videoId,
        error: error.message || 'Unknown error occurred'
      };
    }
  }

  /**
   * If `video` has an archived STRM backup pair sitting next to its current
   * (real, downloaded) `filePath` - written by
   * videoPersistence._archiveStaleStrmSidecars when STRM cache-on-play
   * completed a download - deletes only the big media file and restores the
   * `.strm`/`.strmtool.json` pair, flipping the row back to `is_strm: true`
   * instead of marking it `removed`. Purely file-by-file (never a directory
   * delete/move), so this is safe even when `filePath` lives in a season
   * folder shared with other series episodes.
   * @param {object} video - Sequelize Video instance (not yet updated)
   * @returns {Promise<{success:boolean,videoId:number,channelId?:string,message:string}|null>}
   *   null means "no backup found, or revert failed" - caller should fall
   *   through to normal deletion.
   * @private
   */
  async _tryRevertToStrm(video) {
    // Module-scope `fs` (top of file) is already fs.promises; only the sync
    // existsSync check below needs the callback-style module directly.
    const fsSync = require('fs');
    const strmMediaInfoCache = require('./strmMediaInfoCache');

    const dir = path.dirname(video.filePath);
    const stem = path.basename(video.filePath, path.extname(video.filePath));
    const strmBackupPath = path.join(dir, `${stem}.strm.cached`);

    if (!fsSync.existsSync(strmBackupPath)) {
      return null;
    }

    const restoredStrmPath = path.join(dir, `${stem}.strm`);
    const restoredCachePath = strmMediaInfoCache.getMediaInfoCachePath(restoredStrmPath);
    const cacheBackupPath = `${restoredCachePath}.cached`;

    try {
      await fs.unlink(video.filePath).catch((err) => {
        if (err.code !== 'ENOENT') throw err;
      });
      if (video.audioFilePath) {
        await fs.unlink(video.audioFilePath).catch((err) => {
          if (err.code !== 'ENOENT') throw err;
        });
      }

      await fs.rename(strmBackupPath, restoredStrmPath);
      if (fsSync.existsSync(cacheBackupPath)) {
        await fs.rename(cacheBackupPath, restoredCachePath);
      }

      const strmFileSize = (await fs.stat(restoredStrmPath)).size;

      await video.update({
        filePath: restoredStrmPath,
        fileSize: strmFileSize,
        audioFilePath: null,
        audioFileSize: null,
        is_strm: true,
        removed: false,
        // Clears the cache-on-play expiry timer this revert is satisfying
        // (see sweepExpiredCachedVideos) - a later re-cache of this same
        // video sets a fresh cached_at itself (videoPersistence.js), so
        // this never needs to be re-armed here.
        cached_at: null,
        // The deleted real file is what got ffprobed for this - a STRM
        // pointer has no dimensions of its own, so a stale value here would
        // otherwise keep showing a resolution chip for a file that no
        // longer exists. Backfill's ffprobe pass never re-populates it for
        // .strm files (skips them entirely), so this must be cleared here,
        // not left to self-heal later.
        video_resolution: null,
      });

      logger.info({ videoId: video.id, restoredStrmPath }, '[Auto-Removal] Reverted cached video to STRM playback');

      // yt-dlp's download-archive (complete.list) otherwise still remembers
      // this video as already downloaded, so a later cache-on-play attempt
      // (or a regular re-download) would silently skip it - yt-dlp logs
      // "has already been recorded in the archive" and does nothing, even
      // though the real file this revert just deleted no longer exists.
      // Same fix purgeVideoById already applies for the same reason - see
      // its own comment for the matching NZB-side fix in nzb.js.
      if (video.youtubeId) {
        try {
          const archiveModule = require('./archiveModule');
          await archiveModule.removeVideoFromArchive(video.youtubeId);
        } catch (archiveErr) {
          logger.warn({ err: archiveErr, videoId: video.id, youtubeId: video.youtubeId }, '[Auto-Removal] Failed to remove reverted video from yt-dlp archive');
        }
      }

      return {
        success: true,
        videoId: video.id,
        channelId: video.channel_id,
        message: 'Reverted to STRM playback (cached file removed)',
      };
    } catch (err) {
      logger.error({ err, videoId: video.id, filePath: video.filePath }, '[Auto-Removal] Revert-to-STRM failed, falling back to normal deletion');
      return null;
    }
  }

  /**
   * Explicit, user-initiated counterpart to _tryRevertToStrm's use inside
   * deleteVideoById's auto-removal flow: reverts a single downloaded video
   * back to STRM if (and only if) it has an archived `.strm.cached` backup,
   * i.e. it was originally STRM and got cached via strmCacheOnPlay. Unlike
   * the auto-removal path, this ignores autoRemovalPreserveStrmFallback -
   * that flag only controls the automatic fallback, not an explicit click.
   * @param {number} videoId
   * @returns {Promise<{success:boolean,videoId:number,channelId?:string,message?:string,error?:string}>}
   */
  async revertToStrm(videoId) {
    const video = await Video.findByPk(videoId);

    if (!video) {
      return { success: false, videoId, error: 'Video not found in database' };
    }
    if (video.removed) {
      return { success: false, videoId, error: 'Video is already marked as removed' };
    }
    if (video.is_strm) {
      return { success: false, videoId, error: 'Video is already STRM' };
    }
    if (!video.filePath) {
      return { success: false, videoId, error: 'Video has no file path' };
    }

    const reverted = await this._tryRevertToStrm(video);
    if (reverted) {
      return reverted;
    }
    return {
      success: false,
      videoId,
      error: 'This video was not originally STRM (or has no cached backup), so it can\'t be switched back.',
    };
  }

  /**
   * Maintenance-rescan counterpart to _tryRevertToStrm: called for a row
   * whose STRM cache-on-play materialization (cached_at set) went missing
   * outside the app - checkVideoFiles already flipped removed=true for it
   * on the next page load (that read-path guard is what keeps the Library
   * page's "Cached Video" icon honest regardless of this call's outcome).
   * This is a best-effort self-heal, not a correctness requirement: if a
   * `.strm.cached` backup is still there it restores STRM playback,
   * otherwise there's nothing recoverable and the row is left as-is.
   * @param {object} video - Sequelize Video instance
   * @returns {Promise<{success:boolean,videoId:number,message:string}|null>}
   */
  async reconcileRemovedCachedVideo(video) {
    if (!video.filePath) return null;
    return this._tryRevertToStrm(video);
  }

  /**
   * Scheduled counterpart to _tryRevertToStrm/revertToStrm (see cronJobs.js) -
   * reverts every video whose cached_at (set only by the STRM cache-on-play
   * transition in videoPersistence.js, never by a genuine/forced download -
   * see the migration adding that column) is older than
   * strm.cacheOnPlayExpiryHours, so an opportunistic cache doesn't silently
   * become a permanent download. A no-op when the threshold is unset/<=0.
   * @returns {Promise<{success:boolean, reverted:number, failed:number, thresholdHours:number}>}
   */
  async sweepExpiredCachedVideos() {
    const configModule = require('./configModule');
    const { Op } = require('sequelize');
    const config = configModule.getConfig();
    const thresholdHours = this._parsePositiveInt(config.strm?.cacheOnPlayExpiryHours);

    if (thresholdHours <= 0) {
      return { success: true, reverted: 0, failed: 0, thresholdHours };
    }

    const cutoff = new Date(Date.now() - thresholdHours * 60 * 60 * 1000);
    const candidates = await Video.findAll({
      where: {
        is_strm: false,
        removed: false,
        cached_at: { [Op.ne]: null, [Op.lt]: cutoff },
      },
    });

    let reverted = 0;
    let failed = 0;
    for (const video of candidates) {
      const result = await this._tryRevertToStrm(video);
      if (result && result.success) {
        reverted += 1;
      } else {
        failed += 1;
        logger.warn(
          { videoId: video.id, youtubeId: video.youtubeId },
          '[Cache Expiry] Failed to revert expired cached video to STRM (no backup found, or revert failed)'
        );
      }
    }

    if (reverted > 0 || failed > 0) {
      logger.info({ reverted, failed, thresholdHours }, '[Cache Expiry] Swept expired cache-on-play videos back to STRM');
    }

    return { success: true, reverted, failed, thresholdHours };
  }

  /**
   * Delete multiple videos
   * @param {number[]} videoIds - Array of video IDs to delete
   * @returns {Promise<{success: boolean, deleted: number[], failed: Array<{videoId: number, error: string}>}>}
   */
  async deleteVideos(videoIds) {
    const deleted = [];
    const failed = [];
    const affectedChannelIds = [];

    // Process deletions sequentially to avoid overwhelming the file system
    for (const videoId of videoIds) {
      const result = await this.deleteVideoById(videoId);

      if (result.success) {
        deleted.push(videoId);
        affectedChannelIds.push(result.channelId);
      } else {
        failed.push({
          videoId,
          error: result.error || 'Unknown error'
        });
      }
    }

    this._regenerateM3usForChannels(affectedChannelIds);

    return {
      success: failed.length === 0,
      deleted,
      failed
    };
  }

  /**
   * Delete videos by YouTube IDs
   * @param {string[]} youtubeIds - Array of YouTube video IDs
   * @returns {Promise<{success: boolean, deleted: string[], failed: Array<{youtubeId: string, error: string}>}>}
   */
  async deleteVideosByYoutubeIds(youtubeIds) {
    const deleted = [];
    const failed = [];
    const affectedChannelIds = [];

    for (const youtubeId of youtubeIds) {
      try {
        // Find the video by YouTube ID
        const video = await Video.findOne({
          where: { youtubeId: youtubeId }
        });

        if (!video) {
          failed.push({
            youtubeId,
            error: 'Video not found in database'
          });
          continue;
        }

        // Delete using the database ID
        const result = await this.deleteVideoById(video.id);

        if (result.success) {
          deleted.push(youtubeId);
          affectedChannelIds.push(result.channelId);
        } else {
          failed.push({
            youtubeId,
            error: result.error || 'Unknown error'
          });
        }
      } catch (error) {
        failed.push({
          youtubeId,
          error: error.message || 'Unknown error occurred'
        });
      }
    }

    this._regenerateM3usForChannels(affectedChannelIds);

    return {
      success: failed.length === 0,
      deleted,
      failed
    };
  }

  /**
   * Permanently remove a video's database row. No file operations happen
   * here — this is only for videos already confirmed missing from disk
   * (`video.removed`), where deleteVideoById refuses to act (see its
   * "already marked as removed" check) since there's nothing left to
   * delete but the app still shows the row with no way to clear it.
   *
   * Unlike deleteVideoById — which marks `removed: true` and deletes the
   * file but never touches the row — this actually calls `video.destroy()`.
   * `JobVideo` rows are deleted first because the DB has a real, non-cascading
   * FK constraint on `JobVideos.video_id` that would otherwise reject the
   * delete; `VideoWatchStatus` rows are deleted too (no FK, but would
   * orphan otherwise). `ChannelVideo`/`PlaylistVideo` rows are deliberately
   * left alone — they key by `youtube_id`, represent the YouTube-catalog
   * listing independent of this local download, and already tolerate an
   * absent `Video` row.
   * @param {number} videoId - The database ID of the video to purge
   * @returns {Promise<{success: boolean, videoId: number, channelId?: string, error?: string}>}
   */
  async purgeVideoById(videoId) {
    try {
      const video = await Video.findByPk(videoId);

      if (!video) {
        return {
          success: false,
          videoId,
          error: 'Video not found in database'
        };
      }

      if (!video.removed) {
        return {
          success: false,
          videoId,
          error: 'Video is not marked as missing from disk; use Delete instead'
        };
      }

      const { JobVideo, VideoWatchStatus } = require('../models');
      const channelId = video.channel_id;
      const youtubeId = video.youtubeId;

      await JobVideo.destroy({ where: { video_id: videoId } });
      await VideoWatchStatus.destroy({ where: { video_id: videoId } });
      await video.destroy();

      // yt-dlp's download-archive otherwise still remembers this video, so a
      // later backfillFromCompleteList run (server startup, or the daily
      // 2:20am cron in jobModule.js) would find it missing from the Videos
      // table, find the still-lying-around jobs/info/<id>.info.json, and
      // silently recreate the row - undoing this purge. See the identical
      // fix in untrackFromYoutarrLibrary (server/routes/nzb.js).
      if (youtubeId) {
        try {
          const archiveModule = require('./archiveModule');
          await archiveModule.removeVideoFromArchive(youtubeId);
        } catch (err) {
          logger.warn({ err, videoId, youtubeId }, 'Failed to remove purged video from yt-dlp archive');
        }
      }

      return {
        success: true,
        videoId,
        channelId
      };
    } catch (error) {
      logger.error({ videoId, err: error }, 'Error purging video');
      return {
        success: false,
        videoId,
        error: error.message || 'Unknown error occurred'
      };
    }
  }

  /**
   * Purge multiple videos' database rows. See purgeVideoById.
   * @param {number[]} videoIds
   * @returns {Promise<{success: boolean, purged: number[], failed: Array<{videoId: number, error: string}>}>}
   */
  async purgeVideos(videoIds) {
    const purged = [];
    const failed = [];
    const affectedChannelIds = [];

    for (const videoId of videoIds) {
      const result = await this.purgeVideoById(videoId);

      if (result.success) {
        purged.push(videoId);
        affectedChannelIds.push(result.channelId);
      } else {
        failed.push({
          videoId,
          error: result.error || 'Unknown error'
        });
      }
    }

    this._regenerateM3usForChannels(affectedChannelIds);

    return {
      success: failed.length === 0,
      purged,
      failed
    };
  }

  /**
   * Regenerate the channel .m3u playlist for each affected channel, deduped.
   * @param {Array<string|undefined>} channelIds
   */
  _regenerateM3usForChannels(channelIds) {
    const unique = [...new Set((channelIds || []).filter(Boolean))];
    for (const channelId of unique) {
      m3uGenerator.generateChannelM3UInBackground(channelId, 'video-deletion');
    }
  }

  /**
   * Get videos older than the specified threshold
   * Uses the same timeCreated calculation as videosModule.js
   * @param {number} ageInDays - Age threshold in days
   * @returns {Promise<Array<{id: number, youtubeId: string, youTubeVideoName: string, timeCreated: Date, fileSize: number}>>}
   */
  async getVideosOlderThanThreshold(ageInDays, excludeIds = [], minFileSizeBytes = 0) {
    const { Sequelize, sequelize } = require('../db.js');

    try {
      const excludeClause = excludeIds && excludeIds.length > 0
        ? '          AND Videos.id NOT IN (:excludeIds)\n'
        : '';
      const minSizeClause = minFileSizeBytes > 0
        ? '          AND (Videos.fileSize IS NULL OR Videos.fileSize >= :minFileSizeBytes)\n'
        : '';

      // Use raw SQL query to match the timeCreated calculation in videosModule.js
      const query = `
        SELECT DISTINCT
          Videos.id,
          Videos.youtubeId,
          Videos.youTubeVideoName,
          Videos.youTubeChannelName,
          Videos.fileSize,
          COALESCE(Videos.last_downloaded_at, Jobs.timeCreated, STR_TO_DATE(Videos.originalDate, '%Y%m%d')) AS timeCreated
        FROM Videos
        LEFT JOIN JobVideos ON Videos.id = JobVideos.video_id
        LEFT JOIN Jobs ON Jobs.id = JobVideos.job_id
        LEFT JOIN channels AS ProtChannel ON ProtChannel.channel_id = Videos.channel_id AND ProtChannel.enabled = 1
        WHERE Videos.removed = 0
          AND Videos.protected = 0
          AND COALESCE(ProtChannel.auto_removal_protected, 0) = 0
          AND COALESCE(Videos.last_downloaded_at, Jobs.timeCreated, STR_TO_DATE(Videos.originalDate, '%Y%m%d')) IS NOT NULL
          AND COALESCE(Videos.last_downloaded_at, Jobs.timeCreated, STR_TO_DATE(Videos.originalDate, '%Y%m%d')) < DATE_SUB(NOW(), INTERVAL :ageInDays DAY)
${excludeClause}${minSizeClause}        ORDER BY timeCreated ASC
      `;

      const replacements = { ageInDays };
      if (excludeIds && excludeIds.length > 0) {
        replacements.excludeIds = excludeIds;
      }
      if (minFileSizeBytes > 0) {
        replacements.minFileSizeBytes = minFileSizeBytes;
      }

      const videos = await sequelize.query(query, {
        replacements,
        type: Sequelize.QueryTypes.SELECT
      });

      logger.info({ count: videos.length, ageInDays }, '[Auto-Removal] Found videos older than threshold');
      return videos;
    } catch (error) {
      logger.error({ err: error }, 'Error getting videos older than threshold');
      return [];
    }
  }

  /**
   * Get the oldest N videos
   * Used for freeing up space when storage is low
   * @param {number} limit - Maximum number of videos to return
   * @returns {Promise<Array<{id: number, youtubeId: string, youTubeVideoName: string, timeCreated: Date, fileSize: number}>>}
   */
  async getOldestVideos(limit, excludeIds = [], minFileSizeBytes = 0) {
    const { Sequelize, sequelize } = require('../db.js');

    try {
      const excludeClause = excludeIds && excludeIds.length > 0
        ? '          AND Videos.id NOT IN (:excludeIds)\n'
        : '';
      const minSizeClause = minFileSizeBytes > 0
        ? '          AND (Videos.fileSize IS NULL OR Videos.fileSize >= :minFileSizeBytes)\n'
        : '';

      const query = `
        SELECT DISTINCT
          Videos.id,
          Videos.youtubeId,
          Videos.youTubeVideoName,
          Videos.youTubeChannelName,
          Videos.fileSize,
          COALESCE(Videos.last_downloaded_at, Jobs.timeCreated, STR_TO_DATE(Videos.originalDate, '%Y%m%d')) AS timeCreated
        FROM Videos
        LEFT JOIN JobVideos ON Videos.id = JobVideos.video_id
        LEFT JOIN Jobs ON Jobs.id = JobVideos.job_id
        WHERE Videos.removed = 0
          AND Videos.protected = 0
          AND COALESCE(Videos.last_downloaded_at, Jobs.timeCreated, STR_TO_DATE(Videos.originalDate, '%Y%m%d')) IS NOT NULL
${excludeClause}${minSizeClause}        ORDER BY timeCreated ASC
        LIMIT :limit
      `;

      const replacements = { limit };
      if (excludeIds && excludeIds.length > 0) {
        replacements.excludeIds = excludeIds;
      }
      if (minFileSizeBytes > 0) {
        replacements.minFileSizeBytes = minFileSizeBytes;
      }

      const videos = await sequelize.query(query, {
        replacements,
        type: Sequelize.QueryTypes.SELECT
      });

      logger.info({ count: videos.length, limit }, '[Auto-Removal] Found oldest videos');
      return videos;
    } catch (error) {
      logger.error({ err: error }, 'Error getting oldest videos');
      return [];
    }
  }

  /**
   * Scan the output directory for orphan empty channel directories and remove them.
   * Unlike _tryCleanupChannelDirectory (which only runs after a video deletion), this
   * proactively finds directories that are already empty (or contain only ignorable files
   * like poster.jpg) and cleans them up. Handles both root-level and subfolder-level channels.
   * @returns {Promise<{removed: string[], errors: string[]}>}
   */
  async cleanupOrphanDirectories() {
    const configModule = require('./configModule');
    const baseDir = configModule.directoryPath;
    const removed = [];
    const errors = [];

    if (!baseDir) {
      logger.debug('[Orphan Cleanup] No output directory configured, skipping');
      return { removed, errors };
    }

    try {
      const topLevelDirs = await listSubdirectories(baseDir);

      for (const dir of topLevelDirs) {
        const dirName = path.basename(dir);

        if (isSubfolderDir(dirName)) {
          // Subfolder directory (e.g., __Music) — check its children as channel dirs
          try {
            const channelDirs = await listSubdirectories(dir);
            for (const channelDir of channelDirs) {
              const wasRemoved = await cleanupEmptyChannelDirectory(channelDir, baseDir, {
                includeIgnorableFiles: true
              });
              if (wasRemoved) {
                removed.push(channelDir);
              }
            }
            // Clean up the subfolder itself if it's now empty
            await cleanupEmptyParents(dir, baseDir);
          } catch (dirError) {
            logger.warn({ err: dirError, dir }, '[Orphan Cleanup] Error processing subfolder directory');
            errors.push(dirError.message);
          }
        } else {
          // Root-level channel directory
          const wasRemoved = await cleanupEmptyChannelDirectory(dir, baseDir, {
            includeIgnorableFiles: true
          });
          if (wasRemoved) {
            removed.push(dir);
          }
        }
      }

      if (removed.length > 0) {
        logger.info({ count: removed.length, directories: removed }, '[Orphan Cleanup] Removed empty channel directories');
      } else {
        logger.debug('[Orphan Cleanup] No orphan directories found');
      }
    } catch (error) {
      logger.error({ err: error }, '[Orphan Cleanup] Error scanning for orphan directories');
      errors.push(error.message);
    }

    return { removed, errors };
  }

  /**
   * Perform automatic cleanup based on configured thresholds
   * This is the main method called by the cron job
   * @param {object} options
   * @param {boolean} [options.dryRun=false] - When true, returns a simulation without deleting files
   * @param {Record<string, any>} [options.overrides={}] - Optional config overrides (e.g. thresholds)
   * @param {boolean} [options.includeSamples=true] - Include sample video metadata in the response
   * @returns {Promise<{success: boolean, dryRun: boolean, deletedByAge: number, deletedBySpace: number, totalDeleted: number, freedBytes: number, errors: string[], plan: object, simulationTotals: object | null}>}
   */
  async performAutomaticCleanup(options = {}) {
    const { dryRun = false, overrides = {}, includeSamples = true } = options;
    const configModule = require('./configModule');
    const autoRemovalQueries = require('./autoRemovalQueries');
    const baseConfig = configModule.getConfig();
    const config = { ...baseConfig, ...overrides };

    const watchedEnabled = config.autoRemovalWatchedEnabled === true;
    const keepRecentCount = this._parsePositiveInt(config.autoRemovalKeepRecentCount);
    // Safety floor shared by every strategy below: a video whose tracked file
    // is smaller than this is never a removal candidate (protects bare .strm
    // rows, a few dozen bytes, from being "cleaned up" for ~0 bytes freed).
    const minFileSizeBytes = this._parsePositiveInt(config.autoRemovalMinFileSizeKB) * 1024;

    const result = {
      success: true,
      dryRun,
      deletedByAge: 0,
      deletedByWatched: 0,
      deletedBySpace: 0,
      totalDeleted: 0,
      freedBytes: 0,
      errors: [],
      plan: {
        ageStrategy: {
          enabled: false,
          thresholdDays: null,
          candidateCount: 0,
          estimatedFreedBytes: 0,
          deletedCount: 0,
          failedCount: 0,
          sampleVideos: []
        },
        watchedStrategy: {
          enabled: false,
          minDaysSinceWatched: null,
          minVideoAgeDays: null,
          candidateCount: 0,
          estimatedFreedBytes: 0,
          deletedCount: 0,
          failedCount: 0,
          skippedReason: null,
          sampleVideos: []
        },
        keepRecent: {
          count: keepRecentCount,
          protectedCount: 0
        },
        channelKeepRecent: {
          channelCount: 0,
          protectedCount: 0
        },
        spaceStrategy: {
          enabled: false,
          threshold: config.autoRemovalFreeSpaceThreshold !== undefined && config.autoRemovalFreeSpaceThreshold !== null
            ? config.autoRemovalFreeSpaceThreshold
            : null,
          thresholdBytes: null,
          candidateCount: 0,
          estimatedFreedBytes: 0,
          deletedCount: 0,
          failedCount: 0,
          storageStatus: null,
          needsCleanup: false,
          iterations: 0,
          sampleVideos: []
        }
      },
      simulationTotals: dryRun ? {
        byAge: 0,
        byWatched: 0,
        bySpace: 0,
        total: 0,
        estimatedFreedBytes: 0
      } : null
    };

    // In dry-run mode nothing is actually deleted, so later strategies must
    // exclude the ids earlier strategies already claimed to avoid double counting.
    const dryRunProcessedIds = dryRun ? new Set() : null;

    logger.info({ dryRun }, '[Auto-Removal] Starting automatic video cleanup');

    const hasAgeThreshold = config.autoRemovalVideoAgeThreshold !== null && config.autoRemovalVideoAgeThreshold !== '';
    const hasSpaceThreshold = config.autoRemovalFreeSpaceThreshold !== null && config.autoRemovalFreeSpaceThreshold !== '';

    if (!config.autoRemovalEnabled && !dryRun) {
      logger.info('[Auto-Removal] Auto-removal is disabled, skipping cleanup');
      return result;
    }

    if (!hasAgeThreshold && !hasSpaceThreshold && !watchedEnabled) {
      logger.info('[Auto-Removal] No thresholds configured, skipping cleanup');
      return result;
    }

    // The N most recently downloaded videos are protected from every strategy.
    // If the guard query fails we abort: running without it would delete the
    // videos this setting exists to keep.
    let keepRecentIds = [];
    if (keepRecentCount > 0) {
      try {
        keepRecentIds = await autoRemovalQueries.getRecentVideoIds(keepRecentCount);
        result.plan.keepRecent.protectedCount = keepRecentIds.length;
        logger.info({ keepRecentCount, protectedCount: keepRecentIds.length }, '[Auto-Removal] Protecting most recent downloads from cleanup');
      } catch (error) {
        logger.error({ err: error, keepRecentCount }, '[Auto-Removal] Could not determine the most recent downloads, aborting cleanup');
        result.errors.push('Could not determine the most recent downloads; cleanup aborted for safety');
        result.success = false;
        return result;
      }
    }

    // Per-channel keep-recent guard (channel settings). Runs regardless of the
    // global count; fails closed for the same reason the global guard does.
    try {
      const channelKeep = await autoRemovalQueries.getChannelKeepRecentIds();
      result.plan.channelKeepRecent.channelCount = channelKeep.channelCount;
      result.plan.channelKeepRecent.protectedCount = channelKeep.ids.length;
      if (channelKeep.ids.length > 0) {
        keepRecentIds = Array.from(new Set([...keepRecentIds, ...channelKeep.ids]));
        logger.info(
          { channelCount: channelKeep.channelCount, protectedCount: channelKeep.ids.length },
          '[Auto-Removal] Protecting per-channel most recent downloads from cleanup'
        );
      }
    } catch (error) {
      logger.error({ err: error }, '[Auto-Removal] Could not determine per-channel protected downloads, aborting cleanup');
      result.errors.push('Could not determine per-channel protected downloads; cleanup aborted for safety');
      result.success = false;
      return result;
    }

    // Age-based cleanup
    if (hasAgeThreshold) {
      const thresholdDays = parseInt(config.autoRemovalVideoAgeThreshold, 10);

      if (Number.isNaN(thresholdDays) || thresholdDays <= 0) {
        logger.warn({ threshold: config.autoRemovalVideoAgeThreshold }, '[Auto-Removal] Invalid age threshold provided, skipping age-based cleanup');
      } else {
        result.plan.ageStrategy.enabled = true;
        result.plan.ageStrategy.thresholdDays = thresholdDays;

        try {
          logger.info({ thresholdDays }, '[Auto-Removal] Checking for videos older than threshold');
          const oldVideos = await this.getVideosOlderThanThreshold(thresholdDays, keepRecentIds, minFileSizeBytes);
          const estimatedFreed = oldVideos.reduce((sum, v) => sum + (parseInt(v.fileSize) || 0), 0);

          if (dryRun && dryRunProcessedIds) {
            oldVideos.forEach(video => dryRunProcessedIds.add(video.id));
          }

          result.plan.ageStrategy.candidateCount = oldVideos.length;
          result.plan.ageStrategy.estimatedFreedBytes = estimatedFreed;
          if (includeSamples) {
            result.plan.ageStrategy.sampleVideos = oldVideos.slice(0, 10).map(video => this.formatVideoForPlan(video));
          }

          if (dryRun) {
            if (result.simulationTotals) {
              result.simulationTotals.byAge = oldVideos.length;
              result.simulationTotals.total += oldVideos.length;
              result.simulationTotals.estimatedFreedBytes += estimatedFreed;
            }
          } else if (oldVideos.length > 0) {
            logger.info({ count: oldVideos.length }, '[Auto-Removal] Deleting videos older than threshold');
            const videoIds = oldVideos.map(v => v.id);
            const deleteResult = await this.deleteVideos(videoIds);

            result.deletedByAge = deleteResult.deleted.length;
            result.plan.ageStrategy.deletedCount = deleteResult.deleted.length;
            result.plan.ageStrategy.failedCount = deleteResult.failed.length;
            result.totalDeleted += deleteResult.deleted.length;

            if (deleteResult.failed.length > 0) {
              result.errors.push(`Failed to delete ${deleteResult.failed.length} videos by age`);
              deleteResult.failed.forEach(f => {
                logger.error({ videoId: f.videoId, error: f.error }, '[Auto-Removal] Failed to delete video');
              });
            }

            const deletedVideos = oldVideos.filter(v => deleteResult.deleted.includes(v.id));
            const freed = deletedVideos.reduce((sum, v) => sum + (parseInt(v.fileSize) || 0), 0);
            result.freedBytes += freed;
            result.plan.ageStrategy.estimatedFreedBytes = freed;

            if (includeSamples) {
              const deletedSamples = deletedVideos.slice(0, 10).map(video => this.formatVideoForPlan(video));
              result.plan.ageStrategy.sampleVideos = deletedSamples;
            }

            logger.info({ deletedCount: deleteResult.deleted.length, freedGB: (freed / (1024 ** 3)).toFixed(2) }, '[Auto-Removal] Age-based cleanup completed');
          } else {
            logger.info('[Auto-Removal] No videos found older than age threshold');
          }
        } catch (error) {
          logger.error({ err: error }, '[Auto-Removal] Error during age-based cleanup');
          result.errors.push(`Age-based cleanup error: ${error.message}`);
          result.success = false;
        }
      }
    }

    // Watched-based cleanup
    if (watchedEnabled) {
      if (config.watchStatusSyncEnabled === false) {
        result.plan.watchedStrategy.skippedReason = 'Watched-based cleanup skipped: watch status sync is disabled';
        logger.warn('[Auto-Removal] Watch status sync is disabled, skipping watched-based cleanup');
      } else {
        const minDaysSinceWatched = this._parsePositiveInt(config.autoRemovalWatchedMinDaysSinceWatched);
        const minVideoAgeDays = this._parsePositiveInt(config.autoRemovalWatchedMinVideoAgeDays);

        result.plan.watchedStrategy.enabled = true;
        result.plan.watchedStrategy.minDaysSinceWatched = minDaysSinceWatched;
        result.plan.watchedStrategy.minVideoAgeDays = minVideoAgeDays;

        try {
          logger.info({ minDaysSinceWatched, minVideoAgeDays }, '[Auto-Removal] Checking for watched videos eligible for removal');
          // Real runs can't overlap (age deletions are already marked
          // removed), so only dry-run needs the explicit exclusion.
          const watchedExcludeIds = dryRun && dryRunProcessedIds
            ? Array.from(new Set([...keepRecentIds, ...dryRunProcessedIds]))
            : keepRecentIds;
          const watchedVideos = await autoRemovalQueries.getWatchedRemovalCandidates({
            minDaysSinceWatched,
            minVideoAgeDays,
            excludeIds: watchedExcludeIds,
            minFileSizeBytes
          });
          const estimatedFreed = watchedVideos.reduce((sum, v) => sum + (parseInt(v.fileSize) || 0), 0);

          if (dryRun && dryRunProcessedIds) {
            watchedVideos.forEach(video => dryRunProcessedIds.add(video.id));
          }

          result.plan.watchedStrategy.candidateCount = watchedVideos.length;
          result.plan.watchedStrategy.estimatedFreedBytes = estimatedFreed;
          if (includeSamples) {
            result.plan.watchedStrategy.sampleVideos = watchedVideos.slice(0, 10).map(video => this.formatVideoForPlan(video));
          }

          if (dryRun) {
            if (result.simulationTotals) {
              result.simulationTotals.byWatched = watchedVideos.length;
              result.simulationTotals.total += watchedVideos.length;
              result.simulationTotals.estimatedFreedBytes += estimatedFreed;
            }
          } else if (watchedVideos.length > 0) {
            logger.info({ count: watchedVideos.length }, '[Auto-Removal] Deleting watched videos');
            const videoIds = watchedVideos.map(v => v.id);
            const deleteResult = await this.deleteVideos(videoIds);

            result.deletedByWatched = deleteResult.deleted.length;
            result.plan.watchedStrategy.deletedCount = deleteResult.deleted.length;
            result.plan.watchedStrategy.failedCount = deleteResult.failed.length;
            result.totalDeleted += deleteResult.deleted.length;

            if (deleteResult.failed.length > 0) {
              result.errors.push(`Failed to delete ${deleteResult.failed.length} watched videos`);
              deleteResult.failed.forEach(f => {
                logger.error({ videoId: f.videoId, error: f.error }, '[Auto-Removal] Failed to delete video');
              });
            }

            const deletedVideos = watchedVideos.filter(v => deleteResult.deleted.includes(v.id));
            const freed = deletedVideos.reduce((sum, v) => sum + (parseInt(v.fileSize) || 0), 0);
            result.freedBytes += freed;
            result.plan.watchedStrategy.estimatedFreedBytes = freed;

            if (includeSamples) {
              result.plan.watchedStrategy.sampleVideos = deletedVideos.slice(0, 10).map(video => this.formatVideoForPlan(video));
            }

            logger.info({ deletedCount: deleteResult.deleted.length, freedGB: (freed / (1024 ** 3)).toFixed(2) }, '[Auto-Removal] Watched-based cleanup completed');
          } else {
            logger.info('[Auto-Removal] No watched videos eligible for removal');
          }
        } catch (error) {
          logger.error({ err: error }, '[Auto-Removal] Error during watched-based cleanup');
          result.errors.push(`Watched-based cleanup error: ${error.message}`);
          result.success = false;
        }
      }
    }

    // Space-based cleanup
    if (hasSpaceThreshold) {
      try {
        logger.info({ threshold: config.autoRemovalFreeSpaceThreshold }, '[Auto-Removal] Checking storage status against threshold');
        const storageStatus = await configModule.getStorageStatus();

        result.plan.spaceStrategy.storageStatus = storageStatus;

        if (!storageStatus) {
          logger.warn('[Auto-Removal] Could not retrieve storage status - skipping space-based cleanup for safety');
          result.errors.push('Storage status unavailable, skipped space-based cleanup');
        } else {
          const isBelowThreshold = configModule.isStorageBelowThreshold(
            storageStatus.available,
            config.autoRemovalFreeSpaceThreshold
          );

          result.plan.spaceStrategy.needsCleanup = isBelowThreshold;

          const thresholdBytes = configModule.convertStorageThresholdToBytes(config.autoRemovalFreeSpaceThreshold);

          if (thresholdBytes === null) {
            logger.warn('[Auto-Removal] Invalid storage threshold format, skipping space-based cleanup');
            result.errors.push('Invalid storage threshold format, skipped space-based cleanup');
          } else {
            result.plan.spaceStrategy.enabled = true;
            result.plan.spaceStrategy.thresholdBytes = thresholdBytes;

            if (isBelowThreshold) {
              const spaceToFree = thresholdBytes - storageStatus.available;
              logger.info({ spaceToFreeGB: (spaceToFree / (1024 ** 3)).toFixed(2) }, '[Auto-Removal] Need to free storage space');

              const batchSize = 50;
              const maxIterations = 10;

              if (dryRun) {
                const processedIds = new Set(dryRunProcessedIds || []);
                keepRecentIds.forEach(id => processedIds.add(id));
                let freedSoFar = 0;
                let iterations = 0;

                while (freedSoFar < spaceToFree && iterations < maxIterations) {
                  const oldestVideos = await this.getOldestVideos(batchSize, Array.from(processedIds), minFileSizeBytes);

                  if (oldestVideos.length === 0) {
                    logger.info('[Auto-Removal] Dry-run: no more videos available for space-based cleanup');
                    break;
                  }

                  oldestVideos.forEach(v => processedIds.add(v.id));

                  const batchFreed = oldestVideos.reduce((sum, v) => sum + (parseInt(v.fileSize) || 0), 0);
                  freedSoFar += batchFreed;

                  result.plan.spaceStrategy.candidateCount += oldestVideos.length;
                  result.plan.spaceStrategy.estimatedFreedBytes += batchFreed;

                  if (includeSamples && result.plan.spaceStrategy.sampleVideos.length < 10) {
                    const remainingSlots = 10 - result.plan.spaceStrategy.sampleVideos.length;
                    result.plan.spaceStrategy.sampleVideos.push(
                      ...oldestVideos.slice(0, remainingSlots).map(video => this.formatVideoForPlan(video))
                    );
                  }

                  iterations += 1;
                }

                result.plan.spaceStrategy.iterations = iterations;

                if (result.simulationTotals) {
                  result.simulationTotals.bySpace = result.plan.spaceStrategy.candidateCount;
                  result.simulationTotals.total += result.plan.spaceStrategy.candidateCount;
                  result.simulationTotals.estimatedFreedBytes += result.plan.spaceStrategy.estimatedFreedBytes;
                }
              } else {
                let freedSoFar = 0;
                let iterations = 0;
                const affectedChannelIds = [];

                while (freedSoFar < spaceToFree && iterations < maxIterations) {
                  const oldestVideos = await this.getOldestVideos(batchSize, keepRecentIds, minFileSizeBytes);

                  if (oldestVideos.length === 0) {
                    logger.info('[Auto-Removal] No more videos available to delete');
                    break;
                  }

                  let batchDeletedCount = 0;
                  let batchFreed = 0;

                  // Delete videos one-by-one until threshold is met to avoid over-deletion
                  for (const video of oldestVideos) {
                    if (freedSoFar >= spaceToFree) {
                      logger.info('[Auto-Removal] Space threshold met, stopping space-based cleanup');
                      break;
                    }

                    result.plan.spaceStrategy.candidateCount += 1;

                    const deleteResult = await this.deleteVideoById(video.id);

                    if (deleteResult.success) {
                      const videoSize = parseInt(video.fileSize) || 0;
                      freedSoFar += videoSize;
                      batchFreed += videoSize;
                      batchDeletedCount += 1;
                      affectedChannelIds.push(deleteResult.channelId);

                      result.deletedBySpace += 1;
                      result.plan.spaceStrategy.deletedCount += 1;
                      result.totalDeleted += 1;
                      result.freedBytes += videoSize;
                      result.plan.spaceStrategy.estimatedFreedBytes += videoSize;

                      if (includeSamples && result.plan.spaceStrategy.sampleVideos.length < 10) {
                        result.plan.spaceStrategy.sampleVideos.push(this.formatVideoForPlan(video));
                      }
                    } else {
                      result.plan.spaceStrategy.failedCount += 1;
                      result.errors.push(`Failed to delete video ${video.id}: ${deleteResult.error}`);
                      logger.error({ videoId: video.id, error: deleteResult.error }, '[Auto-Removal] Failed to delete video');
                    }
                  }

                  logger.info({
                    batch: iterations + 1,
                    deletedCount: batchDeletedCount,
                    batchFreedGB: (batchFreed / (1024 ** 3)).toFixed(2),
                    totalFreedGB: (freedSoFar / (1024 ** 3)).toFixed(2)
                  }, '[Auto-Removal] Batch completed');

                  iterations += 1;

                  if (freedSoFar >= spaceToFree) {
                    break;
                  }
                }

                result.plan.spaceStrategy.iterations = iterations;

                if (iterations >= maxIterations) {
                  logger.warn('[Auto-Removal] Reached maximum iterations for space-based cleanup');
                  result.errors.push('Reached maximum iterations, may need additional cleanup');
                }

                this._regenerateM3usForChannels(affectedChannelIds);
              }
            } else {
              logger.info({ availableGB: storageStatus.availableGB }, '[Auto-Removal] Storage is above threshold, no space-based cleanup needed');
            }
          }
        }
      } catch (error) {
        logger.error({ err: error }, '[Auto-Removal] Error during space-based cleanup');
        result.errors.push(`Space-based cleanup error: ${error.message}`);
        result.success = false;
      }
    }

    logger.info({
      dryRun,
      totalDeleted: result.totalDeleted,
      deletedByAge: result.deletedByAge,
      deletedByWatched: result.deletedByWatched,
      deletedBySpace: result.deletedBySpace,
      totalFreedGB: (result.freedBytes / (1024 ** 3)).toFixed(2),
      errorCount: result.errors.length
    }, '[Auto-Removal] Cleanup completed');

    if (dryRun && result.simulationTotals) {
      logger.info({
        simulatedByAge: result.simulationTotals.byAge,
        simulatedByWatched: result.simulationTotals.byWatched,
        simulatedBySpace: result.simulationTotals.bySpace,
        estimatedFreedGB: (result.simulationTotals.estimatedFreedBytes / (1024 ** 3)).toFixed(2)
      }, '[Auto-Removal] Dry-run simulation summary');
    }

    return result;
  }
}

module.exports = new VideoDeletionModule();
