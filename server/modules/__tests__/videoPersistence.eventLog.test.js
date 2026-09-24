/* eslint-env jest */

jest.mock('../../models/job');
jest.mock('../../models/video');
jest.mock('../../models/jobvideo');
jest.mock('../../models/channelvideo');
jest.mock('../channelVideoReanchor', () => ({
  applyExactDateForGroup: jest.fn().mockResolvedValue(undefined),
  applyExactDateForVideo: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../download/videoMetadataProcessor', () => ({
  processVideoMetadata: jest.fn(),
}));
jest.mock('../strmMediaInfoCache', () => ({
  getMediaInfoCachePath: (p) => `${p}.mediainfo.json`,
}));
jest.mock('../../logger');

const mockFs = { existsSync: jest.fn(), renameSync: jest.fn() };
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: (...args) => mockFs.existsSync(...args),
  renameSync: (...args) => mockFs.renameSync(...args),
}));

// Archiving a STRM sidecar (a real download replaced the .strm) is logged once
// per file actually renamed, tied to the video the caller passes.
describe('videoPersistence STRM archive log entries', () => {
  let videoPersistence;
  let jobEventLog;
  const video = { youtubeId: 'abc123', youTubeVideoName: 'A Title', youTubeChannelName: 'A Channel' };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    mockFs.existsSync.mockReturnValue(true);
    mockFs.renameSync.mockImplementation(() => {});
    jobEventLog = require('../jobEventLog');
    videoPersistence = require('../videoPersistence');
  });

  test('records strm.archived for the STRM file that was renamed', () => {
    videoPersistence._archiveStaleStrmSidecars('/lib/x.strm', video);

    expect(jobEventLog.record).toHaveBeenCalledWith('strm.archived', {
      youtubeId: 'abc123',
      videoTitle: 'A Title',
      channelName: 'A Channel',
      detail: { path: '/lib/x.strm' },
    });
  });

  test('records one event per file archived (the STRM and its media-info cache)', () => {
    videoPersistence._archiveStaleStrmSidecars('/lib/x.strm', video);

    expect(jobEventLog.record).toHaveBeenCalledTimes(2);
  });

  test('records nothing for a file that does not exist', () => {
    mockFs.existsSync.mockReturnValue(false);

    videoPersistence._archiveStaleStrmSidecars('/lib/x.strm', video);

    expect(jobEventLog.record).not.toHaveBeenCalled();
  });

  test('records nothing for a file that could not be renamed', () => {
    mockFs.renameSync.mockImplementation(() => { throw new Error('EACCES'); });

    videoPersistence._archiveStaleStrmSidecars('/lib/x.strm', video);

    expect(jobEventLog.record).not.toHaveBeenCalled();
  });

  test('still archives when no video is given', () => {
    videoPersistence._archiveStaleStrmSidecars('/lib/x.strm');

    expect(mockFs.renameSync).toHaveBeenCalledWith('/lib/x.strm', '/lib/x.strm.cached');
  });
});

// An 'untracked'-strategy NZB grab gets a real Video row too (until Sonarr/
// Radarr's history-delete removes it) - marking it tracked here would make
// every later event in that job's log (strm.created, video.downloaded,
// job.finished, ...) read as "tracked" even though the whole point of the
// strategy is to end up untracked. See server/routes/nzb.js's
// NZB_GRAB_REQUESTED, which already records the correct isTracked: false.
describe('videoPersistence upsertVideoForJob tracked-state bookkeeping', () => {
  let videoPersistence;
  let jobEventLog;
  let Video;
  let JobVideo;
  const video = { youtubeId: 'abc123', youTubeVideoName: 'A Title', youTubeChannelName: 'A Channel' };
  const createdRow = { id: 999, youtubeId: 'abc123', youTubeVideoName: 'A Title', youTubeChannelName: 'A Channel' };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    jobEventLog = require('../jobEventLog');
    videoPersistence = require('../videoPersistence');
    Video = require('../../models/video');
    JobVideo = require('../../models/jobvideo');
    Video.findOne.mockResolvedValue(null);
    Video.create.mockResolvedValue(createdRow);
    JobVideo.findOne.mockResolvedValue(null);
  });

  test('marks a freshly created video tracked for an ordinary job', async () => {
    await videoPersistence.upsertVideoForJob(video, { id: 'job-1', jobType: 'Channel Downloads', data: {} });

    expect(jobEventLog.markTracked).toHaveBeenCalledWith('abc123', true);
  });

  test('marks it untracked for an untracked-strategy NZB grab', async () => {
    await videoPersistence.upsertVideoForJob(video, { id: 'job-1', data: { nzb: { importStrategy: 'untracked' } } });

    expect(jobEventLog.markTracked).toHaveBeenCalledWith('abc123', false);
  });

  test('still marks it tracked for a hardlink-strategy NZB grab', async () => {
    await videoPersistence.upsertVideoForJob(video, { id: 'job-1', data: { nzb: { importStrategy: 'hardlink' } } });

    expect(jobEventLog.markTracked).toHaveBeenCalledWith('abc123', true);
  });

  test('marks it untracked when the untracked strategy is only in a DB row aux_data', async () => {
    const aux_data = JSON.stringify({ nzb: { importStrategy: 'untracked' } });
    await videoPersistence.upsertVideoForJob(video, { id: 'job-1', jobType: 'Sonarr/Radarr: TV [abc123]', aux_data });

    expect(jobEventLog.markTracked).toHaveBeenCalledWith('abc123', false);
  });

  test('still marks it tracked for a job with no nzb data at all', async () => {
    await videoPersistence.upsertVideoForJob(video, { id: 'job-1', data: {} });

    expect(jobEventLog.markTracked).toHaveBeenCalledWith('abc123', true);
  });

  // Regression: a plain object built to carry the tracked-state hint must
  // still carry .id, or this real DB query gets job_id: undefined and
  // Sequelize rejects it - "WHERE parameter 'job_id' has invalid 'undefined'
  // value" - failing the job for every video, not just NZB ones.
  test('links the new video to the real job id, not just the tracked-state hint', async () => {
    await videoPersistence.upsertVideoForJob(video, { id: 'job-1', data: { nzb: { importStrategy: 'untracked' } } });

    expect(JobVideo.create).toHaveBeenCalledWith({ job_id: 'job-1', video_id: 999 });
  });
});
