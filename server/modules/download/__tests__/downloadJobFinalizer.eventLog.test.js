/* eslint-env jest */

jest.mock('../../../logger');

jest.mock('../../jobModule', () => ({
  updateJob: jest.fn().mockResolvedValue(),
  startNextJob: jest.fn(() => Promise.resolve()),
  getJob: jest.fn(),
  saveJobOnly: jest.fn().mockResolvedValue()
}));

jest.mock('../../configModule', () => ({
  getConfig: jest.fn().mockReturnValue({}),
  getCookiesPath: jest.fn().mockReturnValue(null)
}));

jest.mock('../../messageEmitter', () => ({ emitMessage: jest.fn() }));
jest.mock('../../notificationModule', () => ({ sendDownloadNotification: jest.fn().mockResolvedValue() }));
jest.mock('../videoMetadataProcessor', () => ({ processVideoMetadata: jest.fn().mockResolvedValue([]) }));
jest.mock('../downloadRunTracker', () => ({ isActive: jest.fn().mockReturnValue(false), recordJobResult: jest.fn() }));
jest.mock('../downloadResultProcessor', () => ({
  resolveUrlsToProcess: jest.fn().mockReturnValue([]),
  partitionDownloadResults: jest.fn().mockReturnValue({ successfulVideos: [], failedVideosList: [] }),
  reconcileArchive: jest.fn().mockResolvedValue()
}));
jest.mock('../downloadCleanup', () => ({
  cleanupInProgressVideos: jest.fn().mockResolvedValue(),
  cleanupPartialFiles: jest.fn().mockResolvedValue()
}));
jest.mock('../downloadCompletionEffects', () => ({ runCompletionSideEffects: jest.fn().mockResolvedValue() }));
jest.mock('../failedVideoEnricher', () => ({ enrichFailedVideos: jest.fn().mockResolvedValue() }));

const downloadResultProcessor = require('../downloadResultProcessor');
const jobEventLog = require('../../jobEventLog');
const { finalizeDownloadJob } = require('../downloadJobFinalizer');

const context = (overrides = {}) => ({
  jobId: 'job-123',
  jobType: 'Manually Added Urls',
  code: 0,
  signal: null,
  monitor: {
    videoCount: { current: 1, total: 0, completed: 0, skipped: 0 },
    hasError: false,
    lastParsed: null,
    currentChannelName: '',
    snapshot: jest.fn((state) => ({ state })),
  },
  errorTracker: {
    failedVideos: new Map(),
    expectedSkipCount: 0,
    unexpectedErrorCount: 0,
    terminatedChannelIds: new Set(),
    terminatedChannels: [],
    terminationFailures: [],
    membersOnlyVideoIds: new Set(),
    settlePersistence: jest.fn().mockResolvedValue(),
  },
  timeoutController: { shutdownInProgress: false, shutdownReason: null },
  router: {
    stderrBuffer: '',
    botDetected: false,
    httpForbiddenDetected: false,
    partialDestinations: new Set(),
    emitCookiesSuggestion: jest.fn(),
  },
  wasManuallyTerminated: false,
  manualReason: null,
  initialCount: 0,
  originalUrls: null,
  allowRedownload: false,
  skipJobTransition: false,
  runId: null,
  tempChannelsFile: null,
  onTempChannelsFileCleaned: jest.fn(),
  ...overrides,
});

const failing = (failedVideosList) => {
  downloadResultProcessor.partitionDownloadResults.mockReturnValue({ successfulVideos: [], failedVideosList });
};

describe('downloadJobFinalizer video/events log', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    failing([]);
  });

  it('records video.failed for each failed video with its error and snapshot', async () => {
    failing([{ youtubeId: 'abc123def45', title: 'A Title', channel: 'A Channel', error: 'Video unavailable' }]);

    await finalizeDownloadJob(context());

    expect(jobEventLog.record).toHaveBeenCalledWith('video.failed', {
      jobId: 'job-123',
      youtubeId: 'abc123def45',
      videoTitle: 'A Title',
      channelName: 'A Channel',
      detail: { error: 'Video unavailable', diagnosisKey: undefined, autoRetryQueued: false },
    });
  });

  it('records one video.failed per failed video', async () => {
    failing([
      { youtubeId: 'aaaaaaaaaaa', error: 'e1' },
      { youtubeId: 'bbbbbbbbbbb', error: 'e2' },
    ]);

    await finalizeDownloadJob(context());

    const failedCalls = jobEventLog.record.mock.calls.filter(([type]) => type === 'video.failed');
    expect(failedCalls.map(([, fields]) => fields.youtubeId)).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
  });

  it('records nothing when no video failed', async () => {
    await finalizeDownloadJob(context());

    expect(jobEventLog.record).not.toHaveBeenCalled();
  });

  it('records video.auto_retry_queued for failures already handed to a retry job', async () => {
    failing([{ youtubeId: 'abc123def45', error: 'HTTP Error 403: Forbidden', autoRetryQueued: true }]);

    await finalizeDownloadJob(context());

    expect(jobEventLog.record).toHaveBeenCalledWith('video.auto_retry_queued', expect.objectContaining({ youtubeId: 'abc123def45' }));
  });

  it('does not record video.auto_retry_queued for an ordinary failure', async () => {
    failing([{ youtubeId: 'abc123def45', error: 'Video unavailable' }]);

    await finalizeDownloadJob(context());

    const types = jobEventLog.record.mock.calls.map(([type]) => type);
    expect(types).not.toContain('video.auto_retry_queued');
  });
});
