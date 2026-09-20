/* eslint-env jest */
jest.mock('../../../logger');
// byteRangeServe.js transitively requires configModule (via streamDebug) -
// see byteRangeHlsMode.test.js for why it needs mocking.
jest.mock('../../configModule', () => ({
  getConfig: jest.fn(() => ({})),
  directoryPath: '/tmp/youtarr-test-mock',
}));

const { resolveVirtualRange, waitForRangeAvailable, isFfmpegClient } = require('../byteRangeServe');

describe('byteRangeServe.resolveVirtualRange', () => {
  const sizes = { baseSize: 1000, streamSize: 500 };

  it('serves a range inside the base file from the base file', () => {
    expect(resolveVirtualRange({ ...sizes, rangeHeader: 'bytes=100-199' })).toMatchObject({ source: 'base', srcStart: 100, srcEnd: 199, start: 100, end: 199, total: 1500 });
  });

  it('caps a range starting in the base file at the base file end instead of straddling into the stream file', () => {
    expect(resolveVirtualRange({ ...sizes, rangeHeader: 'bytes=900-1400' })).toMatchObject({ source: 'base', srcStart: 900, srcEnd: 999, end: 999 });
  });

  it('rebases a range starting in the stream file onto that file\'s own offsets', () => {
    expect(resolveVirtualRange({ ...sizes, rangeHeader: 'bytes=1200-1299' })).toMatchObject({ source: 'stream', srcStart: 200, srcEnd: 299, start: 1200, end: 1299 });
  });

  it('clamps an open-ended stream range to the stream file end', () => {
    expect(resolveVirtualRange({ ...sizes, rangeHeader: 'bytes=1000-' })).toMatchObject({ source: 'stream', srcStart: 0, srcEnd: 499, end: 1499 });
  });

  it('treats a missing Range header as a request from byte 0', () => {
    expect(resolveVirtualRange({ ...sizes, rangeHeader: undefined })).toMatchObject({ source: 'base', srcStart: 0, srcEnd: 999 });
  });

  it('returns null for a range starting past the virtual end', () => {
    expect(resolveVirtualRange({ ...sizes, rangeHeader: 'bytes=5000-' })).toBeNull();
  });

  it('returns null when nothing exists yet', () => {
    expect(resolveVirtualRange({ baseSize: 0, streamSize: 0, rangeHeader: 'bytes=0-' })).toBeNull();
  });
});

describe('byteRangeServe.waitForRangeAvailable', () => {
  const logContext = { sessionKey: 'k', youtubeId: 'v' };

  it('returns immediately when the requested start already exists', async () => {
    const getSize = jest.fn(() => 500);
    await waitForRangeAvailable({ headers: { range: 'bytes=100-' } }, { getSize, isDone: () => false, isFailed: () => false, logContext });
    expect(getSize).toHaveBeenCalledTimes(1);
  });

  it('does not wait when there is no Range header', async () => {
    const getSize = jest.fn(() => 0);
    await waitForRangeAvailable({ headers: {} }, { getSize, isDone: () => false, isFailed: () => false, logContext });
    expect(getSize).not.toHaveBeenCalled();
  });

  it('gives up immediately when the encode has already finished', async () => {
    const getSize = jest.fn(() => 10);
    await waitForRangeAvailable({ headers: { range: 'bytes=100-' } }, { getSize, isDone: () => true, isFailed: () => false, logContext });
    expect(getSize).toHaveBeenCalledTimes(1);
  });

  it('gives up immediately when the session has failed', async () => {
    const getSize = jest.fn(() => 10);
    await waitForRangeAvailable({ headers: { range: 'bytes=100-' } }, { getSize, isDone: () => false, isFailed: () => true, logContext });
    expect(getSize).toHaveBeenCalledTimes(1);
  });
});

describe('byteRangeServe.isFfmpegClient', () => {
  const withUa = (ua) => ({ headers: { 'user-agent': ua } });

  it('recognizes ffmpeg\'s HTTP client', () => {
    expect(isFfmpegClient(withUa('Lavf/62.12.102'))).toBe(true);
  });

  it('does not treat a browser as ffmpeg', () => {
    expect(isFfmpegClient(withUa('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153.0 Safari/537.36'))).toBe(false);
  });

  it('does not match Lavf appearing later in the string', () => {
    expect(isFfmpegClient(withUa('Something Lavf/1'))).toBe(false);
  });

  it('is false when there is no User-Agent', () => {
    expect(isFfmpegClient({ headers: {} })).toBe(false);
  });
});
