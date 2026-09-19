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
jest.mock('../../modules/nzbDiagnosticLog', () => ({}));
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

const path = require('path');
const nzb = require('../nzb');
const jobModule = require('../../modules/jobModule');
const Video = require('../../models/video');
const { cleanupEmptyParents } = require('../../modules/filesystem');

const buildJob = (categoryName) => ({
  id: 'job-1',
  status: 'Complete',
  data: {
    nzb: { categoryName, youtubeId: 'abc123' },
    videos: [{ id: 7, youtubeId: 'abc123' }],
  },
});

describe('nzb.js handleHistoryDeleteRequest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Video.findOne.mockResolvedValue({ dataValues: { id: 7, youtubeId: 'abc123', filePath: '/data/x.strm' } });
  });

  test('clears the in-memory videos of an untracked job so a later saveJobs pass cannot re-create the row', async () => {
    const job = buildJob('TV');
    jobModule.getJob.mockReturnValue(job);

    await nzb.handleHistoryDeleteRequest(['job-1']);

    expect(job.data.videos).toEqual([]);
  });

  test('leaves the in-memory videos of a hardlink-strategy job alone', async () => {
    const job = buildJob('Keep');
    jobModule.getJob.mockReturnValue(job);

    await nzb.handleHistoryDeleteRequest(['job-1']);

    expect(job.data.videos).toHaveLength(1);
  });

  test('persists the job without re-persisting its videos', async () => {
    const job = buildJob('TV');
    jobModule.getJob.mockReturnValue(job);

    await nzb.handleHistoryDeleteRequest(['job-1']);

    expect(jobModule.saveJobOnly).toHaveBeenCalledWith('job-1', job, { skipVideoPersistence: true });
  });

  test('removes the now-empty folders above an untracked grab file', async () => {
    Video.findOne.mockResolvedValue({
      dataValues: { id: 7, youtubeId: 'abc123', filePath: '/data/__sonarr/chan/Season 2019/ep/x.strm' },
    });
    jobModule.getJob.mockReturnValue(buildJob('TV'));

    await nzb.handleHistoryDeleteRequest(['job-1']);

    expect(cleanupEmptyParents).toHaveBeenCalledWith(
      path.resolve('/data/__sonarr/chan/Season 2019/ep'),
      path.resolve('/data')
    );
  });

  test('does not clean folders for a hardlink-strategy job', async () => {
    jobModule.getJob.mockReturnValue(buildJob('Keep'));

    await nzb.handleHistoryDeleteRequest(['job-1']);

    expect(cleanupEmptyParents).not.toHaveBeenCalled();
  });

  test('does not walk up from a file outside the library root', async () => {
    Video.findOne.mockResolvedValue({
      dataValues: { id: 7, youtubeId: 'abc123', filePath: '/elsewhere/ep/x.strm' },
    });
    jobModule.getJob.mockReturnValue(buildJob('TV'));

    await nzb.handleHistoryDeleteRequest(['job-1']);

    expect(cleanupEmptyParents).not.toHaveBeenCalled();
  });
});
