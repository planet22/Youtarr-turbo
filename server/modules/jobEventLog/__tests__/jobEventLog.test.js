jest.mock('../../../logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

describe('jobEventLog', () => {
  let jobEventLog;
  let JobEvent;
  let Video;
  let Job;
  let logger;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.doMock('../../../models', () => ({
      JobEvent: {
        create: jest.fn().mockResolvedValue(undefined),
        findAll: jest.fn().mockResolvedValue([]),
        destroy: jest.fn().mockResolvedValue(0),
      },
      Video: { findOne: jest.fn().mockResolvedValue(null), findAll: jest.fn().mockResolvedValue([]) },
      Job: { findOne: jest.fn().mockResolvedValue(null) },
    }));
    jest.doMock('../../configModule', () => ({ getConfig: jest.fn(() => ({})) }));
    jobEventLog = jest.requireActual('../index');
    ({ JobEvent, Video, Job } = require('../../../models'));
    logger = require('../../../logger');
  });

  describe('record', () => {
    test('writes a row with the catalog message, actor and level', async () => {
      jobEventLog.record('video.failed', { jobId: 'j1', youtubeId: 'abc', detail: { error: 'boom' } });
      await jobEventLog.flush();
      expect(JobEvent.create).toHaveBeenCalledWith(expect.objectContaining({
        job_id: 'j1', youtube_id: 'abc', event_type: 'video.failed', level: 'error',
        actor: 'downloader', message: 'Download failed - boom',
      }));
    });

    test('returns immediately without waiting for the write', () => {
      expect(jobEventLog.record('job.started', { jobId: 'j1' })).toBeUndefined();
      expect(JobEvent.create).not.toHaveBeenCalled();
    });

    test('stamps occurred_at at call time, not write time', async () => {
      const before = Date.now();
      jobEventLog.record('job.started', { jobId: 'j1' });
      const after = Date.now();
      await jobEventLog.flush();
      const stamped = JobEvent.create.mock.calls[0][0].occurred_at.getTime();
      expect(stamped).toBeGreaterThanOrEqual(before);
      expect(stamped).toBeLessThanOrEqual(after);
    });

    test('honours an explicit occurredAt', async () => {
      jobEventLog.record('job.started', { jobId: 'j1', occurredAt: 1700000000123 });
      await jobEventLog.flush();
      expect(JobEvent.create.mock.calls[0][0].occurred_at.getTime()).toBe(1700000000123);
    });

    test('writes events in call order', async () => {
      jobEventLog.record('job.created', { jobId: 'a' });
      jobEventLog.record('job.started', { jobId: 'b' });
      jobEventLog.record('job.finished', { jobId: 'c' });
      await jobEventLog.flush();
      expect(JobEvent.create.mock.calls.map((c) => c[0].job_id)).toEqual(['a', 'b', 'c']);
    });

    test('a failed write does not stop later events being written', async () => {
      JobEvent.create.mockRejectedValueOnce(new Error('db down'));
      jobEventLog.record('job.created', { jobId: 'a' });
      jobEventLog.record('job.started', { jobId: 'b' });
      await jobEventLog.flush();
      expect(JobEvent.create).toHaveBeenCalledTimes(2);
    });

    test('a failed write is logged as a warning, not thrown', async () => {
      JobEvent.create.mockRejectedValueOnce(new Error('db down'));
      jobEventLog.record('job.created', { jobId: 'a' });
      await expect(jobEventLog.flush()).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalled();
    });

    test('truncates an over-long message to the column size', async () => {
      jobEventLog.record('job.started', { jobId: 'a', message: 'x'.repeat(2000) });
      await jobEventLog.flush();
      expect(JobEvent.create.mock.calls[0][0].message).toHaveLength(512);
    });

    test('replaces an oversized detail payload instead of storing it', async () => {
      jobEventLog.record('job.started', { jobId: 'a', detail: { blob: 'x'.repeat(20000) } });
      await jobEventLog.flush();
      expect(JSON.parse(JobEvent.create.mock.calls[0][0].detail)).toMatchObject({ truncated: true });
    });

    test('stores an unserializable detail as a marker instead of throwing', async () => {
      const circular = {};
      circular.self = circular;
      jobEventLog.record('job.started', { jobId: 'a', detail: circular });
      await jobEventLog.flush();
      expect(JSON.parse(JobEvent.create.mock.calls[0][0].detail)).toEqual({ unserializable: true });
    });
  });

  describe('snapshot captured at the moment of the event', () => {
    const lastRow = () => JobEvent.create.mock.calls[JobEvent.create.mock.calls.length - 1][0];

    test('never looks anything up in the database when writing', async () => {
      jobEventLog.record('video.download_started', { jobId: 'j1', youtubeId: 'abc' });
      await jobEventLog.flush();
      expect(Video.findOne).not.toHaveBeenCalled();
      expect(Job.findOne).not.toHaveBeenCalled();
    });

    test('uses the title and channel the caller supplied', async () => {
      jobEventLog.record('video.failed', { youtubeId: 'abc', videoTitle: 'T', channelName: 'C' });
      await jobEventLog.flush();
      expect(lastRow()).toMatchObject({ video_title: 'T', channel_name: 'C' });
    });

    test('fills a missing title from what was remembered a moment before', async () => {
      jobEventLog.rememberVideo('abc', { title: 'Remembered', channelName: 'Chan' });
      jobEventLog.record('video.download_started', { youtubeId: 'abc' });
      await jobEventLog.flush();
      expect(lastRow()).toMatchObject({ video_title: 'Remembered', channel_name: 'Chan' });
    });

    test('lets a supplied title win over a remembered one', async () => {
      jobEventLog.rememberVideo('abc', { title: 'Old' });
      jobEventLog.record('video.failed', { youtubeId: 'abc', videoTitle: 'New' });
      await jobEventLog.flush();
      expect(lastRow().video_title).toBe('New');
    });

    test('remembers a title supplied on one event for the next', async () => {
      jobEventLog.record('video.failed', { youtubeId: 'abc', videoTitle: 'Seen once' });
      jobEventLog.record('video.deleted', { youtubeId: 'abc' });
      await jobEventLog.flush();
      expect(lastRow().video_title).toBe('Seen once');
    });

    test('leaves the title empty for a video nothing is known about', async () => {
      jobEventLog.record('video.download_started', { youtubeId: 'never-seen' });
      await jobEventLog.flush();
      expect(lastRow().video_title).toBeNull();
    });

    test('fills the job type from a remembered job', async () => {
      jobEventLog.rememberJob('j1', 'Channel Downloads');
      jobEventLog.record('job.started', { jobId: 'j1' });
      await jobEventLog.flush();
      expect(lastRow().job_type).toBe('Channel Downloads');
    });

    test('stores the source label of the job at the moment of the event', async () => {
      jobEventLog.rememberJob('j1', 'Sonarr/Radarr: TV [abc123]');
      jobEventLog.record('job.started', { jobId: 'j1' });
      await jobEventLog.flush();
      expect(lastRow().source).toBe('NZB (TV)');
    });

    test('stores no source for an event with no job', async () => {
      jobEventLog.record('log.cleared', {});
      await jobEventLog.flush();
      expect(lastRow().source).toBeNull();
    });

    test('forgets the oldest entries beyond the cap', async () => {
      for (let i = 0; i < 2001; i += 1) jobEventLog.rememberJob('job-' + i, 'T' + i);
      jobEventLog.record('job.started', { jobId: 'job-0' });
      await jobEventLog.flush();
      expect(lastRow().job_type).toBeNull();
    });
  });

  describe('list', () => {
    const row = (over = {}) => ({
      id: 5, occurred_at: new Date('2026-09-19T17:12:59.566Z'), job_id: 'j1', youtube_id: 'abc',
      event_type: 'nzb.untracked', level: 'info', actor: 'nzb', message: 'm', detail: '{"a":1}',
      video_title: 'T', channel_name: 'C', job_type: 'X', source: 'Channels', ...over,
    });
    const query = () => JobEvent.findAll.mock.calls[0][0];

    beforeEach(() => {
      JobEvent.count = jest.fn().mockResolvedValue(0);
    });

    test('maps a row to the API shape with an ISO millisecond timestamp and parsed detail', async () => {
      JobEvent.findAll.mockResolvedValueOnce([row()]);
      const { events } = await jobEventLog.list({});
      expect(events[0]).toEqual({
        id: 5, occurredAt: '2026-09-19T17:12:59.566Z', jobId: 'j1', youtubeId: 'abc',
        eventType: 'nzb.untracked', level: 'info', actor: 'nzb', message: 'm', detail: { a: 1 },
        videoTitle: 'T', channelName: 'C', jobType: 'X', source: 'Channels', isTracked: null,
      });
    });

    test.each([[true, true], [false, false], [null, null]])('maps a stored is_tracked of %p', async (stored, expected) => {
      JobEvent.findAll.mockResolvedValueOnce([row({ is_tracked: stored })]);
      const { events } = await jobEventLog.list({});
      expect(events[0].isTracked).toBe(expected);
    });

    test('filters to videos that were in the library', async () => {
      await jobEventLog.list({ tracked: 'tracked' });
      expect(query().where.is_tracked).toBe(true);
    });

    test('filters to videos that were not in the library', async () => {
      await jobEventLog.list({ tracked: 'untracked' });
      expect(query().where.is_tracked).toBe(false);
    });

    test('returns a null detail when the stored JSON is corrupt', async () => {
      JobEvent.findAll.mockResolvedValueOnce([row({ detail: '{nope' })]);
      const { events } = await jobEventLog.list({});
      expect(events[0].detail).toBeNull();
    });

    test('reports how many events match, for paging', async () => {
      JobEvent.count.mockResolvedValueOnce(1234);
      const { total } = await jobEventLog.list({});
      expect(total).toBe(1234);
    });

    test('counts with the same filters it lists with', async () => {
      await jobEventLog.list({ jobId: 'j1' });
      expect(JobEvent.count).toHaveBeenCalledWith({ where: query().where });
    });

    test('orders newest first by default, keeping same-millisecond events in the order written', async () => {
      await jobEventLog.list({});
      expect(query().order).toEqual([['occurred_at', 'DESC'], ['id', 'ASC']]);
    });

    test('orders oldest first when asked, still ties in the order written', async () => {
      await jobEventLog.list({ order: 'asc' });
      expect(query().order).toEqual([['occurred_at', 'ASC'], ['id', 'ASC']]);
    });

    test('pages with limit and offset', async () => {
      await jobEventLog.list({ limit: 25, offset: 50 });
      expect(query()).toMatchObject({ limit: 25, offset: 50 });
    });

    test('defaults to the first page', async () => {
      await jobEventLog.list({});
      expect(query()).toMatchObject({ limit: 100, offset: 0 });
    });

    test('caps the page size', async () => {
      await jobEventLog.list({ limit: 99999 });
      expect(query().limit).toBe(500);
    });

    test('filters by job id and youtube id', async () => {
      await jobEventLog.list({ jobId: 'j1', youtubeId: 'abc' });
      expect(query().where).toMatchObject({ job_id: 'j1', youtube_id: 'abc' });
    });

    test('filters by an event type family', async () => {
      await jobEventLog.list({ category: 'nzb' });
      const { Op } = require('sequelize');
      expect(query().where.event_type[Op.like]).toBe('nzb.%');
    });

    test('filters to a time range', async () => {
      await jobEventLog.list({ from: '2026-09-19T00:00:00.000Z', to: '2026-09-19T23:59:59.999Z' });
      const { Op } = require('sequelize');
      const range = query().where.occurred_at;
      expect(range[Op.gte]).toEqual(new Date('2026-09-19T00:00:00.000Z'));
      expect(range[Op.lte]).toEqual(new Date('2026-09-19T23:59:59.999Z'));
    });

    test('filters by actor', async () => {
      await jobEventLog.list({ actor: 'nzb' });
      expect(query().where.actor).toBe('nzb');
    });

    test('filters by exact channel name', async () => {
      await jobEventLog.list({ channel: 'pcrobec' });
      expect(query().where.channel_name).toBe('pcrobec');
    });

    test('filters by exact event type', async () => {
      await jobEventLog.list({ eventType: 'video.failed' });
      expect(query().where.event_type).toBe('video.failed');
    });

    test('filters by the stored source label', async () => {
      await jobEventLog.list({ source: 'NZB (TV)' });
      expect(query().where.source).toBe('NZB (TV)');
    });

    test('does not filter by source when none is given', async () => {
      await jobEventLog.list({});
      expect(query().where.source).toBeUndefined();
    });

    test('escapes LIKE wildcards in the search text', async () => {
      await jobEventLog.list({ q: '100%_x' });
      const { Op } = require('sequelize');
      const clause = query().where[Op.or][0];
      expect(clause.message[Op.like]).toBe('%100\\%\\_x%');
    });
  });

  describe('facets', () => {
    test('offers the distinct event types, actors and channels found in the log', async () => {
      JobEvent.findAll
        .mockResolvedValueOnce([{ value: 'job.created' }, { value: 'video.failed' }])
        .mockResolvedValueOnce([{ value: 'nzb' }])
        .mockResolvedValueOnce([{ value: 'pcrobec' }])
        .mockResolvedValueOnce([{ value: 'NZB (TV)' }, { value: 'Channels' }]);
      const facets = await jobEventLog.facets();
      expect(facets).toMatchObject({
        eventTypes: ['job.created', 'video.failed'], actors: ['nzb'], channels: ['pcrobec'], sources: ['NZB (TV)', 'Channels'],
      });
    });

    test('leaves out empty values', async () => {
      JobEvent.findAll.mockResolvedValueOnce([{ value: 'a' }, { value: '' }, { value: null }]).mockResolvedValue([]);
      const facets = await jobEventLog.facets();
      expect(facets.eventTypes).toEqual(['a']);
    });
  });

  describe('tracked state captured at the moment of the event', () => {
    const lastRow = () => JobEvent.create.mock.calls[JobEvent.create.mock.calls.length - 1][0];

    test('is unknown until the library state has been loaded', async () => {
      jobEventLog.record('video.download_started', { youtubeId: 'abc' });
      await jobEventLog.flush();
      expect(lastRow().is_tracked).toBeNull();
    });

    test('is true for a video in the library once loaded', async () => {
      Video.findAll.mockResolvedValueOnce([{ youtubeId: 'abc', youTubeVideoName: 'T', youTubeChannelName: 'C' }]);
      await jobEventLog.warm();
      jobEventLog.record('video.download_started', { youtubeId: 'abc' });
      await jobEventLog.flush();
      expect(lastRow().is_tracked).toBe(true);
    });

    test('is false for a video not in the library once loaded', async () => {
      await jobEventLog.warm();
      jobEventLog.record('video.download_started', { youtubeId: 'abc' });
      await jobEventLog.flush();
      expect(lastRow().is_tracked).toBe(false);
    });

    test('is unknown for an event with no video', async () => {
      await jobEventLog.warm();
      jobEventLog.record('job.started', { jobId: 'j1' });
      await jobEventLog.flush();
      expect(lastRow().is_tracked).toBeNull();
    });

    test('an explicit value on the event wins', async () => {
      jobEventLog.record('nzb.untracked', { youtubeId: 'abc', isTracked: false });
      await jobEventLog.flush();
      expect(lastRow().is_tracked).toBe(false);
    });

    test('an explicit value updates what later events see', async () => {
      Video.findAll.mockResolvedValueOnce([{ youtubeId: 'abc' }]);
      await jobEventLog.warm();
      jobEventLog.record('nzb.untracked', { youtubeId: 'abc', isTracked: false });
      jobEventLog.record('video.failed', { youtubeId: 'abc' });
      await jobEventLog.flush();
      expect(lastRow().is_tracked).toBe(false);
    });

    test('markTracked(true) makes a later event read as tracked', async () => {
      await jobEventLog.warm();
      jobEventLog.markTracked('abc', true);
      jobEventLog.record('video.downloaded', { youtubeId: 'abc' });
      await jobEventLog.flush();
      expect(lastRow().is_tracked).toBe(true);
    });

    test('a change made before the library state loads is not lost when it lands', async () => {
      jobEventLog.markTracked('abc', true);
      Video.findAll.mockResolvedValueOnce([]);
      await jobEventLog.warm();
      jobEventLog.record('video.downloaded', { youtubeId: 'abc' });
      await jobEventLog.flush();
      expect(lastRow().is_tracked).toBe(true);
    });

    test('a removal made before the library state loads wins over the loaded row', async () => {
      jobEventLog.markTracked('abc', false);
      Video.findAll.mockResolvedValueOnce([{ youtubeId: 'abc' }]);
      await jobEventLog.warm();
      jobEventLog.record('video.failed', { youtubeId: 'abc' });
      await jobEventLog.flush();
      expect(lastRow().is_tracked).toBe(false);
    });

    test('stays unknown, without throwing, when the library state cannot be loaded', async () => {
      Video.findAll.mockRejectedValueOnce(new Error('db down'));
      await expect(jobEventLog.warm()).resolves.toBeUndefined();
      jobEventLog.record('video.failed', { youtubeId: 'abc' });
      await jobEventLog.flush();
      expect(lastRow().is_tracked).toBeNull();
    });

    test('loading the library state also fills in titles for videos nothing has named yet', async () => {
      Video.findAll.mockResolvedValueOnce([{ youtubeId: 'abc', youTubeVideoName: 'From library', youTubeChannelName: 'Chan' }]);
      await jobEventLog.warm();
      jobEventLog.record('video.download_started', { youtubeId: 'abc' });
      await jobEventLog.flush();
      expect(lastRow()).toMatchObject({ video_title: 'From library', channel_name: 'Chan' });
    });

    test('loading the library state never overwrites a name already supplied', async () => {
      jobEventLog.rememberVideo('abc', { title: 'Supplied' });
      Video.findAll.mockResolvedValueOnce([{ youtubeId: 'abc', youTubeVideoName: 'From library' }]);
      await jobEventLog.warm();
      jobEventLog.record('video.download_started', { youtubeId: 'abc' });
      await jobEventLog.flush();
      expect(lastRow().video_title).toBe('Supplied');
    });
  });

  describe('one video reads the same across its events', () => {
    const lastRow = () => JobEvent.create.mock.calls[JobEvent.create.mock.calls.length - 1][0];

    test('a provisional title is used when nothing better is known', async () => {
      jobEventLog.record('job.created', { youtubeId: 'abc', provisionalTitle: 'Celebrity Juice S17E10' });
      await jobEventLog.flush();
      expect(lastRow().video_title).toBe('Celebrity Juice S17E10');
    });

    test('the id an NZB name carries is stripped from a provisional title', async () => {
      jobEventLog.record('job.created', { youtubeId: 'GSdt_08xE8k', provisionalTitle: 'Celebrity Juice S17E10 [GSdt_08xE8k]' });
      await jobEventLog.flush();
      expect(lastRow().video_title).toBe('Celebrity Juice S17E10');
    });

    test('a remembered real title wins over a provisional one', async () => {
      jobEventLog.rememberVideo('abc', { title: 'Real title', channelName: 'Real channel' });
      jobEventLog.record('job.created', { youtubeId: 'abc', provisionalTitle: 'nzb name [abcdefghijk]' });
      await jobEventLog.flush();
      expect(lastRow()).toMatchObject({ video_title: 'Real title', channel_name: 'Real channel' });
    });

    test('a supplied real title wins over a provisional one', async () => {
      jobEventLog.record('strm.created', { youtubeId: 'abc', videoTitle: 'Real title', provisionalTitle: 'stand-in' });
      await jobEventLog.flush();
      expect(lastRow().video_title).toBe('Real title');
    });

    test('a provisional title is never remembered for later events', async () => {
      jobEventLog.record('job.created', { youtubeId: 'abc', provisionalTitle: 'stand-in' });
      jobEventLog.record('video.failed', { youtubeId: 'abc' });
      await jobEventLog.flush();
      expect(lastRow().video_title).toBeNull();
    });

    test('later events use the real title and channel once one event has supplied them', async () => {
      jobEventLog.record('job.created', { youtubeId: 'abc', provisionalTitle: 'stand-in' });
      jobEventLog.record('strm.created', { youtubeId: 'abc', videoTitle: 'Real title', channelName: 'Real channel' });
      jobEventLog.record('job.finished', { youtubeId: 'abc' });
      await jobEventLog.flush();
      expect(lastRow()).toMatchObject({ video_title: 'Real title', channel_name: 'Real channel' });
    });

    test('a provisional title that is only an id-tag leaves the title empty', async () => {
      jobEventLog.record('job.created', { youtubeId: 'GSdt_08xE8k', provisionalTitle: '[GSdt_08xE8k]' });
      await jobEventLog.flush();
      expect(lastRow().video_title).toBeNull();
    });
  });

  describe('runWithContext', () => {
    it('applies the ambient actor to events recorded inside it', async () => {
      jobEventLog.runWithContext({ actor: 'auto-removal' }, () => jobEventLog.record('video.deleted', { youtubeId: 'abc' }));
      await jobEventLog.flush();
      expect(JobEvent.create.mock.calls[0][0].actor).toBe('auto-removal');
    });

    it('applies the ambient reason as detail.reason and into the message', async () => {
      jobEventLog.runWithContext({ reason: 'automatic removal' }, () => jobEventLog.record('video.deleted', { youtubeId: 'abc' }));
      await jobEventLog.flush();
      expect(JobEvent.create.mock.calls[0][0].message).toBe('Video deleted - automatic removal');
    });

    it('keeps the ambient context across awaits', async () => {
      await jobEventLog.runWithContext({ actor: 'nightly' }, async () => {
        await Promise.resolve();
        await new Promise((resolve) => setImmediate(resolve));
        jobEventLog.record('video.deleted', { youtubeId: 'abc' });
      });
      await jobEventLog.flush();
      expect(JobEvent.create.mock.calls[0][0].actor).toBe('nightly');
    });

    it('lets an explicit actor on the call win over the ambient one', async () => {
      jobEventLog.runWithContext({ actor: 'ambient' }, () => jobEventLog.record('video.deleted', { youtubeId: 'abc', actor: 'explicit' }));
      await jobEventLog.flush();
      expect(JobEvent.create.mock.calls[0][0].actor).toBe('explicit');
    });

    it('lets an explicit detail.reason win over the ambient one', async () => {
      jobEventLog.runWithContext({ reason: 'ambient' }, () => jobEventLog.record('video.deleted', { youtubeId: 'abc', detail: { reason: 'explicit' } }));
      await jobEventLog.flush();
      expect(JSON.parse(JobEvent.create.mock.calls[0][0].detail).reason).toBe('explicit');
    });

    it('does not leak the context to events recorded outside it', async () => {
      jobEventLog.runWithContext({ actor: 'auto-removal' }, () => {});
      jobEventLog.record('video.deleted', { youtubeId: 'abc' });
      await jobEventLog.flush();
      expect(JobEvent.create.mock.calls[0][0].actor).toBe('library');
    });

    it('returns whatever the wrapped function returns', async () => {
      await expect(jobEventLog.runWithContext({ actor: 'x' }, async () => 42)).resolves.toBe(42);
    });
  });

  describe('clear', () => {
    test('deletes every event and reports how many', async () => {
      JobEvent.destroy.mockResolvedValueOnce(42);
      await expect(jobEventLog.clear()).resolves.toBe(42);
      expect(JobEvent.destroy).toHaveBeenCalledWith({ where: {} });
    });

    test('waits for events already queued before deleting', async () => {
      jobEventLog.record('job.started', { jobId: 'j1' });
      await jobEventLog.clear();
      expect(JobEvent.create.mock.invocationCallOrder[0]).toBeLessThan(JobEvent.destroy.mock.invocationCallOrder[0]);
    });

    test('leaves one log.cleared entry behind so the log is never silently empty', async () => {
      JobEvent.destroy.mockResolvedValueOnce(7);
      await jobEventLog.clear();
      await jobEventLog.flush();
      const last = JobEvent.create.mock.calls[JobEvent.create.mock.calls.length - 1][0];
      expect(last).toMatchObject({ event_type: 'log.cleared', level: 'warn', message: 'Event log cleared (7 events removed)' });
    });

    test('writes the log.cleared entry after the delete, so it survives', async () => {
      await jobEventLog.clear();
      await jobEventLog.flush();
      expect(JobEvent.destroy.mock.invocationCallOrder[0]).toBeLessThan(JobEvent.create.mock.invocationCallOrder[0]);
    });

    test('rejects and leaves no clear entry when the delete fails', async () => {
      JobEvent.destroy.mockRejectedValueOnce(new Error('db down'));
      await expect(jobEventLog.clear()).rejects.toThrow('db down');
      await jobEventLog.flush();
      expect(JobEvent.create).not.toHaveBeenCalled();
    });
  });

  describe('retention', () => {
    test('defaults to 180 days when config has no value', () => {
      expect(jobEventLog.getRetentionDays()).toBe(180);
    });

    test('uses the configured number of days', () => {
      require('../../configModule').getConfig.mockReturnValue({ jobEventLogRetentionDays: 30 });
      expect(jobEventLog.getRetentionDays()).toBe(30);
    });

    test('treats 0 as keep forever', () => {
      require('../../configModule').getConfig.mockReturnValue({ jobEventLogRetentionDays: 0 });
      expect(jobEventLog.getRetentionDays()).toBe(0);
    });

    test('falls back to the default for a negative value', () => {
      require('../../configModule').getConfig.mockReturnValue({ jobEventLogRetentionDays: -5 });
      expect(jobEventLog.getRetentionDays()).toBe(180);
    });

    test('prune deletes only rows older than the cutoff', async () => {
      JobEvent.destroy.mockResolvedValueOnce(4);
      const before = Date.now();
      await expect(jobEventLog.prune(10)).resolves.toBe(4);
      const { Op } = require('sequelize');
      const cutoff = JobEvent.destroy.mock.calls[0][0].where.occurred_at[Op.lt].getTime();
      expect(cutoff).toBeLessThanOrEqual(before - 10 * 24 * 60 * 60 * 1000 + 1000);
    });

    test('prune with 0 days deletes nothing', async () => {
      await expect(jobEventLog.prune(0)).resolves.toBe(0);
      expect(JobEvent.destroy).not.toHaveBeenCalled();
    });
  });
});
