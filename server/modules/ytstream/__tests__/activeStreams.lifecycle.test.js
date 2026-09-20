/* eslint-env jest */

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('activeStreams lifecycle', () => {
  let streams;
  let logger;
  let messageEmitter;
  let youtubeMetadataCache;
  let processRegistry;
  let workDir;

  // The module keeps process-wide singleton state (stream map, timers,
  // once-only install flags), so load a fresh copy for every test.
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    jest.doMock('../../../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
    jest.doMock('../../messageEmitter', () => ({ emitMessage: jest.fn() }));
    jest.doMock('../../youtubeMetadataCache', () => ({ getCachedTitles: jest.fn() }));
    jest.doMock('../streamDebug', () => ({ streamDebug: jest.fn() }));
    jest.doMock('../processRegistry', () => ({ killAllChildProcesses: jest.fn() }));

    logger = require('../../../logger');
    messageEmitter = require('../../messageEmitter');
    youtubeMetadataCache = require('../../youtubeMetadataCache');
    processRegistry = require('../processRegistry');
    streams = require('../activeStreams');
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'active-streams-'));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  const entry = (overrides = {}) => ({
    streamId: 's1',
    mode: 'direct',
    youtubeId: 'abc123DEF45',
    quality: '1080',
    container: 'mp4',
    transcode: 'copy',
    hardwareMode: 'none',
    clientIp: '10.0.0.1',
    userAgent: 'Jellyfin',
    state: 'active',
    startedAt: Date.now(),
    bytesTransferred: 0,
    bytesPerSecond: 0,
    lastActivityAt: Date.now(),
    ...overrides,
  });

  const emitted = (type) => messageEmitter.emitMessage.mock.calls.filter((c) => c[3] === type).map((c) => c[4]);

  describe('stream history persistence', () => {
    const StreamHistory = () => ({ upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) });

    it('does nothing without models', async () => {
      await expect(streams.persistStreamHistoryStart(entry())).resolves.toBeUndefined();
      await expect(streams.persistStreamHistoryEnd(entry(), 'completed', null)).resolves.toBeUndefined();
    });

    it('does nothing when the StreamHistory model is missing', async () => {
      streams.init({ models: {}, hlsSessions: new Map(), destroyHlsSession: jest.fn() });

      await expect(streams.persistStreamHistoryStart(entry())).resolves.toBeUndefined();
    });

    it('upserts the start row keyed by stream id', async () => {
      const model = StreamHistory();
      streams.init({ models: { StreamHistory: model }, hlsSessions: new Map(), destroyHlsSession: jest.fn() });

      await streams.persistStreamHistoryStart(entry({ hardwareMode: 'vaapi' }));

      expect(model.upsert).toHaveBeenCalledWith({
        stream_id: 's1',
        youtube_id: 'abc123DEF45',
        mode: 'direct',
        quality: '1080',
        container: 'mp4',
        transcode: 'copy',
        hardware_mode: 'vaapi',
        client_ip: '10.0.0.1',
        user_agent: 'Jellyfin',
        started_at: new Date('2026-01-01T00:00:00Z'),
        ended_at: null,
        bytes_transferred: 0,
        end_reason: null,
        error_message: null,
      });
    });

    it('stores missing optional fields as null', async () => {
      const model = StreamHistory();
      streams.init({ models: { StreamHistory: model }, hlsSessions: new Map(), destroyHlsSession: jest.fn() });

      await streams.persistStreamHistoryStart(entry({ quality: undefined, container: undefined, transcode: undefined, hardwareMode: undefined, clientIp: undefined, userAgent: undefined }));

      expect(model.upsert.mock.calls[0][0]).toMatchObject({ quality: null, container: null, transcode: null, hardware_mode: null, client_ip: null, user_agent: null });
    });

    it('warns instead of throwing when the start row cannot be saved', async () => {
      const model = StreamHistory();
      model.upsert.mockRejectedValue(new Error('db down'));
      streams.init({ models: { StreamHistory: model }, hlsSessions: new Map(), destroyHlsSession: jest.fn() });

      await expect(streams.persistStreamHistoryStart(entry())).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalled();
    });

    it('updates the end row with the reason, bytes and error', async () => {
      const model = StreamHistory();
      streams.init({ models: { StreamHistory: model }, hlsSessions: new Map(), destroyHlsSession: jest.fn() });

      await streams.persistStreamHistoryEnd(entry({ bytesTransferred: 2048 }), 'error', 'boom');

      expect(model.update).toHaveBeenCalledWith(
        { ended_at: new Date('2026-01-01T00:00:00Z'), bytes_transferred: 2048, end_reason: 'error', error_message: 'boom' },
        { where: { stream_id: 's1' } }
      );
    });

    it('stores a missing error and byte count as null and zero', async () => {
      const model = StreamHistory();
      streams.init({ models: { StreamHistory: model }, hlsSessions: new Map(), destroyHlsSession: jest.fn() });

      await streams.persistStreamHistoryEnd(entry({ bytesTransferred: undefined }), 'completed', undefined);

      expect(model.update.mock.calls[0][0]).toMatchObject({ bytes_transferred: 0, error_message: null });
    });

    it('warns instead of throwing when the end row cannot be saved', async () => {
      const model = StreamHistory();
      model.update.mockRejectedValue(new Error('db down'));
      streams.init({ models: { StreamHistory: model }, hlsSessions: new Map(), destroyHlsSession: jest.fn() });

      await expect(streams.persistStreamHistoryEnd(entry(), 'completed', null)).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('fillMissingTitlesFromMetadataCache', () => {
    it('does not query when every title is known', async () => {
      await streams.fillMissingTitlesFromMetadataCache(['a', 'b'], { a: 'A', b: 'B' });

      expect(youtubeMetadataCache.getCachedTitles).not.toHaveBeenCalled();
    });

    it('fills only the missing titles from the cache', async () => {
      youtubeMetadataCache.getCachedTitles.mockResolvedValue({ b: 'From Cache' });
      const titles = { a: 'A' };

      await streams.fillMissingTitlesFromMetadataCache(['a', 'b'], titles);

      expect(youtubeMetadataCache.getCachedTitles).toHaveBeenCalledWith(['b']);
      expect(titles).toEqual({ a: 'A', b: 'From Cache' });
    });

    it('leaves a title alone when the cache has none for it', async () => {
      youtubeMetadataCache.getCachedTitles.mockResolvedValue({});
      const titles = {};

      await streams.fillMissingTitlesFromMetadataCache(['a'], titles);

      expect(titles).toEqual({});
    });
  });

  describe('computeSegmentStatus', () => {
    const seed = (files) => files.forEach((f) => fs.writeFileSync(path.join(workDir, f), 'x'));
    const session = (overrides = {}) => ({ totalSegments: 5, dir: workDir, segmentDurationSeconds: 4, ...overrides });

    it.each([
      [null],
      [{ dir: '/x' }],
      [{ totalSegments: 0, dir: '/x' }],
      [{ totalSegments: 3 }],
    ])('returns null for %j', (input) => {
      expect(streams.computeSegmentStatus(input)).toBeNull();
    });

    it('returns null when the directory cannot be read', () => {
      expect(streams.computeSegmentStatus(session({ dir: path.join(workDir, 'missing') }))).toBeNull();
    });

    it('marks the segments that exist on disk', () => {
      seed(['segment00000.ts', 'segment00002.ts', 'playlist.m3u8', 'init.mp4']);

      expect(streams.computeSegmentStatus(session()).encoded).toEqual([true, false, true, false, false]);
    });

    it('ignores segment files outside the declared range', () => {
      seed(['segment00009.ts']);

      expect(streams.computeSegmentStatus(session()).encoded).toEqual([false, false, false, false, false]);
    });

    it('reports the true final count once the encode has ended early', () => {
      seed(['segment00000.ts', 'segment00001.ts', 'segment00002.ts']);

      const status = streams.computeSegmentStatus(session({ encodeEnded: true }));

      expect(status.totalSegments).toBe(3);
      expect(status.encoded).toEqual([true, true, true]);
    });

    it('keeps the estimated count while the encode is still running', () => {
      seed(['segment00000.ts']);

      expect(streams.computeSegmentStatus(session({ encodeEnded: false })).totalSegments).toBe(5);
    });

    it('keeps the estimate when an ended encode produced nothing', () => {
      expect(streams.computeSegmentStatus(session({ encodeEnded: true })).totalSegments).toBe(5);
    });

    it('reports how far the buffer fetch has reached', () => {
      const status = streams.computeSegmentStatus(session({ bufferEnabled: true, bufferedSeconds: 10 }));

      expect(status.bufferedThroughIndex).toBe(2);
    });

    it('caps the buffered index at the segment count', () => {
      expect(streams.computeSegmentStatus(session({ bufferEnabled: true, bufferedSeconds: 9999 })).bufferedThroughIndex).toBe(5);
    });

    it('reports zero buffered when buffering is off', () => {
      expect(streams.computeSegmentStatus(session({ bufferedSeconds: 100 })).bufferedThroughIndex).toBe(0);
    });

    it('reports whether the buffer fetch is complete', () => {
      expect(streams.computeSegmentStatus(session({ bufferFetchDone: true })).bufferComplete).toBe(true);
      expect(streams.computeSegmentStatus(session()).bufferComplete).toBe(false);
    });

    it('reports the segment most recently served', () => {
      expect(streams.computeSegmentStatus(session({ lastServedSegmentIndex: 3 })).currentSegmentIndex).toBe(3);
      expect(streams.computeSegmentStatus(session()).currentSegmentIndex).toBeNull();
    });

    it('points the backfill indicator at the first gap while backfilling', () => {
      seed(['segment00000.ts', 'segment00001.ts', 'segment00003.ts']);

      expect(streams.computeSegmentStatus(session({ backfillInProgress: true })).backfillSegmentIndex).toBe(2);
    });

    it('has no backfill index when there is no gap left', () => {
      seed(['segment00000.ts', 'segment00001.ts', 'segment00002.ts', 'segment00003.ts', 'segment00004.ts']);

      expect(streams.computeSegmentStatus(session({ backfillInProgress: true })).backfillSegmentIndex).toBeNull();
    });

    it('has no backfill index when no backfill is running', () => {
      expect(streams.computeSegmentStatus(session()).backfillSegmentIndex).toBeNull();
    });
  });

  describe('snapshotStream', () => {
    beforeEach(() => {
      streams.init({ models: null, hlsSessions: new Map(), destroyHlsSession: jest.fn() });
    });

    it('copies the identifying and transfer fields', () => {
      const snapshot = streams.snapshotStream(entry({ tuning: 'fast', bytesTransferred: 10, bytesPerSecond: 5 }));

      expect(snapshot).toMatchObject({
        streamId: 's1', mode: 'direct', youtubeId: 'abc123DEF45', quality: '1080', container: 'mp4', transcode: 'copy',
        hardwareMode: 'none', tuning: 'fast', clientIp: '10.0.0.1', userAgent: 'Jellyfin', state: 'active',
        bytesTransferred: 10, bytesPerSecond: 5,
      });
    });

    it('counts viewers only when tracked', () => {
      expect(streams.snapshotStream(entry()).viewerCount).toBeUndefined();
      expect(streams.snapshotStream(entry({ viewers: new Map([['a', {}], ['b', {}]]) })).viewerCount).toBe(2);
    });

    it('defaults the error, estimate flag and playback position', () => {
      expect(streams.snapshotStream(entry())).toMatchObject({ error: null, bytesEstimated: false, playbackSeconds: null });
    });

    it('passes through an error, estimate flag and playback position', () => {
      expect(streams.snapshotStream(entry({ error: 'boom', bytesEstimated: true, playbackSeconds: 42 }))).toMatchObject({ error: 'boom', bytesEstimated: true, playbackSeconds: 42 });
    });

    it('has no segment status for a direct stream', () => {
      expect(streams.snapshotStream(entry()).segments).toBeNull();
    });

    it('reads segment status from the live hls session for an hls stream', () => {
      fs.writeFileSync(path.join(workDir, 'segment00000.ts'), 'x');
      const hlsSessions = new Map([['s1', { totalSegments: 2, dir: workDir, segmentDurationSeconds: 4 }]]);
      streams.init({ models: null, hlsSessions, destroyHlsSession: jest.fn() });

      expect(streams.snapshotStream(entry({ mode: 'hls' })).segments.encoded).toEqual([true, false]);
    });

    it('has no segment status for an hls stream whose session is gone', () => {
      expect(streams.snapshotStream(entry({ mode: 'hls' })).segments).toBeNull();
    });

    it('builds a segment strip from a youtube-hls segment grid', () => {
      const segmentGrid = { total: 4, durationSeconds: 6, requested: new Set([0, 1]), current: 1 };

      const { segments } = streams.snapshotStream(entry({ mode: 'youtube-hls', segmentGrid }));

      expect(segments).toMatchObject({ totalSegments: 4, segmentDurationSeconds: 6, currentSegmentIndex: 1, bufferedThroughIndex: 0, bufferComplete: false, backfillSegmentIndex: null });
    });
  });

  describe('tracking', () => {
    beforeEach(() => {
      streams.init({ models: null, hlsSessions: new Map(), destroyHlsSession: jest.fn() });
    });

    it('announces a newly tracked stream', () => {
      streams.trackStream(entry());

      expect(emitted('streamStarted')).toEqual([expect.objectContaining({ streamId: 's1', youtubeId: 'abc123DEF45' })]);
    });

    it('makes the stream retrievable and listed', () => {
      streams.trackStream(entry());

      expect(streams.getStream('s1')).toMatchObject({ streamId: 's1' });
      expect(streams.listStreams().map((s) => s.streamId)).toEqual(['s1']);
    });

    it('returns undefined for an unknown stream', () => {
      expect(streams.getStream('nope')).toBeUndefined();
    });

    it('persists the start of a tracked stream', async () => {
      const upsert = jest.fn().mockResolvedValue(undefined);
      streams.init({ models: { StreamHistory: { upsert, update: jest.fn() } }, hlsSessions: new Map(), destroyHlsSession: jest.fn() });

      streams.trackStream(entry());

      expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ stream_id: 's1' }));
    });

    it('tracks a pending request with zeroed counters and never persists it', () => {
      const upsert = jest.fn();
      streams.init({ models: { StreamHistory: { upsert, update: jest.fn() } }, hlsSessions: new Map(), destroyHlsSession: jest.fn() });

      streams.trackPendingRequest({ streamId: 'p1', mode: 'hls', youtubeId: 'x', state: 'requested' });

      expect(streams.getStream('p1')).toMatchObject({ bytesTransferred: 0, bytesPerSecond: 0, state: 'requested' });
      expect(upsert).not.toHaveBeenCalled();
    });

    it('lets a pending request override the defaults', () => {
      streams.trackPendingRequest({ streamId: 'p1', mode: 'hls', youtubeId: 'x', bytesTransferred: 7 });

      expect(streams.getStream('p1').bytesTransferred).toBe(7);
    });
  });

  describe('createBytesCounter', () => {
    it('adds bytes and refreshes the activity time', () => {
      const tracked = entry({ bytesTransferred: 10, lastActivityAt: 0 });

      streams.createBytesCounter(tracked)(5);

      expect(tracked.bytesTransferred).toBe(15);
      expect(tracked.lastActivityAt).toBe(Date.now());
    });

    it('is safe for an entry that is already gone', () => {
      expect(() => streams.createBytesCounter(undefined)(5)).not.toThrow();
    });
  });

  describe('updateStream', () => {
    beforeEach(() => {
      streams.init({ models: null, hlsSessions: new Map(), destroyHlsSession: jest.fn() });
    });

    it('returns null for an unknown stream', () => {
      expect(streams.updateStream('nope', { state: 'active' })).toBeNull();
    });

    it('merges the patch and broadcasts it immediately', () => {
      streams.trackStream(entry({ state: 'requested' }));
      messageEmitter.emitMessage.mockClear();

      const updated = streams.updateStream('s1', { state: 'resolving' });

      expect(updated.state).toBe('resolving');
      expect(emitted('streamProgress')).toEqual([{ streams: [expect.objectContaining({ streamId: 's1', state: 'resolving' })] }]);
    });
  });

  describe('throughput ticker', () => {
    beforeEach(() => {
      streams.init({ models: null, hlsSessions: new Map(), destroyHlsSession: jest.fn() });
    });

    it('broadcasts progress every 1.5 seconds', () => {
      streams.trackStream(entry());
      messageEmitter.emitMessage.mockClear();

      jest.advanceTimersByTime(3000);

      expect(emitted('streamProgress')).toHaveLength(2);
    });

    it('computes bytes per second from the bytes moved since tracking began', () => {
      const tracked = entry({ bytesTransferred: 0 });
      streams.trackStream(tracked);
      tracked.bytesTransferred = 3000;

      jest.advanceTimersByTime(1500);

      expect(tracked.bytesPerSecond).toBe(2000);
    });

    it('smooths bursts over a ten second window', () => {
      const tracked = entry({ bytesTransferred: 0 });
      streams.trackStream(tracked);
      tracked.bytesTransferred = 10000;
      jest.advanceTimersByTime(1500);
      jest.advanceTimersByTime(1500);

      // no new bytes since the burst, but it still counts within the window
      expect(tracked.bytesPerSecond).toBeCloseTo(10000 / 3, 0);
    });

    it('lets old samples fall out of the window', () => {
      const tracked = entry({ bytesTransferred: 0 });
      streams.trackStream(tracked);
      tracked.bytesTransferred = 10000;
      jest.advanceTimersByTime(1500);

      jest.advanceTimersByTime(15000);

      expect(tracked.bytesPerSecond).toBe(0);
    });

    it('keeps the sample history bounded', () => {
      const tracked = entry();
      streams.trackStream(tracked);

      jest.advanceTimersByTime(60000);

      expect(tracked.history.length).toBeLessThan(12);
    });

    it('stops ticking once the last stream ends', () => {
      streams.trackStream(entry());
      streams.untrackStream('s1', 'completed', null);
      messageEmitter.emitMessage.mockClear();

      jest.advanceTimersByTime(5000);

      expect(emitted('streamProgress')).toEqual([]);
    });

    it('stops ticking after the last stream is removed silently', () => {
      streams.trackStream(entry());
      // remove behind the ticker's back via the silent path, which keeps the timer for a tick
      streams.untrackStream('s1', 'promoted', null);
      messageEmitter.emitMessage.mockClear();

      jest.advanceTimersByTime(5000);

      expect(emitted('streamProgress')).toEqual([]);
    });

    it('restarts when a new stream is tracked after going idle', () => {
      streams.trackStream(entry());
      streams.untrackStream('s1', 'completed', null);
      streams.trackStream(entry({ streamId: 's2' }));
      messageEmitter.emitMessage.mockClear();

      jest.advanceTimersByTime(1500);

      expect(emitted('streamProgress')).toHaveLength(1);
    });
  });

  describe('untrackStream', () => {
    beforeEach(() => {
      streams.init({ models: null, hlsSessions: new Map(), destroyHlsSession: jest.fn() });
    });

    it('removes the stream and announces the stop', () => {
      streams.trackStream(entry());

      streams.untrackStream('s1', 'completed', null);

      expect(streams.getStream('s1')).toBeUndefined();
      expect(emitted('streamStopped')).toEqual([{ streamId: 's1', mode: 'direct', youtubeId: 'abc123DEF45', reason: 'completed' }]);
    });

    it('persists the end of the stream', () => {
      const update = jest.fn().mockResolvedValue(undefined);
      streams.init({ models: { StreamHistory: { upsert: jest.fn().mockResolvedValue(undefined), update } }, hlsSessions: new Map(), destroyHlsSession: jest.fn() });
      streams.trackStream(entry({ bytesTransferred: 99 }));

      streams.untrackStream('s1', 'client-disconnected', 'gone');

      expect(update).toHaveBeenCalledWith(expect.objectContaining({ end_reason: 'client-disconnected', error_message: 'gone', bytes_transferred: 99 }), { where: { stream_id: 's1' } });
    });

    it.each(['retry', 'stale-failed', 'promoted'])('removes silently for the internal reason %s', (reason) => {
      const update = jest.fn();
      streams.init({ models: { StreamHistory: { upsert: jest.fn().mockResolvedValue(undefined), update } }, hlsSessions: new Map(), destroyHlsSession: jest.fn() });
      streams.trackStream(entry());

      streams.untrackStream('s1', reason, null);

      expect(streams.getStream('s1')).toBeUndefined();
      expect(emitted('streamStopped')).toEqual([]);
      expect(update).not.toHaveBeenCalled();
    });

    it('does nothing for a stream that is not tracked', () => {
      streams.untrackStream('nope', 'completed', null);

      expect(emitted('streamStopped')).toEqual([]);
    });
  });

  describe('failStreamThenUntrack', () => {
    beforeEach(() => {
      streams.init({ models: null, hlsSessions: new Map(), destroyHlsSession: jest.fn() });
    });

    it('marks the stream failed and broadcasts it straight away', () => {
      streams.trackStream(entry());
      messageEmitter.emitMessage.mockClear();

      streams.failStreamThenUntrack('s1', 'ready-failed', 'no segment');

      expect(streams.getStream('s1')).toMatchObject({ state: 'failed', error: 'no segment' });
      expect(emitted('streamProgress')[0].streams[0]).toMatchObject({ state: 'failed', error: 'no segment' });
    });

    it('keeps the failed row visible for five seconds, then removes it', () => {
      streams.trackStream(entry());
      streams.failStreamThenUntrack('s1', 'ready-failed', 'no segment');

      jest.advanceTimersByTime(4999);
      expect(streams.getStream('s1')).toBeDefined();
      jest.advanceTimersByTime(1);

      expect(streams.getStream('s1')).toBeUndefined();
      expect(emitted('streamStopped')[0]).toMatchObject({ reason: 'ready-failed' });
    });

    it('stores a missing error as null', () => {
      streams.trackStream(entry());

      streams.failStreamThenUntrack('s1', 'ready-failed', undefined);

      expect(streams.getStream('s1').error).toBeNull();
    });

    it('does not remove a newer stream that reused the same id', () => {
      streams.trackStream(entry());
      streams.failStreamThenUntrack('s1', 'ready-failed', 'first attempt');
      streams.untrackStream('s1', 'retry', null);
      streams.trackStream(entry({ startedAt: 1 }));

      jest.advanceTimersByTime(6000);

      expect(streams.getStream('s1')).toBeDefined();
    });

    it('removes a stream that is not tracked as a plain untrack', () => {
      streams.failStreamThenUntrack('nope', 'ready-failed', 'x');

      expect(emitted('streamStopped')).toEqual([]);
    });
  });

  describe('ensureHlsIdleReaper', () => {
    const IDLE = 120_000;
    const SWEEP = 60_000;
    let destroyHlsSession;
    let hlsSessions;

    beforeEach(() => {
      destroyHlsSession = jest.fn();
      hlsSessions = new Map();
      streams.init({ models: null, hlsSessions, destroyHlsSession });
    });

    it('destroys a session that has been idle too long', () => {
      const session = { key: 'k1', lastAccess: Date.now() };
      hlsSessions.set('k1', session);
      streams.ensureHlsIdleReaper(IDLE, SWEEP);

      jest.advanceTimersByTime(IDLE + SWEEP);

      expect(destroyHlsSession).toHaveBeenCalledWith(session, 'idle-timeout');
    });

    it('leaves a recently used session alone', () => {
      hlsSessions.set('k1', { key: 'k1', lastAccess: Date.now() });
      streams.ensureHlsIdleReaper(IDLE, SWEEP);

      jest.advanceTimersByTime(SWEEP);

      expect(destroyHlsSession).not.toHaveBeenCalled();
    });

    it('defers reaping while a backfill pass is running', () => {
      hlsSessions.set('k1', { key: 'k1', lastAccess: Date.now() - 10 * IDLE, backfillInProgress: true });
      streams.ensureHlsIdleReaper(IDLE, SWEEP);

      jest.advanceTimersByTime(SWEEP);

      expect(destroyHlsSession).not.toHaveBeenCalled();
    });

    it('only installs the reaper once', () => {
      hlsSessions.set('k1', { key: 'k1', lastAccess: Date.now() - 10 * IDLE });

      streams.ensureHlsIdleReaper(IDLE, SWEEP);
      streams.ensureHlsIdleReaper(IDLE, SWEEP);
      jest.advanceTimersByTime(SWEEP);

      expect(destroyHlsSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('ensureProcessExitHandlers', () => {
    let handlers;

    beforeEach(() => {
      handlers = {};
      jest.spyOn(process, 'once').mockImplementation((event, fn) => { handlers[event] = fn; return process; });
    });

    it('installs exit, SIGTERM and SIGINT handlers once', () => {
      streams.init({ models: null, hlsSessions: new Map(), destroyHlsSession: jest.fn() });

      streams.ensureProcessExitHandlers();
      streams.ensureProcessExitHandlers();

      expect(Object.keys(handlers).sort()).toEqual(['SIGINT', 'SIGTERM', 'exit']);
      expect(process.once).toHaveBeenCalledTimes(3);
    });

    it('kills child processes and removes session directories on shutdown', () => {
      const dir = path.join(workDir, 'session-dir');
      fs.mkdirSync(dir);
      streams.init({ models: null, hlsSessions: new Map([['k1', { dir }]]), destroyHlsSession: jest.fn() });
      streams.ensureProcessExitHandlers();

      handlers.SIGTERM();

      expect(processRegistry.killAllChildProcesses).toHaveBeenCalledWith('SIGTERM');
      expect(fs.existsSync(dir)).toBe(false);
    });

    it.each(['exit', 'SIGINT'])('reports %s as the reason', (event) => {
      streams.init({ models: null, hlsSessions: new Map(), destroyHlsSession: jest.fn() });
      streams.ensureProcessExitHandlers();

      handlers[event]();

      expect(processRegistry.killAllChildProcesses).toHaveBeenCalledWith(event);
    });

    it('keeps going when a session directory cannot be removed', () => {
      jest.spyOn(fs, 'rmSync').mockImplementation(() => { throw new Error('busy'); });
      streams.init({ models: null, hlsSessions: new Map([['k1', { dir: '/x' }]]), destroyHlsSession: jest.fn() });
      streams.ensureProcessExitHandlers();

      expect(() => handlers.exit()).not.toThrow();
    });
  });
});
