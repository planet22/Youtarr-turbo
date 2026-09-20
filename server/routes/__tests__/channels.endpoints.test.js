/* eslint-env jest */

// channels.js requires these directly at factory top; mock them so requiring
// the route file does not pull in the real database.
jest.mock('../../modules/channelSettingsModule', () => ({
  validateSubFolder: jest.fn().mockReturnValue({ valid: true }),
  getChannelSettings: jest.fn(),
  updateChannelSettings: jest.fn(),
  getAllSubFolders: jest.fn(),
  getChannelsUsingDefaultSubfolder: jest.fn(),
  getChannelsUsingGlobalFileStructure: jest.fn(),
  previewTitleFilter: jest.fn(),
  previewCombinedFilters: jest.fn(),
}));
jest.mock('../../models/channelvideo', () => ({ findAll: jest.fn(), update: jest.fn() }));
jest.mock('../../logger');

const express = require('express');
const supertest = require('supertest');

const createChannelRoutes = require('../channels');
const channelSettingsModule = require('../../modules/channelSettingsModule');

describe('channel routes: remaining endpoints', () => {
  let log;
  let channelModule;
  let consoleError;

  const makeApp = () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.log = log;
      next();
    });
    app.use(createChannelRoutes({
      verifyToken: (_req, _res, next) => next(),
      channelModule,
      archiveModule: {},
      channelDownloadAllModule: {},
      ratingMapper: require('../../modules/ratingMapper'),
    }));
    return supertest(app);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    channelModule = {
      getChannelsPaginated: jest.fn(),
      writeChannels: jest.fn(),
      updateChannelsByDelta: jest.fn(),
      getChannelInfo: jest.fn(),
      getChannelVideos: jest.fn(),
      isFetchInProgress: jest.fn(),
    };
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  describe('GET /getchannels', () => {
    it('passes the paging, search, sort and subfolder query through', async () => {
      channelModule.getChannelsPaginated.mockResolvedValue({ channels: [], total: 0 });

      const res = await makeApp().get('/getchannels').query({ page: '2', pageSize: '10', search: 'cats', sortBy: 'title', sortOrder: 'asc', subFolder: '__kids' });

      expect(res.body).toEqual({ channels: [], total: 0 });
      expect(channelModule.getChannelsPaginated).toHaveBeenCalledWith({ page: '2', pageSize: '10', searchTerm: 'cats', sortBy: 'title', sortOrder: 'asc', subFolder: '__kids' });
    });

    it('answers 500 with a generic message when listing fails', async () => {
      channelModule.getChannelsPaginated.mockRejectedValue(new Error('db down'));

      const res = await makeApp().get('/getchannels');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Failed to fetch channels' });
      expect(log.error).toHaveBeenCalled();
    });
  });

  describe('POST /updatechannels', () => {
    it('writes a plain array of channels', async () => {
      const res = await makeApp().post('/updatechannels').send(['https://youtube.com/@a']);

      expect(res.body).toEqual({ status: 'success' });
      expect(channelModule.writeChannels).toHaveBeenCalledWith(['https://youtube.com/@a']);
    });

    it('applies an add/remove delta', async () => {
      const res = await makeApp().post('/updatechannels').send({ add: ['u1'], remove: ['u2'] });

      expect(res.body).toEqual({ status: 'success' });
      expect(channelModule.updateChannelsByDelta).toHaveBeenCalledWith({ enableUrls: ['u1'], disableUrls: ['u2'] });
    });

    it('accepts a delta with only additions or only removals', async () => {
      await makeApp().post('/updatechannels').send({ add: ['u1'] });
      await makeApp().post('/updatechannels').send({ remove: ['u2'] });

      expect(channelModule.updateChannelsByDelta.mock.calls).toEqual([
        [{ enableUrls: ['u1'], disableUrls: [] }],
        [{ enableUrls: [], disableUrls: ['u2'] }],
      ]);
    });

    it('rejects an empty delta', async () => {
      const res = await makeApp().post('/updatechannels').send({ add: [], remove: [] });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ status: 'error', message: 'No channel changes provided' });
    });

    it('rejects an object with no lists', async () => {
      const res = await makeApp().post('/updatechannels').send({ foo: 1 });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ status: 'error', message: 'Invalid payload for channel update' });
    });

    it('answers 500 when the update fails', async () => {
      channelModule.writeChannels.mockRejectedValue(new Error('disk full'));

      const res = await makeApp().post('/updatechannels').send([]);

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ status: 'error', message: 'Failed to update channels' });
    });
  });

  describe('POST /addchannelinfo', () => {
    it('rejects a missing url', async () => {
      const res = await makeApp().post('/addchannelinfo').send({});

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ status: 'error', message: 'URL is missing in the request' });
    });

    it('returns the channel info with its channel id', async () => {
      channelModule.getChannelInfo.mockResolvedValue({ id: 'UC1', title: 'T' });

      const res = await makeApp().post('/addchannelinfo').send({ url: 'https://youtube.com/@t' });

      expect(res.body).toEqual({ status: 'success', channelInfo: { id: 'UC1', title: 'T', channel_id: 'UC1' } });
      expect(channelModule.getChannelInfo).toHaveBeenCalledWith('https://youtube.com/@t', false);
    });

    it.each([
      ['CHANNEL_NOT_FOUND', 404, 'Channel not found. Please check the URL and try again.'],
      ['COOKIES_REQUIRED', 403, 'the original message'],
      ['NETWORK_ERROR', 503, 'Unable to connect to YouTube. Please try again later.'],
      ['CHANNEL_EMPTY', 422, 'This channel has no videos to download.'],
      ['SOMETHING_ELSE', 500, 'Failed to get channel information. Please try again.'],
    ])('maps the %s failure to %s', async (code, status, message) => {
      channelModule.getChannelInfo.mockRejectedValue(Object.assign(new Error('the original message'), { code }));

      const res = await makeApp().post('/addchannelinfo').send({ url: 'u' });

      expect(res.status).toBe(status);
      expect(res.body).toEqual({ status: 'error', message, error: 'the original message' });
    });

    it('uses a generic error text when the failure has no message', async () => {
      channelModule.getChannelInfo.mockRejectedValue(Object.assign(new Error(''), { code: 'X' }));

      const res = await makeApp().post('/addchannelinfo').send({ url: 'u' });

      expect(res.body.error).toBe('Unknown error');
    });
  });

  describe('GET /getchannelinfo/:channelId', () => {
    it('returns the channel info', async () => {
      channelModule.getChannelInfo.mockResolvedValue({ id: 'UC1' });

      const res = await makeApp().get('/getchannelinfo/UC1');

      expect(res.body).toEqual({ id: 'UC1' });
      expect(channelModule.getChannelInfo).toHaveBeenCalledWith('UC1', true);
    });
  });

  describe('channel settings', () => {
    it('returns the settings of a channel', async () => {
      channelSettingsModule.getChannelSettings.mockResolvedValue({ sub_folder: null });

      const res = await makeApp().get('/api/channels/UC1/settings');

      expect(res.body).toEqual({ sub_folder: null });
      expect(channelSettingsModule.getChannelSettings).toHaveBeenCalledWith('UC1');
    });

    it('answers 404 for an unknown channel', async () => {
      channelSettingsModule.getChannelSettings.mockResolvedValue(null);

      const res = await makeApp().get('/api/channels/UC1/settings');

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Channel not found' });
    });

    it('answers 500 with the reason when reading fails', async () => {
      channelSettingsModule.getChannelSettings.mockRejectedValue(new Error('db down'));

      const res = await makeApp().get('/api/channels/UC1/settings');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'db down' });
    });

    it('updates the settings with the request body', async () => {
      channelSettingsModule.updateChannelSettings.mockResolvedValue({ success: true });

      const res = await makeApp().put('/api/channels/UC1/settings').send({ video_quality: '720' });

      expect(res.body).toEqual({ success: true });
      expect(channelSettingsModule.updateChannelSettings).toHaveBeenCalledWith('UC1', { video_quality: '720' });
    });

    it.each([
      [400, 'Invalid video quality'],
      [404, 'Channel not found'],
      [409, 'Cannot change subfolder while downloads are in progress for this channel'],
    ])('answers %i with the reason when the module reports that status', async (statusCode, message) => {
      channelSettingsModule.updateChannelSettings.mockRejectedValue(Object.assign(new Error(message), { statusCode }));

      const res = await makeApp().put('/api/channels/UC1/settings').send({ sub_folder: 'x' });

      expect(res.status).toBe(statusCode);
      expect(res.body).toEqual({ error: message });
    });

    it('answers 500 with the reason for other failures', async () => {
      channelSettingsModule.updateChannelSettings.mockRejectedValue(new Error('db down'));

      const res = await makeApp().put('/api/channels/UC1/settings').send({});

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'db down' });
    });
  });

  describe.each([
    ['/api/channels/subfolders', 'getAllSubFolders', ['__a']],
    ['/api/channels/using-default-subfolder', 'getChannelsUsingDefaultSubfolder', { count: 1, channelNames: ['A'] }],
    ['/api/channels/using-global-file-structure', 'getChannelsUsingGlobalFileStructure', { count: 2, channelNames: [] }],
  ])('GET %s', (path, method, payload) => {
    it('returns what the settings module reports', async () => {
      channelSettingsModule[method].mockResolvedValue(payload);

      const res = await makeApp().get(path);

      expect(res.body).toEqual(payload);
    });

    it('answers 500 with the reason when it fails', async () => {
      channelSettingsModule[method].mockRejectedValue(new Error('db down'));

      const res = await makeApp().get(path);

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'db down' });
    });
  });

  describe('filter previews', () => {
    it('previews a title filter', async () => {
      channelSettingsModule.previewTitleFilter.mockResolvedValue({ videos: [] });

      const res = await makeApp().get('/api/channels/UC1/filter-preview').query({ title_filter_regex: '^S' });

      expect(res.body).toEqual({ videos: [] });
      expect(channelSettingsModule.previewTitleFilter).toHaveBeenCalledWith('UC1', '^S');
    });

    it('previews with an empty filter when none is given', async () => {
      channelSettingsModule.previewTitleFilter.mockResolvedValue({});

      await makeApp().get('/api/channels/UC1/filter-preview');

      expect(channelSettingsModule.previewTitleFilter).toHaveBeenCalledWith('UC1', '');
    });

    it('answers 500 with the reason when the title preview fails', async () => {
      channelSettingsModule.previewTitleFilter.mockRejectedValue(new Error('bad regex'));

      const res = await makeApp().get('/api/channels/UC1/filter-preview');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'bad regex' });
    });

    it('previews the combined filters', async () => {
      channelSettingsModule.previewCombinedFilters.mockResolvedValue({ totalCount: 0 });

      const res = await makeApp().get('/api/channels/UC1/combined-filter-preview').query({ title_filter_regex: '^S', season_episode_regex: '(?P<season>1)' });

      expect(res.body).toEqual({ totalCount: 0 });
      expect(channelSettingsModule.previewCombinedFilters).toHaveBeenCalledWith('UC1', '^S', '(?P<season>1)');
    });

    it('previews the combined filters with empty values when none are given', async () => {
      channelSettingsModule.previewCombinedFilters.mockResolvedValue({});

      await makeApp().get('/api/channels/UC1/combined-filter-preview');

      expect(channelSettingsModule.previewCombinedFilters).toHaveBeenCalledWith('UC1', '', '');
    });

    it('answers 500 with the reason when the combined preview fails', async () => {
      channelSettingsModule.previewCombinedFilters.mockRejectedValue(new Error('bad regex'));

      const res = await makeApp().get('/api/channels/UC1/combined-filter-preview');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'bad regex' });
    });
  });

  describe('GET /getchannelvideos/:channelId', () => {
    const callArgs = () => channelModule.getChannelVideos.mock.calls[0];

    it('uses sensible defaults', async () => {
      channelModule.getChannelVideos.mockResolvedValue({ videos: [] });

      await makeApp().get('/getchannelvideos/UC1');

      expect(callArgs()).toEqual(['UC1', 1, 50, 'off', '', 'date', 'desc', 'videos', null, null, null, null, 'off', 'off', 'off', 'off', false]);
    });

    it('caps the page size at 200', async () => {
      channelModule.getChannelVideos.mockResolvedValue({});

      await makeApp().get('/getchannelvideos/UC1').query({ pageSize: '5000' });

      expect(callArgs()[2]).toBe(200);
    });

    it('passes every filter through', async () => {
      channelModule.getChannelVideos.mockResolvedValue({});

      await makeApp().get('/getchannelvideos/UC1').query({
        page: '3', pageSize: '20', searchQuery: 'cats', sortBy: 'title', sortOrder: 'asc', tabType: 'shorts',
        minDuration: '30', maxDuration: '600', dateFrom: '2024-01-01', dateTo: '2024-02-01',
        downloadedFilter: 'only', protectedFilter: 'exclude', missingFilter: 'only', ignoredFilter: 'exclude', watchedFilter: 'only',
        applyChannelFilters: 'true',
      });

      expect(callArgs()).toEqual(['UC1', 3, 20, 'only', 'cats', 'title', 'asc', 'shorts', 30, 600, '2024-01-01', '2024-02-01', 'exclude', 'only', 'exclude', 'only', true]);
    });

    it('treats unparseable durations as no limit', async () => {
      channelModule.getChannelVideos.mockResolvedValue({});

      await makeApp().get('/getchannelvideos/UC1').query({ minDuration: 'abc', maxDuration: 'x' });

      expect(callArgs().slice(8, 10)).toEqual([null, null]);
    });

    it.each([['true', true], ['1', true], ['false', false], ['yes', false]])('reads applyChannelFilters=%s as %s', async (value, expected) => {
      channelModule.getChannelVideos.mockResolvedValue({});

      await makeApp().get('/getchannelvideos/UC1').query({ applyChannelFilters: value });

      expect(callArgs()[16]).toBe(expected);
    });

    it('ignores an unknown filter mode', async () => {
      channelModule.getChannelVideos.mockResolvedValue({});

      await makeApp().get('/getchannelvideos/UC1').query({ downloadedFilter: 'maybe' });

      expect(callArgs()[3]).toBe('off');
    });

    it('wraps a plain array result in a videos field', async () => {
      channelModule.getChannelVideos.mockResolvedValue([{ id: 1 }]);

      const res = await makeApp().get('/getchannelvideos/UC1');

      expect(res.body).toEqual({ videos: [{ id: 1 }] });
    });

    it('returns an object result as it is', async () => {
      channelModule.getChannelVideos.mockResolvedValue({ videos: [{ id: 1 }], total: 1 });

      const res = await makeApp().get('/getchannelvideos/UC1');

      expect(res.body).toEqual({ videos: [{ id: 1 }], total: 1 });
    });

    it('answers 500 with a generic message when fetching fails', async () => {
      channelModule.getChannelVideos.mockRejectedValue(new Error('db down'));

      const res = await makeApp().get('/getchannelvideos/UC1');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Failed to get channel videos' });
    });
  });

  describe('GET /api/channels/:channelId/fetch-status', () => {
    it('reports whether a fetch is running', async () => {
      channelModule.isFetchInProgress.mockReturnValue({ isFetching: true });

      const res = await makeApp().get('/api/channels/UC1/fetch-status').query({ tabType: 'shorts' });

      expect(res.body).toEqual({ isFetching: true });
      expect(channelModule.isFetchInProgress).toHaveBeenCalledWith('UC1', 'shorts');
    });

    it('checks every tab when none is given', async () => {
      channelModule.isFetchInProgress.mockReturnValue({ isFetching: false });

      await makeApp().get('/api/channels/UC1/fetch-status');

      expect(channelModule.isFetchInProgress).toHaveBeenCalledWith('UC1', null);
    });

    it('answers 500 with isFetching false when the check throws', async () => {
      channelModule.isFetchInProgress.mockImplementation(() => { throw new Error('boom'); });

      const res = await makeApp().get('/api/channels/UC1/fetch-status');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ isFetching: false, error: 'Failed to get fetch status' });
    });
  });

  describe('POST /api/channels/:channelId/videos/bulk-ignore', () => {
    it.each([['missing', {}], ['empty', { youtubeIds: [] }], ['not an array', { youtubeIds: 'a' }]])('rejects youtubeIds that are %s', async (_label, body) => {
      const res = await makeApp().post('/api/channels/UC1/videos/bulk-ignore').send(body);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, error: 'youtubeIds must be a non-empty array' });
    });

    it('rejects more than 500 ids', async () => {
      const res = await makeApp().post('/api/channels/UC1/videos/bulk-ignore').send({ youtubeIds: Array.from({ length: 501 }, (_, i) => `id${i}`) });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('youtubeIds array exceeds maximum of 500');
    });
  });
});
