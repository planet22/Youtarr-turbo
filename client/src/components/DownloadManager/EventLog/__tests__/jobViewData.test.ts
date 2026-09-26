import { buildSwimlanes, buildTimeTicks, groupEventsByJob, groupEventsByVideo } from '../jobViewData';
import type { JobEvent } from '../../../../types/JobEvent';

const at = (ms: number) => new Date(Date.UTC(2026, 8, 21, 20, 0, 0) + ms).toISOString();

const event = (id: number, ms: number, over: Partial<JobEvent> = {}): JobEvent => ({
  id,
  occurredAt: at(ms),
  jobId: 'job-1',
  youtubeId: 'vid-a',
  eventType: 'video.started',
  level: 'info',
  actor: 'downloader',
  message: `Message ${id}`,
  detail: null,
  videoTitle: 'Video A',
  channelName: 'Channel A',
  jobType: 'Channel Downloads',
  source: 'Channels',
  isTracked: true,
  ...over,
});

describe('groupEventsByVideo', () => {
  test('orders groups by when each first appeared, regardless of kind', () => {
    const groups = groupEventsByVideo([
      event(1, 0),
      event(2, 10, { youtubeId: null, videoTitle: null, eventType: 'job.started' }),
    ]);

    expect(groups.map((group) => group.title)).toEqual(['Video A', 'Job: Channel Downloads']);
  });

  test('keeps different jobs separate even when they share a job type', () => {
    const groups = groupEventsByVideo([
      event(1, 0, { jobId: 'job-1', youtubeId: null, videoTitle: null, eventType: 'job.started' }),
      event(2, 10, { jobId: 'job-2', youtubeId: null, videoTitle: null, eventType: 'job.started' }),
    ]);

    expect(groups.map((group) => group.title)).toEqual(['Job: Channel Downloads', 'Job: Channel Downloads']);
    expect(groups[0].key).not.toBe(groups[1].key);
  });

  test('falls back to a bare "Job" title when the job has no recorded type', () => {
    const [group] = groupEventsByVideo([
      event(1, 0, { jobId: 'job-1', youtubeId: null, videoTitle: null, jobType: null, eventType: 'job.started' }),
    ]);

    expect(group.title).toBe('Job');
  });

  test('gives an event with neither a job nor a video its own group, named for its step', () => {
    const groups = groupEventsByVideo([
      event(1, 0, { jobId: null, youtubeId: null, videoTitle: null, eventType: 'log.cleared' }),
    ]);

    expect(groups.map((group) => group.title)).toEqual(['Log cleared']);
  });

  test('keeps two job-less, video-less events in separate groups', () => {
    const groups = groupEventsByVideo([
      event(1, 0, { jobId: null, youtubeId: null, videoTitle: null, eventType: 'log.cleared' }),
      event(2, 10, { jobId: null, youtubeId: null, videoTitle: null, eventType: 'log.cleared' }),
    ]);

    expect(groups).toHaveLength(2);
  });

  test('orders the videos by when their first event happened', () => {
    const groups = groupEventsByVideo([
      event(1, 500, { youtubeId: 'vid-b', videoTitle: 'Video B' }),
      event(2, 100, { youtubeId: 'vid-a' }),
    ]);

    expect(groups.map((group) => group.youtubeId)).toEqual(['vid-a', 'vid-b']);
  });

  test('lists each group\'s events oldest first', () => {
    const [group] = groupEventsByVideo([event(2, 200), event(1, 100), event(3, 300)]);

    expect(group.events.map((e) => e.id)).toEqual([1, 2, 3]);
  });

  test('keeps insertion order for events in the same millisecond', () => {
    const [group] = groupEventsByVideo([event(2, 100), event(1, 100)]);

    expect(group.events.map((e) => e.id)).toEqual([1, 2]);
  });

  test('falls back to the video id when no title was recorded', () => {
    const [group] = groupEventsByVideo([event(1, 0, { videoTitle: null })]);

    expect(group.title).toBe('vid-a');
  });

  test('takes the title from a later event when the first had none', () => {
    const [group] = groupEventsByVideo([event(1, 0, { videoTitle: null }), event(2, 10)]);

    expect(group.title).toBe('Video A');
  });

  test('takes the channel from a later event when the first had none', () => {
    const [group] = groupEventsByVideo([event(1, 0, { channelName: null }), event(2, 10)]);

    expect(group.channelName).toBe('Channel A');
  });

  test('returns nothing for no events', () => {
    expect(groupEventsByVideo([])).toEqual([]);
  });
});

