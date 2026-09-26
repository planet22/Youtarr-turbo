/* eslint-env jest */

const mockFactories = require('./mockFactories');

jest.mock('../../../logger');
jest.mock('../../../models/channel', () => mockFactories.mockChannelModel());
jest.mock('../../../models/channelvideo', () => mockFactories.mockChannelVideoModel());
jest.mock('../../../models/video', () => mockFactories.mockVideoModel());
jest.mock('../../mediaServers/watchStatusQueries', () => ({ getWatchedByMap: jest.fn().mockResolvedValue(new Map()) }));
jest.mock('../../configModule', () => mockFactories.mockConfigModule());
jest.mock('../../fileCheckModule', () => mockFactories.mockFileCheckModule());
jest.mock('../../youtubeApi', () => mockFactories.mockYoutubeApi());
jest.mock('../../../db', () => mockFactories.mockDb());
jest.mock('../../channelSettingsModule', () => ({ testChannelFiltersBatch: jest.fn() }));
jest.mock('../../download/downloadSettingsResolver', () => ({ resolveFinalLibraryMode: jest.fn() }));

describe('channelVideosService.attachChannelFilterPreview', () => {
  let service;
  let channelSettingsModule;
  let configModule;
  let downloadSettingsResolver;

  const channel = (overrides = {}) => ({
    min_duration: null,
    max_duration: null,
    title_filter_regex: null,
    season_episode_regex: null,
    library_mode: null,
    ...overrides,
  });

  const video = (id, overrides = {}) => ({ youtube_id: id, title: `Title ${id}`, duration: 600, publishedAt: '2024-06-01T00:00:00Z', ...overrides });

  const batchResults = (results) => channelSettingsModule.testChannelFiltersBatch.mockReturnValue({ results });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();

    channelSettingsModule = require('../../channelSettingsModule');
    configModule = require('../../configModule');
    downloadSettingsResolver = require('../../download/downloadSettingsResolver');
    channelSettingsModule.testChannelFiltersBatch.mockReturnValue({ results: [] });
    configModule.getConfig.mockReturnValue({});
    downloadSettingsResolver.resolveFinalLibraryMode.mockReturnValue('movie');

    service = require('../channelVideosService');
  });

  describe('movie mode', () => {
    it('lets a video through when the channel has no filters', () => {
      const videos = [video('a')];

      service.attachChannelFilterPreview(videos, channel());

      expect(videos[0].channelFilterPreview).toEqual({
        wouldDownload: true,
        excludedReason: null,
        isSeriesMode: false,
        season: null,
        episode: null,
        seasonEpisodeDecoded: false,
      });
    });

    it('marks a video shorter than the minimum as excluded by duration', () => {
      const videos = [video('a', { duration: 30 })];

      service.attachChannelFilterPreview(videos, channel({ min_duration: 60 }));

      expect(videos[0].channelFilterPreview).toMatchObject({ wouldDownload: false, excludedReason: 'duration' });
    });

    it('marks a video longer than the maximum as excluded by duration', () => {
      const videos = [video('a', { duration: 5000 })];

      service.attachChannelFilterPreview(videos, channel({ max_duration: 3600 }));

      expect(videos[0].channelFilterPreview).toMatchObject({ wouldDownload: false, excludedReason: 'duration' });
    });

    it('keeps a video exactly on the duration bounds', () => {
      const videos = [video('a', { duration: 60 }), video('b', { duration: 3600 })];

      service.attachChannelFilterPreview(videos, channel({ min_duration: 60, max_duration: 3600 }));

      expect(videos.map((v) => v.channelFilterPreview.wouldDownload)).toEqual([true, true]);
    });

    it.each([
      ['a minimum', { min_duration: 60 }],
      ['a maximum', { max_duration: 3600 }],
    ])('excludes a video with no known duration when there is %s', (_label, bounds) => {
      const videos = [video('a', { duration: null })];

      service.attachChannelFilterPreview(videos, channel(bounds));

      expect(videos[0].channelFilterPreview.excludedReason).toBe('duration');
    });

    it('ignores duration entirely when there are no bounds', () => {
      const videos = [video('a', { duration: null })];

      service.attachChannelFilterPreview(videos, channel());

      expect(videos[0].channelFilterPreview.wouldDownload).toBe(true);
    });

    it('excludes a video whose title does not match the filter', () => {
      batchResults([{ id: 'a', titleMatches: false }]);
      const videos = [video('a')];

      service.attachChannelFilterPreview(videos, channel({ title_filter_regex: 'keep' }));

      expect(videos[0].channelFilterPreview).toMatchObject({ wouldDownload: false, excludedReason: 'titleFilter' });
    });

    it('keeps a video whose title matches the filter', () => {
      batchResults([{ id: 'a', titleMatches: true }]);
      const videos = [video('a')];

      service.attachChannelFilterPreview(videos, channel({ title_filter_regex: 'keep' }));

      expect(videos[0].channelFilterPreview.wouldDownload).toBe(true);
    });

    it('reports duration ahead of the title filter when both would exclude', () => {
      batchResults([{ id: 'a', titleMatches: false }]);
      const videos = [video('a', { duration: 1 })];

      service.attachChannelFilterPreview(videos, channel({ min_duration: 60, title_filter_regex: 'keep' }));

      expect(videos[0].channelFilterPreview.excludedReason).toBe('duration');
    });

    it('lets a video through when there was no filter and no batch result for it', () => {
      const videos = [video('a')];

      service.attachChannelFilterPreview(videos, channel());

      expect(videos[0].channelFilterPreview.wouldDownload).toBe(true);
    });

    it('excludes a video when a filter exists but the batch produced nothing for it', () => {
      const videos = [video('a')];

      service.attachChannelFilterPreview(videos, channel({ title_filter_regex: 'keep' }));

      expect(videos[0].channelFilterPreview.excludedReason).toBe('titleFilter');
    });

    it('never attaches a season or episode outside series mode', () => {
      batchResults([{ id: 'a', titleMatches: true, seasonEpisodeMatches: true, season: 2, episode: 3 }]);
      const videos = [video('a')];

      service.attachChannelFilterPreview(videos, channel());

      expect(videos[0].channelFilterPreview).toMatchObject({ season: null, episode: null, seasonEpisodeDecoded: false });
    });
  });

  describe('series mode', () => {
    beforeEach(() => {
      downloadSettingsResolver.resolveFinalLibraryMode.mockReturnValue('series');
    });

    it('uses the season and episode decoded from the title', () => {
      batchResults([{ id: 'a', titleMatches: true, seasonEpisodeMatches: true, season: 3, episode: 9 }]);
      const videos = [video('a')];

      service.attachChannelFilterPreview(videos, channel({ season_episode_regex: 'S(\\d+)E(\\d+)' }));

      expect(videos[0].channelFilterPreview).toEqual({
        wouldDownload: true, excludedReason: null, isSeriesMode: true, season: 3, episode: 9, seasonEpisodeDecoded: true,
      });
    });

    it('falls back to the upload year when the title does not decode', () => {
      batchResults([{ id: 'a', titleMatches: true, seasonEpisodeMatches: false }]);
      const videos = [video('a', { publishedAt: '2022-03-04T00:00:00Z' })];

      service.attachChannelFilterPreview(videos, channel({ season_episode_regex: 'x' }));

      expect(videos[0].channelFilterPreview).toMatchObject({ season: 2022, episode: null, seasonEpisodeDecoded: false });
    });

    it('falls back to the upload year when there is no decode pattern at all', () => {
      const videos = [video('a', { publishedAt: '2021-01-01T00:00:00Z' })];

      service.attachChannelFilterPreview(videos, channel());

      expect(videos[0].channelFilterPreview.season).toBe(2021);
    });

    it('has no season when the upload date is missing or invalid', () => {
      const videos = [video('a', { publishedAt: null }), video('b', { publishedAt: 'not a date' })];

      service.attachChannelFilterPreview(videos, channel());

      expect(videos.map((v) => v.channelFilterPreview.season)).toEqual([null, null]);
    });

    it('gives an excluded video no season at all', () => {
      const videos = [video('a', { duration: 1 })];

      service.attachChannelFilterPreview(videos, channel({ min_duration: 60 }));

      expect(videos[0].channelFilterPreview).toMatchObject({ isSeriesMode: true, season: null, episode: null });
    });
  });

  describe('batch request', () => {
    it('evaluates every title in one call', () => {
      service.attachChannelFilterPreview([video('a'), video('b')], channel());

      expect(channelSettingsModule.testChannelFiltersBatch).toHaveBeenCalledTimes(1);
      expect(channelSettingsModule.testChannelFiltersBatch.mock.calls[0][0].videos).toEqual([
        { id: 'a', title: 'Title a' },
        { id: 'b', title: 'Title b' },
      ]);
    });

    it('accepts camelCase video ids and a missing title', () => {
      service.attachChannelFilterPreview([{ youtubeId: 'x', duration: 5 }], channel());

      expect(channelSettingsModule.testChannelFiltersBatch.mock.calls[0][0].videos).toEqual([{ id: 'x', title: '' }]);
    });

    it('trims the title filter', () => {
      service.attachChannelFilterPreview([video('a')], channel({ title_filter_regex: '  keep  ' }));

      expect(channelSettingsModule.testChannelFiltersBatch.mock.calls[0][0].titleFilterRegex).toBe('keep');
    });

    it('sends an empty title filter when the channel has none', () => {
      service.attachChannelFilterPreview([video('a')], channel());

      expect(channelSettingsModule.testChannelFiltersBatch.mock.calls[0][0].titleFilterRegex).toBe('');
    });

    it('sends the trimmed decode pattern only in series mode', () => {
      downloadSettingsResolver.resolveFinalLibraryMode.mockReturnValue('series');
      service.attachChannelFilterPreview([video('a')], channel({ season_episode_regex: '  S(\\d+)  ' }));

      expect(channelSettingsModule.testChannelFiltersBatch.mock.calls[0][0].seasonEpisodeRegex).toBe('S(\\d+)');
    });

    it('does not send the decode pattern outside series mode', () => {
      service.attachChannelFilterPreview([video('a')], channel({ season_episode_regex: 'S(\\d+)' }));

      expect(channelSettingsModule.testChannelFiltersBatch.mock.calls[0][0].seasonEpisodeRegex).toBe('');
    });

    it('resolves the library mode from the channel and the global default', () => {
      const ch = channel({ library_mode: 'series' });
      configModule.getConfig.mockReturnValue({ defaultLibraryMode: 'movie' });

      service.attachChannelFilterPreview([video('a')], ch);

      expect(downloadSettingsResolver.resolveFinalLibraryMode).toHaveBeenCalledWith({ channelRecord: ch, globalDefault: 'movie' });
    });

    it('copes with a missing config', () => {
      configModule.getConfig.mockReturnValue(null);

      expect(() => service.attachChannelFilterPreview([video('a')], channel())).not.toThrow();
    });

    it('handles an empty page', () => {
      expect(() => service.attachChannelFilterPreview([], channel())).not.toThrow();
    });
  });
});

