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
      readFileSync: jest.fn(),
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

  describe('bitrate estimation', () => {
    it('uses the real-encoder-output estimate for the video BitRate when transcode=h264, not the source format bitrate', () => {
      const data = writeAndParse('/media/video', baseMeta, {
        mode: 'hls-buffer', quality: '1080', container: 'mp4', transcode: 'h264',
      });
      const videoStream = data.mediaStreams.find((s) => s.Type === 1);
      // baseMeta's video format has tbr: 4000 (4,000,000 bps if used
      // directly) - transcode=h264 should ignore that and use the
      // estimate for a 1080p real VAAPI QP=15 encode (10,000,000) instead.
      expect(videoStream.BitRate).toBe(10_000_000);
    });

    it('keeps the source format bitrate for transcode=copy (passthrough, not re-encoded)', () => {
      const data = writeAndParse('/media/video', baseMeta, {
        mode: 'direct', quality: '1080', container: 'mp4', transcode: 'copy',
      });
      const videoStream = data.mediaStreams.find((s) => s.Type === 1);
      expect(videoStream.BitRate).toBe(4_000_000);
    });

    it('sets a top-level aggregate bitrate summing the video and audio stream BitRates', () => {
      const data = writeAndParse('/media/video', baseMeta, {
        mode: 'direct', quality: '1080', container: 'mp4', transcode: 'copy',
      });
      const videoStream = data.mediaStreams.find((s) => s.Type === 1);
      const audioStream = data.mediaStreams.find((s) => s.Type === 0);
      expect(data.bitrate).toBe(videoStream.BitRate + audioStream.BitRate);
    });
  });

  describe('updateContainerOnly', () => {
    const ytstreamParams = { mode: 'hls-buffer', quality: '1080', container: 'mp4', transcode: 'h264' };

    it('returns "written" and patches container when the existing sidecar has a stale value', () => {
      fs.readFileSync.mockReturnValueOnce(JSON.stringify({ version: '1.0', container: 'mp4', mediaStreams: [] }));

      const result = strmMediaInfoCache.updateContainerOnly('/media/video', ytstreamParams);

      expect(result).toBe('written');
      const [writtenPath, writtenJson] = fs.writeFileSync.mock.calls[0];
      expect(writtenPath).toBe(strmMediaInfoCache.getMediaInfoCachePath('/media/video'));
      expect(JSON.parse(writtenJson).container).toBe('hls');
    });

    it('returns "already-correct" and does not write when the sidecar already has the resolved container', () => {
      fs.readFileSync.mockReturnValueOnce(JSON.stringify({ version: '1.0', container: 'hls', mediaStreams: [] }));

      const result = strmMediaInfoCache.updateContainerOnly('/media/video', ytstreamParams);

      expect(result).toBe('already-correct');
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('returns "no-sidecar" when no .strmtool.json exists to read', () => {
      fs.readFileSync.mockImplementationOnce(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      const result = strmMediaInfoCache.updateContainerOnly('/media/video', ytstreamParams);

      expect(result).toBe('no-sidecar');
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('returns "write-failed" when the sidecar exists but the write throws', () => {
      fs.readFileSync.mockReturnValueOnce(JSON.stringify({ version: '1.0', container: 'mp4', mediaStreams: [] }));
      fs.writeFileSync.mockImplementationOnce(() => {
        throw new Error('disk full');
      });

      const result = strmMediaInfoCache.updateContainerOnly('/media/video', ytstreamParams);

      expect(result).toBe('write-failed');
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
