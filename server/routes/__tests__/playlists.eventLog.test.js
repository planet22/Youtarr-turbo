/* eslint-env jest */
const express = require('express');
const createPlaylistRoutes = require('../playlists');
const { findRouteHandler } = require('../../__tests__/testUtils');

const loggerMock = { info: jest.fn(), error: jest.fn() };

const createResponse = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

const makePlaylist = () => ({ id: 1, playlist_id: 'PLtest123', title: 'Test Playlist', enabled: true });

const buildDeps = (overrides = {}) => ({
  verifyToken: (req, res, next) => next(),
  playlistModule: {},
  m3uGenerator: {},
  downloadModule: {},
  mediaServers: { mediaServerSync: {}, watchStatusQueries: {} },
  channelSettingsModule: {},
  subfolderModule: {},
  ratingMapper: {},
  playlistVideoFilters: {},
  jobEventLog: { record: jest.fn() },
  models: {
    Playlist: { findOne: jest.fn().mockResolvedValue(makePlaylist()) },
    PlaylistVideo: { update: jest.fn().mockResolvedValue([1]) },
    Video: {},
  },
  ...overrides,
});

const getHandler = (method, path, deps) => {
  const app = express();
  app.use(express.json());
  app.use(createPlaylistRoutes(deps));
  return findRouteHandler(app, method, path);
};

const request = () => ({ params: { playlistId: 'PLtest123', ytId: 'abc123' }, log: loggerMock });

// Ignoring / unignoring a playlist video is logged where the flag is written.
describe('playlist routes video/events log', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('ignore', () => {
    const path = '/api/playlists/:playlistId/videos/:ytId/ignore';

    test('records video.ignored with the playlist it happened in', async () => {
      const deps = buildDeps();

      await getHandler('post', path, deps)(request(), createResponse());

      expect(deps.jobEventLog.record).toHaveBeenCalledWith('video.ignored', {
        youtubeId: 'abc123',
        detail: { playlistId: 'PLtest123', playlistTitle: 'Test Playlist' },
      });
    });

    test('records nothing when the playlist does not exist', async () => {
      const deps = buildDeps();
      deps.models.Playlist.findOne.mockResolvedValue(null);

      await getHandler('post', path, deps)(request(), createResponse());

      expect(deps.jobEventLog.record).not.toHaveBeenCalled();
    });

    test('records nothing when saving the flag fails', async () => {
      const deps = buildDeps();
      deps.models.PlaylistVideo.update.mockRejectedValue(new Error('db down'));
      const res = createResponse();

      await getHandler('post', path, deps)(request(), res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(deps.jobEventLog.record).not.toHaveBeenCalled();
    });

    test('still works when no log is wired in', async () => {
      const deps = buildDeps({ jobEventLog: undefined });
      const res = createResponse();

      await getHandler('post', path, deps)(request(), res);

      expect(res.json).toHaveBeenCalledWith({ success: true });
    });
  });

  describe('unignore', () => {
    const path = '/api/playlists/:playlistId/videos/:ytId/unignore';

    test('records video.unignored with the playlist it happened in', async () => {
      const deps = buildDeps();

      await getHandler('post', path, deps)(request(), createResponse());

      expect(deps.jobEventLog.record).toHaveBeenCalledWith('video.unignored', {
        youtubeId: 'abc123',
        detail: { playlistId: 'PLtest123', playlistTitle: 'Test Playlist' },
      });
    });

    test('records nothing when the playlist does not exist', async () => {
      const deps = buildDeps();
      deps.models.Playlist.findOne.mockResolvedValue(null);

      await getHandler('post', path, deps)(request(), createResponse());

      expect(deps.jobEventLog.record).not.toHaveBeenCalled();
    });
  });
});
