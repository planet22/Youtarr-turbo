/* eslint-env jest */

jest.mock('../../logger');

// The save-retry backoff for completed jobs and the "fresh videos" read path
// (NZB and HLS-buffer backfills) - neither needs a real database.
describe('JobModule save retries and fresh-video backfills', () => {
  let jobModule;
  let logger;
  let Video;
  let YoutubeMetadataCache;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    process.env.JOBMODULE_DISABLE_INITIAL_BACKFILL = 'true';

    Video = { findAll: jest.fn().mockResolvedValue([]) };
    YoutubeMetadataCache = { findAll: jest.fn().mockResolvedValue([]) };

    jest.doMock('uuid', () => ({ v4: () => 'uuid' }));
    jest.doMock('node-cron', () => ({ schedule: jest.fn() }));
    jest.doMock('fs', () => ({
      existsSync: jest.fn(() => false),
      mkdirSync: jest.fn(),
      readFileSync: jest.fn(),
      renameSync: jest.fn(),
      writeFileSync: jest.fn(),
      promises: { readFile: jest.fn(), writeFile: jest.fn(), access: jest.fn(), mkdir: jest.fn(), readdir: jest.fn() },
    }));
    jest.doMock('../messageEmitter.js', () => ({ emitMessage: jest.fn() }));
    jest.doMock('../configModule', () => ({ getJobsPath: () => '/jobs', getConfig: () => ({}) }));
    jest.doMock('../../models/job', () => ({ findAll: jest.fn().mockResolvedValue([]), findOne: jest.fn() }));
    jest.doMock('../../models/video', () => Video);
    jest.doMock('../../models/jobvideo', () => ({}));
    jest.doMock('../../models/jobvideodownload', () => ({}));
    jest.doMock('../../models/channelvideo', () => ({}));
    jest.doMock('../../models/youtubemetadatacache', () => YoutubeMetadataCache);
    jest.doMock('../videoPersistence', () => ({}));
    jest.doMock('../download/downloadCleanup', () => ({ cleanupInProgressVideos: jest.fn().mockResolvedValue() }));
    jest.doMock('../channelVideoReanchor', () => ({}));
    jest.doMock('../strmMaterializer', () => ({ pauseActiveJob: jest.fn(), resumeActiveJob: jest.fn() }));

    logger = require('../../logger');
    jobModule = require('../jobModule');
    jobModule.jobs = {};
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    delete process.env.JOBMODULE_DISABLE_INITIAL_BACKFILL;
  });

  describe('scheduleSaveRetry', () => {
    it('does nothing for a job that no longer exists', () => {
      jobModule.scheduleSaveRetry('gone', 1);

      expect(logger.warn).toHaveBeenCalledWith({ jobId: 'gone' }, 'Cannot schedule retry for missing job');
      expect(jest.getTimerCount()).toBe(0);
    });

    it.each([[1, 1000], [2, 2000], [3, 3000]])('waits %s second(s) before attempt %s', (attempt, delay) => {
      jobModule.jobs.j1 = { id: 'j1' };
      const spy = jest.spyOn(jobModule, 'runSaveRetry').mockResolvedValue(undefined);

      jobModule.scheduleSaveRetry('j1', attempt);
      jest.advanceTimersByTime(delay - 1);
      expect(spy).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);

      expect(spy).toHaveBeenCalledWith('j1', attempt);
    });
  });

  describe('runSaveRetry', () => {
    beforeEach(() => {
      jest.spyOn(jobModule, 'saveJobs').mockResolvedValue(undefined);
      jest.spyOn(jobModule, 'scheduleSaveRetry').mockImplementation(() => {});
    });

    it('skips a job that is no longer in memory', async () => {
      await jobModule.runSaveRetry('gone', 1);

      expect(jobModule.saveJobs).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith({ jobId: 'gone', attempt: 1 }, expect.stringContaining('job no longer exists in memory'));
    });

    it('clears the retry counter once the save succeeded', async () => {
      jobModule.jobs.j1 = { id: 'j1', _saveRetries: 2 };

      await jobModule.runSaveRetry('j1', 2);

      expect(jobModule.jobs.j1._saveRetries).toBeUndefined();
      expect(jobModule.scheduleSaveRetry).not.toHaveBeenCalled();
    });

    it('does nothing more when the save succeeded and no counter was set', async () => {
      jobModule.jobs.j1 = { id: 'j1' };

      await jobModule.runSaveRetry('j1', 1);

      expect(jobModule.scheduleSaveRetry).not.toHaveBeenCalled();
    });

    it('schedules the next attempt when the pending save was not cleared', async () => {
      jobModule.jobs.j1 = { id: 'j1', _needsSave: true, _saveRetries: 1 };

      await jobModule.runSaveRetry('j1', 1);

      expect(jobModule.jobs.j1._saveRetries).toBe(2);
      expect(jobModule.scheduleSaveRetry).toHaveBeenCalledWith('j1', 2);
    });

    it('gives up after the last attempt and clears the flags', async () => {
      jobModule.jobs.j1 = { id: 'j1', _needsSave: true, _saveRetries: 3 };

      await jobModule.runSaveRetry('j1', 3);

      expect(jobModule.jobs.j1._needsSave).toBeUndefined();
      expect(jobModule.jobs.j1._saveRetries).toBeUndefined();
      expect(jobModule.scheduleSaveRetry).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith({ jobId: 'j1', maxRetries: 3 }, expect.stringContaining('Giving up'));
    });

    it('logs a save that throws and still evaluates the pending flag', async () => {
      jobModule.saveJobs.mockRejectedValue(new Error('db down'));
      jobModule.jobs.j1 = { id: 'j1', _needsSave: true };

      await jobModule.runSaveRetry('j1', 1);

      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'j1', attempt: 1 }), expect.stringContaining('Retry attempt for job'));
      expect(jobModule.scheduleSaveRetry).toHaveBeenCalledWith('j1', 2);
    });

    it('warns when the job disappears during the retry', async () => {
      jobModule.jobs.j1 = { id: 'j1', _needsSave: true };
      jobModule.saveJobs.mockImplementation(async () => { delete jobModule.jobs.j1; });

      await jobModule.runSaveRetry('j1', 1);

      expect(logger.warn).toHaveBeenCalledWith({ jobId: 'j1', attempt: 1 }, expect.stringContaining('no longer tracked'));
    });
  });

  describe('getRunningJobsWithFreshVideos', () => {
    const withJobs = (jobs) => jest.spyOn(jobModule, 'getRunningJobs').mockReturnValue(jobs);
    const videoRow = (fields) => ({ ...fields, dataValues: fields });

    it('returns the jobs untouched when nothing needs refreshing', async () => {
      const jobs = [{ id: 'a', data: {} }];
      withJobs(jobs);

      await expect(jobModule.getRunningJobsWithFreshVideos()).resolves.toBe(jobs);
      expect(Video.findAll).not.toHaveBeenCalled();
    });

    it('replaces stale videos with fresh rows by database id', async () => {
      withJobs([{ id: 'a', data: { videos: [{ id: 1, removed: false }, { id: 2 }, { youtubeId: 'no-id' }] } }]);
      Video.findAll.mockResolvedValue([videoRow({ id: 1, removed: true })]);

      const [job] = await jobModule.getRunningJobsWithFreshVideos();

      expect(job.data.videos).toEqual([{ id: 1, removed: true }, { id: 2 }, { youtubeId: 'no-id' }]);
      expect(Video.findAll).toHaveBeenCalledWith({ where: { id: [1, 2] } });
    });

    it('passes through a job whose videos is not an array', async () => {
      const job = { id: 'a', data: { videos: 'oops', nzb: { youtubeId: 'nz1' } } };
      withJobs([job]);
      Video.findAll.mockResolvedValue([]);

      const [result] = await jobModule.getRunningJobsWithFreshVideos();

      expect(result).toBe(job);
    });

    describe('NZB grabs with no videos of their own', () => {
      it('shows the video that already exists in the library', async () => {
        withJobs([{ id: 'a', data: { nzb: { youtubeId: 'nz1' } } }]);
        Video.findAll.mockResolvedValue([videoRow({ id: 9, youtubeId: 'nz1', youTubeVideoName: 'Existing' })]);

        const [job] = await jobModule.getRunningJobsWithFreshVideos();

        expect(job.data.videos).toEqual([{ id: 9, youtubeId: 'nz1', youTubeVideoName: 'Existing' }]);
        expect(Video.findAll).toHaveBeenCalledWith({ where: { youtubeId: ['nz1'] } });
      });

      it('leaves the job alone when the library has no such video', async () => {
        const job = { id: 'a', data: { nzb: { youtubeId: 'nz1' } } };
        withJobs([job]);

        const [result] = await jobModule.getRunningJobsWithFreshVideos();

        expect(result).toBe(job);
      });
    });

    describe('HLS buffer cache jobs with no videos of their own', () => {
      const bufferJob = (info = {}) => ({
        id: 'b',
        data: { hlsBufferCacheInfo: { youtubeId: 'hb1', filePath: '/cache/hb1.ts', fileSize: 500, downloadDurationSeconds: 12, avgDownloadMBps: 3.5, ...info } },
      });

      it('shows a tracked video with the buffer file\'s own path, size and timing', async () => {
        withJobs([bufferJob()]);
        Video.findAll.mockResolvedValue([videoRow({ id: 4, youtubeId: 'hb1', filePath: '/lib/x.strm', fileSize: 1, is_strm: true })]);

        const [job] = await jobModule.getRunningJobsWithFreshVideos();

        expect(job.data.videos[0]).toMatchObject({ id: 4, is_strm: true, filePath: '/cache/hb1.ts', fileSize: 500, downloadDurationSeconds: 12, avgDownloadMBps: 3.5 });
        expect(YoutubeMetadataCache.findAll).not.toHaveBeenCalled();
      });

      it('falls back to the tracked video\'s own values when the buffer info lacks them', async () => {
        withJobs([bufferJob({ filePath: undefined, fileSize: undefined, downloadDurationSeconds: undefined, avgDownloadMBps: undefined })]);
        Video.findAll.mockResolvedValue([videoRow({ id: 4, youtubeId: 'hb1', filePath: '/lib/x.strm', fileSize: 1, downloadDurationSeconds: 7, avgDownloadMBps: 2 })]);

        const [job] = await jobModule.getRunningJobsWithFreshVideos();

        expect(job.data.videos[0]).toMatchObject({ filePath: '/lib/x.strm', fileSize: 1, downloadDurationSeconds: 7, avgDownloadMBps: 2 });
      });

      it('builds an untracked row from the metadata cache for a video with no library row', async () => {
        withJobs([bufferJob()]);
        YoutubeMetadataCache.findAll.mockResolvedValue([{ youtube_id: 'hb1', raw_info_json: JSON.stringify({ title: 'Cached Title', uploader: 'Up', duration: 90 }) }]);

        const [job] = await jobModule.getRunningJobsWithFreshVideos();

        expect(job.data.videos).toEqual([{
          id: null,
          youtubeId: 'hb1',
          youTubeChannelName: 'Up',
          youTubeVideoName: 'Cached Title',
          duration: 90,
          filePath: '/cache/hb1.ts',
          fileSize: 500,
          downloadDurationSeconds: 12,
          avgDownloadMBps: 3.5,
          is_strm: false,
          removed: false,
          isTracked: false,
        }]);
      });

      it('names the channel after the channel field when there is no uploader', async () => {
        withJobs([bufferJob()]);
        YoutubeMetadataCache.findAll.mockResolvedValue([{ youtube_id: 'hb1', raw_info_json: JSON.stringify({ channel: 'Ch' }) }]);

        const [job] = await jobModule.getRunningJobsWithFreshVideos();

        expect(job.data.videos[0].youTubeChannelName).toBe('Ch');
      });

      it('uses the YouTube id as the title when nothing is cached', async () => {
        withJobs([bufferJob({ filePath: undefined, fileSize: undefined })]);

        const [job] = await jobModule.getRunningJobsWithFreshVideos();

        expect(job.data.videos[0]).toMatchObject({ youTubeVideoName: 'hb1', youTubeChannelName: '', duration: null, filePath: null, fileSize: null });
      });

      it('warns and still builds a row when the cached info is not valid JSON', async () => {
        withJobs([bufferJob()]);
        YoutubeMetadataCache.findAll.mockResolvedValue([{ youtube_id: 'hb1', raw_info_json: '{broken' }]);

        const [job] = await jobModule.getRunningJobsWithFreshVideos();

        expect(job.data.videos[0].youTubeVideoName).toBe('hb1');
        expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ youtubeId: 'hb1' }), expect.stringContaining('failed to parse cached raw_info_json'));
      });

      it('handles a cache row with no info blob', async () => {
        withJobs([bufferJob()]);
        YoutubeMetadataCache.findAll.mockResolvedValue([{ youtube_id: 'hb1', raw_info_json: null }]);

        const [job] = await jobModule.getRunningJobsWithFreshVideos();

        expect(job.data.videos[0].youTubeVideoName).toBe('hb1');
      });

      it('only asks the metadata cache about ids with no library row', async () => {
        withJobs([bufferJob(), { id: 'c', data: { hlsBufferCacheInfo: { youtubeId: 'hb2' } } }]);
        Video.findAll.mockResolvedValue([videoRow({ id: 4, youtubeId: 'hb1' })]);

        await jobModule.getRunningJobsWithFreshVideos();

        expect(YoutubeMetadataCache.findAll).toHaveBeenCalledWith({ where: { youtube_id: ['hb2'] } });
      });

      it('leaves a job that already has videos alone', async () => {
        const job = { id: 'd', data: { videos: [{ youtubeId: 'x' }], hlsBufferCacheInfo: { youtubeId: 'hb1' } } };
        withJobs([job]);

        const [result] = await jobModule.getRunningJobsWithFreshVideos();

        expect(result.data.videos).toEqual([{ youtubeId: 'x' }]);
        expect(Video.findAll).not.toHaveBeenCalled();
      });
    });
  });
});
