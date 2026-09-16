/* eslint-env jest */

jest.mock('fs');
jest.mock('../../logger');

describe('StrmMediaInfoCache', () => {
  let strmMediaInfoCache;
  let fs;

  const baseMeta = {
    id: 'dQw4w9WgXcQ',
    duration: 212,
    formats: [
      { format_id: '137', vcodec: 'avc1.640028', acodec: 'none', height: 1080, width: 1920, tbr: 4000, ext: 'mp4' },
      { format_id: '140', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128, ext: 'm4a' },
    ],
  };

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    jest.doMock('fs', () => ({
      writeFileSync: jest.fn(),
      existsSync: jest.fn().mockReturnValue(true),
      mkdirSync: jest.fn(),
    }));

    fs = require('fs');
    strmMediaInfoCache = require('../strmMediaInfoCache');
  });

  function writeAndParse(mediaBasePath, meta, ytstreamParams) {
    strmMediaInfoCache.writeMediaInfoCacheFile(mediaBasePath, meta, ytstreamParams);
    const [, jsonString] = fs.writeFileSync.mock.calls[0];
    return JSON.parse(jsonString);
  }

  describe('container field', () => {
    it('declares "hls" for mode=hls, regardless of the configured container setting', () => {
      const data = writeAndParse('/media/video', baseMeta, {
        mode: 'hls', quality: '1080', container: 'mp4', transcode: 'h264',
      });
      expect(data.container).toBe('hls');
    });

    it('declares "hls" for mode=hls-buffer, regardless of the configured container setting', () => {
      const data = writeAndParse('/media/video', baseMeta, {
        mode: 'hls-buffer', quality: '1080', container: 'mkv', transcode: 'copy',
      });
      expect(data.container).toBe('hls');
    });

    it('uses the configured container for mode=direct (no HLS involved)', () => {
      const data = writeAndParse('/media/video', baseMeta, {
        mode: 'direct', quality: '1080', container: 'mp4', transcode: 'copy',
      });
      expect(data.container).toBe('mp4');
    });

    it('uses the configured container for mode=direct-redirect', () => {
      const data = writeAndParse('/media/video', baseMeta, {
        mode: 'direct-redirect', quality: '1080', container: 'mp4', transcode: 'copy',
      });
      expect(data.container).toBe('mp4');
    });

    it('falls back to the selected video format extension when no container is configured and mode is not HLS', () => {
      const data = writeAndParse('/media/video', baseMeta, {
        mode: 'direct', quality: '1080', container: '', transcode: 'copy',
      });
      expect(data.container).toBe('mp4');
    });
  });

  describe('mediaStreams codec', () => {
    it('still reports the real negotiated codec for hls mode (container fix does not affect codec reporting)', () => {
      const data = writeAndParse('/media/video', baseMeta, {
        mode: 'hls', quality: '1080', container: 'mp4', transcode: 'h264',
      });
      const videoStream = data.mediaStreams.find((s) => s.Type === 1);
      expect(videoStream.Codec).toBe('h264');
    });
  });
});
