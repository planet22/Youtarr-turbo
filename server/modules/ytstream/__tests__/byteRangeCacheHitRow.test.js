/* eslint-env jest */
jest.mock('../../../logger');
jest.mock('../streamDebug', () => ({ streamDebug: jest.fn() }));
jest.mock('../../messageEmitter', () => ({ emitMessage: jest.fn() }));
jest.mock('../../youtubeMetadataCache', () => ({ getCachedTitle: jest.fn() }));
jest.mock('../../configModule', () => ({
  getConfig: jest.fn(() => ({})),
  directoryPath: '/tmp/youtarr-test-mock',
}));

const { EventEmitter } = require('events');
const { streamDebug } = require('../streamDebug');
const logger = require('../../../logger');
const { getStream, untrackStream, listStreams } = require('../activeStreams');
const { CACHE_HIT_MODE, IDLE_HOLD_MS, beginCacheHit, resetCacheHitRows } = require('../byteRangeCacheHitRow');

const params = (overrides = {}) => ({
  streamId: 'cachehit-abc',
  youtubeId: 'vid00000001',
  quality: '1080',
  transcode: 'copy',
  container: 'mkv',
  clientIp: '10.0.0.5',
  userAgent: 'Lavf/62',
  ...overrides,
});

function fakeRes() {
  const res = new EventEmitter();
  res.destroy = jest.fn();
  res.req = { headers: { range: 'bytes=0-' } };
  return res;
}

describe('byteRangeCacheHitRow', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    resetCacheHitRows();
    listStreams().forEach((entry) => untrackStream(entry.streamId, 'promoted'));
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('creates a Live Streams row on the first request', () => {
    beginCacheHit(params(), fakeRes());
    expect(getStream('cachehit-abc')).toMatchObject({ mode: CACHE_HIT_MODE, container: 'mkv', state: 'active', youtubeId: 'vid00000001' });
  });

  it('shares one row between several requests for the same cache entry', () => {
    beginCacheHit(params(), fakeRes());
    beginCacheHit(params({ clientIp: '10.0.0.6' }), fakeRes());
    expect(listStreams()).toHaveLength(1);
  });

  it('records each client as a viewer of the row', () => {
    beginCacheHit(params(), fakeRes());
    beginCacheHit(params({ clientIp: '10.0.0.6' }), fakeRes());
    expect([...getStream('cachehit-abc').viewers.keys()]).toEqual(['10.0.0.5', '10.0.0.6']);
  });

  it('counts the bytes sent onto the row', () => {
    const { onBytesSent } = beginCacheHit(params(), fakeRes());
    onBytesSent(1000);
    onBytesSent(500);
    expect(getStream('cachehit-abc').bytesTransferred).toBe(1500);
  });

  it('keeps the row while a request is still in flight, however long it runs', () => {
    beginCacheHit(params(), fakeRes());
    jest.advanceTimersByTime(IDLE_HOLD_MS * 3);
    expect(getStream('cachehit-abc')).toBeDefined();
  });

  it('removes the row once every request is done and the idle hold has passed', () => {
    const res = fakeRes();
    beginCacheHit(params(), res);
    res.emit('close');
    jest.advanceTimersByTime(IDLE_HOLD_MS + 20 * 1000);
    expect(getStream('cachehit-abc')).toBeUndefined();
  });

  it('keeps the row through a quiet gap shorter than the idle hold', () => {
    const res = fakeRes();
    beginCacheHit(params(), res);
    res.emit('close');
    jest.advanceTimersByTime(IDLE_HOLD_MS - 6 * 1000);
    expect(getStream('cachehit-abc')).toBeDefined();
  });

  it('logs each finished request with the bytes read and its speed', () => {
    const res = fakeRes();
    const { onBytesSent } = beginCacheHit(params(), res);
    onBytesSent(2 * 1024 * 1024);
    jest.advanceTimersByTime(1000);
    res.emit('close');
    expect(streamDebug).toHaveBeenCalledWith(
      expect.objectContaining({ sentMB: 2, range: 'bytes=0-', MBps: 2 }),
      'ytstream: byte-range cache hit - request finished'
    );
  });

  it('logs a throughput heartbeat while a player is reading', () => {
    const { onBytesSent } = beginCacheHit(params(), fakeRes());
    onBytesSent(10 * 1024 * 1024);
    jest.advanceTimersByTime(5000);
    expect(streamDebug).toHaveBeenCalledWith(
      expect.objectContaining({ readMB: 10, MBps: 2, inFlight: 1 }),
      'ytstream: byte-range cache hit - throughput heartbeat (reading the cached file)'
    );
  });

  it('logs a summary with the total read when the row ends', () => {
    const res = fakeRes();
    const { onBytesSent } = beginCacheHit(params(), res);
    onBytesSent(3 * 1024 * 1024);
    res.emit('close');
    jest.advanceTimersByTime(IDLE_HOLD_MS + 20 * 1000);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'idle-timeout', totalMB: 3, requests: 1 }),
      'ytstream: byte-range cache-hit Live Streams row ended'
    );
  });

  it('Stop removes the row and cuts the transfers still running', () => {
    const res = fakeRes();
    beginCacheHit(params(), res);
    getStream('cachehit-abc').stop();
    expect(getStream('cachehit-abc')).toBeUndefined();
    expect(res.destroy).toHaveBeenCalled();
  });

  it('starts a fresh row for a request after the previous one was stopped', () => {
    beginCacheHit(params(), fakeRes());
    getStream('cachehit-abc').stop();
    beginCacheHit(params(), fakeRes());
    expect(getStream('cachehit-abc')).toBeDefined();
  });
});
