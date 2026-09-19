import { buildForcedSettingsSummary } from '../settingsSummary';
import type { YtstreamSummaryInput } from '../settingsSummary';
import type { YtstreamModeCompatibility } from '../../../Configuration/hooks/useYtstreamModeCompatibility';

const base: YtstreamSummaryInput = { forceServerSettings: true, defaultMode: 'hls', quality: '1080', qualityStrictness: 'fallback', container: 'mp4', transcode: 'copy' };
const optional = { status: 'optional' as const };
const hlsCompat: YtstreamModeCompatibility = { container: optional, transcode: optional, hardwareMode: optional, tuning: optional, calculatedLength: optional };
const ignored = { status: 'ignored' as const };

const labels = (items: ReturnType<typeof buildForcedSettingsSummary>) => (items || []).map((item) => item.label);
const valueOf = (items: ReturnType<typeof buildForcedSettingsSummary>, label: string) => (items || []).find((item) => item.label === label)?.value;

describe('buildForcedSettingsSummary', () => {
  it('shows nothing when server settings are not forced', () => {
    expect(buildForcedSettingsSummary({ ...base, forceServerSettings: false }, hlsCompat)).toBeNull();
  });

  it('shows nothing before the config has loaded', () => {
    expect(buildForcedSettingsSummary(undefined, {})).toBeNull();
  });

  it('always includes the mode and quality', () => {
    expect(labels(buildForcedSettingsSummary(base, {}))).toEqual(['Mode', 'Quality']);
  });

  it('labels the mode and formats a numeric quality with its strictness', () => {
    const items = buildForcedSettingsSummary(base, {});
    expect([valueOf(items, 'Mode'), valueOf(items, 'Quality')]).toEqual(['HLS', '1080p (fallback)']);
  });

  it('shows a non-numeric quality as it is', () => {
    expect(valueOf(buildForcedSettingsSummary({ ...base, quality: 'best' }, {}), 'Quality')).toBe('best (fallback)');
  });

  it('includes container and transcode for a mode where they are optional', () => {
    expect(labels(buildForcedSettingsSummary(base, hlsCompat))).toEqual(expect.arrayContaining(['Container', 'Transcode']));
  });

  it('leaves out the settings the mode ignores', () => {
    const compat: YtstreamModeCompatibility = { container: ignored, transcode: ignored, hardwareMode: ignored, tuning: ignored, calculatedLength: ignored };
    expect(labels(buildForcedSettingsSummary({ ...base, defaultMode: 'direct' }, compat))).toEqual(['Mode', 'Quality']);
  });

  it('shows hardware and tuning only when transcoding to H.264', () => {
    expect(labels(buildForcedSettingsSummary({ ...base, transcode: 'h264', hardwareMode: 'vaapi', tuning: 'quality' }, hlsCompat))).toEqual(expect.arrayContaining(['Hardware', 'Tuning']));
    expect(labels(buildForcedSettingsSummary(base, hlsCompat))).not.toContain('Hardware');
  });

  it('shows a required calculated length as on (required)', () => {
    expect(valueOf(buildForcedSettingsSummary(base, { calculatedLength: { status: 'forced' } }), 'Calculated length')).toBe('on (required)');
  });

  it('shows an optional calculated length as its setting', () => {
    expect(valueOf(buildForcedSettingsSummary({ ...base, calculatedLength: true }, hlsCompat), 'Calculated length')).toBe('on');
  });

  describe('byte-range plain file', () => {
    const plain: YtstreamSummaryInput = { ...base, defaultMode: 'hls-byterange', byteRangeDeliverAsFile: true, container: 'mkv', transcode: 'copy', byteRangeResumeCache: true };

    it('is named as the plain file variant', () => {
      expect(valueOf(buildForcedSettingsSummary(plain, {}), 'Mode')).toBe('Byte-range Plain file');
    });

    it('shows the Matroska or MP4 container even though the mode table ignores it', () => {
      expect(valueOf(buildForcedSettingsSummary(plain, { container: ignored }), 'Container')).toBe('Matroska');
    });

    it('shows the resume setting', () => {
      expect(valueOf(buildForcedSettingsSummary(plain, {}), 'Resume partial cache')).toBe('on');
    });

    it('shows the transcode setting, which this mode uses', () => {
      expect(valueOf(buildForcedSettingsSummary(plain, {}), 'Transcode')).toBe('Copy');
    });

    it('does not show the container for the manifest variant', () => {
      expect(labels(buildForcedSettingsSummary({ ...plain, byteRangeDeliverAsFile: false }, { container: ignored }))).not.toContain('Container');
    });
  });

  describe('youtube-hls', () => {
    const yt: YtstreamSummaryInput = { ...base, defaultMode: 'youtube-hls', audioLanguage: 'de' };
    const ytCompat: YtstreamModeCompatibility = { container: ignored, transcode: ignored, hardwareMode: ignored, tuning: ignored };

    it('shows the audio language', () => {
      expect(valueOf(buildForcedSettingsSummary(yt, ytCompat), 'Audio language')).toBe('de');
    });

    it('shows original when no language is set', () => {
      expect(valueOf(buildForcedSettingsSummary({ ...yt, audioLanguage: ' ' }, ytCompat), 'Audio language')).toBe('original');
    });

    it('leaves out container and transcode, which it ignores', () => {
      expect(labels(buildForcedSettingsSummary(yt, ytCompat))).toEqual(['Mode', 'Quality', 'Audio language', 'Routing']);
    });

    it('shows playback going straight to YouTube by default', () => {
      expect(valueOf(buildForcedSettingsSummary(yt, ytCompat), 'Routing')).toBe('direct to YouTube');
    });

    it('shows playlists routed through Youtarr', () => {
      expect(valueOf(buildForcedSettingsSummary({ ...yt, youtubeHlsProxy: 'proxy' }, ytCompat), 'Routing')).toBe('playlists via Youtarr');
    });

    it('shows segments routed through Youtarr too', () => {
      expect(valueOf(buildForcedSettingsSummary({ ...yt, youtubeHlsProxy: 'serve' }, ytCompat), 'Routing')).toBe('playlists + segments via Youtarr');
    });
  });
});
