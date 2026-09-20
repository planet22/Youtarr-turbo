const { EVENT_TYPES, EVENT_CATALOG, LEVELS, describeEvent } = require('../eventCatalog');

describe('eventCatalog', () => {
  test('every declared event type has a catalog entry', () => {
    for (const type of Object.values(EVENT_TYPES)) {
      expect(EVENT_CATALOG[type]).toBeDefined();
    }
  });

  test('event type strings are unique', () => {
    const values = Object.values(EVENT_TYPES);
    expect(new Set(values).size).toBe(values.length);
  });

  test('every catalog entry renders a non-empty message with no detail at all', () => {
    for (const type of Object.values(EVENT_TYPES)) {
      expect(describeEvent(type, {}).message.length).toBeGreaterThan(0);
    }
  });

  describe('describeEvent', () => {
    test('falls back to the raw type as the message for an unknown event type', () => {
      expect(describeEvent('made.up_type', {})).toEqual({ actor: null, level: LEVELS.INFO, message: 'made.up_type' });
    });

    test('an explicit message overrides the catalog message', () => {
      expect(describeEvent(EVENT_TYPES.JOB_STARTED, { message: 'custom' }).message).toBe('custom');
    });

    test('an explicit level overrides the catalog level', () => {
      expect(describeEvent(EVENT_TYPES.VIDEO_FAILED, { level: LEVELS.INFO }).level).toBe(LEVELS.INFO);
    });

    test('an explicit actor overrides the catalog actor', () => {
      expect(describeEvent(EVENT_TYPES.JOB_STARTED, { actor: 'me' }).actor).toBe('me');
    });

    test('video.failed defaults to error level', () => {
      expect(describeEvent(EVENT_TYPES.VIDEO_FAILED, { detail: { error: 'HTTP 403' } }).level).toBe(LEVELS.ERROR);
    });

    test('video.failed message includes the error text', () => {
      expect(describeEvent(EVENT_TYPES.VIDEO_FAILED, { detail: { error: 'HTTP 403' } }).message).toBe('Download failed - HTTP 403');
    });

    test('job.finished is error level for an Error status', () => {
      expect(describeEvent(EVENT_TYPES.JOB_FINISHED, { detail: { status: 'Error' } }).level).toBe(LEVELS.ERROR);
    });

    test('job.finished is warn level for a Terminated status', () => {
      expect(describeEvent(EVENT_TYPES.JOB_FINISHED, { detail: { status: 'Terminated' } }).level).toBe(LEVELS.WARN);
    });

    test('job.finished is info level for a Complete status', () => {
      expect(describeEvent(EVENT_TYPES.JOB_FINISHED, { detail: { status: 'Complete' } }).level).toBe(LEVELS.INFO);
    });

    test('job.finished message summarises video, failed and skipped counts', () => {
      const { message } = describeEvent(EVENT_TYPES.JOB_FINISHED, {
        detail: { status: 'Complete with Warnings', videoCount: 1, failedCount: 2, skippedCount: 3 },
      });
      expect(message).toBe('Job finished: Complete with Warnings (1 video, 2 failed, 3 skipped)');
    });

    test('job.created reads "Job queued" for a Pending job', () => {
      expect(describeEvent(EVENT_TYPES.JOB_CREATED, { detail: { status: 'Pending' } }).message).toBe('Job queued');
    });
  });
});
