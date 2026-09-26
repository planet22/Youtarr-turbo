/* eslint-env jest */

jest.mock('fs');
jest.mock('../../logger');
jest.mock('../configModule', () => ({ getConfig: jest.fn() }));
jest.mock('../ytstreamProbeShortcut', () => ({ PROBE_SHORTCUT_USER_AGENT: 'Youtarr Probe/1.0' }));

const fs = require('fs');
const path = require('path');
const configModule = require('../configModule');
const strmGenerator = require('../strmGenerator');

const UA_SUFFIX = `|User-Agent=${encodeURIComponent('Youtarr Probe/1.0')}\n`;
const VIDEO_ID = 'dQw4w9WgXcQ';

describe('strmGenerator', () => {
  const originalPublicUrl = process.env.YOUTARR_PUBLIC_URL;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.YOUTARR_PUBLIC_URL;
    configModule.getConfig.mockReturnValue({});
  });

  afterAll(() => {
    if (originalPublicUrl === undefined) delete process.env.YOUTARR_PUBLIC_URL;
    else process.env.YOUTARR_PUBLIC_URL = originalPublicUrl;
  });

  // Splits the generated content into its URL and the query params
  function parseContent(content) {
    const url = new URL(content.split('|')[0]);
    return { url, params: url.searchParams };
  }

  describe('buildStrmContent', () => {
    describe('target=youtube', () => {
      it('returns the plain watch URL', () => {
        expect(strmGenerator.buildStrmContent(VIDEO_ID, { target: 'youtube' })).toBe(`https://www.youtube.com/watch?v=${VIDEO_ID}\n`);
      });

      it('takes the target from config when no override is passed', () => {
        configModule.getConfig.mockReturnValue({ strm: { target: 'youtube' } });

        expect(strmGenerator.buildStrmContent(VIDEO_ID)).toBe(`https://www.youtube.com/watch?v=${VIDEO_ID}\n`);
      });

      it('does not append the probe user agent', () => {
        expect(strmGenerator.buildStrmContent(VIDEO_ID, { target: 'youtube' })).not.toContain('User-Agent');
      });
    });

    describe('target=ytstream', () => {
      it('is the default target', () => {
        expect(strmGenerator.buildStrmContent(VIDEO_ID)).toContain('/api/ytstream/');
      });

      it('ends with a newline', () => {
        expect(strmGenerator.buildStrmContent(VIDEO_ID).endsWith('\n')).toBe(true);
      });

      it('carries the probe user agent so playback can be told apart from a metadata probe', () => {
        expect(strmGenerator.buildStrmContent(VIDEO_ID).endsWith(UA_SUFFIX)).toBe(true);
      });

      it('targets the video id under /api/ytstream', () => {
        const { url } = parseContent(strmGenerator.buildStrmContent(VIDEO_ID));

        expect(url.pathname).toBe(`/api/ytstream/${VIDEO_ID}`);
      });

      it('defaults the base URL to localhost:3011', () => {
        const { url } = parseContent(strmGenerator.buildStrmContent(VIDEO_ID));

        expect(url.origin).toBe('http://127.0.0.1:3011');
      });

      it('uses YOUTARR_PUBLIC_URL over the default', () => {
        process.env.YOUTARR_PUBLIC_URL = 'https://env.example.com';

        expect(parseContent(strmGenerator.buildStrmContent(VIDEO_ID)).url.origin).toBe('https://env.example.com');
      });

      it('uses strm.proxyBaseUrl over YOUTARR_PUBLIC_URL', () => {
        process.env.YOUTARR_PUBLIC_URL = 'https://env.example.com';
        configModule.getConfig.mockReturnValue({ strm: { proxyBaseUrl: 'https://cfg.example.com' } });

        expect(parseContent(strmGenerator.buildStrmContent(VIDEO_ID)).url.origin).toBe('https://cfg.example.com');
      });

      it('uses opts.proxyBaseUrl over strm.proxyBaseUrl', () => {
        configModule.getConfig.mockReturnValue({ strm: { proxyBaseUrl: 'https://cfg.example.com' } });

        const content = strmGenerator.buildStrmContent(VIDEO_ID, { proxyBaseUrl: 'https://opt.example.com' });

        expect(parseContent(content).url.origin).toBe('https://opt.example.com');
      });

      it('strips a trailing slash from the base URL', () => {
        const content = strmGenerator.buildStrmContent(VIDEO_ID, { proxyBaseUrl: 'https://opt.example.com/' });

        expect(content.startsWith(`https://opt.example.com/api/ytstream/${VIDEO_ID}?`)).toBe(true);
      });

      it('includes mode, quality, container and transcode params', () => {
        const { params } = parseContent(strmGenerator.buildStrmContent(VIDEO_ID));

        expect(Object.fromEntries(params)).toEqual({ mode: 'direct', quality: '1080', container: 'mp4', transcode: 'copy' });
      });

      it('adds calculatedLength=1 only when enabled', () => {
        const { params } = parseContent(strmGenerator.buildStrmContent(VIDEO_ID, { ytstreamFakeLength: true }));

        expect(params.get('calculatedLength')).toBe('1');
      });

      it('omits calculatedLength when disabled', () => {
        const { params } = parseContent(strmGenerator.buildStrmContent(VIDEO_ID));

        expect(params.has('calculatedLength')).toBe(false);
      });

      it('adds deliverAsFile=1 only when enabled', () => {
        const { params } = parseContent(strmGenerator.buildStrmContent(VIDEO_ID, { ytstreamByteRangeDeliverAsFile: true }));

        expect(params.get('deliverAsFile')).toBe('1');
      });

      it('omits deliverAsFile when disabled', () => {
        const { params } = parseContent(strmGenerator.buildStrmContent(VIDEO_ID));

        expect(params.has('deliverAsFile')).toBe(false);
      });

      it('includes the configured ytstream.streamKey', () => {
        configModule.getConfig.mockReturnValue({ ytstream: { streamKey: 'the-stream-key' } });

        const { params } = parseContent(strmGenerator.buildStrmContent(VIDEO_ID));

        expect(params.get('key')).toBe('the-stream-key');
      });

      it('omits the key param when no streamKey is configured', () => {
        const { params } = parseContent(strmGenerator.buildStrmContent(VIDEO_ID));

        expect(params.has('key')).toBe(false);
      });
    });

    describe('id validation', () => {
      it.each([undefined, null, '', 42])('rejects a missing/non-string id (%p)', (id) => {
        expect(() => strmGenerator.buildStrmContent(id)).toThrow('youtubeId is required');
      });

      it.each(['abc', 'has space in it', 'bad/slash1234', 'a'.repeat(21)])('rejects the malformed id %p', (id) => {
        expect(() => strmGenerator.buildStrmContent(id)).toThrow('Invalid YouTube id');
      });

      it('trims surrounding whitespace from a valid id', () => {
        expect(strmGenerator.buildStrmContent(`  ${VIDEO_ID}  `, { target: 'youtube' })).toBe(`https://www.youtube.com/watch?v=${VIDEO_ID}\n`);
      });
    });
  });

  describe('resolveYtstreamParams', () => {
    it('falls back to hardcoded defaults for an empty config', () => {
      expect(strmGenerator.resolveYtstreamParams({})).toEqual({
        mode: 'direct',
        quality: '1080',
        container: 'mp4',
        transcode: 'copy',
        calculatedLength: false,
        byteRangeDeliverAsFile: false,
      });
    });

    it('uses ytstream.defaultMode and ytstream.container', () => {
      const params = strmGenerator.resolveYtstreamParams({ ytstream: { defaultMode: 'hls', container: 'ts' } });

      expect([params.mode, params.container]).toEqual(['hls', 'ts']);
    });

    it('lets opts override the configured mode and container', () => {
      const params = strmGenerator.resolveYtstreamParams(
        { ytstream: { defaultMode: 'hls', container: 'ts' } },
        { ytstreamMode: 'hls-buffer', ytstreamContainer: 'mp4' }
      );

      expect([params.mode, params.container]).toEqual(['hls-buffer', 'mp4']);
    });

    describe('quality precedence', () => {
      const cfg = { strm: { quality: '720' }, ytstream: { quality: '480' }, preferredResolution: '2160' };

      it('prefers opts.quality', () => {
        expect(strmGenerator.resolveYtstreamParams(cfg, { quality: 360 }).quality).toBe('360');
      });

      it('then strm.quality', () => {
        expect(strmGenerator.resolveYtstreamParams(cfg).quality).toBe('720');
      });

      it('then ytstream.quality', () => {
        expect(strmGenerator.resolveYtstreamParams({ ytstream: { quality: '480' }, preferredResolution: '2160' }).quality).toBe('480');
      });

      it('then preferredResolution', () => {
        expect(strmGenerator.resolveYtstreamParams({ preferredResolution: '2160' }).quality).toBe('2160');
      });

      it('always returns a string', () => {
        expect(strmGenerator.resolveYtstreamParams({ preferredResolution: 720 }).quality).toBe('720');
      });
    });

    describe('transcode', () => {
      it('prefers opts.ytstreamTranscode', () => {
        expect(strmGenerator.resolveYtstreamParams({ ytstream: { transcode: 'copy' } }, { ytstreamTranscode: 'h264' }).transcode).toBe('h264');
      });

      it('then ytstream.transcode', () => {
        expect(strmGenerator.resolveYtstreamParams({ ytstream: { transcode: 'h264' }, videoCodec: 'default' }).transcode).toBe('h264');
      });

      it.each([
        ['default', 'copy'],
        ['h264', 'h264'],
        ['h265', 'h264'],
        [undefined, 'copy'],
      ])('derives it from videoCodec %p as %s', (videoCodec, expected) => {
        expect(strmGenerator.resolveYtstreamParams({ videoCodec }).transcode).toBe(expected);
      });
    });

    describe('boolean flags', () => {
      it('lets opts.ytstreamFakeLength=false override a true config value', () => {
        expect(strmGenerator.resolveYtstreamParams({ ytstream: { calculatedLength: true } }, { ytstreamFakeLength: false }).calculatedLength).toBe(false);
      });

      it('reads calculatedLength from config when no override is passed', () => {
        expect(strmGenerator.resolveYtstreamParams({ ytstream: { calculatedLength: true } }).calculatedLength).toBe(true);
      });

      it('lets opts.ytstreamByteRangeDeliverAsFile=false override a true config value', () => {
        const params = strmGenerator.resolveYtstreamParams({ ytstream: { byteRangeDeliverAsFile: true } }, { ytstreamByteRangeDeliverAsFile: false });

        expect(params.byteRangeDeliverAsFile).toBe(false);
      });

      it('reads byteRangeDeliverAsFile from config when no override is passed', () => {
        expect(strmGenerator.resolveYtstreamParams({ ytstream: { byteRangeDeliverAsFile: true } }).byteRangeDeliverAsFile).toBe(true);
      });
    });
  });

  describe('getStrmPath', () => {
    it('swaps the extension for .strm', () => {
      expect(strmGenerator.getStrmPath(path.join('media', 'Channel', 'Video [abc].mp4'))).toBe(path.join('media', 'Channel', 'Video [abc].strm'));
    });

    it('adds .strm to a path with no extension', () => {
      expect(strmGenerator.getStrmPath(path.join('media', 'Video'))).toBe(path.join('media', 'Video.strm'));
    });

    it('keeps dots inside the base name', () => {
      expect(strmGenerator.getStrmPath(path.join('media', 'v1.2 title.mkv'))).toBe(path.join('media', 'v1.2 title.strm'));
    });
  });

  describe('writeStrmFile', () => {
    const mediaPath = path.join('media', 'Channel', 'Video.mp4');
    const strmPath = path.join('media', 'Channel', 'Video.strm');

    it('throws when no media path is given', () => {
      expect(() => strmGenerator.writeStrmFile('', VIDEO_ID)).toThrow('mediaPath is required');
    });

    it('writes the generated content to the .strm path as utf8', () => {
      fs.existsSync.mockReturnValue(true);

      strmGenerator.writeStrmFile(mediaPath, VIDEO_ID, { target: 'youtube' });

      expect(fs.writeFileSync).toHaveBeenCalledWith(strmPath, `https://www.youtube.com/watch?v=${VIDEO_ID}\n`, 'utf8');
    });

    it('returns the .strm path', () => {
      fs.existsSync.mockReturnValue(true);

      expect(strmGenerator.writeStrmFile(mediaPath, VIDEO_ID, { target: 'youtube' })).toBe(strmPath);
    });

    it('creates the directory when it does not exist', () => {
      fs.existsSync.mockReturnValue(false);

      strmGenerator.writeStrmFile(mediaPath, VIDEO_ID, { target: 'youtube' });

      expect(fs.mkdirSync).toHaveBeenCalledWith(path.dirname(strmPath), { recursive: true });
    });

    it('does not create the directory when it already exists', () => {
      fs.existsSync.mockReturnValue(true);

      strmGenerator.writeStrmFile(mediaPath, VIDEO_ID, { target: 'youtube' });

      expect(fs.mkdirSync).not.toHaveBeenCalled();
    });

    it('does not write anything for an invalid video id', () => {
      fs.existsSync.mockReturnValue(true);

      expect(() => strmGenerator.writeStrmFile(mediaPath, 'bad id')).toThrow('Invalid YouTube id');
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });
  });
});
