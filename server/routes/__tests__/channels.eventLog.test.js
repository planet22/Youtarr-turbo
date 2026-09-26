/* eslint-env jest */

// channels.js requires these directly at factory top; mock them so requiring
// the route file does not pull in the real database.
jest.mock('../../modules/channelSettingsModule', () => ({
  validateSubFolder: jest.fn().mockReturnValue({ valid: true }),
}));
jest.mock('../../models/channelvideo', () => ({ findOne: jest.fn(), findAll: jest.fn(), update: jest.fn() }));
jest.mock('../../logger');

const express = require('express');
const supertest = require('supertest');

const createChannelRoutes = require('../channels');
const ChannelVideo = require('../../models/channelvideo');

// Ignoring / unignoring a video is logged where the flag is written, with the
// title the channel listing holds at that moment.
describe('channel routes video/events log', () => {
  let archiveModule;
  let jobEventLog;
  let channelVideo;

  const makeApp = (extra = {}) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
      next();
    });
    app.use(createChannelRoutes({
      verifyToken: (_req, _res, next) => next(),
      channelModule: {},
      archiveModule,
      channelDownloadAllModule: {},
      ratingMapper: {},
      jobEventLog,
      ...extra,
    }));
    return supertest(app);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    archiveModule = {
      addVideoToArchive: jest.fn().mockResolvedValue(undefined),
      removeVideoFromArchive: jest.fn().mockResolvedValue(undefined),
    };
    jobEventLog = { record: jest.fn() };
    channelVideo = { youtube_id: 'abc123', title: 'A Title', update: jest.fn().mockResolvedValue(undefined) };
    ChannelVideo.findOne.mockResolvedValue(channelVideo);
    ChannelVideo.findAll.mockResolvedValue([channelVideo]);
    ChannelVideo.update.mockResolvedValue([1]);
  });

  describe('ignore', () => {
    it('records video.ignored with the video title and channel id', async () => {
      await makeApp().post('/api/channels/UC1/videos/abc123/ignore');

      expect(jobEventLog.record).toHaveBeenCalledWith('video.ignored', {
        youtubeId: 'abc123', videoTitle: 'A Title', detail: { channelId: 'UC1' },
      });
    });

    it('records nothing when the video is not found', async () => {
      ChannelVideo.findOne.mockResolvedValue(null);

      const res = await makeApp().post('/api/channels/UC1/videos/abc123/ignore');

      expect(res.status).toBe(404);
      expect(jobEventLog.record).not.toHaveBeenCalled();
    });

    it('records nothing when adding to the archive fails', async () => {
      archiveModule.addVideoToArchive.mockRejectedValue(new Error('disk'));

      const res = await makeApp().post('/api/channels/UC1/videos/abc123/ignore');

      expect(res.status).toBe(500);
      expect(jobEventLog.record).not.toHaveBeenCalled();
    });

    it('still works when no log is wired in', async () => {
      const res = await makeApp({ jobEventLog: undefined }).post('/api/channels/UC1/videos/abc123/ignore');

      expect(res.status).toBe(200);
    });
  });

  describe('unignore', () => {
    it('records video.unignored', async () => {
      await makeApp().post('/api/channels/UC1/videos/abc123/unignore');

      expect(jobEventLog.record).toHaveBeenCalledWith('video.unignored', {
        youtubeId: 'abc123', videoTitle: 'A Title', detail: { channelId: 'UC1' },
      });
    });

    it('records nothing when the video is not found', async () => {
      ChannelVideo.findOne.mockResolvedValue(null);

      await makeApp().post('/api/channels/UC1/videos/abc123/unignore');

      expect(jobEventLog.record).not.toHaveBeenCalled();
    });
  });

  describe('bulk ignore', () => {
    it('records video.ignored for each video found', async () => {
      ChannelVideo.findAll.mockResolvedValue([
        { youtube_id: 'a', title: 'One' },
        { youtube_id: 'b', title: 'Two' },
      ]);

      await makeApp().post('/api/channels/UC1/videos/bulk-ignore').send({ youtubeIds: ['a', 'b'] });

      expect(jobEventLog.record.mock.calls.map(([type, fields]) => [type, fields.youtubeId])).toEqual([
        ['video.ignored', 'a'],
        ['video.ignored', 'b'],
      ]);
    });

    it('marks bulk entries so they can be told from a single ignore', async () => {
      await makeApp().post('/api/channels/UC1/videos/bulk-ignore').send({ youtubeIds: ['abc123'] });

      expect(jobEventLog.record.mock.calls[0][1].detail).toEqual({ channelId: 'UC1', bulk: true });
    });

    it('does not record ids that were not found', async () => {
      ChannelVideo.findAll.mockResolvedValue([]);

      await makeApp().post('/api/channels/UC1/videos/bulk-ignore').send({ youtubeIds: ['missing'] });

      expect(jobEventLog.record).not.toHaveBeenCalled();
    });
  });
});
