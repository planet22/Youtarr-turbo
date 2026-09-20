/* eslint-env jest */

describe('cronJobs task registry', () => {
  let cronJobs;
  let mockSchedule;
  let mockDb;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    mockSchedule = { schedule: jest.fn() };
    jest.doMock('node-cron', () => mockSchedule);
    jest.doMock('../../logger', () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }));
    mockDb = {
      Session: { destroy: jest.fn().mockResolvedValue(0) },
      Sequelize: { Op: { or: Symbol('or'), lt: Symbol('lt') } }
    };
    jest.doMock('../../db', () => mockDb);
    jest.doMock('../videosModule', () => ({ backfillVideoMetadata: jest.fn() }));
    jest.doMock('../videoDeletionModule', () => ({
      performAutomaticCleanup: jest.fn(),
      cleanupOrphanDirectories: jest.fn().mockResolvedValue({ removed: [], errors: [] })
    }));
    jest.doMock('../notificationModule', () => ({ sendAutoRemovalNotification: jest.fn() }));
    jest.doMock('../ytdlpModule', () => ({ performUpdate: jest.fn() }));
    jest.doMock('../configModule', () => ({
      getConfig: jest.fn(() => ({})),
      updateConfig: jest.fn(),
      isElfhostedPlatform: jest.fn(() => false)
    }));

    cronJobs = require('../cronJobs');
    cronJobs.initialize();
  });

  const findTask = (id) => cronJobs.getTasks().find((t) => t.id === id);

  test('lists every scheduled job as a task', () => {
    expect(cronJobs.getTasks().map((t) => t.id)).toEqual([
      'auto-removal',
      'strm-cache-expiry',
      'session-cleanup',
      'stream-history-prune',
      'metadata-cache-prune',
      'metadata-backfill',
      'ytdlp-update'
    ]);
  });

  test('flags only auto-removal as needing confirmation', () => {
    expect(cronJobs.getTasks().filter((t) => t.confirm).map((t) => t.id)).toEqual(['auto-removal']);
  });

  test('reports the next occurrence of a daily schedule', () => {
    const next = new Date(findTask('session-cleanup').nextRun);
    expect([next.getHours(), next.getMinutes()]).toEqual([3, 0]);
  });

  test('a never-run task has no last status', () => {
    expect(findTask('session-cleanup').lastStatus).toBeNull();
  });

  test('runTaskNow starts the task and records a manual run', async () => {
    expect(cronJobs.runTaskNow('session-cleanup')).toEqual({ started: true });
    await new Promise((resolve) => setImmediate(resolve));

    const task = findTask('session-cleanup');
    expect([task.lastTrigger, task.lastStatus, task.running]).toEqual(['manual', 'ok', false]);
  });

  test('runTaskNow refuses a task that is already running', () => {
    cronJobs.runTaskNow('session-cleanup');
    expect(cronJobs.runTaskNow('session-cleanup')).toEqual({ started: false, reason: 'running' });
  });

  test('runTaskNow reports an unknown task', () => {
    expect(cronJobs.runTaskNow('nope')).toEqual({ started: false, reason: 'unknown' });
  });

  test('the scheduled callback records a scheduled run', async () => {
    const [, callback] = mockSchedule.schedule.mock.calls.find(([expr]) => expr === '0 3 * * *');
    await callback();

    expect(findTask('session-cleanup').lastTrigger).toBe('scheduled');
  });
});
