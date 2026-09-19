/* eslint-env jest */
jest.mock('../../../logger');
jest.mock('../playbackPlan', () => ({ getVideoDurationSeconds: jest.fn(() => Promise.resolve(null)) }));
jest.mock('../../configModule', () => ({
  getConfig: jest.fn(() => ({})),
  directoryPath: '/tmp/youtarr-test-mock',
}));
jest.mock('../paths', () => ({
  YTSTREAM_CACHE_DIR: require('path').join(require('os').tmpdir(), 'byterange-dryrun-test-fixed'),
}));

const fs = require('fs');
const path = require('path');
const { PERSISTENT_CACHE_DIR } = require('../byteRangeCacheIndex');
const { describeByteRangeRun, buildSessionKey } = require('../byteRangeHlsMode');

const baseParams = {
  youtubeId: 'vid00000001', quality: '1080', qualityStrictness: 'fallback', transcode: 'copy', hardwareMode: 'none', tuning: 'fast',
  container: 'mp4', deliverAsFile: true, resumeCache: false,
};

function writeCache(params, { ext = 'mp4', bytes = 4096, meta = { complete: true, durationSeconds: 100 } } = {}) {
  const key = buildSessionKey(params);
  fs.mkdirSync(PERSISTENT_CACHE_DIR, { recursive: true });
  fs.writeFileSync(path.join(PERSISTENT_CACHE_DIR, `${key}.${ext}`), Buffer.alloc(bytes));
  if (meta) fs.writeFileSync(path.join(PERSISTENT_CACHE_DIR, `${key}.json`), JSON.stringify({ ...meta, youtubeId: params.youtubeId }));
}

describe('describeByteRangeRun', () => {
  beforeEach(() => fs.rmSync(path.dirname(PERSISTENT_CACHE_DIR), { recursive: true, force: true }));
  afterAll(() => fs.rmSync(path.dirname(PERSISTENT_CACHE_DIR), { recursive: true, force: true }));

  it('reports the same session key the real request would use', () => {
    expect(describeByteRangeRun(baseParams).sessionKey).toBe(buildSessionKey(baseParams));
  });

  it('would start a fresh encode when nothing is cached', () => {
    expect(describeByteRangeRun(baseParams).wouldCall).toMatch(/fresh encode/);
  });

  it('would serve a finished cache entry directly', () => {
    writeCache(baseParams);
    expect(describeByteRangeRun(baseParams).wouldCall).toMatch(/stealth-cache hit/);
  });

  it('reports the cache entry size and completeness', () => {
    writeCache(baseParams, { bytes: 5000 });
    expect(describeByteRangeRun(baseParams).cache).toMatchObject({ exists: true, sizeBytes: 5000, complete: true });
  });

  it('finds an mkv cache entry under its .mkv name', () => {
    const mkv = { ...baseParams, container: 'mkv' };
    writeCache(mkv, { ext: 'mkv' });
    expect(describeByteRangeRun(mkv).cache.path.endsWith('.mkv')).toBe(true);
  });

  it('describes Matroska delivery for the mkv container', () => {
    expect(describeByteRangeRun({ ...baseParams, container: 'mkv' }).delivery).toMatch(/Matroska/);
  });

  it('ignores a cached partial when resume is off', () => {
    writeCache(baseParams, { meta: { complete: false, durationSeconds: 50 } });
    expect(describeByteRangeRun(baseParams).wouldCall).toMatch(/resume is off/);
  });

  it('reports whether a partial mkv could be resumed when resume is on', () => {
    const mkv = { ...baseParams, container: 'mkv', resumeCache: true };
    writeCache(mkv, { ext: 'mkv', meta: { complete: false, durationSeconds: 50, mkvResumeFailed: true } });
    const result = describeByteRangeRun(mkv);
    expect([result.cache.resumable, result.cache.resumeFailedBefore]).toEqual([false, true]);
  });

  it('describes the manifest variant when deliverAsFile is off', () => {
    const result = describeByteRangeRun({ ...baseParams, deliverAsFile: false });
    expect(result.delivery).toMatch(/manifest/);
    expect(result.cache).toBeUndefined();
  });

  it('never creates anything on disk', () => {
    describeByteRangeRun(baseParams);
    expect(fs.existsSync(PERSISTENT_CACHE_DIR)).toBe(false);
  });
});
