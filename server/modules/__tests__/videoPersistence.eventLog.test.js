/* eslint-env jest */

jest.mock('../../models/job');
jest.mock('../../models/video');
jest.mock('../../models/jobvideo');
jest.mock('../../models/channelvideo');
jest.mock('../channelVideoReanchor', () => ({
  applyExactDateForGroup: jest.fn().mockResolvedValue(undefined),
  applyExactDateForVideo: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../download/videoMetadataProcessor', () => ({
  processVideoMetadata: jest.fn(),
}));
jest.mock('../strmMediaInfoCache', () => ({
  getMediaInfoCachePath: (p) => `${p}.mediainfo.json`,
}));
jest.mock('../../logger');

const mockFs = { existsSync: jest.fn(), renameSync: jest.fn() };
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: (...args) => mockFs.existsSync(...args),
  renameSync: (...args) => mockFs.renameSync(...args),
}));

// Archiving a STRM sidecar (a real download replaced the .strm) is logged once
// per file actually renamed, tied to the video the caller passes.
describe('videoPersistence STRM archive log entries', () => {
  let videoPersistence;
  let jobEventLog;
  const video = { youtubeId: 'abc123', youTubeVideoName: 'A Title', youTubeChannelName: 'A Channel' };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    mockFs.existsSync.mockReturnValue(true);
    mockFs.renameSync.mockImplementation(() => {});
    jobEventLog = require('../jobEventLog');
    videoPersistence = require('../videoPersistence');
  });

  test('records strm.archived for the STRM file that was renamed', () => {
    videoPersistence._archiveStaleStrmSidecars('/lib/x.strm', video);

    expect(jobEventLog.record).toHaveBeenCalledWith('strm.archived', {
      youtubeId: 'abc123',
      videoTitle: 'A Title',
      channelName: 'A Channel',
      detail: { path: '/lib/x.strm' },
    });
  });

  test('records one event per file archived (the STRM and its media-info cache)', () => {
    videoPersistence._archiveStaleStrmSidecars('/lib/x.strm', video);

    expect(jobEventLog.record).toHaveBeenCalledTimes(2);
  });

  test('records nothing for a file that does not exist', () => {
    mockFs.existsSync.mockReturnValue(false);

    videoPersistence._archiveStaleStrmSidecars('/lib/x.strm', video);

    expect(jobEventLog.record).not.toHaveBeenCalled();
  });

  test('records nothing for a file that could not be renamed', () => {
    mockFs.renameSync.mockImplementation(() => { throw new Error('EACCES'); });

    videoPersistence._archiveStaleStrmSidecars('/lib/x.strm', video);

    expect(jobEventLog.record).not.toHaveBeenCalled();
  });

  test('still archives when no video is given', () => {
    videoPersistence._archiveStaleStrmSidecars('/lib/x.strm');

    expect(mockFs.renameSync).toHaveBeenCalledWith('/lib/x.strm', '/lib/x.strm.cached');
  });
});
