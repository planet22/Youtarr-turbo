/* eslint-env jest */
jest.mock('../../../logger');
jest.mock('../../messageEmitter', () => ({ emitMessage: jest.fn() }));
jest.mock('../../youtubeMetadataCache', () => ({ getCachedTitle: jest.fn() }));
jest.mock('../../configModule', () => ({
  getConfig: jest.fn(() => ({})),
  directoryPath: '/tmp/youtarr-test-mock',
}));

const { createBytesCounter } = require('../activeStreams');

describe('activeStreams.createBytesCounter', () => {
  it('adds each chunk to the stream entry total', () => {
    const entry = { bytesTransferred: 0, lastActivityAt: 0 };
    const count = createBytesCounter(entry);
    count(1000);
    count(500);
    expect(entry.bytesTransferred).toBe(1500);
  });

  it('refreshes the entry activity time', () => {
    const entry = { bytesTransferred: 0, lastActivityAt: 0 };
    createBytesCounter(entry)(10);
    expect(entry.lastActivityAt).toBeGreaterThan(0);
  });

  it('is a safe no-op when the stream has no tracked entry', () => {
    expect(() => createBytesCounter(undefined)(10)).not.toThrow();
  });
});
