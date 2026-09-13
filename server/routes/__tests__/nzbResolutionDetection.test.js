jest.mock('../../modules/configModule', () => ({
  getConfig: jest.fn(() => ({})),
  getCookiesPath: jest.fn(() => null),
  directoryPath: '/data',
}));
jest.mock('../../modules/videoSearchModule', () => ({
  attachLocalResolutionHeight: jest.fn(),
  searchVideos: jest.fn(),
  SearchCanceledError: class SearchCanceledError extends Error {},
  SearchTimeoutError: class SearchTimeoutError extends Error {},
}));
jest.mock('../../modules/nzbThumbnailProbe', () => ({
  fillUnknownDefinitions: jest.fn(),
}));
jest.mock('../../modules/jobModule', () => ({}));
jest.mock('../../modules/nzbDiagnosticLog', () => ({
  recordDiagnosticEvent: jest.fn(),
  getDiagnosticEvents: jest.fn(),
}));
jest.mock('../../logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../../models/channelvideo', () => ({}));
jest.mock('../../models/video', () => ({}));
jest.mock('../../modules/notifications/utils', () => ({ formatBytes: jest.fn() }));
jest.mock('../../modules/download/jobTypes', () => ({ nzbDownloadJobLabel: 'youtarr-nzb' }));

const nzb = require('../nzb');
const videoSearchModule = require('../../modules/videoSearchModule');
const nzbThumbnailProbe = require('../../modules/nzbThumbnailProbe');

describe('nzb.js getResolutionDetectionConfig', () => {
  test('defaults all three to true when nzb.resolutionDetection is missing (configs saved before this setting existed)', () => {
    expect(nzb.getResolutionDetectionConfig({})).toEqual({ fixed: true, thumb: true, extract: true });
  });

  test('respects explicit false values', () => {
    expect(
      nzb.getResolutionDetectionConfig({ nzb: { resolutionDetection: { fixed: false, thumb: false, extract: true } } })
    ).toEqual({ fixed: false, thumb: false, extract: true });
  });
});

describe('nzb.js applyResolutionDetection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('applies an already-known local resolution ("fixed") without a further DB lookup', async () => {
    const results = [{ youtubeId: 'a', localResolutionHeight: 1080 }];
    await nzb.applyResolutionDetection(results, { fixed: true, thumb: true, extract: true });

    expect(results[0].definition).toBe('hd');
    expect(results[0].actualHeightTier).toBe(1080);
    expect(results[0].resolutionSource).toBe('fixed');
    expect(videoSearchModule.attachLocalResolutionHeight).not.toHaveBeenCalled();
  });

  test('labels a known-local SD resolution correctly', async () => {
    const results = [{ youtubeId: 'a', localResolutionHeight: 288 }];
    await nzb.applyResolutionDetection(results, { fixed: true, thumb: true, extract: true });

    expect(results[0].definition).toBe('sd');
    expect(results[0].resolutionSource).toBe('fixed');
  });

  test('looks up localResolutionHeight when entirely missing (e.g. RSS-mode results that never went through videoSearchModule)', async () => {
    videoSearchModule.attachLocalResolutionHeight.mockImplementation(async (rs) => {
      rs[0].localResolutionHeight = 480;
    });
    const results = [{ youtubeId: 'a' }];
    await nzb.applyResolutionDetection(results, { fixed: true, thumb: true, extract: true });

    expect(videoSearchModule.attachLocalResolutionHeight).toHaveBeenCalledWith(results);
    expect(results[0].definition).toBe('sd');
    expect(results[0].resolutionSource).toBe('fixed');
  });

  test('does not look up local resolution at all when "fixed" is toggled off', async () => {
    const results = [{ youtubeId: 'a' }];
    await nzb.applyResolutionDetection(results, { fixed: false, thumb: true, extract: true });
    expect(videoSearchModule.attachLocalResolutionHeight).not.toHaveBeenCalled();
  });

  test('a known-null local lookup (already checked, genuinely never downloaded) is not looked up again', async () => {
    const results = [{ youtubeId: 'a', localResolutionHeight: null }];
    await nzb.applyResolutionDetection(results, { fixed: true, thumb: true, extract: true });
    expect(videoSearchModule.attachLocalResolutionHeight).not.toHaveBeenCalled();
  });

  test('tags an already-known API definition with source "api" before handing off to the probe', async () => {
    const results = [{ youtubeId: 'a', definition: 'hd', localResolutionHeight: null }];
    await nzb.applyResolutionDetection(results, { fixed: true, thumb: true, extract: true });

    expect(results[0].resolutionSource).toBe('api');
    expect(nzbThumbnailProbe.fillUnknownDefinitions).toHaveBeenCalled();
  });

  test('a "fixed" match takes precedence over an existing API definition', async () => {
    const results = [{ youtubeId: 'a', definition: 'hd', localResolutionHeight: 360 }];
    await nzb.applyResolutionDetection(results, { fixed: true, thumb: true, extract: true });

    expect(results[0].definition).toBe('sd');
    expect(results[0].actualHeightTier).toBe(360);
    expect(results[0].resolutionSource).toBe('fixed');
  });

  test('passes the thumb/extract toggles straight through to nzbThumbnailProbe.fillUnknownDefinitions', async () => {
    const results = [{ youtubeId: 'a', localResolutionHeight: null }];
    await nzb.applyResolutionDetection(results, { fixed: true, thumb: false, extract: true });
    expect(nzbThumbnailProbe.fillUnknownDefinitions).toHaveBeenCalledWith(results, { useThumb: false, useExtract: true });
  });

  test('returns durationMs and the queryCount fillUnknownDefinitions reports, for the diagnostics page\'s Resolution column', async () => {
    nzbThumbnailProbe.fillUnknownDefinitions.mockResolvedValueOnce(3);
    const results = [{ youtubeId: 'a', localResolutionHeight: null }];
    const outcome = await nzb.applyResolutionDetection(results, { fixed: true, thumb: true, extract: true });
    expect(outcome.queryCount).toBe(3);
    expect(typeof outcome.durationMs).toBe('number');
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('reports queryCount 0 when fillUnknownDefinitions resolves nothing (e.g. every item already settled)', async () => {
    nzbThumbnailProbe.fillUnknownDefinitions.mockResolvedValueOnce(undefined);
    const results = [{ youtubeId: 'a', definition: 'hd', localResolutionHeight: null }];
    const outcome = await nzb.applyResolutionDetection(results, { fixed: true, thumb: true, extract: true });
    expect(outcome.queryCount).toBe(0);
  });
});
