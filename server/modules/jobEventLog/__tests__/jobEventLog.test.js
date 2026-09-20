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
      Video: { findOne: jest.fn().mockResolvedValue(null) },
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
      video_title: 'T', channel_name: 'C', job_type: 'X', ...over,
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
        videoTitle: 'T', channelName: 'C', jobType: 'X',
      });
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

    test('filters by a source label, matching the job types in that group', async () => {
      await jobEventLog.list({ source: 'NZB' });
      const { Op } = require('sequelize');
      expect(query().where[Op.and][0][Op.or]).toEqual([{ job_type: { [Op.like]: 'Sonarr/Radarr: %' } }]);
    });

    test('a source with several job types matches any of them', async () => {
      await jobEventLog.list({ source: 'Playlists' });
      const { Op } = require('sequelize');
      expect(query().where[Op.and][0][Op.or]).toHaveLength(2);
    });

    test('ignores an unknown source label', async () => {
      await jobEventLog.list({ source: 'Nonsense' });
      const { Op } = require('sequelize');
      expect(query().where[Op.and]).toBeUndefined();
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
        .mockResolvedValueOnce([{ value: 'pcrobec' }]);
      const facets = await jobEventLog.facets();
      expect(facets).toMatchObject({ eventTypes: ['job.created', 'video.failed'], actors: ['nzb'], channels: ['pcrobec'] });
    });

    test('always offers every source label', async () => {
      const facets = await jobEventLog.facets();
      expect(facets.sources).toEqual(expect.arrayContaining(['Channels', 'NZB', 'Playlists']));
    });

    test('leaves out empty values', async () => {
      JobEvent.findAll.mockResolvedValueOnce([{ value: 'a' }, { value: '' }, { value: null }]).mockResolvedValue([]);
      const facets = await jobEventLog.facets();
      expect(facets.eventTypes).toEqual(['a']);
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
