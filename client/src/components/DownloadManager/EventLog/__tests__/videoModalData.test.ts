import { eventToVideoModalData } from '../videoModalData';
import type { JobEvent } from '../../../../types/JobEvent';

const event = (over: Partial<JobEvent> = {}): JobEvent => ({
  id: 1,
  occurredAt: '2026-09-19T17:12:59.566Z',
  jobId: 'job-1',
  youtubeId: 'abc123',
  eventType: 'nzb.untracked',
  level: 'info',
  actor: 'nzb',
  message: 'm',
  detail: null,
  videoTitle: 'Celebrity Juice S26E09',
  channelName: 'pcrobec',
  jobType: 'X',
  ...over,
});

describe('eventToVideoModalData', () => {
  test('carries the video id, title and channel the entry recorded', () => {
    expect(eventToVideoModalData(event())).toMatchObject({
      youtubeId: 'abc123', title: 'Celebrity Juice S26E09', channelName: 'pcrobec',
    });
  });

  test('falls back to the video id as the title when none was recorded', () => {
    expect(eventToVideoModalData(event({ videoTitle: null })).title).toBe('abc123');
  });

  test('uses an empty channel name when none was recorded', () => {
    expect(eventToVideoModalData(event({ channelName: null })).channelName).toBe('');
  });

  test('points at the local thumbnail path', () => {
    expect(eventToVideoModalData(event()).thumbnailUrl).toBe('/images/videothumb-abc123.jpg');
  });

  test('starts as not downloaded, since a log entry holds no library state', () => {
    expect(eventToVideoModalData(event())).toMatchObject({ status: 'never_downloaded', isDownloaded: false, filePath: null });
  });

  test('uses the time of the entry as the added time', () => {
    expect(eventToVideoModalData(event()).addedAt).toBe('2026-09-19T17:12:59.566Z');
  });

  test('has no database id', () => {
    expect(eventToVideoModalData(event()).databaseId).toBeNull();
  });
});
