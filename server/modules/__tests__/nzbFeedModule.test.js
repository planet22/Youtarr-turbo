jest.mock('../../logger', () => ({
  info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn(),
}));

const nzbFeedModule = require('../nzbFeedModule');

const baseOpts = {
  categoryName: 'TestCategory',
  newznabCategoryIds: ['5040'],
  baseUrl: 'http://localhost:3011',
  apikey: 'testkey',
  quality: '1080',
};

describe('nzbFeedModule.buildSearchXml - per-result quality capping', () => {
  test('labels an unknown-definition result at the full configured quality', () => {
    const xml = nzbFeedModule.buildSearchXml(
      [{ youtubeId: 'abc123', title: 'Some Video', duration: 600 }],
      baseOpts
    );
    expect(xml).toContain('Some Video [1080p]');
  });

  test('caps the label to 480p when the result is known to be SD-only', () => {
    const xml = nzbFeedModule.buildSearchXml(
      [{ youtubeId: 'abc123', title: 'Old Low-Res Upload', duration: 600, definition: 'sd' }],
      baseOpts
    );
    expect(xml).toContain('Old Low-Res Upload [480p]');
    expect(xml).not.toContain('[1080p]');
  });

  test('does not raise an SD result above a configured quality already below the SD ceiling', () => {
    const xml = nzbFeedModule.buildSearchXml(
      [{ youtubeId: 'abc123', title: 'Low Quality Setting', duration: 600, definition: 'sd' }],
      { ...baseOpts, quality: '360' }
    );
    expect(xml).toContain('Low Quality Setting [360p]');
  });

  test('leaves an HD-flagged result at the full configured quality', () => {
    const xml = nzbFeedModule.buildSearchXml(
      [{ youtubeId: 'abc123', title: 'Real HD Video', duration: 600, definition: 'hd' }],
      baseOpts
    );
    expect(xml).toContain('Real HD Video [1080p]');
  });

  test('estimates a smaller file size for a capped SD result than an uncapped one of the same duration', () => {
    const sdXml = nzbFeedModule.buildSearchXml(
      [{ youtubeId: 'sd1', title: 'SD', duration: 1200, definition: 'sd' }],
      baseOpts
    );
    const hdXml = nzbFeedModule.buildSearchXml(
      [{ youtubeId: 'hd1', title: 'HD', duration: 1200, definition: 'hd' }],
      baseOpts
    );
    const sdSize = Number(/<size>(\d+)<\/size>/.exec(sdXml)[1]);
    const hdSize = Number(/<size>(\d+)<\/size>/.exec(hdXml)[1]);
    expect(sdSize).toBeLessThan(hdSize);
  });

  test('uses an exact actualHeightTier over the coarse SD ceiling when both are present', () => {
    const xml = nzbFeedModule.buildSearchXml(
      [{ youtubeId: 'abc123', title: 'Old Low-Res Upload', duration: 600, definition: 'sd', actualHeightTier: 360 }],
      baseOpts
    );
    expect(xml).toContain('Old Low-Res Upload [360p]');
    expect(xml).not.toContain('[480p]');
  });

  test('caps actualHeightTier against the configured quality if the source somehow exceeds it', () => {
    const xml = nzbFeedModule.buildSearchXml(
      [{ youtubeId: 'abc123', title: 'Exceeds Configured', duration: 600, definition: 'hd', actualHeightTier: 2160 }],
      { ...baseOpts, quality: '1080' }
    );
    expect(xml).toContain('Exceeds Configured [1080p]');
  });

  test('mixed-result search labels each item at its own effective tier', () => {
    const xml = nzbFeedModule.buildSearchXml(
      [
        { youtubeId: 'a', title: 'HD One', duration: 300, definition: 'hd' },
        { youtubeId: 'b', title: 'SD One', duration: 300, definition: 'sd' },
        { youtubeId: 'c', title: 'Unknown One', duration: 300 },
      ],
      baseOpts
    );
    expect(xml).toContain('HD One [1080p]');
    expect(xml).toContain('SD One [480p]');
    expect(xml).toContain('Unknown One [1080p]');
  });
});