describe('groupEventsByJob', () => {
  test('collapses one job\'s events across multiple videos into a single group', () => {
    const groups = groupEventsByJob([
      event(1, 0, { youtubeId: null, videoTitle: null, eventType: 'job.started' }),
      event(2, 100, { youtubeId: 'vid-a' }),
      event(3, 200, { youtubeId: 'vid-b', videoTitle: 'Video B' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].events).toHaveLength(3);
  });

  test('keeps different jobs in separate groups', () => {
    const groups = groupEventsByJob([
      event(1, 0, { jobId: 'job-1', youtubeId: null, videoTitle: null, eventType: 'job.started' }),
      event(2, 10, { jobId: 'job-2', youtubeId: null, videoTitle: null, eventType: 'job.started' }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0].key).not.toBe(groups[1].key);
  });

  test('titles a job group by its job type', () => {
    const [group] = groupEventsByJob([event(1, 0, { youtubeId: null, videoTitle: null, jobType: 'Manual downloads', eventType: 'job.started' })]);

    expect(group.title).toBe('Job: Manual downloads');
  });

  test('groups a job-less video by video, same as groupEventsByVideo', () => {
    const groups = groupEventsByJob([event(1, 0, { jobId: null })]);

    expect(groups[0].youtubeId).toBe('vid-a');
    expect(groups[0].title).toBe('Video A');
  });

  test('gives a job-less, video-less event its own group', () => {
    const groups = groupEventsByJob([
      event(1, 0, { jobId: null, youtubeId: null, videoTitle: null, eventType: 'log.cleared' }),
      event(2, 10, { jobId: null, youtubeId: null, videoTitle: null, eventType: 'log.cleared' }),
    ]);

    expect(groups).toHaveLength(2);
  });

  test('falls back to a bare "Job" title when the job has no recorded type', () => {
    const [group] = groupEventsByJob([
      event(1, 0, { youtubeId: null, videoTitle: null, jobType: null, eventType: 'job.started' }),
    ]);

    expect(group.title).toBe('Job');
  });

  test('falls back to the video id for a job-less video with no title', () => {
    const [group] = groupEventsByJob([event(1, 0, { jobId: null, videoTitle: null })]);

    expect(group.title).toBe('vid-a');
  });
});

describe('buildSwimlanes', () => {
  test('has no lanes and no axis for no events', () => {
    expect(buildSwimlanes([])).toEqual({ lanes: [], startIso: null, endIso: null });
  });

  test('spans the axis from the first to the last event', () => {
    const { startIso, endIso } = buildSwimlanes([event(2, 5000), event(1, 0)]);

    expect([startIso, endIso]).toEqual([at(0), at(5000)]);
  });

  test('makes one lane per video plus the job', () => {
    const { lanes } = buildSwimlanes([
      event(1, 0, { youtubeId: null, videoTitle: null }),
      event(2, 10),
      event(3, 20, { youtubeId: 'vid-b' }),
    ]);

    expect(lanes).toHaveLength(3);
  });

  test('places events on one shared time axis', () => {
    const { lanes } = buildSwimlanes([
      event(1, 0, { youtubeId: 'vid-a' }),
      event(2, 10000, { youtubeId: 'vid-b' }),
      event(3, 5000, { youtubeId: 'vid-a' }),
    ]);

    const middle = lanes[0].points[1].left;
    expect(middle).toBeGreaterThan(lanes[0].points[0].left);
    expect(middle).toBeLessThan(lanes[1].points[0].left);
  });

  test('keeps every dot inside the plot', () => {
    const { lanes } = buildSwimlanes([event(1, 0), event(2, 1000)]);

    const lefts = lanes[0].points.map((point) => point.left);
    expect(Math.min(...lefts)).toBeGreaterThan(0);
    expect(Math.max(...lefts)).toBeLessThan(100);
  });

  test('spreads events from the same millisecond apart so each stays clickable', () => {
    const { lanes } = buildSwimlanes([event(1, 0), event(2, 0), event(3, 0)]);

    const [a, b, c] = lanes[0].points.map((point) => point.left);
    expect(b - a).toBeGreaterThanOrEqual(1.5);
    expect(c - b).toBeGreaterThanOrEqual(1.5);
  });

  test('keeps the order of events after spreading them', () => {
    const { lanes } = buildSwimlanes([event(1, 0), event(2, 1), event(3, 2), event(4, 100000)]);

    const lefts = lanes[0].points.map((point) => point.left);
    expect([...lefts].sort((x, y) => x - y)).toEqual(lefts);
  });

  test('pulls a crowd at the right edge back inside the plot', () => {
    const { lanes } = buildSwimlanes([event(1, 0), event(2, 100000), event(3, 100000), event(4, 100000)]);

    expect(lanes[0].points[3].left).toBeLessThanOrEqual(98.5);
  });

  test('labels a lane with its video title', () => {
    const { lanes } = buildSwimlanes([event(1, 0)]);

    expect(lanes[0].label).toBe('Video A');
  });

  test('treats an unparseable timestamp as the earliest instant instead of crashing', () => {
    const { lanes } = buildSwimlanes([event(1, 0, { occurredAt: 'not-a-date' }), event(2, 1000)]);

    expect(lanes[0].points.map((point) => point.event.id)).toEqual([1, 2]);
  });
});

describe('buildTimeTicks', () => {
  test('marks the start, midpoint and end', () => {
    const ticks = buildTimeTicks(at(0), at(10000));

    expect(ticks.map((tick) => tick.iso)).toEqual([at(0), at(2500), at(5000), at(7500), at(10000)]);
  });

  test('does not throw when the start instant is unparseable', () => {
    expect(() => buildTimeTicks('not-a-date', at(10000))).not.toThrow();
  });

  test('does not throw when the end instant is unparseable', () => {
    expect(() => buildTimeTicks(at(0), 'not-a-date')).not.toThrow();
  });
});
