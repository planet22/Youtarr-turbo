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

  describe('download and failure detail', () => {
    test('video.downloaded shows size, time taken and rate', () => {
      const { message } = describeEvent(EVENT_TYPES.VIDEO_DOWNLOADED, {
        detail: { fileSize: 181, downloadDurationSeconds: 12, avgDownloadMBps: 2.4 },
      });
      expect(message).toBe('Downloaded 181 B in 12s (2.40 MB/s)');
    });

    test('video.downloaded scales the size and the time', () => {
      const { message } = describeEvent(EVENT_TYPES.VIDEO_DOWNLOADED, {
        detail: { fileSize: 5 * 1024 * 1024, downloadDurationSeconds: 125, avgDownloadMBps: 0.04 },
      });
      expect(message).toBe('Downloaded 5.0 MB in 2m 05s (0.04 MB/s)');
    });

    test('video.downloaded copes with only some figures known', () => {
      expect(describeEvent(EVENT_TYPES.VIDEO_DOWNLOADED, { detail: { fileSize: 2048 } }).message).toBe('Downloaded 2.0 KB');
    });

    test('video.downloaded says just "Downloaded" when nothing is known', () => {
      expect(describeEvent(EVENT_TYPES.VIDEO_DOWNLOADED, {}).message).toBe('Downloaded');
    });

    test('video.failed adds the likely cause Download History shows', () => {
      const { message } = describeEvent(EVENT_TYPES.VIDEO_FAILED, {
        detail: { error: 'HTTP Error 403: Forbidden', diagnosisTitle: 'YouTube blocked the download' },
      });
      expect(message).toBe('Download failed - HTTP Error 403: Forbidden (Likely cause: YouTube blocked the download)');
    });

    test('video.failed with no diagnosis shows only the error', () => {
      expect(describeEvent(EVENT_TYPES.VIDEO_FAILED, { detail: { error: 'boom' } }).message).toBe('Download failed - boom');
    });

    test('the hls buffer message includes the transfer rate', () => {
      const { message } = describeEvent(EVENT_TYPES.CACHE_HLS_BUFFER_FINALIZED, {
        detail: { fileSize: 2048, downloadDurationSeconds: 4, avgDownloadMBps: 0.5, filePath: '/c/x.ts' },
      });
      expect(message).toBe('HLS buffer saved 2.0 KB in 4s (0.50 MB/s) to /c/x.ts');
    });

    test('cache.deleted says how much was freed and why', () => {
      const { message } = describeEvent(EVENT_TYPES.CACHE_DELETED, { detail: { freedBytes: 3 * 1024 * 1024, reason: 'expired hidden cache' } });
      expect(message).toBe('Hidden cache file deleted (freed 3.0 MB) - expired hidden cache');
    });
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

describe('file, STRM and cache steps', () => {
  const msg = (type, detail) => describeEvent(type, { detail }).message;

  test('video.transcoded names the codec and the original file', () => {
    expect(msg(EVENT_TYPES.VIDEO_TRANSCODED, { codec: 'h264', from: 'a.webm' })).toBe('Transcoded after download to h264 (from a.webm)');
  });

  test('video.marked_missing is a warning that names the file', () => {
    const result = describeEvent(EVENT_TYPES.VIDEO_MARKED_MISSING, { detail: { filePath: '/lib/x.mp4' } });
    expect(result).toMatchObject({ level: 'warn', message: 'Video file not found on disk, marked missing (/lib/x.mp4)' });
  });

  test('video.restored names the file', () => {
    expect(msg(EVENT_TYPES.VIDEO_RESTORED, { filePath: '/lib/x.mp4' })).toBe('Video file found again on disk (/lib/x.mp4)');
  });

  test('strm.archived names the archived file', () => {
    expect(msg(EVENT_TYPES.STRM_ARCHIVED, { path: '/lib/x.strm' })).toBe('STRM file archived after a real download replaced it (/lib/x.strm)');
  });

  test('cache.fetch_started says the hidden cache is being created, with quality', () => {
    expect(msg(EVENT_TYPES.CACHE_FETCH_STARTED, { quality: '1080' })).toBe('Hidden cache being created (buffer fetch started) at quality 1080');
  });

  test('log.cleared is a warning saying how many events were removed', () => {
    const result = describeEvent(EVENT_TYPES.LOG_CLEARED, { detail: { deletedCount: 12 } });
    expect(result).toMatchObject({ level: 'warn', actor: 'maintenance', message: 'Event log cleared (12 events removed)' });
  });
});

describe('protection, ignore and YouTube availability', () => {
  test.each([
    ['video.protected', 'Video protected from automatic removal'],
    ['video.unprotected', 'Video protection removed'],
    ['video.ignored', 'Video ignored - it will not be downloaded'],
    ['video.unignored', 'Video no longer ignored'],
  ])('%s says what happened', (type, message) => {
    expect(describeEvent(type, {}).message).toBe(message);
  });

  test('video.unavailable_on_youtube is a warning', () => {
    expect(describeEvent(EVENT_TYPES.VIDEO_UNAVAILABLE_ON_YOUTUBE, {})).toMatchObject({
      level: 'warn', message: 'Video is no longer available on YouTube',
    });
  });
});
