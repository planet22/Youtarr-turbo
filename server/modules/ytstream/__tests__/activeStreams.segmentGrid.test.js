/* eslint-env jest */
jest.mock('../../../logger');
jest.mock('../../messageEmitter', () => ({ emitMessage: jest.fn() }));
jest.mock('../../youtubeMetadataCache', () => ({ getCachedTitle: jest.fn() }));
jest.mock('../../configModule', () => ({
  getConfig: jest.fn(() => ({})),
  directoryPath: '/tmp/youtarr-test-mock',
}));

const { snapshotStream } = require('../activeStreams');

const baseEntry = (overrides = {}) => ({
  streamId: 's1', mode: 'youtube-hls', youtubeId: 'vid00000001', quality: '1080', state: 'active', startedAt: 1, bytesTransferred: 0, bytesPerSecond: 0, lastActivityAt: 1, ...overrides,
});

describe('snapshotStream segments for a youtube-hls row with segments routed through Youtarr', () => {
  const grid = { total: 4, durationSeconds: 5, requested: [true, true, false, false], current: 1 };

  it('reports the requested segments in the same shape as an hls session', () => {
    expect(snapshotStream(baseEntry({ segmentGrid: grid })).segments).toEqual({
      totalSegments: 4,
      segmentDurationSeconds: 5,
      encoded: [true, true, false, false],
      bufferedThroughIndex: 0,
      bufferComplete: false,
      currentSegmentIndex: 1,
      backfillSegmentIndex: null,
    });
  });

  it('gives the client its own copy of the requested flags', () => {
    const snapshot = snapshotStream(baseEntry({ segmentGrid: grid }));
    snapshot.segments.encoded[3] = true;
    expect(grid.requested[3]).toBe(false);
  });

  it('reports no segments for a row without a grid (every other mode)', () => {
    expect(snapshotStream(baseEntry({ mode: 'direct' })).segments).toBeNull();
  });

  it('reports the estimate flag and playback position for a routed row', () => {
    const snapshot = snapshotStream(baseEntry({ segmentGrid: grid, bytesEstimated: true, playbackSeconds: 5 }));
    expect([snapshot.bytesEstimated, snapshot.playbackSeconds]).toEqual([true, 5]);
  });

  it('reports exact totals and no position for a row that never estimated', () => {
    const snapshot = snapshotStream(baseEntry());
    expect([snapshot.bytesEstimated, snapshot.playbackSeconds]).toEqual([false, null]);
  });
});
