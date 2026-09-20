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

  describe('snapshot', () => {
    test('fills title and channel from the Video row when the caller gave none', async () => {
      Video.findOne.mockResolvedValueOnce({ youTubeVideoName: 'A Title', youTubeChannelName: 'A Channel' });
      jobEventLog.record('video.download_started', { jobId: 'j1', youtubeId: 'abc' });
      await jobEventLog.flush();
      expect(JobEvent.create).toHaveBeenCalledWith(expect.objectContaining({ video_title: 'A Title', channel_name: 'A Channel' }));
    });

    test('does not query Videos when the caller supplied title and channel', async () => {
      jobEventLog.record('video.failed', { youtubeId: 'abc', videoTitle: 'T', channelName: 'C' });
      await jobEventLog.flush();
      expect(Video.findOne).not.toHaveBeenCalled();
    });

    test('fills job type from the Job row when the caller gave none', async () => {
      Job.findOne.mockResolvedValueOnce({ jobType: 'Channel Downloads' });
      jobEventLog.record('job.started', { jobId: 'j1' });
      await jobEventLog.flush();
      expect(JobEvent.create).toHaveBeenCalledWith(expect.objectContaining({ job_type: 'Channel Downloads' }));
    });

    test('still writes the row when the snapshot lookup throws', async () => {
      Video.findOne.mockRejectedValueOnce(new Error('lookup failed'));
      jobEventLog.record('video.download_started', { jobId: 'j1', youtubeId: 'abc' });
      await jobEventLog.flush();
      expect(JobEvent.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('list', () => {
    const row = (over = {}) => ({
      id: 5, occurred_at: new Date('2026-09-19T17:12:59.566Z'), job_id: 'j1', youtube_id: 'abc',
      event_type: 'nzb.untracked', level: 'info', actor: 'nzb', message: 'm', detail: '{"a":1}',
      video_title: 'T', channel_name: 'C', job_type: 'X', ...over,
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

    test('reports the last returned id as nextCursor when another page exists', async () => {
      JobEvent.findAll.mockResolvedValueOnce([row({ id: 9 }), row({ id: 8 }), row({ id: 7 })]);
      const { events, nextCursor } = await jobEventLog.list({ limit: 2 });
      expect(events.map((e) => e.id)).toEqual([9, 8]);
      expect(nextCursor).toBe(8);
    });

    test('reports a null nextCursor on the final page', async () => {
      JobEvent.findAll.mockResolvedValueOnce([row({ id: 9 })]);
      const { nextCursor } = await jobEventLog.list({ limit: 2 });
      expect(nextCursor).toBeNull();
    });

    test('orders newest-first by default', async () => {
      await jobEventLog.list({});
      expect(JobEvent.findAll.mock.calls[0][0].order).toEqual([['id', 'DESC']]);
    });

    test('orders oldest-first when asked', async () => {
      await jobEventLog.list({ order: 'asc' });
      expect(JobEvent.findAll.mock.calls[0][0].order).toEqual([['id', 'ASC']]);
    });

    test('filters by job id and youtube id', async () => {
      await jobEventLog.list({ jobId: 'j1', youtubeId: 'abc' });
      expect(JobEvent.findAll.mock.calls[0][0].where).toMatchObject({ job_id: 'j1', youtube_id: 'abc' });
    });

    test('caps the page size', async () => {
      await jobEventLog.list({ limit: 99999 });
      expect(JobEvent.findAll.mock.calls[0][0].limit).toBe(501);
    });

    test('escapes LIKE wildcards in the search text', async () => {
      await jobEventLog.list({ q: '100%_x' });
      const { Op } = require('sequelize');
      const clause = JobEvent.findAll.mock.calls[0][0].where[Op.or][0];
      expect(clause.message[Op.like]).toBe('%100\\%\\_x%');
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
