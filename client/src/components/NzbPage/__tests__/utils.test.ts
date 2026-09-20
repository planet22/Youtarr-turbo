import {
  formatDurationMs,
  formatRelativeTime,
  formatResolutionStats,
  formatResolutionBreakdown,
  formatCountdown,
} from '../utils';
import { NzbSearchTraceItem } from '../../../hooks/useNzbStats';

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

const item = (overrides: Partial<NzbSearchTraceItem> = {}): NzbSearchTraceItem => ({
  youtubeId: 'abc123DEF45',
  title: 'T',
  kept: true,
  reason: null,
  matchedTerm: null,
  effectiveHeightTier: 1080,
  resolutionSource: 'thumb',
  ...overrides,
});

describe('formatDurationMs', () => {
  it.each([
    [0, '0ms'],
    [250, '250ms'],
    [999, '999ms'],
    [1000, '1.0s'],
    [1500, '1.5s'],
    [12345, '12.3s'],
  ])('formats %ims as %s', (ms, expected) => {
    expect(formatDurationMs(ms)).toBe(expected);
  });

  it('rounds a fractional millisecond value', () => {
    expect(formatDurationMs(12.6)).toBe('13ms');
  });
});

describe('formatRelativeTime', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([
    [0, 'just now'],
    [4_000, 'just now'],
    [5_000, '5s ago'],
    [59_000, '59s ago'],
    [60_000, '1m ago'],
    [45 * 60_000, '45m ago'],
    [3 * 3_600_000, '3h ago'],
    [23 * 3_600_000, '23h ago'],
    [24 * 3_600_000, '1d ago'],
    [72 * 3_600_000, '3d ago'],
  ])('shows %ims ago as %s', (ago, expected) => {
    expect(formatRelativeTime(NOW - ago)).toBe(expected);
  });

  it('treats a future timestamp as just now', () => {
    expect(formatRelativeTime(NOW + 60_000)).toBe('just now');
  });
});

describe('formatResolutionStats', () => {
  it('combines the duration and query count', () => {
    expect(formatResolutionStats(1500, 8)).toBe('1.5s (8)');
  });

  it('shows a dash when the duration is unknown', () => {
    expect(formatResolutionStats(undefined, 3)).toBe('-');
  });

  it('shows a dash when the query count is unknown', () => {
    expect(formatResolutionStats(500, undefined)).toBe('-');
  });

  it('still shows a zero count', () => {
    expect(formatResolutionStats(0, 0)).toBe('0ms (0)');
  });
});

describe('formatResolutionBreakdown', () => {
  it('returns null without items', () => {
    expect(formatResolutionBreakdown(undefined)).toBeNull();
    expect(formatResolutionBreakdown([])).toBeNull();
  });

  it('tallies each source', () => {
    const items = [
      item({ resolutionSource: 'metadataCache' }),
      item({ resolutionSource: 'thumb' }),
      item({ resolutionSource: 'thumb' }),
      item({ resolutionSource: 'extract' }),
    ];

    expect(formatResolutionBreakdown(items)).toBe('Cache: 1 · Thumb: 2 · Extract: 1');
  });

  it('shows a dash for a source that resolved nothing', () => {
    expect(formatResolutionBreakdown([item({ resolutionSource: 'thumb' })])).toBe('Cache: - · Thumb: 1 · Extract: -');
  });

  it.each(['fixed', 'api'] as const)('does not count %s items, which never reach the probe', (source) => {
    const items = [item({ resolutionSource: source }), item({ resolutionSource: 'thumb' })];

    expect(formatResolutionBreakdown(items)).toBe('Cache: - · Thumb: 1 · Extract: -');
  });

  it('skips items that never got a resolved height', () => {
    const items = [item({ effectiveHeightTier: null }), item({ effectiveHeightTier: undefined, resolutionSource: 'extract' })];

    expect(formatResolutionBreakdown(items)).toBeNull();
  });

  it('returns null when every item was settled by fixed or api', () => {
    expect(formatResolutionBreakdown([item({ resolutionSource: 'fixed' }), item({ resolutionSource: 'api' })])).toBeNull();
  });

  it('ignores items with no source', () => {
    expect(formatResolutionBreakdown([item({ resolutionSource: null })])).toBeNull();
  });
});

describe('formatCountdown', () => {
  it.each([
    [0, 'expired'],
    [-500, 'expired'],
    [1000, '1s'],
    [45_000, '45s'],
    [59_400, '59s'],
    [60_000, '1m 0s'],
    [125_000, '2m 5s'],
    [3_600_000, '60m 0s'],
  ])('formats %ims as %s', (ms, expected) => {
    expect(formatCountdown(ms)).toBe(expected);
  });
});
