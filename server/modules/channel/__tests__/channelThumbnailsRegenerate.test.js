/* eslint-env jest */

const path = require('path');

// Same mocking approach as server/modules/__tests__/channelPoster.test.js:
// mock fs-extra directly and let the real channelThumbnails/fileOperations
// code run against it, so regenerateChannelImages is exercised end to end.
// Paths are built with path.join (not hardcoded forward-slash strings) so
// these pass on both Linux (CI) and Windows (dev) - buildChannelPath uses
// the native path.join internally, which emits backslashes on win32.
jest.mock('fs-extra');
jest.mock('../../configModule');
jest.mock('../../../logger');
jest.mock('../../../models', () => ({ Video: { findAll: jest.fn() } }));
jest.mock('../../download/downloadSettingsResolver', () => ({ resolveFinalLibraryMode: jest.fn() }));

const BASE_DIR = path.join(path.sep, 'videos');
const IMAGE_DIR = path.join(path.sep, 'images');

// Every regenerateChannelImages() call now also runs video-thumbnail
// regeneration (independent of the writeChannelPosters/writeBackdropImages
// flags this file was originally written around), which starts every
// counts object from this zeroed shape. Video.findAll defaults to an empty
// array in beforeEach, so it contributes nothing unless a test opts in.
const ZERO_VIDEO_THUMB_COUNTS = {
  videoThumbsCopied: 0, videoThumbsDownloaded: 0, videoThumbsSkipped: 0, videoThumbsErrors: 0,
};

