/* eslint-env jest */

// This suite's fixtures are POSIX paths, so run the code under test against POSIX
// path semantics on every platform (a no-op on Linux).
jest.mock('path', () => jest.requireActual('path').posix);

jest.mock('fs', () => ({
  promises: {
    stat: jest.fn(),
  },
}));

// A video's file appearing or disappearing is logged once, when the file check
// notices the change - with the video's own facts as they are at that moment.
describe('FileCheckModule video/events log', () => {
  let fileCheckModule;
  let mockFs;
  let jobEventLog;

  const video = (over = {}) => ({
    id: 1,
    youtubeId: 'abc123',
    youTubeVideoName: 'A Title',
    youTubeChannelName: 'A Channel',
    filePath: '/videos/channel/video.mp4',
    removed: false,
    ...over,
  });

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockFs = require('fs').promises;
    jobEventLog = require('../jobEventLog');
    fileCheckModule = require('../fileCheckModule');
  });

  test('records video.marked_missing when a file is no longer on disk', async () => {
    mockFs.stat.mockRejectedValue({ code: 'ENOENT' });

    await fileCheckModule.checkVideoFiles([video()]);

    expect(jobEventLog.record).toHaveBeenCalledWith('video.marked_missing', {
      youtubeId: 'abc123',
      videoTitle: 'A Title',
      channelName: 'A Channel',
      detail: { filePath: '/videos/channel/video.mp4' },
    });
  });

  test('records video.restored when a missing file is found again', async () => {
    mockFs.stat.mockResolvedValue({ size: 1000, isFile: () => true });

    await fileCheckModule.checkVideoFiles([video({ removed: true, fileSize: '1000' })]);

    expect(jobEventLog.record).toHaveBeenCalledWith('video.restored', expect.objectContaining({
      youtubeId: 'abc123',
      detail: { filePath: '/videos/channel/video.mp4' },
    }));
  });

  test('records nothing for a video whose file is present and already known', async () => {
    mockFs.stat.mockResolvedValue({ size: 1000, isFile: () => true });

    await fileCheckModule.checkVideoFiles([video({ fileSize: '1000' })]);

    expect(jobEventLog.record).not.toHaveBeenCalled();
  });

  test('records nothing for a video already marked missing whose file is still gone', async () => {
    mockFs.stat.mockRejectedValue({ code: 'ENOENT' });

    await fileCheckModule.checkVideoFiles([video({ removed: true })]);

    expect(jobEventLog.record).not.toHaveBeenCalled();
  });

  test('does not change what the check reports', async () => {
    mockFs.stat.mockRejectedValue({ code: 'ENOENT' });

    const result = await fileCheckModule.checkVideoFiles([video()]);

    expect(result.updates).toEqual([{ id: 1, removed: true }]);
  });

  test('records one event per changed video', async () => {
    mockFs.stat.mockRejectedValue({ code: 'ENOENT' });

    await fileCheckModule.checkVideoFiles([video(), video({ id: 2, youtubeId: 'zzz999' })]);

    expect(jobEventLog.record).toHaveBeenCalledTimes(2);
  });
});
