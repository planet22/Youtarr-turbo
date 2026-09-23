import {
  componentAbbr,
  componentLabel,
  dayEndIso,
  dayStartIso,
  EVENT_LEVEL_OPTIONS,
  eventLevelColor,
  formatEventDelta,
  formatEventTime,
  formatEventTimeParts,
  MESSAGE_PREVIEW_LENGTH,
  previewMessage,
  stepLabel,
} from '../eventLogFormat';

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

describe('tracked labels', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { trackedLabel, TRACKED_OPTIONS } = require('../eventLogFormat');

  test.each([[true, 'Yes'], [false, 'No'], [null, '']])('labels %p as %p', (value, label) => {
    expect(trackedLabel(value)).toBe(label);
  });

  test('offers tracked and untracked as filter options', () => {
    expect(TRACKED_OPTIONS).toEqual(['tracked', 'untracked']);
  });
});

describe('detail formatting', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { detailLabel, describeDetailEntries } = require('../eventLogFormat');

  test('turns a camelCase key into a readable label', () => {
    expect(detailLabel('diagnosisMessage')).toBe('Diagnosis message');
  });

  test('keeps the capitals of an abbreviation in a key', () => {
    expect(detailLabel('avgDownloadMBps')).toBe('Avg download MBps');
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

  test('formats a download speed', () => {
    expect(describeDetailEntries({ avgDownloadMBps: 5.5 })).toEqual([{ label: 'Avg download MBps', value: '5.5 MB/s' }]);
  });

  test('shows a zero download speed as a plain number', () => {
    expect(describeDetailEntries({ avgDownloadMBps: 0 })).toEqual([{ label: 'Avg download MBps', value: '0' }]);
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

describe('stepLabel', () => {
  test.each([
    ['video.download_started', 'download started'],
    ['job.finished', 'finished'],
    ['strm.created', 'strm created'],
    ['nzb.import_detected', 'nzb import detected'],
    ['cache.hls_buffer_finalized', 'cache hls buffer finalized'],
  ])('shows %s as %s', (type, label) => {
    expect(stepLabel(type)).toBe(label);
  });

  test('leaves a type with no family as it is', () => {
    expect(stepLabel('started')).toBe('started');
  });
});

describe('componentLabel', () => {
  test.each([
    ['downloader', 'Downloader'],
    ['library', 'Video library'],
    ['media-server', 'Media server'],
    ['ytstream', 'Streaming'],
    ['nzb', 'NZB'],
    ['strm', 'STRM'],
    ['youtube', 'YouTube'],
    ['strm-cache-expiry', 'STRM cache expiry'],
    ['maintenance', 'Maint.'],
  ])('shows %s as %s', (actor, label) => {
    expect(componentLabel(actor)).toBe(label);
  });

  test('reads an unlisted component as its own name with dashes as spaces', () => {
    expect(componentLabel('some-new-part')).toBe('Some new part');
  });

  test('is empty when there is no component', () => {
    expect(componentLabel(null)).toBe('');
  });
});

describe('componentAbbr', () => {
  test.each([
    ['downloader', 'DL'],
    ['library', 'Library'],
    ['media-server', 'Media'],
    ['ytstream', 'Stream'],
    ['auto-removal', 'Auto-rm'],
    ['strm-cache-expiry', 'STRM exp.'],
  ])('abbreviates %s to %s', (actor, abbr) => {
    expect(componentAbbr(actor)).toBe(abbr);
  });

  test('falls back to the full label for a component that is already short', () => {
    expect(componentAbbr('nzb')).toBe('NZB');
  });

  test('is empty when there is no component', () => {
    expect(componentAbbr(null)).toBe('');
  });
});

describe('dayStartIso / dayEndIso', () => {
  test('turns a date key into local midnight', () => {
    expect(new Date(dayStartIso('2026-09-19') as string).getTime()).toBe(new Date(2026, 8, 19, 0, 0, 0, 0).getTime());
  });

  test('turns a date key into the last millisecond of that local day', () => {
    expect(new Date(dayEndIso('2026-09-19') as string).getTime()).toBe(new Date(2026, 8, 19, 23, 59, 59, 999).getTime());
  });

  test('is undefined for a malformed date key', () => {
    expect(dayStartIso('not-a-date')).toBeUndefined();
    expect(dayEndIso('not-a-date')).toBeUndefined();
  });
});

describe('formatEventTimeParts', () => {
  test('puts the date on its own, without a time', () => {
    expect(formatEventTimeParts('2026-09-19T17:12:59.566Z').date).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });

  test('puts the time, with milliseconds, on its own', () => {
    expect(formatEventTimeParts('2026-09-19T17:12:59.566Z').time).toMatch(/:\d{2}\.566/);
  });

  test('keeps entries a few milliseconds apart distinguishable', () => {
    expect(formatEventTimeParts('2026-09-19T17:12:59.394Z').time).not.toBe(formatEventTimeParts('2026-09-19T17:12:59.566Z').time);
  });

  test('gives the input back as the date, with no time, when it is not a date', () => {
    expect(formatEventTimeParts('not a date')).toEqual({ date: 'not a date', time: '' });
  });
});

describe('previewMessage', () => {
  test('leaves a short message alone', () => {
    expect(previewMessage('Download started')).toEqual({ text: 'Download started', truncated: false });
  });

  test('leaves a message of exactly the preview length alone', () => {
    expect(previewMessage('x'.repeat(MESSAGE_PREVIEW_LENGTH)).truncated).toBe(false);
  });

  test('cuts a long message at a word', () => {
    const message = 'File finalized at ' + 'word '.repeat(30);
    const { text, truncated } = previewMessage(message);
    expect(truncated).toBe(true);
    expect(text.endsWith('word')).toBe(true);
  });

  test('keeps the preview within the limit', () => {
    expect(previewMessage('word '.repeat(60)).text.length).toBeLessThanOrEqual(MESSAGE_PREVIEW_LENGTH);
  });

  test('cuts a long unbroken string at the limit', () => {
    expect(previewMessage('x'.repeat(300)).text).toBe('x'.repeat(MESSAGE_PREVIEW_LENGTH));
  });

  test('does not leave dangling punctuation on the cut', () => {
    const message = 'a'.repeat(90) + ', ' + 'b'.repeat(50);
    expect(previewMessage(message).text.endsWith(',')).toBe(false);
  });
});