describe('channelVideosService.buildChannelVideosResponse', () => {
  let service;

  beforeEach(() => {
    jest.resetModules();
    service = require('../channelVideosService');
  });

  it('uses the page length when there are no stats', () => {
    const response = service.buildChannelVideosResponse([{}, {}], null);

    expect(response).toMatchObject({ totalCount: 2, oldestVideoDate: null, dataSource: 'cache', autoDownloadsEnabled: false });
  });

  it('uses the stats when given', () => {
    const response = service.buildChannelVideosResponse([{}], null, 'yt_dlp', { totalCount: 40, oldestVideoDate: '2020-01-01' }, true);

    expect(response).toMatchObject({ totalCount: 40, oldestVideoDate: '2020-01-01', dataSource: 'yt_dlp', autoDownloadsEnabled: true });
  });

  it('has no tabs or fetch time without a channel', () => {
    const response = service.buildChannelVideosResponse([], null);

    expect(response).toMatchObject({ availableTabs: [], lastFetched: null });
  });

  it('returns the videos it was given', () => {
    const videos = [{ id: 1 }];

    expect(service.buildChannelVideosResponse(videos, null).videos).toBe(videos);
  });

  it('reports the tabs available on the channel', () => {
    const response = service.buildChannelVideosResponse([], { available_tabs: 'videos,shorts', hidden_tabs: null, lastFetchedByTab: null });

    expect(response.availableTabs).toEqual(expect.arrayContaining(['videos', 'shorts']));
  });
});
