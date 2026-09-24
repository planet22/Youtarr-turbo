/* eslint-env jest */

describe('cronJobs nightly maintenance tasks', () => {
  let cronJobs;
  let schedule;
  let logger;
  let db;
  let videoDeletionModule;
  let ytstreamRoutes;
  let configStore;
  const DAY_MS = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    schedule = { schedule: jest.fn() };
    logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };
    db = {
      Session: { destroy: jest.fn() },
      StreamHistory: { destroy: jest.fn().mockResolvedValue(0) },
      YoutubeMetadataCache: { destroy: jest.fn().mockResolvedValue(0) },
      Sequelize: { Op: { or: Symbol('or'), lt: Symbol('lt') } },
    };
    videoDeletionModule = {
      performAutomaticCleanup: jest.fn(),
      cleanupOrphanDirectories: jest.fn().mockResolvedValue({}),
      sweepExpiredCachedVideos: jest.fn().mockResolvedValue({ reverted: 0, failed: 0 }),
    };
    ytstreamRoutes = { sweepExpiredUntrackedBufferCache: jest.fn().mockResolvedValue({ deleted: 0 }) };
    configStore = {};

    jest.doMock('node-cron', () => schedule);
    jest.doMock('../../logger', () => logger);
    jest.doMock('../../db', () => db);
    jest.doMock('../videosModule', () => ({ backfillVideoMetadata: jest.fn() }));
    jest.doMock('../videoDeletionModule', () => videoDeletionModule);
    jest.doMock('../notificationModule', () => ({ sendAutoRemovalNotification: jest.fn() }));
    jest.doMock('../ytdlpModule', () => ({ performUpdate: jest.fn() }));
    jest.doMock('../videoThumbnailCache', () => ({ pruneUnused: jest.fn(() => Promise.resolve(0)) }));
    jest.doMock('../configModule', () => ({ getConfig: jest.fn(() => configStore), isElfhostedPlatform: jest.fn(() => false) }));
    jest.doMock('../youtubeMetadataCache', () => ({ YOUTUBE_METADATA_CACHE_RETENTION_DAYS: 365 }));
    jest.doMock('../../routes/ytstream', () => ytstreamRoutes);

    cronJobs = require('../cronJobs');
    cronJobs.initialize();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const run = async (expression) => {
    const call = schedule.schedule.mock.calls.find(([expr]) => expr === expression);
    await call[1]();
  };
  const task = (id) => cronJobs.getTasks().find((t) => t.id === id);

  describe('deletions run inside a video/events log context', () => {
    it('runs the nightly auto-removal as the auto-removal actor', async () => {
      videoDeletionModule.performAutomaticCleanup.mockResolvedValue({ totalDeleted: 0, freedBytes: 0, errors: [] });

      await run('0 2 * * *');

      expect(require('../jobEventLog').runWithContext).toHaveBeenCalledWith(
        { actor: 'auto-removal', reason: 'automatic removal' },
        expect.any(Function)
      );
    });

    it('runs the STRM cache expiry sweep as the strm-cache-expiry actor', async () => {
      await run('10 2 * * *');

      expect(require('../jobEventLog').runWithContext).toHaveBeenCalledWith(
        { actor: 'strm-cache-expiry', reason: 'STRM cache-on-play expiry' },
        expect.any(Function)
      );
    });
  });

  describe('video/events log prune (3:25 AM)', () => {
    it('is registered as its own task', () => {
      expect(task('job-event-prune')).toMatchObject({ cron: '25 3 * * *', confirm: false });
    });

    it('prunes the log through jobEventLog', async () => {
      const jobEventLog = require('../jobEventLog');

      await run('25 3 * * *');

      expect(jobEventLog.prune).toHaveBeenCalled();
    });

    it('logs instead of throwing when the prune fails', async () => {
      require('../jobEventLog').prune.mockRejectedValueOnce(new Error('db down'));

      await run('25 3 * * *');

      expect(logger.error).toHaveBeenCalledWith({ err: expect.any(Error) }, 'Error pruning the video/events log');
    });
  });

  describe('STRM cache-on-play expiry (2:10 AM)', () => {
    it('is registered as its own task', () => {
      expect(task('strm-cache-expiry')).toMatchObject({ cron: '10 2 * * *', confirm: false });
    });

    it('sweeps expired cache-on-play downloads', async () => {
      await run('10 2 * * *');

      expect(videoDeletionModule.sweepExpiredCachedVideos).toHaveBeenCalled();
    });

    it('logs when videos were reverted', async () => {
      videoDeletionModule.sweepExpiredCachedVideos.mockResolvedValue({ reverted: 2, failed: 0 });

      await run('10 2 * * *');

      expect(logger.info).toHaveBeenCalledWith({ reverted: 2, failed: 0 }, 'STRM cache-on-play expiry sweep completed');
    });

    it('logs when a revert failed', async () => {
      videoDeletionModule.sweepExpiredCachedVideos.mockResolvedValue({ reverted: 0, failed: 1 });

      await run('10 2 * * *');

      expect(logger.info).toHaveBeenCalledWith({ reverted: 0, failed: 1 }, 'STRM cache-on-play expiry sweep completed');
    });

    it('stays quiet when nothing was reverted', async () => {
      await run('10 2 * * *');

      expect(logger.info).not.toHaveBeenCalledWith(expect.anything(), 'STRM cache-on-play expiry sweep completed');
    });

    it('logs and carries on when the sweep throws', async () => {
      videoDeletionModule.sweepExpiredCachedVideos.mockRejectedValue(new Error('db down'));

      await run('10 2 * * *');

      expect(logger.error).toHaveBeenCalledWith({ err: expect.any(Error) }, 'Error during STRM cache-on-play expiry sweep');
      expect(ytstreamRoutes.sweepExpiredUntrackedBufferCache).toHaveBeenCalled();
    });

    it('also expires the untracked hls-buffer cache', async () => {
      ytstreamRoutes.sweepExpiredUntrackedBufferCache.mockResolvedValue({ deleted: 3, freedBytes: 30 });

      await run('10 2 * * *');

      expect(logger.info).toHaveBeenCalledWith({ deleted: 3, freedBytes: 30 }, 'Untracked hls-buffer cache expiry sweep completed');
    });

    it('does not log an untracked sweep that deleted nothing', async () => {
      await run('10 2 * * *');

      expect(logger.info).not.toHaveBeenCalledWith(expect.anything(), 'Untracked hls-buffer cache expiry sweep completed');
    });

    it('logs when the untracked sweep throws', async () => {
      ytstreamRoutes.sweepExpiredUntrackedBufferCache.mockRejectedValue(new Error('io'));

      await run('10 2 * * *');

      expect(logger.error).toHaveBeenCalledWith({ err: expect.any(Error) }, 'Error during untracked hls-buffer cache expiry sweep');
    });

    it('records the run on the task', async () => {
      await run('10 2 * * *');

      expect(task('strm-cache-expiry')).toMatchObject({ lastStatus: 'ok', lastTrigger: 'scheduled', running: false });
    });
  });

  describe('stream history prune (3:15 AM)', () => {
    it('removes rows older than 90 days by default', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);

      await run('15 3 * * *');

      const cutoff = db.StreamHistory.destroy.mock.calls[0][0].where.started_at[db.Sequelize.Op.lt];
      expect(cutoff).toEqual(new Date(1_800_000_000_000 - 90 * DAY_MS));
    });

    it('uses the configured retention', async () => {
      configStore = { ytstream: { historyRetentionDays: 30 } };
      jest.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);

      await run('15 3 * * *');

      const cutoff = db.StreamHistory.destroy.mock.calls[0][0].where.started_at[db.Sequelize.Op.lt];
      expect(cutoff).toEqual(new Date(1_800_000_000_000 - 30 * DAY_MS));
    });

    it.each([0, -5, 'abc', null])('falls back to 90 days for the retention %p', async (days) => {
      configStore = { ytstream: { historyRetentionDays: days } };
      jest.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);

      await run('15 3 * * *');

      const cutoff = db.StreamHistory.destroy.mock.calls[0][0].where.started_at[db.Sequelize.Op.lt];
      expect(cutoff).toEqual(new Date(1_800_000_000_000 - 90 * DAY_MS));
    });

    it('logs how many rows were removed', async () => {
      db.StreamHistory.destroy.mockResolvedValue(12);

      await run('15 3 * * *');

      expect(logger.info).toHaveBeenCalledWith({ removed: 12, retentionDays: 90 }, 'Pruned old stream-history rows');
    });

    it('does nothing when the StreamHistory model is unavailable', async () => {
      db.StreamHistory = undefined;

      await expect(run('15 3 * * *')).resolves.toBeUndefined();

      expect(logger.info).not.toHaveBeenCalledWith(expect.anything(), 'Pruned old stream-history rows');
    });

    it('logs and carries on when pruning throws', async () => {
      db.StreamHistory.destroy.mockRejectedValue(new Error('db down'));

      await run('15 3 * * *');

      expect(logger.error).toHaveBeenCalledWith({ err: expect.any(Error) }, 'Error pruning stream history');
    });
  });

  describe('untracked metadata cache prune (3:20 AM)', () => {
    it('removes entries not used for a year', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);

      await run('20 3 * * *');

      const cutoff = db.YoutubeMetadataCache.destroy.mock.calls[0][0].where.last_accessed_at[db.Sequelize.Op.lt];
      expect(cutoff).toEqual(new Date(1_800_000_000_000 - 365 * DAY_MS));
    });

    it('logs when entries were removed', async () => {
      db.YoutubeMetadataCache.destroy.mockResolvedValue(7);

      await run('20 3 * * *');

      expect(logger.info).toHaveBeenCalledWith({ removed: 7, retentionDays: 365 }, expect.stringContaining('Pruned stale entries'));
    });

    it('stays quiet when nothing was removed', async () => {
      await run('20 3 * * *');

      expect(logger.info).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('Pruned stale entries'));
    });

    it('does nothing when the model is unavailable', async () => {
      db.YoutubeMetadataCache = undefined;

      await expect(run('20 3 * * *')).resolves.toBeUndefined();
    });

    it('logs and carries on when pruning throws', async () => {
      db.YoutubeMetadataCache.destroy.mockRejectedValue(new Error('db down'));

      await run('20 3 * * *');

      expect(logger.error).toHaveBeenCalledWith({ err: expect.any(Error) }, 'Error pruning youtube_metadata_cache');
    });
  });

  describe('task registry behavior', () => {
    it('refuses to start a task that is already running', async () => {
      let release;
      videoDeletionModule.sweepExpiredCachedVideos.mockReturnValue(new Promise((resolve) => { release = resolve; }));
      const first = run('10 2 * * *');

      const second = cronJobs.runTaskNow('strm-cache-expiry');

      expect(second).toEqual({ started: false, reason: 'running' });
      release({ reverted: 0, failed: 0 });
      await first;
    });

    it('skips a scheduled trigger while the same task is running', async () => {
      let release;
      videoDeletionModule.sweepExpiredCachedVideos.mockReturnValue(new Promise((resolve) => { release = resolve; }));
      const first = run('10 2 * * *');

      await run('10 2 * * *');

      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'strm-cache-expiry', trigger: 'scheduled' }), expect.stringContaining('already running'));
      release({ reverted: 0, failed: 0 });
      await first;
    });

    it('reports an unknown task', () => {
      expect(cronJobs.runTaskNow('nope')).toEqual({ started: false, reason: 'unknown' });
    });

    it('reports a next run time for every daily task', () => {
      for (const t of cronJobs.getTasks()) {
        expect(new Date(t.nextRun).getTime()).toBeGreaterThan(Date.now());
      }
    });
  });
});
