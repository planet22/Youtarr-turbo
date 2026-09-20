/* eslint-env jest */

jest.mock('../../logger');

// Video/events log instrumentation in JobModule: which status changes become
// log entries, and that the entry carries the facts frozen at that moment.
describe('JobModule video/events log', () => {
  const DOWNLOAD = 'Channel Downloads';

  let jobModule;
  let jobEventLog;
  let Job;
  let JobVideo;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.JOBMODULE_DISABLE_INITIAL_BACKFILL = 'true';

    Job = {
      findAll: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue([1]),
      destroy: jest.fn().mockResolvedValue(1),
    };
    JobVideo = { findAll: jest.fn().mockResolvedValue([]), destroy: jest.fn().mockResolvedValue(0) };

    jest.doMock('uuid', () => ({ v4: () => 'uuid-1' }));
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
    jest.doMock('../../models/job', () => Job);
    jest.doMock('../../models/video', () => ({ findAll: jest.fn().mockResolvedValue([]), findOne: jest.fn().mockResolvedValue(null) }));
    jest.doMock('../../models/jobvideo', () => JobVideo);
    jest.doMock('../../models/jobvideodownload', () => ({
      findAll: jest.fn().mockResolvedValue([]),
      destroy: jest.fn().mockResolvedValue(0),
    }));
    jest.doMock('../../models/channelvideo', () => ({}));
    jest.doMock('../videoPersistence', () => ({}));
    jest.doMock('../download/downloadCleanup', () => ({ cleanupInProgressVideos: jest.fn().mockResolvedValue() }));
    jest.doMock('../channelVideoReanchor', () => ({}));
    jest.doMock('../strmMaterializer', () => ({ pauseActiveJob: jest.fn(), resumeActiveJob: jest.fn() }));

    jobEventLog = require('../jobEventLog');
    jobModule = require('../jobModule');
    jobModule.jobs = {};
    jest.spyOn(jobModule, 'saveJobOnly').mockResolvedValue(undefined);
    jest.spyOn(jobModule, 'saveJobs').mockResolvedValue(undefined);
    jest.spyOn(jobModule, 'scheduleSaveRetry').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.JOBMODULE_DISABLE_INITIAL_BACKFILL;
  });

  const recordedTypes = () => jobEventLog.record.mock.calls.map(([type]) => type);
  const callsOf = (type) => jobEventLog.record.mock.calls.filter(([t]) => t === type);

  describe('addJob', () => {
    it('records job.created with the initial status', async () => {
      await jobModule.addJob({ jobType: DOWNLOAD, status: 'Pending' });

      expect(jobEventLog.record).toHaveBeenCalledWith('job.created', {
        jobId: 'uuid-1', jobType: DOWNLOAD, detail: { status: 'Pending' },
      });
    });

    it('does not record job.started for a queued job', async () => {
      await jobModule.addJob({ jobType: DOWNLOAD, status: 'Pending' });

      expect(recordedTypes()).not.toContain('job.started');
    });

    it('also records job.started when the job begins In Progress', async () => {
      await jobModule.addJob({ jobType: DOWNLOAD, status: 'In Progress' });

      expect(recordedTypes()).toEqual(['job.created', 'job.started']);
    });

    it('records nothing when saving the job fails', async () => {
      Job.create.mockRejectedValueOnce(new Error('db down'));

      await expect(jobModule.addJob({ jobType: DOWNLOAD, status: 'Pending' })).rejects.toThrow('db down');
      expect(jobEventLog.record).not.toHaveBeenCalled();
    });
  });

  describe('single-video jobs', () => {
    const NZB_JOB = { jobType: 'Sonarr/Radarr: TV [abc]', status: 'Pending', data: { nzb: { youtubeId: 'abc', nzbName: 'Celebrity Juice S26E09' } } };

    test('ties job.created to the video an NZB grab is for', async () => {
      await jobModule.addJob({ ...NZB_JOB });

      expect(callsOf('job.created')[0][1]).toMatchObject({ youtubeId: 'abc', videoTitle: 'Celebrity Juice S26E09' });
    });

    test('ties job.created to the only URL of a one-video job', async () => {
      await jobModule.addJob({ jobType: 'Manually Added Urls', status: 'Pending', data: { urls: ['https://www.youtube.com/watch?v=WhPpqSPYDoQ'] } });

      expect(callsOf('job.created')[0][1].youtubeId).toBe('WhPpqSPYDoQ');
    });

    test('leaves a multi-video job without a video', async () => {
      await jobModule.addJob({ jobType: 'Channel Downloads', status: 'Pending', data: {} });

      expect(callsOf('job.created')[0][1].youtubeId).toBeUndefined();
    });

    test('ties job.finished to the same video', async () => {
      jobModule.jobs.j1 = { id: 'j1', jobType: 'Sonarr/Radarr: TV [abc]', status: 'In Progress', data: { nzb: { youtubeId: 'abc' } } };

      await jobModule.updateJob('j1', { status: 'Complete' });

      expect(callsOf('job.finished')[0][1].youtubeId).toBe('abc');
    });

    test('remembers the job type so later events can be stamped with it', async () => {
      await jobModule.addJob({ ...NZB_JOB });

      expect(jobEventLog.rememberJob).toHaveBeenCalledWith('uuid-1', 'Sonarr/Radarr: TV [abc]');
    });
  });

  describe('a failed NZB grab', () => {
    const nzbJob = (data = {}) => ({
      id: 'j1', jobType: 'Sonarr/Radarr: TV [abc]', status: 'In Progress',
      data: { nzb: { youtubeId: 'abc', nzbName: 'Celebrity Juice S26E09', categoryName: 'TV' }, ...data },
    });

    test('is recorded once, when the job finishes with no video produced', async () => {
      jobModule.jobs.j1 = nzbJob();

      await jobModule.updateJob('j1', { status: 'Complete' });

      expect(callsOf('nzb.grab_failed')).toHaveLength(1);
    });

    test('carries the video, category and reason', async () => {
      jobModule.jobs.j1 = nzbJob({ failedVideos: [{ error: 'Sign in to confirm you are not a bot' }] });

      await jobModule.updateJob('j1', { status: 'Complete' });

      expect(callsOf('nzb.grab_failed')[0][1]).toMatchObject({
        jobId: 'j1', youtubeId: 'abc', videoTitle: 'Celebrity Juice S26E09',
        detail: { message: 'Sign in to confirm you are not a bot', categoryName: 'TV' },
      });
    });

    test('is not recorded when a video was produced', async () => {
      const Video = require('../../models/video');
      JobVideo.findAll.mockResolvedValue([{ video_id: 1 }]);
      Video.findOne.mockResolvedValue({ dataValues: { id: 1 } });
      jobModule.jobs.j1 = nzbJob();

      await jobModule.updateJob('j1', { status: 'Complete' });

      expect(callsOf('nzb.grab_failed')).toHaveLength(0);
    });

    test('is not recorded when yt-dlp skipped the video because it was already downloaded', async () => {
      jobModule.jobs.j1 = nzbJob({ cumulativeSkipped: 1 });

      await jobModule.updateJob('j1', { status: 'Complete' });

      expect(callsOf('nzb.grab_failed')).toHaveLength(0);
    });

    test('is not recorded for a job that is not an NZB grab', async () => {
      jobModule.jobs.j1 = { id: 'j1', jobType: DOWNLOAD, status: 'In Progress', data: {} };

      await jobModule.updateJob('j1', { status: 'Complete' });

      expect(callsOf('nzb.grab_failed')).toHaveLength(0);
    });

    test('is not recorded again by a later, unrelated update', async () => {
      jobModule.jobs.j1 = nzbJob();
      await jobModule.updateJob('j1', { status: 'Complete' });

      await jobModule.updateJob('j1', { data: { note: 'x' } });

      expect(callsOf('nzb.grab_failed')).toHaveLength(1);
    });
  });

  describe('updateJob status changes', () => {
    it('records job.started when a Pending job flips to In Progress', async () => {
      jobModule.jobs.j1 = { id: 'j1', jobType: DOWNLOAD, status: 'Pending' };

      await jobModule.updateJob('j1', { status: 'In Progress' });

      expect(callsOf('job.started')).toHaveLength(1);
    });

    it('stamps the status change with an explicit occurredAt', async () => {
      jobModule.jobs.j1 = { id: 'j1', jobType: DOWNLOAD, status: 'Pending' };

      await jobModule.updateJob('j1', { status: 'In Progress' });

      expect(callsOf('job.started')[0][1].occurredAt).toBeInstanceOf(Date);
    });

    it('records nothing for a data-only update', async () => {
      jobModule.jobs.j1 = { id: 'j1', jobType: DOWNLOAD, status: 'In Progress' };

      await jobModule.updateJob('j1', { data: { queueOrder: 3 } });

      expect(jobEventLog.record).not.toHaveBeenCalled();
    });

    it('records nothing when the status is set to the value it already has', async () => {
      jobModule.jobs.j1 = { id: 'j1', jobType: DOWNLOAD, status: 'In Progress' };

      await jobModule.updateJob('j1', { status: 'In Progress' });

      expect(jobEventLog.record).not.toHaveBeenCalled();
    });

    it('records job.finished with the final status when a download job completes', async () => {
      jobModule.jobs.j1 = { id: 'j1', jobType: DOWNLOAD, status: 'In Progress' };

      await jobModule.updateJob('j1', { status: 'Complete' });

      expect(callsOf('job.finished')[0][1].detail).toMatchObject({ status: 'Complete', previousStatus: 'In Progress' });
    });

    it('reports the video count after the completed-job reload from the database', async () => {
      JobVideo.findAll.mockResolvedValue([{ video_id: 1 }, { video_id: 2 }]);
      const Video = require('../../models/video');
      Video.findOne.mockImplementation(({ where }) => Promise.resolve({ dataValues: { id: where.id } }));
      jobModule.jobs.j1 = { id: 'j1', jobType: DOWNLOAD, status: 'In Progress' };

      await jobModule.updateJob('j1', { status: 'Complete' });

      expect(callsOf('job.finished')[0][1].detail.videoCount).toBe(2);
    });

    it('carries failed and skipped counts from the job data', async () => {
      jobModule.jobs.j1 = { id: 'j1', jobType: DOWNLOAD, status: 'In Progress' };

      await jobModule.updateJob('j1', {
        status: 'Complete with Warnings',
        data: { failedVideos: [{}, {}], cumulativeSkipped: 4 },
      });

      expect(callsOf('job.finished')[0][1].detail).toMatchObject({ failedCount: 2, skippedCount: 4 });
    });

    it('uses the job output as the reason for an Error status', async () => {
      jobModule.jobs.j1 = { id: 'j1', jobType: DOWNLOAD, status: 'In Progress' };

      await jobModule.updateJob('j1', { status: 'Error', output: 'Output directory is not accessible' });

      expect(callsOf('job.finished')[0][1].detail.reason).toBe('Output directory is not accessible');
    });

    it('prefers the job notes as the reason when present', async () => {
      jobModule.jobs.j1 = { id: 'j1', jobType: DOWNLOAD, status: 'In Progress' };

      await jobModule.updateJob('j1', { status: 'Terminated', output: 'x', data: { notes: 'Stopped by user' } });

      expect(callsOf('job.finished')[0][1].detail.reason).toBe('Stopped by user');
    });

    it('does not use a successful job output as a reason', async () => {
      jobModule.jobs.j1 = { id: 'j1', jobType: DOWNLOAD, status: 'In Progress' };

      await jobModule.updateJob('j1', { status: 'Complete' });

      expect(callsOf('job.finished')[0][1].detail.reason).toBeUndefined();
    });

    it('does not change what updateJob does to the job itself', async () => {
      jobModule.jobs.j1 = { id: 'j1', jobType: DOWNLOAD, status: 'In Progress' };

      await jobModule.updateJob('j1', { status: 'Complete' });

      expect(jobModule.jobs.j1.status).toBe('Complete');
    });
  });

  describe('removePendingJob', () => {
    it('records job.removed for a queued job', async () => {
      jobModule.jobs.j1 = { id: 'j1', jobType: DOWNLOAD, status: 'Pending' };

      await jobModule.removePendingJob('j1');

      expect(jobEventLog.record).toHaveBeenCalledWith('job.removed', { jobId: 'j1', jobType: DOWNLOAD });
    });

    it('records nothing when the job is not pending', async () => {
      jobModule.jobs.j1 = { id: 'j1', jobType: DOWNLOAD, status: 'In Progress' };

      await jobModule.removePendingJob('j1');

      expect(jobEventLog.record).not.toHaveBeenCalled();
    });
  });

  describe('terminateInProgressJobs', () => {
    it('records job.finished Terminated for an interrupted In Progress job', async () => {
      jobModule.jobs.j1 = { id: 'j1', jobType: DOWNLOAD, status: 'In Progress', data: {} };

      await jobModule.terminateInProgressJobs();

      expect(callsOf('job.finished')[0][1].detail).toMatchObject({ status: 'Terminated', previousStatus: 'In Progress' });
    });

    it('records job.finished Terminated for a Pending job dropped at restart', async () => {
      jobModule.jobs.j1 = { id: 'j1', jobType: DOWNLOAD, status: 'Pending', data: {} };

      await jobModule.terminateInProgressJobs();

      expect(callsOf('job.finished')[0][1].detail).toMatchObject({ status: 'Terminated', previousStatus: 'Pending' });
    });

    it('records nothing for jobs that already finished', async () => {
      jobModule.jobs.j1 = { id: 'j1', jobType: DOWNLOAD, status: 'Complete', data: {} };

      await jobModule.terminateInProgressJobs();

      expect(jobEventLog.record).not.toHaveBeenCalled();
    });
  });
});
