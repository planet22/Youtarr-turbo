/* eslint-env jest */

const { estimateVideoBandwidthBps } = require('../videoBandwidthEstimate');

describe('estimateVideoBandwidthBps', () => {
  it('returns the 480p tier for heights at or below 480', () => {
    expect(estimateVideoBandwidthBps(480)).toBe(3_000_000);
    expect(estimateVideoBandwidthBps(360)).toBe(3_000_000);
  });

  it('returns the 1080p tier for a 1920x1080 source', () => {
    expect(estimateVideoBandwidthBps(1080)).toBe(10_000_000);
  });

  it('returns the top (4K+) tier for anything above 1440', () => {
    expect(estimateVideoBandwidthBps(2160)).toBe(30_000_000);
    expect(estimateVideoBandwidthBps(4320)).toBe(30_000_000);
  });

  it('picks the first tier whose maxHeight covers an in-between height', () => {
    // 900 isn't an exact tier boundary - should land on the 1080p tier,
    // not silently fall through to 720p or skip to 1440p.
    expect(estimateVideoBandwidthBps(900)).toBe(10_000_000);
  });
});
