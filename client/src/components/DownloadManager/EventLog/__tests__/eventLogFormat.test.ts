import { EVENT_LEVEL_OPTIONS, eventLevelColor, formatEventDelta, formatEventTime } from '../eventLogFormat';

describe('eventLogFormat', () => {
  describe('formatEventTime', () => {
    test('shows milliseconds', () => {
      expect(formatEventTime('2026-09-19T17:12:59.566Z')).toMatch(/\.566/);
    });

    test('keeps entries a few milliseconds apart distinguishable', () => {
      expect(formatEventTime('2026-09-19T17:12:59.394Z')).not.toBe(formatEventTime('2026-09-19T17:12:59.566Z'));
    });

    test('returns the input unchanged when it is not a date', () => {
      expect(formatEventTime('not a date')).toBe('not a date');
    });
  });

  describe('formatEventDelta', () => {
    const base = '2026-09-19T17:12:00.000Z';

    test('shows milliseconds under a second', () => {
      expect(formatEventDelta(base, '2026-09-19T17:12:00.045Z')).toBe('+45 ms');
    });

    test('shows zero for identical timestamps', () => {
      expect(formatEventDelta(base, base)).toBe('+0 ms');
    });

    test('shows seconds with milliseconds under a minute', () => {
      expect(formatEventDelta(base, '2026-09-19T17:12:01.234Z')).toBe('+1.234 s');
    });

    test('shows minutes and zero-padded seconds from a minute up', () => {
      expect(formatEventDelta(base, '2026-09-19T17:14:03.900Z')).toBe('+2m 03s');
    });

    test('is null when the order is reversed', () => {
      expect(formatEventDelta('2026-09-19T17:12:05.000Z', base)).toBeNull();
    });

    test('is null when a timestamp is invalid', () => {
      expect(formatEventDelta('nope', base)).toBeNull();
    });
  });

  describe('eventLevelColor', () => {
    test('maps error to the error color', () => {
      expect(eventLevelColor('error')).toBe('error');
    });

    test('maps warn to the warning color', () => {
      expect(eventLevelColor('warn')).toBe('warning');
    });

    test('maps info to the default color', () => {
      expect(eventLevelColor('info')).toBe('default');
    });

    test('maps an unknown level to the default color', () => {
      expect(eventLevelColor('mystery')).toBe('default');
    });
  });

  test('level options start with an empty "all levels" choice', () => {
    expect(EVENT_LEVEL_OPTIONS[0]).toEqual({ value: '', label: 'All levels' });
  });
});

describe('detail formatting', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { detailLabel, describeDetailEntries } = require('../eventLogFormat');

  test('turns a camelCase key into a readable label', () => {
    expect(detailLabel('diagnosisMessage')).toBe('Diagnosis message');
  });

  test('labels a single word', () => {
    expect(detailLabel('error')).toBe('Error');
  });

  test('formats a file size as bytes', () => {
    expect(describeDetailEntries({ fileSize: 2048 })).toEqual([{ label: 'File size', value: '2.0 KB' }]);
  });

  test('formats a duration in seconds', () => {
    expect(describeDetailEntries({ downloadDurationSeconds: 12 })).toEqual([{ label: 'Download duration seconds', value: '12s' }]);
  });

  test('shows text values as they are', () => {
    expect(describeDetailEntries({ error: 'HTTP 403' })).toEqual([{ label: 'Error', value: 'HTTP 403' }]);
  });

  test('shows nested values as JSON', () => {
    expect(describeDetailEntries({ counts: { a: 1 } })).toEqual([{ label: 'Counts', value: '{"a":1}' }]);
  });

  test('drops empty values', () => {
    expect(describeDetailEntries({ a: null, b: undefined, c: '' })).toEqual([]);
  });

  test('has nothing to show when there is no detail', () => {
    expect(describeDetailEntries(null)).toEqual([]);
  });
});
