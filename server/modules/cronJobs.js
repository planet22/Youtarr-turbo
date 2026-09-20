const schedule = require('node-cron');
const logger = require('../logger');

// Registry behind the Maintenance page's "Scheduled tasks" table: every job
// below is registered through defineTask, which schedules it exactly as
// before and also lets it be run on demand. State is in-memory (resets on
// restart).
const tasks = new Map();
const runners = new Map();

// Next occurrence of a daily "M H * * *" expression in server-local time (the
// zone node-cron schedules in), or null for any other shape.
function nextDailyRun(cronExpression, now = new Date()) {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(cronExpression);
  if (!match) return null;
  const next = new Date(now);
  next.setHours(Number(match[2]), Number(match[1]), 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

async function runTask(id, trigger) {
  const task = tasks.get(id);
  if (!task) return { started: false, reason: 'unknown' };
  if (task.running) {
    logger.warn({ taskId: id, trigger }, 'Scheduled task already running, skipping this trigger');
    return { started: false, reason: 'running' };
  }

  task.running = true;
  task.lastTrigger = trigger;
  task.lastStartedAt = new Date().toISOString();
  try {
    await runners.get(id)();
    task.lastStatus = 'ok';
    task.lastError = null;
  } catch (err) {
    task.lastStatus = 'error';
    task.lastError = err.message;
    logger.error({ err, taskId: id }, 'Scheduled task failed');
  } finally {
    task.running = false;
    task.lastFinishedAt = new Date().toISOString();
  }
  return { started: true };
}

function defineTask({ id, label, description, cron, confirm }, run) {
  tasks.set(id, {
    id, label, description, cron, confirm,
    running: false,
    lastTrigger: null,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastStatus: null,
    lastError: null,
  });
  runners.set(id, run);
  schedule.schedule(cron, async () => {
    await runTask(id, 'scheduled');
  });
}

function getTasks() {
  return Array.from(tasks.values()).map((task) => ({
    ...task,
    nextRun: nextDailyRun(task.cron),
  }));
}

/**
 * Starts a task in the background and returns immediately.
 * @returns {{started: boolean, reason?: 'unknown'|'running'}}
 */
function runTaskNow(id) {
  const task = tasks.get(id);
  if (!task) return { started: false, reason: 'unknown' };
  if (task.running) return { started: false, reason: 'running' };
  void runTask(id, 'manual');
  return { started: true };
}

/**
 * Initialize all scheduled cron jobs for the application
 * This module centralizes all cron job definitions for better maintainability
 *
 * @param {Object} [deps]
 * @param {Function} [deps.refreshYtDlpVersionCache] - Refreshes the cached yt-dlp version after a successful auto-update
 */
function initialize(deps = {}) {
  const db = require('../db');
  const videosModule = require('./videosModule');
  const videoDeletionModule = require('./videoDeletionModule');
  const notificationModule = require('./notificationModule');
  const ytdlpModule = require('./ytdlpModule');
  const configModule = require('./configModule');
  const jobEventLog = require('./jobEventLog');
  const { refreshYtDlpVersionCache } = deps;

  logger.info('Initializing scheduled cron jobs');

  // ============================================================================
  // AUTOMATIC VIDEO CLEANUP - 2:00 AM Daily
  // ============================================================================
  defineTask({
    id: 'auto-removal',
    label: 'Automatic video cleanup',
    description: 'Deletes videos per the auto-removal settings (age, watched, free space), then removes empty folders. Permanently deletes files.',
    cron: '0 2 * * *',
    confirm: true,
  }, async () => {
    logger.info('Running automatic video cleanup cron job');
    try {
      const result = await jobEventLog.runWithContext(
        { actor: 'auto-removal', reason: 'automatic removal' },
        () => videoDeletionModule.performAutomaticCleanup()
      );

      if (result.totalDeleted > 0) {
        logger.info({
          totalDeleted: result.totalDeleted,
          freedGB: (result.freedBytes / (1024 ** 3)).toFixed(2)
        }, 'Automatic cleanup completed successfully');

        notificationModule.sendAutoRemovalNotification(result)
          .catch(err => logger.error({ err }, 'Failed to send auto-removal notification'));
      } else {
        logger.info('Automatic cleanup completed: no videos deleted');
      }

      if (result.errors.length > 0) {
        logger.warn({ errorCount: result.errors.length }, 'Automatic cleanup completed with errors');
      }
    } catch (error) {
      logger.error({ err: error }, 'Error during automatic video cleanup');
    }

    // Always scan for orphan empty channel directories, regardless of auto-removal settings.
    // This handles directories left behind from deletions before the cleanup feature existed,
    // or from files deleted outside of Youtarr.
    try {
      await videoDeletionModule.cleanupOrphanDirectories();
    } catch (error) {
      logger.error({ err: error }, 'Error during orphan directory cleanup');
    }
  });

  // ============================================================================
  // STRM CACHE-ON-PLAY EXPIRY SWEEP - 2:10 AM Daily
  // ============================================================================
  // Reverts videos that STRM cache-on-play opportunistically downloaded
  // (server/modules/strmCacheOnPlay.js) back to STRM once older than
  // strm.cacheOnPlayExpiryHours, so a cache-on-play download doesn't
  // silently become a permanent one. No-op (returns immediately) when that
  // threshold is unset/0 - see videoDeletionModule.sweepExpiredCachedVideos.
  // Runs 10 minutes after the main auto-removal pass so both nightly jobs
  // don't race on the same rows.
  defineTask({
    id: 'strm-cache-expiry',
    label: 'STRM cache-on-play expiry',
    description: 'Reverts expired cache-on-play downloads back to STRM and clears expired untracked HLS buffer files.',
    cron: '10 2 * * *',
    confirm: false,
  }, async () => {
    try {
      const result = await jobEventLog.runWithContext(
        { actor: 'strm-cache-expiry', reason: 'STRM cache-on-play expiry' },
        () => videoDeletionModule.sweepExpiredCachedVideos()
      );
      if (result.reverted > 0 || result.failed > 0) {
        logger.info(result, 'STRM cache-on-play expiry sweep completed');
      }
    } catch (error) {
      logger.error({ err: error }, 'Error during STRM cache-on-play expiry sweep');
    }

    // Same threshold, same slot - mode=hls-buffer's untracked cache (no
    // Video row to attach the above sweep's cached_at/is_strm lifecycle to)
    // gets its own age-based cleanup here instead - see
    // ytstream.js's sweepExpiredUntrackedBufferCache doc comment.
    try {
      const ytstreamRoutes = require('../routes/ytstream');
      const bufferResult = await ytstreamRoutes.sweepExpiredUntrackedBufferCache();
      if (bufferResult.deleted > 0) {
        logger.info(bufferResult, 'Untracked hls-buffer cache expiry sweep completed');
      }
    } catch (error) {
      logger.error({ err: error }, 'Error during untracked hls-buffer cache expiry sweep');
    }
  });

  // ============================================================================
  // SESSION CLEANUP - 3:00 AM Daily
  // ============================================================================
  defineTask({
    id: 'session-cleanup',
    label: 'Session cleanup',
    description: 'Removes expired and long-inactive login sessions.',
    cron: '0 3 * * *',
    confirm: false,
  }, async () => {
    try {
      const result = await db.Session.destroy({
        where: {
          [db.Sequelize.Op.or]: [
            {
              expires_at: {
                [db.Sequelize.Op.lt]: new Date()
              }
            },
            {
              is_active: false,
              updatedAt: {
                [db.Sequelize.Op.lt]: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // 30 days old
              }
            }
          ]
        }
      });
      logger.info({ removed: result }, 'Removed expired sessions');
    } catch (error) {
      logger.error({ err: error }, 'Error cleaning sessions');
    }
  });

  // ============================================================================
  // STREAM HISTORY PRUNE - 3:15 AM Daily
  // ============================================================================
  // Keeps the audit trail from growing unbounded - every ytstream playback
  // session (server/routes/ytstream.js's trackStream/untrackStream) writes a
  // row here, with no natural cap the way the job-history table has. Retention
  // is configurable (Settings -> Streaming -> ytstream.historyRetentionDays),
  // defaulting to 90 days when unset.
  defineTask({
    id: 'stream-history-prune',
    label: 'Stream history prune',
    description: 'Removes stream-history rows older than the configured retention.',
    cron: '15 3 * * *',
    confirm: false,
  }, async () => {
    if (!db.StreamHistory) return;
    try {
      const configuredDays = configModule.getConfig().ytstream?.historyRetentionDays;
      const retentionDays = Number.isFinite(configuredDays) && configuredDays > 0 ? configuredDays : 90;
      const result = await db.StreamHistory.destroy({
        where: {
          started_at: {
            [db.Sequelize.Op.lt]: new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000),
          },
        },
      });
      logger.info({ removed: result, retentionDays }, 'Pruned old stream-history rows');
    } catch (error) {
      logger.error({ err: error }, 'Error pruning stream history');
    }
  });

  // ============================================================================
  // UNTRACKED YOUTUBE METADATA CACHE PRUNE - 3:20 AM Daily
  // ============================================================================
  // youtube_metadata_cache (server/models/youtubemetadatacache.js) holds
  // cheap-but-not-free lookups (currently just duration) for videos with no
  // Video library row - untracked NZB grabs and played-but-never-downloaded
  // videos. Each row is a handful of bytes, so retention is deliberately on
  // its own, much longer clock than every other prune here (stream_history's
  // 90 days, cache-on-play's configurable hours) - a year of near-zero
  // storage cost buys a lot fewer repeat yt-dlp calls, and it's only
  // expired by how recently it was actually used, not when it was first
  // fetched. Single source of truth: server/modules/youtubeMetadataCache.js
  // (also read by the Library page's per-video expiry countdown).
  const { YOUTUBE_METADATA_CACHE_RETENTION_DAYS } = require('./youtubeMetadataCache');
  defineTask({
    id: 'metadata-cache-prune',
    label: 'Untracked metadata cache prune',
    description: 'Removes stale entries from the untracked-video YouTube metadata cache.',
    cron: '20 3 * * *',
    confirm: false,
  }, async () => {
    if (!db.YoutubeMetadataCache) return;
    try {
      const retentionDays = YOUTUBE_METADATA_CACHE_RETENTION_DAYS;
      const result = await db.YoutubeMetadataCache.destroy({
        where: {
          last_accessed_at: {
            [db.Sequelize.Op.lt]: new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000),
          },
        },
      });
      if (result > 0) logger.info({ removed: result, retentionDays }, 'Pruned stale entries from the untracked-video YouTube metadata cache');
    } catch (error) {
      logger.error({ err: error }, 'Error pruning youtube_metadata_cache');
    }
  });

  // ============================================================================
  // VIDEO/EVENTS LOG PRUNE - 3:25 AM Daily
  // ============================================================================
  // job_events (server/modules/jobEventLog) is append-only, so this is the only
  // thing that ever removes rows. Retention is jobEventLogRetentionDays
  // (default 180, 0 keeps everything).
  defineTask({
    id: 'job-event-prune',
    label: 'Video/events log prune',
    description: 'Removes video/events log rows older than the configured retention.',
    cron: '25 3 * * *',
    confirm: false,
  }, async () => {
    try {
      await jobEventLog.prune();
    } catch (error) {
      logger.error({ err: error }, 'Error pruning the video/events log');
    }
  });

  // ============================================================================
  // VIDEO METADATA BACKFILL - 3:30 AM Daily
  // ============================================================================
  defineTask({
    id: 'metadata-backfill',
    label: 'Video metadata backfill',
    description: 'Starts the video metadata backfill (runs in the background).',
    cron: '30 3 * * *',
    confirm: false,
  }, async () => {
    logger.info('Starting scheduled video metadata backfill');
    try {
      // Run asynchronously without blocking - the method handles its own async flow
      videosModule.backfillVideoMetadata({ trigger: 'scheduled' })
        .then(result => {
          if (result && result.timedOut) {
            logger.info('Video metadata backfill reached time limit, will continue tomorrow');
          } else {
            logger.info('Video metadata backfill completed successfully');
          }
        })
        .catch(err => {
          logger.error({ err }, 'Video metadata backfill failed');
        });
    } catch (error) {
      logger.error({ err: error }, 'Error starting video metadata backfill');
    }
  });

  // ============================================================================
  // YT-DLP AUTO-UPDATE - 4:00 AM Daily (only when enabled in config)
  // ============================================================================
  defineTask({
    id: 'ytdlp-update',
    label: 'yt-dlp auto-update',
    description: 'Updates yt-dlp. Does nothing unless auto-update is enabled in settings.',
    cron: '0 4 * * *',
    confirm: false,
  }, async () => {
    try {
      // Skip on platforms that manage yt-dlp themselves (e.g., Elfhosted)
      if (configModule.isElfhostedPlatform()) {
        return;
      }

      const config = configModule.getConfig();
      if (!config.autoUpdateYtdlp) {
        return;
      }

      logger.info('Running nightly yt-dlp auto-update');
      const checkedAt = new Date().toISOString();
      const result = await ytdlpModule.performUpdate({ channel: config.ytdlpUpdateChannel });

      const updatedConfig = { ...configModule.getConfig(), ytdlpLastChecked: checkedAt };

      const resultStatus = result.reason || (result.success ? (result.newVersion ? 'updated' : 'up-to-date') : 'error');

      if (result.success) {
        if (resultStatus === 'updated') {
          updatedConfig.ytdlpLastUpdated = checkedAt;
          updatedConfig.ytdlpLastResult = {
            status: 'updated',
            ...(result.newVersion ? { version: result.newVersion } : {})
          };
          logger.info({ newVersion: result.newVersion }, 'Nightly yt-dlp auto-update installed new version');
        } else {
          updatedConfig.ytdlpLastResult = { status: 'up-to-date' };
          logger.info('Nightly yt-dlp auto-update: already up to date');
        }
        if (typeof refreshYtDlpVersionCache === 'function') {
          try {
            refreshYtDlpVersionCache();
          } catch (err) {
            logger.warn({ err }, 'Failed to refresh yt-dlp version cache after auto-update');
          }
        }
      } else {
        updatedConfig.ytdlpLastResult = {
          status: resultStatus === 'skipped' ? 'skipped' : 'error',
          message: result.message || 'Unknown error'
        };
        if (resultStatus === 'skipped') {
          logger.info({ message: result.message }, 'Nightly yt-dlp auto-update skipped');
        } else {
          logger.warn({ message: result.message }, 'Nightly yt-dlp auto-update failed');
        }
      }

      configModule.updateConfig(updatedConfig);
    } catch (error) {
      logger.error({ err: error }, 'Unexpected error in nightly yt-dlp auto-update');
    }
  });

  logger.info('Scheduled cron jobs initialized successfully');
  logger.info('  - Automatic video cleanup: 2:00 AM daily');
  logger.info('  - Session cleanup: 3:00 AM daily');
  logger.info('  - Video metadata backfill: 3:30 AM daily');
  logger.info('  - yt-dlp auto-update: 4:00 AM daily (when enabled)');
}

module.exports = {
  initialize,
  getTasks,
  runTaskNow
};
