import {
  parseClientLabel,
  isLikelyProbeRequest,
  formatModeLabel,
  formatModeChipLabel,
  modeChipColor,
  formatChipColor,
  formatElapsed,
  MODE_LABELS,
  STREAM_MODE_OPTIONS,
  ACTUAL_FILE_MODES,
} from '../utils';

describe('parseClientLabel', () => {
  it.each([undefined, null, ''])('labels a missing user agent (%p) as unknown', (ua) => {
    expect(parseClientLabel(ua)).toBe('Unknown client');
  });

  it.each([
    ['Jellyfin-Server/10.9.0', 'Jellyfin'],
    ['VLC/3.0.20 LibVLC/3.0.20', 'VLC'],
    ['curl/8.4.0', 'curl'],
    ['Wget/1.21', 'wget'],
    ['Kodi/20.2 (Windows)', 'Kodi'],
    ['Infuse/7.6', 'Infuse'],
    ['Mozilla/5.0 Chrome/120 Safari/537.36 Edg/120.0', 'Edge'],
    ['Mozilla/5.0 Gecko/20100101 Firefox/121.0', 'Firefox'],
    ['Mozilla/5.0 AppleWebKit Chrome/120 Safari/537.36', 'Chrome'],
    ['Mozilla/5.0 AppleWebKit Version/17 Safari/605', 'Safari'],
  ])('recognises %s as %s', (ua, expected) => {
    expect(parseClientLabel(ua)).toBe(expected);
  });

  it('checks Edge before Chrome, since Edge also advertises Chrome', () => {
    expect(parseClientLabel('Chrome/120 Edg/120')).toBe('Edge');
  });

  it('checks Chrome before Safari, since Chrome also advertises Safari', () => {
    expect(parseClientLabel('Chrome/120 Safari/537')).toBe('Chrome');
  });

  it('matches case-insensitively', () => {
    expect(parseClientLabel('JELLYFIN')).toBe('Jellyfin');
  });

  it('falls back to the product token of an unrecognised agent', () => {
    expect(parseClientLabel('Youtarr-Playback/1.0')).toBe('Youtarr-Playback');
  });

  it('uses the libavformat token for a bare Lavf agent', () => {
    expect(parseClientLabel('Lavf/61.7.103')).toBe('Lavf');
  });

  it('stops the product token at a space', () => {
    expect(parseClientLabel('MyPlayer 2.0')).toBe('MyPlayer');
  });

  it('stops the product token at a parenthesis', () => {
    expect(parseClientLabel('Thing(v2)')).toBe('Thing');
  });

  it('ignores leading whitespace when reading the product token', () => {
    expect(parseClientLabel('  Custom/1')).toBe('Custom');
  });

  it('falls back to unknown when there is no usable token', () => {
    expect(parseClientLabel('(weird)')).toBe('Unknown client');
  });
});

describe('isLikelyProbeRequest', () => {
  it('flags a bare libavformat agent', () => {
    expect(isLikelyProbeRequest('Lavf/61.7.103')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isLikelyProbeRequest('lavf/58.0')).toBe(true);
  });

  it('does not flag an agent that merely contains Lavf', () => {
    expect(isLikelyProbeRequest('Something Lavf/1.0')).toBe(false);
  });

  it('does not flag a real client', () => {
    expect(isLikelyProbeRequest('Jellyfin/10.9')).toBe(false);
  });

  it.each([undefined, null, ''])('does not flag %p', (ua) => {
    expect(isLikelyProbeRequest(ua)).toBe(false);
  });
});

describe('formatModeLabel', () => {
  it.each(Object.entries(MODE_LABELS))('labels %s as %s', (mode, label) => {
    expect(formatModeLabel(mode)).toBe(label);
  });

  it('returns an unknown mode unchanged rather than mislabelling it', () => {
    expect(formatModeLabel('brand-new-mode')).toBe('brand-new-mode');
  });

  it('lists every labelled mode as a filter option', () => {
    expect(STREAM_MODE_OPTIONS).toEqual(Object.keys(MODE_LABELS));
  });
});

describe('formatModeChipLabel', () => {
  it.each([
    ['hls-buffer', 'HLS+Buf'],
    ['direct-redirect', 'Direct (redir)'],
    ['cached-file', 'Cached'],
    ['probe-cache-hit', 'Probe'],
    ['probe-shortcut', 'Probe'],
    ['byterange-cache-hit', 'Cached'],
  ])('shortens %s to %s', (mode, label) => {
    expect(formatModeChipLabel(mode)).toBe(label);
  });

  it('uses the full label for a mode with no short form', () => {
    expect(formatModeChipLabel('hls')).toBe('HLS');
  });

  it('falls back to the raw mode for an unknown one', () => {
    expect(formatModeChipLabel('mystery')).toBe('mystery');
  });
});

describe('modeChipColor', () => {
  it.each([...ACTUAL_FILE_MODES, 'byterange-cache-hit'])('marks the already-downloaded mode %s as success', (mode) => {
    expect(modeChipColor(mode)).toBe('success');
  });

  it.each(['hls', 'hls-buffer'])('marks the live-encode mode %s as info', (mode) => {
    expect(modeChipColor(mode)).toBe('info');
  });

  it.each(['direct', 'direct-redirect', 'unknown'])('leaves %s uncoloured', (mode) => {
    expect(modeChipColor(mode)).toBe('default');
  });
});

describe('formatChipColor', () => {
  it.each([null, undefined, '', 'copy'])('leaves a %p transcode uncoloured', (transcode) => {
    expect(formatChipColor(transcode, 'vaapi')).toBe('default');
  });

  it('marks a hardware h264 transcode as success', () => {
    expect(formatChipColor('h264', 'vaapi')).toBe('success');
  });

  it.each([null, undefined, '', 'none'])('flags a software h264 transcode (hardware %p) as a warning', (hardware) => {
    expect(formatChipColor('h264', hardware)).toBe('warning');
  });

  it('marks any other transcode as info', () => {
    expect(formatChipColor('hevc', 'none')).toBe('info');
  });
});

describe('formatElapsed', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);

  it('shows minutes and padded seconds under an hour', () => {
    expect(formatElapsed(now - 65_000, now)).toBe('1:05');
  });

  it('shows zero elapsed as 0:00', () => {
    expect(formatElapsed(now, now)).toBe('0:00');
  });

  it('adds hours with padded minutes once past an hour', () => {
    expect(formatElapsed(now - (3600 + 5 * 60 + 9) * 1000, now)).toBe('1:05:09');
  });

  it('never goes negative when the start is in the future', () => {
    expect(formatElapsed(now + 10_000, now)).toBe('0:00');
  });

  it('ignores fractional seconds', () => {
    expect(formatElapsed(now - 1999, now)).toBe('0:01');
  });

  it('defaults to the current time', () => {
    jest.useFakeTimers().setSystemTime(now);
    try {
      expect(formatElapsed(now - 90_000)).toBe('1:30');
    } finally {
      jest.useRealTimers();
    }
  });
});
