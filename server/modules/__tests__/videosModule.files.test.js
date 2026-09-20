/* eslint-env jest */

jest.mock('../../logger');

describe('VideosModule file scanning, rating updates and backfill flushing', () => {
  let fs;
  let os;
  let path;
  let dir;
  let videosModule;
  let logger;
  let Video;
  let sequelize;
  let nfoGenerator;
  let ChannelModel;

  const touch = (relative, content = 'x') => {
    const full = path.join(dir, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return full;
  };

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    fs = require('fs');
    os = require('os');
    path = require('path');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfiles-test-'));

    Video = { findByPk: jest.fn() };
    sequelize = { query: jest.fn().mockResolvedValue([]) };
    nfoGenerator = { writeVideoNfoFile: jest.fn() };
    ChannelModel = { findAll: jest.fn().mockResolvedValue([]) };

    jest.doMock('../../db.js', () => ({ Sequelize: { QueryTypes: { SELECT: 'SELECT', UPDATE: 'UPDATE' } }, sequelize }));
    jest.doMock('../../models', () => ({ Video }));
    jest.doMock('../../models/channel', () => ChannelModel);
    jest.doMock('../configModule', () => ({}));
    jest.doMock('../fileCheckModule', () => ({}));
    jest.doMock('../mediaServers/watchStatusQueries', () => ({}));
    jest.doMock('../messageEmitter', () => ({}));
    jest.doMock('../m3uGenerator', () => ({}));
    jest.doMock('../nfoGenerator', () => nfoGenerator);

    logger = require('../../logger');
    videosModule = require('../videosModule');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('scanForVideoFiles', () => {
    it('maps a video file to its YouTube id', async () => {
      const file = touch('Channel/Title [abc123].mp4', '12345');

      const { fileMap } = await videosModule.scanForVideoFiles(dir);

      expect(fileMap.get('abc123')).toEqual({ videoFilePath: file, videoFileSize: 5, audioFilePath: null, audioFileSize: null });
    });

    it('maps an audio file to the same id as its video', async () => {
      const video = touch('Channel/Title [abc123].mp4', '12345');
      const audio = touch('Channel/Title [abc123].mp3', '123');

      const { fileMap } = await videosModule.scanForVideoFiles(dir);

      expect(fileMap.get('abc123')).toEqual({ videoFilePath: video, videoFileSize: 5, audioFilePath: audio, audioFileSize: 3 });
    });

    it('descends into nested folders', async () => {
      const file = touch('__Sub/Channel/Title - abc [deep1]/Title [deep1].mkv');

      const { fileMap } = await videosModule.scanForVideoFiles(dir);

      expect(fileMap.get('deep1').videoFilePath).toBe(file);
    });

    it('ignores files that are not media', async () => {
      touch('Channel/Title [abc123].jpg');
      touch('Channel/Title [abc123].info.json');
      touch('Channel/notes.txt');

      const { fileMap } = await videosModule.scanForVideoFiles(dir);

      expect(fileMap.size).toBe(0);
    });

    it('ignores media files without a bracketed id at the end', async () => {
      touch('Channel/No Id.mp4');
      touch('Channel/[abc123] leading.mp4');

      const { fileMap } = await videosModule.scanForVideoFiles(dir);

      expect(fileMap.size).toBe(0);
    });

    it('uses the last bracket group as the id', async () => {
      touch('Channel/Title [first] name [abc123].mp4');

      const { fileMap } = await videosModule.scanForVideoFiles(dir);

      expect([...fileMap.keys()]).toEqual(['abc123']);
    });

    it('matches extensions without regard to case', async () => {
      touch('Channel/Title [abc123].MP4');

      const { fileMap } = await videosModule.scanForVideoFiles(dir);

      expect(fileMap.has('abc123')).toBe(true);
    });

    it('keeps the larger of two duplicate files and reports the other as a duplicate', async () => {
      touch('A/Title [dup1].mp4', '12');
      const large = touch('B/Title [dup1].mp4', '123456');

      const { fileMap, duplicates } = await videosModule.scanForVideoFiles(dir);

      expect(fileMap.get('dup1').videoFilePath).toBe(large);
      expect(duplicates.get('dup1')).toHaveLength(1);
    });

    it('warns when it replaces a duplicate with a larger file', async () => {
      touch('A/Title [dup1].mp4', '12');
      touch('B/Title [dup1].mp4', '123456');

      await videosModule.scanForVideoFiles(dir);

      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ youtubeId: 'dup1' }), 'Duplicate found: keeping larger file');
    });

    it('does not replace a file with an equal or smaller duplicate', async () => {
      const first = touch('A/Title [dup1].mp4', '1234');
      touch('B/Title [dup1].mp4', '1234');

      const { fileMap } = await videosModule.scanForVideoFiles(dir);

      expect(fileMap.get('dup1').videoFilePath).toBe(first);
    });

    it('adds to the maps it is given', async () => {
      const fileMap = new Map([['existing', { videoFilePath: '/x', videoFileSize: 1, audioFilePath: null, audioFileSize: null }]]);
      touch('Channel/Title [abc123].mp4');

      const result = await videosModule.scanForVideoFiles(dir, fileMap);

      expect(result.fileMap).toBe(fileMap);
      expect([...fileMap.keys()].sort()).toEqual(['abc123', 'existing']);
    });

    it('logs and returns empty maps for a folder that does not exist', async () => {
      const { fileMap } = await videosModule.scanForVideoFiles(path.join(dir, 'missing'));

      expect(fileMap.size).toBe(0);
      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ dir: path.join(dir, 'missing') }), 'Error scanning directory');
    });
  });

  describe('bulkUpdateVideoRatings', () => {
    const makeVideo = (filePath = null) => ({ filePath, update: jest.fn().mockResolvedValue(undefined) });

    it('reports a video that does not exist as failed', async () => {
      Video.findByPk.mockResolvedValue(null);

      const result = await videosModule.bulkUpdateVideoRatings([1], 'PG');

      expect(result).toEqual({ success: [], warnings: [], failed: [{ id: 1, error: 'Video not found' }] });
    });

    it('marks the rating as a manual override', async () => {
      const video = makeVideo();
      Video.findByPk.mockResolvedValue(video);

      const result = await videosModule.bulkUpdateVideoRatings([1], 'PG');

      expect(video.update).toHaveBeenCalledWith({ normalized_rating: 'PG', rating_source: 'Manual Override' });
      expect(result.success).toEqual([1]);
    });

    it('can clear a rating', async () => {
      const video = makeVideo();
      Video.findByPk.mockResolvedValue(video);

      await videosModule.bulkUpdateVideoRatings([1], null);

      expect(video.update).toHaveBeenCalledWith({ normalized_rating: null, rating_source: 'Manual Override' });
    });

    it('rewrites the info json and NFO when one sits next to the video', async () => {
      const filePath = touch('Channel/Title [abc].mp4');
      const jsonPath = touch('Channel/Title [abc].info.json', JSON.stringify({ id: 'abc', title: 'T' }));
      Video.findByPk.mockResolvedValue(makeVideo(filePath));

      await videosModule.bulkUpdateVideoRatings([1], 'PG-13');

      const written = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      expect(written).toEqual({ id: 'abc', title: 'T', normalized_rating: 'PG-13', rating_source: 'Manual Override' });
      expect(nfoGenerator.writeVideoNfoFile).toHaveBeenCalledWith(filePath, written);
    });

    it('succeeds without touching files when there is no info json', async () => {
      const filePath = touch('Channel/Title [abc].mp4');
      Video.findByPk.mockResolvedValue(makeVideo(filePath));

      const result = await videosModule.bulkUpdateVideoRatings([1], 'PG');

      expect(result.success).toEqual([1]);
      expect(nfoGenerator.writeVideoNfoFile).not.toHaveBeenCalled();
    });

    it('warns instead of succeeding when the info json is corrupt', async () => {
      const filePath = touch('Channel/Title [abc].mp4');
      touch('Channel/Title [abc].info.json', '{broken');
      Video.findByPk.mockResolvedValue(makeVideo(filePath));

      const result = await videosModule.bulkUpdateVideoRatings([1], 'PG');

      expect(result.success).toEqual([]);
      expect(result.warnings).toEqual([{ id: 1, warning: 'Database updated but NFO not regenerated (corrupt .info.json)' }]);
      expect(nfoGenerator.writeVideoNfoFile).not.toHaveBeenCalled();
    });

    it('reports an update that throws and carries on with the rest', async () => {
      const bad = { filePath: null, update: jest.fn().mockRejectedValue(new Error('db down')) };
      Video.findByPk.mockResolvedValueOnce(bad).mockResolvedValueOnce(makeVideo());

      const result = await videosModule.bulkUpdateVideoRatings([1, 2], 'PG');

      expect(result).toEqual({ success: [2], warnings: [], failed: [{ id: 1, error: 'db down' }] });
      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ videoId: 1 }), 'Failed to update video rating');
    });
  });

  describe('getAllUniqueChannels', () => {
    it('returns the distinct channel names from downloaded videos, sorted', async () => {
      sequelize.query.mockResolvedValue([{ youTubeChannelName: 'Zed' }, { youTubeChannelName: 'Alpha' }, { youTubeChannelName: 'Alpha' }]);

      await expect(videosModule.getAllUniqueChannels()).resolves.toEqual(['Alpha', 'Zed']);
    });

    it('skips empty channel names', async () => {
      sequelize.query.mockResolvedValue([{ youTubeChannelName: '' }, { youTubeChannelName: null }, { youTubeChannelName: 'Alpha' }]);

      await expect(videosModule.getAllUniqueChannels()).resolves.toEqual(['Alpha']);
    });

    it('merges in the uploader names of the channel rows it is given', async () => {
      ChannelModel.findAll.mockResolvedValue([{ uploader: 'Tracked' }, { uploader: null }]);
      sequelize.query.mockResolvedValue([{ youTubeChannelName: 'Alpha' }]);

      await expect(videosModule.getAllUniqueChannels()).resolves.toEqual(['Alpha', 'Tracked']);
    });

    it('returns an empty list and logs when a query fails', async () => {
      sequelize.query.mockRejectedValue(new Error('db down'));

      await expect(videosModule.getAllUniqueChannels()).resolves.toEqual([]);
      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'Error in getAllUniqueChannels');
    });
  });

  describe('_flushBackfillUpdates', () => {
    const updateCalls = () => sequelize.query.mock.calls;

    it('writes each changed column with bound parameters', async () => {
      await videosModule._flushBackfillUpdates([{ id: 5, filePath: '/a', fileSize: 10, audioFilePath: '/b', audioFileSize: 3, video_resolution: '1920x1080', removed: true }]);

      expect(updateCalls()[0]).toEqual([
        'UPDATE Videos SET filePath = ?, fileSize = ?, audioFilePath = ?, audioFileSize = ?, video_resolution = ?, removed = ? WHERE id = ?',
        { replacements: ['/a', 10, '/b', 3, '1920x1080', 1, 5], type: 'UPDATE' },
      ]);
    });

    it('only sets the columns that are present', async () => {
      await videosModule._flushBackfillUpdates([{ id: 5, video_resolution: '0x0' }]);

      expect(updateCalls()[0][0]).toBe('UPDATE Videos SET video_resolution = ? WHERE id = ?');
    });

    it('can set a column to null', async () => {
      await videosModule._flushBackfillUpdates([{ id: 5, audioFilePath: null }]);

      expect(updateCalls()[0][1].replacements).toEqual([null, 5]);
    });

    it('writes removed as 0 when false', async () => {
      await videosModule._flushBackfillUpdates([{ id: 5, removed: false }]);

      expect(updateCalls()[0][1].replacements).toEqual([0, 5]);
    });

    it('skips an update that has nothing to set', async () => {
      await videosModule._flushBackfillUpdates([{ id: 5 }]);

      expect(sequelize.query).not.toHaveBeenCalled();
    });

    it('keeps going and logs when one update fails', async () => {
      sequelize.query.mockRejectedValueOnce(new Error('deadlock')).mockResolvedValue([]);

      await videosModule._flushBackfillUpdates([{ id: 1, removed: true }, { id: 2, removed: true }]);

      expect(sequelize.query).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ videoId: 1 }), 'Failed to update video');
      expect(logger.info).toHaveBeenCalledWith({ batchSuccess: 1, batchFailed: 1 }, 'Batch update results');
    });

    it('does not log batch results when every update succeeds', async () => {
      await videosModule._flushBackfillUpdates([{ id: 1, removed: true }]);

      expect(logger.info).not.toHaveBeenCalledWith(expect.anything(), 'Batch update results');
    });

    it('applies every update across batches of 100', async () => {
      await videosModule._flushBackfillUpdates(Array.from({ length: 250 }, (_, i) => ({ id: i, removed: true })));

      expect(sequelize.query).toHaveBeenCalledTimes(250);
    });
  });
});
