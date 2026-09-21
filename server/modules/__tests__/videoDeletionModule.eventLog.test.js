/* eslint-env jest */

jest.mock('../../logger');
jest.mock('../m3uGenerator', () => ({ generateChannelM3UInBackground: jest.fn() }));

// Video/events log entries for deletions: what is recorded, and that the row's
// own title/channel ride along so the entry survives the Video row being purged.
describe('VideoDeletionModule video/events log', () => {
  let videoDeletionModule;
  let mockVideo;
  let mockFs;
  let jobEventLog;

  const videoRow = (overrides = {}) => ({
    id: 7,
    youtubeId: 'abc123',
    youTubeVideoName: 'A Title',
    youTubeChannelName: 'A Channel',
    channel_id: 'UC1',
    filePath: '/lib/Channel/Channel - A Title - abc123/Channel - A Title  [abc123].mp4',
    removed: false,
    update: jest.fn().mockResolvedValue(),
    destroy: jest.fn().mockResolvedValue(),
    ...overrides,
  });

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    mockVideo = { findByPk: jest.fn(), findOne: jest.fn() };
    mockFs = { readdir: jest.fn().mockResolvedValue([]), unlink: jest.fn() };

    jest.doMock('../../models', () => ({
      Video: mockVideo,
      JobVideo: { destroy: jest.fn().mockResolvedValue(1) },
      VideoWatchStatus: { destroy: jest.fn().mockResolvedValue(0) },
    }));
    jest.doMock('fs', () => ({ promises: mockFs }));
    jest.doMock('../filesystem', () => ({
      isVideoDirectory: jest.fn(() => true),
      cleanupEmptyChannelDirectory: jest.fn().mockResolvedValue(false),
      cleanupEmptyParents: jest.fn().mockResolvedValue(),
      removeEmptyDescendants: jest.fn().mockResolvedValue([]),
      isSubfolderDir: jest.fn(),
      listSubdirectories: jest.fn().mockResolvedValue([]),
      removeDirectoryResilient: jest.fn().mockResolvedValue(),
    }));
    jest.doMock('../configModule', () => ({
      directoryPath: '/lib',
      getConfig: jest.fn().mockReturnValue({ autoRemovalPreserveStrmFallback: false }),
    }));
    jest.doMock('../archiveModule', () => ({ removeVideoFromArchive: jest.fn().mockResolvedValue() }));

    jobEventLog = require('../jobEventLog');
    videoDeletionModule = require('../videoDeletionModule');
  });

  describe('deleteVideoById', () => {
    it('records video.deleted with the title, channel and file path after deleting', async () => {
      mockVideo.findByPk.mockResolvedValue(videoRow());

      await videoDeletionModule.deleteVideoById(7);

      expect(jobEventLog.record).toHaveBeenCalledWith('video.deleted', {
        youtubeId: 'abc123',
        videoTitle: 'A Title',
        channelName: 'A Channel',
        detail: { filePath: '/lib/Channel/Channel - A Title - abc123/Channel - A Title  [abc123].mp4' },
      });
    });

    it('records video.deleted for a video with no file path', async () => {
      mockVideo.findByPk.mockResolvedValue(videoRow({ filePath: null }));

      await videoDeletionModule.deleteVideoById(7);

      expect(jobEventLog.record).toHaveBeenCalledWith('video.deleted', expect.objectContaining({ detail: { noFilePath: true } }));
    });

    it('records nothing when the video does not exist', async () => {
      mockVideo.findByPk.mockResolvedValue(null);

      await videoDeletionModule.deleteVideoById(7);

      expect(jobEventLog.record).not.toHaveBeenCalled();
    });

    it('records nothing for a video already marked removed', async () => {
      mockVideo.findByPk.mockResolvedValue(videoRow({ removed: true }));

      await videoDeletionModule.deleteVideoById(7);

      expect(jobEventLog.record).not.toHaveBeenCalled();
    });

    it('records nothing when deleting the files fails', async () => {
      const filesystem = require('../filesystem');
      filesystem.removeDirectoryResilient.mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
      mockVideo.findByPk.mockResolvedValue(videoRow());

      await videoDeletionModule.deleteVideoById(7);

      expect(jobEventLog.record).not.toHaveBeenCalled();
    });

    it('still reports success when the log call has nothing to say', async () => {
      mockVideo.findByPk.mockResolvedValue(videoRow());

      await expect(videoDeletionModule.deleteVideoById(7)).resolves.toMatchObject({ success: true });
    });
  });

  describe('purgeVideoById', () => {
    it('records video.deleted flagged as a purge, with the snapshot from the row', async () => {
      mockVideo.findByPk.mockResolvedValue(videoRow({ removed: true }));

      await videoDeletionModule.purgeVideoById(7);

      expect(jobEventLog.record).toHaveBeenCalledWith('video.deleted', {
        youtubeId: 'abc123',
        videoTitle: 'A Title',
        channelName: 'A Channel',
        isTracked: false,
        detail: { purged: true },
      });
    });

    it('says the video is no longer tracked, because a purge deletes its row', async () => {
      mockVideo.findByPk.mockResolvedValue(videoRow({ removed: true }));

      await videoDeletionModule.purgeVideoById(7);

      expect(jobEventLog.record.mock.calls[0][1].isTracked).toBe(false);
    });

    it('records nothing when the video is not marked missing', async () => {
      mockVideo.findByPk.mockResolvedValue(videoRow({ removed: false }));

      await videoDeletionModule.purgeVideoById(7);

      expect(jobEventLog.record).not.toHaveBeenCalled();
    });
  });
});
