/* eslint-env jest */

jest.mock('../../logger');
jest.mock('../../models/video', () => ({ findOne: jest.fn() }));
jest.mock('../configModule', () => ({
  getConfig: jest.fn(),
  getStorageStatus: jest.fn(),
  isStorageBelowThreshold: jest.fn(),
}));
jest.mock('../jobModule', () => ({ getAllJobs: jest.fn() }));
jest.mock('../downloadModule', () => ({ doSpecificDownloads: jest.fn() }));

const path = require('path');
const Video = require('../../models/video');
const configModule = require('../configModule');
const jobModule = require('../jobModule');
const downloadModule = require('../downloadModule');
const jobEventLog = require('../jobEventLog');
const { forceEnqueueCacheDownload } = require('../strmCacheOnPlay');

const YT_ID = 'dQw4w9WgXcQ';
const STRM_PATH = path.join('media', 'Channel', 'Some Video [dQw4w9WgXcQ].strm');

describe('strmCacheOnPlay video/events log', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    configModule.getConfig.mockReturnValue({ strm: { cacheOnPlay: true } });
    jobModule.getAllJobs.mockReturnValue({});
    Video.findOne.mockResolvedValue({
      youtubeId: YT_ID, youTubeVideoName: 'Some Video', filePath: STRM_PATH, is_strm: true, channel_id: 'UC123',
    });
    downloadModule.doSpecificDownloads.mockResolvedValue('job-9');
  });

  it('records strm.cache_on_play_queued with the queued job id and the title', async () => {
    await forceEnqueueCacheDownload(YT_ID);

    expect(jobEventLog.record).toHaveBeenCalledWith('strm.cache_on_play_queued', {
      jobId: 'job-9',
      youtubeId: YT_ID,
      videoTitle: 'Some Video',
      detail: { targetDir: path.dirname(STRM_PATH) },
    });
  });

  it('records nothing when the video is not a STRM item', async () => {
    Video.findOne.mockResolvedValue({ youtubeId: YT_ID, filePath: STRM_PATH, is_strm: false });

    await forceEnqueueCacheDownload(YT_ID);

    expect(jobEventLog.record).not.toHaveBeenCalled();
  });

  it('records nothing when the download could not be enqueued', async () => {
    downloadModule.doSpecificDownloads.mockRejectedValue(new Error('queue down'));

    await forceEnqueueCacheDownload(YT_ID).catch(() => {});

    expect(jobEventLog.record).not.toHaveBeenCalled();
  });

  it('leaves the job id out when the enqueue returned none', async () => {
    downloadModule.doSpecificDownloads.mockResolvedValue(undefined);

    await forceEnqueueCacheDownload(YT_ID);

    expect(jobEventLog.record.mock.calls[0][1].jobId).toBeUndefined();
  });
});
