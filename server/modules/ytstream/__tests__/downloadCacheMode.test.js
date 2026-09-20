/* eslint-env jest */
jest.mock('../../../logger');
// downloadCacheMode.js transitively requires configModule (via paths.js's
// YTSTREAM_CACHE_DIR and ytDlpRunner->tempPathManager) - the real
// configModule constructor reads config.json and calls logger.setLevel at
// module-load time, neither of which the plain logger mock above provides.
jest.mock('../../configModule', () => ({
  getConfig: jest.fn(() => ({})),
  directoryPath: '/tmp/youtarr-test-mock',
}));
const { buildCacheKey } = require('../downloadCacheMode');

describe('downloadCacheMode.buildCacheKey', () => {
  const baseParams = {
    youtubeId: 'dQw4w9WgXcQ',
    quality: '1080',
    qualityStrictness: 'fallback',
    transcode: 'h264',
    hardwareMode: 'vaapi',
    tuning: 'fast',
  };

  it('is deterministic for the same params', () => {
    expect(buildCacheKey({ ...baseParams })).toBe(buildCacheKey({ ...baseParams }));
  });

  it('differs when the youtubeId differs', () => {
    expect(buildCacheKey(baseParams)).not.toBe(buildCacheKey({ ...baseParams, youtubeId: 'otherId12345' }));
  });

  it('differs when quality differs', () => {
    expect(buildCacheKey(baseParams)).not.toBe(buildCacheKey({ ...baseParams, quality: '720' }));
  });

  it('differs when transcode differs (copy vs h264 must not collide)', () => {
    expect(buildCacheKey(baseParams)).not.toBe(buildCacheKey({ ...baseParams, transcode: 'copy' }));
  });
});
