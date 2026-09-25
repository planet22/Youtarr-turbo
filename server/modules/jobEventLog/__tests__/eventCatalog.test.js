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

  test('video.file_finalized shows the path relative to the download folder', () => {
    expect(msg(EVENT_TYPES.VIDEO_FILE_FINALIZED, { filePath: '/usr/src/app/data/__Series/Show/Season 1/Ep [abc123DEF45].mp4' }))
      .toBe('File finalized at __Series/Show/Season 1/Ep [abc123DEF45].mp4');
  });

  test('a path outside the download folder is shown in full', () => {
    expect(msg(EVENT_TYPES.VIDEO_FILE_FINALIZED, { filePath: '/elsewhere/x.mp4' })).toBe('File finalized at /elsewhere/x.mp4');
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

describe('long errors stay out of the main line', () => {
  const failed = (error, extra = {}) => describeEvent(EVENT_TYPES.VIDEO_FAILED, { detail: { error, ...extra } }).message;
  const LONG = 'Failed to fetch video metadata: ERROR: [youtube] VyJRZmWDIps: Sign in to confirm your age. Use --cookies-from-browser or --cookies for the authentication.';

  test('a short error is shown in the message', () => {
    expect(failed('Video unavailable')).toBe('Download failed - Video unavailable');
  });

  test('an error of exactly 100 characters is still shown', () => {
    const hundred = 'x'.repeat(100);
    expect(failed(hundred)).toBe('Download failed - ' + hundred);
  });

  test('an error over 100 characters is left out of the message', () => {
    expect(failed('x'.repeat(101))).toBe('Download failed');
  });

  test('a yt-dlp style paragraph is left out of the message', () => {
    expect(failed(LONG)).toBe('Download failed');
  });

  test('a multi-line error is left out even when short', () => {
    expect(failed('first line\nsecond line')).toBe('Download failed');
  });

  test('the likely cause still shows when the error is left out', () => {
    expect(failed(LONG, { diagnosisTitle: 'Age-restricted video' })).toBe('Download failed (Likely cause: Age-restricted video)');
  });

  test('a short error and a likely cause show together', () => {
    expect(failed('HTTP 403', { diagnosisTitle: 'Blocked' })).toBe('Download failed - HTTP 403 (Likely cause: Blocked)');
  });

  test('a long job reason is left out of the job.finished message', () => {
    const message = describeEvent(EVENT_TYPES.JOB_FINISHED, { detail: { status: 'Error', reason: 'y'.repeat(300) } }).message;
    expect(message).toBe('Job finished: Error');
  });

  test('a short job reason is shown in the job.finished message', () => {
    const message = describeEvent(EVENT_TYPES.JOB_FINISHED, { detail: { status: 'Terminated', reason: 'Stopped by user' } }).message;
    expect(message).toBe('Job finished: Terminated - Stopped by user');
  });

  test('a long untrack failure is left out of its message', () => {
    expect(describeEvent(EVENT_TYPES.NZB_UNTRACK_FAILED, { detail: { error: 'z'.repeat(200) } }).message)
      .toBe('Could not remove from the Youtarr library');
  });
});

describe('rating, move and playlist steps', () => {
  const msg = (type, detail) => describeEvent(type, { detail }).message;

  test('video.rating_changed shows the previous and new rating', () => {
    expect(msg(EVENT_TYPES.VIDEO_RATING_CHANGED, { previousRating: 'PG', rating: 'R' })).toBe('Rating changed from PG to R');
  });

  test('video.rating_changed says "none" when there was no previous rating', () => {
    expect(msg(EVENT_TYPES.VIDEO_RATING_CHANGED, { rating: 'R' })).toBe('Rating changed from none to R');
  });

  test('video.rating_changed says "none" when the rating was cleared', () => {
    expect(msg(EVENT_TYPES.VIDEO_RATING_CHANGED, { previousRating: 'PG' })).toBe('Rating changed from PG to none');
  });

  test('video.moved shows where the file went and where it was', () => {
    expect(msg(EVENT_TYPES.VIDEO_MOVED, { from: '/a/x.mp4', to: '/b/x.mp4' })).toBe('Video file moved to /b/x.mp4 (from /a/x.mp4)');
  });

  test('playlist.synced says created on the first sync', () => {
    expect(msg(EVENT_TYPES.PLAYLIST_SYNCED, { playlistTitle: 'My PL', server: 'Plex', created: true, itemCount: 3 }))
      .toBe('Playlist "My PL" created on Plex (3 items)');
  });

  test('playlist.synced says updated on a later sync', () => {
    expect(msg(EVENT_TYPES.PLAYLIST_SYNCED, { playlistTitle: 'My PL', server: 'Plex', created: false, itemCount: 3 }))
      .toBe('Playlist "My PL" updated on Plex (3 items)');
  });

  test('playlist.item_added names the playlist and server', () => {
    expect(msg(EVENT_TYPES.PLAYLIST_ITEM_ADDED, { playlistTitle: 'My PL', server: 'Plex' })).toBe('Added to playlist "My PL" on Plex');
  });

  test('playlist.item_removed names the playlist and server', () => {
    expect(msg(EVENT_TYPES.PLAYLIST_ITEM_REMOVED, { playlistTitle: 'My PL', server: 'Plex' })).toBe('Removed from playlist "My PL" on Plex');
  });

  describe('recreated, interrupted and playback-cache events', () => {
    const say = (type, detail) => describeEvent(type, { detail }).message;

    test('says a recreated video came back from the archive', () => {
      expect(say(EVENT_TYPES.VIDEO_RECREATED, { hasFile: true })).toBe('Video re-added to the library from the download archive');
    });

    test('says when the recreated video has no file on disk', () => {
      expect(say(EVENT_TYPES.VIDEO_RECREATED, { hasFile: false })).toBe('Video re-added to the library from the download archive (no file found on disk)');
    });

    test('warns when a download was interrupted', () => {
      expect(describeEvent(EVENT_TYPES.VIDEO_DOWNLOAD_INTERRUPTED, {}).level).toBe('warn');
    });

    test('says partial files were removed', () => {
      expect(say(EVENT_TYPES.VIDEO_DOWNLOAD_INTERRUPTED, {})).toBe('Download interrupted - partial files removed');
    });

    test('says when nothing was left to remove', () => {
      expect(say(EVENT_TYPES.VIDEO_DOWNLOAD_INTERRUPTED, { alreadyRemoved: true })).toBe('Download interrupted - no partial files were left');
    });

    test('says a complete playback cache was saved, with its size', () => {
      expect(say(EVENT_TYPES.CACHE_BYTE_RANGE_SAVED, { complete: true, sizeBytes: 2048 })).toBe('Playback cache saved (complete) - 2.0 KB');
    });

    test('says a resumed partial playback cache was saved', () => {
      expect(say(EVENT_TYPES.CACHE_BYTE_RANGE_SAVED, { complete: false, resumed: true })).toBe('Playback cache saved (partial, after resume)');
    });

    test('says a seekable mp4 was made for playback', () => {
      expect(say(EVENT_TYPES.CACHE_REMUXED, { size: 1024 })).toBe('Seekable .mp4 made for in-app playback of a .ts file (1.0 KB)');
    });
  });
});
