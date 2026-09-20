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
const {
  maybeEnqueueCacheDownload,
  forceEnqueueCacheDownload,
  hasActiveCacheJob,
  isFeatureEnabled,
  STRM_CACHE_LABEL_PREFIX,
} = require('../strmCacheOnPlay');

const YT_ID = 'dQw4w9WgXcQ';
const STRM_PATH = path.join('media', 'Channel', 'Some Video [dQw4w9WgXcQ].strm');

function strmVideo(overrides = {}) {
  return {
    youtubeId: YT_ID,
    youTubeVideoName: 'Some Video',
    filePath: STRM_PATH,
    is_strm: true,
    channel_id: 'UC123',
    ...overrides,
  };
}

describe('strmCacheOnPlay', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    configModule.getConfig.mockReturnValue({ strm: { cacheOnPlay: true } });
    jobModule.getAllJobs.mockReturnValue({});
    Video.findOne.mockResolvedValue(strmVideo());
    downloadModule.doSpecificDownloads.mockResolvedValue(undefined);
  });

  describe('isFeatureEnabled', () => {
    it('is enabled only for an explicit true', () => {
      expect(isFeatureEnabled({ strm: { cacheOnPlay: true } })).toBe(true);
    });

    it.each([
      ['false', { strm: { cacheOnPlay: false } }],
      ['a truthy non-boolean', { strm: { cacheOnPlay: 'true' } }],
      ['missing', { strm: {} }],
      ['no strm section', {}],
      ['no config', undefined],
    ])('is disabled when cacheOnPlay is %s', (_label, config) => {
      expect(isFeatureEnabled(config)).toBe(false);
    });
  });

  describe('hasActiveCacheJob', () => {
    const cacheJob = (status, id = YT_ID) => ({ status, jobType: `${STRM_CACHE_LABEL_PREFIX}Some Video [${id}]` });

    it.each(['Pending', 'In Progress'])('finds a %s cache job for the video', (status) => {
      jobModule.getAllJobs.mockReturnValue({ 1: cacheJob(status) });

      expect(hasActiveCacheJob(YT_ID)).toBe(true);
    });

    it.each(['Complete', 'Failed', 'Terminated'])('ignores a %s cache job', (status) => {
      jobModule.getAllJobs.mockReturnValue({ 1: cacheJob(status) });

      expect(hasActiveCacheJob(YT_ID)).toBe(false);
    });

    it('ignores a cache job for a different video', () => {
      jobModule.getAllJobs.mockReturnValue({ 1: cacheJob('Pending', 'otherVideo1') });

      expect(hasActiveCacheJob(YT_ID)).toBe(false);
    });

    it('ignores an active job that is not a STRM cache job', () => {
      jobModule.getAllJobs.mockReturnValue({ 1: { status: 'Pending', jobType: `Channel Downloads [${YT_ID}]` } });

      expect(hasActiveCacheJob(YT_ID)).toBe(false);
    });

    it('ignores a job with a non-string jobType', () => {
      jobModule.getAllJobs.mockReturnValue({ 1: { status: 'Pending', jobType: null } });

      expect(hasActiveCacheJob(YT_ID)).toBe(false);
    });

    it('is false when there are no jobs at all', () => {
      expect(hasActiveCacheJob(YT_ID)).toBe(false);
    });
  });

  describe('forceEnqueueCacheDownload', () => {
    it('enqueues a download for a STRM video', async () => {
      await expect(forceEnqueueCacheDownload(YT_ID)).resolves.toEqual({ queued: true });
    });

    it('works even when cacheOnPlay is disabled', async () => {
      configModule.getConfig.mockReturnValue({ strm: { cacheOnPlay: false } });

      await expect(forceEnqueueCacheDownload(YT_ID)).resolves.toEqual({ queued: true });
    });

    it('queues the watch URL for the video', async () => {
      await forceEnqueueCacheDownload(YT_ID);

      expect(downloadModule.doSpecificDownloads.mock.calls[0][0].body.urls).toEqual([`https://www.youtube.com/watch?v=${YT_ID}`]);
    });

    it('labels the job with the STRM cache prefix, video name and id', async () => {
      await forceEnqueueCacheDownload(YT_ID);

      expect(downloadModule.doSpecificDownloads.mock.calls[0][0].body.jobLabel).toBe(`${STRM_CACHE_LABEL_PREFIX}Some Video [${YT_ID}]`);
    });

    it('labels the job with the id when the video has no name', async () => {
      Video.findOne.mockResolvedValue(strmVideo({ youTubeVideoName: null }));

      await forceEnqueueCacheDownload(YT_ID);

      expect(downloadModule.doSpecificDownloads.mock.calls[0][0].body.jobLabel).toBe(`${STRM_CACHE_LABEL_PREFIX}${YT_ID} [${YT_ID}]`);
    });

    it('forces a real download at a throttled rate', async () => {
      await forceEnqueueCacheDownload(YT_ID);

      expect(downloadModule.doSpecificDownloads.mock.calls[0][0].body.overrideSettings).toEqual({
        mediaMode: 'download',
        ytdlpRateLimitOverride: '3M',
      });
    });

    it('pins the target to the folder and file stem of the existing .strm', async () => {
      await forceEnqueueCacheDownload(YT_ID);

      expect(downloadModule.doSpecificDownloads.mock.calls[0][0].body.strmCacheTarget).toEqual({
        targetDir: path.join('media', 'Channel'),
        fileStem: 'Some Video [dQw4w9WgXcQ]',
      });
    });

    it('passes the video channel id', async () => {
      await forceEnqueueCacheDownload(YT_ID);

      expect(downloadModule.doSpecificDownloads.mock.calls[0][0].body.channelId).toBe('UC123');
    });

    it('omits the channel id when the video has none', async () => {
      Video.findOne.mockResolvedValue(strmVideo({ channel_id: null }));

      await forceEnqueueCacheDownload(YT_ID);

      expect(downloadModule.doSpecificDownloads.mock.calls[0][0].body.channelId).toBeUndefined();
    });

    it.each([
      ['there is no Video row', null],
      ['the video is already a real download', strmVideo({ is_strm: false })],
      ['the video has no file path', strmVideo({ filePath: null })],
    ])('reports not-strm when %s', async (_label, video) => {
      Video.findOne.mockResolvedValue(video);

      await expect(forceEnqueueCacheDownload(YT_ID)).resolves.toEqual({ queued: false, reason: 'not-strm' });
    });

    it('does not enqueue anything for a non-STRM video', async () => {
      Video.findOne.mockResolvedValue(strmVideo({ is_strm: false }));

      await forceEnqueueCacheDownload(YT_ID);

      expect(downloadModule.doSpecificDownloads).not.toHaveBeenCalled();
    });

    it('reports already-queued when a cache job is already active', async () => {
      jobModule.getAllJobs.mockReturnValue({ 1: { status: 'In Progress', jobType: `${STRM_CACHE_LABEL_PREFIX}Some Video [${YT_ID}]` } });

      await expect(forceEnqueueCacheDownload(YT_ID)).resolves.toEqual({ queued: false, reason: 'already-queued' });
    });

    it('reports already-queued for a concurrent call while the first is still enqueuing', async () => {
      let release;
      downloadModule.doSpecificDownloads.mockReturnValue(new Promise((resolve) => { release = resolve; }));

      const first = forceEnqueueCacheDownload(YT_ID);
      const second = await forceEnqueueCacheDownload(YT_ID);
      release();
      await first;

      expect(second).toEqual({ queued: false, reason: 'already-queued' });
    });

    it('allows another enqueue once the first has finished', async () => {
      await forceEnqueueCacheDownload(YT_ID);

      await expect(forceEnqueueCacheDownload(YT_ID)).resolves.toEqual({ queued: true });
    });

    it('reports an error result when the lookup throws', async () => {
      Video.findOne.mockRejectedValue(new Error('db down'));

      await expect(forceEnqueueCacheDownload(YT_ID)).resolves.toEqual({ queued: false, reason: 'error' });
    });

    it('releases the in-flight guard after a failure', async () => {
      Video.findOne.mockRejectedValueOnce(new Error('db down'));
      await forceEnqueueCacheDownload(YT_ID);

      await expect(forceEnqueueCacheDownload(YT_ID)).resolves.toEqual({ queued: true });
    });

    describe('disk space preflight', () => {
      beforeEach(() => {
        configModule.getConfig.mockReturnValue({ strm: { cacheOnPlay: true }, autoRemovalFreeSpaceThreshold: '10GB' });
        configModule.getStorageStatus.mockResolvedValue({ available: 5, availableGB: '5' });
      });

      it('skips with low-disk-space when storage is below the threshold', async () => {
        configModule.isStorageBelowThreshold.mockReturnValue(true);

        await expect(forceEnqueueCacheDownload(YT_ID)).resolves.toEqual({ queued: false, reason: 'low-disk-space' });
      });

      it('does not enqueue when storage is below the threshold', async () => {
        configModule.isStorageBelowThreshold.mockReturnValue(true);

        await forceEnqueueCacheDownload(YT_ID);

        expect(downloadModule.doSpecificDownloads).not.toHaveBeenCalled();
      });

      it('enqueues when storage is above the threshold', async () => {
        configModule.isStorageBelowThreshold.mockReturnValue(false);

        await expect(forceEnqueueCacheDownload(YT_ID)).resolves.toEqual({ queued: true });
      });

      it('compares available space against the configured threshold', async () => {
        configModule.isStorageBelowThreshold.mockReturnValue(false);

        await forceEnqueueCacheDownload(YT_ID);

        expect(configModule.isStorageBelowThreshold).toHaveBeenCalledWith(5, '10GB');
      });

      it('enqueues when storage status is unavailable', async () => {
        configModule.getStorageStatus.mockResolvedValue(null);

        await expect(forceEnqueueCacheDownload(YT_ID)).resolves.toEqual({ queued: true });
      });

      it('does not check storage when no threshold is configured', async () => {
        configModule.getConfig.mockReturnValue({ strm: { cacheOnPlay: true } });

        await forceEnqueueCacheDownload(YT_ID);

        expect(configModule.getStorageStatus).not.toHaveBeenCalled();
      });
    });
  });

  describe('maybeEnqueueCacheDownload', () => {
    it('enqueues when the feature is enabled', async () => {
      await maybeEnqueueCacheDownload(YT_ID);

      expect(downloadModule.doSpecificDownloads).toHaveBeenCalledTimes(1);
    });

    it('does nothing when the feature is disabled', async () => {
      configModule.getConfig.mockReturnValue({ strm: { cacheOnPlay: false } });

      await maybeEnqueueCacheDownload(YT_ID);

      expect(Video.findOne).not.toHaveBeenCalled();
    });

    it('does nothing when skip is requested', async () => {
      await maybeEnqueueCacheDownload(YT_ID, { skip: true });

      expect(Video.findOne).not.toHaveBeenCalled();
    });

    it('does nothing when a cache job is already active', async () => {
      jobModule.getAllJobs.mockReturnValue({ 1: { status: 'Pending', jobType: `${STRM_CACHE_LABEL_PREFIX}Some Video [${YT_ID}]` } });

      await maybeEnqueueCacheDownload(YT_ID);

      expect(downloadModule.doSpecificDownloads).not.toHaveBeenCalled();
    });

    it('enqueues only once for concurrent calls on the same video', async () => {
      let release;
      downloadModule.doSpecificDownloads.mockReturnValue(new Promise((resolve) => { release = resolve; }));

      const first = maybeEnqueueCacheDownload(YT_ID);
      await maybeEnqueueCacheDownload(YT_ID);
      release();
      await first;

      expect(downloadModule.doSpecificDownloads).toHaveBeenCalledTimes(1);
    });

    it('never throws when enqueueing fails', async () => {
      downloadModule.doSpecificDownloads.mockRejectedValue(new Error('queue full'));

      await expect(maybeEnqueueCacheDownload(YT_ID)).resolves.toBeUndefined();
    });

    it('releases the in-flight guard after a failure so the next play can retry', async () => {
      downloadModule.doSpecificDownloads.mockRejectedValueOnce(new Error('queue full'));
      await maybeEnqueueCacheDownload(YT_ID);

      await maybeEnqueueCacheDownload(YT_ID);

      expect(downloadModule.doSpecificDownloads).toHaveBeenCalledTimes(2);
    });
  });
});
