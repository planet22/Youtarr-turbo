/* eslint-env jest */

jest.mock('../../../logger');

jest.mock('../../messageEmitter', () => ({
  emitMessage: jest.fn()
}));

jest.mock('../../filesystem', () => {
  const actualPathBuilder = jest.requireActual('../../filesystem/pathBuilder');
  return {
    isMainVideoFile: jest.fn().mockReturnValue(true),
    extractYoutubeIdFromPath: jest.fn(actualPathBuilder.extractYoutubeIdFromPath),
  };
});

jest.mock('../../../models', () => ({
  JobVideoDownload: {
    findOrCreate: jest.fn().mockResolvedValue([{}, true])
  }
}));

const { JobVideoDownload } = require('../../../models');
const jobEventLog = require('../../jobEventLog');
const YtdlpOutputRouter = require('../YtdlpOutputRouter');

const DESTINATION_LINE = '[download] Destination: /output/Channel - Title [abc123XYZ_d].mp4\n';

// findOrCreate resolves asynchronously and the log call sits in its .then
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('YtdlpOutputRouter video/events log', () => {
  let router;

  beforeEach(() => {
    jest.clearAllMocks();
    JobVideoDownload.findOrCreate.mockResolvedValue([{}, true]);
    router = new YtdlpOutputRouter({
      jobId: 'job-123',
      config: { enableStallDetection: false },
      monitor: {
        hasError: false,
        lastParsed: null,
        processProgress: jest.fn().mockReturnValue({ state: 'downloading_video' }),
        snapshot: jest.fn((state) => ({ state })),
      },
      errorTracker: {
        currentVideoId: null,
        trackVideoStart: jest.fn(),
        trackVideoFromDestination: jest.fn(),
        handleErrorLine: jest.fn().mockReturnValue(false),
      },
      timeoutController: { noteLine: jest.fn(), noteActivity: jest.fn() },
    });
  });

  it('records video.download_started the first time a video destination is seen', async () => {
    router.handleStdoutChunk(DESTINATION_LINE);
    await settle();

    expect(jobEventLog.record).toHaveBeenCalledWith('video.download_started', {
      jobId: 'job-123',
      youtubeId: 'abc123XYZ_d',
      detail: { destination: '/output/Channel - Title [abc123XYZ_d].mp4' },
    });
  });

  it('records nothing when the tracking row already existed', async () => {
    JobVideoDownload.findOrCreate.mockResolvedValue([{}, false]);

    router.handleStdoutChunk(DESTINATION_LINE);
    await settle();

    expect(jobEventLog.record).not.toHaveBeenCalled();
  });

  it('records nothing for a line without a destination', async () => {
    router.handleStdoutChunk('[download]  42.0% of 10.00MiB at 1.00MiB/s ETA 00:05\n');
    await settle();

    expect(jobEventLog.record).not.toHaveBeenCalled();
  });

  it('still routes the destination when the tracking write fails', async () => {
    JobVideoDownload.findOrCreate.mockRejectedValue(new Error('db down'));

    router.handleStdoutChunk(DESTINATION_LINE);
    await settle();

    expect(router.partialDestinations.has('/output/Channel - Title [abc123XYZ_d].mp4')).toBe(true);
  });

  it('does not record an event when the tracking write fails', async () => {
    JobVideoDownload.findOrCreate.mockRejectedValue(new Error('db down'));

    router.handleStdoutChunk(DESTINATION_LINE);
    await settle();

    expect(jobEventLog.record).not.toHaveBeenCalled();
  });
});
