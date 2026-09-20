/* eslint-env jest */

jest.mock('../../logger');

// updateJob: in-memory merging, completion announcements, the DB recount of a
// finished download job, and the save-failure retry bookkeeping.
describe('JobModule.updateJob', () => {
  const DOWNLOAD = 'Channel Downloads';

  let jobModule;
  let logger;
  let Video;
  let JobVideo;
  let MessageEmitter;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.JOBMODULE_DISABLE_INITIAL_BACKFILL = 'true';

    Video = { findAll: jest.fn().mockResolvedValue([]), findOne: jest.fn().mockResolvedValue(null) };
    JobVideo = { findAll: jest.fn().mockResolvedValue([]) };
    MessageEmitter = { emitMessage: jest.fn() };

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
    jest.doMock('../messageEmitter.js', () => MessageEmitter);
    jest.doMock('../configModule', () => ({ getJobsPath: () => '/jobs', getConfig: () => ({}) }));
    jest.doMock('../../models/job', () => ({ findAll: jest.fn().mockResolvedValue([]), findOne: jest.fn() }));
    jest.doMock('../../models/video', () => Video);
    jest.doMock('../../models/jobvideo', () => JobVideo);
    jest.doMock('../../models/jobvideodownload', () => ({}));
    jest.doMock('../../models/channelvideo', () => ({}));
    jest.doMock('../videoPersistence', () => ({}));
    jest.doMock('../download/downloadCleanup', () => ({ cleanupInProgressVideos: jest.fn().mockResolvedValue() }));
    jest.doMock('../channelVideoReanchor', () => ({}));
    jest.doMock('../strmMaterializer', () => ({ pauseActiveJob: jest.fn(), resumeActiveJob: jest.fn() }));

    logger = require('../../logger');
    jobModule = require('../jobModule');
    jobModule.jobs = {};
    jest.spyOn(jobModule, 'saveJobOnly').mockResolvedValue(undefined);
    jest.spyOn(jobModule, 'saveJobs').mockResolvedValue(undefined);
    jest.spyOn(jobModule, 'scheduleSaveRetry').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.JOBMODULE_DISABLE_INITIAL_BACKFILL;
  });

  const settle = async () => {
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }
  };

  it('warns and does nothing for an unknown job', async () => {
    await jobModule.updateJob('gone', { status: 'Complete' });

    expect(logger.warn).toHaveBeenCalledWith('Job to update did not exist!');
    expect(jobModule.saveJobOnly).not.toHaveBeenCalled();
  });

  it('merges data instead of replacing it so out-of-band fields survive', async () => {
    jobModule.jobs.j1 = { id: 'j1', jobType: DOWNLOAD, status: 'In Progress', data: { nzb: { youtubeId: 'x' } } };

    await jobModule.updateJob('j1', { data: { failedVideos: [1] } });

    expect(jobModule.jobs.j1.data).toEqual({ nzb: { youtubeId: 'x' }, failedVideos: [1] });
  });

  it('creates data when the job had none', async () => {
    jobModule.jobs.j1 = { id: 'j1', jobType: DOWNLOAD, status: 'In Progress' };

    await jobModule.updateJob('j1', { data: { a: 1 } });

    expect(jobModule.jobs.j1.data).toEqual({ a: 1 });
  });

  describe('in-progress updates', () => {
    it('saves through saveJobs', async () => {
      jobModule.jobs.j1 = { id: 'j1', jobType: DOWNLOAD, status: 'Pending' };

      await jobModule.updateJob('j1', { status: 'In Progress' });

      expect(jobModule.saveJobs).toHaveBeenCalledTimes(1);
      expect(jobModule.saveJobOnly).not.toHaveBeenCalled();
    });

    it('logs a failed save without throwing', async () => {
      jobModule.saveJobs.mockRejectedValue(new Error('db down'));
      jobModule.jobs.j1 = { id: 'j1', jobType: DOWNLOAD, status: 'Pending' };

      await jobModule.updateJob('j1', { status: 'In Progress' });
      await settle();

      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'j1' }), 'Failed to save in-progress job');
    });
  });

  describe('finishing a download job', () => {
    const finish = async (status, extra = {}) => {
      jobModule.jobs.j1 = { id: 'j1', jobType: DOWNLOAD, status: 'In Progress' };
      await jobModule.updateJob('j1', { status, data: { videos: [{ id: 1 }, { id: 2 }] }, ...extra });
      return jobModule.jobs.j1;
    };

    it('announces completion with the videos it was given', async () => {
      await finish('Complete');

      expect(MessageEmitter.emitMessage).toHaveBeenCalledWith('broadcast', null, 'download', 'downloadComplete', { text: 'Download job completed.', videos: [{ id: 1 }, { id: 2 }] });
    });

    it('announces completion with no videos when there are none', async () => {
      jobModule.jobs.j1 = { id: 'j1', jobType: DOWNLOAD };

      await jobModule.updateJob('j1', { status: 'Terminated' });

      expect(MessageEmitter.emitMessage.mock.calls[0][4].videos).toEqual([]);
    });

    it('writes the video count as the output of a successful job', async () => {
      const job = await finish('Complete');

      expect(job.output).toBe('2 videos.');
      expect(job.status).toBe('Complete');
    });

    it('keeps the warnings status', async () => {
      const job = await finish('Complete with Warnings');

      expect(job.status).toBe('Complete with Warnings');
    });

    it.each(['Error', 'Terminated'])('leaves the output and status of a %s job alone', async (status) => {
      const job = await finish(status, { output: 'custom output' });

      expect(job.status).toBe(status);
      expect(job.output).toBe('custom output');
    });

    it('recounts the videos from the database', async () => {
      JobVideo.findAll.mockResolvedValue([{ video_id: 1 }, { video_id: 2 }, { video_id: 3 }]);
      Video.findOne
        .mockResolvedValueOnce({ dataValues: { id: 1 } })
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ dataValues: { id: 3 } });

      const job = await finish('Complete');

      expect(job.data.videos).toEqual([{ id: 1 }, { id: 3 }]);
      expect(job.output).toBe('2 videos.');
      expect(JobVideo.findAll).toHaveBeenCalledWith({ where: { job_id: 'j1' } });
    });

    it('keeps the videos it was given when the database has none for the job', async () => {
      JobVideo.findAll.mockResolvedValue([]);

      const job = await finish('Complete', { data: { videos: [{ id: 7 }, { id: 8 }] } });

      expect(job.data.videos).toEqual([{ id: 7 }, { id: 8 }]);
      expect(job.output).toBe('2 videos.');
    });

    it('keeps the videos it was given when the rows exist but their videos are gone', async () => {
      JobVideo.findAll.mockResolvedValue([{ video_id: 1 }]);
      Video.findOne.mockResolvedValue(null);

      const job = await finish('Complete', { data: { videos: [{ id: 7 }] } });

      expect(job.data.videos).toEqual([{ id: 7 }]);
    });

    it('prefers the database list when it found videos', async () => {
      JobVideo.findAll.mockResolvedValue([{ video_id: 1 }]);
      Video.findOne.mockResolvedValue({ dataValues: { id: 1 } });

      const job = await finish('Complete', { data: { videos: [{ id: 7 }, { id: 8 }] } });

      expect(job.data.videos).toEqual([{ id: 1 }]);
      expect(job.output).toBe('1 videos.');
    });

    it('does not overwrite the output of an Error job with the recount', async () => {
      JobVideo.findAll.mockResolvedValue([{ video_id: 1 }]);
      Video.findOne.mockResolvedValue({ dataValues: { id: 1 } });

      const job = await finish('Error', { output: 'failed because' });

      expect(job.output).toBe('failed because');
      expect(job.data.videos).toEqual([{ id: 1 }]);
    });

    it('carries on when the database recount fails', async () => {
      JobVideo.findAll.mockRejectedValue(new Error('db down'));

      await finish('Complete');

      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'j1' }), 'Error loading videos from database for completed job');
      expect(jobModule.saveJobOnly).toHaveBeenCalled();
    });

    it('saves just this job', async () => {
      await finish('Complete');

      expect(jobModule.saveJobOnly).toHaveBeenCalledWith('j1', expect.objectContaining({ id: 'j1' }));
      expect(jobModule.saveJobs).not.toHaveBeenCalled();
    });

    it('marks the job for retry and schedules one when the save fails', async () => {
      jobModule.saveJobOnly.mockRejectedValue(new Error('db down'));

      const job = await finish('Complete');
      await settle();

      expect(job._needsSave).toBe(true);
      expect(job._saveRetries).toBe(1);
      expect(jobModule.scheduleSaveRetry).toHaveBeenCalledWith('j1', 1);
    });

    it('gives up and clears the flags once the retries are used up', async () => {
      jobModule.saveJobOnly.mockRejectedValue(new Error('db down'));
      jobModule.jobs.j1 = { id: 'j1', jobType: DOWNLOAD, _saveRetries: 3 };

      await jobModule.updateJob('j1', { status: 'Complete' });
      await settle();

      expect(jobModule.jobs.j1._needsSave).toBeUndefined();
      expect(jobModule.jobs.j1._saveRetries).toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith({ jobId: 'j1', maxRetries: 3 }, expect.stringContaining('Max retries exceeded'));
      expect(jobModule.scheduleSaveRetry).not.toHaveBeenCalled();
    });
  });

  describe('finishing a job that is not a download', () => {
    it('does not announce a download or rewrite its output', async () => {
      jobModule.jobs.j1 = { id: 'j1', jobType: 'Import Subscriptions', status: 'In Progress', output: 'imported 3' };

      await jobModule.updateJob('j1', { status: 'Complete' });

      expect(MessageEmitter.emitMessage).not.toHaveBeenCalled();
      expect(jobModule.jobs.j1.output).toBe('imported 3');
    });

    it('saves it as a completed job without recounting videos', async () => {
      jobModule.jobs.j1 = { id: 'j1', jobType: 'Import Subscriptions', status: 'In Progress' };
      await settle();
      JobVideo.findAll.mockClear();

      await jobModule.updateJob('j1', { status: 'Complete' });

      expect(jobModule.saveJobOnly).toHaveBeenCalledWith('j1', expect.any(Object));
      expect(JobVideo.findAll).not.toHaveBeenCalled();
    });

    it('treats a killed job as completed', async () => {
      jobModule.jobs.j1 = { id: 'j1', jobType: 'Import Subscriptions', status: 'In Progress' };

      await jobModule.updateJob('j1', { status: 'Killed' });

      expect(jobModule.saveJobOnly).toHaveBeenCalled();
    });
  });
});
