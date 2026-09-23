jest.mock('../../modules/configModule', () => ({
  getConfig: jest.fn(() => ({
    nzb: { categories: [{ name: 'TV', importStrategy: 'untracked' }, { name: 'Keep', importStrategy: 'hardlink' }] },
  })),
  getCookiesPath: jest.fn(() => null),
  directoryPath: '/data',
}));
jest.mock('../../modules/videoSearchModule', () => ({
  SearchCanceledError: class SearchCanceledError extends Error {},
  SearchTimeoutError: class SearchTimeoutError extends Error {},
}));
jest.mock('../../modules/nzbThumbnailProbe', () => ({}));
jest.mock('../../modules/jobModule', () => ({
  getJob: jest.fn(),
  saveJobOnly: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../modules/nzbDiagnosticLog', () => ({
  resolveLogLimit: jest.fn(() => 20),
  recordDiagnosticEvent: jest.fn().mockResolvedValue(undefined),
  getDiagnosticEvents: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../modules/archiveModule', () => ({
  removeVideoFromArchive: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../../models', () => ({
  JobVideo: { destroy: jest.fn().mockResolvedValue(1) },
  VideoWatchStatus: { destroy: jest.fn().mockResolvedValue(0) },
}));
jest.mock('../../models/channelvideo', () => ({}));
jest.mock('../../models/video', () => ({
  findOne: jest.fn(),
  destroy: jest.fn().mockResolvedValue(1),
}));
jest.mock('../../modules/filesystem', () => ({
  cleanupEmptyParents: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../modules/notifications/utils', () => ({ formatBytes: jest.fn() }));
jest.mock('../../modules/download/jobTypes', () => ({ nzbDownloadJobLabel: 'youtarr-nzb' }));

const nzb = require('../nzb');
const jobModule = require('../../modules/jobModule');
const jobEventLog = require('../../modules/jobEventLog');
const Video = require('../../models/video');

const buildJob = (categoryName) => ({
  id: 'job-1',
  status: 'Complete',
  data: {
    nzb: { categoryName, youtubeId: 'abc123', nzbName: 'Celebrity Juice S26E09' },
    videos: [{ id: 7, youtubeId: 'abc123' }],
  },
});

const typesRecorded = () => jobEventLog.record.mock.calls.map(([type]) => type);
const callFor = (type) => jobEventLog.record.mock.calls.find(([t]) => t === type);

describe('nzb.js video/events log', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Video.destroy.mockResolvedValue(1);
    Video.findOne.mockResolvedValue({
      dataValues: {
        id: 7, youtubeId: 'abc123', filePath: '/data/x.strm',
        youTubeVideoName: 'Celebrity Juice S26E09', youTubeChannelName: 'pcrobec',
      },
    });
  });

  describe('history delete of an untracked-strategy grab', () => {
    it('records the history removal then the untrack, in that order', async () => {
      jobModule.getJob.mockReturnValue(buildJob('TV'));

      await nzb.handleHistoryDeleteRequest(['job-1']);

      expect(typesRecorded()).toEqual(['nzb.history_removed', 'nzb.untracked']);
    });

    it('carries the video title and channel on the untrack entry, since the row is gone by then', async () => {
      jobModule.getJob.mockReturnValue(buildJob('TV'));

      await nzb.handleHistoryDeleteRequest(['job-1']);

      expect(callFor('nzb.untracked')[1]).toMatchObject({
        jobId: 'job-1', youtubeId: 'abc123', videoTitle: 'Celebrity Juice S26E09', channelName: 'pcrobec',
      });
    });

    it('says the video is no longer tracked, since its library row was just deleted', async () => {
      jobModule.getJob.mockReturnValue(buildJob('TV'));

      await nzb.handleHistoryDeleteRequest(['job-1']);

      expect(callFor('nzb.untracked')[1].isTracked).toBe(false);
    });

    it('offers the NZB name only as a provisional title on the history-removed entry', async () => {
      jobModule.getJob.mockReturnValue(buildJob('TV'));

      await nzb.handleHistoryDeleteRequest(['job-1']);

      expect(callFor('nzb.history_removed')[1]).toMatchObject({ provisionalTitle: 'Celebrity Juice S26E09' });
      expect(callFor('nzb.history_removed')[1].videoTitle).toBeUndefined();
    });

    it('names the trigger and the destroyed row counts in the untrack detail', async () => {
      jobModule.getJob.mockReturnValue(buildJob('TV'));

      await nzb.handleHistoryDeleteRequest(['job-1']);

      expect(callFor('nzb.untracked')[1].detail).toEqual({
        trigger: 'Sonarr/Radarr history delete',
        counts: { jobVideoCount: 1, watchStatusCount: 0, videoCount: 1 },
      });
    });

    it('records nzb.untrack_failed with the error when removing the rows throws', async () => {
      Video.destroy.mockRejectedValue(new Error('db down'));
      jobModule.getJob.mockReturnValue(buildJob('TV'));

      await nzb.handleHistoryDeleteRequest(['job-1']);

      expect(callFor('nzb.untrack_failed')[1].detail).toMatchObject({ error: 'db down' });
    });

    it('does not record an untrack when removing the rows throws', async () => {
      Video.destroy.mockRejectedValue(new Error('db down'));
      jobModule.getJob.mockReturnValue(buildJob('TV'));

      await nzb.handleHistoryDeleteRequest(['job-1']);

      expect(typesRecorded()).not.toContain('nzb.untracked');
    });
  });

  describe('history delete of a hardlink-strategy grab', () => {
    it('records only the history removal, since the library video is left alone', async () => {
      jobModule.getJob.mockReturnValue(buildJob('Keep'));

      await nzb.handleHistoryDeleteRequest(['job-1']);

      expect(typesRecorded()).toEqual(['nzb.history_removed']);
    });

    it('stamps the history removal with the same time the job records', async () => {
      const job = buildJob('Keep');
      jobModule.getJob.mockReturnValue(job);

      await nzb.handleHistoryDeleteRequest(['job-1']);

      expect(callFor('nzb.history_removed')[1].occurredAt).toBe(job.data.nzb.historyRemovedAt);
    });
  });

  describe('a grab that produced no video', () => {
    const failedJob = (id) => ({
      id,
      status: 'Complete',
      timeInitiated: Date.now(),
      data: { nzb: { categoryName: 'Keep', youtubeId: 'abc123', nzbName: 'Celebrity Juice S26E09' }, videos: [] },
    });

    beforeEach(() => {
      Video.findOne.mockResolvedValue(null);
    });

    it('never writes to the log just because a status was read', async () => {
      await nzb.computeNzbStatusDetail(failedJob('fail-1'));
      await nzb.computeNzbStatusDetail(failedJob('fail-2'));

      expect(jobEventLog.record).not.toHaveBeenCalled();
    });

    it('still reports a grab with no video as failed', async () => {
      await expect(nzb.computeNzbStatusDetail(failedJob('fail-3'))).resolves.toBe('Failed - no video produced');
    });

    it('does not report an imported, untracked grab as failed just because its video row is gone', async () => {
      const job = failedJob('imported-1');
      job.data.nzb.untracked = true;
      job.data.nzb.importStrategy = 'untracked';

      await expect(nzb.computeNzbStatusDetail(job)).resolves.toMatch(/Imported by Sonarr\/Radarr/);
    });

    it('records nothing when the video was produced', async () => {
      const job = failedJob('ok-1');
      job.data.videos = [{ id: 7, youtubeId: 'abc123', filePath: '/data/x.strm' }];

      await nzb.computeNzbStatusDetail(job);

      expect(typesRecorded()).not.toContain('nzb.grab_failed');
    });
  });

  it('records nothing for a job that is not an NZB grab', async () => {
    jobModule.getJob.mockReturnValue({ id: 'job-1', status: 'Complete', data: { videos: [] } });

    await nzb.handleHistoryDeleteRequest(['job-1']);

    expect(jobEventLog.record).not.toHaveBeenCalled();
  });

  describe('reconcileMovedUntrackedVideo', () => {
    const { JobVideo } = require('../../models');
    let Job;

    beforeEach(() => {
      Job = { findAll: jest.fn() };
      // reconcileMovedUntrackedVideo pulls Job from the models barrel
      require('../../models').Job = Job;
      JobVideo.findAll = jest.fn().mockResolvedValue([{ job_id: 'job-1' }]);
      require('../../models').VideoWatchStatus.destroy.mockResolvedValue(0);
      Video.findByPk = jest.fn().mockResolvedValue(null);
      const aux = JSON.stringify({ nzb: { categoryName: 'TV' } });
      Job.findAll.mockResolvedValue([{ id: 'job-1', aux_data: aux }]);
      jobModule.getJob.mockReturnValue(buildJob('TV'));
    });

    it('records nzb.untracked with the moved-away trigger and the video snapshot', async () => {
      await nzb.reconcileMovedUntrackedVideo({
        id: 7, youtubeId: 'abc123', filePath: '/data/x.strm', youTubeVideoName: 'A Title', youTubeChannelName: 'A Channel',
      });

      expect(callFor('nzb.untracked')[1]).toMatchObject({
        jobId: 'job-1',
        youtubeId: 'abc123',
        videoTitle: 'A Title',
        channelName: 'A Channel',
        detail: { trigger: 'file moved away by Sonarr/Radarr (no history-delete call received)' },
      });
    });

    it('records nothing when no associated job uses the untracked strategy', async () => {
      Job.findAll.mockResolvedValue([{ id: 'job-1', aux_data: JSON.stringify({ nzb: { categoryName: 'Keep' } }) }]);

      await nzb.reconcileMovedUntrackedVideo({ id: 7, youtubeId: 'abc123', filePath: '/data/x.strm' });

      expect(jobEventLog.record).not.toHaveBeenCalled();
    });

    it('records nothing when the video row was not actually removed', async () => {
      Video.destroy.mockResolvedValue(0);

      await nzb.reconcileMovedUntrackedVideo({ id: 7, youtubeId: 'abc123', filePath: '/data/x.strm' });

      expect(jobEventLog.record).not.toHaveBeenCalled();
    });
  });
});
