/* eslint-env jest */

// Exercises the STRM revert / cache-expiry / purge paths against a real temp
// directory (the existing suite mocks fs), so the file renames and unlinks are
// checked for real.

jest.mock('../../logger');

describe('VideoDeletionModule STRM revert, cache expiry and purge', () => {
  const YT_ID = 'abc12345678';

  let fs;
  let os;
  let path;
  let dir;
  let videoDir;
  let mediaPath;
  let strmPath;
  let logger;
  let videoDeletionModule;
  let Video;
  let JobVideo;
  let VideoWatchStatus;
  let archiveModule;
  let m3uGenerator;
  let configValues;
  let sequelize;
  const TRANSACTION = { id: 'tx' };

  const write = (p, content = 'x') => fs.writeFileSync(p, content);
  const exists = (p) => fs.existsSync(p);

  const makeVideo = (overrides = {}) => ({
    id: 1,
    youtubeId: YT_ID,
    filePath: mediaPath,
    audioFilePath: null,
    channel_id: 'UC1',
    removed: false,
    is_strm: false,
    update: jest.fn().mockResolvedValue(undefined),
    destroy: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  });

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    fs = require('fs');
    os = require('os');
    path = require('path');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdel-test-'));
    videoDir = path.join(dir, 'Channel', `Channel - Title - ${YT_ID}`);
    fs.mkdirSync(videoDir, { recursive: true });
    mediaPath = path.join(videoDir, `Title [${YT_ID}].mp4`);
    strmPath = path.join(videoDir, `Title [${YT_ID}].strm`);

    configValues = { autoRemovalPreserveStrmFallback: true };
    Video = { findByPk: jest.fn(), findOne: jest.fn(), findAll: jest.fn().mockResolvedValue([]) };
    JobVideo = { destroy: jest.fn().mockResolvedValue(1) };
    VideoWatchStatus = { destroy: jest.fn().mockResolvedValue(1) };
    archiveModule = { removeVideoFromArchive: jest.fn().mockResolvedValue(undefined) };
    m3uGenerator = { generateChannelM3UInBackground: jest.fn() };

    sequelize = { transaction: jest.fn(async (work) => work(TRANSACTION)) };
    jest.doMock('../../db', () => ({ sequelize }));
    jest.doMock('../../models', () => ({ Video, JobVideo, VideoWatchStatus }));
    jest.doMock('../configModule', () => ({ directoryPath: dir, getConfig: jest.fn(() => configValues) }));
    jest.doMock('../archiveModule', () => archiveModule);
    jest.doMock('../m3uGenerator', () => m3uGenerator);

    logger = require('../../logger');
    videoDeletionModule = require('../videoDeletionModule');

    // A cached-from-STRM video: the real file plus the archived STRM backup.
    write(mediaPath, 'big media file');
    write(`${strmPath}.cached`, 'https://example.invalid/stream');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('reverting a cached video to STRM during auto-removal', () => {
    it('removes the media file and restores the STRM placeholder', async () => {
      const video = makeVideo();
      Video.findByPk.mockResolvedValue(video);

      const result = await videoDeletionModule.deleteVideoById(1);

      expect(result).toEqual({ success: true, videoId: 1, channelId: 'UC1', message: 'Reverted to STRM playback (cached file removed)' });
      expect(exists(mediaPath)).toBe(false);
      expect(exists(strmPath)).toBe(true);
      expect(exists(`${strmPath}.cached`)).toBe(false);
    });

    it('points the row back at the STRM file and clears the cached state', async () => {
      const video = makeVideo({ audioFilePath: path.join(videoDir, 'a.mp3') });
      Video.findByPk.mockResolvedValue(video);

      await videoDeletionModule.deleteVideoById(1);

      expect(video.update).toHaveBeenCalledWith({
        filePath: strmPath,
        fileSize: fs.statSync(strmPath).size,
        audioFilePath: null,
        audioFileSize: null,
        is_strm: true,
        removed: false,
        cached_at: null,
        video_resolution: null,
      });
    });

    it('also removes the audio file', async () => {
      const audioPath = path.join(videoDir, `Title [${YT_ID}].mp3`);
      write(audioPath);
      Video.findByPk.mockResolvedValue(makeVideo({ audioFilePath: audioPath }));

      await videoDeletionModule.deleteVideoById(1);

      expect(exists(audioPath)).toBe(false);
    });

    it('tolerates media files that are already gone', async () => {
      fs.unlinkSync(mediaPath);
      Video.findByPk.mockResolvedValue(makeVideo({ audioFilePath: path.join(videoDir, 'missing.mp3') }));

      const result = await videoDeletionModule.deleteVideoById(1);

      expect(result.message).toBe('Reverted to STRM playback (cached file removed)');
    });

    it('restores the archived media-info cache next to the STRM file', async () => {
      write(path.join(videoDir, `Title [${YT_ID}].strmtool.json.cached`), '{"a":1}');
      Video.findByPk.mockResolvedValue(makeVideo());

      await videoDeletionModule.deleteVideoById(1);

      expect(fs.readFileSync(path.join(videoDir, `Title [${YT_ID}].strmtool.json`), 'utf8')).toBe('{"a":1}');
      expect(exists(path.join(videoDir, `Title [${YT_ID}].strmtool.json.cached`))).toBe(false);
    });

    it('forgets the video in the yt-dlp archive so it can be downloaded again', async () => {
      Video.findByPk.mockResolvedValue(makeVideo());

      await videoDeletionModule.deleteVideoById(1);

      expect(archiveModule.removeVideoFromArchive).toHaveBeenCalledWith(YT_ID);
    });

    it('still succeeds when the archive cannot be updated', async () => {
      archiveModule.removeVideoFromArchive.mockRejectedValue(new Error('archive locked'));
      Video.findByPk.mockResolvedValue(makeVideo());

      const result = await videoDeletionModule.deleteVideoById(1);

      expect(result.success).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ youtubeId: YT_ID }), expect.stringContaining('Failed to remove reverted video from yt-dlp archive'));
    });

    it('skips the archive when the video has no YouTube id in its row', async () => {
      const result = await videoDeletionModule._tryRevertToStrm(makeVideo({ youtubeId: null }));

      expect(result.success).toBe(true);
      expect(archiveModule.removeVideoFromArchive).not.toHaveBeenCalled();
    });

    it('does not revert when the fallback is turned off', async () => {
      configValues.autoRemovalPreserveStrmFallback = false;
      const video = makeVideo();
      Video.findByPk.mockResolvedValue(video);

      const result = await videoDeletionModule.deleteVideoById(1);

      expect(result.message).toBe('Video deleted successfully');
      expect(video.update).toHaveBeenCalledWith({ removed: true });
    });

    it('deletes normally when there is no STRM backup', async () => {
      fs.unlinkSync(`${strmPath}.cached`);
      const video = makeVideo();
      Video.findByPk.mockResolvedValue(video);

      const result = await videoDeletionModule.deleteVideoById(1);

      expect(result.message).toBe('Video deleted successfully');
      expect(exists(videoDir)).toBe(false);
    });

    it('falls back to normal deletion when the revert fails partway', async () => {
      // A directory in the way of the restored .strm makes the rename fail.
      fs.mkdirSync(strmPath);
      write(path.join(strmPath, 'blocker'));
      const video = makeVideo();
      Video.findByPk.mockResolvedValue(video);

      const result = await videoDeletionModule.deleteVideoById(1);

      expect(result.message).toBe('Video deleted successfully');
      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ videoId: 1 }), expect.stringContaining('Revert-to-STRM failed'));
    });
  });

  describe('revertToStrm (explicit)', () => {
    it('reverts a cached video', async () => {
      Video.findByPk.mockResolvedValue(makeVideo());

      const result = await videoDeletionModule.revertToStrm(1);

      expect(result.success).toBe(true);
      expect(exists(strmPath)).toBe(true);
    });

    it('ignores the auto-removal fallback setting', async () => {
      configValues.autoRemovalPreserveStrmFallback = false;
      Video.findByPk.mockResolvedValue(makeVideo());

      const result = await videoDeletionModule.revertToStrm(1);

      expect(result.success).toBe(true);
    });

    it.each([
      ['does not exist', null, 'Video not found in database'],
      ['is already removed', { removed: true }, 'Video is already marked as removed'],
      ['is already STRM', { is_strm: true }, 'Video is already STRM'],
      ['has no file path', { filePath: null }, 'Video has no file path'],
    ])('refuses a video that %s', async (_label, overrides, error) => {
      Video.findByPk.mockResolvedValue(overrides === null ? null : makeVideo(overrides));

      const result = await videoDeletionModule.revertToStrm(1);

      expect(result).toEqual({ success: false, videoId: 1, error });
    });

    it('keeps the media file and the STRM backup when restoring the media-info cache fails', async () => {
      write(path.join(videoDir, `Title [${YT_ID}].strmtool.json.cached`), '{"a":1}');
      // A directory where the restored media-info cache belongs makes that rename fail.
      const cachePath = path.join(videoDir, `Title [${YT_ID}].strmtool.json`);
      fs.mkdirSync(cachePath);
      write(path.join(cachePath, 'blocker'));
      Video.findByPk.mockResolvedValue(makeVideo());

      const result = await videoDeletionModule.revertToStrm(1);

      expect(result.success).toBe(false);
      expect(exists(mediaPath)).toBe(true);
      expect(exists(`${strmPath}.cached`)).toBe(true);
      expect(exists(strmPath)).toBe(false);
    });

    it('puts the STRM backup back when the media file cannot be deleted', async () => {
      // A directory in place of the media file makes the unlink fail.
      fs.unlinkSync(mediaPath);
      fs.mkdirSync(mediaPath);
      write(path.join(mediaPath, 'blocker'));
      const video = makeVideo();
      Video.findByPk.mockResolvedValue(video);

      const result = await videoDeletionModule.revertToStrm(1);

      expect(result.success).toBe(false);
      expect(exists(`${strmPath}.cached`)).toBe(true);
      expect(exists(strmPath)).toBe(false);
      expect(video.update).not.toHaveBeenCalled();
    });

    it('explains when the video was never STRM', async () => {
      fs.unlinkSync(`${strmPath}.cached`);
      Video.findByPk.mockResolvedValue(makeVideo());

      const result = await videoDeletionModule.revertToStrm(1);

      expect(result.success).toBe(false);
      expect(result.error).toContain('was not originally STRM');
      expect(exists(mediaPath)).toBe(true);
    });
  });

  describe('reconcileRemovedCachedVideo', () => {
    it('does nothing for a row without a file path', async () => {
      await expect(videoDeletionModule.reconcileRemovedCachedVideo(makeVideo({ filePath: null }))).resolves.toBeNull();
    });

    it('restores STRM playback when a backup is still there', async () => {
      const result = await videoDeletionModule.reconcileRemovedCachedVideo(makeVideo());

      expect(result.success).toBe(true);
      expect(exists(strmPath)).toBe(true);
    });

    it('returns null when there is nothing to restore', async () => {
      fs.unlinkSync(`${strmPath}.cached`);

      await expect(videoDeletionModule.reconcileRemovedCachedVideo(makeVideo())).resolves.toBeNull();
    });
  });

  describe('sweepExpiredCachedVideos', () => {
    const NOW = 1_800_000_000_000;

    beforeEach(() => {
      jest.spyOn(Date, 'now').mockReturnValue(NOW);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it.each([[undefined], [0], [-3], ['abc']])('does nothing when the expiry is %p', async (hours) => {
      configValues.strm = { cacheOnPlayExpiryHours: hours };

      const result = await videoDeletionModule.sweepExpiredCachedVideos();

      expect(result.reverted).toBe(0);
      expect(result.failed).toBe(0);
      expect(Video.findAll).not.toHaveBeenCalled();
    });

    it('selects cached, still-present videos older than the expiry', async () => {
      configValues.strm = { cacheOnPlayExpiryHours: 24 };

      await videoDeletionModule.sweepExpiredCachedVideos();

      const { where } = Video.findAll.mock.calls[0][0];
      const { Op } = require('sequelize');
      expect(where.is_strm).toBe(false);
      expect(where.removed).toBe(false);
      expect(where.cached_at[Op.lt]).toEqual(new Date(NOW - 24 * 60 * 60 * 1000));
    });

    it('reverts each expired video and reports the counts', async () => {
      configValues.strm = { cacheOnPlayExpiryHours: 24 };
      Video.findAll.mockResolvedValue([makeVideo()]);

      const result = await videoDeletionModule.sweepExpiredCachedVideos();

      expect(result).toEqual({ success: true, reverted: 1, failed: 0, skipped: 0, thresholdHours: 24 });
    });

    it('skips a video with no STRM backup quietly instead of failing it every night', async () => {
      configValues.strm = { cacheOnPlayExpiryHours: 24 };
      fs.unlinkSync(`${strmPath}.cached`);
      Video.findAll.mockResolvedValue([makeVideo()]);

      const result = await videoDeletionModule.sweepExpiredCachedVideos();

      expect(result).toMatchObject({ reverted: 0, failed: 0, skipped: 1 });
      expect(logger.warn).not.toHaveBeenCalled();
      expect(exists(mediaPath)).toBe(true);
    });

    it('still counts and logs a revert that fails although a backup exists', async () => {
      configValues.strm = { cacheOnPlayExpiryHours: 24 };
      // A directory in the way of the restored .strm makes the rename fail.
      fs.mkdirSync(strmPath);
      write(path.join(strmPath, 'blocker'));
      Video.findAll.mockResolvedValue([makeVideo()]);

      const result = await videoDeletionModule.sweepExpiredCachedVideos();

      expect(result).toMatchObject({ reverted: 0, failed: 1, skipped: 0 });
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ youtubeId: YT_ID }), expect.stringContaining('[Cache Expiry] Failed to revert'));
    });

    it('logs a summary only when something was swept', async () => {
      configValues.strm = { cacheOnPlayExpiryHours: 24 };

      await videoDeletionModule.sweepExpiredCachedVideos();

      expect(logger.info).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('Swept expired'));
    });
  });

  describe('deleteVideoById safety checks', () => {
    it('refuses a path that does not contain the YouTube id', async () => {
      const video = makeVideo({ filePath: path.join(dir, 'Other Channel', 'unrelated-name.mp4') });
      Video.findByPk.mockResolvedValue(video);

      const result = await videoDeletionModule.deleteVideoById(1);

      expect(result).toEqual({ success: false, videoId: 1, error: 'Safety check failed: invalid file path' });
      expect(video.update).not.toHaveBeenCalled();
    });
  });

  describe('purgeVideoById', () => {
    it('removes the job links, watch status and the row itself', async () => {
      const video = makeVideo({ removed: true });
      Video.findByPk.mockResolvedValue(video);

      const result = await videoDeletionModule.purgeVideoById(1);

      expect(result).toEqual({ success: true, videoId: 1, channelId: 'UC1' });
      expect(JobVideo.destroy).toHaveBeenCalledWith(expect.objectContaining({ where: { video_id: 1 } }));
      expect(VideoWatchStatus.destroy).toHaveBeenCalledWith(expect.objectContaining({ where: { video_id: 1 } }));
      expect(video.destroy).toHaveBeenCalled();
    });

    it('deletes all three rows inside one transaction', async () => {
      const video = makeVideo({ removed: true });
      Video.findByPk.mockResolvedValue(video);

      await videoDeletionModule.purgeVideoById(1);

      expect(sequelize.transaction).toHaveBeenCalledTimes(1);
      expect(JobVideo.destroy).toHaveBeenCalledWith({ where: { video_id: 1 }, transaction: TRANSACTION });
      expect(VideoWatchStatus.destroy).toHaveBeenCalledWith({ where: { video_id: 1 }, transaction: TRANSACTION });
      expect(video.destroy).toHaveBeenCalledWith({ transaction: TRANSACTION });
    });

    it('fails without touching the archive when the video row cannot be deleted', async () => {
      const video = makeVideo({ removed: true });
      video.destroy.mockRejectedValue(new Error('locked'));
      Video.findByPk.mockResolvedValue(video);

      const result = await videoDeletionModule.purgeVideoById(1);

      expect(result).toEqual({ success: false, videoId: 1, error: 'locked' });
      expect(archiveModule.removeVideoFromArchive).not.toHaveBeenCalled();
    });

    it('removes dependent rows before the video row', async () => {
      const order = [];
      JobVideo.destroy.mockImplementation(async () => { order.push('jobVideo'); });
      VideoWatchStatus.destroy.mockImplementation(async () => { order.push('watchStatus'); });
      const video = makeVideo({ removed: true, destroy: jest.fn(async () => { order.push('video'); }) });
      Video.findByPk.mockResolvedValue(video);

      await videoDeletionModule.purgeVideoById(1);

      expect(order).toEqual(['jobVideo', 'watchStatus', 'video']);
    });

    it('forgets the video in the yt-dlp archive', async () => {
      Video.findByPk.mockResolvedValue(makeVideo({ removed: true }));

      await videoDeletionModule.purgeVideoById(1);

      expect(archiveModule.removeVideoFromArchive).toHaveBeenCalledWith(YT_ID);
    });

    it('skips the archive for a row without a YouTube id', async () => {
      Video.findByPk.mockResolvedValue(makeVideo({ removed: true, youtubeId: null }));

      await videoDeletionModule.purgeVideoById(1);

      expect(archiveModule.removeVideoFromArchive).not.toHaveBeenCalled();
    });

    it('still succeeds when the archive cannot be updated', async () => {
      archiveModule.removeVideoFromArchive.mockRejectedValue(new Error('locked'));
      Video.findByPk.mockResolvedValue(makeVideo({ removed: true }));

      const result = await videoDeletionModule.purgeVideoById(1);

      expect(result.success).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ videoId: 1, youtubeId: YT_ID }), 'Failed to remove purged video from yt-dlp archive');
    });

    it('refuses a video that does not exist', async () => {
      Video.findByPk.mockResolvedValue(null);

      await expect(videoDeletionModule.purgeVideoById(1)).resolves.toEqual({ success: false, videoId: 1, error: 'Video not found in database' });
    });

    it('refuses a video that is still present on disk', async () => {
      const video = makeVideo({ removed: false });
      Video.findByPk.mockResolvedValue(video);

      const result = await videoDeletionModule.purgeVideoById(1);

      expect(result.error).toBe('Video is not marked as missing from disk; use Delete instead');
      expect(video.destroy).not.toHaveBeenCalled();
    });

    it('reports the reason when the delete fails', async () => {
      JobVideo.destroy.mockRejectedValue(new Error('FK violation'));
      Video.findByPk.mockResolvedValue(makeVideo({ removed: true }));

      const result = await videoDeletionModule.purgeVideoById(1);

      expect(result).toEqual({ success: false, videoId: 1, error: 'FK violation' });
      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ videoId: 1 }), 'Error purging video');
    });

    it('uses a generic message when the error has none', async () => {
      Video.findByPk.mockRejectedValue(new Error(''));

      const result = await videoDeletionModule.purgeVideoById(1);

      expect(result.error).toBe('Unknown error occurred');
    });
  });

  describe('purgeVideos', () => {
    it('purges every video and regenerates playlists for the affected channels', async () => {
      Video.findByPk
        .mockResolvedValueOnce(makeVideo({ id: 1, removed: true, channel_id: 'UCa' }))
        .mockResolvedValueOnce(makeVideo({ id: 2, removed: true, channel_id: 'UCb' }));

      const result = await videoDeletionModule.purgeVideos([1, 2]);

      expect(result).toEqual({ success: true, purged: [1, 2], failed: [] });
      expect(m3uGenerator.generateChannelM3UInBackground).toHaveBeenCalledTimes(2);
    });

    it('reports the videos that could not be purged', async () => {
      Video.findByPk
        .mockResolvedValueOnce(makeVideo({ id: 1, removed: true }))
        .mockResolvedValueOnce(makeVideo({ id: 2, removed: false }))
        .mockResolvedValueOnce(null);

      const result = await videoDeletionModule.purgeVideos([1, 2, 3]);

      expect(result).toEqual({
        success: false,
        purged: [1],
        failed: [
          { videoId: 2, error: 'Video is not marked as missing from disk; use Delete instead' },
          { videoId: 3, error: 'Video not found in database' },
        ],
      });
    });
  });
});
