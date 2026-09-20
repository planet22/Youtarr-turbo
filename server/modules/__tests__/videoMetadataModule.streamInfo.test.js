/* eslint-env jest */

jest.mock('../../logger');

describe('VideoMetadataModule.getVideoStreamInfo', () => {
  const YT_ID = 'abc12345678';

  let fs;
  let os;
  let path;
  let dir;
  let Video;
  let tsRemuxCache;
  let ytstreamRoutes;
  let logger;
  let videoMetadataModule;

  const write = (name, content = 'media-bytes') => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content);
    return p;
  };

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    fs = require('fs');
    os = require('os');
    path = require('path');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmeta-test-'));

    Video = { findOne: jest.fn() };
    tsRemuxCache = { ensureSeekableMp4: jest.fn() };
    ytstreamRoutes = { getUntrackedBufferCachePath: jest.fn() };

    jest.doMock('../../models', () => ({ Video }));
    jest.doMock('../../models/channelvideo', () => ({}));
    jest.doMock('../tsRemuxCache', () => tsRemuxCache);
    jest.doMock('../../routes/ytstream', () => ytstreamRoutes);
    jest.doMock('../configModule', () => ({ directoryPath: dir, getJobsPath: () => dir }));
    jest.doMock('../ytDlpRunner', () => ({}));
    jest.doMock('../youtubeApi', () => ({ isAvailable: () => false }));
    jest.doMock('../channelVideoReanchor', () => ({}));
    jest.doMock('../youtubeMetadataCache', () => ({}));

    logger = require('../../logger');
    videoMetadataModule = require('../videoMetadataModule');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('for a video in the library', () => {
    it('describes the file, its type and its size', async () => {
      const filePath = write('video.mp4', '12345');
      Video.findOne.mockResolvedValue({ youtubeId: YT_ID, filePath });

      const info = await videoMetadataModule.getVideoStreamInfo(YT_ID, 'video');

      expect(info).toEqual({ filePath, contentType: 'video/mp4', fileSize: 5, isStrm: false });
    });

    it('looks the video up by YouTube id', async () => {
      Video.findOne.mockResolvedValue(null);
      ytstreamRoutes.getUntrackedBufferCachePath.mockReturnValue(path.join(dir, 'none.ts'));

      await videoMetadataModule.getVideoStreamInfo(YT_ID, 'video');

      expect(Video.findOne).toHaveBeenCalledWith({ where: { youtubeId: YT_ID } });
    });

    it.each([
      ['video.webm', 'video/webm'],
      ['video.mkv', 'video/x-matroska'],
      ['audio.mp3', 'audio/mpeg'],
    ])('reports the content type for %s', async (name, expected) => {
      const filePath = write(name);
      Video.findOne.mockResolvedValue({ youtubeId: YT_ID, filePath, audioFilePath: filePath });

      const info = await videoMetadataModule.getVideoStreamInfo(YT_ID, name.startsWith('audio') ? 'audio' : 'video');

      expect(info.contentType).toBe(expected);
    });

    it('falls back to a generic type for an unknown extension', async () => {
      const filePath = write('video.xyz');
      Video.findOne.mockResolvedValue({ youtubeId: YT_ID, filePath });

      const info = await videoMetadataModule.getVideoStreamInfo(YT_ID, 'video');

      expect(info.contentType).toBe('application/octet-stream');
    });

    it('serves the audio file for audio requests', async () => {
      const audioFilePath = write('audio.mp3', 'abc');
      Video.findOne.mockResolvedValue({ youtubeId: YT_ID, filePath: write('video.mp4'), audioFilePath });

      const info = await videoMetadataModule.getVideoStreamInfo(YT_ID, 'audio');

      expect(info.filePath).toBe(audioFilePath);
    });

    it.each([['video', 'filePath'], ['audio', 'audioFilePath']])('reports no %s file when the row has none', async (type, field) => {
      Video.findOne.mockResolvedValue({ youtubeId: YT_ID, filePath: write('x.mp4'), audioFilePath: write('x.mp3'), [field]: null });

      const info = await videoMetadataModule.getVideoStreamInfo(YT_ID, type);

      expect(info).toEqual({ error: 'no_file', message: `No ${type} file available for this video` });
    });

    it('reports a file that is missing from disk', async () => {
      Video.findOne.mockResolvedValue({ youtubeId: YT_ID, filePath: path.join(dir, 'gone.mp4') });

      const info = await videoMetadataModule.getVideoStreamInfo(YT_ID, 'video');

      expect(info).toEqual({ error: 'file_missing', message: 'File not found on disk' });
    });
  });

  describe('STRM videos', () => {
    it('hands a STRM row off to the caller instead of serving the text file', async () => {
      const filePath = write('video.strm', 'https://example.invalid');
      Video.findOne.mockResolvedValue({ youtubeId: YT_ID, filePath, is_strm: true });

      const info = await videoMetadataModule.getVideoStreamInfo(YT_ID, 'video');

      expect(info).toEqual({ isStrm: true, youtubeId: YT_ID, filePath });
    });

    it('recognizes a .strm file even when the row is not flagged', async () => {
      const filePath = write('video.STRM');
      Video.findOne.mockResolvedValue({ youtubeId: YT_ID, filePath, is_strm: false });

      const info = await videoMetadataModule.getVideoStreamInfo(YT_ID, 'video');

      expect(info.isStrm).toBe(true);
    });

    it('does not treat an audio request as STRM', async () => {
      const audioFilePath = write('audio.mp3');
      Video.findOne.mockResolvedValue({ youtubeId: YT_ID, filePath: write('video.strm'), audioFilePath, is_strm: true });

      const info = await videoMetadataModule.getVideoStreamInfo(YT_ID, 'audio');

      expect(info.isStrm).toBe(false);
    });
  });

  describe('for a video that is not in the library', () => {
    it('serves the untracked hls-buffer cache copy', async () => {
      const cachePath = write('cache.mp4', 'cached');
      ytstreamRoutes.getUntrackedBufferCachePath.mockReturnValue(cachePath);
      Video.findOne.mockResolvedValue(null);

      const info = await videoMetadataModule.getVideoStreamInfo(YT_ID, 'video');

      expect(info).toMatchObject({ filePath: cachePath, fileSize: 6, isStrm: false });
      expect(ytstreamRoutes.getUntrackedBufferCachePath).toHaveBeenCalledWith(YT_ID);
    });

    it('reports not found when there is no cached copy', async () => {
      ytstreamRoutes.getUntrackedBufferCachePath.mockReturnValue(path.join(dir, 'missing.ts'));
      Video.findOne.mockResolvedValue(null);

      await expect(videoMetadataModule.getVideoStreamInfo(YT_ID, 'video')).resolves.toEqual({ error: 'not_found', message: 'Video not found' });
    });

    it('has no audio-only fallback', async () => {
      Video.findOne.mockResolvedValue(null);

      await expect(videoMetadataModule.getVideoStreamInfo(YT_ID, 'audio')).resolves.toEqual({ error: 'not_found', message: 'Video not found' });
      expect(ytstreamRoutes.getUntrackedBufferCachePath).not.toHaveBeenCalled();
    });
  });

  describe('MPEG-TS files', () => {
    it('serves the seekable mp4 remux instead of the raw .ts', async () => {
      const tsPath = write('video.ts', 'raw-ts-data');
      const remuxPath = write('video.remux.mp4', 'mp4');
      tsRemuxCache.ensureSeekableMp4.mockResolvedValue(remuxPath);
      Video.findOne.mockResolvedValue({ youtubeId: YT_ID, filePath: tsPath });

      const info = await videoMetadataModule.getVideoStreamInfo(YT_ID, 'video');

      expect(info).toEqual({ filePath: remuxPath, contentType: 'video/mp4', fileSize: 3, isStrm: false });
      expect(tsRemuxCache.ensureSeekableMp4).toHaveBeenCalledWith(tsPath);
    });

    it('falls back to the raw file when no remux is available', async () => {
      const tsPath = write('video.ts', 'raw-ts-data');
      tsRemuxCache.ensureSeekableMp4.mockResolvedValue(null);
      Video.findOne.mockResolvedValue({ youtubeId: YT_ID, filePath: tsPath });

      const info = await videoMetadataModule.getVideoStreamInfo(YT_ID, 'video');

      expect(info).toMatchObject({ filePath: tsPath, fileSize: 11 });
    });

    it('warns and falls back to the raw file when the remux fails', async () => {
      const tsPath = write('video.ts', 'raw');
      tsRemuxCache.ensureSeekableMp4.mockRejectedValue(new Error('ffmpeg missing'));
      Video.findOne.mockResolvedValue({ youtubeId: YT_ID, filePath: tsPath });

      const info = await videoMetadataModule.getVideoStreamInfo(YT_ID, 'video');

      expect(info.filePath).toBe(tsPath);
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ filePath: tsPath }), expect.stringContaining('.ts remux lookup failed'));
    });

    it('does not remux audio requests', async () => {
      const tsPath = write('audio.ts');
      Video.findOne.mockResolvedValue({ youtubeId: YT_ID, filePath: write('video.mp4'), audioFilePath: tsPath });

      await videoMetadataModule.getVideoStreamInfo(YT_ID, 'audio');

      expect(tsRemuxCache.ensureSeekableMp4).not.toHaveBeenCalled();
    });

    it('serves the untracked buffer cache through the remux too', async () => {
      const tsPath = write('cache.ts');
      const remuxPath = write('cache.mp4', 'mp4');
      ytstreamRoutes.getUntrackedBufferCachePath.mockReturnValue(tsPath);
      tsRemuxCache.ensureSeekableMp4.mockResolvedValue(remuxPath);
      Video.findOne.mockResolvedValue(null);

      const info = await videoMetadataModule.getVideoStreamInfo(YT_ID, 'video');

      expect(info.filePath).toBe(remuxPath);
    });
  });
});