describe('channelThumbnails.regenerateChannelImages', () => {
  let channelThumbnails;
  let fs;
  let configModule;
  let logger;
  let Video;
  let downloadSettingsResolver;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    jest.doMock('fs-extra', () => ({
      existsSync: jest.fn(),
      copySync: jest.fn(),
      chmodSync: jest.fn(),
      removeSync: jest.fn(),
      promises: {
        readFile: jest.fn(),
        writeFile: jest.fn(),
        unlink: jest.fn(),
        rename: jest.fn(),
      },
    }));

    jest.doMock('../../configModule', () => ({
      directoryPath: BASE_DIR,
      getImagePath: jest.fn().mockReturnValue(IMAGE_DIR),
      onConfigChange: jest.fn(),
      getConfig: jest.fn().mockReturnValue({
        writeChannelPosters: true,
        writeBackdropImages: false,
      }),
      getDefaultSubfolder: jest.fn().mockReturnValue(null),
    }));

    // Series library mode is off by default (movie), so most tests below
    // never touch Video.findAll - only the season-images describe block
    // below opts channels into series mode.
    jest.doMock('../../../models', () => ({ Video: { findAll: jest.fn().mockResolvedValue([]) } }));
    jest.doMock('../../download/downloadSettingsResolver', () => ({
      resolveFinalLibraryMode: jest.fn().mockReturnValue('movie'),
    }));

    fs = require('fs-extra');
    configModule = require('../../configModule');
    logger = require('../../../logger');
    Video = require('../../../models').Video;
    downloadSettingsResolver = require('../../download/downloadSettingsResolver');
    channelThumbnails = require('../channelThumbnails');
  });

  it('overwrites poster.jpg/logo.jpg even when they already exist', async () => {
    const channels = [{ channel_id: 'UC123', uploader: 'Test Channel' }];
    const channelDir = path.join(BASE_DIR, 'Test Channel');
    const posterPath = path.join(channelDir, 'poster.jpg');
    const logoPath = path.join(channelDir, 'logo.jpg');
    const thumbPath = path.join(IMAGE_DIR, 'channelthumb-UC123.jpg');

    fs.existsSync.mockImplementation((p) => {
      if (p === BASE_DIR) return true;
      if (p === channelDir) return true;
      // Both targets already exist - the whole point of "force"
      if (p === posterPath) return true;
      if (p === logoPath) return true;
      if (p === thumbPath) return true;
      return false;
    });

    const counts = await channelThumbnails.regenerateChannelImages(channels);

    expect(fs.copySync).toHaveBeenCalledWith(thumbPath, posterPath, { overwrite: true });
    expect(fs.copySync).toHaveBeenCalledWith(thumbPath, logoPath, { overwrite: true });
    expect(fs.copySync).toHaveBeenCalledTimes(2);
    expect(counts).toEqual({ copied: 2, skippedNoSource: 0, skippedNoFolder: 0, errors: 0, ...ZERO_VIDEO_THUMB_COUNTS });
  });

  it('chmods every copied destination to a permissive mode', async () => {
    const channels = [{ channel_id: 'UC123', uploader: 'Test Channel' }];
    const channelDir = path.join(BASE_DIR, 'Test Channel');
    fs.existsSync.mockReturnValue(true);

    await channelThumbnails.regenerateChannelImages(channels);

    expect(fs.chmodSync).toHaveBeenCalledWith(path.join(channelDir, 'poster.jpg'), 0o644);
    expect(fs.chmodSync).toHaveBeenCalledWith(path.join(channelDir, 'logo.jpg'), 0o644);
  });

  it('counts skippedNoSource and does not copy when the cached channel thumbnail is missing', async () => {
    const channels = [{ channel_id: 'UC123', uploader: 'Test Channel' }];
    const channelDir = path.join(BASE_DIR, 'Test Channel');

    fs.existsSync.mockImplementation((p) => {
      if (p === BASE_DIR) return true;
      if (p === channelDir) return true;
      return false; // cached channelthumb-*.jpg missing
    });

    const counts = await channelThumbnails.regenerateChannelImages(channels);

    expect(fs.copySync).not.toHaveBeenCalled();
    expect(counts).toEqual({ copied: 0, skippedNoSource: 2, skippedNoFolder: 0, errors: 0, ...ZERO_VIDEO_THUMB_COUNTS });
  });

  it('counts skippedNoFolder and skips a channel whose folder does not exist on disk', async () => {
    const channels = [{ channel_id: 'UC123', uploader: 'Missing Channel' }];

    fs.existsSync.mockImplementation((p) => {
      if (p === BASE_DIR) return true;
      return false; // channel folder itself doesn't exist
    });

    const counts = await channelThumbnails.regenerateChannelImages(channels);

    expect(fs.copySync).not.toHaveBeenCalled();
    expect(counts.skippedNoFolder).toBe(1);
  });

  it('tallies errors and logs, without throwing, when a copy fails', async () => {
    const channels = [{ channel_id: 'UC123', uploader: 'Test Channel' }];
    fs.existsSync.mockReturnValue(true);
    const copyError = new Error('Permission denied');
    fs.copySync.mockImplementation(() => { throw copyError; });

    const counts = await channelThumbnails.regenerateChannelImages(channels);

    expect(counts.errors).toBe(2); // poster.jpg + logo.jpg both fail
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: copyError, channelFolderName: 'Test Channel' }),
      'Error regenerating channel image'
    );
  });

  it('skips channel poster/backdrop copies when both flags are disabled, independent of video-thumbnail regeneration', async () => {
    // writeThumbnail defaults to enabled (undefined !== false) - video
    // thumbnail regeneration isn't governed by writeChannelPosters/
    // writeBackdropImages, so it still runs, but finds nothing to do since
    // Video.findAll defaults to an empty array.
    configModule.getConfig.mockReturnValue({ writeChannelPosters: false, writeBackdropImages: false });
    const channels = [{ channel_id: 'UC123', uploader: 'Test Channel' }];

    const counts = await channelThumbnails.regenerateChannelImages(channels);

    expect(fs.copySync).not.toHaveBeenCalled();
    expect(counts).toEqual({ copied: 0, skippedNoSource: 0, skippedNoFolder: 0, errors: 0, ...ZERO_VIDEO_THUMB_COUNTS });
  });

  it('also skips video-thumbnail regeneration when strm.writeThumbnail is disabled', async () => {
    configModule.getConfig.mockReturnValue({
      writeChannelPosters: false, writeBackdropImages: false, strm: { writeThumbnail: false },
    });
    const channels = [{ channel_id: 'UC123', uploader: 'Test Channel' }];

    await channelThumbnails.regenerateChannelImages(channels);

    expect(Video.findAll).not.toHaveBeenCalled();
  });

  it('also force-copies backdrop.jpg/banner.jpg when writeBackdropImages is enabled', async () => {
    configModule.getConfig.mockReturnValue({ writeChannelPosters: false, writeBackdropImages: true });
    const channels = [{ channel_id: 'UC123', uploader: 'Test Channel' }];
    const channelDir = path.join(BASE_DIR, 'Test Channel');
    const bannerPath = path.join(IMAGE_DIR, 'channelbanner-UC123.jpg');

    fs.existsSync.mockImplementation((p) => {
      if (p === BASE_DIR) return true;
      if (p === channelDir) return true;
      if (p === bannerPath) return true;
      return true; // backdrop.jpg/banner.jpg already exist - force should overwrite anyway
    });

    const counts = await channelThumbnails.regenerateChannelImages(channels);

    expect(fs.copySync).toHaveBeenCalledWith(bannerPath, path.join(channelDir, 'backdrop.jpg'), { overwrite: true });
    expect(fs.copySync).toHaveBeenCalledWith(bannerPath, path.join(channelDir, 'banner.jpg'), { overwrite: true });
    expect(counts.copied).toBe(2);
  });

  describe('TV Series library mode - season images', () => {
    it('force-copies poster.jpg/logo.jpg into every distinct season folder found among the channel\'s videos', async () => {
      downloadSettingsResolver.resolveFinalLibraryMode.mockReturnValue('series');
      const channels = [{ channel_id: 'UC123', uploader: 'Test Channel' }];
      const channelDir = path.join(BASE_DIR, 'Test Channel');
      const season1Dir = path.join(channelDir, 'Season 2023');
      const season2Dir = path.join(channelDir, 'Season 2024');
      const thumbPath = path.join(IMAGE_DIR, 'channelthumb-UC123.jpg');

      Video.findAll.mockResolvedValue([
        { filePath: path.join(season1Dir, 'S2023E01 - Ep One.mp4') },
        { filePath: path.join(season1Dir, 'S2023E02 - Ep Two.mp4') },
        { filePath: path.join(season2Dir, 'S2024E01 - Ep One.mp4') },
      ]);

      fs.existsSync.mockReturnValue(true); // channel folder, both season folders, and the thumb source all exist

      const counts = await channelThumbnails.regenerateChannelImages(channels);

      expect(Video.findAll).toHaveBeenCalledWith(expect.objectContaining({ where: { channel_id: 'UC123' } }));
      // Deduped to 2 season folders despite 3 videos (two share season1Dir).
      expect(fs.copySync).toHaveBeenCalledWith(thumbPath, path.join(season1Dir, 'poster.jpg'), { overwrite: true });
      expect(fs.copySync).toHaveBeenCalledWith(thumbPath, path.join(season1Dir, 'logo.jpg'), { overwrite: true });
      expect(fs.copySync).toHaveBeenCalledWith(thumbPath, path.join(season2Dir, 'poster.jpg'), { overwrite: true });
      expect(fs.copySync).toHaveBeenCalledWith(thumbPath, path.join(season2Dir, 'logo.jpg'), { overwrite: true });
      // 2 (channel poster/logo) + 2 season folders x 2 images = 6.
      expect(counts.copied).toBe(6);
    });

    it('skips season folders that no longer exist on disk', async () => {
      downloadSettingsResolver.resolveFinalLibraryMode.mockReturnValue('series');
      const channels = [{ channel_id: 'UC123', uploader: 'Test Channel' }];
      const channelDir = path.join(BASE_DIR, 'Test Channel');
      const goneDir = path.join(channelDir, 'Season 2020');

      Video.findAll.mockResolvedValue([{ filePath: path.join(goneDir, 'old-episode.mp4') }]);

      fs.existsSync.mockImplementation((p) => p !== goneDir);

      await channelThumbnails.regenerateChannelImages(channels);

      expect(fs.copySync).not.toHaveBeenCalledWith(expect.anything(), path.join(goneDir, 'poster.jpg'), expect.anything());
    });

    it('never copies into a season folder for a channel in movie mode (the default)', async () => {
      downloadSettingsResolver.resolveFinalLibraryMode.mockReturnValue('movie');
      const channels = [{ channel_id: 'UC123', uploader: 'Test Channel' }];
      const channelDir = path.join(BASE_DIR, 'Test Channel');
      const someOtherDir = path.join(channelDir, 'Some Folder');
      // Video.findAll is still called (video-thumbnail regeneration runs
      // regardless of library mode - see the top-level describe block's
      // own tests), but regenerateSeasonImagesForChannel's own movie-mode
      // early-return means none of its season-folder copies should happen.
      Video.findAll.mockResolvedValue([{ filePath: path.join(someOtherDir, 'video.mp4'), youtubeId: 'vid1' }]);
      fs.existsSync.mockReturnValue(true);

      await channelThumbnails.regenerateChannelImages(channels);

      expect(fs.copySync).not.toHaveBeenCalledWith(expect.anything(), path.join(someOtherDir, 'poster.jpg'), expect.anything());
      expect(fs.copySync).not.toHaveBeenCalledWith(expect.anything(), path.join(someOtherDir, 'logo.jpg'), expect.anything());
    });

    it('does not abort the whole batch if season-image regeneration fails for one channel', async () => {
      downloadSettingsResolver.resolveFinalLibraryMode.mockReturnValue('series');
      const channels = [
        { channel_id: 'UC_BAD', uploader: 'Bad Channel' },
        { channel_id: 'UC_GOOD', uploader: 'Good Channel' },
      ];
      Video.findAll
        .mockRejectedValueOnce(new Error('db unavailable'))
        .mockResolvedValueOnce([]);
      fs.existsSync.mockReturnValue(true);

      const counts = await channelThumbnails.regenerateChannelImages(channels);

      // Second channel's channel-level poster/logo still got copied despite the first channel's season-image failure.
      expect(fs.copySync).toHaveBeenCalledWith(
        path.join(IMAGE_DIR, 'channelthumb-UC_GOOD.jpg'),
        path.join(BASE_DIR, 'Good Channel', 'poster.jpg'),
        { overwrite: true }
      );
      expect(counts.errors).toBeGreaterThan(0);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: 'UC_BAD' }),
        'Error regenerating season images for channel'
      );
    });
  });

  describe('missing video/episode thumbnails', () => {
    it('skips a video whose library-adjacent thumbnail already exists', async () => {
      const channels = [{ channel_id: 'UC123', uploader: 'Test Channel' }];
      const channelDir = path.join(BASE_DIR, 'Test Channel');
      const videoPath = path.join(channelDir, 'My Video [vid1].mp4');
      Video.findAll.mockResolvedValue([{ filePath: videoPath, youtubeId: 'vid1' }]);
      fs.existsSync.mockReturnValue(true); // including the thumbnail itself

      const counts = await channelThumbnails.regenerateChannelImages(channels);

      expect(counts.videoThumbsSkipped).toBe(1);
      expect(counts.videoThumbsCopied).toBe(0);
      expect(counts.videoThumbsDownloaded).toBe(0);
    });

    it('copies from the UI-grid thumbnail cache when the library-adjacent thumbnail is missing', async () => {
      const channels = [{ channel_id: 'UC123', uploader: 'Test Channel' }];
      const channelDir = path.join(BASE_DIR, 'Test Channel');
      const videoPath = path.join(channelDir, 'My Video [vid1].mp4');
      const expectedThumbPath = path.join(channelDir, 'My Video [vid1].jpg');
      const uiThumbPath = path.join(IMAGE_DIR, 'videothumb-vid1.jpg');
      Video.findAll.mockResolvedValue([{ filePath: videoPath, youtubeId: 'vid1' }]);

      fs.existsSync.mockImplementation((p) => {
        if (p === expectedThumbPath) return false; // the bug being repaired
        return true; // channel folder, video folder, uiThumbPath all present
      });

      const counts = await channelThumbnails.regenerateChannelImages(channels);

      expect(fs.copySync).toHaveBeenCalledWith(uiThumbPath, expectedThumbPath, { overwrite: true });
      expect(counts.videoThumbsCopied).toBe(1);
      expect(counts.videoThumbsDownloaded).toBe(0);
    });

    it('downloads hqdefault.jpg from YouTube when the UI-grid cache is also missing', async () => {
      const channels = [{ channel_id: 'UC123', uploader: 'Test Channel' }];
      const channelDir = path.join(BASE_DIR, 'Test Channel');
      const videoPath = path.join(channelDir, 'My Video [vid1].mp4');
      const expectedThumbPath = path.join(channelDir, 'My Video [vid1].jpg');
      const uiThumbPath = path.join(IMAGE_DIR, 'videothumb-vid1.jpg');
      Video.findAll.mockResolvedValue([{ filePath: videoPath, youtubeId: 'vid1' }]);

      fs.existsSync.mockImplementation((p) => {
        if (p === expectedThumbPath) return false;
        if (p === uiThumbPath) return false;
        return true;
      });
      const downloadSpy = jest.spyOn(channelThumbnails, 'downloadImageToPath').mockResolvedValue();

      const counts = await channelThumbnails.regenerateChannelImages(channels);

      expect(downloadSpy).toHaveBeenCalledWith('https://i.ytimg.com/vi/vid1/hqdefault.jpg', expectedThumbPath);
      expect(fs.copySync).not.toHaveBeenCalledWith(uiThumbPath, expectedThumbPath, expect.anything());
      expect(counts.videoThumbsDownloaded).toBe(1);
      expect(counts.videoThumbsCopied).toBe(0);

      downloadSpy.mockRestore();
    });

    it('tallies videoThumbsErrors and logs, without throwing, when both recovery paths fail', async () => {
      const channels = [{ channel_id: 'UC123', uploader: 'Test Channel' }];
      const channelDir = path.join(BASE_DIR, 'Test Channel');
      const videoPath = path.join(channelDir, 'My Video [vid1].mp4');
      const expectedThumbPath = path.join(channelDir, 'My Video [vid1].jpg');
      Video.findAll.mockResolvedValue([{ filePath: videoPath, youtubeId: 'vid1' }]);

      fs.existsSync.mockImplementation((p) => p !== expectedThumbPath); // uiThumbPath exists, but the copy will fail below
      const copyError = new Error('disk full');
      fs.copySync.mockImplementation(() => { throw copyError; });

      const counts = await channelThumbnails.regenerateChannelImages(channels);

      expect(counts.videoThumbsErrors).toBe(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: copyError, youtubeId: 'vid1', thumbPath: expectedThumbPath }),
        'Error regenerating missing video thumbnail'
      );
    });

    it('skips videos whose own folder no longer exists on disk', async () => {
      const channels = [{ channel_id: 'UC123', uploader: 'Test Channel' }];
      const channelDir = path.join(BASE_DIR, 'Test Channel');
      const goneDir = path.join(channelDir, 'Gone Video Folder');
      const videoPath = path.join(goneDir, 'video.mp4');
      Video.findAll.mockResolvedValue([{ filePath: videoPath, youtubeId: 'vid1' }]);

      fs.existsSync.mockImplementation((p) => p !== goneDir);

      const counts = await channelThumbnails.regenerateChannelImages(channels);

      // Channel-level poster/logo copies (an unrelated, always-on default)
      // still happen - only the gone video's own thumbnail is skipped.
      expect(fs.copySync).not.toHaveBeenCalledWith(expect.anything(), path.join(goneDir, 'video.jpg'), expect.anything());
      expect(counts.videoThumbsCopied).toBe(0);
      expect(counts.videoThumbsSkipped).toBe(0);
    });

    it('runs for a movie-mode channel too (not gated by TV Series library mode)', async () => {
      downloadSettingsResolver.resolveFinalLibraryMode.mockReturnValue('movie');
      const channels = [{ channel_id: 'UC123', uploader: 'Test Channel' }];
      const channelDir = path.join(BASE_DIR, 'Test Channel');
      const videoPath = path.join(channelDir, 'My Video [vid1].mp4');
      const expectedThumbPath = path.join(channelDir, 'My Video [vid1].jpg');
      const uiThumbPath = path.join(IMAGE_DIR, 'videothumb-vid1.jpg');
      Video.findAll.mockResolvedValue([{ filePath: videoPath, youtubeId: 'vid1' }]);

      fs.existsSync.mockImplementation((p) => p !== expectedThumbPath);

      const counts = await channelThumbnails.regenerateChannelImages(channels);

      expect(fs.copySync).toHaveBeenCalledWith(uiThumbPath, expectedThumbPath, { overwrite: true });
      expect(counts.videoThumbsCopied).toBe(1);
    });
  });
});
