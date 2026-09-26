/* eslint-env jest */

jest.mock('../streamDebug', () => ({ streamDebug: jest.fn() }));
jest.mock('../debugPlaylistCopy', () => ({ maybeSaveDebugPlaylistCopy: jest.fn() }));

const { maybeSaveDebugPlaylistCopy } = require('../debugPlaylistCopy');
const {
  estimateHlsBandwidthBps,
  resolveHlsCodecsString,
  buildHlsMasterPlaylist,
  buildHlsTopLevelPlaylistResponse,
} = require('../hlsMasterPlaylist');

describe('hlsMasterPlaylist', () => {
  describe('estimateHlsBandwidthBps', () => {
    it.each([
      [360, 3_192_000],
      [480, 3_192_000],
      [720, 6_192_000],
      [1080, 10_192_000],
      [1440, 16_192_000],
      [2160, 30_192_000],
      [4320, 30_192_000],
    ])('adds 192 kbps of audio to the video estimate for %ip', (height, expected) => {
      expect(estimateHlsBandwidthBps(height)).toBe(expected);
    });

    it('uses the top tier for heights beyond the ladder', () => {
      expect(estimateHlsBandwidthBps(100000)).toBe(30_192_000);
    });
  });

  describe('resolveHlsCodecsString', () => {
    it.each(['copy', '', undefined, 'auto'])('declares no codecs for transcode=%p', (transcode) => {
      expect(resolveHlsCodecsString(transcode, 1080, 'none')).toBeNull();
    });

    it.each([
      [240, '1e'],
      [480, '1e'],
      [481, '1f'],
      [720, '1f'],
      [721, '28'],
      [1080, '28'],
      [1081, '32'],
      [1440, '32'],
      [1441, '33'],
      [2160, '33'],
    ])('picks the H.264 level for %ip', (height, level) => {
      expect(resolveHlsCodecsString('h264', height, 'none')).toBe(`avc1.6400${level},mp4a.40.2`);
    });

    it('uses the verified constraint flags for VAAPI', () => {
      expect(resolveHlsCodecsString('h264', 1080, 'vaapi')).toBe('avc1.640828,mp4a.40.2');
    });

    it.each(['none', 'qsv', 'nvenc', 'amf', undefined])('assumes zero constraint flags for the %p encoder', (hardwareMode) => {
      expect(resolveHlsCodecsString('h264', 720, hardwareMode)).toBe('avc1.64001f,mp4a.40.2');
    });

    it('always declares AAC-LC audio', () => {
      expect(resolveHlsCodecsString('h264', 720, 'none')).toMatch(/,mp4a\.40\.2$/);
    });
  });

  describe('buildHlsMasterPlaylist', () => {
    it('builds a single-variant master playlist', () => {
      const playlist = buildHlsMasterPlaylist({ width: 1920, height: 1080, bandwidthBps: 10_192_000, codecs: 'avc1.640028,mp4a.40.2', mediaPlaylistUrl: 'http://h/p.m3u8' });

      expect(playlist).toBe([
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-STREAM-INF:BANDWIDTH=10192000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"',
        'http://h/p.m3u8',
        '',
      ].join('\n'));
    });

    it.each([[null], [undefined], ['']])('leaves out CODECS when it is %p', (codecs) => {
      const playlist = buildHlsMasterPlaylist({ width: 1280, height: 720, bandwidthBps: 1, codecs, mediaPlaylistUrl: 'u' });

      expect(playlist).toContain('#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720\n');
      expect(playlist).not.toContain('CODECS');
    });

    it('ends with a newline', () => {
      expect(buildHlsMasterPlaylist({ width: 1, height: 1, bandwidthBps: 1, mediaPlaylistUrl: 'u' }).endsWith('\n')).toBe(true);
    });
  });

  describe('buildHlsTopLevelPlaylistResponse', () => {
    let deps;

    beforeEach(() => {
      jest.clearAllMocks();
      deps = {
        enabled: true,
        youtubeId: 'abc',
        quality: '1080',
        transcode: 'h264',
        hardwareMode: 'none',
        models: { marker: true },
        mediaPlaylistUrl: 'http://h/playlist.m3u8',
        rewrittenMediaPlaylist: '#EXTM3U\nmedia',
        resolveVideoTargetResolution: jest.fn().mockResolvedValue({ width: 3840, height: 2160 }),
        capResolutionToHeight: jest.fn((w, h, cap) => ({ width: 1920, height: cap })),
        resolveQualityHeight: jest.fn().mockReturnValue(1080),
      };
    });

    it('returns the media playlist untouched when the master playlist is disabled', async () => {
      deps.enabled = false;

      await expect(buildHlsTopLevelPlaylistResponse(deps)).resolves.toBe('#EXTM3U\nmedia');
      expect(deps.resolveVideoTargetResolution).not.toHaveBeenCalled();
    });

    it('saves a debug copy of the media playlist when disabled', async () => {
      deps.enabled = false;

      await buildHlsTopLevelPlaylistResponse(deps);

      expect(maybeSaveDebugPlaylistCopy).toHaveBeenCalledWith({ youtubeId: 'abc', kind: 'media', content: '#EXTM3U\nmedia' });
    });

    it('wraps the media playlist in a master playlist sized to the capped resolution', async () => {
      const result = await buildHlsTopLevelPlaylistResponse(deps);

      expect(result).toContain('RESOLUTION=1920x1080');
      expect(result).toContain('BANDWIDTH=10192000');
      expect(result).toContain('http://h/playlist.m3u8');
    });

    it('resolves the source resolution for the video and caps it to the requested quality', async () => {
      await buildHlsTopLevelPlaylistResponse(deps);

      expect(deps.resolveVideoTargetResolution).toHaveBeenCalledWith('abc', { marker: true });
      expect(deps.resolveQualityHeight).toHaveBeenCalledWith('1080');
      expect(deps.capResolutionToHeight).toHaveBeenCalledWith(3840, 2160, 1080);
    });

    it('declares the codecs for a re-encode', async () => {
      const result = await buildHlsTopLevelPlaylistResponse(deps);

      expect(result).toContain('CODECS="avc1.640028,mp4a.40.2"');
    });

    it('declares the VAAPI constraint flags for a VAAPI encode', async () => {
      deps.hardwareMode = 'vaapi';

      const result = await buildHlsTopLevelPlaylistResponse(deps);

      expect(result).toContain('CODECS="avc1.640828,mp4a.40.2"');
    });

    it('declares no codecs for a remux', async () => {
      deps.transcode = 'copy';

      const result = await buildHlsTopLevelPlaylistResponse(deps);

      expect(result).not.toContain('CODECS');
    });

    it('sizes bandwidth from the capped height, not the source height', async () => {
      deps.resolveQualityHeight.mockReturnValue(480);
      deps.capResolutionToHeight.mockReturnValue({ width: 854, height: 480 });

      const result = await buildHlsTopLevelPlaylistResponse(deps);

      expect(result).toContain('BANDWIDTH=3192000');
      expect(result).toContain('RESOLUTION=854x480');
    });

    it('saves a debug copy of the master playlist', async () => {
      const result = await buildHlsTopLevelPlaylistResponse(deps);

      expect(maybeSaveDebugPlaylistCopy).toHaveBeenCalledWith({ youtubeId: 'abc', kind: 'master', content: result });
    });

    it('propagates a failure to resolve the source resolution', async () => {
      deps.resolveVideoTargetResolution.mockRejectedValue(new Error('probe failed'));

      await expect(buildHlsTopLevelPlaylistResponse(deps)).rejects.toThrow('probe failed');
    });
  });
});
